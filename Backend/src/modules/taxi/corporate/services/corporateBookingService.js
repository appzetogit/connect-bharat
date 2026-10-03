import mongoose from 'mongoose';
import { ApiError } from '../../../../utils/ApiError.js';
import { Ride } from '../../user/models/Ride.js';
import { Corporate } from '../models/Corporate.js';
import { CorporateDepartment } from '../models/CorporateDepartment.js';
import { CorporateEmployee } from '../models/CorporateEmployee.js';
import { CorporateInvoice } from '../models/CorporateInvoice.js';
import { CorporateTripPolicy } from '../models/CorporateTripPolicy.js';
import {
  checkCreditLimit,
  computeCorporateDiscount,
  employeePolicyLayer,
  evaluateTripPolicy,
  getIstMonthRange,
  mergePolicies,
  normalizeCorporateServiceType,
  resolveEmployeeMonthlyLimit,
  rolePolicyLayer,
  round2,
} from './corporatePolicyEngine.js';
import { getCorporateSettings, isFlagOn } from './corporateSettingsService.js';
import {
  computeCorporateSplit,
  defaultEmployeePaymentMethod,
  estimateTripKm,
  normalizeExcessMethods,
  resolveEmployeePaymentMethod,
  serializeOffices,
} from './corporateV2Rules.js';
import {
  getAllowanceSnapshot,
  releaseReservationForUnsavedRide,
  reserveAllowanceKm,
  upsertAllowanceUsage,
} from './corporateAllowanceService.js';
import { findActiveMembership } from './corporateMembership.js';
import { assertTravelZone, corporateApiError, priceCorporateTrip } from './corporatePricingService.js';
import { resolveEmployeeRole, serializeRoleRef } from './corporateRoleService.js';

/// Rides that have been booked against a company but not yet charged to it.
/// Their billable amount counts against the credit limit and monthly caps so
/// that several bookings in flight cannot each pass against the same headroom.
const IN_FLIGHT_STATUSES = ['searching', 'accepted', 'ongoing'];

const toObjectId = (value) => new mongoose.Types.ObjectId(String(value));

/// Billed spend this IST month plus in-flight bookings, for one filter.
const sumCorporateSpend = async (match) => {
  const { from, to } = getIstMonthRange(new Date());
  const [row] = await Ride.aggregate([
    {
      $match: {
        ...match,
        paymentMethod: 'corporate',
        $or: [
          { status: 'completed', 'corporate.chargedAt': { $gte: from, $lt: to } },
          { status: { $in: IN_FLIGHT_STATUSES }, 'corporate.chargedAt': null },
        ],
      },
    },
    { $group: { _id: null, total: { $sum: '$corporate.billedAmount' } } },
  ]);
  return round2(row?.total || 0);
};

const sumPendingExposure = async (corporateId) => {
  const [row] = await Ride.aggregate([
    {
      $match: {
        'corporate.corporateId': toObjectId(corporateId),
        paymentMethod: 'corporate',
        status: { $in: IN_FLIGHT_STATUSES },
        'corporate.chargedAt': null,
      },
    },
    { $group: { _id: null, total: { $sum: '$corporate.billedAmount' } } },
  ]);
  return round2(row?.total || 0);
};

const loadPolicy = async ({ corporateId, departmentId, role = null, employee = null }) => {
  const policies = await CorporateTripPolicy.find({
    corporateId,
    departmentId: { $in: departmentId ? [null, departmentId] : [null] },
  }).lean();
  const company = policies.find((item) => !item.departmentId) || null;
  const department = departmentId ? policies.find((item) => String(item.departmentId) === String(departmentId)) || null : null;
  return mergePolicies(company, department, rolePolicyLayer(role), employeePolicyLayer(employee));
};

export { findActiveMembership };

const PANEL_BOOKERS_WITHOUT_APPROVAL = ['owner', 'admin', 'approver'];

