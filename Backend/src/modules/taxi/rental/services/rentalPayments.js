import { ApiError } from '../../../../utils/ApiError.js';
import {
  createPhonePeRentalAdvancePaymentOrder,
  createRentalAdvancePaymentOrder,
  verifyPhonePeRentalAdvancePayment,
  verifyRentalAdvancePayment,
} from '../../user/controllers/userController.js';
import { RentalBookingRequest } from '../../admin/models/RentalBookingRequest.js';
import { debitUserWallet } from './rentalWallet.js';
import { roundMoney } from './rentalBilling.js';

/// Collects a rental deposit or extension payment.
///
/// The Razorpay and PhonePe work (credential lookup, order creation, the
/// signature check, the PhonePe SDK client and its token cache) already exists
/// in the rental-advance handlers. They are plain Express handlers and not
/// exported as functions, so rather than copy ~200 lines of gateway code they
/// are invoked here with a derived request and a capturing response. Their
/// request/response contract is what the apps already depend on, so it is
/// stable.

/// Runs an Express handler and resolves with the JSON it would have sent.
const invokeHandler = (handler, req, body, params = {}) =>
  new Promise((resolve, reject) => {
    const derivedReq = Object.create(req);
    derivedReq.body = body;
    derivedReq.params = { ...(req.params || {}), ...params };
    derivedReq.query = { ...(req.query || {}) };
    const res = {
      statusCode: 200,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(payload) {
        resolve(payload);
        return this;
      },
      send(payload) {
        resolve(payload);
        return this;
      },
      setHeader() {},
    };
    Promise.resolve(handler(derivedReq, res)).catch(reject);
  });

const SUPPORTED_ORDER_PROVIDERS = ['razorpay', 'phonepe'];
export const SUPPORTED_PAY_PROVIDERS = ['wallet', 'razorpay', 'phonepe'];

/// A gateway payment id may settle exactly one rental charge. Without this a
/// rider could replay one verified payment against a second deposit.
const assertPaymentIdUnused = async (paymentId) => {
  if (!paymentId) return;
  const reused = await RentalBookingRequest.exists({
    $or: [{ 'deposit.paymentId': paymentId }, { 'extensions.paymentId': paymentId }],
  });
  if (reused) {
    throw new ApiError(409, 'This payment has already been applied to a rental charge');
  }
};

/// Creates a gateway order for `amount`. The response is the advance flow's
/// own response, so the apps can reuse their checkout code unchanged.
export const createRentalChargeOrder = async ({ req, provider, amount, booking, purpose }) => {
  const normalized = String(provider || '').trim().toLowerCase();
  if (!SUPPORTED_ORDER_PROVIDERS.includes(normalized)) {
    throw new ApiError(400, `provider must be one of ${SUPPORTED_ORDER_PROVIDERS.join(', ')}`);
  }

  const body = {
    amount: roundMoney(amount),
    vehicleId: String(booking.vehicleTypeId?._id || booking.vehicleTypeId || ''),
    vehicleName: `${booking.vehicleName || 'Rental'} ${purpose}`.trim().slice(0, 120),
    pickup: booking.pickupDateTime ? new Date(booking.pickupDateTime).toISOString() : '',
    returnTime: booking.returnDateTime ? new Date(booking.returnDateTime).toISOString() : '',
    bookingReference: booking.bookingReference,
  };

  const payload = normalized === 'razorpay'
    ? await invokeHandler(createRentalAdvancePaymentOrder, req, body)
    : await invokeHandler(createPhonePeRentalAdvancePaymentOrder, req, body);

  return {
    provider: normalized,
    amount: roundMoney(amount),
    purpose,
    ...(payload?.data || {}),
    // The advance handler mints a fresh reference for Razorpay; the charge
    // belongs to this booking, so report the booking's own.
    bookingReference: booking.bookingReference,
  };
};

/// Collects `amount` by wallet, or verifies a gateway payment for it.
/// Resolves with { provider, paymentId, orderId, amount }.
export const collectRentalCharge = async ({ req, provider, amount, booking, referenceKey, title, payload = {} }) => {
  const normalized = String(provider || '').trim().toLowerCase();
  const expected = roundMoney(amount);
  if (!SUPPORTED_PAY_PROVIDERS.includes(normalized)) {
    throw new ApiError(400, `provider must be one of ${SUPPORTED_PAY_PROVIDERS.join(', ')}`);
  }
  if (!(expected > 0)) {
    throw new ApiError(400, 'Nothing to pay');
  }

  if (normalized === 'wallet') {
    await debitUserWallet({
      userId: booking.userId?._id || booking.userId,
      amount: expected,
      title,
      referenceKey,
      providerPaymentId: booking.bookingReference,
    });
    return { provider: 'wallet', paymentId: referenceKey, orderId: '', amount: expected };
  }

  if (normalized === 'razorpay') {
    const result = await invokeHandler(verifyRentalAdvancePayment, req, {
      razorpay_order_id: payload.razorpay_order_id || payload.orderId,
      razorpay_payment_id: payload.razorpay_payment_id || payload.paymentId,
      razorpay_signature: payload.razorpay_signature || payload.signature,
    });
    const data = result?.data || {};
    if (data.status !== 'paid') {
      throw new ApiError(402, 'Payment is not complete');
    }
    if (roundMoney(data.amount) + 0.01 < expected) {
      throw new ApiError(400, 'Paid amount is less than the amount due');
    }
    await assertPaymentIdUnused(data.paymentId);
    return { provider: 'razorpay', paymentId: data.paymentId, orderId: data.orderId || '', amount: roundMoney(data.amount) };
  }

  const merchantTransactionId = String(payload.merchantTransactionId || payload.transactionId || '').trim();
  if (!merchantTransactionId) {
    throw new ApiError(400, 'merchantTransactionId is required');
  }
  const result = await invokeHandler(verifyPhonePeRentalAdvancePayment, req, {}, { merchantTransactionId });
  const data = result?.data || {};
  if (data.status === 'pending') {
    throw new ApiError(409, 'PhonePe payment is still pending');
  }
  if (data.status !== 'paid') {
    throw new ApiError(402, data.providerMessage || 'PhonePe payment was not completed');
  }
  if (roundMoney(data.amount) + 0.01 < expected) {
    throw new ApiError(400, 'Paid amount is less than the amount due');
  }
  await assertPaymentIdUnused(merchantTransactionId);
  return { provider: 'phonepe', paymentId: merchantTransactionId, orderId: merchantTransactionId, amount: roundMoney(data.amount) };
};
