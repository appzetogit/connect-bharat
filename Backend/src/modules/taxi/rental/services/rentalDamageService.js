import mongoose from 'mongoose';
import { ApiError } from '../../../../utils/ApiError.js';
import { RentalBookingRequest } from '../../admin/models/RentalBookingRequest.js';
import { RentalDamageReport } from '../models/RentalDamageReport.js';
import { roundMoney } from './rentalBilling.js';
import { deductFromDeposit, removeDepositDeductionsForReport } from './rentalDepositService.js';
import { emitRentalToAdmins, emitRentalToUser, RENTAL_SOCKET_EVENTS } from './rentalEvents.js';

/// Damage reporting (7.8).
///
/// Anyone involved can report; only an admin assesses, charges, waives or
/// settles a dispute. Charging takes the money from the held deposit first and
/// adds the rest to the booking as an `additionalCharges` entry, which the
/// billing math includes in the final charge. Re-charging or waiving a report
/// first undoes whatever that report charged before, so the booking never
/// carries two charges for one report.

const SEVERITIES = ['minor', 'moderate', 'major'];
const STAGES = ['pre', 'post', 'during'];

const isObjectId = (value) => mongoose.Types.ObjectId.isValid(String(value || ''));

const normalizeItems = (items = []) =>
  (Array.isArray(items) ? items : [])
    .map((item) => ({
      part: String(item?.part || '').trim(),
      severity: SEVERITIES.includes(String(item?.severity || '').toLowerCase()) ? String(item.severity).toLowerCase() : 'minor',
      description: String(item?.description || '').trim(),
      photos: (Array.isArray(item?.photos) ? item.photos : []).map((url) => String(url || '').trim()).filter(Boolean),
      estimatedCost: roundMoney(Math.max(0, Number(item?.estimatedCost || 0))),
    }))
    .filter((item) => item.part || item.description || item.photos.length);

export const serializeDamageReport = (report = {}) => ({
  id: String(report._id || ''),
  bookingId: String(report.bookingId?._id || report.bookingId || ''),
  bookingReference: report.bookingReference || '',
  userId: report.userId ? String(report.userId?._id || report.userId) : '',
  unitId: report.unitId ? String(report.unitId) : '',
  reportedBy: {
    role: report.reportedBy?.role || '',
    id: report.reportedBy?.id || '',
    name: report.reportedBy?.name || '',
  },
  stage: report.stage,
  items: (report.items || []).map((item) => ({
    id: String(item._id || ''),
    part: item.part || '',
    severity: item.severity || 'minor',
    description: item.description || '',
    photos: item.photos || [],
    estimatedCost: Number(item.estimatedCost || 0),
  })),
  notes: report.notes || '',
  totalEstimatedCost: Number(report.totalEstimatedCost || 0),
  assessedAmount: report.assessedAmount ?? null,
  status: report.status,
  chargedAmount: Number(report.chargedAmount || 0),
  chargedFromDeposit: Number(report.chargedFromDeposit || 0),
  chargedToFinal: Number(report.chargedToFinal || 0),
  dispute: {
    raisedAt: report.dispute?.raisedAt || null,
    reason: report.dispute?.reason || '',
  },
  resolution: report.resolution || '',
  resolvedAt: report.resolvedAt || null,
  history: report.history || [],
  createdAt: report.createdAt || null,
  updatedAt: report.updatedAt || null,
});

