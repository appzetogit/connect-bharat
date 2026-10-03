# Outstation API (SOW 6.1–6.9, 2.8)

For the Flutter team. All paths are relative to the taxi API base (the same base as `/rides`). Auth is `Authorization: Bearer <token>` with the role shown. Errors use the usual `{ success: false, message }` shape.

An outstation trip is still a `Ride` with `serviceType: "intercity"`, booked with `POST /rides` (or the socket `requestRide`). This document covers what changed on that booking and the new endpoints.

Code: `Backend/src/modules/taxi/outstation/`.

---

## 1. Booking an outstation trip (changed: `POST /rides`)

Same endpoint and body as before. The `intercity` object now takes these fields:

| Field | Type | Notes |
|---|---|---|
| `tripType` | string | `one_way` \| `round_trip` \| `multi_day`. The old labels `"One Way"` / `"Round Trip"` / `"Multi Day"` are still accepted and are stored as the code. Anything else returns **400**. |
| `travelDate` or `startAt` | ISO date string | Pickup time. `scheduledAt` (top level) also works. |
| `returnAt` | ISO date string | Round trip / multi-day only. Must be after the start. |
| `days` | integer | Optional. If you leave it out, it's counted from `startAt` to `returnAt` on the IST calendar, both days included. `multi_day` needs `days >= 2` or a `returnAt` on a later day (otherwise **400**). One-way is always 1. |
| `fromCity`, `toCity`, `passengers`, `distance`, `vehicleName`, `packageId`, `packageTypeName`, `bookingId` | | unchanged |

```json
{
  "pickup": [75.8577, 22.7196], "drop": [77.4126, 23.2599],
  "vehicleTypeId": "65f...", "serviceType": "intercity", "paymentMethod": "cash",
  "fare": 0,
  "intercity": {
    "fromCity": "Indore", "toCity": "Bhopal",
    "tripType": "round_trip",
    "travelDate": "2026-10-05T04:30:00.000Z",
    "returnAt": "2026-10-07T13:30:00.000Z"
  }
}
```

### How the fare is worked out (off-package trips, when the vehicle has outstation rates)

- **One way:** the routed distance, priced on the outstation rates (base, per km, per minute, minimum fare, night charge, surge and tax), the same way as before.
- **Round trip / multi-day:** the routed distance there and back, but never less than `outstation_min_km_per_day × days`.
- **Allowances:** `outstation_driver_allowance_per_day × days`, plus `outstation_night_allowance_per_night × (days − 1)` on a return trip. These are added on top and are not taxed or surged.
- **Package trips** (`packageId`) are priced the same way as before.
- If you send `fare`, it is ignored whenever the server can price the trip, as before.

`ride.pricingSnapshot.fare_breakdown` now has `tariff: "outstation"` and these fields: `tripType, days, nights, oneWayKm, tripKm, tripMinutes, minKmPerDay, minimumKm, billableKm, driverAllowancePerDay, driverAllowance, nightAllowancePerNight, nightAllowance, allowancesTotal, tripFare, rates, total`. It also keeps the fare engine's own fields: `baseFare, distanceFare, timeFare, surgeMultiplier, nightCharge, tax`, and so on.

### New fields on the ride

`ride.intercity` gains `tripTypeLabel, startAt, returnAt, days, driverAllowancePerDay, nightAllowancePerNight, tollsAndPermits[], stateTaxes`.

The ride also gains three top-level fields:

```json
"advance":  { "required": true, "amount": 900, "type": "percentage", "value": 20,
              "status": "pending", "provider": "", "orderId": "", "paymentId": "",
              "paidAt": null, "expiresAt": "2026-10-03T12:15:00.000Z",
              "refundedAt": null, "refundAmount": 0 },
"odometer": { "startReading": null, "startPhoto": "", "startAt": null,
              "endReading": null, "endPhoto": "", "endAt": null },
"fareAdjustment": { "computedAt": null, "applied": false, "...": "see section 4" }
```

`advance.status` is one of `none | pending | paid | waived | expired | refunded`.

On intercity rides, the realtime payload (`ride:state`, `ride:status:updated`) also includes `advance`, `odometer`, `fareAdjustment` (a short version) and `amountDue` (fare minus the advance paid). Other services' payloads don't change.

---

## 2. Mandatory advance (SOW 6.4 / 2.8)

