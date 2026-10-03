/// Pure corporate rules: policy evaluation, discount, credit check, invoice
/// math, aging, CSV parsing. No database or env access here, so every rule
/// that decides money can be unit-tested without Mongo
/// (Backend/test/corporate.test.js).

export const CORPORATE_SERVICE_TYPES = Object.freeze(['ride', 'parcel', 'intercity', 'rental']);

const IST_OFFSET_MINUTES = 330;

export const round2 = (value) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.round((numeric + Number.EPSILON) * 100) / 100;
};

const toNumberOrNull = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
};

const toIdList = (list) => (Array.isArray(list) ? list.map((item) => String(item?._id || item)).filter(Boolean) : []);

/// Maps a Ride `serviceType` (ride | parcel | intercity) or "rental" onto the
/// corporate service vocabulary. Anything unknown is an ordinary ride.
export const normalizeCorporateServiceType = (serviceType) => {
  const value = String(serviceType || 'ride').trim().toLowerCase();
  if (value === 'outstation') return 'intercity';
  if (value === 'delivery') return 'parcel';
  return CORPORATE_SERVICE_TYPES.includes(value) ? value : 'ride';
};

/// Day of week and minutes since midnight in India time. Policies are written
/// by Indian travel desks in local time, and the servers run in UTC.
export const getIstClock = (date = new Date()) => {
  const shifted = new Date(new Date(date).getTime() + IST_OFFSET_MINUTES * 60 * 1000);
  return {
    day: shifted.getUTCDay(),
    minutes: shifted.getUTCHours() * 60 + shifted.getUTCMinutes(),
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth(),
    date: shifted.getUTCDate(),
  };
};

const parseClockMinutes = (value, fallback) => {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value || '').trim());
  if (!match) return fallback;
  const hours = Math.min(23, Number(match[1]));
  const minutes = Math.min(59, Number(match[2]));
  return hours * 60 + minutes;
};

/// True when `at` falls in any window. No windows = any time.
///
/// A window that ends before it starts ("22:00"-"06:00") runs past midnight;
/// its `days` refer to the day it starts on.
export const isWithinTimeWindows = (windows = [], at = new Date()) => {
  if (!Array.isArray(windows) || windows.length === 0) return true;
  const { day, minutes } = getIstClock(at);

  return windows.some((window) => {
    const start = parseClockMinutes(window?.start, 0);
    const end = parseClockMinutes(window?.end, 24 * 60 - 1);
    const days = Array.isArray(window?.days) ? window.days.map(Number) : [];
    const dayAllowed = (d) => days.length === 0 || days.includes(d);

    if (start <= end) {
      return dayAllowed(day) && minutes >= start && minutes <= end;
    }

    // Overnight: the evening part belongs to today, the early-morning part to
    // the window that started yesterday.
    if (minutes >= start) return dayAllowed(day);
    if (minutes <= end) return dayAllowed((day + 6) % 7);
    return false;
  });
};

const POLICY_DEFAULTS = Object.freeze({
  active: true,
  allowedServices: [],
  allowedVehicleTypeIds: [],
  allowedHours: [],
  outsideHoursAction: 'approval',
  maxFarePerTrip: null,
  overMaxFareAction: 'block',
  requireApprovalAbove: null,
  requireApprovalAlways: false,
});

/// Company policy, then department policy on top, then (v2) the role's travel
/// rules and the employee's own. Each later layer wins only where it actually
/// says something (non-empty list, non-null scalar), so a department policy
/// that only sets a fare cap still inherits the company's hours.
///
/// Call as mergePolicies(company, department, role, employee); build the last
/// two with rolePolicyLayer / employeePolicyLayer.
export const mergePolicies = (...layers) => {
  const merged = { ...POLICY_DEFAULTS };
  for (const source of layers) {
    if (!source || source.active === false) continue;
    for (const key of Object.keys(POLICY_DEFAULTS)) {
      if (key === 'active') continue;
      const value = source[key];
      if (Array.isArray(value)) {
        if (value.length) merged[key] = value;
      } else if (value !== null && value !== undefined && value !== '') {
        merged[key] = value;
      }
    }
  }
  return merged;
};

