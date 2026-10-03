import crypto from 'node:crypto';

/// Pure helpers for the payments module.
///
/// Nothing here touches Mongo, env or the network, so the unit tests in
/// `Backend/test/payments.test.js` can import this file without a database or
/// a `.env`. Anything that needs settings or a gateway lives in the services.

/// Money is carried in rupees with two decimals everywhere else in this
/// codebase (fares, wallets, withdrawals), so the ledger keeps `amount` in the
/// same unit to stay readable next to those documents. It also stores
/// `amountMinor` (integer paise) and every report sums that field, because
/// adding floats over thousands of rows drifts by a paisa here and there.
export const roundMoney = (value) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  // Number.EPSILON nudges values such as 1.005 that are stored as 1.00499...
  return Math.round((numeric + Math.sign(numeric) * Number.EPSILON) * 100) / 100;
};

/// Rupees -> integer paise. Gateways (Razorpay, PhonePe) speak paise.
export const toMinorUnits = (rupees) => {
  const numeric = Number(rupees);
  if (!Number.isFinite(numeric)) return 0;
  return Math.round(roundMoney(numeric) * 100);
};

/// Integer paise -> rupees with two decimals.
export const fromMinorUnits = (paise) => {
  const numeric = Number(paise);
  if (!Number.isFinite(numeric)) return 0;
  return Math.round(numeric) / 100;
};

/// Normalises an amount the caller passes in rupees: positive, two decimals.
/// Returns 0 for anything that is not a finite positive number so callers can
/// skip with a single check.
export const normalizePositiveAmount = (value) => {
  const rounded = roundMoney(value);
  return rounded > 0 ? rounded : 0;
};

const sanitizeKeyPart = (part) =>
  String(part ?? '')
    .trim()
    .replace(/\s+/g, '_')
    .replace(/[^A-Za-z0-9_.:@-]/g, '');

/// Builds a deterministic idempotency key from parts, e.g.
/// buildIdempotencyKey('refund', 'razorpay', 'pay_123') -> 'refund:razorpay:pay_123'.
///
/// Empty parts are dropped rather than producing '::', so a missing optional
/// part does not silently create a different key per call site. Keys longer
/// than 200 characters are hashed: the unique index must stay small and
/// RazorpayX caps X-Payout-Idempotency at a few dozen characters anyway.
export const buildIdempotencyKey = (...parts) => {
  const cleaned = parts.flat().map(sanitizeKeyPart).filter(Boolean);
  if (!cleaned.length) {
    throw new Error('buildIdempotencyKey needs at least one non-empty part');
  }

  const key = cleaned.join(':');
  if (key.length <= 200) return key;
  return `${cleaned[0]}:sha256:${crypto.createHash('sha256').update(key).digest('hex')}`;
};

/// A shorter, header-safe version for gateways that limit the header length
/// (RazorpayX idempotency header). Stable for the same input.
export const buildGatewayIdempotencyHeader = (...parts) =>
  crypto.createHash('sha256').update(buildIdempotencyKey(...parts)).digest('hex').slice(0, 40);

const timingSafeEqualHex = (expectedHex, receivedHex) => {
  const expected = Buffer.from(String(expectedHex || ''), 'utf8');
  const received = Buffer.from(String(receivedHex || '').trim(), 'utf8');
  if (!expected.length || expected.length !== received.length) return false;
  return crypto.timingSafeEqual(expected, received);
};

export const computeHmacSha256Hex = (secret, payload) =>
  crypto.createHmac('sha256', String(secret)).update(payload).digest('hex');

/// Razorpay webhook signature: HMAC-SHA256 of the exact raw request body with
/// the webhook secret, hex-encoded, in the `x-razorpay-signature` header.
/// The body must be the raw bytes — re-serialising parsed JSON changes key
/// order or whitespace and the signature no longer matches.
export const verifyRazorpayWebhookSignature = ({ rawBody, signature, secret }) => {
  if (!secret || !signature || rawBody === undefined || rawBody === null) return false;
  const payload = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody), 'utf8');
  return timingSafeEqualHex(computeHmacSha256Hex(secret, payload), signature);
};

/// Razorpay checkout signature (client verify): HMAC-SHA256 of
/// `${orderId}|${paymentId}` with the API key secret.
export const verifyRazorpayCheckoutSignature = ({ orderId, paymentId, signature, keySecret }) => {
  if (!keySecret || !orderId || !paymentId || !signature) return false;
  return timingSafeEqualHex(computeHmacSha256Hex(keySecret, `${orderId}|${paymentId}`), signature);
};

/// PhonePe v2 callback auth: the `Authorization` header carries
/// SHA256(`${username}:${password}`) where username/password are what the
/// merchant set for the webhook in the PhonePe dashboard. This is exactly what
/// the SDK's `validateCallback` checks (CommonUtils.isCallbackValid); we do it
/// here too so it is unit-testable and works without an SDK client instance.
/// Some proxies prefix the value with "SHA256 " — accepted.
export const verifyPhonePeCallbackAuthorization = ({ authorization, username, password }) => {
  if (!username || !password || !authorization) return false;
  const received = String(authorization).trim().replace(/^sha256\s+/i, '');
  const expected = crypto.createHash('sha256').update(`${username}:${password}`).digest('hex');
  return timingSafeEqualHex(expected, received.toLowerCase());
};

