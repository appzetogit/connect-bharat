import test from 'node:test';
import assert from 'node:assert/strict';

// env.js refuses to load without these; nothing here talks to Mongo or Redis.
process.env.MONGODB_URI ||= 'mongodb://127.0.0.1:27017/security-test';
process.env.JWT_SECRET ||= 'security-test-secret';
process.env.REDIS_ENABLED ||= 'false';

const {
  OTP_LOCK_MS,
  OTP_MAX_ATTEMPTS,
  buildOtpError,
  evaluateOtpAttempt,
  generateTripOtp,
  resolveTripOtpRequirements,
  safeOtpEquals,
} = await import('../src/modules/taxi/services/tripOtpService.js');
const {
  buildAdminScope,
  mergeRolePermissions,
  permissionListGrants,
  registerAdminRoutePermission,
  resolveRequiredAdminPermission,
} = await import('../src/modules/taxi/middlewares/adminPermissionMiddleware.js');
const { ADMIN_MANAGE_PERMISSIONS } = await import('../src/modules/taxi/admin/services/adminAccessService.js');
const { AUTH_ROLES, isAuthRoleRegistered, registerAuthRole } = await import('../src/modules/taxi/middlewares/authMiddleware.js');
const { clampPreAuthFolder, readPreAuthUploadCredential } = await import('../src/modules/taxi/middlewares/uploadAuthMiddleware.js');
const { redactRideOtpForDriver } = await import('../src/modules/taxi/user/routes/tripSecurityRoutes.js');
const { buildServiceLocationFilter, mergeScopeIntoQuery } = await import('../src/modules/taxi/admin/services/adminScopeService.js');

// ---- OTP compare -----------------------------------------------------------

test('safeOtpEquals matches equal codes and ignores surrounding whitespace', () => {
  assert.equal(safeOtpEquals('1234', '1234'), true);
  assert.equal(safeOtpEquals('1234', ' 12 34 '), true);
  assert.equal(safeOtpEquals(1234, '1234'), true);
});

test('safeOtpEquals rejects wrong, empty and different-length codes', () => {
  assert.equal(safeOtpEquals('1234', '1235'), false);
  assert.equal(safeOtpEquals('1234', '12345'), false);
  assert.equal(safeOtpEquals('1234', ''), false);
  assert.equal(safeOtpEquals('', ''), false);
  assert.equal(safeOtpEquals(undefined, '1234'), false);
});

test('generateTripOtp is always four digits', () => {
  for (let i = 0; i < 200; i += 1) {
    assert.match(generateTripOtp(), /^\d{4}$/);
  }
});

// ---- OTP attempts ----------------------------------------------------------

test('correct OTP verifies and resets the counter', () => {
  const now = 1_000_000;
  const outcome = evaluateOtpAttempt({ expected: '4321', provided: '4321', state: { failedAttempts: 3 }, now });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.nextState.failedAttempts, 0);
  assert.equal(outcome.nextState.lockedUntil, null);
  assert.equal(outcome.nextState.verifiedAt.getTime(), now);
});

test('missing OTP is rejected but not counted', () => {
  const outcome = evaluateOtpAttempt({ expected: '4321', provided: '', state: { failedAttempts: 2 } });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.reason, 'missing');
  assert.equal(outcome.nextState.failedAttempts, 2);
  assert.equal(outcome.attemptsRemaining, OTP_MAX_ATTEMPTS - 2);
});

test('wrong OTP counts down, then locks on the last attempt', () => {
  const now = 5_000_000;
  let state = {};
  for (let attempt = 1; attempt < OTP_MAX_ATTEMPTS; attempt += 1) {
    const outcome = evaluateOtpAttempt({ expected: '4321', provided: '0000', state, now });
    assert.equal(outcome.reason, 'mismatch');
    assert.equal(outcome.attemptsRemaining, OTP_MAX_ATTEMPTS - attempt);
    state = outcome.nextState;
  }

  const locked = evaluateOtpAttempt({ expected: '4321', provided: '0000', state, now });
  assert.equal(locked.ok, false);
  assert.equal(locked.reason, 'locked');
  assert.equal(locked.nextState.lockedUntil.getTime(), now + OTP_LOCK_MS);
  assert.equal(locked.nextState.failedAttempts, 0);
});

