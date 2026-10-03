# User and driver app APIs (SOW items 4.2, 4.3, 4.5, 4.11, 4.13, 4.14, 4.15, 6.9, 9.4, 9.7, 9.8)

For the Flutter team. All paths are served under both `/api` and `/api/v1`.
Auth is `Authorization: Bearer <accessToken>` from the existing login flows.
Every response has the usual envelope: `{ "success": true, "data": ... }`, or
`{ "success": false, "message": "...", "details": null }` with a 4xx/5xx status.

Nothing existing was renamed or removed. `GET/PATCH /users/me` are unchanged.

Dates: a plain `YYYY-MM-DD` is read as an **India (IST) calendar day**. `from`
is the start of that day and `to` is the end of it, so `to=2026-10-03` includes
the evening of the 3rd. A full ISO timestamp is used as given.

---

## 1. Profile (rider) — 4.2

### `GET /users/me/profile` — role `user`

```json
{
  "success": true,
  "data": {
    "user": {
      "id": "66f0...",
      "name": "Asha Rao",
      "phone": "9876543210",
      "countryCode": "+91",
      "email": "asha@example.com",
      "gender": "female",
      "dateOfBirth": "1994-05-01",
      "anniversary": null,
      "profileImage": "https://.../a.jpg",
      "referralCode": "ASHA12",
      "rating": 4.7,
      "ratingCount": 12,
      "addresses": [ /* same objects as GET /users/me/addresses */ ],
      "emergencyContacts": [ /* same objects as GET /users/me/emergency-contacts */ ],
      "createdAt": "2026-01-02T10:00:00.000Z"
    }
  }
}
```

`rating` is the average of the ratings drivers gave this rider; `null` while
`ratingCount` is 0.

### `PATCH /users/me/profile` — role `user`

Send only the fields you want to change.

| field | rules |
|---|---|
| `name` | 2-80 chars |
| `email` | valid email or `""` |
| `gender` | `male`, `female`, `other`, `prefer-not-to-say`, or `""` |
| `dateOfBirth` | `YYYY-MM-DD`, not in the future, at least 13 years ago. `null`/`""` clears it |
| `anniversary` | `YYYY-MM-DD`, not in the future. `null`/`""` clears it |
| `profileImage` | URL (upload first via `/common/upload/image`) |

```json
{ "gender": "female", "dateOfBirth": "1994-05-01", "anniversary": "2020-02-14" }
```

Response: same as `GET /users/me/profile`. 400 with a message on bad input.

---

## 2. Saved addresses (rider) — 4.3

Max **20** addresses. Exactly one is the default while any exist: the first
one you add becomes the default, and deleting the default promotes another.

Address object:

```json
{
  "id": "6700...",
  "label": "Home",
  "street": "12, 4th Cross, Indiranagar",
  "additionalDetails": "Flat 3B",
  "city": "Bengaluru",
  "state": "Karnataka",
  "zipCode": "560038",
  "phone": "",
  "lat": 12.9719,
  "lng": 77.6412,
  "location": { "type": "Point", "coordinates": [77.6412, 12.9719] },
  "isDefault": true,
  "createdAt": "...",
  "updatedAt": "..."
}
```

### `GET /users/me/addresses` — role `user`
`data: { results: [address...], limit: 20 }`, default first, then newest.

### `POST /users/me/addresses` — role `user`

```json
{
  "label": "Home",
  "street": "12, 4th Cross, Indiranagar",
  "additionalDetails": "Flat 3B",
  "city": "Bengaluru",
  "state": "Karnataka",
  "zipCode": "560038",
  "lat": 12.9719,
  "lng": 77.6412,
  "isDefault": false
}
```

- Required: `street`, `city`, `state`, and coordinates (`lat`+`lng`, or `location.coordinates: [lng, lat]`).
- `label`: `Home`, `Office` (also accepts `Work`), or `Other`. Default `Home`.
- `phone`: optional 10 digits.

201 → `data: { address, results }`. 400 when the limit is reached.

### `PATCH /users/me/addresses/:addressId` — role `user`
Any subset of the create fields. `isDefault: true` makes it the default.
→ `data: { address, results }`. 404 if not yours.

### `DELETE /users/me/addresses/:addressId` — role `user`
→ `data: { deleted: true, results }`.

