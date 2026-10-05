# Corporate employees — Flutter user app implementation guide

What the **rider (user) app** needs to support company-billed trips for employees.
The driver app has its own short section at the end (§10).

- API base: `https://bharat.buytogetherindia.com/api/v1`
- Socket.IO: `https://bharat.buytogetherindia.com` (same JWT as REST)
- Auth: the normal rider JWT (`Authorization: Bearer <token>`). There is **no separate
  employee login** — an employee is an ordinary rider whose phone number the company
  added. They log in to the user app with OTP as usual.
- All responses are `{ "success": true, "data": ... }`; errors are
  `{ "success": false, "message": "...", "details": {...} }` and, for corporate
  errors, a `code` at the top level.

Full field reference: `docs/api/corporate.md` §1 and §6.1. Contract: `docs/plans/corporate-v2.md`.

---

## 1. How it works (what the employee sees)

1. The company (on its web panel) adds the employee by phone number and gives them a
   **role** (CEO, VP, Sales Field Staff… — any name, created by the company).
2. The role decides the employee's **free km allowance** (e.g. 20 km per week), which
   vehicles and services they may book, and whether trips need approval.
3. When booking, the employee chooses **"Bill to company"** instead of cash/online.
4. Km inside the allowance are paid by the company. Km beyond it (the **excess**) are
   paid by the employee — by cash to the driver, online (Razorpay) or wallet.
5. Some companies only allow trips **near their offices** (office boundary).
6. Some trips need a **company approver** first — the ride waits, no driver is
   contacted until approved.
7. The company's travel desk can also **book a trip for the employee**; it appears in
   the employee's app like any other ride.

---

## 2. Screens to build or change

| Screen | Change |
|---|---|
| App start / profile load | Call `GET /users/me/corporate`, cache the result (§3) |
| Profile → "My company" (new) | Company name, employee ID, role, allowance progress bar, travel zone (§9) |
| Vehicle selection / fare screen | "Bill to company" option; per-vehicle company/employee split; boundary warning (§4) |
| Excess payment sheet (new) | Pick cash / online / wallet for the employee's share (§5) |
| Searching screen | "Waiting for company approval" state (§7) |
| Trip screens | "Billed to {company}" badge; no fare-raise / bidding UI (§8) |
| Trip complete / payment | Pay only the employee share, or nothing (§8) |
| Notifications | New push types for travel-desk bookings and approvals (§7, §9) |

---

## 3. Is this rider an employee? — `GET /users/me/corporate`

Call after login and on app resume (allowance changes as trips complete). Never errors
for a non-employee.

```json
{
  "success": true,
  "data": {
    "eligible": true,
    "paymentMethod": "corporate",
    "memberships": [
      {
        "corporateId": "6ac1...",
        "corporateName": "Demo Corp Pvt Ltd",
        "corporateStatus": "approved",
        "employeeId": "6ac1...",
        "employeeCode": "DEMO6904-0001",
        "role": { "id": "6ac1...", "name": "Sales Field Staff", "code": "SFS" },
        "department": { "id": "6ac1...", "name": "Sales" },
        "canBill": true,
        "reason": "",
        "allowance": {
          "enabled": true, "period": "weekly", "periodKey": "2026-W41",
          "allowanceKm": 20, "usedKm": 9.2, "reservedKm": 0, "remainingKm": 10.8
        },
        "travelZone": {
          "mode": "office_boundary", "rule": "both_ends",
          "offices": [{ "name": "MG Road HQ", "lat": 12.9756, "lng": 77.605, "radiusKm": 15 }]
        },
        "excessPayment": { "allowedMethods": ["cash", "online", "wallet"] },
        "pricing": "company_tariff",
        "tariffAppliesTo": ["ride", "intercity"],
        "discount": { "type": "percentage", "value": 0, "appliesTo": ["ride", "parcel", "intercity", "rental"] },
        "monthlyLimit": 0,
        "spentThisMonth": 150,
        "remainingThisMonth": null,
        "policy": {
          "allowedServices": ["ride", "intercity"],
          "allowedVehicleTypeIds": [],
          "allowedHours": [{ "days": [1,2,3,4,5], "start": "08:00", "end": "21:00" }],
          "outsideHoursAction": "approval",
          "maxFarePerTrip": null,
          "requireApprovalAbove": null,
          "requireApprovalAlways": false
        }
      }
    ]
  }
}
```

