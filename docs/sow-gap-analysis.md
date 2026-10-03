# SOW gap analysis — backend

Source: *Complete Custom (Android & iOS) Application* SOW (Appzeto, "Parcel + Outstation + Rental + Corporate Transport Platform").
Scope: **backend only** (`Backend/`). Mobile app screens are the Flutter team's; app items below are judged only on whether the backend API they need exists.
Paths are relative to `Backend/src/modules/taxi/`.

**Score: 98 line items — 19 Have · 46 Partial · 33 Missing.**

Legend: ✅ Have · 🟡 Partial · ❌ Missing

---

## Fix first — security / correctness bugs found during the audit

These aren't SOW items, but several SOW items can't be built correctly on top of them.

1. **Taxi and outstation fares come from the client.** `createRideRecord` trusts `fare` from the request body and only checks it isn't negative (`services/rideService.js:~1070`). The outstation fields in `SetPrice` are editable in admin but never read when a fare is computed.
2. **Ride start OTP is never verified.** `Ride.otp` is generated but `updateRideLifecycle` (`services/rideService.js:1990`) never compares it, through either REST or socket.
3. **Unauthenticated uploads:** `POST /common/upload/image` and `POST /users/profile-image` have no `authenticate`.
4. **No payment webhooks.** There is no Razorpay webhook. The PhonePe callback (`common/controllers/commonController.js:63`) only logs. If the app is killed after a capture, the payment is lost unless the client calls verify later.
5. **User wallet history is truncated** to 50 entries (`$push … $slice: -50`), so the user wallet can't serve as an audit trail.
6. **Admin RBAC is barely enforced.** `assertAdminPermission` guards only about 9 resources. Users, trips, dashboard, wallet, reports, promotions and settings are open to any subadmin. `AdminRole` is never read.
7. **Driver auth doesn't block `status:'blocked'`** (`middlewares/authMiddleware.js:79-85`), and `Driver.approve` defaults to `true`.

---

## 1. System / architecture

| # | Item | Status | Notes |
|---|---|---|---|
| 1.1 | Parcel / Outstation / Rental / Corporate services | 🟡 | Parcel and outstation are partial, rental mostly exists, corporate is absent. |
| 1.2 | Hub Panel and Corporate Panel modules | ❌ | Neither exists. Admin, user and driver APIs exist. |
| 1.5 | RBAC: Admin, Hub Manager, Corporate Admin, Driver, User | 🟡 | Roles in `authMiddleware.js:16-26` have no `hub_manager` or `corporate_admin`. Admin permissions are view-only and mostly unenforced (see bug 6). |
| 1.6 | Multi-city, city-wise pricing | ✅ | `ServiceLocation` → `Zone` → `SetPrice`, with a zone → city → global fallback. Gap: `PriceHike` (surge) and business settings are global, not per city. |
| 1.8 | Real-time GPS for all trips and deliveries | 🟡 | Ride and parcel tracking over socket works. Admin can't join ride rooms and no location reaches `admin:broadcast`. Bus tracking is REST-only. Pooling has no tracking. |

## 2. Master Admin Panel

