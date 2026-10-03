# Logistics API: hub parcel network

For the Flutter team (rider and driver apps) and the hub web panel. This covers SOW items 3.1–3.10, 5.2–5.8 and 5.10.

All paths below go under `/api/v1` (`/api` also works). Every response uses the usual envelope: `{ "success": true, "data": … }`, or `{ "success": false, "message": "…", "details": … }` on error.

## Which flow books a parcel?

There are two parcel flows, and they run side by side:

| Flow | When | Endpoints |
|---|---|---|
| **direct** | Same-city point-to-point. One driver picks up and delivers. Unchanged. | `POST /deliveries/quote`, `POST /deliveries` |
| **hub** | Intercity and long-distance. Also same-city when the admin sets `logistics.intracity_fulfilment = hub`. | `POST /logistics/shipments/quote`, `POST /logistics/shipments` |

Start with `POST /logistics/shipments/quote`. Its `fulfilment` field tells you which flow to use. If it says `"direct"`, call the existing `/deliveries` endpoints.

---

## 1. Direct deliveries (existing endpoints, new optional fields)

`POST /deliveries/quote` and `POST /deliveries` now accept these fields inside `parcel`. All are optional; leave them out and the request behaves exactly as it did before.

```json
"parcel": {
  "...existing fields": "...",
  "weightKg": 7.2,
  "dimensions": { "l": 30, "w": 20, "h": 15 },
  "fragile": true,
  "express": false,
  "declaredValue": 5000,
  "insurance": { "opted": true }
}
```

- **Pricing.** These fields change the fare only when the admin turns on `delivery.enable_parcel_surcharges`. It is off by default. When it is on, the quote and the booking add `tripSubtotal` and a `parcelSurcharges` object (`weightCharge`, `fragileCharge`, `expressCharge`, `insurancePremium`, `total`). Surcharges are added before service tax. The server always computes the insurance premium; any premium the app sends is ignored.
- **Scheduled pickup (5.7).** `POST /deliveries` now accepts `scheduledAt` (ISO date-time). The dispatcher waits until then before searching for a driver. Leave it out to dispatch immediately.

---

## 2. Customer (rider app), role `user`

### `POST /logistics/shipments/quote`

Before the user has entered contact details, coordinates alone are enough.

Request:
```json
{
  "sender":   { "location": [77.5946, 12.9716] },
  "receiver": { "location": [77.2090, 28.6139] },
  "weightKg": 1.2,
  "dimensions": { "l": 30, "w": 20, "h": 10 },
  "fragile": false,
  "express": true,
  "declaredValue": 3000,
  "insurance": { "opted": true },
  "paymentMethod": "online",
  "pickupMode": "pickup",
  "forceHub": false
}
```

Field rules:
- `location`: `[lng, lat]`.
- `paymentMethod`: `online`, `cash` (the sender pays at pickup or at the counter) or `cod` (the receiver pays on delivery).
- `pickupMode`: `pickup` (a driver collects from the sender) or `drop_at_hub` (the sender walks the parcel in).
- `forceHub: true`: prices a same-city parcel through the hubs anyway.

Response when `fulfilment` is `hub`:
```json
{
  "scope": "long_distance", "scopeReason": "beyond_intercity_distance",
  "fulfilment": "hub", "distanceKm": 1740.2,
  "originHub": { "id": "…", "code": "BLR01", "name": "Bengaluru Hub", "address": "…" },
  "destinationHub": { "id": "…", "code": "DEL02", "name": "Delhi Hub", "address": "…" },
  "rateCardId": "…",
  "actualWeightKg": 1.2, "volumetricWeightKg": 1.2, "chargeableWeightKg": 1.5, "billedOn": "actual",
  "sizeCategory": "small",
  "pricing": {
    "currency": "INR", "chargeableWeightKg": 1.5, "weightCharge": 90,
    "slab": { "upToKg": 2, "price": 90 }, "extraKg": 0,
    "distanceKm": 1740.2, "distanceBand": { "upToKm": 2000, "multiplier": 2, "flat": 50 }, "distanceAdjustment": 140,
    "freight": 230, "expressCharge": 115, "fragileCharge": 0, "pickupCharge": 20,
    "insurancePremium": 60, "insuranceCoverAmount": 3000, "codFee": 0,
    "subtotal": 425, "taxPercent": 18, "taxAmount": 76.5, "total": 501.5
  },
  "slaHours": 60, "estimatedDeliveryBy": "2026-10-06T08:00:00.000Z"
}
```