Rules for the app:
- Show "Bill to company" only when `eligible == true`.
- Use the membership with `canBill == true`. If a rider has several, let them pick the
  company and send its `corporateId` on estimate and booking.
- `canBill == false` → show `reason` (e.g. company out of credit) and hide the option.
- `allowance.enabled == false` → no km limit, the company pays everything. Hide the km bar.
- `travelZone.mode == "free_roaming"` → no boundary.
- `policy.allowedServices` uses `ride | parcel | intercity | rental` (`intercity` = outstation).
  Hide "Bill to company" for services not in the list (empty list = all).
- `policy.allowedVehicleTypeIds` non-empty → only those vehicles can be billed.
- `allowedHours` are IST; `days` 0 = Sunday. Outside hours the server either blocks or
  asks for approval (`outsideHoursAction`) — you don't have to enforce it, just don't be
  surprised by the 403 / approval.

### Dart models

```dart
class CorporateProfile {
  final bool eligible;
  final List<CorporateMembership> memberships;
  CorporateProfile.fromJson(Map<String, dynamic> j)
      : eligible = j['eligible'] == true,
        memberships = ((j['memberships'] as List?) ?? [])
            .map((m) => CorporateMembership.fromJson(m)).toList();

  CorporateMembership? get billable =>
      memberships.where((m) => m.canBill).cast<CorporateMembership?>().firstWhere((_) => true, orElse: () => null);
}

class CorporateMembership {
  final String corporateId, corporateName, employeeId, employeeCode, reason, pricing;
  final bool canBill;
  final CorporateRole? role;
  final Allowance allowance;
  final TravelZone travelZone;
  final List<String> excessMethods;     // cash | online | wallet
  final List<String> allowedServices;   // ride | parcel | intercity | rental
  final List<String> allowedVehicleTypeIds;

  CorporateMembership.fromJson(Map<String, dynamic> j)
      : corporateId = j['corporateId'] ?? '',
        corporateName = j['corporateName'] ?? '',
        employeeId = j['employeeId'] ?? '',
        employeeCode = j['employeeCode'] ?? '',
        reason = j['reason'] ?? '',
        pricing = j['pricing'] ?? 'standard',
        canBill = j['canBill'] == true,
        role = j['role'] == null ? null : CorporateRole.fromJson(j['role']),
        allowance = Allowance.fromJson(j['allowance'] ?? const {}),
        travelZone = TravelZone.fromJson(j['travelZone'] ?? const {}),
        excessMethods = List<String>.from(j['excessPayment']?['allowedMethods'] ?? const []),
        allowedServices = List<String>.from(j['policy']?['allowedServices'] ?? const []),
        allowedVehicleTypeIds = List<String>.from(j['policy']?['allowedVehicleTypeIds'] ?? const []);
}

class CorporateRole {
  final String id, name, code;
  CorporateRole.fromJson(Map<String, dynamic> j) : id = j['id'] ?? '', name = j['name'] ?? '', code = j['code'] ?? '';
}

class Allowance {
  final bool enabled;
  final String period, periodKey;       // weekly|monthly, "2026-W41" | "2026-10"
  final double allowanceKm, usedKm, reservedKm, remainingKm;
  Allowance.fromJson(Map<String, dynamic> j)
      : enabled = j['enabled'] == true,
        period = j['period'] ?? '',
        periodKey = j['periodKey'] ?? '',
        allowanceKm = (j['allowanceKm'] ?? 0).toDouble(),
        usedKm = (j['usedKm'] ?? 0).toDouble(),
        reservedKm = (j['reservedKm'] ?? 0).toDouble(),
        remainingKm = (j['remainingKm'] ?? 0).toDouble();
}

class TravelZone {
  final String mode, rule;              // free_roaming|office_boundary, both_ends|either_end
  final List<Office> offices;
  TravelZone.fromJson(Map<String, dynamic> j)
      : mode = j['mode'] ?? 'free_roaming',
        rule = j['rule'] ?? 'both_ends',
        offices = ((j['offices'] as List?) ?? []).map((o) => Office.fromJson(o)).toList();
}

class Office {
  final String name; final double lat, lng, radiusKm;
  Office.fromJson(Map<String, dynamic> j)
      : name = j['name'] ?? '', lat = (j['lat'] ?? 0).toDouble(),
        lng = (j['lng'] ?? 0).toDouble(), radiusKm = (j['radiusKm'] ?? 0).toDouble();
}
```