/// A CorporateRole as a policy layer: only the travel-rule fields, with the
/// role's own "unset" values (empty list, null) left to inherit. An inactive
/// role contributes nothing.
export const rolePolicyLayer = (role = null) => {
  if (!role || role.active === false) return null;
  return {
    allowedServices: Array.isArray(role.allowedServices) ? role.allowedServices : [],
    allowedVehicleTypeIds: Array.isArray(role.allowedVehicleTypeIds) ? role.allowedVehicleTypeIds : [],
    maxFarePerTrip: toNumberOrNull(role.maxFarePerTrip),
    requireApprovalAlways: role.requireApprovalAlways === true || role.requireApprovalAlways === false ? role.requireApprovalAlways : null,
    requireApprovalAbove: toNumberOrNull(role.requireApprovalAbove),
  };
};

/// The employee's own settings as the last policy layer. `requiresApproval`
/// only ever tightens (false means "not set" here, as it always has).
export const employeePolicyLayer = (employee = null) => {
  if (!employee) return null;
  return {
    allowedServices: Array.isArray(employee.allowedServices) ? employee.allowedServices : [],
    requireApprovalAlways: employee.requiresApproval === true ? true : null,
  };
};

/// The employee's monthly cap on company-paid spend: their own limit when set,
/// else the role's `monthlySpendLimit`. 0 = none.
export const resolveEmployeeMonthlyLimit = ({ employee = {}, role = null } = {}) => {
  const own = Math.max(0, Number(employee?.monthlyLimit) || 0);
  if (own > 0) return own;
  if (!role || role.active === false) return 0;
  return Math.max(0, Number(role.monthlySpendLimit) || 0);
};

/// Whether a trip may be billed to the company, and whether it needs an
/// approver first.
///
/// Block reasons are things nobody can approve away (service not allowed, hard
/// monthly limit). Approval reasons are soft limits a manager may waive.
export const evaluateTripPolicy = ({
  corporate = {},
  policy = POLICY_DEFAULTS,
  employee = {},
  department = null,
  trip = {},
  spend = {},
} = {}) => {
  const blockReasons = [];
  const approvalReasons = [];
  const serviceType = normalizeCorporateServiceType(trip.serviceType);
  const fare = Math.max(0, Number(trip.fare) || 0);
  const vehicleTypeId = trip.vehicleTypeId ? String(trip.vehicleTypeId) : '';
  const at = trip.at ? new Date(trip.at) : new Date();

  const serviceLists = [corporate.allowedServices, policy.allowedServices, employee.allowedServices]
    .filter((list) => Array.isArray(list) && list.length);
  if (serviceLists.some((list) => !list.includes(serviceType))) {
    blockReasons.push(`${serviceType} is not allowed for this account`);
  }

  const vehicleLists = [corporate.allowedVehicleTypeIds, policy.allowedVehicleTypeIds]
    .map(toIdList)
    .filter((list) => list.length);
  if (vehicleTypeId && vehicleLists.some((list) => !list.includes(vehicleTypeId))) {
    blockReasons.push('This vehicle type is not allowed by your company policy');
  }

  if (!isWithinTimeWindows(policy.allowedHours, at)) {
    if (policy.outsideHoursAction === 'block') blockReasons.push('Outside allowed travel hours');
    else approvalReasons.push('Outside allowed travel hours');
  }

  const maxFare = toNumberOrNull(policy.maxFarePerTrip);
  if (maxFare !== null && fare > maxFare) {
    if (policy.overMaxFareAction === 'approval') approvalReasons.push(`Fare above the ${maxFare} per-trip limit`);
    else blockReasons.push(`Fare above the ${maxFare} per-trip limit`);
  }

  const approvalAbove = toNumberOrNull(policy.requireApprovalAbove);
  if (policy.requireApprovalAlways === true || approvalAbove === 0) {
    approvalReasons.push('Company policy requires approval for every trip');
  } else if (approvalAbove !== null && fare > approvalAbove) {
    approvalReasons.push(`Fare above ${approvalAbove}`);
  }

  if (employee.requiresApproval === true) {
    approvalReasons.push('Employee trips require approval');
  }

  const monthlyLimit = Math.max(0, Number(employee.monthlyLimit) || 0);
  const employeeSpend = Math.max(0, Number(spend.employeeMonthSpend) || 0);
  if (monthlyLimit > 0 && employeeSpend + fare > monthlyLimit) {
    blockReasons.push(`Monthly limit of ${monthlyLimit} would be exceeded`);
  }

  const budget = Math.max(0, Number(department?.monthlyBudget) || 0);
  const departmentSpend = Math.max(0, Number(spend.departmentMonthSpend) || 0);
  if (budget > 0 && departmentSpend + fare > budget) {
    approvalReasons.push('Department monthly budget would be exceeded');
  }

  return {
    allowed: blockReasons.length === 0,
    blockReasons,
    requiresApproval: blockReasons.length === 0 && approvalReasons.length > 0,
    approvalReasons: [...new Set(approvalReasons)],
  };
};

