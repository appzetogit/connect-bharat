# Admin operations API

These endpoints cover the Master Admin Panel items: manual driver assignment (2.10), the live admin feed (2.9, 2.3, 1.8), the dashboard and analytics (2.1, 2.2, 2.17), user verify and block (2.4), driver document approval (2.5), and vehicle approval (2.6).

The code is in `Backend/src/modules/taxi/admin/operations/`. The router is mounted from `admin/routes/adminRoutes.js`.

**Auth.** Every route needs an admin token: `Authorization: Bearer <admin access token>`. Each route also checks a panel permission. Super admins pass every check. A subadmin needs the permission named in each section below, and may only act on records in their assigned `service_location_ids`. Otherwise the response is `403`.

**Envelope.** A success response looks like `{ "success": true, "data": … }`. An error response looks like `{ "success": false, "message": "…", "details"?: … }`, following the existing error middleware.

The driver and rider apps call none of these routes. They only need to handle the new **socket events and push types** sent to them, which are marked **(apps)** below.

---

## Settings

Both settings live in the business settings section `customization`, set with `PATCH /admin/general-settings/customization`. Values are the strings `'1'` and `'0'`. The server caches them for 30 seconds.

| Key | Default | Effect |
|---|---|---|
| `require_verified_documents_for_approval` | `'0'` | When `'1'`, approving a driver (`PATCH /admin/drivers/:id {approve:true}` or `POST /admin/drivers/:id/approve`) returns `409` until every required document has `reviewStatus: approved`. |
| `require_vehicle_approval` | `'0'` | When `'1'`, dispatch only offers rides to drivers whose vehicle is approved. A self-owned vehicle needs `Driver.vehicleApproval.status = approved`. A fleet driver needs their assigned `FleetVehicle.status = approved`. **Before turning this on, approve the vehicles of the drivers who are already active.** Every existing driver starts with `pending`. |

---

## 1. Manual driver assignment (permission `ongoing.view`)

### GET `/admin/rides/:rideId/candidate-drivers`

Lists drivers near the pickup point, with each one's eligibility. Eligible drivers come first, then the list is sorted by distance.

Query parameters:
- `radius_km`: default 10, range 1 to 50.
- `limit`: default 30, maximum 100.
- `include_offline`: `1` also lists offline drivers.

```json
{
  "success": true,
  "data": {
    "ride": { "rideId": "…", "status": "searching", "liveStatus": "searching", "serviceType": "ride", "pickupAddress": "…", "pickup": [75.85, 22.71], "driverId": null, "...": "…" },
    "radiusKm": 10,
    "etaIsEstimate": true,
    "requireVehicleApproval": false,
    "candidates": [
      {
        "driverId": "66f…",
        "name": "Ravi",
        "phone": "98…",
        "vehicleType": "car",
        "vehicleTypeId": "65a…",
        "vehicleNumber": "MP09AB1234",
        "vehicleMake": "Maruti", "vehicleModel": "Dzire", "vehicleColor": "White",
        "rating": 4.7,
        "isOnline": true,
        "isOnRide": false,
        "lat": 22.72, "lng": 75.86,
        "distanceMeters": 1840,
        "etaMinutes": 7,
        "isCurrentDriver": false,
        "eligible": true,
        "reasons": [],
        "reasonMessages": [],
        "forceable": false
      }
    ]
  }
}
```

`etaMinutes` is an estimate: straight-line distance × 1.3 at 22 km/h. It is not a routed ETA.

Possible `reasons` values:
- `deleted`
- `not_approved`
- `blocked`
- `offline`
- `on_ride`
- `wallet_blocked`
- `vehicle_mismatch`
- `vehicle_not_approved`
- `scheduled_soon`
- `scheduled_conflict`

`forceable: true` means every reason on that driver can be overridden with `force`.

### POST `/admin/rides/:rideId/assign-driver`

Request body:

```json
{ "driverId": "66f…", "force": false }
```