| # | Item | Status | Notes |
|---|---|---|---|
| 2.1 | Real-time dashboard | 🟡 | `getDashboardData` (`admin/services/adminService.js:8625`) is polled every 60s, not pushed. Loads every ride into memory. `payment_success_rate: 99.4` is hardcoded. Counts taxi only. |
| 2.2 | Booking overview by service type | 🟡 | Separate lists for each service type. No aggregated counts or revenue by service. |
| 2.3 | Live driver tracking and status | 🟡 | Polling only, capped at 500 pins. `DriverLocationHistory` exists but no admin route reads it (no trail or replay). |
| 2.4 | User view / block / verify | 🟡 | View and block (`active`) work. **Verify is missing**: `isVerified` can't be set. No block reason. |
| 2.5 | Driver approval after doc verification | 🟡 | Approve endpoint and DL/RC third-party checks exist. Approval doesn't require verified docs. No per-document approve/reject and no rejection reason. |
| 2.6 | Vehicle approval (company and self-owned) | 🟡 | `FleetVehicle` has pending/approved/rejected, set through generic CRUD. Self-owned vehicles (inline on `Driver`) have no separate approval. |
| 2.7 | Service-wise commission | ✅ | On `SetPrice`, `BusService`, pooling and `ServiceStore.rentalCommission`. Scattered across models, but it works. |
| 2.8 | Advance payment rules (Outstation and Rental) | 🟡 | Rental is done (`RentalVehicleType.advancePayment`). **Outstation has none.** |
| 2.9 | Real-time booking monitoring | 🟡 | `/admin/ongoing-rides` is REST. No ride lifecycle events go to the admin socket room. |
| 2.10 | Manual driver assignment | ❌ | No endpoint. The admin web "Assign Driver" button calls `handleNotImplemented`. |
| 2.11 | Dynamic pricing: base, per-km, min, night, waiting, surge | 🟡 | Base, per-km, per-min and waiting exist. **No minimum fare, no night charge. Surge is stored but never charged.** Waiting is applied to parcels only. Depends on bug 1. |
| 2.12 | Cancellation and refund processing | 🟡 | Real Razorpay refund only for bus cancellation. Driver-cancel → user wallet credit. Admin cancel, pooling and rental do no refund. No admin refund endpoint. |
| 2.13 | Corporate account management | ❌ | Only a `WebsiteEnquiry` lead type `corporate`. |
| 2.14 | Hub creation and control | 🟡 | `ServiceStore` (rental service centres) is the closest thing. Nothing exists for parcel hubs. |
| 2.15 | Settlement and payout reports | 🟡 | Withdrawal approve only debits the wallet; no bank or RazorpayX payout. Owner withdrawals have no approve route. CSV reports are ride-only. |
| 2.16 | Promo codes and campaigns | ✅ | Full CRUD, limits, city and user scoping. Gaps: no flat-amount discount and no campaign analytics. |
| 2.17 | Revenue and performance analytics | 🟡 | Ride-only. No bus, pooling, rental or subscription revenue, no per-city rollup and no acceptance or cancellation KPIs. |

## 3. Hub Panel (parcel operations) — essentially not built

Today a parcel is **a single-driver taxi ride with a `parcel` sub-object**. `Delivery` mirrors `Ride` 1:1. There are no hubs, legs, custody, scans or tracking numbers.

| # | Item | Status | Notes |
|---|---|---|---|
| 3.1 | Secure hub login | 🟡 | The `service_center` / `service_center_staff` OTP login can serve as a template, but it is wired to rentals. |
| 3.2 | Barcode / QR scanning | ❌ | No stored AWB or tracking code. The admin list shows a computed `DEL_xxx` string. |
| 3.3 | Inbound entry and verification | ❌ | |
| 3.4 | Outbound dispatch marking | ❌ | |
| 3.5 | Hub-to-hub transfer tracking | ❌ | |
| 3.6 | Last-mile driver assignment | ❌ | Only automatic dispatch from the pickup point. |
| 3.7 | Statuses: Received / In Transit / Out for Delivery / Delivered | 🟡 | Parcels reuse the taxi status enum. None of the hub statuses exist. |
| 3.8 | Failed delivery and rescheduling | ❌ | Cancel is the only non-completed end state. |
| 3.9 | Daily hub revenue reports | ❌ | |
| 3.10 | Hub performance tracking | ❌ | |

## 4. User app — backend support

| # | Item | Status | Notes |
|---|---|---|---|
| 4.1 | OTP register/login | ✅ | `/users/auth/send-otp`, `verify-otp` |
| 4.2 | Profile management | 🟡 | `PATCH /users/me` only accepts name, email and image. Gender and DOB exist but can't be edited. |
| 4.3 | Multiple saved addresses | 🟡 | `User.addresses` schema exists, but **no endpoints** use it. |
| 4.4 | Service selection | ✅ | Taxi, delivery, intercity, rental, pooling, bus, plus `/users/app-modules` |
| 4.5 | Maps / auto-location | 🟡 | Only `/users/route` (Directions + OSRM). No geocode or places proxy. This may be fine if the app calls Google directly. |
| 4.6 | Automatic fare calculation | 🟡 | Server-side for parcels only. Taxi fare comes from the client (bug 1). |
| 4.7 | Booking preview / estimate | 🟡 | Delivery quote and rental quote exist. **No `/rides/estimate`.** |
| 4.8 | UPI / Card / NetBanking / Wallet / Cash | 🟡 | `paymentMethod` is cash or online. Online goes through Razorpay Checkout. Wallet pay exists. PhonePe isn't wired for rides. |
| 4.9 | Booking history | ✅ | Per service. No date-range filter. |
| 4.10 | Real-time driver tracking | ✅ | Socket `ride:*` events, Redis adapter, Firebase RTDB mirror |
| 4.11 | In-app call / chat with driver | 🟡 | Rider-driver chat over socket exists. **No call masking** (Exotel or Twilio). |
| 4.12 | Push notifications | ✅ | FCM |
| 4.13 | Rating and feedback | 🟡 | Rider rates driver only. Driver can't rate rider. |
| 4.14 | Downloadable invoice | 🟡 | PDF is built and emailed. **No download endpoint.** No fare breakup. |
| 4.15 | SOS | 🟡 | Creates a `SafetyAlert` and notifies admins. No user emergency contacts and no SMS fan-out. |