Response when `fulfilment` is `direct` (same city):
```json
{ "scope": "intracity", "fulfilment": "direct", "distanceKm": 8.1,
  "directDelivery": { "quoteEndpoint": "/deliveries/quote", "bookEndpoint": "/deliveries" }, "pricing": null }
```

Scope rules:
- **intracity**: same zone or same city. Also used when one end has no zone and the trip is within `intracity_max_km` (60).
- **intercity**: different cities within `intercity_max_km` (400).
- **long_distance**: anything further.

Origin and destination hubs are the nearest active hub within `hub_search_radius_km` (50). Hub type must be `origin` or `any` for the sender end, and `destination` or `any` for the receiver end.

Errors (400) in plain language:
- "No parcel hub serves the delivery location yet"
- "Parcels are not priced for … yet" (no rate card)
- "Express is not available on this route"
- "Cash on delivery is not available on this route"
- "Declared value above … cannot be insured"
- Weight over 100kg

### `GET /logistics/pickup-slots?date=YYYY-MM-DD` (public)

```json
{ "results": [ { "slot": "09:00-12:00", "date": "2026-10-04", "startsAt": "2026-10-04T03:30:00.000Z", "endsAt": "2026-10-04T06:30:00.000Z", "available": true } ] }
```

Slots are in local time (IST). A slot is marked unavailable when it starts sooner than `pickup_lead_minutes` (60) from now. The same slots are used when rescheduling a delivery.

### `GET /logistics/hubs` (public)

Lists active hubs (`id, code, name, type, address, location, operatingHours`). Use it for "drop at hub".

### `POST /logistics/shipments`

The body is the same as the quote, plus contact details. The pickup slot is optional.

```json
{
  "sender":   { "name": "Asha Rao", "phone": "9123456780", "address": "5 Brigade Rd, Bengaluru", "pincode": "560001", "landmark": "", "location": [77.6070, 12.9719] },
  "receiver": { "name": "Ravi Kumar", "phone": "9876543210", "address": "12 MG Rd, New Delhi", "pincode": "110001", "location": [77.2167, 28.6315] },
  "weightKg": 1.2, "dimensions": { "l": 30, "w": 20, "h": 10 },
  "goodsTypeId": "…", "description": "Books", "instructions": "Call before arriving",
  "fragile": false, "express": true, "declaredValue": 3000, "insurance": { "opted": true },
  "paymentMethod": "online", "pickupMode": "pickup",
  "scheduledPickup": { "date": "2026-10-04", "slot": "09:00-12:00" }
}
```

Returns 201 with `{ shipment, quote }`.
- `shipment` is the shipment object described below.
- `shipment.awb` is the tracking number. Its format is `ZB` + 3-letter city + YYMMDD + 6-digit sequence + Luhn check digit, for example `ZBBLR2610030004272`.
- If `fulfilment` would be `direct`, the response is 409 with `details.code = "USE_DIRECT_DELIVERY"`.

Online payment capture for shipments is **not wired yet**. `payment.status` stays `pending` for `online`. `cash` becomes `paid` once the parcel is picked up or received at the hub, and `cod` becomes `paid` on delivery.

### Shipment object (owner view)

