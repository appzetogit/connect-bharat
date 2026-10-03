# Corporate module API

SOW items 8.1–8.9, 2.13, 10.4 and the `corporate_admin` role (1.5).

Base URL: `/api/v1` (also `/api`). Every response is `{ "success": true, "data": ... }`; errors are `{ "success": false, "message": "...", "details": ... }`.
Money is in rupees with two decimals. Dates are ISO strings (UTC); "month" and "hours" rules are evaluated in IST.

Code: `Backend/src/modules/taxi/corporate/`. Corporate web panel: `/corporate-panel` in `frontend/`. Admin pages: `/admin/corporates`.

---

## 1. Rider app (Flutter) — what changes

### 1.1 `GET /users/me/corporate` — role `user`

Tells the app whether to offer **Bill to company** on the payment picker.

```json
{
  "success": true,
  "data": {
    "eligible": true,
    "paymentMethod": "corporate",
    "memberships": [
      {
        "corporateId": "66f0...",
        "corporateName": "Acme Pvt Ltd",
        "corporateStatus": "approved",
        "employeeId": "66f1...",
        "employeeCode": "EMP001",
        "department": { "id": "66f2...", "name": "Sales" },
        "canBill": true,
        "reason": "",
        "discount": { "type": "percentage", "value": 10, "appliesTo": ["ride", "parcel", "intercity", "rental"] },
        "monthlyLimit": 5000,
        "spentThisMonth": 1240.5,
        "remainingThisMonth": 3759.5,
        "policy": {
          "allowedServices": ["ride", "intercity"],
          "allowedVehicleTypeIds": [],
          "allowedHours": [{ "days": [1, 2, 3, 4, 5], "start": "08:00", "end": "21:00" }],
          "outsideHoursAction": "approval",
          "maxFarePerTrip": 1500,
          "requireApprovalAbove": 800,
          "requireApprovalAlways": false
        }
      }
    ]
  }
}
```

A rider who is not an employee gets `{ "eligible": false, "memberships": [] }` (never an error). `canBill: false` with a `reason` means the company is not approved or is out of credit.
`allowedServices` uses `ride | parcel | intercity | rental` (`intercity` = outstation). Hours are IST; `days` 0 = Sunday.

### 1.2 Booking with `paymentMethod: "corporate"`

Unchanged endpoints, one new value:

- `POST /rides` (REST) and the socket event `requestRide`: send `"paymentMethod": "corporate"`.
- Parcels through `POST /deliveries` work the same way if the app passes `paymentMethod: "corporate"`.

The server prices the trip (as for every booking), then checks the company policy, the employee's monthly limit, the department budget and the company credit limit.

**Refused** → HTTP 403, socket `errorMessage`:

```json
{ "success": false, "message": "Fare above the 1500 per-trip limit", "details": { "reasons": ["Fare above the 1500 per-trip limit"] } }
```

Other 403 messages: `You are not registered as an employee of any company`, `Your company account is not active for billing`, `Company credit limit reached`, `No credit limit has been set for this company`, `<service> is not allowed for this account`, `Monthly limit of N would be exceeded`, `Outside allowed travel hours` (when the policy blocks), `Your company has an overdue invoice. Corporate billing is paused.`, `Corporate billing is not available right now`.
Promo codes cannot be combined with corporate billing (400). If the rider has an active ride subscription that covers the vehicle, the subscription wins and the ride is not billed to the company.

**Accepted** → the normal ride response, with the new field `ride.corporate`:

```json
"paymentMethod": "corporate",
"fare": 455,
"corporate": {
  "corporateId": "66f0...",
  "employeeId": "66f1...",
  "departmentId": "66f2...",
  "tripRequestId": null,
  "approvalStatus": "not_required",
  "discountType": "percentage",
  "discountValue": 10,
  "discountAmount": 45.5,
  "billedAmount": 409.5,
  "chargedAt": null,
  "billed": false,
  "invoiceId": null
}
```

