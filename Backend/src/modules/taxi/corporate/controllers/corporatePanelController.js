import { ApiError } from '../../../../utils/ApiError.js';
import { CorporateEmployee } from '../models/CorporateEmployee.js';
import {
  changeCorporatePassword,
  loginWithPassword,
  sendLoginOtp,
  serializeCorporateAdmin,
  serializeCorporateSummary,
  verifyLoginOtp,
} from '../services/corporateAuthService.js';
import { approveTripRequest, listTripRequests, rejectTripRequest } from '../services/corporateApprovalService.js';
import {
  EMPLOYEE_IMPORT_TEMPLATE_CSV,
  createCorporateEmployee,
  deactivateCorporateEmployee,
  importCorporateEmployees,
  inviteCorporateEmployee,
  listCorporateEmployees,
  updateCorporateEmployee,
} from '../services/corporateEmployeeService.js';
import {
  buildCorporateInvoicePdf,
  createInvoicePaymentLink,
  getAgingReport,
  getCorporateInvoice,
  listCorporateInvoices,
  syncInvoicePaymentLink,
} from '../services/corporateInvoiceService.js';
import { listCorporateLedger } from '../services/corporateLedger.js';
import {
  departmentsToCsv,
  employeesToCsv,
  getCorporateUsageAnalytics,
  getDepartmentReport,
  getEmployeeReport,
  listCorporateTrips,
  tripsToCsv,
} from '../services/corporateReportService.js';
import {
  createCorporateAdminUser,
  createDepartment,
  deleteDepartment,
  deletePolicy,
  listCorporateAdmins,
  listDepartments,
  listPolicies,
  registerCorporate,
  updateCorporateAdminUser,
  updateCorporateProfile,
  updateDepartment,
  upsertPolicy,
} from '../services/corporateService.js';

const ok = (res, data, status = 200) => res.status(status).json({ success: true, data });

const sendCsv = (res, filename, csv) => {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(`﻿${csv}`);
};

const wantsCsv = (req) => String(req.query.format || '').toLowerCase() === 'csv';

// --- public ----------------------------------------------------------------

export const register = async (req, res) => ok(res, await registerCorporate(req.body), 201);
export const login = async (req, res) => ok(res, await loginWithPassword(req.body || {}));
export const sendOtp = async (req, res) => ok(res, await sendLoginOtp(req.body || {}));
export const verifyOtp = async (req, res) => ok(res, await verifyLoginOtp(req.body || {}));

// --- session ---------------------------------------------------------------

export const getMe = async (req, res) =>
  ok(res, {
    admin: serializeCorporateAdmin(req.corporateAdmin),
    corporate: { ...serializeCorporateSummary(req.corporate), ...req.corporate.toObject() },
  });

export const changePassword = async (req, res) =>
  ok(res, await changeCorporatePassword({ adminId: req.corporateAdmin._id, ...req.body }));

export const updateProfile = async (req, res) =>
  ok(res, await updateCorporateProfile({ corporateId: req.corporate._id, body: req.body }));

export const getDashboard = async (req, res) => {
  const [usage, aging] = await Promise.all([
    getCorporateUsageAnalytics({ corporateId: req.corporate._id, from: req.query.from, to: req.query.to }),
    getAgingReport({ corporateId: req.corporate._id }),
  ]);
  ok(res, { ...usage, aging: { buckets: aging.buckets, totalDue: aging.totalDue } });
};

// --- employees -------------------------------------------------------------

export const listEmployees = async (req, res) => ok(res, await listCorporateEmployees({ corporateId: req.corporate._id, ...req.query }));

export const getEmployee = async (req, res) => {
  const employee = await CorporateEmployee.findOne({ _id: req.params.employeeId, corporateId: req.corporate._id })
    .populate('departmentId', 'name code')
    .lean();
  if (!employee) throw new ApiError(404, 'Employee not found');
  ok(res, employee);
};

export const createEmployee = async (req, res) =>
  ok(res, await createCorporateEmployee({ corporate: req.corporate, body: req.body, invite: req.body?.sendInvite === true }), 201);

export const updateEmployee = async (req, res) =>
  ok(res, await updateCorporateEmployee({ corporate: req.corporate, employeeId: req.params.employeeId, body: req.body }));

export const deactivateEmployee = async (req, res) =>
  ok(res, await deactivateCorporateEmployee({ corporate: req.corporate, employeeId: req.params.employeeId }));

export const inviteEmployee = async (req, res) =>
  ok(res, await inviteCorporateEmployee({ corporate: req.corporate, employeeId: req.params.employeeId }));

export const importEmployees = async (req, res) => ok(res, await importCorporateEmployees({ corporate: req.corporate, body: req.body }));

export const employeeImportTemplate = async (_req, res) => sendCsv(res, 'employee-import-template.csv', EMPLOYEE_IMPORT_TEMPLATE_CSV);

// --- departments & policies -----------------------------------------------

export const getDepartments = async (req, res) => ok(res, await listDepartments({ corporateId: req.corporate._id }));
export const postDepartment = async (req, res) => ok(res, await createDepartment({ corporateId: req.corporate._id, body: req.body }), 201);
export const patchDepartment = async (req, res) =>
  ok(res, await updateDepartment({ corporateId: req.corporate._id, departmentId: req.params.departmentId, body: req.body }));