/// Decides whether a booking may be billed to the rider's company.
///
/// Called from `createRideRecord` once the server-side fare is known. Throws
/// ApiError(403) with the reasons when the trip is not allowed; otherwise
/// returns what the ride needs to store, including whether dispatch must wait
/// for an approver.
///
/// v2 (docs/plans/corporate-v2.md): prices on the company tariff when it is on
/// (the returned `grossFare` then replaces the Set Price fare), enforces the
/// office boundary, merges the role's travel rules, works out the estimated
/// company / employee split from the role's km allowance and validates the
/// employee's payment method for any excess. Policy, monthly caps and the
/// credit limit are checked on the company's share after discount. Nothing is
/// written here; the allowance is reserved in attachCorporateBookingToRide.
///
/// `booker` = { adminId, role, note } for a travel-desk booking: owner /
/// admin / approver bookings skip the approval step.
export const validateCorporateBooking = async ({
  userId,
  serviceType,
  vehicleTypeId,
  fare,
  scheduledAt,
  corporateId = null,
  fareSource = 'server',
  fareBreakdown = null,
  pricingRule = null,
  distanceMeters = 0,
  durationMinutes = 0,
  intercity = null,
  pickupCoords = null,
  dropCoords = null,
  employeePaymentMethod = '',
  booker = null,
}) => {
  const settings = await getCorporateSettings();
  if (!isFlagOn(settings.booking_enabled)) {
    throw new ApiError(403, 'Corporate billing is not available right now');
  }

  const membership = await findActiveMembership({ userId, corporateId });
  if (!membership?.employee) {
    throw new ApiError(403, 'You are not registered as an employee of any company');
  }
  const { employee, corporate } = membership;
  if (!corporate || corporate.status !== 'approved') {
    throw new ApiError(403, 'Your company account is not active for billing');
  }

  const service = normalizeCorporateServiceType(serviceType);
  if (pickupCoords && dropCoords) {
    assertTravelZone({ corporate, settings, pickup: pickupCoords, drop: dropCoords });
  }

  const priced = priceCorporateTrip({
    corporate,
    settings,
    serviceType: service,
    vehicleTypeId,
    distanceMeters,
    durationMinutes,
    intercity,
    pricingRule,
    standardFare: fare,
    standardFareSource: fareSource,
    standardBreakdown: fareBreakdown,
  });
  const grossFare = Math.max(0, Number(priced.fare) || 0);
  if (booker && !(grossFare > 0)) {
    throw new ApiError(400, 'This vehicle cannot be priced for this trip');
  }

  const role = await resolveEmployeeRole(employee);
  const at = scheduledAt || new Date();
  const allowanceSnapshot = await getAllowanceSnapshot({ employee, role, settings, at });
  const estimatedKm = estimateTripKm({ distanceMeters, serviceType: service, tripType: intercity?.tripType });
  const split = computeCorporateSplit({
    fare: grossFare,
    km: estimatedKm,
    remainingKm: allowanceSnapshot.remainingKm,
    allowanceEnabled: allowanceSnapshot.enabled,
  });

  const allowedMethods = normalizeExcessMethods(corporate.excessPayment?.allowedMethods);
  const payment = resolveEmployeePaymentMethod({
    requested: employeePaymentMethod,
    allowedMethods,
    required: split.employeeAmount > 0,
  });
  if (!payment.ok) {
    throw corporateApiError(400, payment.reason, {
      code: 'corporate_employee_payment_method',
      allowedMethods,
      employeeAmount: split.employeeAmount,
      companyAmount: split.companyAmount,
    });
  }

  const discount = computeCorporateDiscount({ discount: corporate.discount, serviceType: service, fare: split.companyAmount });

  const [department, policy, employeeMonthSpend, pendingExposure] = await Promise.all([
    employee.departmentId ? CorporateDepartment.findById(employee.departmentId).lean() : null,
    loadPolicy({ corporateId: corporate._id, departmentId: employee.departmentId, role, employee }),
    sumCorporateSpend({ 'corporate.employeeId': toObjectId(employee._id) }),
    sumPendingExposure(corporate._id),
  ]);
  const departmentMonthSpend = department
    ? await sumCorporateSpend({ 'corporate.departmentId': toObjectId(department._id) })
    : 0;

  const evaluation = evaluateTripPolicy({
    corporate,
    policy,
    employee: { ...employee, monthlyLimit: resolveEmployeeMonthlyLimit({ employee, role }) },
    department,
    trip: { serviceType: service, vehicleTypeId, fare: discount.billableAmount, at },
    spend: { employeeMonthSpend, departmentMonthSpend },
  });

  if (!evaluation.allowed) {
    throw new ApiError(403, evaluation.blockReasons[0], { reasons: evaluation.blockReasons });
  }

  if (isFlagOn(settings.block_booking_when_overdue)) {
    const overdue = await CorporateInvoice.exists({ corporateId: corporate._id, status: 'overdue' });
    if (overdue) {
      throw new ApiError(403, 'Your company has an overdue invoice. Corporate billing is paused.');
    }
  }

  const credit = checkCreditLimit({
    creditLimit: corporate.creditLimit,
    currentOutstanding: corporate.currentOutstanding,
    pendingExposure,
    amount: discount.billableAmount,
    gracePercent: corporate.creditGracePercent ?? settings.credit_grace_percent,
    graceAmount: settings.credit_grace_amount,
  });
  if (!credit.allowed) {
    throw new ApiError(403, credit.reason, { credit });
  }

  const skipApproval = Boolean(booker && PANEL_BOOKERS_WITHOUT_APPROVAL.includes(booker.role));

  return {
    corporateId: corporate._id,
    corporateName: corporate.name,
    employeeId: employee._id,
    employeeUserId: employee.userId,
    departmentId: employee.departmentId || null,
    roleId: role?._id || null,
    serviceType: service,
    grossFare: round2(grossFare),
    pricing: priced.pricing,
    fareSource: priced.fareSource,
    fareBreakdown: priced.fareBreakdown,
    discount: {
      type: discount.type,
      value: discount.value,
      amount: discount.amount,
      maxPerTrip: corporate.discount?.maxPerTrip,
      appliesTo: corporate.discount?.appliesTo,
    },
    discountAmount: discount.amount,
    billableAmount: discount.billableAmount,
    allowance: {
      enabled: allowanceSnapshot.enabled,
      period: allowanceSnapshot.period,
      periodKey: allowanceSnapshot.enabled ? allowanceSnapshot.periodKey : '',
      allowanceKm: allowanceSnapshot.allowanceKm,
      remainingKmAtBooking: allowanceSnapshot.remainingKm,
      estimatedKm,
      coveredKm: split.coveredKm,
      excessKm: split.excessKm,
    },
    split: {
      companyAmount: split.companyAmount,
      employeeAmount: split.employeeAmount,
      employeePaymentMethod: payment.method,
    },
    allowedMethods,
    driverCommission: corporate.driverCommission?.enabled
      ? {
          type: corporate.driverCommission.type === 'fixed' ? 'fixed' : 'percentage',
          value: Math.max(0, Number(corporate.driverCommission.value) || 0),
        }
      : null,
    bookedByCorporateAdminId: booker?.adminId || null,
    bookingNote: String(booker?.note || '').trim().slice(0, 500),
    requiresApproval: skipApproval ? false : evaluation.requiresApproval,
    approvalReasons: skipApproval ? [] : evaluation.approvalReasons,
    approvalExpiryMinutes: Math.max(1, Number(corporate.approvalExpiryMinutes || settings.default_approval_expiry_minutes) || 30),
  };
};

