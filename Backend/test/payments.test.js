import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { test } from 'node:test';
import {
  buildGatewayIdempotencyHeader,
  buildIdempotencyKey,
  classifyDriverWalletTransaction,
  classifyPhonePeMerchantOrder,
  classifyRazorpayOrder,
  classifyUserWalletTransaction,
  clampPagination,
  fromMinorUnits,
  normalizePositiveAmount,
  parseRazorpayWebhookEvent,
  roundMoney,
  toMinorUnits,
  verifyPhonePeCallbackAuthorization,
  verifyRazorpayCheckoutSignature,
  verifyRazorpayWebhookSignature,
} from '../src/modules/taxi/payments/utils/paymentUtils.js';
import {
  buildUserWalletTransfer,
  extractPushedWalletTransactions,
} from '../src/modules/taxi/payments/plugins/walletLedgerPlugins.js';

const hmac = (secret, body) => crypto.createHmac('sha256', secret).update(body).digest('hex');

test('razorpay webhook signature: accepts the exact raw body, rejects anything else', () => {
  const secret = 'whsec_test';
  const rawBody = Buffer.from('{"event":"payment.captured","payload":{"payment":{"entity":{"id":"pay_1"}}}}');
  const signature = hmac(secret, rawBody);

  assert.equal(verifyRazorpayWebhookSignature({ rawBody, signature, secret }), true);
  assert.equal(verifyRazorpayWebhookSignature({ rawBody: rawBody.toString('utf8'), signature, secret }), true);
  // Re-serialised JSON (what you get after express.json) does not match.
  const reserialised = JSON.stringify(JSON.parse(rawBody.toString('utf8')), null, 2);
  assert.equal(verifyRazorpayWebhookSignature({ rawBody: reserialised, signature, secret }), false);
  assert.equal(verifyRazorpayWebhookSignature({ rawBody, signature, secret: 'other' }), false);
  assert.equal(verifyRazorpayWebhookSignature({ rawBody, signature: signature.slice(0, -1), secret }), false);
  assert.equal(verifyRazorpayWebhookSignature({ rawBody, signature: '', secret }), false);
  assert.equal(verifyRazorpayWebhookSignature({ rawBody, signature, secret: '' }), false);
});

test('razorpay checkout signature: HMAC of order_id|payment_id', () => {
  const keySecret = 'key_secret';
  const signature = hmac(keySecret, 'order_1|pay_1');
  assert.equal(verifyRazorpayCheckoutSignature({ orderId: 'order_1', paymentId: 'pay_1', signature, keySecret }), true);
  assert.equal(verifyRazorpayCheckoutSignature({ orderId: 'order_1', paymentId: 'pay_2', signature, keySecret }), false);
  assert.equal(verifyRazorpayCheckoutSignature({ orderId: '', paymentId: 'pay_1', signature, keySecret }), false);
});

test('phonepe callback authorization: SHA256(username:password), optional "SHA256 " prefix', () => {
  const username = 'merchant_user';
  const password = 'merchant_pass';
  const hash = crypto.createHash('sha256').update(`${username}:${password}`).digest('hex');

  assert.equal(verifyPhonePeCallbackAuthorization({ authorization: hash, username, password }), true);
  assert.equal(verifyPhonePeCallbackAuthorization({ authorization: `SHA256 ${hash}`, username, password }), true);
  assert.equal(verifyPhonePeCallbackAuthorization({ authorization: hash.toUpperCase(), username, password }), true);
  assert.equal(verifyPhonePeCallbackAuthorization({ authorization: hash, username, password: 'wrong' }), false);
  assert.equal(verifyPhonePeCallbackAuthorization({ authorization: '', username, password }), false);
  assert.equal(verifyPhonePeCallbackAuthorization({ authorization: hash, username: '', password }), false);
});