### `POST /users/me/addresses/:addressId/default` — role `user`
No body. → `data: { address, results }`.

---

## 3. Maps proxy (rider and driver) — 4.5

Role `user` or `driver`. Rate limit 150 requests / 5 min per account
(429 `Too many map lookups...`). Results are cached server-side. If the server
has no Google key the endpoints answer **503** `Maps lookup is not configured on
the server` — fall back to the device's own geocoder. Google failures are 502.

`country` (optional, ISO-2, default `in`) restricts results to one country.

### `GET /maps/geocode?address=MG%20Road%20Bengaluru`

```json
{
  "success": true,
  "data": {
    "results": [
      {
        "placeId": "ChIJ...",
        "formattedAddress": "MG Road, Bengaluru, Karnataka 560001, India",
        "lat": 12.9756, "lng": 77.6067,
        "types": ["route"],
        "route": "MG Road", "sublocality": "", "locality": "Bengaluru",
        "city": "Bengaluru", "district": "Bangalore Urban",
        "state": "Karnataka", "country": "India", "zipCode": "560001"
      }
    ]
  }
}
```

### `GET /maps/reverse-geocode?lat=12.97&lng=77.59`
Same shape as geocode. Coordinates are rounded to ~11 m before lookup.

### `GET /maps/places/autocomplete?input=airp&lat=12.97&lng=77.59&sessiontoken=<uuid>`
Optional `radius` (metres, default 50000) when `lat`/`lng` are given.
Use one `sessiontoken` (any UUID) per search session, and pass the same token to
the details call that ends it.

```json
{
  "success": true,
  "data": {
    "predictions": [
      {
        "placeId": "ChIJ...",
        "description": "Kempegowda International Airport, Bengaluru",
        "mainText": "Kempegowda International Airport",
        "secondaryText": "Bengaluru, Karnataka, India",
        "distanceMeters": 31000,
        "types": ["airport"]
      }
    ]
  }
}
```

### `GET /maps/places/:placeId?sessiontoken=<uuid>`

```json
{
  "success": true,
  "data": {
    "placeId": "ChIJ...", "name": "Kempegowda International Airport",
    "formattedAddress": "...", "lat": 13.1986, "lng": 77.7066,
    "types": ["airport"], "city": "Bengaluru", "state": "Karnataka",
    "country": "India", "zipCode": "560300", "route": "", "sublocality": "",
    "locality": "Bengaluru", "district": "Bangalore Rural"
  }
}
```
404 when the place doesn't exist.

---

## 4. Driver rates the rider — 4.13

### `PATCH /rides/:rideId/driver-feedback` — role `driver`

Only the assigned driver, only after the ride is `completed`, only once.

```json
{ "rating": 5, "comment": "Polite, on time" }
```

`rating` integer 1-5, `comment` optional (max 500 chars).

```json
{
  "success": true,
  "data": {
    "rideId": "6701...",
    "driverFeedback": { "rating": 5, "comment": "Polite, on time", "createdAt": "..." },
    "user": { "id": "66f0...", "rating": 4.8, "ratingCount": 13 }
  }
}
```

Errors: 404 (not your ride), 409 `You can rate the rider only after the ride is
completed`, 409 `You have already rated this rider`.

**Rider rating in ride payloads.** Wherever the ride's `user` block is returned
(`GET /rides/:rideId`, `GET /rides/active/me`, socket `ride:state` payloads built
by `serializeRideRealtime`) the user object now also has `rating` and
`ratingCount`, and the serialized ride has a top-level `userRating` (number, or
`null` if never rated). The rider's own rating of the driver is unchanged
(`PATCH /rides/:rideId/feedback`).

---

## 5. Invoice — 4.14, 6.9

Rider who booked or the assigned driver; ride must be `completed` (409 otherwise).

### `GET /rides/:rideId/invoice` — role `user` or `driver`
Streams `application/pdf` with `Content-Disposition: attachment; filename="..."`.
Add `?inline=1` to get `inline` instead (for an in-app viewer).

The PDF now prints an itemised fare breakup when the ride was priced on the
server, plus an "Outstation Trip" block (from/to city, trip type, travel date,
passengers, distance) and a "Parcel" block when relevant. Older rides still
show the single "Trip Fare" line.

### `GET /rides/:rideId/invoice.json` — role `user` or `driver`
The same data for a native screen:

```json
{
  "success": true,
  "data": {
    "invoice": {
      "rideId": "6701...",
      "invoiceNumber": "INV-1A2B3C4D",
      "serviceType": "intercity",
      "status": "completed",
      "completedAt": "2026-10-03T08:15:00.000Z",
      "distanceKm": 150.2,
      "durationMinutes": 185,
      "invoiceDate": "3 October 2026",
      "company": { "name": "ZI CAB", "tagline": "...", "address": "...", "phone": "...", "email": "...", "city": "Bengaluru" },
      "trip": {
        "customerName": "Asha Rao", "customerEmail": "asha@example.com",
        "driverName": "Ravi", "vehicleNumber": "KA01AB1234",
        "pickup": "...", "drop": "...", "paymentMethod": "online"
      },
      "intercity": {
        "fromCity": "Bengaluru", "toCity": "Mysuru", "tripType": "round_trip",
        "tripTypeLabel": "Round trip", "travelDate": "2026-10-03", "passengers": 3,
        "distanceKm": 150, "vehicleName": "Sedan", "packageName": "", "bookingId": ""
      },
      "parcel": null,
      "fare": {
        "symbol": "₹", "currencySymbol": "₹",
        "tripFare": 2330, "total": 2330,
        "itemised": true,
        "items": [
          { "key": "base_fare", "label": "Base fare", "amount": 500, "kind": "charge" },
          { "key": "distance_fare", "label": "Distance (148 km)", "amount": 1500, "kind": "charge" },
          { "key": "time_fare", "label": "Time (180 min)", "amount": 100, "kind": "charge" },
          { "key": "surge", "label": "Surge (x1.1)", "amount": 50, "kind": "charge" },
          { "key": "night_charge", "label": "Night charge", "amount": 40, "kind": "charge" },
          { "key": "tax", "label": "Tax (5%)", "amount": 100, "kind": "tax" },
          { "key": "waiting_charge", "label": "Waiting (4 min)", "amount": 20, "kind": "charge" },
          { "key": "platform_fee", "label": "Platform fee", "amount": 10, "kind": "charge" },
          { "key": "promo_discount", "label": "Promo discount (SAVE10)", "amount": -30, "kind": "discount" },
          { "key": "fare_adjustment", "label": "Fare adjustment", "amount": 40, "kind": "adjustment" }
        ]
      }
    }
  }
}
```

- `items` always sum to `total` (the amount actually charged). A bid or
  rounding gap appears as a `fare_adjustment` line rather than lines that don't add up.
- Possible `key`s: `trip_fare` (old rides only), `base_fare`, `package_fare`,
  `round_trip`, `distance_fare`, `time_fare`, `surge`, `night_charge`,
  `minimum_fare_topup`, `tax`, `waiting_charge`, `platform_fee`,
  `promo_discount`, `fare_adjustment`. Render `label` as-is.
- `kind`: `charge` | `tax` | `discount` (negative) | `adjustment` (either sign).
- `parcel` (when a delivery): `{ category, weight, description, senderName, receiverName, deliveryScope, deliveredAt }`.
- `fare.symbol` may be `"Rs. "` (PDF font fallback); use `currencySymbol` in the app.
- For a driver, `trip.customerEmail` is always `""`.

---

## 6. SOS and emergency contacts — 4.15

### Rider emergency contacts — role `user`
Mirrors the driver's `/drivers/emergency-contacts`. Max **5**.

- `GET /users/me/emergency-contacts` → `data: { results: [contact...], limit: 5 }`
- `POST /users/me/emergency-contacts`
  ```json
  { "name": "Mom", "phone": "9876543210", "relation": "Mother", "source": "device" }
  ```
  `phone` is reduced to its last 10 digits and must be 10 digits. `source` is
  `manual` (default) or `device`. 201 → the contact. 409 if the number is
  already saved, 400 at the limit.
- `DELETE /users/me/emergency-contacts/:contactId` → `data: { deleted: true, results }`

Contact: `{ "id": "...", "name": "Mom", "phone": "9876543210", "relation": "Mother", "source": "device" }`

### SOS (unchanged endpoints, new side effects)
`POST /users/sos` (rider) and `POST /drivers/sos` (driver) keep their request
and response. After the alert is saved, the server, in the background (the SOS
call never waits for or fails on this):

