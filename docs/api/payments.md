# Payments API — ledger, webhooks, refunds, payouts

Covers SOW items 10.1, 10.5, 10.6, 2.12, 2.15 and 9.9, and audit bugs 4 (no webhooks) and 5 (wallet history capped at 50).
Code: `Backend/src/modules/taxi/payments/`.

All REST paths below work under both `/api/v1` and `/api`. Responses follow the existing envelope:

```json
{ "success": true, "data": { ... }, "message": "optional" }
```

Errors: `{ "success": false, "message": "..." }` with the HTTP status.

**Money units.** Every amount in these APIs is **rupees with two decimals** (the same unit used everywhere else in this backend). Gateways use paise internally. The ledger also stores `amountMinor` (integer paise), and all reports sum that field.

---

## 1. What changed for existing app flows

Nothing was renamed or removed. Existing request and response shapes are unchanged. Behaviour differences:

| Flow | Before | Now |
|---|---|---|
| User wallet top-up verify (`POST /users/wallet/razorpay/verify`, `GET /users/wallet/phonepe/status/:id`) | Credited when the app called verify. Concurrent callback and verify calls could double-credit. | Same response. The credit goes through a shared settlement claim, so it happens exactly once whether the app, the redirect callback or the webhook arrives first. |
| Driver wallet top-up verify (`POST /drivers/wallet/top-up/razorpay/verify`, PhonePe status) | Same as above | Same as above |
| App killed after paying | Money captured, wallet never credited | The webhook settles it (see section 3) |
| Ride completion / tip payment (`POST /rides/:rideId/...razorpay/verify`) | Pays the driver and records feedback | Unchanged. If the webhook already settled the payment because the app was killed, a later verify call records only the rating and feedback, and returns the ride. |
| Admin approves a driver withdrawal | Wallet debit with type `adjustment`, status `completed` | Wallet debit with **type `withdrawal`** (older rows stay `adjustment`). The status is `completed` (default), or `processing` when `payments.payout_mode = razorpayx`. The response gains a `payout` field. |
| Admin cancels a ride, cancels a pooling booking, or releases bus seats | No refund | A `Refund` is created (see section 4). Default: `requested`, waiting for admin approval. |
| `POST /common/payment-gateway/phonepe/callback` | Logged only | Verified and settled once PhonePe webhook credentials are configured. Before that, it logs and acknowledges as before. |

New wallet transaction type for drivers: `WalletTransaction.type = "withdrawal"` (negative amount = withdrawal, positive with `metadata.reversal: true` = a failed payout returned to the wallet).

New withdrawal statuses: `processing` (bank payout in flight) and `failed` (payout bounced; the amount is back in the wallet). Both appear only in `razorpayx` mode.

---

## 2. User endpoints

### GET `/users/wallet/transactions?page=&limit=&wallet=&kind=`
Auth: `user`.

Full, paginated wallet history from the ledger. The embedded `recentTransactions` on `GET /users/wallet` is still the last 10 rows, unchanged. Use this endpoint for the "All transactions" screen.

Query: `page` (default 1), `limit` (default 20, max 100), `wallet` = `balance` | `refundWallet`, `kind` = `credit` | `debit`.

```json
{
  "success": true,
  "data": {
    "source": "ledger",
    "balance": 420.5,
    "refundWallet": 0,
    "results": [
      {
        "id": "led_lq2x9k3a1b2c3d4e5",
        "kind": "credit",
        "amount": 250,
        "title": "Wallet Refilled",
        "category": "wallet_topup",
        "wallet": "balance",
        "balanceAfter": 420.5,
        "reference": { "kind": "user_wallet_tx", "id": "6650f..." },
        "provider": "razorpay",
        "providerPaymentId": "pay_NxYz123",
        "createdAt": "2026-10-03T09:12:44.120Z"
      }
    ],
    "paginator": { "current_page": 1, "per_page": 20, "total": 37, "last_page": 2 }
  }
}
```

`source` is `"wallet_embedded"` for a user who has no ledger rows yet (history from before this release). In that case `results` comes from the old embedded array, `category` is empty, and there is only one page.

`category` values: `wallet_topup`, `ride_fare`, `refund`, `cancellation_fee`, `wallet_transfer`, `referral_bonus`, `subscription`, `rental_payment`, `adjustment`, `wallet_credit`, `wallet_debit`.