/// The company's negotiated discount on one trip. Never more than the fare,
/// and zero for services the discount does not cover.
export const computeCorporateDiscount = ({ discount = {}, serviceType, fare } = {}) => {
  const grossFare = Math.max(0, Number(fare) || 0);
  const value = Math.max(0, Number(discount?.value) || 0);
  const service = normalizeCorporateServiceType(serviceType);
  const appliesTo = Array.isArray(discount?.appliesTo) ? discount.appliesTo : CORPORATE_SERVICE_TYPES;

  if (!value || !grossFare || !appliesTo.includes(service)) {
    return { amount: 0, billableAmount: round2(grossFare), type: discount?.type || 'percentage', value };
  }

  let amount = discount?.type === 'flat' ? value : (grossFare * value) / 100;
  const cap = Math.max(0, Number(discount?.maxPerTrip) || 0);
  if (discount?.type !== 'flat' && cap > 0) amount = Math.min(amount, cap);
  amount = round2(Math.min(amount, grossFare));

  return {
    amount,
    billableAmount: round2(grossFare - amount),
    type: discount?.type === 'flat' ? 'flat' : 'percentage',
    value,
  };
};

/// Can the company take on `amount` more credit?
///
/// Exposure is what is already owed plus what is booked but not yet billed
/// (rides in progress), so a burst of simultaneous bookings cannot each pass
/// against the same headroom. Grace lets an account run slightly over its
/// limit rather than strand an employee mid-month.
export const checkCreditLimit = ({
  creditLimit = 0,
  currentOutstanding = 0,
  pendingExposure = 0,
  amount = 0,
  gracePercent = 0,
  graceAmount = 0,
} = {}) => {
  const limit = Math.max(0, Number(creditLimit) || 0);
  const grace = Math.max(0, (limit * Math.max(0, Number(gracePercent) || 0)) / 100) + Math.max(0, Number(graceAmount) || 0);
  const limitWithGrace = round2(limit + grace);
  const exposure = round2(Math.max(0, Number(currentOutstanding) || 0) + Math.max(0, Number(pendingExposure) || 0));
  const requested = round2(Math.max(0, Number(amount) || 0));
  const available = round2(limitWithGrace - exposure);

  if (limit <= 0) {
    return { allowed: false, reason: 'No credit limit has been set for this company', limit, limitWithGrace, exposure, available: 0 };
  }

  const allowed = exposure + requested <= limitWithGrace;
  return {
    allowed,
    reason: allowed ? '' : 'Company credit limit reached',
    limit,
    limitWithGrace,
    exposure,
    available: Math.max(0, available),
  };
};