/// Reserves the booking's covered km on the employee's usage row and, if
/// another booking got there first, re-splits on what was actually held.
const reserveBookingAllowance = async (booking) => {
  const allowance = { ...booking.allowance, reservedKm: 0, reservationOpen: false };
  let { split } = booking;
  if (!allowance.enabled || !(allowance.estimatedKm > 0)) return { allowance, split };

  try {
    const usage = await upsertAllowanceUsage({
      corporateId: booking.corporateId,
      employeeId: booking.employeeId,
      roleId: booking.roleId,
      period: allowance.period,
      periodKey: allowance.periodKey,
      allowanceKm: allowance.allowanceKm,
    });
    const reserved = allowance.coveredKm > 0 ? await reserveAllowanceKm({ usageId: usage._id, km: allowance.coveredKm }) : 0;
    allowance.reservedKm = reserved;
    allowance.reservationOpen = reserved > 0;
  } catch (error) {
    console.warn('[corporate-allowance] reservation failed', String(booking.employeeId), error.message);
  }

  if (allowance.reservedKm !== allowance.coveredKm) {
    const resplit = computeCorporateSplit({
      fare: booking.grossFare,
      km: allowance.estimatedKm,
      remainingKm: allowance.reservedKm,
      allowanceEnabled: true,
    });
    allowance.coveredKm = resplit.coveredKm;
    allowance.excessKm = resplit.excessKm;
    split = {
      companyAmount: resplit.companyAmount,
      employeeAmount: resplit.employeeAmount,
      employeePaymentMethod: split.employeePaymentMethod
        || (resplit.employeeAmount > 0 ? defaultEmployeePaymentMethod(booking.allowedMethods) : ''),
    };
  }
  return { allowance, split };
};