---

## 4. Fare screen — `POST /rides/estimate`

Ask the server for fares (don't compute them in the app). Send `paymentMethod: "corporate"`
when the rider has picked "Bill to company" (or always for an eligible employee, so you can
show both prices).

```json
POST /rides/estimate
{
  "pickup": { "lat": 12.9757, "lng": 77.6069 },
  "drop":   { "lat": 13.1007, "lng": 77.5963 },
  "serviceType": "ride",
  "paymentMethod": "corporate",
  "corporateId": "6ac1..."
}
```

`pickup`/`drop` accept `{lat,lng}` or `[lng, lat]`. Optional: `vehicleTypeIds`, `scheduledAt`
(ISO), `intercity { packageId, tripType }`, `zone_id`.

Each item in `data.quotes` gains a `corporate` block:

```json
{
  "vehicle": { "id": "6ac0...", "name": "Auto Rickshaw", "image": "...", "capacity": 3 },
  "available": false,
  "fare": null,
  "corporate": {
    "eligible": true,
    "fare": 239,
    "pricing": "company_tariff",
    "breakdown": { "baseFare": 50, "distanceFare": 170, "timeFare": 17, "tax": 0, "total": 239 },
    "allowance": {
      "enabled": true, "period": "weekly", "periodKey": "2026-W41",
      "allowanceKm": 20, "remainingKm": 10.8, "remainingKmAtBooking": 10.8,
      "estimatedKm": 16.2, "coveredKm": 10.8, "excessKm": 5.4
    },
    "split": { "companyAmount": 160, "employeeAmount": 79, "discountAmount": 0, "billedAmount": 160 },
    "employeePaymentRequired": true,
    "allowedMethods": ["cash", "online", "wallet"],
    "withinBoundary": true
  }
}
```

**Important:** for a company-billed trip, read the price from `quote.corporate.fare`, not the
quote's top-level `fare`. With a company tariff the top-level `fare` can be `null` /
`available: false` (no standard price in that city) while `corporate.eligible` is `true`.

Show per vehicle:

| Condition | UI |
|---|---|
| `corporate.eligible == false` | Hide "Bill to company" for this vehicle; show `corporate.reason` |
| `withinBoundary == false` | Red note: "Outside your company's travel area" and disable booking with company billing |
| `split.employeeAmount == 0` | "Paid by {company}" — rider pays ₹0 |
| `split.employeeAmount > 0` | "Company pays ₹{companyAmount} · You pay ₹{employeeAmount}" + "{excessKm} km over your allowance" |
| `pricing == "company_tariff"` | Small "Company rate" badge |
| `allowance.enabled` | "Allowance: {remainingKm} km left this {week/month}" |

Corporate trips have a **fixed fare**: hide bidding / "raise fare" for them.

---

## 5. Excess payment method

When `corporate.employeePaymentRequired == true`, show a picker before booking with only the
methods in `corporate.allowedMethods`:

| Value | Label | What happens |
|---|---|---|
| `cash` | Cash to driver | Driver collects ₹`employeeAmount` at the end |
| `online` | UPI / card | Rider pays through Razorpay after the trip (§8) |
| `wallet` | Wallet | Rider pays from the in-app wallet after the trip (§8) |

Send the choice as `employeePaymentMethod` on booking. If no excess, don't send it.

---

## 6. Book — `POST /rides`

```json
POST /rides
{
  "pickup": [77.6069, 12.9757],
  "drop":   [77.5963, 13.1007],
  "pickupAddress": "MG Road Metro, Bangalore",
  "dropAddress": "Yelahanka, Bangalore",
  "vehicleTypeId": "6ac0...",
  "serviceType": "ride",
  "paymentMethod": "corporate",
  "corporateId": "6ac1...",
  "employeePaymentMethod": "cash",
  "fare": 239
}
```

- ⚠️ **`POST /rides` takes `[longitude, latitude]` arrays only** (unlike the estimate).
- `fare` is ignored for pricing — the server prices the trip itself — but send the quoted
  value anyway; older code paths read it.
- Don't send `promo_code` with `paymentMethod: "corporate"` (400: promos can't be combined).
- The socket event `requestRide` accepts the same fields if the app books over the socket.

