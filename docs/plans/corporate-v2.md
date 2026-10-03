# Corporate v2 — roles, employee IDs, free-km allowance, company tariff, office boundary, travel desk, weekly billing

The contract between the backend and the web panels for this change. The
backend implements exactly these shapes; the panels code against them. If
either side has to deviate, change this file in the same commit.

Base paths (all under `/api/v1`):
- Corporate panel: `/corporate/*` (JWT role `corporate_admin`; existing `requireCorporateAccess` role gates — `managers` = owner|admin, `money` = owner|admin|finance, `deciders` = owner|admin|approver).
- Platform admin: `/admin/corporates/*` (JWT role `admin`).
- Rider app: `/users/me/corporate`, `/rides/*`.

Business decisions this implements:
1. **Excess km is paid by the employee** (split payment). Inside the
   allowance the company pays; beyond it the employee pays the excess share of
   the fare with their own cash / online / wallet.
2. **Company tariff**: the admin may give a company its own per-km rate card.
   When enabled, a company-billed trip is priced on it, and that one fare is
   both what the company is billed (before excess split / discount) and what
   the driver's earnings are computed from (fare − commission). The admin may
   also override the commission taken on that company's trips.
3. **Travel desk**: corporate panel users can book a trip for an employee.
4. **Allowance counts every company-billed service**, rentals included.
5. **Office boundary**: a company chooses free roaming or "only within a
   boundary around our offices".

---

## 1. Data model

### 1.1 `CorporateRole` (new, `corporate/models/CorporateRole.js`)

```js
{
  corporateId: ObjectId,            // required
  name: String,                     // "CEO", "VP", "Employee" — unique per company (case-insensitive)
  code: String,                     // "CEO", "VP", "EMP" — uppercase, unique per company
  level: Number,                    // seniority, higher = more senior; ordering only
  active: Boolean,                  // default true
  isDefault: Boolean,               // the role new employees get when none is chosen; exactly one per company
  allowance: {
    enabled: Boolean,               // false = no km limit, the company pays every km
    km: Number,                     // free km per period, >= 0
    period: 'weekly' | 'monthly',   // IST; weekly = Monday 00:00 → next Monday 00:00
  },
  // Travel rules, same meaning and merge semantics as CorporateTripPolicy
  // (empty list / null = inherit from department → company):
  allowedServices: [String],        // ride | parcel | intercity | rental
  allowedVehicleTypeIds: [ObjectId],
  maxFarePerTrip: Number | null,
  requireApprovalAlways: Boolean | null,
  requireApprovalAbove: Number | null,
  monthlySpendLimit: Number,        // 0 = none (company-paid amount only)
}
```

New companies (self-registered or admin-created) are seeded with three roles:
CEO (level 30), VP (level 20), Employee (level 10, `isDefault: true`), all with
`allowance.enabled: false`. Existing companies get the same three on first
read (idempotent upsert by `code`).

Policy merge order becomes **company → department → role → employee**, each
level overriding only what it sets.

### 1.2 `CorporateEmployee` — added fields

```js
roleId: ObjectId | null,   // CorporateRole; null → the company's default role
employeeCode: String,      // now unique per company (partial unique index on corporateId+employeeCode where non-empty)
```

`employeeCode` is generated when not supplied: `<Corporate.code>-<4-digit seq>`
(e.g. `ACME-0001`), from a per-company counter. A company with no `code` gets
one generated from its name on first need (uppercase letters, max 6, made
unique). A supplied code is kept as typed (trimmed, uppercased). Existing
employees with a blank code are backfilled by `scripts/backfillCorporateV2.js`.

### 1.3 `Corporate` — added fields

```js
billingCycle: 'weekly' | 'monthly',          // was monthly-only; default stays 'monthly'

tariff: {
  enabled: Boolean,                           // default false → normal Set Price fares
  // Fallback rate for any vehicle type not listed below:
  baseFare: Number, baseKm: Number, perKm: Number, perMinute: Number, minimumFare: Number,
  byVehicleType: [{ vehicleTypeId: ObjectId, baseFare, baseKm, perKm, perMinute, minimumFare }],
  // Applies to these services only (default ['ride','intercity']):
  appliesTo: [String],
},

driverCommission: {                           // what the platform keeps on this company's trips
  enabled: Boolean,                           // false → the Set Price commission, as today
  type: 'percentage' | 'fixed',
  value: Number,
},

travelZone: {
  mode: 'free_roaming' | 'office_boundary',   // default 'free_roaming'
  rule: 'both_ends' | 'either_end',           // office_boundary: must pickup AND drop be inside, or just one; default 'both_ends'
  offices: [{
    _id, name: String, address: String,
    location: { type: 'Point', coordinates: [lng, lat] },
    radiusKm: Number,                         // circle around the office; > 0
  }],
},

excessPayment: {
  // What the employee may use to pay their excess share.
  allowedMethods: ['cash', 'online', 'wallet'],   // default all three
},
```

