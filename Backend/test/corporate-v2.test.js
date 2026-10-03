import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildInvoiceTotals,
  employeePolicyLayer,
  evaluateTripPolicy,
  mergePolicies,
  normalizeEmployeeImportRow,
  resolveEmployeeMonthlyLimit,
  rolePolicyLayer,
} from '../src/modules/taxi/corporate/services/corporatePolicyEngine.js';
import {
  checkTravelZone,
  computeCorporateDriverWalletCredit,
  computeCorporateSplit,
  computeCorporateTariffFare,
  computeRemainingKm,
  corporateCodeCandidates,
  defaultEmployeePaymentMethod,
  estimateTripKm,
  formatEmployeeCode,
  getAllowancePeriodKey,
  getIstWeekRange,
  getPreviousIstWeekRange,
  haversineKm,
  isoWeekKey,
  istMonthKey,
  normalizeEmployeeCode,
  resolveEmployeePaymentMethod,
  resolveFinalEmployeePayment,
  resolveTariffRate,
  tariffAppliesTo,
} from '../src/modules/taxi/corporate/services/corporateV2Rules.js';
import { resolveRoleAllowance } from '../src/modules/taxi/corporate/services/corporateAllowanceService.js';
import { rentalKmFromInspection } from '../src/modules/taxi/corporate/services/corporateRentalHook.js';

// --- policy merge with roles ---------------------------------------------------

test('policy merge: company -> department -> role -> employee, each overriding only what it sets', () => {
  const company = { allowedServices: ['ride', 'intercity', 'rental'], maxFarePerTrip: 1000, requireApprovalAbove: 500, allowedHours: [{ start: '08:00', end: '20:00' }] };
  const department = { maxFarePerTrip: 1500, requireApprovalAbove: null };
  const role = rolePolicyLayer({ allowedServices: ['ride'], maxFarePerTrip: 5000, requireApprovalAbove: null, requireApprovalAlways: null, allowedVehicleTypeIds: [] });
  const merged = mergePolicies(company, department, role, employeePolicyLayer({ allowedServices: [], requiresApproval: false }));
  assert.deepEqual(merged.allowedServices, ['ride']);
  assert.equal(merged.maxFarePerTrip, 5000, 'role wins over department');
  assert.equal(merged.requireApprovalAbove, 500, 'null on role inherits the company value');
  assert.equal(merged.allowedHours.length, 1);
  assert.equal(merged.requireApprovalAlways, false);

  const strict = mergePolicies(company, department, role, employeePolicyLayer({ allowedServices: ['intercity'], requiresApproval: true }));
  assert.deepEqual(strict.allowedServices, ['intercity'], 'employee list overrides the role');
  assert.equal(strict.requireApprovalAlways, true);

  // An inactive role contributes nothing; a role may say "never needs approval".
  assert.equal(mergePolicies(company, null, rolePolicyLayer({ active: false, maxFarePerTrip: 9 })).maxFarePerTrip, 1000);
  const relaxed = mergePolicies({ requireApprovalAlways: true }, null, rolePolicyLayer({ requireApprovalAlways: false }));
  assert.equal(relaxed.requireApprovalAlways, false);
});

test('role travel rules feed policy evaluation, and the role spend cap applies when the employee has none', () => {
  const policy = mergePolicies({ allowedServices: [] }, null, rolePolicyLayer({ allowedServices: ['ride'], maxFarePerTrip: 300, requireApprovalAbove: 200 }));
  const blocked = evaluateTripPolicy({ policy, trip: { serviceType: 'intercity', fare: 100 } });
  assert.equal(blocked.allowed, false);
  const approval = evaluateTripPolicy({ policy, trip: { serviceType: 'ride', fare: 250 } });
  assert.equal(approval.requiresApproval, true);
  const capped = evaluateTripPolicy({ policy, trip: { serviceType: 'ride', fare: 350 } });
  assert.equal(capped.allowed, false);

  assert.equal(resolveEmployeeMonthlyLimit({ employee: { monthlyLimit: 0 }, role: { monthlySpendLimit: 4000 } }), 4000);
  assert.equal(resolveEmployeeMonthlyLimit({ employee: { monthlyLimit: 2500 }, role: { monthlySpendLimit: 4000 } }), 2500);
  assert.equal(resolveEmployeeMonthlyLimit({ employee: {}, role: null }), 0);
});