/// Creates a report on a booking document. Post-return reports from staff
/// also tick the inspection's `damageReviewed`, which is what the existing
/// inspection checklist calls it.
export const createDamageReport = async (booking, { stage, items, notes, reporter }) => {
  const normalizedStage = STAGES.includes(String(stage || '')) ? stage : reporter.role === 'user' ? 'during' : 'post';
  if (reporter.role === 'user' && normalizedStage !== 'during') {
    throw new ApiError(400, 'Riders can report damage during the rental only');
  }
  if (reporter.role === 'user' && !['confirmed', 'assigned', 'end_requested'].includes(String(booking.status))) {
    throw new ApiError(409, 'Damage can be reported only during an active rental');
  }
  const normalizedItems = normalizeItems(items);
  if (!normalizedItems.length) {
    throw new ApiError(400, 'At least one damage item (part, description or photo) is required');
  }

  const report = await RentalDamageReport.create({
    bookingId: booking._id,
    bookingReference: booking.bookingReference,
    userId: booking.userId?._id || booking.userId || null,
    unitId: booking.assignedUnitId || null,
    reportedBy: reporter,
    stage: normalizedStage,
    items: normalizedItems,
    notes: String(notes || '').trim(),
    totalEstimatedCost: roundMoney(normalizedItems.reduce((sum, item) => sum + item.estimatedCost, 0)),
    history: [{ action: 'reported', byRole: reporter.role, byId: reporter.id, at: new Date() }],
  });

  booking.damageReportIds = [...(booking.damageReportIds || []), report._id];
  if (normalizedStage === 'post' && reporter.role !== 'user') {
    booking.rentalInspection = booking.rentalInspection || {};
    booking.rentalInspection.afterReturn = booking.rentalInspection.afterReturn || {};
    booking.rentalInspection.afterReturn.damageReviewed = true;
  }
  await booking.save();

  const payload = { bookingId: String(booking._id), bookingReference: booking.bookingReference, report: serializeDamageReport(report.toObject()) };
  emitRentalToAdmins(RENTAL_SOCKET_EVENTS.damageReported, payload);
  if (reporter.role !== 'user') emitRentalToUser(booking.userId, RENTAL_SOCKET_EVENTS.damageReported, payload);

  return report;
};

/// Takes back whatever this report charged before.
const undoCharges = (booking, report) => {
  removeDepositDeductionsForReport(booking, report._id);
  const id = String(report._id);
  booking.additionalCharges = (booking.additionalCharges || []).filter((entry) => String(entry.damageReportId || '') !== id);
  booking.markModified('additionalCharges');
};

/// What this report already took from a deposit that is no longer held.
/// That money is gone (the rest was refunded), so it cannot be undone here
/// and must count towards any new charge rather than be taken twice.
const lockedDepositDeduction = (booking, report) => {
  if (!booking.deposit || booking.deposit.status === 'held') return 0;
  const id = String(report._id);
  return roundMoney(
    (booking.deposit.deductions || [])
      .filter((entry) => String(entry.damageReportId || '') === id)
      .reduce((sum, entry) => sum + Number(entry.amount || 0), 0),
  );
};

const applyCharge = (booking, report, amount) => {
  const locked = lockedDepositDeduction(booking, report);
  undoCharges(booking, report);
  const reason = `Damage ${report.items?.map((item) => item.part).filter(Boolean).join(', ') || 'charge'}`.slice(0, 200);
  const fromDeposit = locked > 0
    ? Math.min(locked, roundMoney(amount))
    : deductFromDeposit(booking, { amount, reason, damageReportId: report._id });
  const toFinal = roundMoney(amount - fromDeposit);
  if (toFinal > 0) {
    booking.additionalCharges.push({ type: 'damage', reason, amount: toFinal, damageReportId: report._id, createdAt: new Date() });
    booking.markModified('additionalCharges');
  }
  report.chargedAmount = roundMoney(amount);
  report.chargedFromDeposit = fromDeposit;
  report.chargedToFinal = toFinal;
};

