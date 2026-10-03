import { ApiError } from '../../../../utils/ApiError.js';
import { Corporate } from '../models/Corporate.js';
import { listDepartments } from '../services/corporateService.js';
import {
  adjustCorporateOutstandingByAdmin,
  approveCorporate,
  createCorporateByAdmin,
  createCorporateFromEnquiry,
  getCorporateDetail,
  listCorporates,
  rejectCorporate,
  suspendCorporate,
  updateCorporateByAdmin,
} from '../services/corporateService.js';
import {
  createCorporateEmployee,
  importCorporateEmployees,
  listCorporateEmployees,
  updateCorporateEmployee,
} from '../services/corporateEmployeeService.js';
import {
  buildCorporateInvoicePdf,
  createInvoicePaymentLink,
  emailCorporateInvoice,
  generateCorporateInvoice,
  getAgingReport,
  getCorporateInvoice,
  issueCorporateInvoice,
  listCorporateInvoices,
  recordCorporateInvoicePayment,
  syncInvoicePaymentLink,
  voidCorporateInvoice,
} from '../services/corporateInvoiceService.js';
import { listCorporateLedger, recomputeCorporateOutstanding } from '../services/corporateLedger.js';
import { getCorporateUsageAnalytics, listCorporateTrips, tripsToCsv } from '../services/corporateReportService.js';
import { listTripRequests } from '../services/corporateApprovalService.js';
import { getCorporateSettings, updateCorporateSettings } from '../services/corporateSettingsService.js';

const ok = (res, data, status = 200) => res.status(status).json({ success: true, data });
const adminId = (req) => req.auth?.admin?.id || req.auth?.sub || null;
const adminLabel = (req) => req.auth?.admin?.email || req.auth?.admin?.name || 'admin';

const loadCorporate = async (id) => {
  const corporate = await Corporate.findById(id);
  if (!corporate) throw new ApiError(404, 'Corporate not found');
  return corporate;
};

export const list = async (req, res) => ok(res, await listCorporates(req.query));
export const create = async (req, res) => ok(res, await createCorporateByAdmin({ adminId: adminId(req), body: req.body }), 201);
export const fromEnquiry = async (req, res) =>
  ok(res, await createCorporateFromEnquiry({ adminId: adminId(req), enquiryId: req.params.enquiryId, body: req.body }), 201);
export const detail = async (req, res) => ok(res, await getCorporateDetail({ corporateId: req.params.id }));
export const update = async (req, res) => ok(res, await updateCorporateByAdmin({ corporateId: req.params.id, body: req.body }));
export const approve = async (req, res) => ok(res, await approveCorporate({ adminId: adminId(req), corporateId: req.params.id, body: req.body }));
export const reject = async (req, res) => ok(res, await rejectCorporate({ corporateId: req.params.id, reason: req.body?.reason }));
export const suspend = async (req, res) => ok(res, await suspendCorporate({ corporateId: req.params.id, reason: req.body?.reason, suspend: true }));
export const reactivate = async (req, res) => ok(res, await suspendCorporate({ corporateId: req.params.id, suspend: false }));

export const getSettings = async (_req, res) => ok(res, await getCorporateSettings());
export const patchSettings = async (req, res) => ok(res, await updateCorporateSettings(req.body));

export const employees = async (req, res) => ok(res, await listCorporateEmployees({ corporateId: req.params.id, ...req.query }));
export const addEmployee = async (req, res) =>
  ok(res, await createCorporateEmployee({ corporate: await loadCorporate(req.params.id), body: req.body, invite: req.body?.sendInvite === true }), 201);
export const editEmployee = async (req, res) =>
  ok(res, await updateCorporateEmployee({ corporate: await loadCorporate(req.params.id), employeeId: req.params.employeeId, body: req.body }));
export const importEmployees = async (req, res) =>
  ok(res, await importCorporateEmployees({ corporate: await loadCorporate(req.params.id), body: req.body }));
export const departments = async (req, res) => ok(res, await listDepartments({ corporateId: req.params.id }));
export const tripRequests = async (req, res) => ok(res, await listTripRequests({ corporateId: req.params.id, ...req.query }));

export const trips = async (req, res) => {
  const csv = String(req.query.format || '').toLowerCase() === 'csv';
  const result = await listCorporateTrips({ corporateId: req.params.id, ...req.query, limit: csv ? 5000 : req.query.limit });
  if (csv) {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="corporate-trips.csv"');
    return res.send(`﻿${tripsToCsv(result.items)}`);
  }
  return ok(res, result);
};

export const usage = async (req, res) =>
  ok(res, await getCorporateUsageAnalytics({ corporateId: req.params.id, from: req.query.from, to: req.query.to }));

export const ledger = async (req, res) => ok(res, await listCorporateLedger({ corporateId: req.params.id, ...req.query }));
export const adjustLedger = async (req, res) =>
  ok(res, await adjustCorporateOutstandingByAdmin({ adminId: adminId(req), corporateId: req.params.id, amount: req.body?.amount, note: req.body?.note }));
export const recomputeLedger = async (req, res) => ok(res, { currentOutstanding: await recomputeCorporateOutstanding(req.params.id) });

export const aging = async (req, res) => ok(res, await getAgingReport({ corporateId: req.query.corporateId || null }));

export const corporateInvoices = async (req, res) => ok(res, await listCorporateInvoices({ corporateId: req.params.id, ...req.query }));
export const allInvoices = async (req, res) => ok(res, await listCorporateInvoices({ corporateId: req.query.corporateId || null, ...req.query }));

export const generateInvoice = async (req, res) => {
  const { from, to, periodKey } = req.body || {};
  const invoice = await generateCorporateInvoice({ corporateId: req.params.id, from, to, periodKey, generatedBy: adminLabel(req) });
  if (req.body?.issue === true) {
    return ok(res, await issueCorporateInvoice({ invoiceId: invoice._id, email: req.body?.email === true }), 201);
  }
  return ok(res, invoice, 201);
};

export const invoice = async (req, res) => ok(res, await getCorporateInvoice({ invoiceId: req.params.invoiceId }));
export const invoicePdf = async (req, res) => {
  const { buffer, filename } = await buildCorporateInvoicePdf({ invoiceId: req.params.invoiceId });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(buffer);
};
export const issueInvoice = async (req, res) => ok(res, await issueCorporateInvoice({ invoiceId: req.params.invoiceId, email: req.body?.email === true }));
export const emailInvoice = async (req, res) => ok(res, await emailCorporateInvoice({ invoiceId: req.params.invoiceId, to: req.body?.to }));
export const recordPayment = async (req, res) =>
  ok(res, await recordCorporateInvoicePayment({ invoiceId: req.params.invoiceId, ...req.body, recordedBy: adminLabel(req) }));
export const voidInvoice = async (req, res) => ok(res, await voidCorporateInvoice({ invoiceId: req.params.invoiceId, reason: req.body?.reason }));
export const paymentLink = async (req, res) => ok(res, await createInvoicePaymentLink({ invoiceId: req.params.invoiceId }));
export const syncPaymentLink = async (req, res) => ok(res, await syncInvoicePaymentLink({ invoiceId: req.params.invoiceId }));
