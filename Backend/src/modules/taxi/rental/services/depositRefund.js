import { creditUserWallet } from './rentalWallet.js';
import { refundPaymentSafely } from '../../payments/services/refundService.js';

/// Pays a released security deposit back to the rider.
///
/// Gateway-paid deposits go back to their source through
/// payments/services/refundService.js; wallet and cash deposits are credited
/// to the rider's in-app wallet. Nothing else in the rental module refunds a
/// deposit.
///
/// Returns { method, reference, amount, applied }.
const GATEWAY_PROVIDERS = new Set(['razorpay', 'phonepe']);

export const refundDepositToSource = async ({ booking, amount }) => {
  // A deposit paid through a gateway goes back to the card/UPI it came from,
  // through the shared refund service (which also queues it for admin review
  // while payments.auto_refund_enabled is off). Wallet and cash deposits, and
  // any gateway refund the service could not even record, fall back to the
  // wallet credit below so the rider is never left with nothing.
  const paidVia = String(booking.deposit?.paidVia || '').trim().toLowerCase();
  const paymentId = String(booking.deposit?.paymentId || '').trim();
  if (GATEWAY_PROVIDERS.has(paidVia) && paymentId) {
    const refund = await refundPaymentSafely({
      provider: paidVia,
      paymentId,
      amount,
      reason: 'Rental security deposit release',
      reference: { kind: 'rental_deposit', id: String(booking._id) },
      userId: booking.userId?._id || booking.userId,
      service: 'rental',
      metadata: { capturedAmount: Number(booking.deposit?.amount || 0) },
    }, 'rental deposit');
    if (refund) {
      return {
        method: paidVia,
        reference: String(refund._id),
        amount,
        applied: refund.status === 'processed',
        refundStatus: refund.status,
      };
    }
  }

  const referenceKey = `rental_deposit_refund_${String(booking._id)}`;
  const result = await creditUserWallet({
    userId: booking.userId?._id || booking.userId,
    amount,
    title: `Rental deposit refund ${booking.bookingReference || ''}`.trim(),
    referenceKey,
    providerPaymentId: booking.deposit?.paymentId || '',
  });

  return {
    method: 'wallet',
    reference: referenceKey,
    amount,
    applied: result.applied,
  };
};