- `fare` stays the trip fare (what the driver's earnings are computed from). The company is billed `billedAmount` = fare − corporate discount. The rider pays nothing.
- Bidding and "raise your fare" are switched off for corporate rides; the quoted fare is the billed fare.
- The driver app must not ask the rider for money: treat `"corporate"` like a prepaid ride. If the driver app sends a `paymentMethod` on completion, it is ignored for corporate rides.

**Approval required** (`approvalStatus: "pending"`): the ride is created in `searching` but **no driver is contacted** until a company approver approves. Show a "Waiting for your company's approval" state. Outcomes arrive on the rider's socket (`user:<id>` room, joined automatically on connect) and as push:

| Socket event | Payload | Meaning |
|---|---|---|
| `corporate:trip:pending` | `{ rideId, tripRequestId, expiresAt, reasons[] }` | Sent right after booking |
| `corporate:trip:approved` | `{ rideId, tripRequestId }` | Dispatch has started; normal `ride:*` events follow |
| `corporate:trip:rejected` | `{ rideId, tripRequestId, status: "rejected" \| "expired", note }` | Followed by the usual `rideCancelled` `{ rideId, room, reason }` and `ride:status:updated` |

Push `data.type`: `corporate_trip_approved`, `corporate_trip_rejected`, `corporate_trip_expired`, `corporate_invite`.
Unanswered requests expire after the company's approval window (default 30 min, or at the pickup time for a scheduled ride) and the ride is cancelled. The rider can cancel while waiting with the normal cancel call.

On completion the trip is charged to the company account (`corporate.chargedAt`, final `discountAmount`/`billedAmount` recomputed on the final fare, e.g. after waiting charges).

---

## 2. Corporate web panel API — role `corporate_admin`

Auth header: `Authorization: Bearer <token>` from login. Panel roles: `owner`, `admin`, `approver`, `finance`.
A company that is `pending`/`suspended` can sign in and call `GET /corporate/me`, `PATCH /corporate/me/password`, `PATCH /corporate/profile`; everything else returns 403 `Company account is <status>`.

### 2.1 Public

| Method | Path | Body | Notes |
|---|---|---|---|
| POST | `/corporate/register` | see below | Creates a `pending` company and its `owner` login. 201 |
| POST | `/corporate/auth/login` | `{ email, password }` | |
| POST | `/corporate/auth/send-otp` | `{ phone }` | Always `{ sent: true }` (does not reveal whether the number exists). With `USE_DEFAULT_OTP` the code is `STATIC_OTP_CODE` or `1234` |
| POST | `/corporate/auth/verify-otp` | `{ phone, otp }` | |

Register body:

```json
{
  "name": "Acme", "legalName": "Acme Pvt Ltd", "gstin": "29ABCDE1234F1Z5", "pan": "ABCDE1234F",
  "industry": "IT", "employeeCountEstimate": 200, "billingEmail": "ap@acme.com",
  "billingAddress": { "line1": "12 MG Road", "city": "Bengaluru", "state": "Karnataka", "pincode": "560001" },
  "contact": { "name": "Asha", "email": "asha@acme.com", "phone": "9876543210" },
  "owner": { "name": "Asha", "email": "asha@acme.com", "phone": "9876543210", "password": "min-8-chars" }
}
```

Login / verify-otp response:

```json
{
  "token": "<jwt>", "role": "corporate_admin",
  "admin": { "id": "...", "corporateId": "...", "name": "Asha", "email": "asha@acme.com", "phone": "9876543210", "role": "owner", "departmentIds": [], "active": true },
  "corporate": { "id": "...", "name": "Acme", "code": "ACME4821", "status": "pending", "creditLimit": 0, "currentOutstanding": 0, "paymentTermsDays": 30, "discount": { "type": "percentage", "value": 0 } }
}
```

### 2.2 Session and dashboard

| Method | Path | Roles | Notes |
|---|---|---|---|
| GET | `/corporate/me` | any | `{ admin, corporate }` (full company record) |
| PATCH | `/corporate/me/password` | any | `{ currentPassword?, newPassword }` (current not needed if none was ever set) |
| PATCH | `/corporate/profile` | owner, admin, finance | `billingEmail`, `billingAddress`, `contact`, `industry`, `legalName`, `employeeCountEstimate` (not name/GSTIN/PAN/terms) |
| GET | `/corporate/dashboard?from&to` | any | Usage analytics (2.7) + `aging` |

### 2.3 Employees (8.2)

| Method | Path | Roles | Body / query |
|---|---|---|---|
| GET | `/corporate/employees` | any | `?search&departmentId&active=true\|false&page&limit` → `{ items, total, page, limit }` |
| POST | `/corporate/employees` | owner, admin | `{ name, phone, email?, employeeCode?, designation?, departmentId?, monthlyLimit?, requiresApproval?, allowedServices?, sendInvite? }` |
| GET | `/corporate/employees/:id` | any | |
| PATCH | `/corporate/employees/:id` | owner, admin | same fields + `active` |
| POST | `/corporate/employees/:id/deactivate` | owner, admin | |
| POST | `/corporate/employees/:id/invite` | owner, admin | → `{ push, sms, email }` booleans |
| POST | `/corporate/employees/import` | owner, admin | `{ csv }` text, or `{ rows: [{...}] }`, or `{ fileBase64, fileName }` (.xlsx/.csv); `createDepartments?`, `sendInvites?` → `{ total, created, updated, failed, errors: [{ row, phone, errors[] }] }` |
| GET | `/corporate/employees/import-template` | any | CSV template |

The employee is linked to the rider `User` with the same 10-digit phone; a rider account is created if none exists. Import columns: `Name, Phone, Email, Employee Code, Department, Designation, Monthly Limit, Requires Approval, Allowed Services`.

### 2.4 Departments and policies

| Method | Path | Roles | Body |
|---|---|---|---|
| GET | `/corporate/departments` | any | each with `activeEmployees`, `approverIds` populated |
| POST | `/corporate/departments` | owner, admin | `{ name, code?, costCenter?, monthlyBudget?, approverIds? }` |
| PATCH | `/corporate/departments/:id` | owner, admin | same + `active` |
| DELETE | `/corporate/departments/:id` | owner, admin | deactivates instead if it has employees → `{ deleted, deactivated }` |
| GET | `/corporate/policies` | any | |
| PUT | `/corporate/policies/company` | owner, admin | policy body |
| PUT | `/corporate/policies/departments/:departmentId` | owner, admin | policy body |
| DELETE | `/corporate/policies/:policyId` | owner, admin | |

Policy body (every field optional; for a department policy an empty list or `null` means "inherit the company policy"):

```json
{
  "allowedServices": ["ride", "intercity"],
  "allowedVehicleTypeIds": ["<Vehicle _id>"],
  "allowedHours": [{ "days": [1, 2, 3, 4, 5], "start": "08:00", "end": "21:00" }],
  "outsideHoursAction": "approval",
  "maxFarePerTrip": 1500,
  "overMaxFareAction": "block",
  "requireApprovalAbove": 800,
  "requireApprovalAlways": false
}
```

Rules are checked against the **billable** amount (after discount). Blocking: service/vehicle not allowed, over `maxFarePerTrip` (unless `overMaxFareAction: "approval"`), outside hours with `outsideHoursAction: "block"`, employee `monthlyLimit` exceeded, company credit. Needs approval: over `requireApprovalAbove` (0 = always), `requireApprovalAlways`, employee `requiresApproval`, outside hours (default), department `monthlyBudget` exceeded.

### 2.5 Approvals (8.3)

| Method | Path | Roles | Notes |
|---|---|---|---|
| GET | `/corporate/trip-requests?status=pending&page&limit` | owner, admin, approver | approvers scoped to departments only see those |
| POST | `/corporate/trip-requests/:id/approve` | owner, admin, approver | `{ note? }` → request `status: "booked"`, dispatch starts |
| POST | `/corporate/trip-requests/:id/reject` | owner, admin, approver | `{ note? }` → ride cancelled |

Trip request: `{ _id, employeeId{name,phone,employeeCode}, departmentId{name}, rideId, serviceType, estimatedFare, billableAmount, pickupAddress, dropAddress, scheduledAt, reasons[], status: pending|approved|rejected|expired|cancelled|booked, approverId, decisionAt, note, expiresAt }`. Deciding an already-decided request returns 409.
Approvers are emailed (setting `approver_email_enabled`) and optionally SMSed when a request opens.

### 2.6 Trips, outstanding, invoices

| Method | Path | Roles | Notes |
|---|---|---|---|
| GET | `/corporate/trips?from&to&status&departmentId&employeeId&page&limit` | any | `&format=csv` downloads CSV |
| GET | `/corporate/outstanding` | owner, admin, finance | `{ currentOutstanding, creditLimit, aging, ledger: { items, total } }` |
| GET | `/corporate/invoices` | owner, admin, finance | issued invoices only (drafts are hidden), without the annex |
| GET | `/corporate/invoices/:id` | owner, admin, finance | full invoice with `lines` and `annex` |
| GET | `/corporate/invoices/:id/pdf` | owner, admin, finance | PDF (tax invoice + trip annexure) |
| POST | `/corporate/invoices/:id/pay` | owner, admin, finance | Razorpay payment link → `{ provider, id, url, status, amount }` |
| POST | `/corporate/invoices/:id/sync-payment` | owner, admin, finance | pulls the link status, records any payment |

Trip row: `{ rideId, serviceType, status, liveStatus, pickupAddress, dropAddress, createdAt, completedAt, scheduledAt, distanceKm, grossFare, discountAmount, billedAmount, approvalStatus, invoiceId, employee{id,name,employeeCode}, department{id,name} }`.

### 2.7 Reports (8.5, 8.8)

| Method | Path | Notes |
|---|---|---|
| GET | `/corporate/reports/usage?from&to` | defaults to the current IST month |
| GET | `/corporate/reports/departments?from&to` | `&format=csv` |
| GET | `/corporate/reports/employees?from&to&departmentId` | `&format=csv` |

Usage response: `{ range, totals{trips,spend,gross,discount,avgFare,distanceKm,rentalTrips,rentalSpend,totalSpend}, outstanding, creditLimit, creditAvailable, pendingApprovals, byService[], byMonth[], byDay[], byDepartment[], byEmployee[] (top 25), topRoutes[] (top 10) }`; each row has `trips, spend, gross, discount, avgFare, distanceKm`.

### 2.8 Panel users

| Method | Path | Roles | Body |
|---|---|---|---|
| GET | `/corporate/admins` | owner, admin | |
| POST | `/corporate/admins` | owner, admin | `{ name, email, phone?, role, departmentIds?, password? }` (only an owner can add an owner) |
| PATCH | `/corporate/admins/:id` | owner, admin | `{ name?, phone?, role?, departmentIds?, active?, password? }` |

---

## 3. Platform admin API — role `admin`

All under `/admin/corporates`, `authenticate(['admin'])`. Subadmins need the new permission `corporates.view`.

| Method | Path | Body / notes |
|---|---|---|
| GET | `/admin/corporates?status&search&page&limit` | `{ items (with activeEmployees), total, statusCounts }` |
| POST | `/admin/corporates` | register body + terms + `status: "approved" \| "pending"` (default approved). Owner password optional |
| POST | `/admin/corporates/from-enquiry/:enquiryId` | converts a `WebsiteEnquiry` of type `corporate`; body overrides the pre-filled fields; closes the enquiry |
| GET | `/admin/corporates/:id` | `{ corporate, admins, departments, policies, employeeCount, pendingApprovals, openInvoices, invoicedDue }` |
| PATCH | `/admin/corporates/:id` | profile and terms |
| POST | `/admin/corporates/:id/approve` | terms (optional) |
| POST | `/admin/corporates/:id/reject` | `{ reason }` (required) |
| POST | `/admin/corporates/:id/suspend` | `{ reason }` |
| POST | `/admin/corporates/:id/reactivate` | |
| GET/POST | `/admin/corporates/:id/employees` | list / add on the company's behalf |
| PATCH | `/admin/corporates/:id/employees/:employeeId` | |
| POST | `/admin/corporates/:id/employees/import` | as 2.3 |
| GET | `/admin/corporates/:id/departments` | |
| GET | `/admin/corporates/:id/trip-requests` | |
| GET | `/admin/corporates/:id/trips` | `&format=csv` |
| GET | `/admin/corporates/:id/reports/usage` | |
| GET | `/admin/corporates/:id/ledger` | account movements |
| POST | `/admin/corporates/:id/ledger/adjust` | `{ amount, note }` (+ raises, − lowers outstanding) |
| POST | `/admin/corporates/:id/ledger/recompute` | rebuilds `currentOutstanding` from the ledger |
| GET | `/admin/corporates/:id/invoices` | |
| POST | `/admin/corporates/:id/invoices/generate` | `{ from, to, periodKey?, issue?, email? }` creates or refreshes the draft for that period |
| GET | `/admin/corporates/invoices?corporateId&status` | all invoices |
| GET | `/admin/corporates/invoices/:invoiceId` / `/pdf` | |
| POST | `/admin/corporates/invoices/:invoiceId/issue` | `{ email? }` sets `issuedAt`, `dueDate = now + paymentTermsDays` |
| POST | `/admin/corporates/invoices/:invoiceId/email` | `{ to? }` |
| POST | `/admin/corporates/invoices/:invoiceId/payments` | `{ amount, method: manual\|bank_transfer\|cheque\|upi\|cash\|razorpay, reference?, note?, paidAt? }` |
| POST | `/admin/corporates/invoices/:invoiceId/void` | `{ reason }` (only with no payments; frees its trips) |
| POST | `/admin/corporates/invoices/:invoiceId/payment-link` | Razorpay Payment Link |
| POST | `/admin/corporates/invoices/:invoiceId/payment-link/sync` | |
| GET | `/admin/corporates/aging?corporateId` | `{ buckets{current,1_30,31_60,61_90,90_plus}, totalDue, corporates[] }` |
| GET/PATCH | `/admin/corporates/settings` | see 4 |

Corporate terms fields: `creditLimit` (0 = no corporate billing), `creditGracePercent` (null = global), `paymentTermsDays`, `approvalExpiryMinutes` (null = global), `discount { type: percentage|flat, value, maxPerTrip, appliesTo[] }`, `allowedServices[]`, `allowedVehicleTypeIds[]`, `serviceLocationIds[]`, `notes`.

Invoice: `{ invoiceNumber: "CORP/2627/00001", periodFrom, periodTo, periodKey, lines[{departmentName,costCenter,trips,grossAmount,discountAmount,netAmount}], annex[{kind,refId,date,serviceType,departmentName,employeeName,employeeCode,pickup,drop,grossAmount,discountAmount,netAmount}], tripCount, subtotal, discount, netAmount, taxableAmount, tax{mode:intra|inter,percent,inclusive,cgst,sgst,igst,total}, total, amountPaid, balanceDue, status: draft|issued|partially_paid|paid|overdue|void, issuedAt, dueDate, payments[], paymentLink }`.

---

## 4. Settings (`AdminBusinessSetting.corporate`, defaults in `corporate/data/defaultCorporateSettings.js`)

| Key | Default | Effect |
|---|---|---|
| `booking_enabled` | `'1'` | Master switch for `paymentMethod: corporate`. Inert until a company is approved with a credit limit |
| `registration_enabled` | `'1'` | Public `POST /corporate/register` |
| `default_approval_expiry_minutes` | `30` | Approval window |
| `credit_grace_percent` / `credit_grace_amount` | `0` / `0` | Allowed overrun of the credit limit |
| `block_booking_when_overdue` | `'0'` | Pause billing while an invoice is overdue |
| `auto_generate_invoices` | `'0'` | Draft last month's invoices on days 1–3 of the IST month |
| `auto_issue_invoices` | `'0'` | Issue and email those drafts |
| `invoice_prefix` | `'CORP'` | Numbering `PREFIX/FY/00001`, gap-free per financial year |
| `invoice_gst_percent` | `5` | |
| `invoice_fare_includes_tax` | `'1'` | Fares are GST-inclusive (invoice total = charged amount). `'0'` adds GST on top, charged to the account on issue |
| `supplier_gstin`, `supplier_legal_name`, `supplier_address`, `invoice_footer_note` | `''` | Printed on invoices; GSTIN state code decides CGST+SGST vs IGST |
| `invite_sms_enabled`, `invite_sms_template_id`, `invite_sms_text` | off | SMS India Hub only delivers DLT templates |
| `approver_sms_enabled`, `approver_sms_template_id`, `approver_sms_text` | off | |
| `approver_email_enabled` | `'1'` | |

---

## 5. Money flow

1. Booking: policy + credit check on the billable amount; in-flight corporate rides count against the limit.
2. Completion: `recordCorporateRideCompletion` charges `billedAmount` to the company (`CorporateLedgerEntry` kind `charge`, idempotent per ride) and raises `Corporate.currentOutstanding`. Driver wallet settlement treats the ride like an online ride (earnings credited, nothing collected).
3. Month end: invoice = statement of that period's charged trips (+ rentals, below). Invoices do not change the outstanding (except the GST add-on when fares are tax-exclusive).
4. Payment recorded (manual or Razorpay link) → ledger `payment`, outstanding goes down.

**Rentals:** invoices and usage reports include completed `RentalBookingRequest`s with `corporateId` = the company and `billingMode` `corporate` (or unset), read from the raw collection because those fields are being added by the rental work. Amount = `corporateBilledAmount` if present, else `totalCost` less the corporate discount for `rental`. They are charged to the account when the invoice is generated (reference `rental:<id>`, idempotent) and stamped with `corporateInvoiceId`.

**Ledger merge note:** `corporate/services/corporateLedger.js` exports `chargeCorporateAccount({ corporateId, amount, reference })` with the same signature as the planned `payments/services/ledgerService.js`; it writes to `CorporateLedgerEntry` until that lands.