```json
{
  "id": "…", "awb": "ZBBLR2610030004272", "qrPayload": "https://…/track/ZBBLR…",
  "status": "in_transit", "displayStatus": "In Transit", "scope": "long_distance",
  "sender": { "name": "…", "phone": "…", "address": "…", "landmark": "", "pincode": "", "location": [lng, lat] },
  "receiver": { "…": "…" },
  "originHub": { "id": "…", "code": "BLR01", "name": "…", "address": "…" },
  "destinationHub": { "…": "…" }, "currentHub": null,
  "pickupMode": "pickup", "distanceKm": 1740.2,
  "weightKg": 1.2, "dimensions": { "l": 30, "w": 20, "h": 10 }, "volumetricWeight": 1.2, "chargeableWeight": 1.5, "sizeCategory": "small",
  "fragile": false, "express": true, "declaredValue": 3000,
  "insurance": { "opted": true, "premium": 60, "coverAmount": 3000 },
  "scheduledPickupAt": "…", "pickupSlot": { "slot": "09:00-12:00", "startsAt": "…", "endsAt": "…" },
  "pricing": { "…": "as in the quote" },
  "payment": { "method": "online", "status": "pending", "amount": 501.5, "codCollectedAmount": 0 },
  "slaDueAt": "…", "deliveredAt": null, "reattemptAt": null,
  "attemptsCount": 0, "attempts": [ { "number": 1, "outAt": "…", "result": "failed", "reasonCode": "customer_unavailable", "at": "…" } ],
  "deliveryOtp": { "sentAt": null, "verified": false },
  "proofOfDelivery": { "photo": "", "signature": "", "receivedBy": "", "otpVerified": false, "at": null },
  "weightDiscrepancy": { "flagged": false },
  "createdAt": "…", "statusUpdatedAt": "…"
}
```

### Status values

| `status` | `displayStatus` |
|---|---|
| booked | Booked |
| pickup_scheduled | Pickup Scheduled |
| picked_up | Picked Up |
| received_at_origin_hub | **Received** |
| in_transit | **In Transit** |
| received_at_destination_hub | **Received** |
| out_for_delivery | **Out for Delivery** |
| delivered | **Delivered** |
| delivery_failed | Delivery Failed |
| reattempt_scheduled | Rescheduled |
| rto_initiated, rto_in_transit | Returning to Sender |
| rto_delivered | Returned to Sender |
| cancelled / lost / damaged | Cancelled / Lost / Damaged |

The allowed transitions are in `Backend/src/modules/taxi/logistics/services/shipmentStateMachine.js`. Show `displayStatus` to the user, but write app logic against `status`.

### Other customer endpoints

| Method | Path | Notes |
|---|---|---|
| GET | `/logistics/shipments?status=&page=&limit=` | Shipments the user booked. `{ results, total, page, limit }` |
| GET | `/logistics/shipments/:awb` | The shipment, plus `timeline` (custody log) and `liveLocation` (see tracking) |
| POST | `/logistics/shipments/:awb/cancel` | `{ "reason": "…" }`. Only while `booked` or `pickup_scheduled`. Also cancels any pickup ride |
| POST | `/logistics/shipments/:awb/reschedule` | `{ "date": "2026-10-05", "slot": "12:00-15:00" }`. Only after a failed delivery attempt. Moves to `reattempt_scheduled` |
| GET | `/logistics/shipments/:awb/label.pdf` | 4×6in printable label (Code128 + QR). Roles `user` (own shipments only), `hub_manager`, `admin` |

### `GET /logistics/track/:awb` (public, no auth, rate-limited)

Use this for the receiver's tracking link. Names, phones and addresses are masked: the address shows only its last two parts, such as city and state. No prices are shown.

```json
{
  "awb": "ZBBLR…", "status": "out_for_delivery", "displayStatus": "Out for Delivery", "scope": "long_distance",
  "sender": { "name": "A*** R**", "phone": "91******80", "address": "Bengaluru" },
  "receiver": { "name": "R*** K****", "phone": "98******10", "address": "New Delhi" },
  "originHub": { "code": "BLR01", "name": "…" }, "destinationHub": { "…": "…" }, "currentHub": null,
  "slaDueAt": "…",
  "timeline": [ { "type": "inbound", "status": "received_at_origin_hub", "displayStatus": "Received", "hub": { "code": "BLR01", "name": "…" }, "at": "…" } ],
  "liveLocation": { "legType": "last_mile", "rideStatus": "started", "coordinates": [lng, lat], "heading": 90, "updatedAt": "…", "driverFirstName": "Suresh" }
}
```

