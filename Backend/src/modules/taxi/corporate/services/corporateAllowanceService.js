import mongoose from 'mongoose';
import { Ride } from '../../user/models/Ride.js';
import { CorporateAllowanceUsage } from '../models/CorporateAllowanceUsage.js';
import { round2 } from './corporatePolicyEngine.js';
import { computeRemainingKm, getAllowancePeriodKey } from './corporateV2Rules.js';
import { getCorporateSettings, isFlagOn } from './corporateSettingsService.js';

/// Free-km allowance bookkeeping (docs/plans/corporate-v2.md §1.5).
///
/// Every write to CorporateAllowanceUsage is one atomic update:
///   reserve: $inc reservedKm, guarded on usedKm + reservedKm + x <= allowanceKm
///   release: reservedKm = max(0, reservedKm - x)        (pipeline update)
///   consume: $inc usedKm, guarded on usedKm + reservedKm + x <= allowanceKm
/// so concurrent bookings can never claim the same remaining km. A ride's own
/// reservation is released exactly once, claimed by flipping
/// `Ride.corporate.allowance.reservationOpen` with a conditional update.
///
/// Nothing in this file imports rideService or dispatchService (both import
/// it), and nothing here throws into a ride flow: booking-time failures fall
/// back to "no km reserved" and completion recomputes from scratch.

const isDuplicateKeyError = (error) => error?.code === 11000;
const EPSILON = 0.0001;

/// The effective allowance for a role right now: off unless both the master
/// switch and the role say on.
export const resolveRoleAllowance = (role, settings) => {
  const enabled = Boolean(isFlagOn(settings?.allowance_enabled) && role?.active !== false && role?.allowance?.enabled);
  const period = role?.allowance?.period === 'weekly' ? 'weekly' : 'monthly';
  return {
    enabled,
    period,
    allowanceKm: enabled ? round2(Math.max(0, Number(role?.allowance?.km) || 0)) : 0,
  };
};

/// Finds (or creates) the usage row for the period and syncs its allowance to
/// the role's current figure, so an allowance raised mid-week applies at once.
export const upsertAllowanceUsage = async ({ corporateId, employeeId, roleId, period, periodKey, allowanceKm }) => {
  const filter = { employeeId, periodKey };
  const update = {
    $set: { corporateId, roleId: roleId || null, period, allowanceKm: round2(allowanceKm) },
    $setOnInsert: { usedKm: 0, reservedKm: 0, rides: 0 },
  };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await CorporateAllowanceUsage.findOneAndUpdate(filter, update, { upsert: true, returnDocument: 'after' }).lean();
    } catch (error) {
      if (!isDuplicateKeyError(error)) throw error;
    }
  }
  return CorporateAllowanceUsage.findOne(filter).lean();
};

export const readAllowanceUsage = ({ employeeId, periodKey }) => CorporateAllowanceUsage.findOne({ employeeId, periodKey }).lean();

export const serializeUsage = (usage, { period = 'monthly', periodKey = '', allowanceKm = 0, enabled = false } = {}) => {
  const row = usage || { periodKey, period, allowanceKm, usedKm: 0, reservedKm: 0, rides: 0 };
  return {
    enabled,
    period: row.period || period,
    periodKey: row.periodKey || periodKey,
    allowanceKm: round2(enabled ? allowanceKm : row.allowanceKm || 0),
    usedKm: round2(row.usedKm || 0),
    reservedKm: round2(row.reservedKm || 0),
    remainingKm: enabled ? computeRemainingKm({ allowanceKm, usedKm: row.usedKm, reservedKm: row.reservedKm }) : 0,
    rides: row.rides || 0,
  };
};

/// The allowance state an employee books against, without writing anything
/// (estimate, /users/me/corporate, panel lists).
export const getAllowanceSnapshot = async ({ employee, role, settings = null, at = new Date() }) => {
  const resolvedSettings = settings || (await getCorporateSettings());
  const allowance = resolveRoleAllowance(role, resolvedSettings);
  const periodKey = getAllowancePeriodKey(allowance.period, at);
  const usage = await readAllowanceUsage({ employeeId: employee._id, periodKey });
  return { ...serializeUsage(usage, { ...allowance, periodKey }), usage };
};

/// Holds up to `km` of the remaining allowance. Returns the km actually held
/// (which can be less than asked when another booking got there first).
export const reserveAllowanceKm = async ({ usageId, km }) => {
  let wanted = round2(Math.max(0, Number(km) || 0));
  for (let attempt = 0; attempt < 4 && wanted > 0; attempt += 1) {
    const updated = await CorporateAllowanceUsage.findOneAndUpdate(
      {
        _id: usageId,
        $expr: { $lte: [{ $add: ['$usedKm', '$reservedKm', wanted] }, { $add: ['$allowanceKm', EPSILON] }] },
      },
      { $inc: { reservedKm: wanted } },
      { returnDocument: 'after' },
    ).lean();
    if (updated) return wanted;
    const fresh = await CorporateAllowanceUsage.findById(usageId).lean();
    if (!fresh) return 0;
    wanted = round2(Math.min(wanted, computeRemainingKm(fresh)));
  }
  return 0;
};

