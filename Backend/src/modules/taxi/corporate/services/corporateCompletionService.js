import { Ride } from '../../user/models/Ride.js';
import { Corporate } from '../models/Corporate.js';
import { round2 } from './corporatePolicyEngine.js';
import {
  computeCorporateSplit,
  computeRemainingKm,
  resolveFinalEmployeePayment,
} from './corporateV2Rules.js';
import {
  consumeAllowanceKm,
  releaseRideAllowance,
  upsertAllowanceUsage,
} from './corporateAllowanceService.js';
import { CorporateAllowanceUsage } from '../models/CorporateAllowanceUsage.js';

/// The final company / employee split of a completed corporate ride
/// (docs/plans/corporate-v2.md §2 "Split at completion").
///
/// Called from updateRideLifecycle after the ride is saved completed (so
/// `fare` and `actualDistanceMeters` are final) and BEFORE wallet settlement,
/// which reads `corporate.split` for the cash-excess case, and before
/// recordCorporateRideCompletion, which bills `split.companyAmount`.
///
/// Order: claim (once per ride) -> release this ride's own reservation ->
/// read what is left of the allowance -> consume min(left, actualKm) with a
/// guarded $inc -> split the final fare on actual km. Never throws: a failure
/// leaves the booking-time split in place and the company billed for it.

const ESTIMATE_FALLBACK_SOURCE = 'estimate';

export const settleCorporateRideAtCompletion = async ({ rideId }) => {
  try {
    const ride = await Ride.findOneAndUpdate(
      {
        _id: rideId,
        paymentMethod: 'corporate',
        'corporate.corporateId': { $ne: null },
        'corporate.chargedAt': null,
        $or: [{ 'corporate.allowance.settledAt': null }, { 'corporate.allowance': null }, { 'corporate.allowance.settledAt': { $exists: false } }],
      },
      { $set: { 'corporate.allowance.settledAt': new Date() } },
      { returnDocument: 'before' },
    ).lean();
    if (!ride) return null;

    const corporate = await Corporate.findById(ride.corporate.corporateId).select('excessPayment').lean();
    const booked = ride.corporate.allowance || {};
    const fare = round2(Number(ride.fare) || 0);
    const actualKm = round2(
      Number.isFinite(Number(ride.actualDistanceMeters)) && ride.actualDistanceMeters !== null
        ? Number(ride.actualDistanceMeters) / 1000
        : (Number(ride.estimatedDistanceMeters) || 0) / 1000,
    );

    // This ride's own hold comes back first, so it can be used again below.
    await releaseRideAllowance(ride._id);

    let coveredKm = actualKm;
    let enabled = Boolean(booked.enabled && booked.periodKey);
    if (enabled) {
      const usage = await upsertAllowanceUsage({
        corporateId: ride.corporate.corporateId,
        employeeId: ride.corporate.employeeId,
        roleId: ride.corporate.roleId,
        period: booked.period || 'monthly',
        periodKey: booked.periodKey,
        allowanceKm: (await currentAllowanceKm(ride.corporate.employeeId, booked.periodKey)) ?? booked.allowanceKm,
      });
      const remaining = computeRemainingKm(usage);
      coveredKm = await consumeAllowanceKm({ usageId: usage._id, km: Math.min(remaining, actualKm) });
    }

    const split = computeCorporateSplit({ fare, km: actualKm, remainingKm: coveredKm, allowanceEnabled: enabled });
    const payment = resolveFinalEmployeePayment({
      employeeAmount: split.employeeAmount,
      chosenMethod: ride.corporate.split?.employeePaymentMethod || '',
      allowedMethods: corporate?.excessPayment?.allowedMethods,
    });

    const set = {
      'corporate.allowance.enabled': enabled,
      'corporate.allowance.actualKm': actualKm,
      'corporate.allowance.coveredKm': split.coveredKm,
      'corporate.allowance.excessKm': split.excessKm,
      'corporate.allowance.reservationOpen': false,
      'corporate.split.companyAmount': split.companyAmount,
      'corporate.split.employeeAmount': split.employeeAmount,
      'corporate.split.employeePaymentMethod': payment.employeePaymentMethod,
      'corporate.split.employeePaymentStatus': payment.employeePaymentStatus,
      'corporate.split.stage': 'final',
    };
    if (!ride.corporate.allowance) {
      set['corporate.allowance.periodKey'] = '';
      set['corporate.allowance.allowanceKm'] = 0;
      set['corporate.allowance.estimatedKm'] = round2((Number(ride.estimatedDistanceMeters) || 0) / 1000);
    }
    await Ride.updateOne({ _id: ride._id }, { $set: set });
    return { ...split, ...payment, actualKm, source: ride.actualDistanceSource || ESTIMATE_FALLBACK_SOURCE };
  } catch (error) {
    console.error('[corporate-completion] final split failed for ride', String(rideId), error.message);
    return null;
  }
};

/// The usage row's allowance as it stands (the role may have changed since
/// booking; the row is kept in sync by every booking). null = no row yet.
const currentAllowanceKm = async (employeeId, periodKey) => {
  const row = await CorporateAllowanceUsage.findOne({ employeeId, periodKey }).select('allowanceKm').lean();
  return row ? row.allowanceKm : null;
};

/// The amount the rider-app completion payment endpoints may charge on a
/// corporate ride: the employee's excess share when it is to be paid online or
/// from the wallet and is not paid yet; 0 otherwise (company-paid in full, or
/// the driver collected it in cash). Returns null for a non-corporate ride.
export const corporateEmployeeAmountDue = (ride) => {
  if (!ride || ride.paymentMethod !== 'corporate') return null;
  const split = ride.corporate?.split;
  if (!split || split.stage !== 'final') return 0;
  if (!(Number(split.employeeAmount) > 0)) return 0;
  if (split.employeePaymentMethod === 'cash' || split.employeePaymentStatus === 'paid') return 0;
  return round2(split.employeeAmount);
};

/// Marks the employee's share paid on a (mongoose) ride document instead of
/// turning the ride into an online ride. Returns true when it handled it.
export const markCorporateEmployeeSharePaid = (ride, method = 'online') => {
  if (!ride || ride.paymentMethod !== 'corporate' || !ride.corporate) return false;
  if (ride.corporate.split) {
    ride.corporate.split.employeePaymentStatus = 'paid';
    ride.corporate.split.employeePaymentMethod = method === 'wallet' ? 'wallet' : 'online';
  }
  return true;
};

/// `$set` paths for the same, for code that updates with updateOne.
export const corporateEmployeePaidUpdate = (ride, method = 'online') =>
  (ride?.paymentMethod === 'corporate'
    ? { 'corporate.split.employeePaymentStatus': 'paid', 'corporate.split.employeePaymentMethod': method === 'wallet' ? 'wallet' : 'online' }
    : null);