`liveLocation` is `null` unless a taxi driver is carrying the parcel on a first-mile or last-mile ride. The web panel also serves this page at `/track/:awb`. Set `logistics.tracking_base_url` to `https://<site>/track` so the label QR links to it.

### Delivery OTP (5.9)

When a shipment goes `out_for_delivery`, the server creates a 4-digit OTP and SMSes it to the receiver. This is on by default (`logistics.require_delivery_otp`).
- The OTP is stored hashed.
- The receiver gets 5 wrong attempts (`delivery_otp_max_attempts`). After that the hub must resend the OTP.
- The SMS uses the only DLT template registered so far, the generic OTP wording.

---

## 3. Driver app (taxi driver on a hub leg), role `driver`

First-mile pickups, last-mile deliveries and returns to sender are dispatched as **ordinary parcel rides**. `createRideRecord` is called with `serviceType: 'parcel'` and `fare_source: 'hub_leg'`, and `paymentMethod` is `online`, so the driver is paid through the wallet like any online parcel. The driver app needs nothing new to run one: it is offered, accepted, photographed at pickup and delivery, and completed as usual.

These rides carry extra fields in `parcel`: `shipmentAwb`, `shipmentId`, `shipmentLegId`, and `hubLegType` (`first_mile` | `last_mile` | `rto_last_mile`). When `hubLegType === 'last_mile'` and the OTP is required, the app should collect the receiver's OTP **before** completing the ride:

| Method | Path | Body | Notes |
|---|---|---|---|
| POST | `/logistics/driver/shipments/:awb/verify-otp` | `{ "otp": "1234" }` | `{ verified: true }`. 401 with the remaining attempts on a wrong code. Only the leg's driver may call it |
| POST | `/logistics/driver/shipments/:awb/fail` | `{ "reasonCode": "customer_unavailable", "note": "", "photo": "" }` | Records a failed attempt. May trigger an automatic return to sender |

What happens when the leg ride completes:
- **first_mile**: the shipment becomes `picked_up`. The hub then inbound-scans it.
- **last_mile** with the OTP verified, or the OTP not required: the shipment becomes `delivered`, and the ride's delivery photo becomes the proof of delivery.
- **last_mile** without the OTP: the shipment stays `out_for_delivery` and an exception is logged for the hub to resolve.
- **rto_last_mile**: the shipment becomes `rto_delivered`.

Socket: a manually assigned driver gets `logistics:leg:assigned` `{ rideId, awb, legType, legId }` in `driver:<id>`, along with the usual `rideAccepted`.

Reason codes: `customer_unavailable`, `wrong_address`, `refused`, `premises_closed`, `cod_not_ready`, `out_of_delivery_area`, `rescheduled_by_customer`, `damaged_in_transit`, `other` (requires `note`).

---

## 4. Hub panel API, role `hub_manager`

Every hub staff member (manager or operator) signs in and receives a JWT with role `hub_manager`. `staff.role` (`hub_manager` | `hub_operator`) controls the revenue report.
- A staff member acts for their own hub, and for any hub that lists them in `managerIds`. Pick one with `?hubId=` on any call; CORS only allows the `Authorization` and `Content-Type` headers.
- The web panel is at `/hub/login` → `/hub/dashboard`.

### Auth (no token)

| Method | Path | Body | Response |
|---|---|---|---|
| POST | `/logistics/hub/auth/send-otp` | `{ "phone": "9xxxxxxxxx" }` | `{ phone, status: "otp_sent", mode, debugOtp }`. `debugOtp` is returned outside production only |
| POST | `/logistics/hub/auth/verify-otp` | `{ "phone", "otp" }` | `{ token, role: "hub_manager", staff: { id, name, phone, email, role, hubId, hub } }` |
| POST | `/logistics/hub/auth/login` | `{ "identifier": "phone or email", "password" }` | Same as verify-otp |

The OTP is valid for 10 minutes, with 5 attempts. It is rate-limited like the driver login.

### Hub endpoints (Bearer token)