test('a locked ride rejects even the right OTP until the lock runs out', () => {
  const now = 10_000_000;
  const state = { failedAttempts: 0, lockedUntil: new Date(now + 60_000) };

  const during = evaluateOtpAttempt({ expected: '4321', provided: '4321', state, now });
  assert.equal(during.ok, false);
  assert.equal(during.reason, 'locked');
  assert.equal(during.retryAfterSeconds, 60);

  const after = evaluateOtpAttempt({ expected: '4321', provided: '4321', state, now: now + 61_000 });
  assert.equal(after.ok, true);
});

test('an expired lock starts the counter again from zero', () => {
  const now = 20_000_000;
  const state = { failedAttempts: 4, lockedUntil: new Date(now - 1) };
  const outcome = evaluateOtpAttempt({ expected: '4321', provided: '9999', state, now });
  assert.equal(outcome.reason, 'mismatch');
  assert.equal(outcome.nextState.failedAttempts, 1);
});

test('OTP errors never use 401 (the web client logs out on 401)', () => {
  assert.equal(buildOtpError('start', { reason: 'mismatch', attemptsRemaining: 2 }).statusCode, 422);
  assert.equal(buildOtpError('start', { reason: 'missing' }).statusCode, 400);
  const locked = buildOtpError('drop', { reason: 'locked', retryAfterSeconds: 300 });
  assert.equal(locked.statusCode, 429);
  assert.equal(locked.details.code, 'drop_otp_locked');
});

// ---- OTP gating ------------------------------------------------------------

test('everything is off with default settings', () => {
  const defaults = {
    enable_ride_start_otp_verification: '0',
    enforce_delivery_otp: '0',
    enable_delivery_otp_load: '1',
    enable_delivery_otp_unload: '1',
  };
  assert.deepEqual(resolveTripOtpRequirements({ serviceType: 'ride' }, defaults), { start: false, drop: false });
  assert.deepEqual(resolveTripOtpRequirements({ serviceType: 'parcel' }, defaults), { start: false, drop: false });
});

test('ride start OTP follows enable_ride_start_otp_verification only', () => {
  const settings = { enable_ride_start_otp_verification: '1' };
  assert.deepEqual(resolveTripOtpRequirements({ serviceType: 'ride' }, settings), { start: true, drop: false });
  assert.deepEqual(resolveTripOtpRequirements({ serviceType: 'intercity' }, settings), { start: true, drop: false });
  assert.deepEqual(resolveTripOtpRequirements({ serviceType: 'parcel' }, settings), { start: false, drop: false });
});

test('parcel OTPs need enforce_delivery_otp plus the per-stage switch', () => {
  const ride = { serviceType: 'parcel' };
  assert.deepEqual(
    resolveTripOtpRequirements(ride, { enforce_delivery_otp: '1', enable_delivery_otp_load: '1', enable_delivery_otp_unload: '1' }),
    { start: true, drop: true },
  );
  assert.deepEqual(
    resolveTripOtpRequirements(ride, { enforce_delivery_otp: '1', enable_delivery_otp_load: '0', enable_delivery_otp_unload: '1' }),
    { start: false, drop: true },
  );
});

test('driver responses lose the rider OTP only while it is enforced', () => {
  const body = { success: true, data: { results: [{ serviceType: 'ride', otp: '1234' }, { serviceType: 'parcel', otp: '5678' }] } };

  const rideOnly = redactRideOtpForDriver(body, { enable_ride_start_otp_verification: '1' });
  assert.equal(rideOnly.data.results[0].otp, '');
  assert.equal(rideOnly.data.results[1].otp, '5678');
  assert.equal(body.data.results[0].otp, '1234', 'input is not mutated');

  const off = redactRideOtpForDriver(body, {});
  assert.equal(off.data.results[0].otp, '1234');

  const delivery = redactRideOtpForDriver({ data: { otp: '1111' } }, { enforce_delivery_otp: '1', enable_delivery_otp_load: '1' }, { assumeParcel: true });
  assert.equal(delivery.data.otp, '');
});