The admin configures the advance per vehicle, in Set Price with `outstation_advance_type` (`none` | `percentage` | `fixed`) and `outstation_advance_value`. When it comes to more than 0, the ride is created with `status: "searching"` and `advance.status: "pending"`. **Dispatch does not start until the advance is paid.**

**App flow:** after `POST /rides`, check `data.ride.advance.required && data.ride.advance.status === "pending"`. If so, show the payment screen. Don't show "finding a driver" until the payment succeeds.

- An unpaid advance expires at `advance.expiresAt`. That is `transport_ride.outstation_advance_timeout_minutes` after booking (default 15). The ride is then cancelled with `advance.status: "expired"`, and the server emits `rideCancelled` with `code: "outstation_advance_expired"`.
- The rider can still cancel with `PATCH /rides/:rideId/cancel` as usual.
- If a ride with a paid advance is later cancelled (by the rider, by dispatch finding no driver, or by an admin), the advance is credited to the rider's wallet within about a minute (`advance.status: "refunded"`). This is controlled by `transport_ride.outstation_advance_refund_to_wallet`, default `'1'`. Any cancellation fee is still settled the usual way.
- **At completion, the advance is deducted from what's due.** The cash to collect, and the online amount on `/rides/:rideId/complete-payment/*`, is `fare − advance`. In the driver's wallet, the advance counts as already collected online.

### POST `/rides/:rideId/advance/razorpay/order` (user)

Body: none.

```json
{ "success": true, "data": {
  "keyId": "rzp_test_...", "orderId": "order_N...", "amount": 90000, "currency": "INR",
  "advanceAmount": 900, "rideId": "66f...", "expiresAt": "2026-10-03T12:15:00.000Z" } }
```

`amount` is in paise. Returns 409 if the ride has no advance, the advance is already settled, or the ride is no longer waiting for one.

### POST `/rides/:rideId/advance/razorpay/verify` (user)

```json
{ "razorpay_order_id": "order_N...", "razorpay_payment_id": "pay_N...", "razorpay_signature": "..." }
```

The server checks the HMAC signature, then re-reads the order from Razorpay. The amount and the `notes.rideId` must match. On success it marks `advance.status: "paid"`, **starts dispatch**, and returns the ride (the same shape as `GET /rides/:rideId`). Calling it again with the same payment is idempotent.

If the ride expired or was cancelled while the user was paying, the money is credited to their wallet and the call returns **409** with the message `...the payment was credited to your wallet`.

### POST `/rides/:rideId/advance/wallet` (user)

Body: none. This debits `advance.amount` from the user's wallet, marks the advance paid, starts dispatch, and returns the ride with **201**. Returns **400** `Insufficient wallet balance` if the balance is too low.

### POST `/admin/outstation/rides/:rideId/advance/waive` (admin)

This releases a pending ride without its advance (`advance.status: "waived"`) and starts dispatch. It returns the fare summary.

### Socket events

| Event | Room | Payload |
|---|---|---|
| `ride:advance:updated` | `user:<userId>` and the ride room | `{ rideId, advance: { required, amount, status, provider, paidAt, expiresAt }, status, liveStatus }`. Sent when the advance is paid, waived, expired or refunded. |
| `rideCancelled` | `user:<userId>` and the ride room | `{ rideId, room, reason: "The advance was not paid in time", code: "outstation_advance_expired" }` |

---

## 3. Odometer and trip expenses (driver)

### POST `/rides/:rideId/odometer` (driver)

```json
{ "stage": "start", "reading": 45210, "photoUrl": "https://.../odo-start.jpg" }
```

- `stage` is `start` or `end`. `photoUrl` is required (upload it first with the existing image upload). `imageUrl` and `url` are accepted as aliases.
- `start` can be recorded, or re-recorded, while the ride is `accepted` or `arriving`, before the trip starts.
- `end` can be recorded while the ride is `started` or `arrived`. It must be at least the start reading.
- When `customization.require_outstation_odometer` is `'1'` (default `'0'`), `PATCH /rides/:rideId/status` returns **400** in two cases: moving to `started` without a start reading, or moving to `completed` without both readings. The socket status update behaves the same way.