| Method | Path | Body / query | Notes |
|---|---|---|---|
| GET | `/logistics/hub/me` | | `{ staff, activeHub {id, code, name, address, type, location}, hubs[], failureReasonCodes }` |
| GET | `/logistics/hub/dashboard` | | `onHand`, `utilisationPercent`, `countsByStatus`, `pendingPickups`, `pendingOutbound`, `pendingDelivery`, `outForDelivery`, `openDriverLegs`, `failedToday`, `deliveredToday`, `expectedInbound[]` (manifests on the way) |
| GET | `/logistics/hub/shipments` | `view=on_hand\|inbound\|outbound\|delivery\|out_for_delivery\|failed\|rto\|pickups\|all`, `status`, `search` (AWB or phone), `page`, `limit` | Hub view of shipments (unmasked) |
| GET | `/logistics/hub/shipments/:awb` | | Shipment + `timeline` + `legDetails` |
| POST | `/logistics/hub/shipments` | Same body as the customer booking | Counter booking. Forced to `drop_at_hub` at this hub; starts as `received_at_origin_hub` |
| GET | `/logistics/hub/hubs` | | Other active hubs (manifest destination picker) |
| POST | `/logistics/hub/scan` | see below | **The scanner endpoint** |
| POST | `/logistics/hub/shipments/:awb/assign-leg` | `{ legType: first_mile\|last_mile\|rto_last_mile, mode: auto\|manual\|runner, driverId?, vehicleTypeId?, scheduledAt?, assignee? }` | auto = taxi dispatch; manual = the given online driver; runner = hub's own staff (`assignee {name, phone}`, last mile only; goes straight to out_for_delivery). Response `{ leg, rideId, otp (ride start OTP to give the driver), fare, fareSource }` |
| GET | `/logistics/hub/drivers/nearby` | `vehicleTypeId`, `radiusKm` | Online drivers near the hub for manual assignment |
| GET | `/logistics/hub/legs` | `status`, `type` | Open driver legs with `ride { status, liveStatus, otp, driver, location }` |
| POST | `/logistics/hub/out-for-delivery` | `{ awbs: [], assignee: {name, phone}, driverId? }` | Bulk hand-over to a runner. Per-AWB `results` |
| POST | `/logistics/hub/shipments/:awb/deliver` | `{ otp, photo?, signature?, receivedBy?, codCollectedAmount? }` | Destination hub only. The OTP is not needed for an RTO handover at the origin hub |
| POST | `/logistics/hub/shipments/:awb/fail` | `{ reasonCode, note?, photo? }` | Returns `{ shipment, autoRto, attemptsMade, maxAttempts }` |
| POST | `/logistics/hub/shipments/:awb/reschedule` | `{ date, slot, note? }` | delivery_failed → reattempt_scheduled |
| POST | `/logistics/hub/shipments/:awb/rto` | `{ reason }` | → rto_initiated |
| POST | `/logistics/hub/shipments/:awb/resend-otp` | | New OTP SMS (resets attempts) |
| GET | `/logistics/hub/manifests` | `direction=outbound\|inbound`, `status` | |
| POST | `/logistics/hub/manifests` | `{ toHubId, vehicle: {number, type}, driver: {name, phone, driverId} }` | Code `MF<HUB><YYMMDD><seq>` |
| GET | `/logistics/hub/manifests/:id` | | With `shipments[]` (and `received` per parcel) |
| POST | `/logistics/hub/manifests/:id/add` · `/remove` | `{ awb }` | Scan into / out of an unsealed manifest. `add` returns `{ manifest, warnings }` |
| POST | `/logistics/hub/manifests/:id/seal` | `{ sealNumber }` | Locks the manifest |
| POST | `/logistics/hub/manifests/:id/dispatch` | `{ vehicle?, driver? }` | Every parcel goes outbound in one step (`in_transit` / `rto_in_transit`) with a linehaul leg. Refused with `details.blocked[]` if any parcel can't go |
| POST | `/logistics/hub/manifests/:id/in-transit` | | dispatched → in_transit |
| POST | `/logistics/hub/manifests/:id/receive` | `{ awbs: [], sealNumber?, sealIntact? }` | At the receiving hub. Inbound-scans the AWBs and reconciles: `discrepancies[]` of `missing` / `extra` / `seal_mismatch` |
| POST | `/logistics/hub/manifests/:id/discrepancies/:index/resolve` | `{ note }` | |
| POST | `/logistics/hub/manifests/:id/close` | | Needs every discrepancy resolved |
| GET | `/logistics/hub/reports/revenue` | `from`, `to` (YYYY-MM-DD, local), `format=csv` | **Managers only.** Per day: `shipments, revenue, tax, insurance, prepaid, cashAtPickup, codBooked, codCollected, codShipments, chargeableKg` + `totals` |
| GET | `/logistics/hub/reports/performance` | `from`, `to` | `throughput {inbound, outbound, outForDelivery, delivered, failed}`, `dwell {averageHours, medianHours, measured, onShelf}`, `sla {measured, breached, percent}`, `failedDeliveryPercent`, `scanCompliance {departed, compliant, percent}` |