test('role allowance is off unless the master switch and the role both say on', () => {
  const role = { allowance: { enabled: true, km: 120, period: 'weekly' } };
  assert.deepEqual(resolveRoleAllowance(role, { allowance_enabled: '1' }), { enabled: true, period: 'weekly', allowanceKm: 120 });
  assert.equal(resolveRoleAllowance(role, { allowance_enabled: '0' }).enabled, false);
  assert.equal(resolveRoleAllowance({ ...role, active: false }, { allowance_enabled: '1' }).enabled, false);
  assert.equal(resolveRoleAllowance({ allowance: { enabled: false, km: 50 } }, { allowance_enabled: '1' }).allowanceKm, 0);
});

// --- tariff ------------------------------------------------------------------

test('company tariff fare uses computeFareBreakdown arithmetic with the Set Price GST', () => {
  const tariff = {
    enabled: true,
    baseFare: 50, baseKm: 2, perKm: 12, perMinute: 1, minimumFare: 80,
    byVehicleType: [{ vehicleTypeId: 'suv', baseFare: 100, baseKm: 0, perKm: 20, perMinute: 0, minimumFare: 0 }],
    appliesTo: ['ride'],
  };
  const fare = computeCorporateTariffFare({ tariff, vehicleTypeId: 'sedan', distanceMeters: 10000, durationMinutes: 20, serviceTaxPercent: 5 });
  // 50 + 8 km x 12 + 20 min x 1 = 166, + 5% = 174.3 -> 174
  assert.equal(fare.total, 174);
  assert.equal(fare.tariff, 'corporate');
  assert.equal(fare.rateSource, 'fallback');

  const short = computeCorporateTariffFare({ tariff, vehicleTypeId: 'sedan', distanceMeters: 1000, durationMinutes: 5, serviceTaxPercent: 5 });
  assert.equal(short.total, 84, 'base covers the trip, minimum fare floor 80, + 5%');

  const suv = computeCorporateTariffFare({ tariff, vehicleTypeId: 'suv', distanceMeters: 10000, durationMinutes: 20, serviceTaxPercent: 0 });
  assert.equal(suv.total, 300);
  assert.equal(resolveTariffRate(tariff, 'suv').source, 'vehicle');

  assert.equal(tariffAppliesTo({ tariff, serviceType: 'ride' }), true);
  assert.equal(tariffAppliesTo({ tariff, serviceType: 'intercity' }), false);
  assert.equal(tariffAppliesTo({ tariff, serviceType: 'ride', masterEnabled: false }), false);
  assert.equal(tariffAppliesTo({ tariff: { ...tariff, enabled: false }, serviceType: 'ride' }), false);
  assert.equal(tariffAppliesTo({ tariff: { enabled: true, appliesTo: [] }, serviceType: 'intercity' }), true, 'default appliesTo is ride + intercity');
});

// --- boundary ----------------------------------------------------------------

test('office boundary: both_ends, either_end, free roaming and the master switch', () => {
  const office = { name: 'HQ', location: { coordinates: [77.5946, 12.9716] }, radiusKm: 5 };
  const near = [77.6, 12.98]; // ~1.2 km
  const far = [77.75, 13.1]; // ~22 km
  assert.ok(haversineKm(office.location.coordinates, near) < 2);
  assert.ok(haversineKm(office.location.coordinates, far) > 15);

  const both = { mode: 'office_boundary', rule: 'both_ends', offices: [office] };
  assert.equal(checkTravelZone({ travelZone: both, pickup: near, drop: near }).withinBoundary, true);
  assert.equal(checkTravelZone({ travelZone: both, pickup: near, drop: far }).withinBoundary, false);

  const either = { ...both, rule: 'either_end' };
  assert.equal(checkTravelZone({ travelZone: either, pickup: near, drop: far }).withinBoundary, true);
  assert.equal(checkTravelZone({ travelZone: either, pickup: far, drop: far }).withinBoundary, false);

  // Two offices: pickup near one, drop near the other.
  const second = { name: 'Plant', lat: 13.1, lng: 77.75, radiusKm: 2 };
  assert.equal(checkTravelZone({ travelZone: { ...both, offices: [office, second] }, pickup: near, drop: far }).withinBoundary, true);

  assert.equal(checkTravelZone({ travelZone: { mode: 'free_roaming' }, pickup: far, drop: far }).applies, false);
  assert.equal(checkTravelZone({ travelZone: both, pickup: far, drop: far, enabled: false }).withinBoundary, true);
});