/// Stores the corporate context on a freshly created ride and, if the policy
/// asked for it, opens the approval request. Called from `createRideRecord`
/// right after `Ride.create`, before the controller starts dispatch, so the
/// dispatch gate sees `approvalStatus: 'pending'` on the same document.
///
/// A company-billed fare is fixed at the quote: bidding and rider fare raises
/// are switched off so the amount that passed the policy and credit checks is
/// the amount that gets billed. A company-tariff fare replaces the Set Price
/// fare here (`pricingSnapshot.fare_source = 'corporate_tariff'`), and a
/// company commission override replaces the Set Price commission in the
/// snapshot wallet settlement reads.
export const attachCorporateBookingToRide = async ({ ride, booking }) => {
  if (!ride || !booking || ride.paymentMethod !== 'corporate') return ride;

  const { allowance, split } = await reserveBookingAllowance(booking);
  const discount = computeCorporateDiscount({ discount: booking.discount, serviceType: booking.serviceType, fare: split.companyAmount });

  ride.corporate = {
    corporateId: booking.corporateId,
    employeeId: booking.employeeId,
    departmentId: booking.departmentId,
    approvalStatus: booking.requiresApproval ? 'pending' : 'not_required',
    discountType: booking.discount.type,
    discountValue: booking.discount.value,
    discountAmount: discount.amount,
    billedAmount: discount.billableAmount,
    roleId: booking.roleId,
    bookedByCorporateAdminId: booking.bookedByCorporateAdminId,
    bookingNote: booking.bookingNote || '',
    pricing: booking.pricing,
    driverCommission: booking.driverCommission || undefined,
    allowance,
    split: {
      companyAmount: split.companyAmount,
      employeeAmount: split.employeeAmount,
      employeePaymentMethod: split.employeePaymentMethod || '',
      employeePaymentStatus: split.employeeAmount > 0 ? 'pending' : 'not_required',
      stage: 'estimate',
    },
  };
  ride.fare = booking.grossFare;
  ride.baseFare = booking.grossFare;
  ride.bidFloorFare = booking.grossFare;
  ride.bookingMode = 'normal';
  ride.pricingNegotiationMode = 'none';
  ride.biddingStatus = 'none';
  ride.nextFareIncreaseAt = null;
  ride.userMaxBidFare = ride.fare;
  ride.bidCeilingMaxFare = ride.fare;
  if (booking.pricing === 'company_tariff') {
    ride.pricingSnapshot.fare_source = 'corporate_tariff';
    ride.pricingSnapshot.fare_breakdown = booking.fareBreakdown;
    // The rate card is the whole negotiated price; no rider platform fee on top.
    ride.pricingSnapshot.rider_platform_fee = 0;
  }
  if (booking.driverCommission) {
    // 1 = percentage, anything else = fixed (walletService normalizeCommissionType).
    ride.pricingSnapshot.admin_commission_type_from_driver = booking.driverCommission.type === 'percentage' ? 1 : 2;
    ride.pricingSnapshot.admin_commission_from_driver = booking.driverCommission.value;
  }
  try {
    await ride.save();
  } catch (error) {
    if (allowance.reservationOpen) {
      await releaseReservationForUnsavedRide(booking, allowance).catch(() => null);
    }
    throw error;
  }

  if (booking.requiresApproval) {
    // Imported lazily: the approval service reaches dispatchService, which
    // imports rideService, which imports this file.
    const { openTripRequestForRide } = await import('./corporateApprovalService.js');
    await openTripRequestForRide({ ride, booking: { ...booking, billableAmount: discount.billableAmount } });
  }

  return ride;
};