/// CGST+SGST when supplier and customer are in the same state (first two GSTIN
/// digits), IGST otherwise. A customer with no GSTIN is billed as intra-state,
/// the usual treatment for an unregistered B2B buyer in the supplier's state.
export const resolveGstMode = (supplierGstin = '', customerGstin = '') => {
  const supplierState = String(supplierGstin || '').trim().slice(0, 2);
  const customerState = String(customerGstin || '').trim().slice(0, 2);
  if (!supplierState || !customerState) return 'intra';
  return supplierState === customerState ? 'intra' : 'inter';
};

const addUsageSummary = (map, key, identity, item, netAmount) => {
  if (!map.has(key)) map.set(key, { ...identity, trips: 0, km: 0, coveredKm: 0, excessKm: 0, employeeAmount: 0, billedAmount: 0 });
  const row = map.get(key);
  row.trips += 1;
  row.km = round2(row.km + (Number(item.actualKm) || 0));
  row.coveredKm = round2(row.coveredKm + (Number(item.coveredKm) || 0));
  row.excessKm = round2(row.excessKm + (Number(item.excessKm) || 0));
  row.employeeAmount = round2(row.employeeAmount + (Number(item.employeeAmount) || 0));
  row.billedAmount = round2(row.billedAmount + netAmount);
};

/// Department lines, the per-trip annex and the totals for one invoice.
///
/// v2: also `byRole` and `byEmployee` (trips, km, covered/excess km, billed)
/// and `employeePaidTotal`. An item's `grossAmount` is the company's share of
/// the fare; the employee-paid excess is never part of the invoice amount.
///
/// `inclusive` (the default) treats trip fares as GST-inclusive, which is how
/// they were quoted to the rider and charged to the credit account, so the
/// invoice total equals what was charged. With `inclusive: false` GST is added
/// on top and the invoice total is higher than the charged amount.
export const buildInvoiceTotals = ({ items = [], gstPercent = 0, inclusive = true, mode = 'intra' } = {}) => {
  const byDepartment = new Map();
  const byRole = new Map();
  const byEmployee = new Map();
  const annex = [];

  for (const item of items) {
    const grossAmount = round2(item.grossAmount);
    const discountAmount = round2(item.discountAmount);
    const netAmount = round2(item.netAmount ?? grossAmount - discountAmount);
    const key = item.departmentId ? String(item.departmentId) : '__none__';

    if (!byDepartment.has(key)) {
      byDepartment.set(key, {
        departmentId: item.departmentId || null,
        departmentName: item.departmentName || 'Unassigned',
        costCenter: item.costCenter || '',
        trips: 0,
        grossAmount: 0,
        discountAmount: 0,
        netAmount: 0,
      });
    }
    const line = byDepartment.get(key);
    line.trips += 1;
    line.grossAmount = round2(line.grossAmount + grossAmount);
    line.discountAmount = round2(line.discountAmount + discountAmount);
    line.netAmount = round2(line.netAmount + netAmount);

    annex.push({ ...item, grossAmount, discountAmount, netAmount });
    addUsageSummary(
      byRole,
      item.roleId ? String(item.roleId) : `name:${item.roleName || ''}`,
      { roleId: item.roleId ? String(item.roleId) : null, roleName: item.roleName || 'Unassigned', roleCode: item.roleCode || '' },
      item,
      netAmount,
    );
    addUsageSummary(
      byEmployee,
      item.employeeId ? String(item.employeeId) : '__none__',
      { employeeId: item.employeeId ? String(item.employeeId) : null, employeeName: item.employeeName || '', employeeCode: item.employeeCode || '' },
      item,
      netAmount,
    );
  }

  annex.sort((a, b) => new Date(a.date || 0) - new Date(b.date || 0));
  const lines = [...byDepartment.values()].sort((a, b) => a.departmentName.localeCompare(b.departmentName));

  const subtotal = round2(lines.reduce((sum, line) => sum + line.grossAmount, 0));
  const discount = round2(lines.reduce((sum, line) => sum + line.discountAmount, 0));
  const netAmount = round2(lines.reduce((sum, line) => sum + line.netAmount, 0));
  const percent = Math.max(0, Number(gstPercent) || 0);

  let taxableAmount;
  let taxTotal;
  if (inclusive) {
    taxableAmount = round2((netAmount * 100) / (100 + percent));
    taxTotal = round2(netAmount - taxableAmount);
  } else {
    taxableAmount = netAmount;
    taxTotal = round2((netAmount * percent) / 100);
  }

  const cgst = mode === 'inter' ? 0 : round2(taxTotal / 2);
  const sgst = mode === 'inter' ? 0 : round2(taxTotal - cgst);
  const igst = mode === 'inter' ? taxTotal : 0;
  const total = inclusive ? netAmount : round2(netAmount + taxTotal);

  const sortSummary = (map) => [...map.values()].sort((a, b) => b.billedAmount - a.billedAmount || b.trips - a.trips);

  return {
    lines,
    annex,
    byRole: sortSummary(byRole),
    byEmployee: sortSummary(byEmployee),
    employeePaidTotal: round2(annex.reduce((sum, item) => sum + (Number(item.employeeAmount) || 0), 0)),
    tripCount: annex.length,
    subtotal,
    discount,
    netAmount,
    taxableAmount,
    tax: { mode, percent, inclusive: Boolean(inclusive), cgst, sgst, igst, total: taxTotal },
    roundOff: 0,
    total,
  };
};