## 5. Parcel module

| # | Item | Status | Notes |
|---|---|---|---|
| 5.1 | Same-city | ✅ | `assertIntracityDelivery`, zone tariff |
| 5.2 | Intercity | 🟡 | `deliveryScope: 'outstation'` exists, but `assertIntracityDelivery` **rejects** cross-zone bookings. No tariff. |
| 5.3 | Long-distance domestic | ❌ | Needs the hub network (section 3). |
| 5.4 | Weight and size category | 🟡 | `GoodsType` category exists. `weight` is free text. No dimensions or slabs, and weight doesn't affect price. |
| 5.5 | Fragile handling | 🟡 | Free-text instructions only. No flag or surcharge. |
| 5.6 | Express delivery | ❌ | |
| 5.7 | Scheduled pickup | 🟡 | `Ride.scheduledAt` exists, but `POST /deliveries` doesn't accept it. |
| 5.8 | Live parcel tracking | ✅ | Single leg, shared ride socket room. No public tracking link for the receiver. |
| 5.9 | OTP delivery confirmation | 🟡 | The OTP exists but is **never checked**. `enable_delivery_otp_*` settings are unused. Only a proof photo is enforced. |
| 5.10 | Parcel insurance | ❌ | |

## 6. Outstation module

Outstation is a `Ride` with `serviceType: 'intercity'` and a free-text `intercity` sub-document.

| # | Item | Status | Notes |
|---|---|---|---|
| 6.1 | One-way | 🟡 | Bookable, but `tripType` is free text and the fare comes from the client. |
| 6.2 | Round-trip | 🟡 | Only an unused `enable_outstation_round_trip` setting. No return fields. |
| 6.3 | Multi-day | ❌ | No end date, day count or driver allowance. |
| 6.4 | Mandatory advance payment | ❌ | |
| 6.5 | Auto extra-km charges | ❌ | No odometer or actual-km capture. |
| 6.6 | Dynamic waiting charges | 🟡 | Values are snapshotted but only applied to parcels. |
| 6.7 | Driver start/end confirmation | 🟡 | Timestamps only. OTP is not verified. No odometer. |
| 6.8 | Automatic final fare adjustment | ❌ | |
| 6.9 | Detailed post-trip invoice | 🟡 | Invoice shows total only, with no breakup and no intercity fields. |

## 7. Rental module

Rental is a separate stack (`RentalVehicleType`, `RentalBookingRequest`, service-centre staff). It doesn't use `Ride`.

| # | Item | Status | Notes |
|---|---|---|---|
| 7.1 | Hourly | ✅ | `pricing[].durationHours / extraHourPrice` |
| 7.2 | Daily | 🟡 | Only as a 24h package. `includedKm` / `extraKmPrice` exist but are never billed. |
| 7.3 | Corporate rental | ❌ | |
| 7.4 | Self-drive toggle | ❌ | No `selfDrive` / `withDriver` field. Self-drive is implied by the DL KYC. |
| 7.5 | Real-time availability | 🟡 | Live geofence tracking during a booking. **No inventory or overlap check.** A vehicle type is not a vehicle unit. |
| 7.6 | Security deposit | ❌ | Only the advance payment. |
| 7.7 | Rental extension | ❌ | |
| 7.8 | Damage reporting | 🟡 | Before/after inspection with photos and `damageReviewed`. No damage charge or dispute. |
| 7.9 | Automatic rental invoice | ❌ | `invoiceService` only handles `Ride`. |
| 7.10 | Admin approval | ✅ | Bookings start `pending`. Optional admin approval to end a rental. |

## 8. Corporate panel — not built