- **Assign.** The ride's `status` is `searching`. The ride's dispatch is stopped, and the open offers sent to other drivers are closed.
- **Reassign.** The ride's `status` is `accepted` and its `liveStatus` is `accepted` or `arriving`. The previous driver is released (`isOnRide: false`) and notified. A trip that has already started cannot be reassigned.
- **Bidding rides** that are still searching need `force: true`.
- **What `force` overrides:** `offline`, `wallet_blocked`, `vehicle_mismatch` and `vehicle_not_approved`.
- **What it never overrides:** a deleted, unapproved or blocked driver, a driver already on a ride, or a scheduled-trip conflict.
- **Checks without `force`:** the driver's own accept checks run, including the wallet minimum.
- **Recorded on the ride:** `assignedBy: { adminId, at, mode: "manual", previousDriverId }`.

Response:

```json
{
  "success": true,
  "data": {
    "ride": { "rideId": "…", "status": "accepted", "liveStatus": "accepted", "driverId": "66f…", "assignedBy": { "adminId": "…", "at": "…", "mode": "manual" }, "...": "…" },
    "mode": "assign",
    "previousDriverId": null,
    "driverId": "66f…",
    "forced": false,
    "overriddenReasons": []
  }
}
```

Errors:
- `409` with `details: { reasons, blockingReasons, forceable }` when the driver is not eligible.
- `409` when the ride changed in the meantime: another driver accepted it, it started, or it was cancelled.
- `403` when the driver's wallet is blocked and `force` was not set.

**Events emitted.** They are the same as for a driver accepting the ride, plus a few extra:

| To | Event | Payload |
|---|---|---|
| rider (`user:<id>`) | `rideAccepted`, `ride:state` | Same as a normal accept |
| ride room `ride_<id>` | `ride:status:updated`, `rideRequestClosed`, `ride:state` | Same as a normal accept, plus a full `ride:state` |
| new driver (`driver:<id>`) **(apps)** | `rideAccepted` | Same as a normal accept |
| new driver **(apps)** | `ride:assigned` | The full `serializeRideRealtime` ride (the shape of `ride:state`) plus `assignedByAdmin: true` |
| other offered drivers **(apps)** | `rideRequestClosed` | `{ rideId, acceptedDriverId, reason: "assigned-by-admin" }`, plus the data-only push `ride_request_closed` |
| previous driver, on reassign **(apps)** | `rideRequestClosed`, `ride:reassigned` | `{ rideId, reason: "reassigned-by-admin" }` |
| admins | `admin:ride:lifecycle` | `event: "assigned"` or `"reassigned"` |

The new driver's sockets are joined to the ride room on the server side. The previous driver's sockets are removed from it. The driver app does not have to send `joinRide`, although sending it is harmless.

**Push notifications (apps):**
- Rider: `ride_accepted`, the same as a normal accept.
- New driver: `{ type: "ride_assigned", rideId, serviceType }`, with the title "New trip assigned".
- Previous driver: `{ type: "ride_reassigned", rideId }`.

---

## 2. Live admin feed

### Socket

An admin socket connects with `auth: { token }` using an admin token, and is joined to `admin:broadcast` automatically.

| Event | When | Payload |
|---|---|---|
| `admin:ride:lifecycle` | A ride is created, accepted, assigned, reassigned, changes status, is completed or is cancelled | `{ event, at, ride, cancelledBy?, reason? }` |
| `admin:driver:location` | A driver sends a location, at most once every 5 seconds per driver (both the idle and on-trip handlers) | `{ driverId, lat, lng, heading, speed, rideId, isOnRide, updatedAt }` |

`event` is one of `created`, `accepted`, `assigned`, `reassigned`, `status`, `completed` or `cancelled`. Any status change to `completed` is reported as `completed`.

`cancelledBy` is one of `user`, `driver`, `admin` or `system`. `system` means no driver was found.

The `ride` object in `admin:ride:lifecycle` looks like this:

```json
{ "rideId": "…", "serviceType": "ride|parcel|intercity", "status": "…", "liveStatus": "…", "fare": 180,
  "paymentMethod": "cash", "bookingMode": "normal", "userId": "…", "userName": "…", "driverId": "…", "driverName": "…",
  "vehicleTypeId": "…", "serviceLocationId": "…", "pickupAddress": "…", "dropAddress": "…",
  "pickup": [lng, lat], "drop": [lng, lat], "scheduledAt": null, "createdAt": "…", "acceptedAt": "…",
  "startedAt": null, "completedAt": null, "cancelledByRole": "", "assignedBy": null,
  "lastDriverLocation": { "lng": 0, "lat": 0, "heading": 90, "updatedAt": "…" } }
```