Response `201`: `data.ride` (the ride) and `data.realtime { room, rideId }` — the same as
any ride, plus `ride.corporate`:

```json
"paymentMethod": "corporate",
"fare": 239,
"corporate": {
  "corporateId": "6ac1...", "employeeId": "6ac1...", "roleId": "6ac1...",
  "approvalStatus": "not_required",
  "pricing": "company_tariff",
  "bookedByCorporateAdminId": null,
  "allowance": { "periodKey": "2026-W41", "allowanceKm": 20, "remainingKmAtBooking": 10.8,
                 "estimatedKm": 16.2, "coveredKm": 10.8, "excessKm": 5.4, "actualKm": 0 },
  "split": { "companyAmount": 160, "employeeAmount": 79, "employeePaymentMethod": "cash",
             "employeePaymentStatus": "pending", "stage": "estimate" },
  "billedAmount": 160
}
```

### Errors to handle on booking

| HTTP | `code` / message | Show |
|---|---|---|
| 400 | `corporate_employee_payment_method` (+ `allowedMethods`, `employeeAmount`, `companyAmount`) | Open the excess payment picker (§5) and retry |
| 403 | `corporate_outside_boundary` (+ `rule`, `offices[]`) | "Your company only allows trips near: {office names}". Optionally draw the circles on the map |
| 403 | `You are not registered as an employee of any company` | Refresh `/users/me/corporate`; hide the option |
| 403 | `Your company account is not active for billing` | Same |
| 403 | `Company credit limit reached` / `No credit limit has been set for this company` | "Company billing unavailable — pay yourself?" and switch to cash/online |
| 403 | `<service> is not allowed for this account` / `Fare above the N per-trip limit` / `Monthly limit of N would be exceeded` / `Outside allowed travel hours` | Show the message; offer personal payment |
| 403 | `Your company has an overdue invoice. Corporate billing is paused.` | Same |
| 400 | promo + corporate | "Promo codes can't be used with company billing" |

For 403s, `details.reasons[]` may list several reasons — show the first.

---

## 7. Approval waiting

If `ride.corporate.approvalStatus == "pending"`, the ride is created but **no driver is
contacted** until a company approver approves. Show a "Waiting for {company} to approve"
screen instead of "Searching for drivers", with a cancel button (normal cancel call).