### GET `/users/payments/refunds?page=&limit=&status=`
Auth: `user`. Lists the rider's own refunds, using the same refund shape as the admin list in section 4 (without the `user` block).

---

## 3. Webhooks (gateway → backend)

Mounted **before** the JSON body parser, so signatures are checked against the raw bytes.

### POST `/api/v1/webhooks/razorpay` (also `/api/webhooks/razorpay`)
No auth header. The `x-razorpay-signature` header is checked: HMAC-SHA256 of the raw body with the webhook secret.

The secret comes from Admin → Payment Gateways → Razorpay → **Webhook Secret** (`razor_pay.webhook_secret`), with env `RAZORPAY_WEBHOOK_SECRET` as the fallback.

In the Razorpay dashboard, add a webhook to this URL with these events: `payment.captured`, `payment.failed`, `refund.processed`, `refund.failed`. For RazorpayX, also add `payout.processed`, `payout.failed`, `payout.reversed` and `payout.rejected`.

Responses:
- `200 {"success":true,"data":{"status":"processed|deferred|ignored|duplicate","eventId":"..."}}`
- `401` for a bad signature
- `503` when no secret is configured
- `500` when processing failed. Razorpay then retries, and the retry re-runs the event.

Idempotency: every delivery is stored in `PaymentEvent`, which is unique on (provider, `x-razorpay-event-id`). A redelivery returns `duplicate: true` and does nothing.

`payment.captured` is matched to the internal flow through the order's notes and receipt, which the existing create-order endpoints already write:

| Purpose | Recognised by | Webhook action |
|---|---|---|
| User wallet top-up | receipt `uwal_`, notes `{userId}` | Credit the wallet now (same function as verify) |
| Driver wallet top-up | receipt `dwal_` or notes `source: driver_wallet_topup` | Credit the wallet now |
| Ride completion | notes `source: ride_completion` | Deferred 2 min, then pay the driver and mark the ride paid if the app never verified. Feedback is not written. |
| Ride tip | notes `kind: ride_tip` | Deferred 2 min, then credit the tip if the app never verified |
| Bus booking | receipt `ubus_` | Deferred 90 s, then confirm the seats if they are still held. Otherwise a refund is raised. |
| Rental advance | notes `purpose: rental_advance_payment` | Deferred 30 min. If no rental booking references the payment by then, a refund is raised. |
| Driver QR / payment-link collection | notes `source: driver_collect_amount` | Ignored. The driver app's QR status poll settles these. |

Deferring lets a live app finish its own verify call first. The webhook settles only what the app never did. Deferred events are processed by a sweeper that runs every 60 s on every instance, each event claimed atomically (started in `server.js`). Admins can force a run with `POST /admin/payments/events/process-due`.

`refund.*` updates the matching `Refund`. `payout.*` updates the matching `Payout` and withdrawal. A failed or reversed payout puts the money back in the wallet once.

