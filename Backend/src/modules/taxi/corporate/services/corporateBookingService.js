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
  evaluateTripPolicy,
  getIstMonthRange,
  mergePolicies,
  normalizeCorporateServiceType,
  round2,
} from './corporatePolicyEngine.js';
import { getCorporateSettings, isFlagOn } from './corporateSettingsService.js';

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

const loadPolicy = async ({ corporateId, departmentId }) => {
  const policies = await CorporateTripPolicy.find({
    corporateId,
    departmentId: { $in: departmentId ? [null, departmentId] : [null] },
  }).lean();
  const company = policies.find((item) => !item.departmentId) || null;
  const department = departmentId ? policies.find((item) => String(item.departmentId) === String(departmentId)) || null : null;
  return mergePolicies(company, department);
};

/// The membership a rider books under. A rider can belong to more than one
/// company; without an explicit `corporateId` the oldest active one is used.
export const findActiveMembership = async ({ userId, corporateId = null }) => {
  const filter = { userId, active: true };
  if (corporateId && mongoose.Types.ObjectId.isValid(String(corporateId))) filter.corporateId = corporateId;
  const employees = await CorporateEmployee.find(filter).sort({ createdAt: 1 }).lean();
  if (!employees.length) return null;

  const corporates = await Corporate.find({ _id: { $in: employees.map((item) => item.corporateId) } }).lean();
  const byId = new Map(corporates.map((item) => [String(item._id), item]));
  const employee = employees.find((item) => byId.get(String(item.corporateId))?.status === 'approved') || employees[0];
  return { employee, corporate: byId.get(String(employee.corporateId)) || null };
};

/// Decides whether a booking may be billed to the rider's company.
///
/// Called from `createRideRecord` once the server-side fare is known. Throws
/// ApiError(403) with the reasons when the trip is not allowed; otherwise
/// returns what the ride needs to store, including whether dispatch must wait
/// for an approver.
export const validateCorporateBooking = async ({ userId, serviceType, vehicleTypeId, fare, scheduledAt, corporateId = null }) => {
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
  const grossFare = Math.max(0, Number(fare) || 0);
  const discount = computeCorporateDiscount({ discount: corporate.discount, serviceType: service, fare: grossFare });

  const [department, policy, employeeMonthSpend, pendingExposure] = await Promise.all([
    employee.departmentId ? CorporateDepartment.findById(employee.departmentId).lean() : null,
    loadPolicy({ corporateId: corporate._id, departmentId: employee.departmentId }),
    sumCorporateSpend({ 'corporate.employeeId': toObjectId(employee._id) }),
    sumPendingExposure(corporate._id),
  ]);
  const departmentMonthSpend = department
    ? await sumCorporateSpend({ 'corporate.departmentId': toObjectId(department._id) })
    : 0;

  const evaluation = evaluateTripPolicy({
    corporate,
    policy,
    employee,
    department,
    trip: { serviceType: service, vehicleTypeId, fare: discount.billableAmount, at: scheduledAt || new Date() },
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

  return {
    corporateId: corporate._id,
    corporateName: corporate.name,
    employeeId: employee._id,
    departmentId: employee.departmentId || null,
    serviceType: service,
    grossFare: round2(grossFare),
    discount: { type: discount.type, value: discount.value, amount: discount.amount },
    discountAmount: discount.amount,
    billableAmount: discount.billableAmount,
    requiresApproval: evaluation.requiresApproval,
    approvalReasons: evaluation.approvalReasons,
    approvalExpiryMinutes: Math.max(1, Number(corporate.approvalExpiryMinutes || settings.default_approval_expiry_minutes) || 30),
  };
};

/// Stores the corporate context on a freshly created ride and, if the policy
/// asked for it, opens the approval request. Called from `createRideRecord`
/// right after `Ride.create`, before the controller starts dispatch, so the
/// dispatch gate sees `approvalStatus: 'pending'` on the same document.
///
/// A company-billed fare is fixed at the quote: bidding and rider fare raises
/// are switched off so the amount that passed the policy and credit checks is
/// the amount that gets billed.
export const attachCorporateBookingToRide = async ({ ride, booking }) => {
  if (!ride || !booking || ride.paymentMethod !== 'corporate') return ride;

  ride.corporate = {
    corporateId: booking.corporateId,
    employeeId: booking.employeeId,
    departmentId: booking.departmentId,
    approvalStatus: booking.requiresApproval ? 'pending' : 'not_required',
    discountType: booking.discount.type,
    discountValue: booking.discount.value,
    discountAmount: booking.discountAmount,
    billedAmount: booking.billableAmount,
  };
  ride.fare = booking.grossFare;
  ride.bookingMode = 'normal';
  ride.pricingNegotiationMode = 'none';
  ride.biddingStatus = 'none';
  ride.nextFareIncreaseAt = null;
  ride.userMaxBidFare = ride.fare;
  ride.bidCeilingMaxFare = ride.fare;
  await ride.save();

  if (booking.requiresApproval) {
    // Imported lazily: the approval service reaches dispatchService, which
    // imports rideService, which imports this file.
    const { openTripRequestForRide } = await import('./corporateApprovalService.js');
    await openTripRequestForRide({ ride, booking });
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
    const [policy, spentThisMonth, pendingExposure] = await Promise.all([
      loadPolicy({ corporateId: corporate._id, departmentId: employee.departmentId }),
      sumCorporateSpend({ 'corporate.employeeId': toObjectId(employee._id) }),
      sumPendingExposure(corporate._id),
    ]);
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
      monthlyLimit: employee.monthlyLimit || 0,
      spentThisMonth,
      remainingThisMonth: employee.monthlyLimit ? Math.max(0, round2(employee.monthlyLimit - spentThisMonth)) : null,
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