// ---- Admin permission mapping ------------------------------------------------

test('GET maps to .view and writes map to .manage', () => {
  assert.equal(resolveRequiredAdminPermission('GET', '/users').permission, 'users.view');
  assert.equal(resolveRequiredAdminPermission('GET', '/users/abc/requests').permission, 'users.view');
  assert.equal(resolveRequiredAdminPermission('PATCH', '/users/abc').permission, 'users.manage');
  assert.equal(resolveRequiredAdminPermission('DELETE', '/drivers/abc').permission, 'drivers.manage');
  assert.equal(resolveRequiredAdminPermission('POST', '/types/set-prices').permission, 'set_prices.manage');
});

test('longest prefix wins', () => {
  assert.equal(resolveRequiredAdminPermission('POST', '/wallet/users/1/adjust').permission, 'wallet.manage');
  assert.equal(resolveRequiredAdminPermission('GET', '/owner-management/manage-owners').permission, 'owners.view');
  assert.equal(resolveRequiredAdminPermission('GET', '/owner-management/driver-needed-document').permission, 'drivers.view');
});

test('prefixes match whole segments only', () => {
  // '/users-export' must not be treated as '/users'.
  assert.equal(resolveRequiredAdminPermission('GET', '/users-export').matched, false);
  assert.equal(resolveRequiredAdminPermission('GET', '/user-subscriptions/plans/list').permission, 'users.view');
});

test('subadmin management is a single fixed key', () => {
  assert.equal(resolveRequiredAdminPermission('GET', '/admin-management/admins').permission, 'subadmins.manage');
  assert.equal(resolveRequiredAdminPermission('POST', '/roles').permission, 'subadmins.manage');
  assert.equal(resolveRequiredAdminPermission('PATCH', '/security/roles/1').permission, 'subadmins.manage');
});

test('lookups are open to read but not to write', () => {
  assert.equal(resolveRequiredAdminPermission('GET', '/types/vehicle-types/list').open, true);
  assert.equal(resolveRequiredAdminPermission('POST', '/types/vehicle-types').permission, 'vehicle_types.manage');
  assert.equal(resolveRequiredAdminPermission('GET', '/countries').open, true);
  assert.equal(resolveRequiredAdminPermission('PATCH', '/general-settings/customization').permission, 'settings.manage');
});

test('unknown paths are unmatched (allowed) until a module registers them', () => {
  assert.equal(resolveRequiredAdminPermission('GET', '/hubs').matched, false);
  registerAdminRoutePermission({ prefix: '/hubs', resource: 'hubs' });
  assert.equal(resolveRequiredAdminPermission('GET', '/hubs/1').permission, 'hubs.view');
  assert.equal(resolveRequiredAdminPermission('POST', '/hubs').permission, 'hubs.manage');
  assert.throws(() => registerAdminRoutePermission({ prefix: '/' , resource: 'x' }));
});

test('.view grants .manage only outside strict mode', () => {
  assert.equal(permissionListGrants(['users.view'], 'users.view'), true);
  assert.equal(permissionListGrants(['users.view'], 'users.manage'), true);
  assert.equal(permissionListGrants(['users.view'], 'users.manage', { strict: true }), false);
  assert.equal(permissionListGrants(['users.manage'], 'users.manage', { strict: true }), true);
  assert.equal(permissionListGrants(['drivers.view'], 'users.view'), false);
  assert.equal(permissionListGrants(['*'], 'anything.manage', { strict: true }), true);
  assert.equal(permissionListGrants([], null), true);
  // subadmins.manage has no .view twin to fall back on.
  assert.equal(permissionListGrants(['subadmins.view'], 'subadmins.manage', { strict: true }), false);
});