/// Status after a payment, from the amounts alone.
export const resolveInvoicePaymentStatus = ({ total, amountPaid, dueDate, now = new Date(), currentStatus = 'issued' }) => {
  if (currentStatus === 'void' || currentStatus === 'draft') return currentStatus;
  const balance = round2(Number(total || 0) - Number(amountPaid || 0));
  if (balance <= 0) return 'paid';
  if (dueDate && new Date(dueDate) < now) return 'overdue';
  return Number(amountPaid || 0) > 0 ? 'partially_paid' : 'issued';
};

export const AGING_BUCKETS = Object.freeze(['current', '1_30', '31_60', '61_90', '90_plus']);

/// Outstanding invoice balances grouped by days past due.
export const buildAgingBuckets = (invoices = [], now = new Date()) => {
  const buckets = Object.fromEntries(AGING_BUCKETS.map((key) => [key, { count: 0, amount: 0 }]));
  let totalDue = 0;

  for (const invoice of invoices) {
    if (['draft', 'void', 'paid'].includes(invoice.status)) continue;
    const balance = round2(invoice.balanceDue ?? Number(invoice.total || 0) - Number(invoice.amountPaid || 0));
    if (balance <= 0) continue;

    const due = invoice.dueDate ? new Date(invoice.dueDate) : null;
    const daysPastDue = due ? Math.floor((now.getTime() - due.getTime()) / (24 * 60 * 60 * 1000)) : 0;
    const key = daysPastDue <= 0 ? 'current'
      : daysPastDue <= 30 ? '1_30'
        : daysPastDue <= 60 ? '31_60'
          : daysPastDue <= 90 ? '61_90'
            : '90_plus';

    buckets[key].count += 1;
    buckets[key].amount = round2(buckets[key].amount + balance);
    totalDue = round2(totalDue + balance);
  }

  return { buckets, totalDue };
};

/// [from, to) for the calendar month (IST) containing `date`, as UTC instants.
export const getIstMonthRange = (date = new Date()) => {
  const { year, month } = getIstClock(date);
  const offsetMs = IST_OFFSET_MINUTES * 60 * 1000;
  const from = new Date(Date.UTC(year, month, 1) - offsetMs);
  const to = new Date(Date.UTC(year, month + 1, 1) - offsetMs);
  return { from, to, periodKey: `${year}-${String(month + 1).padStart(2, '0')}` };
};