/// Admin actions:
///   assess  {assessedAmount, notes?}           -> assessed
///   charge  {amount? (defaults to assessed/estimate)} -> charged
///   waive   {resolution?}                       -> waived (undoes any charge)
///   resolve_dispute {outcome: uphold|waive|adjust, amount?, resolution}
export const adminActOnDamageReport = async (reportId, { action, assessedAmount, amount, resolution, outcome, notes } = {}, adminId = '') => {
  if (!isObjectId(reportId)) throw new ApiError(400, 'Valid damage report id is required');
  const report = await RentalDamageReport.findById(reportId);
  if (!report) throw new ApiError(404, 'Damage report not found');
  const booking = await RentalBookingRequest.findById(report.bookingId);
  if (!booking) throw new ApiError(404, 'Rental booking not found');

  const normalizedAction = String(action || '').trim().toLowerCase();
  const by = { byRole: 'admin', byId: String(adminId || '') };
  const chargeAmount = (value) => {
    const parsed = roundMoney(value ?? report.assessedAmount ?? report.totalEstimatedCost);
    if (!(parsed >= 0)) throw new ApiError(400, 'amount must be zero or more');
    return parsed;
  };

  if (normalizedAction === 'assess') {
    const parsed = roundMoney(assessedAmount);
    if (!(parsed >= 0)) throw new ApiError(400, 'assessedAmount is required');
    report.assessedAmount = parsed;
    if (notes !== undefined) report.notes = String(notes || '').trim();
    if (report.status === 'open') report.status = 'assessed';
    report.history.push({ action: 'assessed', ...by, amount: parsed, at: new Date() });
  } else if (normalizedAction === 'charge') {
    if (report.stage === 'pre') throw new ApiError(400, 'A pre-handover report records existing damage and cannot be charged');
    const value = chargeAmount(amount);
    applyCharge(booking, report, value);
    report.status = value > 0 ? 'charged' : 'waived';
    report.history.push({ action: 'charged', ...by, amount: value, at: new Date() });
  } else if (normalizedAction === 'waive') {
    undoCharges(booking, report);
    report.chargedAmount = 0;
    report.chargedFromDeposit = 0;
    report.chargedToFinal = 0;
    report.status = 'waived';
    report.resolution = String(resolution || report.resolution || '').trim();
    report.resolvedAt = new Date();
    report.history.push({ action: 'waived', ...by, note: report.resolution, at: new Date() });
  } else if (normalizedAction === 'resolve_dispute') {
    if (report.status !== 'disputed') throw new ApiError(409, 'This report is not disputed');
    const normalizedOutcome = String(outcome || '').trim().toLowerCase();
    if (normalizedOutcome === 'waive') {
      undoCharges(booking, report);
      report.chargedAmount = 0;
      report.chargedFromDeposit = 0;
      report.chargedToFinal = 0;
      report.status = 'waived';
    } else if (normalizedOutcome === 'adjust') {
      const value = chargeAmount(amount);
      applyCharge(booking, report, value);
      report.status = value > 0 ? 'charged' : 'waived';
    } else if (normalizedOutcome === 'uphold') {
      report.status = report.chargedAmount > 0 ? 'charged' : 'assessed';
    } else {
      throw new ApiError(400, 'outcome must be uphold, waive or adjust');
    }
    report.resolution = String(resolution || '').trim();
    report.resolvedAt = new Date();
    report.history.push({ action: `dispute_${normalizedOutcome}`, ...by, amount: report.chargedAmount, note: report.resolution, at: new Date() });
  } else {
    throw new ApiError(400, 'action must be assess, charge, waive or resolve_dispute');
  }

  await booking.save();
  await report.save();

  emitRentalToUser(booking.userId, RENTAL_SOCKET_EVENTS.damageUpdated, {
    bookingId: String(booking._id),
    bookingReference: booking.bookingReference,
    report: serializeDamageReport(report.toObject()),
  });

  return { report, booking };
};

/// The rider disputes a charge or an assessment on their own booking.
export const disputeDamageReport = async (reportId, userId, { reason }) => {
  if (!isObjectId(reportId)) throw new ApiError(400, 'Valid damage report id is required');
  const report = await RentalDamageReport.findOne({ _id: reportId, userId });
  if (!report) throw new ApiError(404, 'Damage report not found');
  if (!['assessed', 'charged'].includes(report.status)) {
    throw new ApiError(409, `A ${report.status} report cannot be disputed`);
  }
  const text = String(reason || '').trim();
  if (!text) throw new ApiError(400, 'reason is required');
  report.status = 'disputed';
  report.dispute = { raisedAt: new Date(), reason: text };
  report.history.push({ action: 'disputed', byRole: 'user', byId: String(userId), note: text, at: new Date() });
  await report.save();
  emitRentalToAdmins(RENTAL_SOCKET_EVENTS.damageUpdated, {
    bookingId: String(report.bookingId),
    bookingReference: report.bookingReference,
    report: serializeDamageReport(report.toObject()),
  });
  return report;
};

export const listDamageReports = async (query = {}) => {
  const filter = {};
  if (isObjectId(query.bookingId)) filter.bookingId = query.bookingId;
  if (['open', 'assessed', 'charged', 'waived', 'disputed'].includes(String(query.status || ''))) filter.status = query.status;
  if (STAGES.includes(String(query.stage || ''))) filter.stage = query.stage;
  const reports = await RentalDamageReport.find(filter).sort({ createdAt: -1 }).limit(500).lean();
  return reports.map(serializeDamageReport);
};