test('role permissions merge with the admin\'s own', () => {
  assert.deepEqual(mergeRolePermissions(['users.view'], ['drivers.view', 'users.view']), ['users.view', 'drivers.view']);
  assert.deepEqual(mergeRolePermissions(['users.view'], ['*']), ['*']);
});

test('every .view key has a .manage twin', () => {
  assert.ok(ADMIN_MANAGE_PERMISSIONS.includes('users.manage'));
  assert.ok(ADMIN_MANAGE_PERMISSIONS.includes('settings.manage'));
  assert.ok(!ADMIN_MANAGE_PERMISSIONS.some((key) => key.endsWith('.view')));
});

// ---- Admin scope -------------------------------------------------------------

test('admin scope is unrestricted for superadmins and listed for subadmins', () => {
  const superScope = buildAdminScope({ id: 'a', admin_type: 'superadmin', service_location_ids: ['x'] });
  assert.equal(superScope.unrestricted, true);
  assert.deepEqual(buildServiceLocationFilter(superScope), {});

  const subScope = buildAdminScope({ id: 'b', admin_type: 'subadmin', service_location_ids: ['l1', 'l2'], zone_ids: ['z1'] });
  assert.equal(subScope.unrestricted, false);
  assert.deepEqual(subScope.service_location_ids, ['l1', 'l2']);
  assert.deepEqual(buildServiceLocationFilter(subScope), { service_location_id: { $in: ['l1', 'l2'] } });

  const empty = buildAdminScope({ id: 'c', admin_type: 'subadmin' });
  assert.deepEqual(buildServiceLocationFilter(empty), { service_location_id: { $in: [] } });

  // No scope at all (internal callers) means unrestricted.
  assert.deepEqual(buildServiceLocationFilter(null), {});
});

test('scope merges without clobbering an existing search $or', () => {
  const query = { deletedAt: null, $or: [{ name: 'a' }] };
  const merged = mergeScopeIntoQuery(query, { city: 'x' });
  assert.deepEqual(merged.$or, [{ name: 'a' }]);
  assert.deepEqual(merged.$and, [{ city: 'x' }]);
  assert.equal(mergeScopeIntoQuery(query, {}), query);
});

// ---- Auth roles ----------------------------------------------------------------

test('hub_manager and corporate_admin are reserved but unregistered', () => {
  assert.equal(AUTH_ROLES.HUB_MANAGER, 'hub_manager');
  assert.equal(AUTH_ROLES.CORPORATE_ADMIN, 'corporate_admin');
  assert.equal(isAuthRoleRegistered('hub_manager'), false);
});

test('registerAuthRole validates and registers a model', () => {
  const fakeModel = { findById: async () => null };
  registerAuthRole('test_role_x', fakeModel, { isActive: () => true });
  assert.equal(isAuthRoleRegistered('test_role_x'), true);
  assert.throws(() => registerAuthRole('', fakeModel));
  assert.throws(() => registerAuthRole('thing', {}));
  assert.throws(() => registerAuthRole('admin', fakeModel));
});

// ---- Upload pre-auth -------------------------------------------------------------

test('pre-auth upload credential is read from headers or body', () => {
  assert.deepEqual(readPreAuthUploadCredential({ headers: { 'x-registration-id': 'reg-1' } }), { kind: 'registration', value: 'reg-1' });
  assert.deepEqual(readPreAuthUploadCredential({ headers: {}, body: { signupPhone: '+91 98765 43210' } }), { kind: 'signup_phone', value: '9876543210' });
  assert.equal(readPreAuthUploadCredential({ headers: {}, body: {} }), null);
});

test('pre-auth uploads are confined to signup folders', () => {
  assert.equal(clampPreAuthFolder('user-profile'), 'user-profile');
  assert.equal(clampPreAuthFolder('../landing'), 'onboarding');
  assert.equal(clampPreAuthFolder(''), 'onboarding');
});
