# Pricing API (fare estimate, surge, waiting charge, promos)

For the Flutter team. All paths are under `/api/v1` (`/api` also works). Responses use the usual envelope `{ "success": true, "data": ... }`. Errors look like `{ "success": false, "message": "...", "details": null }`.

Covers SOW gap items 2.11, 4.6, 4.7, 2.16 and 1.6 (per-city surge).

---

## 1. `POST /rides/estimate` (new)

This is the fare quote to show before the rider taps **Book**. Its `fare` is the fare that `POST /rides` will book at, because both go through the same server code. Show this number. Don't compute fares in the app.

**Auth:** optional.
- With no `Authorization` header, you get an anonymous quote. Use this before login.
- With `Authorization: Bearer <user token>`, the quote is for that rider. User-specific promo checks also run: user-only codes and per-user usage limits.
- An invalid or expired token returns **401**. It does not fall back to an anonymous quote.

**Rate limit:** 60 requests per minute per rider (or per IP when anonymous). Over the limit you get **429** with a `Retry-After` header.

### Request body

| Field | Type | Required | Notes |
|---|---|---|---|
| `pickup` | `[lng, lat]` or `{lat, lng}` | yes | `{latitude, longitude}` and a GeoJSON Point also work |
| `drop` | same as `pickup` | yes | |
| `vehicleTypeIds` | `string[]` | no | Vehicles to quote. If omitted, every vehicle with an active ride Set Price for the zone, city or global is quoted. For an intercity package, it's every vehicle in the package. At most 30 vehicles. |
| `vehicleTypeId` | `string` | no | A single vehicle id, combined with `vehicleTypeIds` |
| `zone_id` | `string` | no | If omitted, the zone is found from the pickup point, as `POST /rides` does |
| `service_location_id` | `string` | no | City. If omitted, it comes from the zone |
| `transport_type` | `string` | no | Default `taxi` |
| `serviceType` | `'ride' \| 'intercity'` | no | Default `ride`. `parcel` is refused with a 400; use `POST /deliveries/quote` for parcels |
| `scheduledAt` | ISO date | no | Prices the trip for its pickup time, so night and surge windows apply at that time |
| `intercity` | `{ packageId, tripType }` | no | `tripType` is `one_way` or `round_trip`. `packageId` is the package Set Price id |
| `promo_code` | `string` | no | Shows the discount without redeeming the code |
| `estimatedDistanceMeters` / `estimatedDurationMinutes` | number | no | Used only if the server can't get a road route, the same fallback `POST /rides` uses |

```json
{
  "pickup": { "lat": 12.9716, "lng": 77.5946 },
  "drop": [77.6412, 12.9784],
  "serviceType": "ride",
  "promo_code": "FLAT50"
}
```

### Response

```json
{
  "success": true,
  "data": {
    "service_type": "ride",
    "transport_type": "taxi",
    "priced_at": "2026-10-03T14:05:00.000Z",
    "zone": { "id": "66f...", "name": "Bengaluru Central", "service_location_id": "66e..." },
    "zone_id": "66f...",
    "service_location_id": "66e...",
    "route": { "distance_meters": 8420, "duration_minutes": 24.5, "polyline": "abc~...", "provider": "google" },
    "distance_meters": 8420,
    "duration_minutes": 24.5,
    "promo_code": "FLAT50",
    "quotes": [
      {
        "vehicle": { "id": "65a...", "name": "Sedan", "icon_types": "car", "image": "https://...", "icon": "", "map_icon": "", "capacity": 4 },
        "available": true,
        "fare_source": "server",
        "fare": 187,
        "fare_breakdown": {
          "tariff": "city",
          "distanceKm": 8.42, "durationMinutes": 25,
          "baseDistanceKm": 2, "pricePerKm": 12, "pricePerMinute": 1,
          "baseFare": 50, "distanceFare": 77.04, "timeFare": 24.5,
          "surgeMultiplier": 1, "surgeAmount": 0, "surgeSource": "disabled",
          "nightCharge": 0, "isNight": false,
          "minimumFare": 0, "minimumFareAdjustment": 0,
          "subtotal": 151.54, "serviceTaxPercent": 5, "tax": 7.58,
          "total": 159,
          "timezone": "Asia/Kolkata"
        },
        "set_price_id": "66b...",
        "allowed_payment_methods": ["cash", "online"],
        "platform_fee": 0,
        "waiting": { "waiting_charge": 2, "free_waiting_before": 3 },
        "promo": {
          "eligible": true,
          "code": "FLAT50",
          "discount_type": "flat",
          "discount_amount": 50,
          "fare_before_discount": 159,
          "fare_after_discount": 109
        }
      },
      {
        "vehicle": { "id": "65b...", "name": "Auto", "icon_types": "auto", "image": "", "icon": "", "map_icon": "", "capacity": 3 },
        "available": false,
        "fare_source": "client",
        "fare": null,
        "fare_breakdown": null,
        "set_price_id": null,
        "allowed_payment_methods": ["cash", "online"],
        "platform_fee": 0,
        "waiting": null,
        "promo": { "eligible": false, "reason": "NO_SERVER_FARE", "message": "This vehicle has no server fare to discount" }
      }
    ]
  }
}
```