1. **SMS** each emergency contact of whoever pressed SOS (rider's contacts above,
   or the driver's `/drivers/emergency-contacts`) with their name, phone, a
   Google Maps link to the SOS location, the trip code and the vehicle
   (colour/make/model/plate and, for a rider's SOS, the driver's name).
   **Off by default** — see settings below.
2. **Push** the fleet owner of the ride's driver (if the driver belongs to a
   fleet owner): FCM `data.type = "sos_alert"`, with `alertId`, `rideId`, `driverId`.

Each step is logged on the alert (`logs[]`, visible in the admin SOS screen).
Send `location: { lat, lng }` in the SOS body so the link points at the phone's
position rather than the pickup.

---

## 7. Masked call — 4.11

### `POST /rides/:rideId/call` — role `user` or assigned `driver`

Only while the ride is `accepted` or `ongoing` (409 otherwise). No body.
Rate limit 10 / 10 min.

When masking is **on** (Exotel configured):
```json
{ "success": true, "data": { "status": "in-progress", "provider": "exotel", "callSid": "a1b2..." } }
```
Exotel rings the **caller's own phone first**; when they answer it dials the
other party. Both see the company's ExoPhone. Show "Calling you now…".

When masking is **off** (default), or the bridge failed:
```json
{ "success": true, "data": { "status": "direct", "provider": "none", "callSid": "", "phone": "9123456789", "countryCode": "+91" } }
```
Dial `phone` directly, exactly as today. On a failed bridge `status` is
`"failed"`, `provider` is `"exotel"`, and `error` explains; `phone` is included
so the app can fall back.

Socket: the ride room receives `ride:call` → `{ rideId, initiatorRole, provider, status }`.
Every request is audited in the `TaxiRideCallLog` collection.

---

## 8. Ride chat REST fallback — 4.11

Same storage as the socket chat (`ride:message:send`), so both paths see the same thread.

### `GET /rides/:rideId/messages?limit=50&since=<ISO>` — role `user` or assigned `driver`
`limit` 1-200 (default 50, newest last). `since` returns only newer messages.

```json
{ "success": true, "data": { "results": [
  { "id": "...", "rideId": "...", "senderRole": "user", "senderId": "...", "message": "At the gate", "sentAt": "..." }
] } }
```

### `POST /rides/:rideId/messages` — role `user` or assigned `driver`
```json
{ "message": "At the gate" }
```
1-1000 chars. 201 → the saved message (same shape). Rate limit 60 / min.
Socket: emits `ride:message:new` to the ride room, identical to a socket send.

---

## 9. Driver accept / reject over REST — 9.4

Use when the socket is down. These call the same code as the socket
`acceptRide` / `rejectRide` events, with the same emits.

### `POST /drivers/ride-offers/:rideId/accept` — role `driver`
No body.

```json
{
  "success": true,
  "data": {
    "rideId": "6701...", "room": "ride_6701...",
    "status": "accepted", "liveStatus": "accepted", "acceptedAt": "...",
    "ride": { /* full serialized ride, same as ride:state */ }
  }
}
```
Errors are the existing accept errors (e.g. 409 when another driver won, wallet
or schedule conflicts) with their existing messages.

Socket side effects (same as a socket accept): rider gets `rideAccepted` and
`ride:state`; ride room gets `ride:status:updated` and `rideRequestClosed`;
other notified drivers get `rideRequestClosed`; this driver's sockets (room
`driver:<id>`) are joined to the ride room and receive `rideAccepted`,
`ride:state`, `ride:joined`.

### `POST /drivers/ride-offers/:rideId/reject` — role `driver`
No body. → `data: { rideId, driverId, rejected: true }`. 404 if the ride doesn't exist.
Socket: ride room gets `driverRejectedRide` → `{ rideId, driverId }`. The offer
stops being offered to this driver (and disappears from `GET /drivers/ride-offers`).

---

## 10. Driver earnings — 9.7, 9.8

Completed rides only, bucketed by the IST day they completed.

### `GET /drivers/earnings?range=day|week|month|custom&from=&to=` — role `driver`

- `day` (default) today; `week` Monday→today; `month` 1st→today;
  `custom` needs `from` and `to`, at most 92 days.