export const getPreviousIstMonthRange = (now = new Date()) => {
  const { from } = getIstMonthRange(now);
  return getIstMonthRange(new Date(from.getTime() - 60 * 1000));
};

/// Small RFC 4180 CSV reader: quoted fields, escaped quotes, CRLF. Returns one
/// object per row keyed by the normalised header (lowercase, no spaces/_).
export const parseCsv = (text = '') => {
  const rows = [];
  let field = '';
  let row = [];
  let quoted = false;
  const input = String(text || '').replace(/^﻿/, '');

  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];
    if (quoted) {
      if (char === '"' && input[i + 1] === '"') { field += '"'; i += 1; }
      else if (char === '"') quoted = false;
      else field += char;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === ',') { row.push(field); field = ''; }
    else if (char === '\n' || char === '\r') {
      if (char === '\r' && input[i + 1] === '\n') i += 1;
      row.push(field); field = '';
      if (row.some((cell) => cell.trim() !== '')) rows.push(row);
      row = [];
    } else field += char;
  }
  row.push(field);
  if (row.some((cell) => cell.trim() !== '')) rows.push(row);

  if (!rows.length) return [];
  const headers = rows[0].map(normalizeHeader);
  return rows.slice(1).map((cells) => Object.fromEntries(headers.map((header, index) => [header, String(cells[index] ?? '').trim()])));
};

export const normalizeHeader = (value) => String(value || '').trim().toLowerCase().replace(/[\s_\-.]+/g, '');

export const normalizeIndianPhone = (value) => {
  const digits = String(value || '').replace(/\D/g, '');
  if (digits.length === 12 && digits.startsWith('91')) return digits.slice(2);
  if (digits.length === 11 && digits.startsWith('0')) return digits.slice(1);
  return digits;
};

const truthy = (value) => ['1', 'true', 'yes', 'y'].includes(String(value || '').trim().toLowerCase());

/// One import row → employee fields, or an error message. Accepts the column
/// names a spreadsheet is likely to have (Name, Mobile, Employee ID, ...).
export const normalizeEmployeeImportRow = (row = {}) => {
  const pick = (...keys) => {
    for (const key of keys) {
      const value = row[normalizeHeader(key)];
      if (value !== undefined && String(value).trim() !== '') return String(value).trim();
    }
    return '';
  };

  const name = pick('name', 'employee name', 'full name');
  const phone = normalizeIndianPhone(pick('phone', 'mobile', 'mobile number', 'phone number'));
  const errors = [];
  if (!name) errors.push('name is required');
  if (!/^\d{10}$/.test(phone)) errors.push('a valid 10-digit phone is required');

  const services = [...new Set(
    pick('allowed services', 'services')
      .split(/[|;,]/)
      .map((item) => item.trim())
      .filter(Boolean)
      .map(normalizeCorporateServiceType),
  )];

  return {
    errors,
    value: {
      name,
      phone,
      email: pick('email', 'email address').toLowerCase(),
      employeeCode: pick('employee code', 'employee id', 'emp code', 'code'),
      /// Role code or name; matched against the company's roles on import.
      roleKey: pick('role code', 'role', 'role name'),
      designation: pick('designation', 'title'),
      departmentName: pick('department', 'department name'),
      departmentCode: pick('department code', 'dept code'),
      monthlyLimit: Math.max(0, Number(pick('monthly limit', 'limit')) || 0),
      requiresApproval: truthy(pick('requires approval', 'approval')),
      allowedServices: services,
    },
  };
};

export const toCsv = (columns = [], rows = []) => {
  const escape = (value) => {
    const text = value === null || value === undefined ? '' : value instanceof Date ? value.toISOString() : String(value);
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const header = columns.map((column) => escape(column.label)).join(',');
  const body = rows.map((row) => columns.map((column) => escape(typeof column.value === 'function' ? column.value(row) : row[column.key])).join(','));
  return [header, ...body].join('\n');
};
