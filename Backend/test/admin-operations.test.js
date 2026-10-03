import test from 'node:test';
import assert from 'node:assert/strict';

// The modules under test import models and the cache, which read config at load
// time. No database is contacted by anything below.
process.env.MONGODB_URI ??= 'mongodb://127.0.0.1:27017/admin-operations-test';
process.env.JWT_SECRET ??= 'admin-operations-test';

const feed = await import('../src/modules/taxi/admin/operations/adminFeedService.js');
const docs = await import('../src/modules/taxi/admin/operations/driverDocumentReviewService.js');
const assignment = await import('../src/modules/taxi/admin/operations/manualAssignmentService.js');
const history = await import('../src/modules/taxi/admin/operations/locationHistoryService.js');
const analytics = await import('../src/modules/taxi/admin/operations/dashboardAnalyticsService.js');
const vehicles = await import('../src/modules/taxi/admin/operations/vehicleApprovalService.js');
const settings = await import('../src/modules/taxi/admin/operations/operationsSettings.js');
const access = await import('../src/modules/taxi/admin/operations/operationsAccess.js');
const users = await import('../src/modules/taxi/admin/operations/userModerationService.js');

test('keyed throttle lets one event per key through per interval', () => {
  const throttle = feed.createKeyedThrottle(5000);
  assert.equal(throttle.shouldEmit('d1', 0), true);
  assert.equal(throttle.shouldEmit('d1', 4999), false);
  assert.equal(throttle.shouldEmit('d2', 4999), true, 'other drivers are independent');
  assert.equal(throttle.shouldEmit('d1', 5000), true);
  assert.equal(throttle.shouldEmit('', 10_000), false, 'empty key never emits');
});

test('keyed throttle prunes stale keys once over capacity', () => {
  const throttle = feed.createKeyedThrottle(1000, { maxKeys: 3 });
  throttle.shouldEmit('a', 0);
  throttle.shouldEmit('b', 0);
  throttle.shouldEmit('c', 0);
  throttle.shouldEmit('d', 60_000);
  assert.equal(throttle.size(), 1);
});

test('admin feed ride summary handles populated and bare refs', () => {
  const summary = feed.serializeRideForAdminFeed({
    _id: 'r1',
    status: 'accepted',
    liveStatus: 'arriving',
    userId: { _id: 'u1', name: 'Asha' },
    driverId: 'd1',
    fare: '120',
    pickupLocation: { coordinates: [75.8, 22.7] },
    lastDriverLocation: { coordinates: [75.81, 22.71], heading: 90 },
    assignedBy: { adminId: 'a1', at: 'now' },
  });
  assert.equal(summary.rideId, 'r1');
  assert.equal(summary.userId, 'u1');
  assert.equal(summary.userName, 'Asha');
  assert.equal(summary.driverId, 'd1');
  assert.equal(summary.fare, 120);
  assert.deepEqual(summary.pickup, [75.8, 22.7]);
  assert.equal(summary.lastDriverLocation.lat, 22.71);
  assert.equal(summary.assignedBy.mode, 'manual');
  assert.equal(summary.serviceType, 'ride');
});

test('accepted-ride event name distinguishes driver accept, assign and reassign', () => {
  assert.equal(feed.lifecycleEventForAcceptedRide({}), 'accepted');
  assert.equal(feed.lifecycleEventForAcceptedRide({ assignedBy: { adminId: 'a' } }), 'assigned');
  assert.equal(feed.lifecycleEventForAcceptedRide({ assignedBy: { adminId: 'a', previousDriverId: 'd' } }), 'reassigned');
});

test('required document keys follow the templates and account type', () => {
  const templates = [
    { name: 'Aadhaar', image_type: 'front_back', front_key: 'aadharFront', back_key: 'aadharBack', is_required: true, account_type: 'individual' },
    { name: 'DL', image_type: 'image', key: 'drivingLicense', is_required: true, account_type: 'both' },
    { name: 'Optional', image_type: 'image', key: 'extra', is_required: false, account_type: 'individual' },
    { name: 'Inactive', image_type: 'image', key: 'old', is_required: true, active: false },
    { name: 'Fleet only', image_type: 'image', key: 'fleetDoc', is_required: true, account_type: 'fleet_drivers' },
    { name: 'Vehicle field', template_type: 'vehicle_field', key: 'vehicleNumber', is_required: true },
  ];
  assert.deepEqual(docs.computeRequiredDocumentKeys(templates, docs.documentAccountTypesForDriver({})), [
    'aadharFront',
    'aadharBack',
    'drivingLicense',
  ]);
  assert.deepEqual(docs.computeRequiredDocumentKeys(templates, docs.documentAccountTypesForDriver({ owner_id: 'o1' })), [
    'drivingLicense',
    'fleetDoc',
  ]);
});