/// What the rider app shows on the payment picker: which companies the rider
/// can bill, the policy in plain terms, and how much of the month's limit is
/// left. Never throws for a rider who is not an employee.
export const getRiderCorporateProfile = async ({ userId }) => {
  const settings = await getCorporateSettings();
  const employees = await CorporateEmployee.find({ userId, active: true }).lean();
  if (!employees.length || !isFlagOn(settings.booking_enabled)) {
    return { eligible: false, memberships: [] };
  }

  const corporates = await Corporate.find({ _id: { $in: employees.map((item) => item.corporateId) } }).lean();
  const departments = await CorporateDepartment.find({
    _id: { $in: employees.map((item) => item.departmentId).filter(Boolean) },
  }).lean();
  const corporateById = new Map(corporates.map((item) => [String(item._id), item]));
  const departmentById = new Map(departments.map((item) => [String(item._id), item]));

  const memberships = [];
  for (const employee of employees) {
    const corporate = corporateById.get(String(employee.corporateId));
    if (!corporate) continue;
    const department = employee.departmentId ? departmentById.get(String(employee.departmentId)) : null;
    const role = await resolveEmployeeRole(employee);
    const monthlyLimit = resolveEmployeeMonthlyLimit({ employee, role });
    const [policy, spentThisMonth, pendingExposure, allowance] = await Promise.all([
      loadPolicy({ corporateId: corporate._id, departmentId: employee.departmentId, role, employee }),
      sumCorporateSpend({ 'corporate.employeeId': toObjectId(employee._id) }),
      sumPendingExposure(corporate._id),
      getAllowanceSnapshot({ employee, role, settings }),
    ]);
    const zoneOn = isFlagOn(settings.travel_zone_enabled) && corporate.travelZone?.mode === 'office_boundary';
    const tariffOn = isFlagOn(settings.tariff_enabled) && Boolean(corporate.tariff?.enabled);
    const credit = checkCreditLimit({
      creditLimit: corporate.creditLimit,
      currentOutstanding: corporate.currentOutstanding,
      pendingExposure,
      amount: 0,
      gracePercent: corporate.creditGracePercent ?? settings.credit_grace_percent,
      graceAmount: settings.credit_grace_amount,
    });
    const allowedServices = [corporate.allowedServices, policy.allowedServices, employee.allowedServices]
      .filter((list) => Array.isArray(list) && list.length)
      .reduce((acc, list) => acc.filter((item) => list.includes(item)), ['ride', 'parcel', 'intercity', 'rental']);

    memberships.push({
      corporateId: String(corporate._id),
      corporateName: corporate.name,
      corporateStatus: corporate.status,
      employeeId: String(employee._id),
      employeeCode: employee.employeeCode,
      department: department ? { id: String(department._id), name: department.name } : null,
      canBill: corporate.status === 'approved' && credit.allowed,
      reason: corporate.status !== 'approved' ? 'Company account is not active' : credit.reason,
      discount: {
        type: corporate.discount?.type || 'percentage',
        value: corporate.discount?.value || 0,
        appliesTo: corporate.discount?.appliesTo || [],
      },
      monthlyLimit,
      spentThisMonth,
      remainingThisMonth: monthlyLimit ? Math.max(0, round2(monthlyLimit - spentThisMonth)) : null,
      // --- v2 (contract §3.3)
      role: serializeRoleRef(role),
      allowance: {
        enabled: allowance.enabled,
        period: allowance.period,
        periodKey: allowance.periodKey,
        allowanceKm: allowance.allowanceKm,
        usedKm: allowance.usedKm,
        reservedKm: allowance.reservedKm,
        remainingKm: allowance.remainingKm,
      },
      travelZone: {
        mode: zoneOn ? 'office_boundary' : 'free_roaming',
        rule: zoneOn ? (corporate.travelZone.rule === 'either_end' ? 'either_end' : 'both_ends') : null,
        offices: zoneOn ? serializeOffices(corporate.travelZone.offices).map(({ name, lat, lng, radiusKm }) => ({ name, lat, lng, radiusKm })) : [],
      },
      excessPayment: { allowedMethods: normalizeExcessMethods(corporate.excessPayment?.allowedMethods) },
      pricing: tariffOn ? 'company_tariff' : 'standard',
      tariffAppliesTo: tariffOn ? (corporate.tariff.appliesTo?.length ? corporate.tariff.appliesTo : ['ride', 'intercity']) : [],
      policy: {
        allowedServices,
        allowedVehicleTypeIds: [...(policy.allowedVehicleTypeIds || []), ...(corporate.allowedVehicleTypeIds || [])].map(String),
        allowedHours: policy.allowedHours || [],
        outsideHoursAction: policy.outsideHoursAction,
        maxFarePerTrip: policy.maxFarePerTrip,
        requireApprovalAbove: policy.requireApprovalAbove,
        requireApprovalAlways: Boolean(policy.requireApprovalAlways || employee.requiresApproval),
      },
    });
  }

  return {
    eligible: memberships.some((item) => item.canBill),
    paymentMethod: 'corporate',
    memberships,
  };
};
