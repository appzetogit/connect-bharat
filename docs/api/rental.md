# Rental API (SOW 7.2 to 7.9)

For the Flutter team. All paths are under `/api` (or `/api/v1`). Responses use
the usual envelope, `{ "success": true, "data": ... }`. Errors come back as
`{ "success": false, "message": "..." }` with the HTTP status shown.

Nothing here changes an existing request or response. Existing rental
endpoints keep their shapes and gain the extra booking fields listed in
[Booking fields added](#booking-fields-added).

Code lives in `Backend/src/modules/taxi/rental/`.

---

## Settings (`rental` business-settings section)

| Key | Default | Effect |
|---|---|---|
| `self_drive_enabled` | `'1'` | Self-drive bookings are allowed. This was the only mode before. |
| `with_driver_enabled` | `'0'` | With-driver bookings are allowed. |
| `enforce_inventory` | `'0'` | Booking creation returns **409** when no vehicle unit is free. Leave off until units are entered. |
| `auto_approve_extensions` | `'0'` | An extension is approved straight away when a car is free. |
| `bill_extra_km` | `'0'` | Km beyond the package allowance is billed from the odometer readings. This is captured on each booking when it is created, so changing it never reprices existing bookings. |
| `require_self_drive_kyc` | `'0'` | A self-drive booking without a driving-licence image is rejected with 400. |
| `email_invoice_on_completion` | `'1'` | The invoice PDF is emailed when a rental completes. |

Admins edit these from **Rental Operations > Settings**, or with
`GET/PATCH /admin/rental-settings` or `PATCH /admin/general-settings/rental`.

## Vehicle type fields added

These are returned by `GET /users/rental-vehicles` (the catalogue) and the admin
vehicle endpoints.

```json
{
  "pricing": [
    { "id": "pkg-24h", "label": "1 Day", "durationHours": 24, "price": 1800,
      "includedKm": 250, "extraHourPrice": 150, "extraKmPrice": 9,
      "pricingUnit": "day", "extraDayPrice": 2000, "active": true }
  ],
  "driveModes": ["self_drive", "with_driver"],
  "withDriverSurcharge": { "amount": 600, "unit": "per_day" },
  "securityDeposit": { "enabled": true, "amount": 5000 }
}
```

- `pricingUnit: "hour"` (default) works as before: `price` pays for the whole package (`durationHours`), and `includedKm` covers the whole package.
- `pricingUnit: "day"`: `price` and `includedKm` are **per day**. The booking is billed for every day it spans, and never for fewer days than the package length. If the car comes back late, each extra hour costs `extraHourPrice`, but one late day never costs more than `extraDayPrice`, and each full extra day costs `extraDayPrice`. When `extraDayPrice` is 0, the day `price` is used instead.
- `includedKm: 0` means unlimited km, so no km is ever billed.
- `driveModes` defaults to `["self_drive"]`. Only the modes that are also switched on globally can be booked. Use `GET /users/rental-config`.
- `withDriverSurcharge.unit` is `per_day`, `per_hour` or `per_booking`.

## Booking fields added

These fields appear on every rental booking object: `POST/GET /users/rental-bookings`, `GET /users/rental-bookings/active`, the admin list and the service-centre list.

```json
{
  "driveMode": "self_drive",
  "kycRequired": true,
  "packageTerms": { "pricingUnit": "day", "billedDays": 3, "includedKm": 250, "extraKmPrice": 9, "extraDayPrice": 2000 },
  "withDriverSurcharge": { "amount": 0, "unit": "per_day" },
  "driverSurchargeAmount": 0,
  "billingTerms": { "kmBillingEnabled": false },
  "billingEndedAt": null,
  "assignedUnit": { "id": "", "registrationNumber": "" },
  "assignedDriver": { "id": "", "name": "", "phone": "" },
  "deposit": {
    "required": true, "amount": 5000, "status": "pending",
    "paidVia": "", "paymentId": "", "paidAt": null,
    "releasedAmount": 0, "releasedAt": null, "releasedVia": "",
    "deductions": [{ "id": "...", "reason": "Scratch on bumper", "amount": 1200, "damageReportId": "...", "createdAt": "..." }]
  },
  "extensions": [{ "id": "...", "from": "...", "to": "...", "hours": 3, "amount": 450, "includedKm": 30,
                   "status": "requested", "autoApproved": false, "paymentId": "", "paidVia": "", "paidAt": null, "note": "" }],
  "additionalCharges": [{ "id": "...", "type": "damage", "reason": "...", "amount": 700, "damageReportId": "..." }],
  "damageReportIds": ["..."],
  "invoice": { "invoiceNumber": "RINV-AB12CD", "generatedAt": "...", "emailedAt": "..." },
  "corporateId": "", "corporateEmployeeId": "", "billingMode": "self"
}
```

The `deposit.status` values are `not_required`, `pending`, `held`, `partially_released`, `released` and `forfeited`.

The `extensions[].status` values are `requested`, `approved`, `rejected` and `paid`.

`rideMetrics` (on the existing endpoints and on `rentalBookingSnapshot`) keeps every
field it had and adds the following:
`pricingUnit, billedDays, allowedHours, distanceKm, includedKm, extraKm, extraKmRate, extraKmCharge,
extensionHours, extensionsCharge, extensionsPaid, additionalCharges, extraHours, extraTimeCharge,
driverSurcharge, grossCharge`. `remainingDue` now also subtracts paid extensions.

### Booking creation (`POST /users/rental-bookings`), new optional body fields

| Field | Notes |
|---|---|
| `driveMode` | `self_drive` or `with_driver`. If you leave it out, the first mode allowed for the vehicle is used. A mode that is not allowed returns 400. |
| `corporateId`, `corporateEmployeeId`, `billingMode` | Stored only (corporate rental, 7.3). |

For a day package or a with-driver booking, the server sets `totalCost` and `payableNow`. Get both from **`POST /users/rental-bookings/quote`** before you charge the advance. If a client computes the advance from the package price, it will under-charge.

The response can be **409** `No vehicle of this type is available for the selected dates` when `enforce_inventory` is on.

---

## User endpoints (role `user` unless noted)

### `GET /users/rental-config` (public)
```json
{ "selfDriveEnabled": true, "withDriverEnabled": false, "enforceInventory": false,
  "autoApproveExtensions": false, "billExtraKm": false, "requireSelfDriveKyc": false }
```

### `GET /users/rental-vehicles/:id/availability?from=ISO&to=ISO&serviceStoreId=` (public)
```json
{ "vehicleTypeId": "...", "from": "...", "to": "...", "available": 2, "totalUnits": 3, "usableUnits": 3,
  "overlappingBookings": 1, "inventoryTracked": true, "enforced": false, "bookable": true }
```
Show the vehicle as bookable from `bookable`. When no units are entered and the
inventory is not enforced, `bookable` is `true`, just as before. Units are counted
as usable units minus the most bookings that are out at the same moment. A booking holds a car while its status is pending, confirmed, assigned or end_requested. If the car is out past its return time, it keeps holding until now.

### `POST /users/rental-bookings/quote`
Body: `{ vehicleTypeId, packageId, pickupDateTime, returnDateTime, driveMode? }`
```json
{ "pricingUnit": "day", "billedDays": 3, "requestedHours": 60, "includedHours": 72, "includedKm": 750,
  "basePrice": 5400, "unitPrice": 1800, "extraHourPrice": 150, "extraKmPrice": 9, "extraDayPrice": 2000,
  "driverSurcharge": 0, "totalCost": 5400, "driveMode": "self_drive", "allowedDriveModes": ["self_drive"],
  "kycRequired": true, "payableNow": 1080, "securityDeposit": 5000 }
```

### `GET /users/rental-bookings/:id`
This returns the compact booking (`rentalBookingSnapshot`): id, reference, status, dates,
totalCost, payableNow, paymentStatus, finalCharge, every added field above, and live `rideMetrics`.

### Security deposit
The deposit uses the same gateways as the rental advance (it reuses those handlers).

- `POST /users/rental-bookings/:id/deposit/order`. Body `{ "provider": "razorpay" | "phonepe" }`.
  The response is the advance order response with `amount` set to the deposit:
  - Razorpay: `{ provider, amount, purpose, keyId, orderId, currency, bookingReference }`. Open checkout with `keyId` and `orderId`.
  - PhonePe: `{ provider, amount, purpose, gateway, merchantTransactionId, checkoutUrl, ... }`. The redirect returns to `/phonepe/status?flow=user-rental`, the same as the advance.
- `POST /users/rental-bookings/:id/deposit/pay`. Body by provider:
  - `{ "provider": "wallet" }` debits the in-app wallet. A retry is safe: the debit is idempotent per booking.
  - `{ "provider": "razorpay", "razorpay_order_id", "razorpay_payment_id", "razorpay_signature" }`
  - `{ "provider": "phonepe", "merchantTransactionId" }`. A PhonePe payment that is still pending returns 409, so retry.

  The response is the booking snapshot with `deposit.status: "held"`. The response is 409 if the deposit was already paid, and 400 if the wallet balance is too low. A gateway payment id can settle only one rental charge.

The deposit is released after the rental (see the admin and service-centre
sections). The remainder is credited to the rider's **wallet** for now. See
`rental/services/depositRefund.js`, which is the single switch point for gateway refunds.

### Extension
- `POST /users/rental-bookings/:id/extend/quote`. Body `{ newReturnDateTime }`. The response is `{ from, to, hours, timeCharge, driverSurcharge, includedKm, amount, available }`.
- `POST /users/rental-bookings/:id/extend`. Body `{ newReturnDateTime, note? }`. The response is `{ extension, booking }`.
  The extension is `approved` straight away when `auto_approve_extensions` is on and a car is free. Otherwise it is `requested` and waits for an admin.
  The response is 409 when no car is free for the extra window, when the booking cannot be extended (completed, cancelled or end_requested), or when another request is already pending.
  `returnDateTime` changes only when the extension is approved or paid.
- `POST /users/rental-bookings/:id/extensions/:extId/order`. Body `{ provider }`. Same shape as the deposit order.
- `POST /users/rental-bookings/:id/extensions/:extId/pay`. Same bodies as the deposit pay. Paying an extension that is still `requested` also approves it, provided a car is still free.

  Pricing uses the booking's own rates. Hour packages use `extraHourPrice`, or the package's hourly rate if that is 0. Day packages follow the late-day rule above. A with-driver booking also pays the surcharge for the extra window.

### Damage
- `POST /users/rental-bookings/:id/damage-reports`. Body:
  ```json
  { "items": [{ "part": "Rear bumper", "severity": "minor|moderate|major", "description": "...",
                "photos": ["https://..."], "estimatedCost": 0 }], "notes": "..." }
  ```
  This is allowed while the booking is confirmed, assigned or end_requested, and is saved as stage `during`.
- `GET /users/rental-bookings/:id/damage-reports` returns `{ results: [DamageReport] }`.
- `POST /users/rental-damage-reports/:reportId/dispute`. Body `{ reason }`. Only an `assessed` or `charged` report can be disputed.

A DamageReport looks like this:
```json
{ "id": "...", "bookingId": "...", "bookingReference": "RNT-...", "stage": "pre|post|during",
  "reportedBy": { "role": "user|service_center|service_center_staff|admin", "id": "...", "name": "" },
  "items": [...], "notes": "", "totalEstimatedCost": 0, "assessedAmount": null,
  "status": "open|assessed|charged|waived|disputed", "chargedAmount": 0, "chargedFromDeposit": 0,
  "chargedToFinal": 0, "dispute": { "raisedAt": null, "reason": "" }, "resolution": "", "history": [...] }
```

### Invoice
- `GET /users/rental-bookings/:id/invoice` returns the PDF (`application/pdf`, inline).
- `GET /users/rental-bookings/:id/invoice.json` returns the same data as JSON:
  ```json
  { "invoiceNumber": "RINV-AB12CD", "invoiceDate": "...", "status": "completed",
    "company": {...}, "rental": { "bookingReference", "customerName", "vehicleName", "registrationNumber",
    "driveMode", "serviceCentre", "pickup", "return", "startOdometer", "endOdometer", "distanceKm" },
    "charges": [{ "code": "base_package|extra_time|extra_km|driver_surcharge|extension|damage|additional|minimum_charge|deposit_deduction",
                  "label": "...", "detail": "...", "amount": 0 }],
    "subtotal": 0, "tax": { "percentage": 5, "amount": 0 }, "total": 0,
    "credits": [{ "code": "advance|extensions_paid", "label": "...", "amount": 0 }], "creditTotal": 0,
    "deposit": { "amount": 5000, "status": "held", "held": 3800, "deductedForCharges": 1200, "released": 0 },
    "balance": 0, "metrics": { ...rideMetrics } }
  ```
The invoice is built from the current booking every time, so a later damage charge appears on the next download. It is emailed to the rider once, when the booking first becomes `completed`, whichever app completes it.

---

## Service centre (roles `service_center`, `service_center_staff`)

Staff can act only on bookings assigned to them, the same as the existing `/drivers/service-center/bookings/*` routes.

| Method and path | Body | Notes |
|---|---|---|
| `GET /drivers/service-center/rental-units` | | The centre's own units. |
| `PATCH /drivers/service-center/bookings/:bookingId/assignment` | `{ assignedUnitId }` | Only the centre's own units. Returns 409 if the unit is booked for an overlapping time. |
| `POST /drivers/service-center/bookings/:bookingId/damage-reports` | `{ stage: "pre"\|"post", items, notes }` | At inspection. A `post` report also sets `rentalInspection.afterReturn.damageReviewed = true` and links the report to the booking. A `pre` report records damage that was already there, and that damage can never be charged. |
| `GET /drivers/service-center/bookings/:bookingId/damage-reports` | | |
| `POST /drivers/service-center/bookings/:bookingId/deposit/collect` | `{ paidVia: "cash"\|"upi"\|"card", reference? }` | The deposit was taken at the counter. |
| `POST /drivers/service-center/bookings/:bookingId/deposit/release` | `{ deductions: [{ reason, amount }] }` | Allowed after the rental has ended or been cancelled. The remainder is refunded to the wallet. |
| `GET /drivers/service-center/bookings/:bookingId/invoice` and `/invoice.json` | | |

The existing `PATCH /drivers/service-center/bookings/:bookingId` is unchanged.
Completing a booking through it now also computes `finalCharge`, which was left at 0
before. Once the return odometer reading is saved, the km charge is added.

## Driver (role `driver`)

- `GET /drivers/rental-assignments` lists the with-driver rentals assigned to the calling driver. The response is `{ results: [snapshot + contactName, contactPhone, serviceLocation] }`.

## Admin (role `admin`)

| Method and path | Body or query | Notes |
|---|---|---|
| `GET /admin/rental-settings`, `PATCH /admin/rental-settings` | `{ settings: { key: '0'\|'1' } }` | |
| `GET /admin/rental-vehicle-units` | `?rentalVehicleTypeId&serviceStoreId&status&search` | |
| `POST /admin/rental-vehicle-units` | `{ rentalVehicleTypeId, registrationNumber, serviceStoreId?, status?, odometer?, fuel?, color?, modelYear?, photos?, documents?: [{name,imageUrl,number,expiryDate}], notes? }` | A duplicate registration number returns 409. |
| `PATCH /admin/rental-vehicle-units/:id`, `DELETE /admin/rental-vehicle-units/:id` | | Delete returns 409 while the unit is on an open booking. |
| `GET /admin/rental-vehicles/:id/availability` | `?from&to&serviceStoreId` | The full availability object, including `freeUnitIds` and `peakConcurrent`. |
| `GET /admin/rental-booking-requests` | `?corporateId&billingMode&driveMode&status&depositStatus&vehicleTypeId` | The existing list, now with filters. |
| `PATCH /admin/rental-booking-requests/:id` | existing body, plus `assignedUnitId`, `assignedDriverId` | Existing endpoint. A unit must be the booking's vehicle type, must not be in maintenance or inactive, and must not overlap another booking (409). A driver can be assigned only to a `with_driver` booking. |
| `PATCH /admin/rental-booking-requests/:id/assignment` | `{ assignedUnitId?, assignedDriverId? }` | The same rules, as a dedicated endpoint. |
| `GET /admin/rental-deposits` | `?status` | Bookings that require a deposit. |
| `POST /admin/rental-booking-requests/:id/deposit/collect` | `{ paidVia: cash\|upi\|card\|bank_transfer, reference? }` | |
| `POST /admin/rental-booking-requests/:id/deposit/release` | `{ deductions: [{ reason, amount }] }` | The status becomes `released`, `partially_released` or `forfeited`. |
| `GET /admin/rental-extensions` | `?status=requested` | One row per extension, with the booking reference and the customer. |
| `PATCH /admin/rental-booking-requests/:id/extensions/:extId` | `{ status: "approved"\|"rejected", note? }` | Approval re-checks inventory (409) and moves `returnDateTime`. |
| `GET /admin/rental-damage-reports` | `?bookingId&status&stage` | |
| `GET /admin/rental-damage-reports/:id` | | |
| `PATCH /admin/rental-damage-reports/:id` | see below | |
| `POST /admin/rental-booking-requests/:id/damage-reports` | `{ stage, items, notes }` | |
| `GET /admin/rental-booking-requests/:id/invoice` and `/invoice.json` | | |

Damage actions (`PATCH /admin/rental-damage-reports/:id`):
- `{ "action": "assess", "assessedAmount": 1500, "notes"?: "" }` sets the status to `assessed`.
- `{ "action": "charge", "amount"?: 1500 }`. The amount defaults to the assessed amount, or else the estimate. It is taken from the held deposit first (as a `deposit.deductions` entry), and whatever the deposit cannot cover is added to the booking's `additionalCharges`, which `finalCharge` includes. Charging the same report again replaces its earlier charge instead of adding a second one.
- `{ "action": "waive", "resolution"?: "" }` undoes the report's charge while the deposit is still held.
- `{ "action": "resolve_dispute", "outcome": "uphold"|"waive"|"adjust", "amount"?: 0, "resolution": "" }`

---

## Socket events

The server emits these to the user room (`user:<id>`), the driver room or the admin room:

| Event | To | Payload |
|---|---|---|
| `rental:deposit_updated` | user | `{ bookingId, status, amount?, releasedAmount?, releasedVia?, actor? }` |
| `rental:extension_requested` | admins | `{ bookingId, bookingReference, extension }` |
| `rental:extension_updated` | user | `{ bookingId, bookingReference, extension }` (approved, rejected or paid) |
| `rental:damage_reported` | admins, plus the user when staff or an admin reported it | `{ bookingId, bookingReference, report }` |
| `rental:damage_report_updated` | user (admin action), admins (user dispute) | `{ bookingId, bookingReference, report }` |
| `rental:driver_assigned` | driver | `{ bookingId, bookingReference, pickupDateTime, returnDateTime, vehicleName, serviceLocation, contactName, contactPhone }` |
| `rental:booking_updated` | user | `{ bookingId, status }` (assignment changed) |
| `rental:invoice_ready` | user | `{ bookingId, bookingReference, invoiceNumber }` (on completion) |

## How final charges are computed

A pre-save hook on `RentalBookingRequest` recomputes `finalCharge` whenever a settled
booking (end_requested or completed) is saved. It recomputes against
`billingEndedAt`, which is the moment the clock first stopped. This means:
- the odometer reading, damage charges and extensions recorded after the rider ends the rental are still billed;
- time after the clock stopped is never billed;
- a legacy completed booking that already has a charge and no `billingEndedAt` is never touched.

When the booking becomes `completed`, a post-save hook releases its vehicle unit, which goes back to `available` with the return odometer reading. It also emails the invoice.