const releaseReservedKm = async ({ employeeId, periodKey, km }) => {
  const amount = round2(Math.max(0, Number(km) || 0));
  if (!amount || !periodKey) return;
  await CorporateAllowanceUsage.updateOne(
    { employeeId, periodKey },
    [{ $set: { reservedKm: { $max: [0, { $round: [{ $subtract: ['$reservedKm', amount] }, 2] }] } } }],
    { updatePipeline: true },
  );
};

/// Adds `km` to usedKm, at most what is left. Returns the km consumed.
export const consumeAllowanceKm = async ({ usageId, km }) => {
  let wanted = round2(Math.max(0, Number(km) || 0));
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (wanted <= 0) {
      await CorporateAllowanceUsage.updateOne({ _id: usageId }, { $inc: { rides: 1 } });
      return 0;
    }
    const updated = await CorporateAllowanceUsage.findOneAndUpdate(
      {
        _id: usageId,
        $expr: { $lte: [{ $add: ['$usedKm', '$reservedKm', wanted] }, { $add: ['$allowanceKm', EPSILON] }] },
      },
      { $inc: { usedKm: wanted, rides: 1 } },
      { returnDocument: 'after' },
    ).lean();
    if (updated) return wanted;
    const fresh = await CorporateAllowanceUsage.findById(usageId).lean();
    if (!fresh) return 0;
    wanted = round2(Math.min(wanted, computeRemainingKm(fresh)));
  }
  return 0;
};

/// Releases a ride's reservation once. Safe to call from every cancel path,
/// from completion, and from the sweep; only the first caller moves km.
/// Never throws.
export const releaseRideAllowance = async (rideOrId) => {
  try {
    const rideId = rideOrId?._id || rideOrId;
    if (!rideId || !mongoose.Types.ObjectId.isValid(String(rideId))) return false;
    if (rideOrId?._id && rideOrId.paymentMethod && rideOrId.paymentMethod !== 'corporate') return false;
    const ride = await Ride.findOneAndUpdate(
      { _id: rideId, 'corporate.allowance.reservationOpen': true },
      { $set: { 'corporate.allowance.reservationOpen': false } },
      { returnDocument: 'before' },
    ).select('corporate').lean();
    if (!ride?.corporate?.allowance) return false;
    await releaseReservedKm({
      employeeId: ride.corporate.employeeId,
      periodKey: ride.corporate.allowance.periodKey,
      km: ride.corporate.allowance.reservedKm,
    });
    return true;
  } catch (error) {
    console.warn('[corporate-allowance] release failed', String(rideOrId?._id || rideOrId), error.message);
    return false;
  }
};

/// Gives back km reserved for a booking whose ride could not be saved (so no
/// ride carries the reservation to release later).
export const releaseReservationForUnsavedRide = async (booking, allowance) =>
  releaseReservedKm({ employeeId: booking.employeeId, periodKey: allowance.periodKey, km: allowance.reservedKm });

/// Fire-and-forget form for the cancel paths in dispatchService / rideService.
export const releaseRideAllowanceLater = (ride) => {
  if (!ride || (ride.paymentMethod && ride.paymentMethod !== 'corporate')) return;
  void releaseRideAllowance(ride);
};

/// Safety net run by the corporate job loop: any cancelled ride whose
/// reservation is still open (a cancel path this module has no hook in) gets
/// it released within a minute.
export const sweepStaleAllowanceReservations = async ({ limit = 200 } = {}) => {
  const rides = await Ride.find({
    paymentMethod: 'corporate',
    status: 'cancelled',
    'corporate.allowance.reservationOpen': true,
  })
    .select('_id')
    .limit(limit)
    .lean();
  let released = 0;
  for (const { _id } of rides) {
    if (await releaseRideAllowance(_id)) released += 1;
  }
  return { released };
};

/// Usage rows for one employee, newest period first.
export const listEmployeeAllowanceHistory = async ({ employeeId, limit = 6 }) =>
  CorporateAllowanceUsage.find({ employeeId })
    .sort({ periodKey: -1 })
    .limit(Math.min(52, Math.max(1, Number(limit) || 6)))
    .lean();

export const listCompanyAllowanceUsage = async ({ corporateId, periodKey }) =>
  CorporateAllowanceUsage.find({ corporateId, ...(periodKey ? { periodKey } : {}) })
    .sort({ usedKm: -1 })
    .populate('employeeId', 'name phone employeeCode departmentId')
    .populate('roleId', 'name code')
    .lean();