**Live tracking of one ride.** An admin socket may now emit `ride:join { rideId }`, or the older `joinRide { rideId }`, for any ride. It then receives that ride's `ride:state`, `ride:status:updated` and `ride:driver-location:updated`, unthrottled. Admins cannot send ride chat messages.

### GET `/admin/drivers/:driverId/location-history` (permission `geofencing.view`)

Returns a driver's trail for drawing a route or replaying it. Points are read from `DriverLocationHistory`, which keeps 30 days, and simplified with the Douglas-Peucker algorithm (simplify-js).

Query parameters:
- `from`, `to`: ISO dates or epoch milliseconds. The default is the last 2 hours. The range can be at most 7 days.
- `ride_id`: only the points for that ride.
- `tolerance_m`: simplification tolerance in metres. Default 5, range 0 to 200.

```json
{
  "success": true,
  "data": {
    "driverId": "…", "driverName": "Ravi", "from": "…", "to": "…", "rideId": null,
    "rawCount": 1240, "count": 212, "truncated": false, "toleranceMeters": 5,
    "distanceMeters": 18450, "startedAt": "…", "endedAt": "…",
    "points": [ { "lng": 75.85, "lat": 22.71, "at": "2026-10-03T08:01:02.000Z", "heading": 92, "speed": 8.1, "rideId": null } ]
  }
}
```

`truncated: true` means the window held more than 20,000 points and only the first 20,000 were used.

---

## 3. Dashboard and analytics (permission `dashboard.view`)

Both endpoints accept the same date parameters:
- `from`, `to`: ISO dates. A bare `YYYY-MM-DD` means that day in IST. A bare `to` date includes the whole of that day.
- The range can be at most 366 days.
- `service_location_id`: optional. A subadmin is limited to their own service locations.

### GET `/admin/dashboard/overview`

The default range is the last 30 days. Every figure comes from a Mongo aggregation.

```json
{
  "success": true,
  "data": {
    "range": { "from": "…", "to": "…", "timezone": "Asia/Kolkata" },
    "serviceLocationIds": null,
    "services": {
      "ride":      { "bookings": 120, "completed": 90, "cancelled": 25, "ongoing": 5, "revenue": 15400, "commission": 2310 },
      "parcel":    { "...": "…" },
      "intercity": { "...": "…" },
      "rental":    { "...": "…" },
      "bus":       { "...": "…" },
      "pooling":   { "...": "…" }
    },
    "totals": { "bookings": 300, "completed": 220, "cancelled": 60, "revenue": 51000, "commission": 6100 },
    "rates": { "completionRate": 78.6, "cancellationRate": 21.4, "acceptanceRate": 83.2, "paymentSuccessRate": 96.1 },
    "acceptance": { "decided": 140, "accepted": 116, "manuallyAssigned": 4 },
    "cancellationsByActor": { "user": 30, "driver": 2, "admin": 3, "system": 15, "unknown": 10 },
    "payments": {
      "byMethod": { "cash": { "count": 80, "amount": 12000 }, "online": { "count": 9, "amount": 3000 }, "wallet": { "count": 1, "amount": 400 } },
      "outcomes": { "success": 98, "failed": 4, "successRate": 96.1, "bySource": { "ride": { "success": 9, "failed": 1, "successRate": 90 } } }
    },
    "cities": [ { "serviceLocationId": "…", "name": "Indore", "bookings": 100, "completed": 80, "cancelled": 15, "revenue": 12000, "completionRate": 84.2 } ],
    "daily": [ { "date": "2026-09-04", "bookings": 10, "completed": 8, "cancelled": 2, "revenue": 1500 } ]
  }
}
```

Definitions:
- **Revenue.**
  - Ride, parcel and intercity: the completed fare.
  - Rental: `finalCharge`, or `totalCost` when there is no final charge, counted for completed bookings.
  - Bus: confirmed amount.
  - Pooling: paid fare on bookings that were not cancelled.