```json
{
  "success": true,
  "data": {
    "range": "week",
    "from": "2026-09-27T18:30:00.000Z",
    "to": "2026-10-03T18:29:59.999Z",
    "timezone": "Asia/Kolkata",
    "totals": {
      "trips": 23,
      "grossFare": 5400,
      "driverEarnings": 4320,
      "tips": 60,
      "netEarnings": 4380,
      "distanceKm": 210.4,
      "commission": { "adminCommission": 1000, "riderPlatformFee": 80, "promoDiscount": 120 },
      "paymentSplit": {
        "cash":   { "trips": 15, "amount": 3300 },
        "online": { "trips": 8,  "amount": 2100 }
      }
    },
    "daily": [
      { "date": "2026-09-28", "trips": 4, "grossFare": 900, "driverEarnings": 720, "commission": 160, "tips": 0, "netEarnings": 720 }
    ],
    "byServiceType": [
      { "serviceType": "ride", "trips": 20, "driverEarnings": 3800, "commission": 900 }
    ]
  }
}
```

`daily` has one entry per day in the range, zero-filled. `netEarnings` =
`driverEarnings` + `tips`. Amounts are what was stored on each ride at
settlement, so they match the wallet.

### `GET /drivers/earnings/rides?from=&to=&page=1&limit=20` — role `driver`
Per-ride commission breakdown, newest first. Without `from`/`to`, defaults to
this month (or pass `range=day|week|month`). `limit` max 100.

```json
{
  "success": true,
  "data": {
    "from": "...", "to": "...",
    "results": [
      {
        "rideId": "6701...", "serviceType": "ride", "paymentMethod": "cash",
        "pickupAddress": "...", "dropAddress": "...", "fromCity": "", "toCity": "",
        "completedAt": "...", "distanceKm": 8.2,
        "fare": 240,
        "commission": { "type": "percentage", "rate": 20, "amount": 48 },
        "riderPlatformFee": 5, "tax": 11.43,
        "promoCode": "", "promoDiscount": 0,
        "tip": 20, "driverEarnings": 192, "netEarnings": 212
      }
    ],
    "pagination": { "page": 1, "limit": 20, "total": 23, "totalPages": 2, "hasNextPage": true, "hasPrevPage": false }
  }
}
```

---

## 11. Ride history date filter — 4.9

`GET /rides` (role `user` or `driver`, existing endpoint) now accepts optional
`from` and `to` (booking date, `createdAt`). Without them the response is
exactly as before. 400 on an invalid date or `from` after `to`.

`GET /rides?category=outstation&from=2026-09-01&to=2026-09-30&page=1`

---

## Admin: settings

### Call masking — `GET/PATCH /admin/integration-settings/call-masking` — role `admin`

```json
{ "enabled": "1", "sid": "yourcompany1", "api_key": "...", "api_token": "...",
  "caller_id": "08047xxxxxx", "subdomain": "api.exotel.com", "time_limit": 1800 }
```
Response: `data: { settings: {... api_token masked, api_token_set: true }, active_provider: "exotel" | "none" }`.
Masking is used only when `enabled` is `"1"` and sid, api_key, api_token and
caller_id are all set. Use `api.in.exotel.com` for Exotel's Mumbai cluster.
Sending back the masked token leaves the stored token unchanged.

### SOS SMS — existing `PATCH /admin/integration-settings/sms`
New sub-section `sos_alert` (deep-merged like the rest of `sms`):

```json
{ "sos_alert": {
  "enabled": "1",
  "template_id": "<DLT template id>",
  "template_text": "SOS from {app}: {name} ({phone}) needs help. Location: {link} Trip: {trip} Vehicle: {vehicle}",
  "notify_fleet_owner": "1"
} }
```
The text must match the DLT template registered with the operator word for
word (placeholders are filled in before sending), otherwise operators drop it.
Sent through SMS India Hub with the existing `SMS_INDIA_HUB_*` credentials.

| setting | default |
|---|---|
| `exotel.enabled` | `"0"` (masking off; calls return the direct number) |
| `exotel.subdomain` | `api.exotel.com` |
| `exotel.time_limit` | `0` (Exotel default) |
| `sms.sos_alert.enabled` | `"0"` (no SOS SMS until a DLT template is configured) |
| `sms.sos_alert.notify_fleet_owner` | `"1"` |