### 1.4 `Ride` — added fields

```js
// On every completed ride (not only corporate), set at completion:
actualDistanceMeters: Number,      // odometer delta > GPS trail (DriverLocationHistory) > routed estimate
actualDistanceSource: 'odometer' | 'gps' | 'estimate',

// On Ride.corporate (rideCorporateSchema):
roleId: ObjectId | null,
bookedByCorporateAdminId: ObjectId | null,   // travel-desk bookings
pricing: 'company_tariff' | 'standard',
allowance: {
  periodKey: String,               // '2026-10' or '2026-W41'
  allowanceKm: Number,             // the role's allowance for the period (0 when disabled)
  remainingKmAtBooking: Number,
  estimatedKm: Number,
  actualKm: Number,                // set at completion
  coveredKm: Number,               // company-paid km
  excessKm: Number,                // employee-paid km
},
split: {
  companyAmount: Number,           // billed to the company (before discount)
  employeeAmount: Number,          // the employee pays this
  employeePaymentMethod: 'cash' | 'online' | 'wallet' | '',
  employeePaymentStatus: 'not_required' | 'pending' | 'paid',
},
```

`billedAmount` (existing) = `split.companyAmount` − discount. When the allowance
is disabled for the role, `coveredKm = actualKm`, `employeeAmount = 0`.

### 1.5 `CorporateAllowanceUsage` (new)

One document per employee per period:

```js
{ corporateId, employeeId, roleId, periodKey, period: 'weekly'|'monthly',
  allowanceKm, usedKm, reservedKm, rides: Number, updatedAt }
// unique (employeeId, periodKey)
```

- `reservedKm` holds km for trips booked but not yet completed (so two trips
  booked together cannot both claim the same remaining km). Booking reserves
  `min(remaining, estimatedKm)`; completion releases the reservation and adds
  the actual covered km to `usedKm`; cancellation releases it. All via single
  atomic `$inc` updates guarded on availability.
- `remaining = max(0, allowanceKm − usedKm − reservedKm)`.

---

## 2. Money rules

**Fare.** If `tariff.enabled` and the service is in `tariff.appliesTo`, the
corporate trip's fare is computed from the company tariff (vehicle-specific row,
else the fallback) with the same arithmetic as `computeFareBreakdown`
(base covers `baseKm`, then per-km, per-minute, minimum fare floor; GST stays
at the Set Price `service_tax`). Otherwise the normal server fare. Recorded on
`pricingSnapshot.fare_source = 'corporate_tariff'` with the breakdown.

**Split at booking (estimate).** `coveredKm = min(remaining, estimatedKm)`,
`excessKm = estimatedKm − coveredKm`,
`employeeAmount = round(fare × excessKm / estimatedKm)`, `companyAmount = fare − employeeAmount`.

**Split at completion (final).** Recomputed from `actualKm` against the
allowance remaining at that moment (reservation released first). The ride's
`fare` is the final fare. Same formula with actual km.

**Discount** (existing) applies to `companyAmount` only.

**Credit-limit and monthly-cap checks** use `companyAmount` (after discount).

**Employee payment.** At booking the rider app (or travel desk) chooses
`employeePaymentMethod` from `excessPayment.allowedMethods`, required only
when `employeeAmount > 0` (estimate). If the final split produces an excess the
estimate did not, the default is `cash` when allowed, else `online`.
- cash: the driver collects `employeeAmount` and confirms on completion.
- online / wallet: the existing ride completion payment endpoints
  (`/rides/:id/complete-payment/razorpay/*`, `/wallet`) charge exactly
  `employeeAmount` for corporate rides.

**Driver earnings.** Unchanged principle: commission is computed on the full
`fare` (using `driverCommission` when enabled, else the Set Price commission).
- online/wallet/no excess: driver wallet credited `fare − commission` (as today).
- cash excess: driver collected `employeeAmount` in cash, so the wallet is
  credited `fare − commission − employeeAmount` (may be negative → recorded as a
  commission deduction, exactly how cash rides are handled today).

**Office boundary.** `office_boundary` + `both_ends`: pickup and drop must each
be inside some office circle; `either_end`: at least one. Checked at booking
(estimate and create), including travel-desk bookings. Refused with 403
`{ code: 'corporate_outside_boundary', offices: [...] }`.

---

## 3. Endpoints

### 3.1 Corporate panel (`/corporate`)