Notes:
- `fare_source: "server"` means `fare` is what will be charged.
- `fare_source: "client"` means the server can't price this vehicle. That happens when the vehicle has no Set Price, when an off-package outstation vehicle has no outstation rates, or when an admin has set `fare_source=client`. In that case `POST /rides` books the `fare` the app sends, as it always has.
- For an intercity package, `fare_breakdown` has a different shape: `{ tariff: "package", packageId, tripType, baseFare, roundTripMultiplier, subtotal, tax: 0, total }`.
- `fare` is in whole rupees. `fare_breakdown.total` is the same number.
- `promo` is `null` when no code was sent. If a code was sent, it's `{ eligible: false, reason, message }` or the discount preview shown above. The `reason` codes are the same as `POST /promos/validate`. **When you book with a promo, send `service_location_id`** (use `data.service_location_id` from this response). `POST /rides` requires it to apply a promo.
- `platform_fee` is the most the server will accept as `platformFee` on `POST /rides` for this fare.
- Explicitly requested vehicles that are switched off come back as `available: false, reason: "VEHICLE_UNAVAILABLE"`.

**When the estimate matches the booking:** call `POST /rides` with the same pickup, drop, vehicle and `scheduledAt`, within about 5 minutes. Pickup and drop only need to be within about 100 m of the estimate's points. In that case the booked fare matches the estimate. The route is shared through a 5-minute server cache. Re-estimate if the rider waits longer or crosses into a night or surge window, because the price can change.

**Socket events:** none.

---

## 2. Changes to existing booking flows

### `POST /rides` and socket booking
The request and response shapes are unchanged. Two changes:
- The trip is routed through the same cache as the estimate.
- `ride.pricingSnapshot.fare_breakdown` may now contain `waitingMinutes`, `waitingCharge` and `totalWithWaiting` once a ride with a waiting charge completes (see section 3).

### Surge (`surgeMultiplier`, `surgeSource` in `fare_breakdown`)
Surge applies only when the admin setting `transport_ride.enable_surge_pricing = '1'`. Default is `'0'`, so `surgeSource` is `"disabled"`.

When surge is on, these sources are compared and the larger one is used. They are never added together:
- **Price Hike slots that cover this booking.** A slot with no cities and no zones applies everywhere. Otherwise it applies when the booking's city is in its `service_location_ids` or its zone is in its `zone_ids`.
- **The zone's own `peak_zone_surge_percentage`.**

`surgeSource` is one of `disabled`, `none`, `price_hike` or `zone_peak`.

---

## 3. Waiting charge on taxi and outstation rides

This only happens when `transport_ride.enable_ride_waiting_charge = '1'` (default `'0'`).

When the ride is completed (`PATCH /rides/:rideId/status` with `completed`, or the socket equivalent), the server works out:

```
waited minutes = floor((startedAt - arrivedAt) / 1 min)
charged minutes = min(max(0, waited minutes - free_waiting_before), 60)
charge = charged minutes x waiting_charge
```

- `free_waiting_before` and `waiting_charge` come from the ride's Set Price, frozen in `ride.pricingSnapshot` at booking.
- The charge is added to `ride.fare` and stored in `ride.waitingMinutes` and `ride.waitingCharge`. These fields already exist and were already returned for parcels.
- If the ride has a server fare breakdown, the charge is also written into `pricingSnapshot.fare_breakdown`.
- Rides covered by a subscription are never charged for waiting.
- Parcels work exactly as before.

Show the rider `estimate.quotes[].waiting` so they know the free minutes and the per-minute rate.

**Socket events:** no new events. The existing ride status and completion events carry the updated `fare`, `waitingMinutes` and `waitingCharge`.

---

## 4. Promo codes: flat discounts

`PromoCode` has two new fields:
- `discount_type`: `'percentage'` (default, which is how every existing code behaves) or `'flat'`.
- `discount_amount`: rupees off, used when the type is `'flat'`.

A flat discount is still limited by `maximum_discount_amount` and the cumulative cap, and it is never more than the fare.

Fields added to existing responses:
- `POST /promos/validate`:
  - `data.promo` gains `discount_type` and `discount_amount`.
  - `data.breakdown` gains `discount_type` and `discount_flat_amount`.
- `GET /promos/available`: each item gains `discount_type` and `discount_amount`.
- Admin `GET/POST /admin/promos`, `PATCH /admin/promos/:id`: request and response accept `discount_type` and `discount_amount`. A `'flat'` type needs `discount_amount > 0`.

---

## 5. Admin endpoints changed

### `GET/POST/PATCH /admin/price-hikes[/:id]` (auth: admin)
Each slot gains these fields in the request and response:
```json
{ "service_location_ids": ["66e..."], "zone_ids": ["66f..."] }
```
Both empty (the default) means the slot applies everywhere. Invalid ids are dropped. `PATCH` merges with the stored slot, so sending only `{ active }` keeps the scope.

### `GET/PATCH /admin/general-settings/transport-ride` (auth: admin)
New and newly exposed keys in `settings`:

| Key | Default | Meaning |
|---|---|---|
| `enable_surge_pricing` | `'0'` | Charge Price Hike and zone peak surge on real fares |
| `fare_source` | `'server'` | `'client'` books the fare the app sends (escape hatch) |
| `enable_ride_waiting_charge` | `'0'` | Charge waiting time on taxi and outstation rides |

### Set Prices (`/admin/types/set-prices`)
No API change. The admin form now edits `minimum_fare`, `night_charge_type` (`percentage`/`fixed`), `night_charge`, `night_start_time` and `night_end_time`, which the backend already accepted.