// --- periods -----------------------------------------------------------------

test('IST period keys: monthly, ISO weekly with week 53 and year boundaries', () => {
  // 2026-10-03 (Saturday) is in ISO week 40.
  assert.equal(isoWeekKey(new Date('2026-10-03T06:00:00Z')), '2026-W40');
  // Monday 00:00 IST is Sunday 18:30 UTC: the week turns over then, not at UTC midnight.
  assert.equal(isoWeekKey(new Date('2026-10-04T18:29:00Z')), '2026-W40');
  assert.equal(isoWeekKey(new Date('2026-10-04T18:30:00Z')), '2026-W41');
  // 2020 has 53 ISO weeks; 1-3 Jan 2021 still belong to 2020-W53.
  assert.equal(isoWeekKey(new Date('2020-12-31T06:00:00Z')), '2020-W53');
  assert.equal(isoWeekKey(new Date('2021-01-03T06:00:00Z')), '2020-W53');
  assert.equal(isoWeekKey(new Date('2021-01-04T06:00:00Z')), '2021-W01');
  // 30 Dec 2024 (Monday) is week 1 of 2025.
  assert.equal(isoWeekKey(new Date('2024-12-30T06:00:00Z')), '2025-W01');
  assert.equal(isoWeekKey(new Date('2026-01-01T06:00:00Z')), '2026-W01');

  // Month in IST: 31 Oct 20:00 UTC is already 1 Nov in India.
  assert.equal(istMonthKey(new Date('2026-10-31T20:00:00Z')), '2026-11');
  assert.equal(getAllowancePeriodKey('monthly', new Date('2026-10-31T18:00:00Z')), '2026-10');
  assert.equal(getAllowancePeriodKey('weekly', new Date('2026-10-03T06:00:00Z')), '2026-W40');
});

test('IST week ranges run Monday 00:00 IST to the next Monday', () => {
  const range = getIstWeekRange(new Date('2026-10-03T06:00:00Z'));
  assert.equal(range.from.toISOString(), '2026-09-27T18:30:00.000Z');
  assert.equal(range.to.toISOString(), '2026-10-04T18:30:00.000Z');
  assert.equal(range.periodKey, '2026-W40');

  const previous = getPreviousIstWeekRange(new Date('2026-10-05T03:00:00Z')); // Monday morning IST
  assert.equal(previous.periodKey, '2026-W40');

  const acrossYear = getPreviousIstWeekRange(new Date('2021-01-04T03:00:00Z'));
  assert.equal(acrossYear.periodKey, '2020-W53');
  assert.equal(acrossYear.from.toISOString(), '2020-12-27T18:30:00.000Z');
});

// --- split -------------------------------------------------------------------

test('split at booking: covered km, excess km and the employee share of the fare', () => {
  const remainingKm = computeRemainingKm({ allowanceKm: 100, usedKm: 70, reservedKm: 10 });
  assert.equal(remainingKm, 20);
  const estimate = computeCorporateSplit({ fare: 500, km: 25, remainingKm, allowanceEnabled: true });
  assert.deepEqual(estimate, { km: 25, coveredKm: 20, excessKm: 5, employeeAmount: 100, companyAmount: 400 });

  // Allowance off: the company pays every km, as before v2.
  assert.deepEqual(
    computeCorporateSplit({ fare: 500, km: 25, remainingKm: 0, allowanceEnabled: false }),
    { km: 25, coveredKm: 25, excessKm: 0, employeeAmount: 0, companyAmount: 500 },
  );
  // Inside the allowance: nothing for the employee.
  assert.equal(computeCorporateSplit({ fare: 300, km: 10, remainingKm: 50, allowanceEnabled: true }).employeeAmount, 0);
  // Remaining never goes negative.
  assert.equal(computeRemainingKm({ allowanceKm: 10, usedKm: 12, reservedKm: 0 }), 0);
  // Zero km cannot divide by zero.
  assert.equal(computeCorporateSplit({ fare: 200, km: 0, remainingKm: 0, allowanceEnabled: true }).employeeAmount, 0);
  // Whole rupees, and the parts always add up to the fare.
  const odd = computeCorporateSplit({ fare: 333, km: 7, remainingKm: 3, allowanceEnabled: true });
  assert.equal(odd.employeeAmount, 190);
  assert.equal(odd.employeeAmount + odd.companyAmount, 333);
});