| Method | Path | Gate | Body / query → response |
|---|---|---|---|
| GET | `/roles` | anyRole | → `{ results: [Role + { employeeCount }] }` |
| POST | `/roles` | managers | Role fields → Role |
| PATCH | `/roles/:roleId` | managers | partial Role → Role |
| DELETE | `/roles/:roleId` | managers | refused (409) if employees use it or it is the default |
| POST | `/roles/:roleId/make-default` | managers | → Role |
| GET | `/employees` | anyRole | existing, plus each row gains `role {id,name,code}`, `employeeCode`, `allowance {periodKey, allowanceKm, usedKm, reservedKm, remainingKm}`; new filter `roleId` |
| POST/PATCH | `/employees[/:id]` | managers | existing, plus `roleId`; `employeeCode` optional (generated when blank) |
| GET | `/employees/:id/allowance?periods=6` | anyRole | → `{ current, history: [usage...] }` |
| GET | `/travel-zone` | anyRole | → `travelZone` |
| PUT | `/travel-zone` | managers | `travelZone` → `travelZone` |
| POST | `/bookings/quote` | managers + approver | `{ employeeId, pickup, drop, vehicleTypeId?, serviceType?, scheduledAt? }` → `{ quotes: [{ vehicleTypeId, vehicleName, fare, pricing, breakdown, allowance, split, withinBoundary }] }` |
| POST | `/bookings` | managers + approver | `{ employeeId, pickup:{lat,lng,address}, drop:{lat,lng,address}, vehicleTypeId, serviceType?, scheduledAt?, employeePaymentMethod?, note? }` → `{ ride: {id, status, fare, split, allowance} }`. Books in the employee's name (their rider account); skips the approval step when the booker is owner/admin/approver; pushes "a trip was booked for you" to the employee. |
| GET | `/bookings` | anyRole | travel-desk bookings, paged, filters status/employeeId/from/to |
| POST | `/bookings/:rideId/cancel` | managers + approver | cancels a travel-desk booking that has not started |
| GET | `/invoices/:id/export.csv` and `.xlsx` | money | the per-trip annex |

### 3.2 Platform admin (`/admin/corporates`)

| Method | Path | Body → response |
|---|---|---|
| PATCH | `/:id` | existing, now also accepts `billingCycle`, `tariff`, `driverCommission`, `travelZone`, `excessPayment` |
| GET/POST/PATCH/DELETE | `/:id/roles[/:roleId]` | same as the panel's role endpoints |
| GET | `/:id/allowance?periodKey=` | every employee's usage for a period |
| GET | `/invoices/:invoiceId/export.csv` / `.xlsx` | as panel |

`POST /` (admin create) accepts the same new fields plus, as today, the owner
login (`owner: { name, email, phone, password }`).

### 3.3 Rider app

- `GET /users/me/corporate` — each membership gains `employeeCode`,
  `role {id,name,code}`, `allowance {period, periodKey, allowanceKm, usedKm, reservedKm, remainingKm}`,
  `travelZone {mode, rule, offices:[{name, lat, lng, radiusKm}]}`,
  `excessPayment.allowedMethods`, `pricing: 'company_tariff'|'standard'`.
- `POST /rides/estimate` with `paymentMethod: 'corporate'` — each quote gains
  `corporate { fare, pricing, allowance{...estimate}, split{companyAmount, employeeAmount}, withinBoundary }`.
- `POST /rides` with `paymentMethod: 'corporate'` accepts
  `employeePaymentMethod` (required when the estimate has an excess) and
  optional `corporateId` (for riders in more than one company).

### 3.4 Invoices

Each annex line gains: `employeeCode`, `roleName`, `pickupAddress`,
`dropAddress`, `vehicleName`, `startedAt`, `completedAt`, `actualKm`,
`coveredKm`, `excessKm`, `grossFare`, `employeeAmount`, `companyAmount`,
`discountAmount`, `billedAmount`, `pricing`. Summaries gain `byRole` and
`byEmployee` (trips, km, covered km, excess km, billed). The PDF prints the
role summary and the extra columns; the CSV/XLSX export has every column.

Weekly companies are invoiced every Monday (IST) for the previous week, with
`periodKey` `YYYY-Www` (ISO week); monthly companies as today. The background
job picks per company by `billingCycle`.

---

## 4. Settings (corporate section, defaults)

| Key | Default | Meaning |
|---|---|---|
| `allowance_enabled` | `'1'` | master switch for role km allowances |
| `tariff_enabled` | `'1'` | master switch for company tariffs |
| `travel_zone_enabled` | `'1'` | master switch for office boundaries |
| `travel_desk_enabled` | `'1'` | master switch for panel bookings |

Every per-company field defaults off (`allowance.enabled: false`,
`tariff.enabled: false`, `driverCommission.enabled: false`,
`travelZone.mode: 'free_roaming'`), so nothing changes for an existing
company until someone sets it.