test('idempotency keys are deterministic, drop empty parts and stay bounded', () => {
  assert.equal(buildIdempotencyKey('refund', 'razorpay', 'pay_123'), 'refund:razorpay:pay_123');
  assert.equal(buildIdempotencyKey('refund', '', null, 'pay_123'), 'refund:pay_123');
  assert.equal(buildIdempotencyKey(['a', 'b'], 'c'), 'a:b:c');
  assert.equal(buildIdempotencyKey('x', 'has space', 'we/ird$chars'), 'x:has_space:weirdchars');
  assert.equal(buildIdempotencyKey('refund', 42), 'refund:42');
  assert.throws(() => buildIdempotencyKey('', null));

  const long = buildIdempotencyKey('payout', 'x'.repeat(500));
  assert.ok(long.length <= 200);
  assert.ok(long.startsWith('payout:sha256:'));
  assert.equal(long, buildIdempotencyKey('payout', 'x'.repeat(500)));

  const header = buildGatewayIdempotencyHeader('payout', 'withdrawal', '64f0c0ffee');
  assert.equal(header.length, 40);
  assert.equal(header, buildGatewayIdempotencyHeader('payout', 'withdrawal', '64f0c0ffee'));
  assert.notEqual(header, buildGatewayIdempotencyHeader('payout', 'withdrawal', '64f0c0ffef'));
});

test('amount conversion between rupees and paise', () => {
  assert.equal(toMinorUnits(100), 10000);
  assert.equal(toMinorUnits(199.99), 19999);
  assert.equal(toMinorUnits(0.1 + 0.2), 30);
  assert.equal(toMinorUnits(1.005), 101);
  assert.equal(toMinorUnits('250.50'), 25050);
  assert.equal(toMinorUnits('abc'), 0);
  assert.equal(fromMinorUnits(19999), 199.99);
  assert.equal(fromMinorUnits('100'), 1);
  assert.equal(fromMinorUnits(undefined), 0);
  assert.equal(roundMoney(10.456), 10.46);
  assert.equal(roundMoney(-10.454), -10.45);
  assert.equal(normalizePositiveAmount(-5), 0);
  assert.equal(normalizePositiveAmount('12.345'), 12.35);
  for (const rupees of [0.01, 1, 49.5, 99.99, 1234.56, 100000]) {
    assert.equal(fromMinorUnits(toMinorUnits(rupees)), rupees);
  }
});

test('razorpay order classification follows the notes/receipts the controllers write', () => {
  assert.equal(classifyRazorpayOrder({ receipt: 'uwal_abc_123', notes: { userId: 'u1' } }), 'user_wallet_topup');
  assert.equal(classifyRazorpayOrder({ receipt: 'dwal_abc_123', notes: { driverId: 'd1' } }), 'driver_wallet_topup');
  assert.equal(classifyRazorpayOrder({ notes: { driverId: 'd1', source: 'driver_wallet_topup' } }), 'driver_wallet_topup');
  assert.equal(classifyRazorpayOrder({ notes: { rideId: 'r', userId: 'u', driverId: 'd', source: 'ride_completion' } }), 'ride_completion');
  assert.equal(classifyRazorpayOrder({ receipt: 'utip_x', notes: { kind: 'ride_tip', rideId: 'r' } }), 'ride_tip');
  assert.equal(classifyRazorpayOrder({ receipt: 'rentadv_x', notes: { purpose: 'rental_advance_payment' } }), 'rental_advance');
  assert.equal(classifyRazorpayOrder({ receipt: 'ubus_x', notes: { userId: 'u', busServiceId: 'b' } }), 'bus_booking');
  assert.equal(classifyRazorpayOrder({ notes: { rideId: 'r', driverId: 'd', source: 'driver_collect_amount' } }), 'driver_collection');
  assert.equal(classifyRazorpayOrder({ notes: { userId: 'u1' } }), 'user_wallet_topup');
  assert.equal(classifyRazorpayOrder({}), 'unknown');

  assert.equal(classifyPhonePeMerchantOrder('UWAL1700000000000abcd1234'), 'user_wallet_topup');
  assert.equal(classifyPhonePeMerchantOrder('DWAL1700000000000abcd1234'), 'driver_wallet_topup');
  assert.equal(classifyPhonePeMerchantOrder('URNT1700000000000abcd1234'), 'rental_advance');
  assert.equal(classifyPhonePeMerchantOrder('XYZ'), 'unknown');
});