test('document review summary separates missing, pending, rejected', () => {
  const summary = docs.summarizeDocumentReview(
    {
      aadharFront: { secureUrl: 'x', reviewStatus: 'approved' },
      aadharBack: 'https://legacy-string-url',
      drivingLicense: { secureUrl: 'y', reviewStatus: 'rejected', reviewReason: 'blurred' },
      selfie: { secureUrl: 'z' },
    },
    ['aadharFront', 'aadharBack', 'drivingLicense', 'pan'],
  );
  assert.deepEqual(summary.missing, ['pan']);
  assert.deepEqual(summary.pending, ['aadharBack']);
  assert.deepEqual(summary.rejected, ['drivingLicense']);
  assert.equal(summary.allApproved, false);
  assert.equal(summary.others.length, 1);
  assert.equal(summary.others[0].key, 'selfie');

  const done = docs.summarizeDocumentReview({ a: { secureUrl: 'x', reviewStatus: 'approved' } }, ['a']);
  assert.equal(done.allApproved, true);
});

test('legacy string documents become reviewable objects', () => {
  assert.deepEqual(docs.toReviewableDocument('u'), { secureUrl: 'u', previewUrl: 'u', uploaded: true });
  assert.equal(docs.toReviewableDocument(null), null);
});

test('vehicle match mirrors the accept filter', () => {
  const ride = { vehicleTypeId: 'v1', dispatchVehicleTypeIds: ['v2'] };
  assert.equal(assignment.driverMatchesRideVehicle({ vehicleTypeId: 'v1' }, ride), true);
  assert.equal(assignment.driverMatchesRideVehicle({ vehicleTypeId: 'v9', vehicleTypeIds: ['v2'] }, ride), true);
  assert.equal(assignment.driverMatchesRideVehicle({ vehicleTypeId: 'v9' }, ride), false);
  assert.equal(assignment.driverMatchesRideVehicle({ vehicleType: 'auto' }, { vehicleIconType: 'Auto' }), true);
  assert.equal(assignment.driverMatchesRideVehicle({ vehicleType: 'bike' }, { vehicleIconType: 'auto' }), false);
  assert.equal(assignment.driverMatchesRideVehicle({ vehicleType: 'bike' }, {}), true, 'a ride with no vehicle constraint matches anyone');
});

test('eligibility lists every reason and force overrides only the soft ones', () => {
  const ride = { vehicleTypeId: 'v1' };
  const offline = { isOnline: false, isOnRide: false, vehicleTypeId: 'v2', wallet: { isBlocked: true } };
  const strict = assignment.evaluateDriverEligibility({ driver: offline, ride });
  assert.equal(strict.eligible, false);
  assert.deepEqual(strict.reasons.sort(), ['offline', 'vehicle_mismatch', 'wallet_blocked']);

  const forced = assignment.evaluateDriverEligibility({ driver: offline, ride, force: true });
  assert.equal(forced.eligible, true);
  assert.deepEqual(forced.overridden.sort(), ['offline', 'vehicle_mismatch', 'wallet_blocked']);

  const busy = assignment.evaluateDriverEligibility({ driver: { isOnline: true, isOnRide: true, vehicleTypeId: 'v1' }, ride, force: true });
  assert.equal(busy.eligible, false, 'force never double-books a driver');
  assert.deepEqual(busy.blockingReasons, ['on_ride']);

  const scheduled = assignment.evaluateDriverEligibility({
    driver: { isOnline: false, isOnRide: true, vehicleTypeId: 'v1' },
    ride,
    rideIsFutureScheduled: true,
  });
  assert.equal(scheduled.eligible, true, 'a later trip does not need the driver free now');

  const fleetDriverWallet = assignment.evaluateDriverEligibility({
    driver: { isOnline: true, vehicleTypeId: 'v1', owner_id: 'o1', wallet: { isBlocked: true } },
    ride,
  });
  assert.equal(fleetDriverWallet.eligible, true, "a fleet driver's wallet block is the owner's");

  const unapprovedVehicle = assignment.evaluateDriverEligibility({
    driver: { isOnline: true, vehicleTypeId: 'v1', vehicleApproval: { status: 'pending' } },
    ride,
    requireVehicleApproval: true,
  });
  assert.deepEqual(unapprovedVehicle.reasons, ['vehicle_not_approved']);
});

