import { ApiError } from '../../../../utils/ApiError.js';
import { depositBalance, roundMoney } from './rentalBilling.js';
import { refundDepositToSource } from './depositRefund.js';
import { emitRentalToUser, RENTAL_SOCKET_EVENTS } from './rentalEvents.js';

export { depositBalance };

/// Security deposit lifecycle on a booking document:
///
///   not_required                      (vehicle has no deposit)
///   pending  -> held                  (rider pays, or staff collect cash)
///   held     -> released              (all of it back)
///            -> partially_released    (some kept for damage/fees)
///            -> forfeited             (all of it kept)
///
/// Damage charges taken from the deposit are recorded as `deductions` while it
/// is held; release refunds what is left after all deductions.

const assertDepositPending = (booking) => {
  if (!booking.deposit?.required) {
    throw new ApiError(400, 'This booking has no security deposit');
  }
  if (booking.deposit.status === 'held') {
    throw new ApiError(409, 'The security deposit has already been paid');
  }
  if (booking.deposit.status !== 'pending') {
    throw new ApiError(409, `The security deposit is ${booking.deposit.status}`);
  }
  if (booking.status === 'cancelled') {
    throw new ApiError(409, 'This booking is cancelled');
  }
};

export const markDepositHeld = (booking, { paidVia, paymentId = '', orderId = '' }) => {
  assertDepositPending(booking);
  booking.deposit.status = 'held';
  booking.deposit.paidVia = paidVia;
  booking.deposit.paymentId = paymentId;
  booking.deposit.orderId = orderId;
  booking.deposit.paidAt = new Date();
  booking.markModified('deposit');
};

export { assertDepositPending };

/// Records a deduction against a held deposit. Returns the amount actually
/// taken (capped by what is left).
export const deductFromDeposit = (booking, { amount, reason, damageReportId = null }) => {
  if (!booking.deposit?.required || booking.deposit.status !== 'held') return 0;
  const taken = Math.min(roundMoney(amount), depositBalance(booking.deposit));
  if (!(taken > 0)) return 0;
  booking.deposit.deductions.push({ amount: taken, reason, damageReportId, createdAt: new Date() });
  booking.markModified('deposit');
  return taken;
};

/// Removes every deduction linked to a damage report (when a charge is
/// re-assessed or waived). Only possible while the deposit is still held.
export const removeDepositDeductionsForReport = (booking, damageReportId) => {
  if (!booking.deposit || booking.deposit.status !== 'held') return 0;
  const id = String(damageReportId);
  const before = booking.deposit.deductions.length;
  const removed = booking.deposit.deductions
    .filter((entry) => String(entry.damageReportId || '') === id)
    .reduce((sum, entry) => sum + Number(entry.amount || 0), 0);
  booking.deposit.deductions = booking.deposit.deductions.filter((entry) => String(entry.damageReportId || '') !== id);
  if (booking.deposit.deductions.length !== before) booking.markModified('deposit');
  return roundMoney(removed);
};

/// Releases a held deposit: applies any extra `deductions`, refunds the rest
/// through depositRefund.js and saves the booking.
export const releaseDeposit = async (booking, { deductions = [], actor = 'admin' } = {}) => {
  if (!booking.deposit?.required) {
    throw new ApiError(400, 'This booking has no security deposit');
  }
  if (booking.deposit.status !== 'held') {
    throw new ApiError(409, `The security deposit is ${booking.deposit.status}, not held`);
  }
  if (!['completed', 'cancelled', 'end_requested'].includes(String(booking.status))) {
    throw new ApiError(409, 'The deposit can be released once the rental has ended or been cancelled');
  }

  for (const entry of Array.isArray(deductions) ? deductions : []) {
    const amount = roundMoney(entry?.amount);
    if (!(amount > 0)) continue;
    const reason = String(entry?.reason || '').trim();
    if (!reason) throw new ApiError(400, 'Each deduction needs a reason');
    if (amount > depositBalance(booking.deposit) + 0.001) {
      throw new ApiError(400, 'Deductions exceed the deposit');
    }
    booking.deposit.deductions.push({
      amount,
      reason,
      damageReportId: entry?.damageReportId || null,
      createdAt: new Date(),
    });
  }

  const refundable = depositBalance(booking.deposit);
  const refund = refundable > 0 ? await refundDepositToSource({ booking, amount: refundable }) : null;

  booking.deposit.releasedAmount = refundable;
  booking.deposit.releasedAt = new Date();
  booking.deposit.releasedVia = refund?.method || '';
  booking.deposit.refundReference = refund?.reference || '';
  booking.deposit.status = refundable <= 0
    ? 'forfeited'
    : refundable < roundMoney(booking.deposit.amount)
      ? 'partially_released'
      : 'released';
  booking.markModified('deposit');
  await booking.save();

  emitRentalToUser(booking.userId, RENTAL_SOCKET_EVENTS.depositUpdated, {
    bookingId: String(booking._id),
    status: booking.deposit.status,
    releasedAmount: refundable,
    releasedVia: booking.deposit.releasedVia,
    actor,
  });

  return booking;
};
