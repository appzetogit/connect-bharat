import mongoose from 'mongoose';
import { RentalBookingRequest } from '../../admin/models/RentalBookingRequest.js';
import { Ride } from '../../user/models/Ride.js';
import { Corporate } from '../models/Corporate.js';
import { CorporateDepartment } from '../models/CorporateDepartment.js';
import { CorporateEmployee } from '../models/CorporateEmployee.js';
import { CorporateTripRequest } from '../models/CorporateTripRequest.js';
import { getIstMonthRange, round2, toCsv } from './corporatePolicyEngine.js';

/// Usage analytics (SOW 8.8) and department reporting (8.5). Everything is a
/// Mongo aggregation over completed corporate rides keyed by
/// `corporate.corporateId`; amounts are what the company is billed
/// (`corporate.billedAmount`), with gross and discount alongside.

const toObjectId = (value) => new mongoose.Types.ObjectId(String(value));

/// Defaults to the current IST month when no range is given.
export const resolveReportRange = ({ from, to } = {}) => {
  const month = getIstMonthRange(new Date());
  const fromDate = from ? new Date(from) : month.from;
  const toDate = to ? new Date(to) : month.to;
  return {
    from: Number.isNaN(fromDate.getTime()) ? month.from : fromDate,
    to: Number.isNaN(toDate.getTime()) ? month.to : toDate,
  };
};

const baseMatch = ({ corporateId, from, to, departmentId = null, employeeId = null }) => {
  const match = {
    'corporate.corporateId': toObjectId(corporateId),
    paymentMethod: 'corporate',
    status: 'completed',
    completedAt: { $gte: from, $lt: to },
  };
  if (departmentId) match['corporate.departmentId'] = toObjectId(departmentId);
  if (employeeId) match['corporate.employeeId'] = toObjectId(employeeId);
  return match;
};

const sumFields = {
  trips: { $sum: 1 },
  spend: { $sum: '$corporate.billedAmount' },
  gross: { $sum: '$fare' },
  discount: { $sum: '$corporate.discountAmount' },
  distanceMeters: { $sum: '$estimatedDistanceMeters' },
};

const shapeRow = (row) => ({
  trips: row.trips || 0,
  spend: round2(row.spend),
  gross: round2(row.gross),
  discount: round2(row.discount),
  avgFare: row.trips ? round2(row.spend / row.trips) : 0,
  distanceKm: round2((row.distanceMeters || 0) / 1000),
});

/// Rental spend in the range, read defensively (see corporateInvoiceService).
const rentalSummary = async ({ corporateId, from, to }) => {
  try {
    const [row] = await RentalBookingRequest.collection.aggregate([
      {
        $match: {
          corporateId: toObjectId(corporateId),
          billingMode: { $in: ['corporate', null] },
          status: 'completed',
          updatedAt: { $gte: from, $lt: to },
        },
      },
      { $group: { _id: null, trips: { $sum: 1 }, gross: { $sum: { $ifNull: ['$totalCost', 0] } }, spend: { $sum: { $ifNull: ['$corporateBilledAmount', { $ifNull: ['$totalCost', 0] }] } } } },
    ]).toArray();
    return row ? { trips: row.trips, spend: round2(row.spend), gross: round2(row.gross) } : { trips: 0, spend: 0, gross: 0 };
  } catch {
    return { trips: 0, spend: 0, gross: 0 };
  }
};