test('split at completion: allowance exhausted mid-period and estimate vs actual km', () => {
  // Booked 20 km with 30 km left: no excess estimated, 20 km reserved.
  const estimate = computeCorporateSplit({ fare: 400, km: 20, remainingKm: 30, allowanceEnabled: true });
  assert.equal(estimate.employeeAmount, 0);

  // Meanwhile another trip used 25 km. At completion this ride's 20 km
  // reservation is released first: 30 - 25 = 5 km left for it. The trip
  // actually ran 24 km (fare moved to 480 with waiting).
  const remainingAtCompletion = computeRemainingKm({ allowanceKm: 100, usedKm: 95, reservedKm: 0 });
  const final = computeCorporateSplit({ fare: 480, km: 24, remainingKm: remainingAtCompletion, allowanceEnabled: true });
  assert.deepEqual(final, { km: 24, coveredKm: 5, excessKm: 19, employeeAmount: 380, companyAmount: 100 });

  // Shorter than estimated: the estimate had an excess, the actual has none.
  const shorter = computeCorporateSplit({ fare: 300, km: 8, remainingKm: 10, allowanceEnabled: true });
  assert.equal(shorter.employeeAmount, 0);
  assert.equal(shorter.companyAmount, 300);

  // Fully exhausted: the employee pays it all.
  assert.deepEqual(
    computeCorporateSplit({ fare: 250, km: 12, remainingKm: 0, allowanceEnabled: true }),
    { km: 12, coveredKm: 0, excessKm: 12, employeeAmount: 250, companyAmount: 0 },
  );
});

test('employee payment method: required only with an excess, limited to the company list, final defaults', () => {
  assert.equal(resolveEmployeePaymentMethod({ requested: '', allowedMethods: ['cash', 'online'], required: true }).ok, false);
  assert.equal(resolveEmployeePaymentMethod({ requested: '', required: false }).ok, true);
  assert.equal(resolveEmployeePaymentMethod({ requested: 'wallet', allowedMethods: ['cash', 'online'], required: true }).ok, false);
  assert.equal(resolveEmployeePaymentMethod({ requested: 'Online', allowedMethods: ['cash', 'online'], required: true }).method, 'online');

  assert.equal(defaultEmployeePaymentMethod(['online', 'wallet']), 'online');
  assert.equal(defaultEmployeePaymentMethod([]), 'cash', 'empty list means all three');

  assert.deepEqual(resolveFinalEmployeePayment({ employeeAmount: 0, chosenMethod: '' }), { employeePaymentMethod: '', employeePaymentStatus: 'not_required' });
  assert.deepEqual(resolveFinalEmployeePayment({ employeeAmount: 50, chosenMethod: 'cash', allowedMethods: ['cash'] }), { employeePaymentMethod: 'cash', employeePaymentStatus: 'paid' });
  assert.deepEqual(resolveFinalEmployeePayment({ employeeAmount: 50, chosenMethod: 'wallet' }), { employeePaymentMethod: 'wallet', employeePaymentStatus: 'pending' });
  // An excess the estimate did not have: cash when allowed, else online.
  assert.equal(resolveFinalEmployeePayment({ employeeAmount: 50, chosenMethod: '', allowedMethods: ['cash', 'online'] }).employeePaymentMethod, 'cash');
  assert.equal(resolveFinalEmployeePayment({ employeeAmount: 50, chosenMethod: '', allowedMethods: ['online', 'wallet'] }).employeePaymentMethod, 'online');
});

test('round-trip outstation estimates double the routed km', () => {
  assert.equal(estimateTripKm({ distanceMeters: 120000, serviceType: 'intercity', tripType: 'Round Trip' }), 240);
  assert.equal(estimateTripKm({ distanceMeters: 120000, serviceType: 'intercity', tripType: 'one_way' }), 120);
  assert.equal(estimateTripKm({ distanceMeters: 8000, serviceType: 'ride', tripType: 'round_trip' }), 8);
});

// --- driver wallet -------------------------------------------------------------