test('eta estimate is positive and grows with distance', () => {
  assert.equal(assignment.estimateEtaMinutes(null), null);
  assert.equal(assignment.estimateEtaMinutes(0), 1);
  assert.ok(assignment.estimateEtaMinutes(10_000) > assignment.estimateEtaMinutes(1_000));
});

test('vehicle approval reads the fleet vehicle for fleet drivers', () => {
  assert.equal(vehicles.isDriverVehicleApproved({ vehicleApproval: { status: 'approved' } }), true);
  assert.equal(vehicles.isDriverVehicleApproved({ vehicleApproval: { status: 'pending' } }), false);
  assert.equal(vehicles.isDriverVehicleApproved({ assignedFleetVehicleId: 'f1', vehicleApproval: { status: 'approved' } }, { status: 'rejected' }), false);
  assert.equal(vehicles.isDriverVehicleApproved({ assignedFleetVehicleId: 'f1' }, { status: 'approved' }), true);
});

test('history window defaults, validation and cap', () => {
  const now = new Date('2026-10-03T10:00:00.000Z');
  const { start, end } = history.resolveHistoryWindow({}, now);
  assert.equal(end.toISOString(), now.toISOString());
  assert.equal(end - start, 2 * 60 * 60 * 1000);
  assert.throws(() => history.resolveHistoryWindow({ from: '2026-10-03', to: '2026-10-01' }, now), /before/);
  assert.throws(() => history.resolveHistoryWindow({ from: '2026-09-01', to: '2026-10-01' }, now), /7 days/);
  assert.throws(() => history.resolveHistoryWindow({ from: 'nope' }, now), /valid date/);
  const epoch = history.resolveHistoryWindow({ from: String(now.getTime() - 1000), to: String(now.getTime()) }, now);
  assert.equal(epoch.end - epoch.start, 1000);
});

test('trail simplification keeps the endpoints and corners, with timestamps', () => {
  const fixes = [];
  for (let i = 0; i <= 50; i += 1) fixes.push({ lng: 75.8 + i * 0.0001, lat: 22.7, at: `t${i}` });
  for (let i = 1; i <= 50; i += 1) fixes.push({ lng: 75.805, lat: 22.7 + i * 0.0001, at: `u${i}` });
  const simplified = history.simplifyTrail(fixes, 5);
  assert.ok(simplified.length < 10, `expected a handful of points, got ${simplified.length}`);
  assert.equal(simplified[0].at, 't0');
  assert.equal(simplified[simplified.length - 1].at, 'u50');
  assert.ok(simplified.some((fix) => fix.at === 't50'), 'the corner survives');
  assert.ok(history.totalDistanceMeters(fixes) > 1000);
});

test('rates are null without a denominator', () => {
  assert.equal(analytics.computeRate(1, 0), null);
  assert.equal(analytics.computeRate(2, 3), 66.7);
  assert.equal(analytics.computeRate(0, 5), 0);
});

test('report range: bare dates are IST days and to is inclusive', () => {
  const { start, end } = analytics.resolveReportRange({ from: '2026-10-01', to: '2026-10-02' });
  assert.equal(start.toISOString(), '2026-09-30T18:30:00.000Z');
  assert.equal(end.toISOString(), '2026-10-02T18:29:59.999Z');
  assert.throws(() => analytics.resolveReportRange({ from: '2025-01-01', to: '2026-10-01' }), /at most/);
  const fallback = analytics.resolveReportRange({}, { defaultDays: 7, now: new Date('2026-10-03T00:00:00Z') });
  assert.equal(fallback.end - fallback.start, 7 * 24 * 60 * 60 * 1000);
});

test('daily series fills quiet days with zeros', () => {
  const { start, end } = analytics.resolveReportRange({ from: '2026-10-01', to: '2026-10-03' });
  const series = analytics.fillDailySeries([{ date: '2026-10-02', bookings: 4 }], start, end, () => ({ bookings: 0 }));
  assert.deepEqual(series.map((row) => row.date), ['2026-10-01', '2026-10-02', '2026-10-03']);
  assert.deepEqual(series.map((row) => row.bookings), [0, 4, 0]);
});

test('cancellation actors bucket unknown and legacy values', () => {
  assert.deepEqual(
    analytics.bucketCancellationActors([
      { _id: 'user', count: 3 },
      { _id: '', count: 2 },
      { _id: 'system', count: 1 },
      { _id: 'weird', count: 1 },
    ]),
    { user: 3, driver: 0, admin: 0, system: 1, unknown: 3 },
  );
});