Socket events (the rider's `user:<id>` room is joined automatically on connect):

| Event | Payload | Do |
|---|---|---|
| `corporate:trip:pending` | `{ rideId, tripRequestId, expiresAt, reasons[] }` | Show waiting screen, optional countdown to `expiresAt` |
| `corporate:trip:approved` | `{ rideId, tripRequestId }` | Switch to "Searching for drivers"; normal `ride:*` events follow |
| `corporate:trip:rejected` | `{ rideId, tripRequestId, status: "rejected" \| "expired", note }` | Show "Not approved" (+ `note`); a `rideCancelled` event follows |

Push `data.type`: `corporate_trip_approved`, `corporate_trip_rejected`, `corporate_trip_expired`.

---

## 8. During and after the trip

During the trip: show a "Billed to {corporateName}" badge; no fare-raise UI. Everything else
(tracking, chat, OTP, SOS) is the same as a normal ride.

On completion the server recomputes the split on the **actual km** (`split.stage` becomes
`"final"`). Read the final numbers from the completed ride (`GET /rides/:id` or the
`ride:status:updated` payload) — they can differ from the estimate.

| Final `split` | Rider app |
|---|---|
| `employeeAmount == 0` | "Paid by {company}". Go straight to rating: `PATCH /rides/:id/feedback` |
| `employeePaymentMethod == "cash"` | "Pay ₹{employeeAmount} in cash to the driver". Marked `paid` on completion. Then rating |
| `employeePaymentMethod == "online"` | Razorpay flow below |
| `employeePaymentMethod == "wallet"` | Wallet flow below |

If the estimate had no excess but the final trip does (longer route), the server defaults
the method to cash when allowed, else online.

**Online (Razorpay)** — charges exactly the employee share (+ optional tip):

```
POST /rides/:id/complete-payment/razorpay/order   { "rating": 5, "tipAmount": 0 }
  -> data { keyId, orderId, amount (paise), currency, fare, fareDue, tipAmount, totalCharge }
open Razorpay checkout with keyId / orderId / amount
POST /rides/:id/complete-payment/razorpay/verify  { razorpay_order_id, razorpay_payment_id, razorpay_signature, rating, comment, tipAmount }
```

**Wallet:** `POST /rides/:id/complete-payment/wallet { rating, comment, tipAmount }`.

If nothing is owed, these return 400 `No payable amount remains for this ride` — then just
submit `PATCH /rides/:id/feedback`.

---

## 9. "My company" screen and travel-desk bookings

From the cached `/users/me/corporate` membership:
- Company name, **employee ID** (`employeeCode`), **role** (`role.name`), department.
- Allowance bar: `usedKm + reservedKm` of `allowanceKm`, "{remainingKm} km left this
  week/month" (`period`). `reservedKm` = km held by trips booked but not finished.
- Travel area: "Anywhere" for `free_roaming`, else the office list (+ map circles,
  `rule == both_ends` → "pickup and drop must be near an office", `either_end` → "pickup or drop").
- Payment for extra km: `excessPayment.allowedMethods`.

**Travel desk:** the company can book a trip in the employee's name. The employee gets a push
`data.type: "corporate_trip_booked"` with `data.rideId` → open the ride screen
(`GET /rides/:rideId`). `ride.corporate.bookedByCorporateAdminId` is set on such rides — show
"Booked by your company". If the company cancels it: push `corporate_trip_cancelled` +
the usual `rideCancelled` socket event. An employee can only have one active trip; a
travel-desk booking is refused while they're on one.

Refresh `/users/me/corporate` after every completed or cancelled corporate trip so the
allowance bar stays current.

---

## 10. Driver app (short)

For rides with `paymentMethod == "corporate"`:
- Treat it as prepaid — don't ask the rider for the fare.
- If `ride.corporate.split.employeePaymentMethod == "cash"` and `split.employeeAmount > 0`,
  show **"Collect ₹{employeeAmount} from the rider"** on the completion screen (use the
  amount from the completed ride — it's final then).
- Earnings: the wallet credit is fare − commission, minus the cash the driver collected.

---

## 11. Test checklist

1. Non-employee rider: `/users/me/corporate` → `eligible: false`; no "Bill to company".
2. Employee, role with no allowance: estimate shows company pays all; book; complete; rider pays ₹0.
3. Role with a weekly allowance: two trips; second one exceeds → split shown; choose cash; driver
   collects; allowance bar reaches 0.
4. Choose online for the excess → Razorpay order amount equals `employeeAmount` (+ tip).
5. Company with office boundary: drop outside → `withinBoundary: false` in estimate and 403
   `corporate_outside_boundary` on booking.
6. Role with "every trip needs approval": waiting screen; approve from the company panel →
   searching; reject → cancelled with note.
7. Travel desk booking from the company panel → push opens the ride in the employee app.
8. Employee in two companies → company picker, `corporateId` sent.

Test company on live: Demo Corp Pvt Ltd (company panel at `/corporate-panel/login`). Add an
employee there with the tester's phone number, give them a role with an allowance, then log in
to the user app with that number. The live site also needs cities/zones and vehicle types set
up in the admin panel (or a company tariff) before quotes return vehicles.