### `POST /logistics/hub/scan`

```json
{ "awb": "ZBBLR2610030004272", "type": "inbound", "weightKg": 1.6, "dimensions": { "l": 30, "w": 20, "h": 12 }, "note": "", "photo": "" }
```

The `awb` field accepts the raw AWB, the QR's tracking URL, or keyboard-wedge input with stray whitespace.

| `type` | Extra fields | Effect |
|---|---|---|
| `inbound` | `weightKg`, `dimensions` (re-weigh) | Received at origin or destination, or logged at a transit hub. A weight outside `weight_tolerance_percent` (10%) is flagged as a discrepancy |
| `outbound` | | Leaves the hub without a manifest |
| `manifest_add` / `manifest_remove` | `manifestId` | |
| `out_for_delivery` | `assignee {name, phone}`, `driverId` | Sends the OTP SMS |
| `delivered` | `otp`, `photo`, `signature`, `receivedBy`, `codCollectedAmount` | |
| `failed` | `reasonCode`, `note` | Counts an attempt. Reaching `max_delivery_attempts` (3), or a refusal when `rto_on_refusal` is on, starts a return to sender |
| `rto` | `note` | |
| `exception` | `exceptionType: lost\|damaged` | |

Response:
```json
{ "awb": "…", "type": "inbound", "fromStatus": "picked_up", "toStatus": "received_at_origin_hub", "displayStatus": "Received",
  "warnings": ["Weight discrepancy: booked 1.5kg, measured 2kg"],
  "weightCheck": { "flagged": true, "differencePercent": 33.33, "measured": { "chargeableWeightKg": 2 } },
  "deliveryOtp": { "sms": "live", "debugOtp": "1234" },
  "shipment": { "…": "…" } }
```

An invalid scan returns 409 with a human-readable reason, for example "Parcel was already received at a hub" or "This parcel has to travel to its destination hub first".

---

## 5. Admin (`/admin/logistics/*`, role `admin`, permission `deliveries.view`)

| Method | Path | Notes |
|---|---|---|
| GET / POST | `/admin/logistics/hubs` | List (with `staffCount`), or create `{ code, name, type, cityCode, address, contactPhone, location: [lng, lat], serviceLocationId, zoneId, capacity, status, operatingHours[], managerIds[] }` |
| GET / PATCH / DELETE | `/admin/logistics/hubs/:id` | DELETE deactivates a hub that has shipments instead of deleting it |
| GET | `/admin/logistics/hubs/league-table?from=&to=` | Ranked by SLA breach %, then failed-delivery %, then throughput |
| GET | `/admin/logistics/hubs/:id/performance` · `/revenue?format=csv` | |
| GET / POST | `/admin/logistics/staff?hubId=` | Create `{ hubId, name, phone, email, role: hub_manager\|hub_operator, password?, active }` |
| PATCH / DELETE | `/admin/logistics/staff/:id` | |
| GET / POST | `/admin/logistics/rate-cards?scope=&serviceLocationId=` | See the rate card shape below |
| PUT / DELETE | `/admin/logistics/rate-cards/:id` | |
| GET | `/admin/logistics/shipments?awb=&phone=&status=&hubId=&scope=&from=&to=&page=&limit=` | Search all shipments |
| GET | `/admin/logistics/shipments/:awb` | With `timeline` and `legDetails` |
| GET / PUT | `/admin/logistics/settings` | `{ logistics: {…}, delivery: {…} }` (either or both on PUT) |

