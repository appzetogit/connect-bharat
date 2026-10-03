# Security and trip integrity: API changes

Covers gap-analysis bugs 2, 3, 6 and 7 and items 1.5, 5.9 and 6.7: trip OTPs, upload auth, blocked drivers, driver approval, admin RBAC, city scoping, and the extensible auth roles.

All paths are relative to the API base (`/api` or `/api/v1`). Error bodies keep the existing shape, `{ success: false, message, details? }`. `details.code` is new and machine-readable.

## Settings

Every setting is a string in the `customization` section of business settings (admin: `PATCH /admin/general-settings/customization`). The server caches settings for up to 30 s, so a change can take that long to apply.

| Key | Default | Effect |
|---|---|---|
| `enable_ride_start_otp_verification` | `'0'` | `'1'`: a taxi or outstation trip can't move to `started` until the driver sends the rider's OTP. The OTP is also removed from driver REST responses. |
| `enforce_delivery_otp` | `'0'` | Master switch for parcel OTPs. While it is `'0'`, the two settings below have no effect, as before. |
| `enable_delivery_otp_load` | `'1'` (already existed) | With the master switch on, a parcel can't be `started` (picked up) without the sender's OTP (`Ride.otp`). |
| `enable_delivery_otp_unload` | `'1'` (already existed) | With the master switch on, a parcel can't be `completed` without the receiver's delivery OTP. |
| `require_driver_approval` | `'0'` | `'1'`: a driver created without an explicit `approve` value starts with `approve:false, status:'pending'`. Existing drivers are not touched. |
| `strict_admin_permissions` | `'0'` | `'0'`: a `<res>.view` permission also grants `<res>.manage`. `'1'`: writes need the `.manage` key. |
| `require_upload_auth` | `'1'` | Kill switch for upload auth. Set it to `'0'` only if a mobile build in the field can't send credentials. |

---

## 1. Start-trip OTP (rides, outstation, parcel pickup)

### `PATCH /rides/:rideId/status` (role: driver)

The request now accepts `otp` and `dropOtp`. Every other field is unchanged.

```json
{ "status": "started", "otp": "4821" }
```

```json
{ "status": "completed", "dropOtp": "7305", "paymentMethod": "cash" }
```

The server checks an OTP only when the matching setting is on:

- **`started`**: if the start OTP applies and the trip has not started yet, `otp` must equal the rider's code (`Ride.otp`). The rider app already shows this code. A repeat `started` on a trip that already started is not checked, because the web app sends it over REST and again over the socket.
- **`completed` before `started`**: if the start OTP applies, this returns 409 with `details.code: "start_otp_required"`. Without this rule a driver could skip the OTP by completing straight from `accepted`.
- **`completed` for a parcel**: if the drop OTP applies, `dropOtp` must equal the receiver's code. As a fallback, a value sent in `otp` is also accepted.

The compare runs in constant time. Each stage allows **5 wrong attempts per ride, then locks for 5 minutes**. The counter lives on the ride (`Ride.otpGuard.start|drop`), and a missing code doesn't count as an attempt.

Errors are never 401, because the web client logs the driver out on a 401:

| Status | `details.code` | Meaning |
|---|---|---|
| 400 | `start_otp_missing` / `drop_otp_missing` | No OTP sent |
| 422 | `start_otp_mismatch` / `drop_otp_mismatch` | Wrong OTP. `details.attemptsRemaining` says how many tries are left. |
| 429 | `start_otp_locked` / `drop_otp_locked` | Locked. `details.retryAfterSeconds` says when to retry. |
| 409 | `start_otp_required` | Tried to complete a trip that was never started |

```json
{
  "success": false,
  "message": "Incorrect OTP. Ask the rider for the code shown in their app",
  "details": { "code": "start_otp_mismatch", "stage": "start", "attemptsRemaining": 3, "retryAfterSeconds": null }
}
```

### Socket `ride:status:update` (driver → server)

The payload adds `otp` and `dropOtp`, with the same rules as REST:

```json
{ "rideId": "665f…", "status": "started", "otp": "4821" }
```

On failure the server emits `errorMessage` to that socket. The event now also carries `statusCode` and `details`:

```json
{ "message": "Incorrect OTP. …", "statusCode": 422, "details": { "code": "start_otp_mismatch", "attemptsRemaining": 3 } }
```

On success, the existing `ride:status:updated` and `ride:state` events are emitted to the ride room, unchanged.

### OTP removed from driver responses

When the start OTP applies, `otp` comes back as `""` in responses to driver tokens under `/rides/*`, `/deliveries/*` and `/drivers/*`. A driver app must therefore send the code the rider reads out instead of comparing it locally. Rider responses keep `otp`.

> Known gap: the socket `ride:state` broadcast goes to a room shared by the rider and the driver, so it still carries `otp`. Don't rely on the socket for secrecy. The server check is what enforces the OTP.