```json
{ "success": true, "data": { "rideId": "66f...", "odometer": {
  "startReading": 45210, "startPhoto": "https://...", "startAt": "2026-10-05T04:41:00.000Z",
  "endReading": null, "endPhoto": "", "endAt": null } } }
```

After each reading, the server emits `ride:state` to the ride room.

### POST `/rides/:rideId/expenses` (driver)

```json
{ "type": "toll", "label": "Mandideep toll plaza", "amount": 145, "receiptUrl": "https://.../receipt.jpg" }
```

- `type` is `toll | parking | permit | state_tax | other`.
- `amount` must be more than 0 and at most 100000.
- `receiptUrl` is required.
- The driver can add expenses while the trip is accepted, arriving, started or arrived. The limit is 50 per ride.
- `state_tax` entries are also summed into `intercity.stateTaxes`.

Returns **201** with the fare summary (see section 5). The server emits `ride:state` to the ride room.

---

## 4. Final fare adjustment (SOW 6.5, 6.6, 6.8)

When an intercity ride is completed, the server works out the final fare before it settles the driver's wallet:

- **Actual km:** the odometer difference, else the driver's GPS trail between start and completion, else the estimate.
- **Extra km:** km above the booked billable km, re-floored at `min_km_per_day × days actually used`. Charged at the per-km rate and surge locked at booking.
- **Extra driving time:** single-day trips only.
- **Waiting at pickup:** minutes past `free_waiting_before`, at the waiting rate locked at booking, capped at 120 minutes.
- **Allowances** for days beyond the booking.
- **Tax** at the locked rate on the extra km, time and waiting.
- **Tolls, parking, permits and state taxes** at cost.

The result is never lower than the booked fare.

This is controlled by `transport_ride.enable_outstation_final_fare_adjustment` (default `'0'`):

- `'1'`: `ride.fare` becomes `fareAdjustment.finalFare`, and `fareAdjustment.applied: true`.
- `'0'` (dry run): the calculation is stored with `applied: false` so ops can compare. The rider pays the booked fare.

A prepaid ride (rider subscription) is always a dry run.

```json
"fareAdjustment": {
  "computedAt": "2026-10-07T14:02:00.000Z", "applied": true,
  "bookedFare": 11530, "finalFare": 14520,
  "actualKm": 820, "distanceSource": "odometer", "bookedKm": 600,
  "extraKm": 220, "extraKmCharge": 2640, "extraTimeMinutes": 0, "extraTimeCharge": 0,
  "waitingMinutes": 0, "waitingCharge": 0, "extraDays": 1, "allowances": 500,
  "tollsTotal": 500, "stateTaxes": 800, "taxOnExtras": 132,
  "reason": "220 km over the booked 600 km; 1 day(s) beyond the booking; tolls, parking and permits at cost; state taxes at cost"
}
```

---

## 5. Fare summary

### GET `/rides/:rideId/fare-summary` (user on the ride, driver on the ride, or admin)

Admins can also use `GET /admin/outstation/rides/:rideId/fare-summary`.

```json
{ "success": true, "data": {
  "rideId": "66f...", "serviceType": "intercity", "status": "completed", "liveStatus": "completed",
  "tripType": "round_trip", "tripTypeLabel": "Round Trip", "days": 2,
  "startAt": "2026-10-05T04:30:00.000Z", "returnAt": "2026-10-06T13:30:00.000Z",
  "fare": 14520, "fareSource": "server", "bookedFare": 11530,
  "bookedBreakdown": { "tariff": "outstation", "billableKm": 600, "tripFare": 10730, "driverAllowance": 600, "nightAllowance": 200, "...": "..." },
  "advance": { "required": true, "amount": 2306, "status": "paid", "provider": "razorpay", "paidAt": "...", "expiresAt": "...", "refundAmount": 0 },
  "odometer": { "startReading": 45210, "endReading": 46030, "...": "..." },
  "expenses": [ { "id": "...", "type": "toll", "label": "Mandideep", "amount": 145, "receiptUrl": "...", "addedAt": "..." } ],
  "expensesTotal": 1300,
  "fareAdjustment": { "applied": true, "finalFare": 14520, "...": "as in section 4, without bookedBreakdown" },
  "amountDue": 12214,
  "refundDue": 0,
  "invoiceLines": [
    { "label": "Round Trip fare (600 km, 2 days)", "amount": 10730 },
    { "label": "Driver allowance (2 days)", "amount": 600 },
    { "label": "Night allowance (1 night)", "amount": 200 },
    { "label": "Extra km (220 km)", "amount": 2640 },
    { "label": "Total fare", "amount": 14520 },
    { "label": "Advance paid", "amount": -2306 },
    { "label": "Balance", "amount": 12214 }
  ] } }
```