test('driver wallet credit: unchanged without a cash excess, reduced by the cash the driver holds', () => {
  // fare 500, commission 100 -> earnings 400
  assert.deepEqual(computeCorporateDriverWalletCredit({ driverEarnings: 400, split: null }), { amount: 400, cashCollected: 0, type: 'ride_earning' });
  assert.equal(computeCorporateDriverWalletCredit({ driverEarnings: 400, split: { employeeAmount: 150, employeePaymentMethod: 'online' } }).amount, 400);
  assert.equal(computeCorporateDriverWalletCredit({ driverEarnings: 400, split: { employeeAmount: 150, employeePaymentMethod: 'wallet' } }).amount, 400);
  assert.deepEqual(
    computeCorporateDriverWalletCredit({ driverEarnings: 400, split: { employeeAmount: 150, employeePaymentMethod: 'cash' } }),
    { amount: 250, cashCollected: 150, type: 'ride_earning' },
  );
  // Employee paid the whole fare in cash: the driver owes the commission back.
  assert.deepEqual(
    computeCorporateDriverWalletCredit({ driverEarnings: 400, split: { employeeAmount: 500, employeePaymentMethod: 'cash' } }),
    { amount: -100, cashCollected: 500, type: 'commission_deduction' },
  );
});

// --- codes -------------------------------------------------------------------

test('employee and company codes', () => {
  assert.equal(formatEmployeeCode('ACME', 1), 'ACME-0001');
  assert.equal(formatEmployeeCode('acme', 42), 'ACME-0042');
  assert.equal(formatEmployeeCode('ACME', 12345), 'ACME-12345');
  assert.equal(normalizeEmployeeCode('  emp-01 '), 'EMP-01');

  const candidates = corporateCodeCandidates('Acme Technologies Pvt. Ltd.');
  assert.equal(candidates[0], 'ACMETE');
  assert.equal(candidates[1], 'ACMETA');
  assert.ok(candidates.every((code) => /^[A-Z]{1,6}$/.test(code)));
  assert.equal(new Set(candidates).size, candidates.length);
  assert.equal(corporateCodeCandidates('123 & co')[0], 'CO');
  assert.equal(corporateCodeCandidates('')[0], 'CORP');
});

test('import rows carry the role code or name', () => {
  assert.equal(normalizeEmployeeImportRow({ name: 'A', phone: '9876543210', rolecode: 'DIR' }).value.roleKey, 'DIR');
  assert.equal(normalizeEmployeeImportRow({ name: 'A', phone: '9876543210', role: 'Sales Field Staff' }).value.roleKey, 'Sales Field Staff');
  assert.equal(normalizeEmployeeImportRow({ name: 'A', phone: '9876543210' }).value.roleKey, '');
});

// --- invoices & rentals ----------------------------------------------------------

test('invoice totals bill the company share and summarise by role and employee', () => {
  const totals = buildInvoiceTotals({
    items: [
      { employeeId: 'e1', employeeName: 'Asha', employeeCode: 'ACME-0001', roleId: 'r1', roleName: 'Director', grossAmount: 400, discountAmount: 40, netAmount: 360, actualKm: 25, coveredKm: 20, excessKm: 5, employeeAmount: 100 },
      { employeeId: 'e1', employeeName: 'Asha', employeeCode: 'ACME-0001', roleId: 'r1', roleName: 'Director', grossAmount: 200, discountAmount: 0, netAmount: 200, actualKm: 8, coveredKm: 8, excessKm: 0, employeeAmount: 0 },
      { employeeId: 'e2', employeeName: 'Ravi', roleId: 'r2', roleName: 'Intern', grossAmount: 100, discountAmount: 0, netAmount: 100, actualKm: 4, coveredKm: 4, excessKm: 0, employeeAmount: 0 },
    ],
    gstPercent: 5,
  });
  assert.equal(totals.netAmount, 660);
  assert.equal(totals.employeePaidTotal, 100);
  assert.equal(totals.byRole.length, 2);
  assert.deepEqual(totals.byRole[0], { roleId: 'r1', roleName: 'Director', roleCode: '', trips: 2, km: 33, coveredKm: 28, excessKm: 5, employeeAmount: 100, billedAmount: 560 });
  assert.equal(totals.byEmployee.find((row) => row.employeeId === 'e2').billedAmount, 100);
});

test('rental km come from the inspection odometer, 0 when there are no readings', () => {
  assert.deepEqual(rentalKmFromInspection({ pickupMeterReading: 12000, returnMeterReading: 12180.5 }), { km: 180.5, source: 'odometer' });
  assert.deepEqual(rentalKmFromInspection({ pickupMeterReading: 12000 }), { km: 0, source: 'none' });
  assert.deepEqual(rentalKmFromInspection({ pickupMeterReading: 500, returnMeterReading: 400 }), { km: 0, source: 'none' });
  assert.deepEqual(rentalKmFromInspection(undefined), { km: 0, source: 'none' });
});