| # | Item | Status |
|---|---|---|
| 8.1 | Corporate registration + admin approval | ❌ |
| 8.2 | Employee account management | ❌ (`admin/models/Employee.js` is field-sales staff, not corporate employees) |
| 8.3 | Trip approval workflow | ❌ |
| 8.4 | Monthly credit billing | ❌ |
| 8.5 | Department-wise reporting | ❌ |
| 8.6 | Corporate discount config | ❌ |
| 8.7 | Consolidated monthly invoice | ❌ |
| 8.8 | Usage analytics dashboard | ❌ |
| 8.9 | Outstanding payment tracking | ❌ |

## 9. Driver app — backend support

| # | Item | Status | Notes |
|---|---|---|---|
| 9.1 | OTP registration | ✅ | |
| 9.2 | Document upload | ✅ | Plus DL, PAN, RC, bank and GST verification APIs |
| 9.3 | Online / offline | ✅ | |
| 9.4 | Accept / reject | ✅ | Socket only. No REST fallback. |
| 9.5 | Google Maps navigation | — | App-side |
| 9.6 | Trip start / complete | ✅ | Start OTP not verified (bug 2) |
| 9.7 | Earnings daily / weekly / monthly | 🟡 | Daily `todaySummary` only. No range aggregation. |
| 9.8 | Commission breakdown | 🟡 | Stored per ride. No aggregated endpoint. |
| 9.9 | Wallet and payout request | 🟡 | Request and approve exist. Approval debits the wallet but **no money is sent** (no RazorpayX). |
| 9.10 | Rating visibility | ✅ | |

## 10. Payment system

| # | Item | Status | Notes |
|---|---|---|---|
| 10.1 | Gateway integration | 🟡 | Razorpay (order + signature verify) and PhonePe (status poll). **No webhooks** (bug 4). The Stripe option is config only. |
| 10.2 | UPI / Card / NetBanking | 🟡 | Delegated to Razorpay Checkout, which is acceptable |
| 10.3 | In-app wallet | ✅ | `UserWallet`, driver `WalletTransaction`, owner wallet |
| 10.4 | Corporate credit billing | ❌ | |
| 10.5 | Automated refunds | 🟡 | Gateway refund for bus only. No refund queue or reconciliation. |
| 10.6 | Secure transaction ledger and reporting | ❌ | Split across 7 places, and user history is capped at 50 (bug 5) |

---

## Suggested build order

Each phase unblocks the next.

**Phase 0: foundations and bug fixes**
- Server-side fare engine: `POST /rides/estimate`, then lock the fare at booking. Add minimum fare, night charge, surge (city/zone `PriceHike`), waiting for all services, and outstation pricing from `SetPrice`.
- Verify start and delivery OTP on the server.
- Add auth to the open upload routes. Block `status:'blocked'` drivers.
- Unified `LedgerEntry` collection, plus Razorpay and PhonePe webhooks with signature checks.
- Enforce admin RBAC on every admin route. Add `hub_manager` and `corporate_admin` roles.

**Phase 1: close the Partials (small and high value)**
- Saved-address CRUD, editable profile fields, driver rates rider, invoice download with fare breakup.
- Driver earnings by date range plus commission breakdown. RazorpayX payouts.
- Admin: manual driver assignment, user verify, per-document driver approval, self-owned vehicle approval, socket push of rides and locations to admin, dashboard by service type.
- Refund service (gateway + wallet) used by every cancel path. Admin refund endpoint.
- SOS emergency contacts with SMS fan-out. Call masking (pick a provider).

**Phase 2: Outstation completion**
- Trip type enum (one-way / round / multi-day), return date, driver allowance, mandatory advance, odometer start/end, extra-km and waiting recalculation on completion.

**Phase 3: Rental completion**
- Daily rate and km billing, self-drive toggle, vehicle units + availability and overlap check, security deposit hold and refund, extension endpoint, damage charges, rental invoice.

**Phase 4: Corporate module (new)**
- `Corporate`, `CorporateEmployee`, `Department`, trip approval policy, credit limit and billing cycle, `payment_method: corporate`, monthly consolidated invoice, outstanding tracking, analytics, corporate discounts.

**Phase 5: Hub and parcel network (new, largest)**
- `Hub`, `Shipment` with a stored AWB/QR, `ShipmentLeg`, `ScanEvent` custody log, a parcel status machine (Received → In Transit → Out for Delivery → Delivered / Failed → Rescheduled / RTO), hub staff auth, last-mile assignment, intercity/long-distance tariff, weight slabs, fragile/express/insurance surcharges, scheduled pickup, hub revenue and performance reports.