export const removeDepartment = async (req, res) =>
  ok(res, await deleteDepartment({ corporateId: req.corporate._id, departmentId: req.params.departmentId }));

export const getPolicies = async (req, res) => ok(res, await listPolicies({ corporateId: req.corporate._id }));
export const putCompanyPolicy = async (req, res) => ok(res, await upsertPolicy({ corporateId: req.corporate._id, body: req.body }));
export const putDepartmentPolicy = async (req, res) =>
  ok(res, await upsertPolicy({ corporateId: req.corporate._id, departmentId: req.params.departmentId, body: req.body }));
export const removePolicy = async (req, res) => ok(res, await deletePolicy({ corporateId: req.corporate._id, policyId: req.params.policyId }));

// --- approvals -------------------------------------------------------------

export const getTripRequests = async (req, res) =>
  ok(res, await listTripRequests({ admin: req.corporateAdmin, corporateId: req.corporate._id, ...req.query }));
export const approveTrip = async (req, res) =>
  ok(res, await approveTripRequest({ admin: req.corporateAdmin, tripRequestId: req.params.tripRequestId, note: req.body?.note }));
export const rejectTrip = async (req, res) =>
  ok(res, await rejectTripRequest({ admin: req.corporateAdmin, tripRequestId: req.params.tripRequestId, note: req.body?.note }));

// --- trips & reports -------------------------------------------------------

export const getTrips = async (req, res) => {
  const result = await listCorporateTrips({ corporateId: req.corporate._id, ...req.query, limit: wantsCsv(req) ? 5000 : req.query.limit });
  if (wantsCsv(req)) return sendCsv(res, 'corporate-trips.csv', tripsToCsv(result.items));
  return ok(res, result);
};

export const getUsageReport = async (req, res) =>
  ok(res, await getCorporateUsageAnalytics({ corporateId: req.corporate._id, from: req.query.from, to: req.query.to }));

export const getDepartmentsReport = async (req, res) => {
  const result = await getDepartmentReport({ corporateId: req.corporate._id, from: req.query.from, to: req.query.to });
  if (wantsCsv(req)) return sendCsv(res, 'department-report.csv', departmentsToCsv(result.departments));
  return ok(res, result);
};

export const getEmployeesReport = async (req, res) => {
  const result = await getEmployeeReport({ corporateId: req.corporate._id, ...req.query });
  if (wantsCsv(req)) return sendCsv(res, 'employee-report.csv', employeesToCsv(result.employees));
  return ok(res, result);
};

export const getOutstanding = async (req, res) => {
  const [aging, ledger] = await Promise.all([
    getAgingReport({ corporateId: req.corporate._id }),
    listCorporateLedger({ corporateId: req.corporate._id, page: req.query.page, limit: req.query.limit }),
  ]);
  ok(res, {
    currentOutstanding: req.corporate.currentOutstanding,
    creditLimit: req.corporate.creditLimit,
    aging,
    ledger,
  });
};

// --- invoices --------------------------------------------------------------

/// Drafts are the platform's working copies; the company sees an invoice once
/// it has been issued.
export const getInvoices = async (req, res) => {
  const result = await listCorporateInvoices({ corporateId: req.corporate._id, ...req.query });
  result.items = result.items.filter((invoice) => invoice.status !== 'draft');
  ok(res, result);
};

const loadVisibleInvoice = async (req) => {
  const invoice = await getCorporateInvoice({ invoiceId: req.params.invoiceId, corporateId: req.corporate._id });
  if (invoice.status === 'draft') throw new ApiError(404, 'Invoice not found');
  return invoice;
};

export const getInvoice = async (req, res) => ok(res, await loadVisibleInvoice(req));

export const downloadInvoicePdf = async (req, res) => {
  await loadVisibleInvoice(req);
  const { buffer, filename } = await buildCorporateInvoicePdf({ invoiceId: req.params.invoiceId, corporateId: req.corporate._id });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(buffer);
};

export const payInvoice = async (req, res) => {
  await loadVisibleInvoice(req);
  ok(res, await createInvoicePaymentLink({ invoiceId: req.params.invoiceId, corporateId: req.corporate._id }));
};

export const syncInvoicePayment = async (req, res) => {
  await loadVisibleInvoice(req);
  ok(res, await syncInvoicePaymentLink({ invoiceId: req.params.invoiceId }));
};

// --- panel users -----------------------------------------------------------

export const getAdmins = async (req, res) => ok(res, await listCorporateAdmins({ corporateId: req.corporate._id }));
export const postAdmin = async (req, res) =>
  ok(res, await createCorporateAdminUser({ corporateId: req.corporate._id, body: req.body, actorRole: req.corporateAdmin.role }), 201);
export const patchAdmin = async (req, res) =>
  ok(res, await updateCorporateAdminUser({ corporateId: req.corporate._id, adminUserId: req.params.adminUserId, body: req.body, actor: req.corporateAdmin }));
