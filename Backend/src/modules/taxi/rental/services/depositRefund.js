import { creditUserWallet } from './rentalWallet.js';

/// Pays a released security deposit back to the rider.
///
/// TODAY: the remainder is credited to the rider's in-app wallet
/// (`UserWallet`), whatever way the deposit was paid. That is instant and
/// needs no gateway call.
///
/// LATER: a shared `payments/services/refundService.js` is being built
/// separately. When it lands, change ONLY `refundDepositToSource` below to
/// call it for gateway-paid deposits (`paidVia` 'razorpay' / 'phonepe', with
/// `paymentId`) and keep the wallet credit for 'wallet' and 'cash'. Nothing
/// else in the rental module calls the wallet for a deposit refund.
///
/// Returns { method, reference, amount, applied }.
export const refundDepositToSource = async ({ booking, amount }) => {
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