---

## 2. Parcel delivery OTP

- Every parcel gets a receiver code when it is created. It is stored in `Ride.parcelDropOtp`, a field marked `select: false`, so no serializer can return it.
- When the parcel moves to `started` (pickup) and the drop OTP applies, the code is sent by SMS to `parcel.receiverMobile`, once per ride. A parcel booked before this change gets a code generated at that point. If the SMS fails, the pickup still succeeds.
- The SMS goes through the existing DLT template in `smsService.sendOtpSms`, so its wording is the generic OTP template. Register a parcel-specific template if the wording matters.

### `GET /rides/:rideId/delivery-otp` (role: user, booking owner only)

Lets the sender read the receiver's code, for example to pass it on if the SMS doesn't arrive. Drivers get 403.

```json
{
  "success": true,
  "data": {
    "rideId": "665f…",
    "dropOtp": "7305",
    "required": true,
    "sentToReceiverAt": "2026-10-03T09:12:44.120Z",
    "receiverMobile": "9876543210"
  }
}
```

Errors: 404 if the ride isn't the caller's; 400 if the ride isn't a parcel.

---

## 3. Upload auth

`POST /common/upload/image` and `POST /users/profile-image` used to be open. Both now accept either of the following.

1. **A normal JWT**: `Authorization: Bearer <token>` for any app role (user, driver, owner, admin, bus_driver, pooling_driver, service_center, service_center_staff). Pending drivers and owners are allowed.
2. **A pre-token signup credential**, for screens that upload before login:
   - `X-Registration-Id: <registrationId>` (or `registrationId` in the body): a live driver or pooling onboarding session from `/drivers/onboarding/send-otp`.
   - `X-Signup-Phone: <10-digit phone>` (or `signupPhone` in the body): a rider phone verified through `/users/auth/verify-otp` within the last 10 minutes.

   Pre-token uploads are rate limited to 10 per 10 minutes per credential and 30 per 10 minutes per IP. They can only write to the folders `user-profile`, `driver-onboarding` and `onboarding`. Any other `folder` is changed to `onboarding`.

Request and response bodies are unchanged.

| Status | When |
|---|---|
| 401 `Authorization token is required` | No JWT and no signup credential |
| 401 `Signup session not found or expired…` | The signup credential is unknown or expired |
| 429 | Rate limited. A `Retry-After` header is set. |

The rider web signup screen now sends `X-Signup-Phone`. Driver onboarding documents already go through `/drivers/onboarding/documents`, which is unaffected.

---

## 4. Driver auth

- `authenticate` now returns 403 `Driver account is blocked` for a driver with `status: 'blocked'`, even on routes that allow pending drivers.
- `POST /drivers/login` and `POST /drivers/auth/verify-otp` return 403 `Driver account is blocked` for blocked drivers. Pending drivers can still sign in to see their registration status, as before.
- With `require_driver_approval = '1'`, new drivers start pending. This covers the legacy `POST /drivers/register` and any other path that doesn't set `approve` itself. Onboarding already created drivers as pending.

---

## 5. Admin RBAC

Every authenticated `/admin/*` request now goes through `middlewares/adminPermissionMiddleware.js`:

- `GET`, `HEAD` and `OPTIONS` need `<resource>.view`. Every other method needs `<resource>.manage`.
- While `strict_admin_permissions = '0'`, `.view` also grants `.manage`, so existing subadmins keep the access they have today.
- Superadmins, and admins holding `*`, bypass all checks.
- `/admin-management/*`, `/roles/*` and `/security/roles|admins/*` need `subadmins.manage` for every method.
- These are open to any admin: `/permissions`, `/countries`, `/upload-image`, `/vehicle_preference`, `/types/transport-types`, `/security/permissions`, `/security/me`, and the read-only lookups `GET /types/vehicle-types`, `/goods-types`, `/languages`, `/cancellation-reasons` and `/common/app-modules`.
- A path with no rule is allowed for any authenticated admin. Modules add rules for their own routes (see below).
- A denial returns 403 with `details: { code: 'admin_permission_denied', required: '<key>' }`.

The resource map, abbreviated (the full table is `BUILTIN_RULES` in the middleware):