export const getCorporateUsageAnalytics = async ({ corporateId, from, to }) => {
  const range = resolveReportRange({ from, to });
  const match = baseMatch({ corporateId, ...range });

  const [facet] = await Ride.aggregate([
    { $match: match },
    {
      $facet: {
        totals: [{ $group: { _id: null, ...sumFields } }],
        byService: [{ $group: { _id: '$serviceType', ...sumFields } }, { $sort: { spend: -1 } }],
        byMonth: [
          { $group: { _id: { $dateToString: { format: '%Y-%m', date: '$completedAt', timezone: 'Asia/Kolkata' } }, ...sumFields } },
          { $sort: { _id: 1 } },
        ],
        byDay: [
          { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$completedAt', timezone: 'Asia/Kolkata' } }, ...sumFields } },
          { $sort: { _id: 1 } },
        ],
        byDepartment: [{ $group: { _id: '$corporate.departmentId', ...sumFields } }, { $sort: { spend: -1 } }],
        byEmployee: [{ $group: { _id: '$corporate.employeeId', ...sumFields } }, { $sort: { spend: -1 } }, { $limit: 25 }],
        topRoutes: [
          { $group: { _id: { pickup: '$pickupAddress', drop: '$dropAddress' }, ...sumFields } },
          { $sort: { trips: -1, spend: -1 } },
          { $limit: 10 },
        ],
      },
    },
  ]);

  const departmentIds = (facet?.byDepartment || []).map((row) => row._id).filter(Boolean);
  const employeeIds = (facet?.byEmployee || []).map((row) => row._id).filter(Boolean);
  const [departments, employees, corporate, pendingApprovals, rental] = await Promise.all([
    CorporateDepartment.find({ _id: { $in: departmentIds } }).select('name code monthlyBudget').lean(),
    CorporateEmployee.find({ _id: { $in: employeeIds } }).select('name employeeCode phone').lean(),
    Corporate.findById(corporateId).select('currentOutstanding creditLimit name').lean(),
    CorporateTripRequest.countDocuments({ corporateId, status: 'pending' }),
    rentalSummary({ corporateId, ...range }),
  ]);
  const departmentById = new Map(departments.map((item) => [String(item._id), item]));
  const employeeById = new Map(employees.map((item) => [String(item._id), item]));

  const totals = shapeRow(facet?.totals?.[0] || {});
  return {
    range,
    totals: {
      ...totals,
      rentalTrips: rental.trips,
      rentalSpend: rental.spend,
      totalSpend: round2(totals.spend + rental.spend),
    },
    outstanding: round2(corporate?.currentOutstanding || 0),
    creditLimit: corporate?.creditLimit || 0,
    creditAvailable: round2(Math.max(0, (corporate?.creditLimit || 0) - (corporate?.currentOutstanding || 0))),
    pendingApprovals,
    byService: [
      ...(facet?.byService || []).map((row) => ({ serviceType: row._id || 'ride', ...shapeRow(row) })),
      ...(rental.trips ? [{ serviceType: 'rental', trips: rental.trips, spend: rental.spend, gross: rental.gross, discount: round2(rental.gross - rental.spend), avgFare: round2(rental.spend / rental.trips), distanceKm: 0 }] : []),
    ],
    byMonth: (facet?.byMonth || []).map((row) => ({ month: row._id, ...shapeRow(row) })),
    byDay: (facet?.byDay || []).map((row) => ({ day: row._id, ...shapeRow(row) })),
    byDepartment: (facet?.byDepartment || []).map((row) => {
      const department = row._id ? departmentById.get(String(row._id)) : null;
      return { departmentId: row._id ? String(row._id) : null, name: department?.name || 'Unassigned', code: department?.code || '', ...shapeRow(row) };
    }),
    byEmployee: (facet?.byEmployee || []).map((row) => {
      const employee = employeeById.get(String(row._id));
      return { employeeId: String(row._id), name: employee?.name || '-', employeeCode: employee?.employeeCode || '', ...shapeRow(row) };
    }),
    topRoutes: (facet?.topRoutes || []).map((row) => ({ pickup: row._id?.pickup || '', drop: row._id?.drop || '', ...shapeRow(row) })),
  };
};

/// One row per department (including ones with no trips) with budget use.
export const getDepartmentReport = async ({ corporateId, from, to }) => {
  const range = resolveReportRange({ from, to });
  const [rows, departments, employeeCounts] = await Promise.all([
    Ride.aggregate([
      { $match: baseMatch({ corporateId, ...range }) },
      { $group: { _id: '$corporate.departmentId', ...sumFields, employees: { $addToSet: '$corporate.employeeId' } } },
    ]),
    CorporateDepartment.find({ corporateId }).lean(),
    CorporateEmployee.aggregate([
      { $match: { corporateId: toObjectId(corporateId), active: true } },
      { $group: { _id: '$departmentId', count: { $sum: 1 } } },
    ]),
  ]);
  const rowById = new Map(rows.map((row) => [String(row._id), row]));
  const countById = new Map(employeeCounts.map((row) => [String(row._id), row.count]));

  const result = departments.map((department) => {
    const row = rowById.get(String(department._id)) || {};
    const shaped = shapeRow(row);
    return {
      departmentId: String(department._id),
      name: department.name,
      code: department.code,
      costCenter: department.costCenter,
      monthlyBudget: department.monthlyBudget,
      budgetUsedPercent: department.monthlyBudget ? round2((shaped.spend / department.monthlyBudget) * 100) : null,
      activeEmployees: countById.get(String(department._id)) || 0,
      travellingEmployees: (row.employees || []).length,
      ...shaped,
    };
  });
  const unassigned = rowById.get('null');
  if (unassigned) {
    result.push({ departmentId: null, name: 'Unassigned', code: '', costCenter: '', monthlyBudget: 0, budgetUsedPercent: null, activeEmployees: countById.get('null') || 0, travellingEmployees: (unassigned.employees || []).length, ...shapeRow(unassigned) });
  }
  return { range, departments: result.sort((a, b) => b.spend - a.spend) };
};

export const getEmployeeReport = async ({ corporateId, from, to, departmentId = null }) => {
  const range = resolveReportRange({ from, to });
  const rows = await Ride.aggregate([
    { $match: baseMatch({ corporateId, ...range, departmentId }) },
    { $group: { _id: '$corporate.employeeId', ...sumFields } },
    { $sort: { spend: -1 } },
  ]);
  const employees = await CorporateEmployee.find({ _id: { $in: rows.map((row) => row._id) } }).populate('departmentId', 'name').lean();
  const byId = new Map(employees.map((item) => [String(item._id), item]));
  return {
    range,
    employees: rows.map((row) => {
      const employee = byId.get(String(row._id));
      return {
        employeeId: String(row._id),
        name: employee?.name || '-',
        employeeCode: employee?.employeeCode || '',
        phone: employee?.phone || '',
        department: employee?.departmentId?.name || 'Unassigned',
        monthlyLimit: employee?.monthlyLimit || 0,
        ...shapeRow(row),
      };
    }),
  };
};

export const listCorporateTrips = async ({ corporateId, from, to, departmentId = null, employeeId = null, status = '', page = 1, limit = 25 }) => {
  const range = resolveReportRange({ from, to });
  const filter = {
    'corporate.corporateId': toObjectId(corporateId),
    paymentMethod: 'corporate',
    createdAt: { $gte: range.from, $lt: range.to },
  };
  if (status) filter.status = status;
  if (departmentId) filter['corporate.departmentId'] = toObjectId(departmentId);
  if (employeeId) filter['corporate.employeeId'] = toObjectId(employeeId);

  const safeLimit = Math.min(500, Math.max(1, Number(limit) || 25));
  const safePage = Math.max(1, Number(page) || 1);
  const [rides, total] = await Promise.all([
    Ride.find(filter)
      .select('_id serviceType status liveStatus fare pickupAddress dropAddress createdAt completedAt scheduledAt estimatedDistanceMeters actualDistanceMeters actualDistanceSource corporate vehicleTypeId')
      .sort({ createdAt: -1 })
      .skip((safePage - 1) * safeLimit)
      .limit(safeLimit)
      .populate('corporate.employeeId', 'name employeeCode phone')
      .populate('corporate.departmentId', 'name code')
      .lean(),
    Ride.countDocuments(filter),
  ]);

  return {
    range,
    total,
    page: safePage,
    limit: safeLimit,
    items: rides.map((ride) => ({
      rideId: String(ride._id),
      serviceType: ride.serviceType,
      status: ride.status,
      liveStatus: ride.liveStatus,
      pickupAddress: ride.pickupAddress,
      dropAddress: ride.dropAddress,
      createdAt: ride.createdAt,
      completedAt: ride.completedAt,
      scheduledAt: ride.scheduledAt,
      distanceKm: round2((ride.estimatedDistanceMeters || 0) / 1000),
      grossFare: round2(ride.fare),
      discountAmount: round2(ride.corporate?.discountAmount),
      billedAmount: round2(ride.corporate?.billedAmount),
      approvalStatus: ride.corporate?.approvalStatus || 'not_required',
      invoiceId: ride.corporate?.invoiceId ? String(ride.corporate.invoiceId) : null,
      // Corporate v2
      actualKm: ride.actualDistanceMeters !== null && ride.actualDistanceMeters !== undefined ? round2(ride.actualDistanceMeters / 1000) : null,
      actualDistanceSource: ride.actualDistanceSource || null,
      pricing: ride.corporate?.pricing || 'standard',
      split: ride.corporate?.split || null,
      allowance: ride.corporate?.allowance || null,
      bookedByCorporateAdminId: ride.corporate?.bookedByCorporateAdminId ? String(ride.corporate.bookedByCorporateAdminId) : null,
      employee: ride.corporate?.employeeId
        ? { id: String(ride.corporate.employeeId._id || ride.corporate.employeeId), name: ride.corporate.employeeId.name || '', employeeCode: ride.corporate.employeeId.employeeCode || '' }
        : null,
      department: ride.corporate?.departmentId?.name ? { id: String(ride.corporate.departmentId._id), name: ride.corporate.departmentId.name } : null,
    })),
  };
};

export const tripsToCsv = (items) =>
  toCsv(
    [
      { label: 'Ride ID', key: 'rideId' },
      { label: 'Created', value: (row) => row.createdAt },
      { label: 'Completed', value: (row) => row.completedAt || '' },
      { label: 'Employee', value: (row) => row.employee?.name || '' },
      { label: 'Employee Code', value: (row) => row.employee?.employeeCode || '' },
      { label: 'Department', value: (row) => row.department?.name || '' },
      { label: 'Service', key: 'serviceType' },
      { label: 'Status', key: 'status' },
      { label: 'Pickup', key: 'pickupAddress' },
      { label: 'Drop', key: 'dropAddress' },
      { label: 'Distance (km)', key: 'distanceKm' },
      { label: 'Gross Fare', key: 'grossFare' },
      { label: 'Discount', key: 'discountAmount' },
      { label: 'Billed', key: 'billedAmount' },
      { label: 'Approval', key: 'approvalStatus' },
    ],
    items,
  );

export const departmentsToCsv = (departments) =>
  toCsv(
    [
      { label: 'Department', key: 'name' },
      { label: 'Code', key: 'code' },
      { label: 'Cost Centre', key: 'costCenter' },
      { label: 'Active Employees', key: 'activeEmployees' },
      { label: 'Travelling Employees', key: 'travellingEmployees' },
      { label: 'Trips', key: 'trips' },
      { label: 'Gross', key: 'gross' },
      { label: 'Discount', key: 'discount' },
      { label: 'Spend', key: 'spend' },
      { label: 'Average Fare', key: 'avgFare' },
      { label: 'Monthly Budget', key: 'monthlyBudget' },
      { label: 'Budget Used %', value: (row) => (row.budgetUsedPercent === null ? '' : row.budgetUsedPercent) },
    ],
    departments,
  );

export const employeesToCsv = (employees) =>
  toCsv(
    [
      { label: 'Employee', key: 'name' },
      { label: 'Employee Code', key: 'employeeCode' },
      { label: 'Phone', key: 'phone' },
      { label: 'Department', key: 'department' },
      { label: 'Trips', key: 'trips' },
      { label: 'Spend', key: 'spend' },
      { label: 'Average Fare', key: 'avgFare' },
      { label: 'Monthly Limit', key: 'monthlyLimit' },
    ],
    employees,
  );