test('wallet transaction categories', () => {
  assert.equal(classifyUserWalletTransaction({ kind: 'credit', provider: 'razorpay' }), 'wallet_topup');
  assert.equal(classifyUserWalletTransaction({ kind: 'credit', provider: 'refund' }), 'refund');
  assert.equal(classifyUserWalletTransaction({ kind: 'debit', provider: 'ride_cancellation' }), 'cancellation_fee');
  assert.equal(classifyUserWalletTransaction({ kind: 'credit', provider: 'ride_cancellation' }), 'refund');
  assert.equal(classifyUserWalletTransaction({ kind: 'credit', title: 'Referral Reward', referenceKey: 'referral:x' }), 'referral_bonus');
  assert.equal(classifyUserWalletTransaction({ kind: 'debit', provider: 'ride_completion_wallet', title: 'Ride payment for abc' }), 'ride_fare');
  assert.equal(classifyUserWalletTransaction({ kind: 'debit' }), 'wallet_debit');

  assert.equal(classifyDriverWalletTransaction({ type: 'ride_earning', amount: 90 }), 'ride_fare');
  assert.equal(classifyDriverWalletTransaction({ type: 'commission_deduction', amount: -10 }), 'commission');
  assert.equal(classifyDriverWalletTransaction({ type: 'withdrawal', amount: -500 }), 'withdrawal');
  assert.equal(classifyDriverWalletTransaction({ type: 'withdrawal', amount: 500, metadata: { reversal: true } }), 'withdrawal_reversal');
  // Older withdrawals were written as 'adjustment' with a withdrawalRequestId.
  assert.equal(classifyDriverWalletTransaction({ type: 'adjustment', amount: -500, metadata: { withdrawalRequestId: 'w1' } }), 'withdrawal');
  assert.equal(classifyDriverWalletTransaction({ type: 'adjustment', amount: 20, metadata: { source: 'ride_tip' } }), 'tip');
});

test('pushed wallet transactions are read from both $push shapes', () => {
  const tx = { kind: 'credit', amount: 10 };
  assert.deepEqual(extractPushedWalletTransactions({ $push: { transactions: { $each: [tx], $slice: -50 } } }), [tx]);
  assert.deepEqual(extractPushedWalletTransactions({ $push: { transactions: tx } }), [tx]);
  assert.deepEqual(extractPushedWalletTransactions({ $inc: { balance: 10 } }), []);
  assert.deepEqual(extractPushedWalletTransactions({}), []);
});

test('user wallet movements become one double-entry transfer with a stable key', () => {
  const topup = buildUserWalletTransfer({
    userId: 'u1',
    tx: { _id: 't1', kind: 'credit', amount: 250, provider: 'razorpay', providerOrderId: 'order_1', providerPaymentId: 'pay_1' },
    walletField: 'balance',
    balanceAfter: 300,
  });
  assert.equal(topup.category, 'wallet_topup');
  assert.deepEqual(topup.from, { type: 'gateway', id: 'razorpay' });
  assert.deepEqual(topup.to, { type: 'user', id: 'u1', wallet: 'balance' });
  assert.equal(topup.idempotencyKey, 'user_wallet:u1:pay:razorpay:pay_1:credit');
  assert.equal(topup.toBalanceAfter, 300);

  const fee = buildUserWalletTransfer({
    userId: 'u1',
    tx: { _id: 't2', kind: 'debit', amount: 20, provider: 'ride_cancellation', referenceKey: 'ride:r1:fee' },
    walletField: 'balance',
  });
  assert.equal(fee.category, 'cancellation_fee');
  assert.deepEqual(fee.from, { type: 'user', id: 'u1', wallet: 'balance' });
  assert.deepEqual(fee.to, { type: 'platform', id: 'platform' });
  assert.equal(fee.idempotencyKey, 'user_wallet:u1:ref:ride:r1:fee:debit');

  assert.equal(buildUserWalletTransfer({ userId: 'u1', tx: { kind: 'credit', amount: 0 }, walletField: 'balance' }), null);
});

test('razorpay webhook payload parsing and pagination clamps', () => {
  const parsed = parseRazorpayWebhookEvent({
    event: 'refund.processed',
    created_at: 1700000000,
    payload: { refund: { entity: { id: 'rfnd_1', payment_id: 'pay_1' } }, payment: { entity: { id: 'pay_1' } } },
  });
  assert.equal(parsed.event, 'refund.processed');
  assert.equal(parsed.entityId, 'rfnd_1');
  assert.equal(parsed.payment.id, 'pay_1');

  assert.deepEqual(clampPagination({ page: '0', limit: '1000' }), { page: 1, limit: 100, skip: 0 });
  assert.deepEqual(clampPagination({ page: '3', limit: '10' }), { page: 3, limit: 10, skip: 20 });
});