Rate card shape:
```json
{ "name": "Long distance", "scope": "long_distance", "serviceLocationId": null,
  "volumetricDivisor": 5000, "weightStepKg": 0.5,
  "slabs": [ {"upToKg":0.5,"price":60}, {"upToKg":1,"price":80}, {"upToKg":2,"price":120}, {"upToKg":5,"price":220}, {"upToKg":10,"price":380} ],
  "extraPerKg": 35,
  "distanceBands": [ {"upToKm":800,"multiplier":1,"flat":0}, {"upToKm":2000,"multiplier":1.4,"flat":30} ],
  "minCharge": 0, "expressAllowed": true, "expressMultiplier": 1.5,
  "fragileSurcharge": {"type":"flat","value":40},
  "insurance": {"percent":2,"min":25,"max":2000,"maxDeclaredValue":100000},
  "codAllowed": true, "codFee": {"type":"percent","value":2,"min":30},
  "pickupCharge": 20, "taxPercent": 18, "active": true }
```

How a card is applied:
- A slab's price is the full price for a parcel up to that weight.
- Chargeable weight is the greater of actual and volumetric weight (l×w×h / divisor), rounded up to `weightStepKg`.
- A card with `serviceLocationId: null` is the fallback for every city that has no card of its own.

Admin web pages: **Parcel Network** in the sidebar (`/admin/logistics/hubs`, `rate-cards`, `shipments`, `performance`, `settings`).

---

## 6. Settings

The defaults live in `Backend/src/modules/taxi/logistics/data/defaultLogisticsSettings.js`. The settings are stored in `AdminBusinessSetting.logistics` and `AdminBusinessSetting.delivery`.

`delivery` (the direct parcel flow): `enable_parcel_surcharges` **'0'**, `free_weight_kg` '5', `per_extra_kg_charge` '0', `fragile_surcharge_type` 'flat', `fragile_surcharge_value` '0', `express_multiplier` '1', `insurance_percent` / `insurance_min` / `insurance_max` '0'.

`logistics` (the hub network):

| Setting | Default |
|---|---|
| `intracity_fulfilment` | 'direct' |
| `intracity_max_km` | '60' |
| `intercity_max_km` | '400' |
| `hub_search_radius_km` | '50' |
| `pickup_slots` | ['09:00-12:00', '12:00-15:00', '15:00-18:00', '18:00-21:00'] |
| `pickup_lead_minutes` | '60' |
| `pickup_booking_days_ahead` | '7' |
| `timezone_offset_minutes` | '330' |
| `sla_hours_intracity` / `_intercity` / `_long_distance` | '24' / '72' / '120' |
| `express_sla_factor` | '0.5' |
| `max_delivery_attempts` | '3' |
| `auto_rto_on_max_attempts` | '1' |
| `rto_on_refusal` | '1' |
| `require_delivery_otp` | '1' |
| `delivery_otp_max_attempts` | '5' |
| `weight_tolerance_percent` | '10' |
| `require_manifest_seal` | '1' |
| `leg_fallback_fare` | '80' |
| `leg_vehicle_type_id` | '' |
| `tracking_base_url` | '' |

---

## 7. Socket events

| Event | Room | Payload |
|---|---|---|
| `logistics:shipment:updated` | `user:<bookingUserId>` (riders already join it) and `hub:<hubId>` for origin, destination and current hub | `{ shipmentId, awb, status, displayStatus, fromStatus, currentHubId, hubId, scanType?, updatedAt }` |
| `logistics:manifest:updated` | `hub:<fromHubId>`, `hub:<toHubId>` | `{ manifestId, code, status, fromHubId, toHubId, count }` |
| `logistics:hub:joined` | the hub staff socket | `{ hubIds }`. Sent on connect. A hub-token socket joins `hub:<id>` for every hub it can act for |
| `logistics:leg:assigned` | `driver:<driverId>` | `{ rideId, awb, legType, legId }` (manual assignment) |

Connect with the usual `auth: { token }`. A hub token works on the same socket server.