- **Bus and pooling** have no city. When `service_location_id` is set, they are returned as `null`.
- **`completionRate` and `cancellationRate`** are calculated over finished bookings, meaning completed plus cancelled.
- **`acceptanceRate`** covers rides, parcels and intercity only: rides that got a driver, divided by rides that are no longer searching.
- **`paymentSuccessRate`** counts settled payments only (success plus failed), and leaves out pending ones. It is `null` when there is no data.
- **`cancellationsByActor`** comes from the new `Ride.cancelledByRole` field. Rides cancelled before this release fall under `unknown`.

The old `GET /admin/dashboard/data` response keeps its shape, but now returns real values:
- `payment_success_rate` is computed from the data, and is `null` when there is none. It used to be hardcoded to `99.4`.
- `todayEarnings.by_wallet` and `overallEarnings.by_wallet` used to be `0`. They are now the completed rides paid from the wallet.

### GET `/admin/analytics/drivers`

The default range is the last 7 days.

Query parameters:
- `limit`: the size of the `top` and `bottom` lists. Default 10.
- `sort`: one of `trips`, `earnings`, `utilization`, `rating` or `online`.
- `page`, `page_size`: default page size 50.
- `min_online_minutes`: the minimum online time for a driver to appear in `bottom`. Default 60.

```json
{
  "success": true,
  "data": {
    "range": { "from": "…", "to": "…", "timezone": "Asia/Kolkata" },
    "summary": { "drivers": 420, "activeDrivers": 180, "trips": 950, "earnings": 120000, "onlineMinutes": 64000, "onTripMinutes": 21000, "utilization": 32.8 },
    "top":    [ { "driverId": "…", "name": "…", "phone": "…", "vehicleType": "car", "vehicleNumber": "…", "serviceLocationId": "…", "isOnline": true,
                  "rating": 4.8, "ratingCount": 51, "assigned": 40, "trips": 36, "cancelled": 4, "earnings": 5400, "revenue": 6300,
                  "onlineMinutes": 1800, "onTripMinutes": 720, "utilization": 40 } ],
    "bottom": [ "…same shape, lowest utilisation…" ],
    "items":  [ "…same shape, sorted by `sort`, paginated…" ],
    "pagination": { "page": 1, "pageSize": 50, "total": 180, "sort": "trips" }
  }
}
```

How each figure is calculated:
- **Online minutes:** `Driver.incentiveTracking.dailyActivity`, keyed by IST day. For today, `todaySummary.activeMinutes` is used when the log has no entry for today yet.
- **On-trip minutes:** for completed rides, `completedAt − (startedAt ?? acceptedAt)`.
- **Utilisation:** on-trip minutes divided by online minutes, capped at 100.

---

## 4. Users (permission `users.view`)

### PATCH `/admin/users/:id/verify`

Request body:

```json
{ "verified": true, "note": "Checked Aadhaar in person" }
```

The response is the user's moderation fields:

```json
{ "success": true, "data": { "id": "…", "isVerified": true, "verifiedBy": "<adminId>", "verifiedAt": "…", "verificationNote": "…",
  "active": true, "blockReason": "", "blockedAt": null, "blockedBy": null } }
```

### PATCH `/admin/users/:id/block`

Request body:

```json
{ "blocked": true, "reason": "Repeated no-shows" }
```

- `reason` is required when `blocked` is `true`.
- Blocking sets `active: false`. That is the same flag the existing toggle and the auth middleware use, so the rider's next API call returns `401`.
- Unblocking (`blocked: false`) clears the reason.
- The response has the same shape as `verify`.

**(apps)** The blocked rider's socket receives `account:blocked { reason }`.

`GET /admin/users` and `GET /admin/users/:id` now also return `isVerified` and `blockReason`.

---

## 5. Driver documents (permission `drivers.view`)

Review state is stored on each document entry in `Driver.documents[key]`, which is the same object the apps already read:

```json
"documents": {
  "drivingLicense": { "secureUrl": "…", "previewUrl": "…", "uploaded": true,
                      "reviewStatus": "rejected", "reviewReason": "Photo is blurred", "reviewedBy": "<adminId>", "reviewedAt": "…" }
}
```

