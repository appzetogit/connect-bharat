import { Env, RefundRequest, StandardCheckoutClient } from '@phonepe-pg/pg-sdk-node';
import { ApiError } from '../../../../utils/ApiError.js';
import { resolveConfiguredGatewayCredentials } from '../../services/paymentGatewayService.js';
import { getPaymentSettings } from './paymentSettingsService.js';

/// Thin gateway clients for the payments module.
///
/// The controllers each carry a private copy of these helpers; this module
/// is the shared one for webhooks, refunds and payouts. It uses the same
/// credentials resolver as the controllers, so the admin's gateway settings
/// remain the single source of truth.

const RAZORPAY_BASE_URL = 'https://api.razorpay.com/v1';

export const resolveRazorpayKeys = async () => {
  try {
    return await resolveConfiguredGatewayCredentials('razor_pay');
  } catch (error) {
    // Webhooks, refunds and payouts for an existing payment must work even
    // after an admin switches the active gateway to PhonePe; env keys are
    // the fallback.
    const keyId = String(process.env.RAZORPAY_KEY_ID || '').trim();
    const keySecret = String(process.env.RAZORPAY_KEY_SECRET || '').trim();
    if (keyId && keySecret) return { keyId, keySecret, environment: 'env' };
    throw error;
  }
};

/// Razorpay REST call. `idempotencyKey` is sent as X-Payout-Idempotency,
/// which RazorpayX requires for payouts (and Razorpay ignores elsewhere).
export const razorpayApi = async ({ method = 'GET', path, body, idempotencyKey = '', keys = null }) => {
  const { keyId, keySecret } = keys || (await resolveRazorpayKeys());
  const headers = {
    Authorization: `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString('base64')}`,
    'Content-Type': 'application/json',
  };
  if (idempotencyKey) headers['X-Payout-Idempotency'] = idempotencyKey;

  const response = await fetch(`${RAZORPAY_BASE_URL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    throw new ApiError(
      response.status || 502,
      payload?.error?.description || payload?.error?.message || 'Razorpay request failed',
      { provider: 'razorpay', path, code: payload?.error?.code || null, reason: payload?.error?.reason || null },
    );
  }

  return payload;
};

export const fetchRazorpayOrder = (orderId) =>
  razorpayApi({ method: 'GET', path: `/orders/${encodeURIComponent(orderId)}` });

export const fetchRazorpayPayment = (paymentId) =>
  razorpayApi({ method: 'GET', path: `/payments/${encodeURIComponent(paymentId)}` });

/// RazorpayX payouts are debited from a RazorpayX current account; its
/// number comes from payments settings, then env.
export const resolveRazorpayXAccountNumber = async () => {
  const settings = await getPaymentSettings();
  const accountNumber =
    String(settings.razorpayx_account_number || '').trim() ||
    String(process.env.RAZORPAYX_ACCOUNT_NUMBER || '').trim();
  if (!accountNumber) {
    throw new ApiError(500, 'RazorpayX account number is not configured (payments.razorpayx_account_number or RAZORPAYX_ACCOUNT_NUMBER)');
  }
  return accountNumber;
};

const phonePeClients = new Map();

export const getPhonePeClient = async () => {
  const { clientId, clientSecret, clientVersion, environment } = await resolveConfiguredGatewayCredentials('phone_pay');
  const normalizedEnvironment = String(environment || 'test').trim().toLowerCase();
  const version = Number.parseInt(String(clientVersion || '1'), 10) || 1;
  const cacheKey = `${normalizedEnvironment}::${clientId}::${version}`;

  if (!phonePeClients.has(cacheKey)) {
    phonePeClients.set(
      cacheKey,
      StandardCheckoutClient.getInstance(
        clientId,
        clientSecret,
        version,
        normalizedEnvironment === 'production' ? Env.PRODUCTION : Env.SANDBOX,
      ),
    );
  }

  return phonePeClients.get(cacheKey);
};

/// Same call the `/wallet/phonepe/status/:id` handlers make.
export const fetchPhonePeOrderStatus = async (merchantOrderId) => {
  const client = await getPhonePeClient();
  return client.getOrderStatus(String(merchantOrderId));
};

/// Normalises a PhonePe order-status response the same way the status
/// handlers in userController/driverController do.
export const summarizePhonePeOrderStatus = (merchantOrderId, payload = {}) => {
  const paymentDetails = Array.isArray(payload?.paymentDetails) ? payload.paymentDetails : [];
  const latestPayment = paymentDetails[0] || {};
  const state = String(payload?.state || latestPayment?.state || '').trim().toUpperCase();
  const paymentId = String(
    latestPayment?.transactionId || latestPayment?.paymentTransactionId || merchantOrderId || '',
  ).trim();
  const amount = Math.round(Number(payload?.amount || latestPayment?.amount || 0)) / 100;
  return { state, paymentId, amount, latestPayment };
};

export const createPhonePeRefund = async ({ merchantRefundId, originalMerchantOrderId, amountPaise }) => {
  const client = await getPhonePeClient();
  const request = RefundRequest.builder()
    .merchantRefundId(String(merchantRefundId))
    .originalMerchantOrderId(String(originalMerchantOrderId))
    .amount(Number(amountPaise))
    .build();
  return client.refund(request);
};