`amountDue` is what the driver collects in cash, or what the rider pays at completion. `refundDue` is more than 0 only if a bid lowered the fare below the advance. That refund is **not** automated (see the notes at the end).

---

## 6. Admin

### GET `/admin/outstation/rides` (admin)

Query parameters (all optional):

- `page` (default 1) and `limit` (default 20, max 100)
- `status`: ride status
- `advanceStatus`: `none|pending|paid|waived|expired|refunded`
- `adjustment`: `applied|dry_run|none`
- `tripType`
- `from` and `to`: ISO dates on `createdAt`

```json
{ "success": true, "data": {
  "results": [ {
    "rideId": "66f...", "bookingId": "", "user": { "id": "...", "name": "...", "phone": "..." },
    "driver": { "id": "...", "name": "...", "phone": "...", "vehicleNumber": "..." },
    "status": "completed", "liveStatus": "completed", "fromCity": "Indore", "toCity": "Bhopal",
    "pickupAddress": "...", "dropAddress": "...", "tripType": "round_trip", "days": 2,
    "startAt": "...", "returnAt": "...", "fare": 14520, "fareSource": "server", "paymentMethod": "cash",
    "advance": { "required": true, "amount": 2306, "status": "paid", "provider": "razorpay", "paidAt": "..." },
    "odometer": { "...": "..." }, "expensesTotal": 1300,
    "fareAdjustment": { "applied": true, "bookedFare": 11530, "finalFare": 14520, "difference": 2990,
                        "distanceSource": "odometer", "actualKm": 820, "reason": "..." },
    "createdAt": "...", "startedAt": "...", "completedAt": "..." } ],
  "paginator": { "current_page": 1, "per_page": 20, "total": 1, "last_page": 1 } } }
```

### Set Price fields (admin `POST/PATCH /admin/types/set-prices`)

The admin SetPrices form shows these under the Outstation section:

| Field | Type | Default | Meaning |
|---|---|---|---|
| `outstation_min_km_per_day` | number | 0 (off) | Minimum billable km per day on round trips and multi-day trips |
| `outstation_driver_allowance_per_day` | number | 0 | Driver allowance per day |
| `outstation_night_allowance_per_night` | number | 0 | Night allowance per night (days − 1 on a return trip) |
| `outstation_advance_type` | `none\|percentage\|fixed` | `none` | Mandatory advance |
| `outstation_advance_value` | number | 0 | Percentage of the fare, or a fixed amount (capped at the fare) |

### Business settings

| Section.key | Default | Meaning |
|---|---|---|
| `transport_ride.outstation_advance_timeout_minutes` | `'15'` | Minutes a booking waits for its advance before it's auto-cancelled |
| `transport_ride.outstation_advance_refund_to_wallet` | `'1'` | Credit a paid advance back to the wallet when the ride is cancelled |
| `transport_ride.enable_outstation_final_fare_adjustment` | `'0'` | Charge the final fare (`'0'` means a dry run that only records it) |
| `customization.require_outstation_odometer` | `'0'` | Require odometer readings before start and completion |

---

## 7. For the invoice (merge note)

`buildOutstationInvoiceLines(ride)` in `outstation/services/outstationFare.js` returns `[{ label, amount }]` rows: base or trip fare, allowances, extra km, time, waiting, extra-day allowances, tax on extras, tolls, state taxes, total, advance paid (negative) and balance. It returns `[]` for non-intercity rides. It is pure: pass a ride as a plain object or a Mongoose doc. `invoiceService` can print these rows for intercity rides.

## Notes and limits

- A cancelled ride's advance is refunded to the **wallet**, not to the card. A `refundDue` caused by a bid that lowered the fare below the advance is reported but not paid out.
- On a package trip, `multi_day` is priced like a one-way package. The package multiplier only applies to `round_trip`.
- The GPS fallback uses the driver's location history between `startedAt` and `completedAt`. It is throttled and filters out jumps faster than 160 km/h.
