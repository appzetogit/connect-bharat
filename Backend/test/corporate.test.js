import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAgingBuckets,
  buildInvoiceTotals,
  checkCreditLimit,
  computeCorporateDiscount,
  evaluateTripPolicy,
  getIstMonthRange,
  getPreviousIstMonthRange,
  isWithinTimeWindows,
  mergePolicies,
  normalizeEmployeeImportRow,
  parseCsv,
  resolveGstMode,
  resolveInvoicePaymentStatus,
  toCsv,
} from '../src/modules/taxi/corporate/services/corporatePolicyEngine.js';

// 10:00 IST on Wednesday 2026-09-16 is 04:30 UTC.
const WED_10_IST = new Date('2026-09-16T04:30:00Z');
// 23:30 IST on Wednesday.
const WED_2330_IST = new Date('2026-09-16T18:00:00Z');
// 02:00 IST on Thursday.
const THU_02_IST = new Date('2026-09-16T20:30:00Z');

test('time windows are evaluated in IST, including overnight windows', () => {
  assert.equal(isWithinTimeWindows([], WED_10_IST), true);
  assert.equal(isWithinTimeWindows([{ days: [1, 2, 3, 4, 5], start: '08:00', end: '20:00' }], WED_10_IST), true);
  assert.equal(isWithinTimeWindows([{ days: [0, 6], start: '08:00', end: '20:00' }], WED_10_IST), false);
  assert.equal(isWithinTimeWindows([{ start: '08:00', end: '20:00' }], WED_2330_IST), false);

  const night = [{ days: [3], start: '22:00', end: '06:00' }]; // starts Wednesday night
  assert.equal(isWithinTimeWindows(night, WED_2330_IST), true);
  assert.equal(isWithinTimeWindows(night, THU_02_IST), true, 'early Thursday belongs to the Wednesday window');
  assert.equal(isWithinTimeWindows([{ days: [4], start: '22:00', end: '06:00' }], THU_02_IST), false);
});

test('department policy overrides company policy only where it sets a value', () => {
  const company = { allowedServices: ['ride', 'intercity'], allowedHours: [{ start: '08:00', end: '20:00' }], maxFarePerTrip: 1000, requireApprovalAbove: 500 };
  const department = { allowedServices: [], allowedHours: [], maxFarePerTrip: 2000, requireApprovalAbove: null };
  const merged = mergePolicies(company, department);
  assert.deepEqual(merged.allowedServices, ['ride', 'intercity']);
  assert.equal(merged.allowedHours.length, 1);
  assert.equal(merged.maxFarePerTrip, 2000);
  assert.equal(merged.requireApprovalAbove, 500);
  assert.equal(mergePolicies(company, { ...department, active: false }).maxFarePerTrip, 1000);
});

test('policy evaluation: blocks, approvals and pass-through', () => {
  const policy = mergePolicies({ allowedServices: ['ride', 'intercity'], maxFarePerTrip: 1000, requireApprovalAbove: 400, allowedHours: [{ start: '08:00', end: '20:00' }] });

  const fine = evaluateTripPolicy({ policy, trip: { serviceType: 'ride', fare: 300, at: WED_10_IST } });
  assert.deepEqual(fine, { allowed: true, blockReasons: [], requiresApproval: false, approvalReasons: [] });

  const pricey = evaluateTripPolicy({ policy, trip: { serviceType: 'ride', fare: 600, at: WED_10_IST } });
  assert.equal(pricey.allowed, true);
  assert.equal(pricey.requiresApproval, true);

  const overCap = evaluateTripPolicy({ policy, trip: { serviceType: 'ride', fare: 1200, at: WED_10_IST } });
  assert.equal(overCap.allowed, false);
  assert.equal(overCap.requiresApproval, false, 'a blocked trip is never sent for approval');

  const parcel = evaluateTripPolicy({ policy, trip: { serviceType: 'parcel', fare: 100, at: WED_10_IST } });
  assert.equal(parcel.allowed, false);

  const late = evaluateTripPolicy({ policy, trip: { serviceType: 'ride', fare: 100, at: WED_2330_IST } });
  assert.equal(late.allowed, true);
  assert.ok(late.approvalReasons.includes('Outside allowed travel hours'));

  const lateBlocked = evaluateTripPolicy({ policy: { ...policy, outsideHoursAction: 'block' }, trip: { serviceType: 'ride', fare: 100, at: WED_2330_IST } });
  assert.equal(lateBlocked.allowed, false);
});