| Path prefix under `/admin` | Resource |
|---|---|
| `/dashboard`, `/safety` | `dashboard` |
| `/users`, `/user-subscriptions` | `users` |
| `/drivers`, `/driver-ratings`, `/owner-management/driver-needed-document` | `drivers` |
| `/wallet`, `/payment-methods` | `wallet` |
| `/owner-management` | `owners` |
| `/trips` · `/deliveries` · `/ongoing-rides`, `/ride-requests` | `trips` · `deliveries` · `ongoing` |
| `/types/set-prices`, `/price-hikes` | `set_prices` |
| `/promotions`, `/promos`, `/banners`, `/notifications`, `/push-notifications` | `promotions` |
| `/general-settings` (writes), `/integration-settings`, `/languages`, `/preferences`, `/notification-channels`, `/cancellation-reasons`, `/common/app-modules`, `/driver-subscriptions` | `settings` |
| `/reports` · `/support`, `/careers` · `/referrals` · `/employees` · `/enquiries` · `/landing-content` | as named |
| `/service-locations` · `/zones` · `/airports` · `/service-stores` · `/types/vehicle-types` · `/goods-types` · rental · bus · pooling paths | as named |

Every `.view` key now has a `.manage` twin, for example `users.manage`. They are listed in `ADMIN_MANAGE_PERMISSIONS`.

### Roles (`AdminRole` is now enforced)

An admin's effective permissions are their own `permissions` plus those of their role. The role is looked up by the new `Admin.role_id` field, or, for older accounts, by an `Admin.role` string that matches an `AdminRole.slug`.

#### `GET /admin/security/permissions` (any admin)
```json
{ "success": true, "data": { "view": ["dashboard.view", "…"], "manage": ["dashboard.manage", "…"], "all": ["…"], "strict": false } }
```

#### `GET /admin/security/me` (any admin)
```json
{ "success": true, "data": { "id": "…", "admin_type": "subadmin", "role": "subadmin", "role_id": "66a…", "permissions": ["users.view", "drivers.view"], "scope": { "adminId": "…", "unrestricted": false, "service_location_ids": ["65f…"], "zone_ids": [] }, "strict": false } }
```

#### `GET /admin/security/roles` (`subadmins.manage`)
```json
{ "success": true, "data": [{ "id": "66a…", "name": "Operations Manager", "slug": "operations-manager", "description": "…", "permissions": ["trips.view", "ongoing.view"], "updatedAt": "…" }] }
```

#### `PATCH /admin/security/roles/:id` (`subadmins.manage`)
Body: `{ "permissions": ["trips.view", "trips.manage"], "name"?: "…", "description"?: "…" }`. The server rejects unknown keys and `*`, and returns the updated role.

#### `PATCH /admin/security/admins/:id/role` (`subadmins.manage`)
Body: `{ "role_id": "66a…" }`, or `{ "role_id": null }` to clear the role. An admin can't change their own role.
```json
{ "success": true, "data": { "id": "…", "name": "…", "email": "…", "admin_type": "subadmin", "role_id": "66a…", "role": { "id": "66a…", "permissions": ["…"] } } }
```

### City scoping

The middleware sets `req.adminScope = { adminId, unrestricted, service_location_ids, zone_ids }`. Superadmins are unrestricted. Helpers live in `admin/services/adminScopeService.js`.

Scoped so far:

- `GET /admin/users`: a subadmin sees users who have a ride in one of their service locations, or whose profile `city` names one.
- `GET /admin/dashboard/data`: counts and ride totals are limited to the subadmin's service locations, and the global dashboard cache is bypassed for them. The `live` block is still global.

Other services can opt in with `buildServiceLocationFilter(req.adminScope)` and `mergeScopeIntoQuery(query, filter)`.

### For other modules: guarding your admin routes

```js
import { registerAdminRoutePermission } from '../../middlewares/adminPermissionMiddleware.js';
registerAdminRoutePermission({ prefix: '/hubs', resource: 'hubs' });  // GET → hubs.view, writes → hubs.manage
```

Call it at module load. `prefix` is relative to `/admin`. Your routes must be served under `/admin/...` through a router mounted after `adminRouter`, so that the authenticate and RBAC middleware run first.

---

## 6. Extensible auth roles (`hub_manager`, `corporate_admin`)

`middlewares/authMiddleware.js` exports the following:

- `AUTH_ROLES`: canonical role names, including `HUB_MANAGER: 'hub_manager'` and `CORPORATE_ADMIN: 'corporate_admin'`.
- `registerAuthRole(role, model, { isActive })`: plugs a new account type into `authenticate([...roles])` without the auth file importing its model.
- `isAuthRoleRegistered(role)`.

```js
// e.g. in modules/taxi/hub/models/HubManager.js, after the model is defined
import { registerAuthRole, AUTH_ROLES } from '../../middlewares/authMiddleware.js';
registerAuthRole(AUTH_ROLES.HUB_MANAGER, HubManager, {
  // return false -> 403 "Account is inactive", or throw your own ApiError
  isActive: (entity, { allowPending }) => entity.active !== false && (allowPending || entity.status !== 'pending'),
});
```

Then sign tokens with `signAccessToken({ sub, role: 'hub_manager' })` and guard routes with `authenticate(['hub_manager'])`. Until a module registers a role, tokens with that role get 401 `Unsupported auth role`. `admin` can't be re-registered.