/// Which internal flow a Razorpay order belongs to, from the notes and receipt
/// the existing create-order handlers write. Kept in one place so webhooks and
/// reports agree on the mapping.
export const classifyRazorpayOrder = (order = {}) => {
  const notes = order?.notes && typeof order.notes === 'object' ? order.notes : {};
  const receipt = String(order?.receipt || order?.reference_id || '').trim();
  const source = String(notes.source || notes.kind || notes.purpose || '').trim().toLowerCase();

  if (source === 'ride_completion' || receipt.startsWith('uride_')) return 'ride_completion';
  if (source === 'ride_tip' || receipt.startsWith('utip_')) return 'ride_tip';
  if (source === 'rental_advance_payment' || receipt.startsWith('rentadv_')) return 'rental_advance';
  if (source === 'driver_collect_amount') return 'driver_collection';
  if (source === 'driver_wallet_topup' || receipt.startsWith('dwal_')) return 'driver_wallet_topup';
  if (receipt.startsWith('uwal_')) return 'user_wallet_topup';
  if (receipt.startsWith('ubus_') || notes.busServiceId) return 'bus_booking';
  if (notes.rideId) return 'ride_other';
  if (notes.driverId && !notes.userId) return 'driver_wallet_topup';
  if (notes.userId && Object.keys(notes).length === 1) return 'user_wallet_topup';
  return 'unknown';
};

/// Which internal flow a PhonePe merchant order id belongs to. The create
/// handlers prefix the id: UWAL (user wallet), DWAL (driver wallet),
/// URNT (user rental advance).
export const classifyPhonePeMerchantOrder = (merchantOrderId = '') => {
  const id = String(merchantOrderId || '').trim().toUpperCase();
  if (id.startsWith('UWAL')) return 'user_wallet_topup';
  if (id.startsWith('DWAL')) return 'driver_wallet_topup';
  if (id.startsWith('URNT')) return 'rental_advance';
  return 'unknown';
};

/// Ledger category for an embedded UserWallet transaction. The embedded rows
/// were never typed, so this reads the provider/title the existing writers set.
export const classifyUserWalletTransaction = (tx = {}) => {
  const provider = String(tx.provider || '').trim().toLowerCase();
  const title = String(tx.title || '').trim().toLowerCase();
  const reference = String(tx.referenceKey || '').trim().toLowerCase();
  const kind = tx.kind === 'debit' ? 'debit' : 'credit';

  if ((provider === 'razorpay' || provider === 'phonepe') && kind === 'credit') return 'wallet_topup';
  if (provider === 'refund' || title.includes('refund') || reference.startsWith('refund:')) return 'refund';
  if (provider === 'ride_cancellation') return kind === 'debit' ? 'cancellation_fee' : 'refund';
  if (title.includes('referral') || reference.includes('referral')) return 'referral_bonus';
  if (provider.includes('transfer') || title.includes('transfer') || title.includes('sent to') || title.includes('received from')) {
    return 'wallet_transfer';
  }
  if (provider.includes('subscription') || title.includes('subscription')) return 'subscription';
  if (provider.includes('rental') || title.includes('rental')) return 'rental_payment';
  if (provider.includes('ride') || title.includes('ride')) return 'ride_fare';
  if (provider === 'admin' || title.includes('admin')) return 'adjustment';
  return kind === 'credit' ? 'wallet_credit' : 'wallet_debit';
};

/// Ledger category for a driver WalletTransaction.type (plus metadata hints).
export const classifyDriverWalletTransaction = (tx = {}) => {
  const type = String(tx.type || '').trim();
  const metadata = tx.metadata && typeof tx.metadata === 'object' ? tx.metadata : {};
  const source = String(metadata.source || metadata.reason || '').toLowerCase();

  if (type === 'ride_earning') return 'ride_fare';
  if (type === 'commission_deduction') return 'commission';
  if (type === 'top_up') return 'wallet_topup';
  if (type === 'subscription_purchase') return 'subscription';
  if (type === 'withdrawal' || metadata.withdrawalRequestId) {
    return Number(tx.amount) > 0 ? 'withdrawal_reversal' : 'withdrawal';
  }
  if (source.includes('tip')) return 'tip';
  if (source.includes('ride_completion')) return 'ride_fare';
  if (source.includes('joining_bonus') || source.includes('referral')) return 'bonus';
  if (source.includes('cancel')) return 'cancellation_fee';
  return 'adjustment';
};

/// Normalises a Razorpay webhook body into the pieces the handler needs.
export const parseRazorpayWebhookEvent = (body = {}) => {
  const event = String(body?.event || '').trim();
  const payload = body?.payload || {};
  const payment = payload?.payment?.entity || null;
  const refund = payload?.refund?.entity || null;
  const payout = payload?.payout?.entity || null;
  const order = payload?.order?.entity || null;
  const paymentLink = payload?.payment_link?.entity || null;

  // Razorpay sends a unique id per delivery in the `x-razorpay-event-id`
  // header; this fallback only matters for old test payloads without it.
  const entityId = refund?.id || payout?.id || payment?.id || order?.id || '';
  return {
    event,
    entityId,
    payment,
    refund,
    payout,
    order,
    paymentLink,
    createdAt: Number(body?.created_at || 0) || null,
  };
};

export const clampPagination = ({ page, limit }, { defaultLimit = 20, maxLimit = 100 } = {}) => {
  const safePage = Math.max(1, Number.parseInt(page, 10) || 1);
  const safeLimit = Math.min(maxLimit, Math.max(1, Number.parseInt(limit, 10) || defaultLimit));
  return { page: safePage, limit: safeLimit, skip: (safePage - 1) * safeLimit };
};

export const isEnabledFlag = (value, fallback = false) => {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
};