test('policy evaluation: company and employee service lists, vehicle types, limits and budgets', () => {
  const policy = mergePolicies(null, null);
  const corporate = { allowedServices: ['ride', 'parcel'], allowedVehicleTypeIds: ['v1'] };

  assert.equal(evaluateTripPolicy({ corporate, policy, trip: { serviceType: 'intercity', fare: 10 } }).allowed, false);
  assert.equal(evaluateTripPolicy({ corporate, policy, employee: { allowedServices: ['parcel'] }, trip: { serviceType: 'ride', fare: 10 } }).allowed, false);
  assert.equal(evaluateTripPolicy({ corporate, policy, trip: { serviceType: 'ride', vehicleTypeId: 'v2', fare: 10 } }).allowed, false);
  assert.equal(evaluateTripPolicy({ corporate, policy, trip: { serviceType: 'ride', vehicleTypeId: 'v1', fare: 10 } }).allowed, true);

  const limited = evaluateTripPolicy({ policy, employee: { monthlyLimit: 1000 }, trip: { fare: 300 }, spend: { employeeMonthSpend: 800 } });
  assert.equal(limited.allowed, false);

  const overBudget = evaluateTripPolicy({ policy, department: { monthlyBudget: 5000 }, trip: { fare: 300 }, spend: { departmentMonthSpend: 4900 } });
  assert.equal(overBudget.allowed, true);
  assert.equal(overBudget.requiresApproval, true);

  const always = evaluateTripPolicy({ policy, employee: { requiresApproval: true }, trip: { fare: 1 } });
  assert.equal(always.requiresApproval, true);
  assert.equal(evaluateTripPolicy({ policy: { ...policy, requireApprovalAbove: 0 }, trip: { fare: 1 } }).requiresApproval, true);
});

test('corporate discount: percentage, cap, flat, scope', () => {
  assert.deepEqual(
    computeCorporateDiscount({ discount: { type: 'percentage', value: 10 }, serviceType: 'ride', fare: 455 }),
    { amount: 45.5, billableAmount: 409.5, type: 'percentage', value: 10 },
  );
  assert.equal(computeCorporateDiscount({ discount: { type: 'percentage', value: 20, maxPerTrip: 50 }, serviceType: 'ride', fare: 1000 }).amount, 50);
  assert.equal(computeCorporateDiscount({ discount: { type: 'flat', value: 75 }, serviceType: 'ride', fare: 60 }).amount, 60, 'never more than the fare');
  assert.equal(computeCorporateDiscount({ discount: { type: 'flat', value: 75, appliesTo: ['rental'] }, serviceType: 'ride', fare: 600 }).amount, 0);
  assert.equal(computeCorporateDiscount({ discount: { type: 'percentage', value: 5, appliesTo: ['intercity'] }, serviceType: 'outstation', fare: 3000 }).amount, 150);
  assert.equal(computeCorporateDiscount({ discount: {}, serviceType: 'ride', fare: 100 }).billableAmount, 100);
});

test('credit limit check counts outstanding plus in-flight bookings, with grace', () => {
  assert.equal(checkCreditLimit({ creditLimit: 0, amount: 1 }).allowed, false, 'no limit set means no credit');
  assert.equal(checkCreditLimit({ creditLimit: 10000, currentOutstanding: 9000, amount: 1000 }).allowed, true);
  assert.equal(checkCreditLimit({ creditLimit: 10000, currentOutstanding: 9000, amount: 1001 }).allowed, false);
  assert.equal(checkCreditLimit({ creditLimit: 10000, currentOutstanding: 9000, pendingExposure: 500, amount: 600 }).allowed, false);

  const graced = checkCreditLimit({ creditLimit: 10000, currentOutstanding: 10000, amount: 400, gracePercent: 5 });
  assert.equal(graced.allowed, true);
  assert.equal(graced.limitWithGrace, 10500);
  assert.equal(graced.available, 500);
  assert.equal(checkCreditLimit({ creditLimit: 10000, currentOutstanding: 10000, amount: 400, graceAmount: 300 }).allowed, false);
});

test('GST mode from GSTIN state codes', () => {
  assert.equal(resolveGstMode('29ABCDE1234F1Z5', '29XYZAB1234C1Z1'), 'intra');
  assert.equal(resolveGstMode('29ABCDE1234F1Z5', '27XYZAB1234C1Z1'), 'inter');
  assert.equal(resolveGstMode('', '27XYZAB1234C1Z1'), 'intra');
});

const items = [
  { kind: 'ride', departmentId: 'd1', departmentName: 'Sales', grossAmount: 500, discountAmount: 50, netAmount: 450, date: '2026-09-03' },
  { kind: 'ride', departmentId: 'd1', departmentName: 'Sales', grossAmount: 300, discountAmount: 30, netAmount: 270, date: '2026-09-01' },
  { kind: 'ride', departmentId: 'd2', departmentName: 'Engineering', grossAmount: 210, discountAmount: 21, netAmount: 189, date: '2026-09-02' },
  { kind: 'rental', departmentId: null, grossAmount: 1050, discountAmount: 0, netAmount: 1050, date: '2026-09-04' },
];