### POST `/api/v1/webhooks/phonepe` (also `/api/webhooks/phonepe` and the existing `/api/v1/common/payment-gateway/phonepe/callback`)
No auth middleware. The `Authorization` header must equal `SHA256(username:password)`, which is PhonePe v2 callback validation (the same check as the SDK's `validateCallback`). Username and password come from Admin → Payment Gateways → PhonePe → **Webhook Username / Webhook Password**, with env `PHONEPE_WEBHOOK_USERNAME` / `PHONEPE_WEBHOOK_PASSWORD` as the fallback.

Events handled:
- `checkout.order.completed`: re-checks the order status with PhonePe (the same call `/wallet/phonepe/status/:id` makes), then credits the user or driver wallet. Orders are identified by their merchant order id prefix (`UWAL`, `DWAL`, `URNT`) and the `PaymentOrder` remembered at order creation.
- `checkout.order.failed`
- `pg.refund.completed`
- `pg.refund.failed`

PhonePe top-up orders created **before** this release were not remembered. Their webhooks return `unattributed`, and the app's status poll still settles them.

---

## 4. Admin endpoints

All of these require auth role `admin`. Payment views need the `wallet.view` permission, and settings need `settings.view`. Super admins pass both checks.

### Refund object
```json
{
  "_id": "6651a...",
  "refundNumber": "RFDLQ2X9K3A1F2E3D",
  "status": "requested",
  "provider": "razorpay",
  "destination": "source",
  "amount": 180,
  "currency": "INR",
  "reason": "Ride cancelled by admin",
  "userId": "664f...",
  "user": { "_id": "664f...", "name": "Asha", "phone": "98xxxxxx10" },
  "reference": { "kind": "ride", "id": "6650c..." },
  "service": "ride",
  "gateway": { "paymentId": "pay_NxYz123", "orderId": "order_Nx...", "refundId": "", "status": "" },
  "initiatedBy": { "type": "admin", "id": "6600..." },
  "approvedBy": "", "approvedAt": null, "processedAt": null,
  "failureReason": "", "attempts": 0,
  "metadata": { "capturedAmount": 180 },
  "createdAt": "...", "updatedAt": "..."
}
```

`status`: `requested` → `processing` → `processed` | `failed`. `requested` or `failed` can also go to `rejected`. A `failed` refund can be approved again, which retries it.

`provider`: `razorpay` | `phonepe` | `wallet`. `destination`: `source` (back to the card or UPI), `wallet` (user wallet balance) or `refund_wallet`.

`reference.kind`: `ride`, `bus_booking`, `pooling_booking`, `rental_booking`, `gateway_payment` (a captured payment with no booking), or any kind another module passes.

### GET `/admin/payments/refunds`
Query: `status` (comma list), `provider`, `service`, `referenceKind`, `referenceId`, `userId`, `search`, `from`, `to`, `page`, `limit`.
```json
{ "success": true, "data": { "results": [Refund], "counts": { "requested": { "count": 3, "amount": 540 } }, "paginator": { ... } } }
```

### GET `/admin/payments/refunds/:id`
Returns `{ refund: Refund + gatewayResponse }`.

### POST `/admin/payments/refunds` — manual refund for any ride or booking
```json
{
  "referenceKind": "ride",
  "referenceId": "6650c...",
  "amount": 120.5,
  "destination": "source",
  "reason": "Driver overcharged",
  "queue": false
}
```
- `referenceKind`: `ride` | `bus_booking` | `pooling_booking` | `rental_booking`. The payment id, provider, user and captured amount are looked up from the booking.
- `amount` is optional and defaults to the captured amount. The total refunded for a payment can never exceed what was captured (otherwise `409`).
- `destination`: `source` | `wallet` | `refund_wallet`. Use `wallet` for cash or wallet-paid bookings.
- The refund is sent immediately. With `"queue": true` it is only created as `requested`.
- For other references, pass `provider`, `paymentId`, `orderId` (needed for PhonePe), `userId` and `amount` explicitly.

Response `201`: `{ refund: Refund, duplicate: false }`. The message says `Refund processed`, `Refund processing` or `Refund failed: ...`.

### POST `/admin/payments/refunds/:id/approve`
Sends a `requested` or `failed` refund. Returns `{ refund }`. Approving the same refund twice cannot pay twice.

### POST `/admin/payments/refunds/:id/reject`
Body `{ "reason": "..." }`. Returns `{ refund }` with status `rejected`.

### GET `/admin/payments/ledger`
Query filters: `accountType` (user|driver|owner|corporate|platform|gateway), `accountId`, `wallet`, `category` (comma list), `direction` (credit|debit), `service`, `referenceKind`, `referenceId`, `provider`, `paymentId`, `transferId`, `source`, `from`, `to`, `search`, `page`, `limit` (max 200).
```json
{
  "success": true,
  "data": {
    "results": [
      {
        "entryId": "led_...", "transferId": "trf_...",
        "account": { "type": "driver", "id": "6640...", "wallet": "wallet" },
        "direction": "credit", "amount": 162, "amountMinor": 16200, "currency": "INR",
        "balanceAfter": 1240, "category": "ride_fare", "service": "",
        "description": "Driver earning credited for online ride",
        "reference": { "kind": "ride", "id": "6650c..." },
        "gateway": { "provider": "", "orderId": "", "paymentId": "", "refundId": "", "payoutId": "" },
        "source": "hook:driver_wallet", "metadata": { ... }, "createdBy": { "type": "system", "id": "" },
        "createdAt": "..."
      }
    ],
    "totals": { "credit": { "amount": 9120.5, "count": 210 }, "debit": { "amount": 9120.5, "count": 210 } },
    "paginator": { ... }
  }
}
```
Each money movement is a transfer of two lines (one debit, one credit) sharing a `transferId`. Filter on `direction=credit` to see each movement once.

### GET `/admin/payments/reports/summary?from=&to=&service=`
Defaults to the last 30 days. Days are bucketed in Asia/Kolkata.
```json
{
  "success": true,
  "data": {
    "range": { "from": "...", "to": "...", "timezone": "Asia/Kolkata" },
    "headline": {
      "gateway_collections": { "amount": 52300, "count": 410 },
      "wallet_topups": { "amount": 18000, "count": 95 },
      "refunds": { "amount": 1200, "count": 7 },
      "payouts": { "amount": 25000, "count": 12 },
      "commission": { "amount": 6100.4, "count": 380 },
      "withdrawals": { "amount": 25000, "count": 12 },
      "corporate_charges": { "amount": 0, "count": 0 }
    },
    "byCategory": { "ride_fare": { "amount": 40000, "count": 300 } },
    "byDay": [ { "date": "2026-10-01", "gateway_collection": 1800, "wallet_topup": 600, "refund": 0, "payout": 0, "commission": 210, "withdrawal": 0, "corporate_charge": 0 } ],
    "byService": [ { "service": "bus", "categories": { "gateway_collection": { "amount": 3200, "count": 9 } } } ],
    "refunds": { "processed": { "amount": 900, "count": 5 }, "requested": { "amount": 300, "count": 2 } },
    "payouts": { "processed": { "amount": 25000, "count": 12 } }
  }
}
```

### GET `/admin/payments/payouts?status=&accountType=&accountId=&page=&limit=`
RazorpayX payout records.

### GET `/admin/payments/events?provider=&status=&event=&paymentId=&page=&limit=`
Webhook deliveries (without the raw payload).

### POST `/admin/payments/events/process-due`
Runs the deferred-settlement sweeper now. Returns `{ processed: [{ eventId, status }] }`.

### GET / PATCH `/admin/payments/settings`
Auth: `admin` + `settings.view`. These settings are also readable and writable through the generic `GET/PATCH /admin/general-settings/payments`.
```json
{
  "auto_refund_enabled": "0",
  "payout_mode": "manual",
  "payout_transfer_mode": "IMPS",
  "razorpayx_account_number": ""
}
```

### Owner withdrawals (gap 2.15)
- `GET /admin/wallet/owners/:ownerId/withdrawals?page=&limit=` returns `{ owner: { _id, name, company_name, mobile, email, wallet_balance, total_earned, total_withdrawn, bankDetails }, results: [Withdrawal], paginator }`. The admin web page already called this URL; it now exists.
- `PATCH /admin/wallet/owners/withdrawals/:requestId/approve` debits the owner wallet (`409`/`400` if the balance is short), sets the status to `completed` (or `processing` and sends a payout in razorpayx mode), and returns `{ request, wallet: { balance }, payout }`.
- `PATCH /admin/wallet/owners/withdrawals/:requestId/reject` returns `{ request }` with status `cancelled`.

### Driver withdrawal approve (existing endpoint, extended)
`PATCH /admin/wallet/drivers/withdrawals/:requestId/approve` keeps its response. It adds `payout: { status, payoutId, failureReason } | null`, and `request.status` can now be `processing` or `failed`.

---

## 5. Settings (AdminBusinessSetting `payments` section)

| Key | Default | Effect |
|---|---|---|
| `payments.auto_refund_enabled` | `'0'` | `'1'` sends refunds from cancel paths straight to the gateway or wallet. `'0'` creates them as `requested` for admin approval. Admin manual refunds are always sent unless `queue: true`. |
| `payments.payout_mode` | `'manual'` | `'razorpayx'` sends a RazorpayX payout when a withdrawal is approved (contact → fund account → payout, with an `X-Payout-Idempotency` header). |
| `payments.payout_transfer_mode` | `'IMPS'` | IMPS, NEFT or RTGS for bank payouts. UPI is used automatically for payees who have only a UPI id. |
| `payments.razorpayx_account_number` | `''` | RazorpayX current account. Falls back to env `RAZORPAYX_ACCOUNT_NUMBER`. |
| `third_party.payment.razor_pay.webhook_secret` | `''` | Webhook secret. Falls back to env `RAZORPAY_WEBHOOK_SECRET`. |
| `third_party.payment.phone_pay.webhook_username` / `webhook_password` | `''` | PhonePe callback credentials. Fall back to env `PHONEPE_WEBHOOK_USERNAME` / `PHONEPE_WEBHOOK_PASSWORD`. |

Payee bank details for payouts:
- Drivers: the withdrawal's `bank_details_snapshot`, then `Driver.bankDetails` (`accountNumber`, `ifsc`, `accountHolderName`, `upiId`).
- Owners: `Owner.account_no`, `ifsc` and `owner_name`.

---

## 6. Socket events emitted

| Event | Room | Payload | When |
|---|---|---|---|
| `user:wallet:updated` | `user:<userId>` | `{ balance, refundWallet, credited, provider, paymentId, source }` | A top-up is settled by the webhook or callback (not by the app's own verify call, which already returns the wallet) |
| `payment:refund:updated` | `user:<userId>` | `{ refundNumber, status, amount, provider, destination, reference }` | A refund is queued, processed or failed |
| `driver:wallet:updated` | `driver:<driverId>` | `{ wallet, transaction, notification? }` (existing shape) | A driver top-up is settled by the webhook, a ride payment or tip is settled by the webhook, or a failed payout is returned to the wallet |

---

## 7. Service API for other modules (corporate, rental, outstation, hub)

Import from `Backend/src/modules/taxi/payments/services/...`. All amounts are in rupees.

### `ledgerService.js`
```js
import { recordLedgerEntry, recordTransfer, chargeCorporateAccount, creditCorporateAccount,
         recordTransferSafe, listLedgerEntries } from '../payments/services/ledgerService.js';

// Double entry; idempotent on idempotencyKey (replays return { duplicate: true }).
await recordTransfer({
  from: { type: 'user', id: userId, wallet: 'balance' },   // account types: user|driver|owner|corporate|platform|gateway
  to:   { type: 'platform', id: 'platform' },
  amount: 499,                                             // rupees
  category: 'rental_payment',                              // see LEDGER_CATEGORIES in models/LedgerEntry.js ('other' if unknown)
  service: 'rental',
  description: 'Rental advance',
  reference: { kind: 'rental_booking', id: bookingId },
  gateway: { provider: 'razorpay', orderId, paymentId },
  idempotencyKey: `rental_advance:${bookingId}`,
  metadata: { ... },
  createdBy: { type: 'user', id: userId },
}, { session });   // optional; with a session the write rolls back with your transaction

await recordLedgerEntry({ account, direction: 'debit'|'credit', amount, category, reference, idempotencyKey, ... });

// Never-throwing variants for hooks in money paths (logs on failure; deferred
// until commit when called with a session that is in a transaction):
recordTransferSafe(input, { session, label: 'my-module' });

// Corporate billing hook: corporate is debited, platform credited.
// Idempotent per (corporateId, reference). Throws on bad input.
await chargeCorporateAccount({ corporateId, amount, reference: { kind: 'ride', id: rideId }, description, metadata });
await creditCorporateAccount({ corporateId, amount, reference: { kind: 'ride', id: rideId } }); // reversal
```

User, driver and owner **wallet** movements are mirrored into the ledger automatically by Mongoose plugins on `UserWallet`, `WalletTransaction` and `OwnerWalletTransaction`. Don't also record them by hand.

### `refundService.js`
```js
import { refundPayment, refundPaymentSafely } from '../payments/services/refundService.js';

const { refund, duplicate } = await refundPayment({
  provider: 'razorpay',           // 'razorpay' | 'phonepe' | 'wallet'
  paymentId: 'pay_...',           // Razorpay payment id
  orderId: 'URNT...',             // required for PhonePe (original merchant order id)
  amount: 250,
  reason: 'Rental cancelled',
  reference: { kind: 'rental_booking', id: bookingId },
  toWallet: false,                // true -> user wallet balance, 'refund_wallet' -> refundWallet
  userId,
  service: 'rental',
  initiatedBy: { type: 'system', id: '' },
  autoProcess: undefined,         // undefined: follow payments.auto_refund_enabled; true: send now; false: queue
  idempotencyKey: undefined,      // default: refund:<kind>:<id>:<paymentId>:<paise>
  metadata: { capturedAmount: 1000 }, // enables the "never refund more than captured" check
});
// refundPaymentSafely(input, label) never throws (returns the refund or null) — use it in cancel paths.
```

### `payoutService.js`
`resolveApprovedWithdrawalStatus()` returns the status to store on approval. `startWithdrawalPayoutSafely({ request, account: { type: 'driver'|'owner', id } })` starts the payout.

### `paymentSettlementService.js`
`creditUserWalletFromGateway`, `creditDriverWalletFromGateway`, `rememberPaymentOrder` (call it after creating a PhonePe order so its webhook can find the payer) and `claimPaymentOrder` (exactly-once settlement for your own flows).