test('payment outcomes combine sources and ignore empty ones', () => {
  const result = analytics.summarizePaymentOutcomes({
    ride: { success: 9, failed: 1 },
    rental: { success: 0, failed: 0 },
  });
  assert.equal(result.success, 9);
  assert.equal(result.successRate, 90);
  assert.equal(result.bySource.rental.successRate, null);
  assert.equal(analytics.summarizePaymentOutcomes({}).successRate, null);
});

test('online minutes use the log, and today from todaySummary only when not logged yet', () => {
  const dailyActivity = [
    { date: '2026-09-30', activeMinutes: 50 },
    { date: '2026-10-01', activeMinutes: 100 },
    { date: '2026-10-02', activeMinutes: 30 },
  ];
  const base = { startKey: '2026-10-01', endKey: '2026-10-03', todayKey: '2026-10-03' };
  assert.equal(analytics.sumOnlineMinutes({ dailyActivity, todaySummary: { dateKey: '2026-10-03', activeMinutes: 20 }, ...base }), 150);
  assert.equal(
    analytics.sumOnlineMinutes({
      dailyActivity: [...dailyActivity, { date: '2026-10-03', activeMinutes: 25 }],
      todaySummary: { dateKey: '2026-10-03', activeMinutes: 20 },
      ...base,
    }),
    155,
  );
  assert.equal(analytics.sumOnlineMinutes({ dailyActivity, todaySummary: { dateKey: '2026-10-02', activeMinutes: 99 }, ...base }), 130);
});

test('utilisation is capped and null without online time', () => {
  assert.equal(analytics.computeUtilization(30, 0), null);
  assert.equal(analytics.computeUtilization(30, 120), 25);
  assert.equal(analytics.computeUtilization(200, 100), 100);
});

test('setting flags accept the panel string and boolean forms', () => {
  assert.equal(settings.isSettingEnabled('1'), true);
  assert.equal(settings.isSettingEnabled(true), true);
  assert.equal(settings.isSettingEnabled('0'), false);
  assert.equal(settings.isSettingEnabled(undefined), false);
  assert.equal(settings.isSettingEnabled('maybe'), false);
});

test('service-location filter respects subadmin scope', () => {
  const cityA = '64b7f0c2a1b2c3d4e5f60718';
  const cityB = '64b7f0c2a1b2c3d4e5f60719';
  const superAdmin = { admin_type: 'superadmin' };
  const subadmin = { admin_type: 'subadmin', service_location_ids: [cityA] };
  assert.equal(access.resolveServiceLocationFilter(superAdmin, ''), null);
  assert.deepEqual(access.resolveServiceLocationFilter(superAdmin, cityB), [cityB]);
  assert.deepEqual(access.resolveServiceLocationFilter(subadmin, ''), [cityA]);
  assert.throws(() => access.resolveServiceLocationFilter(subadmin, cityB), /outside/);
  assert.throws(() => access.resolveServiceLocationFilter(superAdmin, 'not-an-id'), /valid id/);
  assert.doesNotThrow(() => access.assertServiceLocationScope(superAdmin, null));
  assert.throws(() => access.assertServiceLocationScope(subadmin, cityB), /outside/);
  assert.doesNotThrow(() => access.assertServiceLocationScope(subadmin, cityA));
});

test('permission guard passes super admins and checks subadmins', () => {
  const guard = access.requireAdminPermission('ongoing.view');
  const run = (admin) => {
    let error = 'not-called';
    guard({ auth: { admin } }, {}, (value) => { error = value; });
    return error;
  };
  assert.equal(run({ admin_type: 'superadmin' }), undefined);
  assert.equal(run({ admin_type: 'subadmin', permissions: ['ongoing.view'] }), undefined);
  assert.equal(run({ admin_type: 'subadmin', permissions: ['users.view'] })?.statusCode, 403);
});

test('boolean flag parsing for verify/block bodies', () => {
  assert.equal(users.parseBooleanFlag(true, 'x'), true);
  assert.equal(users.parseBooleanFlag('0', 'x'), false);
  assert.equal(users.parseBooleanFlag('true', 'x'), true);
  assert.throws(() => users.parseBooleanFlag('sure', 'blocked'), /blocked must be true or false/);
  assert.throws(() => users.parseBooleanFlag(undefined, 'verified'), /verified/);
});