`reviewStatus` is `approved`, `rejected`, or absent. Absent means pending.

### GET `/admin/drivers/:id/documents/review`

```json
{ "success": true, "data": {
  "driverId": "…", "approve": false, "status": "pending", "rejectionReason": "", "rejectedAt": null,
  "requireVerifiedDocumentsForApproval": false,
  "required": [ { "key": "aadharFront", "uploaded": true, "reviewStatus": "approved", "reviewReason": "" } ],
  "others":   [ { "key": "profilePhoto", "uploaded": true, "reviewStatus": "pending", "reviewReason": "" } ],
  "missing": [], "pending": ["aadharBack"], "rejected": [], "allApproved": false } }
```

Required keys come from the active `DriverNeededDocument` templates whose `is_required` is not `false`:
- Independent drivers use templates with account type `individual` or `both`.
- Drivers attached to a fleet owner use `fleet_drivers` or `both`.

### PATCH `/admin/drivers/:id/documents/:documentKey`

Request body:

```json
{ "status": "rejected", "reason": "Photo is blurred" }
```

- `status` is `approved` or `rejected`. `reason` is required when rejecting.
- The response is `{ driverId, documentKey, reviewStatus, reviewReason, reviewedAt, document }`.
- A document that has not been uploaded returns `404`.

**(apps)**
- The driver receives the socket event `driver:document:reviewed` with the same payload as the response.
- When a document is rejected, the driver also gets the push `{ type: "driver_document_rejected", documentKey, reason }`.
- The app should then let the driver upload that document again.

### POST `/admin/drivers/:id/approve`

- Approves the driver through the existing `updateDriver` path, so the joining bonus and the auto-subscription run as before.
- Clears `rejectionReason`.
- Returns `409` with `details: { missing, pending, rejected }` when `require_verified_documents_for_approval` is `'1'` and documents are outstanding.
- The same guard also applies to the existing `PATCH /admin/drivers/:id {approve:true}`.

### POST `/admin/drivers/:id/reject`

Request body:

```json
{ "reason": "Licence expired" }
```

- Sets `approve: false`, `status: "rejected"`, `isOnline: false`, `rejectionReason` and `rejectedAt`.
- Returns `409` if the driver is on a trip.
- The driver profile (`GET /admin/drivers/:id`) now includes `rejectionReason`.
- **(apps)** The driver receives the socket event `driver:application:rejected { driverId, reason }` and the push `{ type: "driver_application_rejected", reason }`.

---

## 6. Vehicle approval

### Self-owned vehicle (permission `drivers.view`)

- **POST `/admin/drivers/:id/vehicle/approve`**: the body is `{}`.
- **POST `/admin/drivers/:id/vehicle/reject`**: the body is `{ "reason": "RC does not match plate" }`.

The result is stored as `Driver.vehicleApproval { status, reason, reviewedBy, reviewedAt }`, which the driver profile also returns.

Response:

```json
{ "success": true, "data": { "driverId": "…", "status": "approved", "reason": "", "reviewedBy": "…", "reviewedAt": "…" } }
```

**(apps)** The driver receives the socket event `driver:vehicle:reviewed` with the same payload, and the push `driver_vehicle_approved` or `driver_vehicle_rejected`.

### Company vehicle (FleetVehicle) (permission `owners.view`)

- **POST `/admin/fleet-vehicles/:id/approve`**: the body is `{}`.
- **POST `/admin/fleet-vehicles/:id/reject`**: the body is `{ "reason": "Insurance expired" }`.

Response:

```json
{ "success": true, "data": { "id": "…", "owner_id": "…", "license_plate_number": "MP09AB1234", "status": "rejected", "reason": "Insurance expired", "reviewedBy": "…", "reviewedAt": "…" } }
```

**(apps)** Drivers assigned to this vehicle receive `driver:vehicle:reviewed { fleetVehicleId, status, reason }`. On rejection they also get the push `fleet_vehicle_rejected`.

Dispatch only filters on these statuses when `require_vehicle_approval` is `'1'`.