test('invoice aggregation: department lines, annex order and inclusive GST', () => {
  const totals = buildInvoiceTotals({ items, gstPercent: 5, inclusive: true, mode: 'intra' });
  assert.equal(totals.tripCount, 4);
  assert.deepEqual(totals.lines.map((line) => [line.departmentName, line.trips, line.netAmount]), [
    ['Engineering', 1, 189],
    ['Sales', 2, 720],
    ['Unassigned', 1, 1050],
  ]);
  assert.equal(totals.subtotal, 2060);
  assert.equal(totals.discount, 101);
  assert.equal(totals.netAmount, 1959);
  // 1959 / 1.05 = 1865.714...
  assert.equal(totals.taxableAmount, 1865.71);
  assert.equal(totals.tax.total, 93.29);
  assert.equal(totals.tax.cgst, 46.65);
  assert.equal(totals.tax.sgst, 46.64, 'the halves add back to the tax total exactly');
  assert.equal(totals.tax.igst, 0);
  assert.equal(totals.total, 1959, 'inclusive invoice total equals what was charged');
  assert.deepEqual(totals.annex.map((item) => item.date), ['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04']);
});

test('invoice aggregation: exclusive GST adds tax on top, inter-state uses IGST', () => {
  const totals = buildInvoiceTotals({ items, gstPercent: 5, inclusive: false, mode: 'inter' });
  assert.equal(totals.taxableAmount, 1959);
  assert.equal(totals.tax.igst, 97.95);
  assert.equal(totals.tax.cgst, 0);
  assert.equal(totals.total, 2056.95);
  assert.equal(buildInvoiceTotals({ items: [] }).total, 0);
});

test('invoice payment status and aging buckets', () => {
  const now = new Date('2026-10-20T00:00:00Z');
  assert.equal(resolveInvoicePaymentStatus({ total: 100, amountPaid: 100, now }), 'paid');
  assert.equal(resolveInvoicePaymentStatus({ total: 100, amountPaid: 40, dueDate: '2026-11-01', now }), 'partially_paid');
  assert.equal(resolveInvoicePaymentStatus({ total: 100, amountPaid: 40, dueDate: '2026-10-01', now }), 'overdue');
  assert.equal(resolveInvoicePaymentStatus({ total: 100, amountPaid: 0, currentStatus: 'draft' }), 'draft');

  const { buckets, totalDue } = buildAgingBuckets([
    { status: 'issued', balanceDue: 100, dueDate: '2026-10-25' },
    { status: 'overdue', balanceDue: 200, dueDate: '2026-10-10' },
    { status: 'overdue', balanceDue: 300, dueDate: '2026-08-01' },
    { status: 'partially_paid', balanceDue: 50, dueDate: '2026-06-01' },
    { status: 'paid', balanceDue: 0, dueDate: '2026-01-01' },
    { status: 'draft', balanceDue: 999 },
  ], now);
  assert.equal(buckets.current.amount, 100);
  assert.equal(buckets['1_30'].amount, 200);
  assert.equal(buckets['61_90'].amount, 300);
  assert.equal(buckets['90_plus'].amount, 50);
  assert.equal(totalDue, 650);
});

test('IST month ranges', () => {
  const { from, to, periodKey } = getIstMonthRange(new Date('2026-09-30T20:00:00Z')); // 1 Oct 01:30 IST
  assert.equal(periodKey, '2026-10');
  assert.equal(from.toISOString(), '2026-09-30T18:30:00.000Z');
  assert.equal(to.toISOString(), '2026-10-31T18:30:00.000Z');
  assert.equal(getPreviousIstMonthRange(new Date('2026-10-01T00:00:00Z')).periodKey, '2026-09');
  assert.equal(getPreviousIstMonthRange(new Date('2026-01-01T00:00:00Z')).periodKey, '2025-12');
});

test('CSV parsing and employee import rows', () => {
  const rows = parseCsv('﻿Name,Mobile Number,Department,Allowed Services,Monthly Limit\r\n"Rao, Asha",+91 98765 43210,Sales,"ride,intercity",5000\n\nBad,123,,,\n');
  assert.equal(rows.length, 2);
  const first = normalizeEmployeeImportRow(rows[0]);
  assert.deepEqual(first.errors, []);
  assert.equal(first.value.name, 'Rao, Asha');
  assert.equal(first.value.phone, '9876543210');
  assert.equal(first.value.departmentName, 'Sales');
  assert.deepEqual(first.value.allowedServices, ['ride', 'intercity']);
  assert.equal(first.value.monthlyLimit, 5000);
  assert.deepEqual(normalizeEmployeeImportRow(rows[1]).errors, ['a valid 10-digit phone is required']);
  assert.deepEqual(normalizeEmployeeImportRow({ phone: '9876543210' }).value.allowedServices, []);

  const csv = toCsv([{ label: 'A', key: 'a' }, { label: 'B', value: (row) => row.b * 2 }], [{ a: 'x,"y"', b: 2 }]);
  assert.equal(csv, 'A,B\n"x,""y""",4');
});
