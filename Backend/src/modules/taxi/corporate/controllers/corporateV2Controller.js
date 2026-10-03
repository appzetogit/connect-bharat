import mongoose from 'mongoose';
import { ApiError } from '../../../../utils/ApiError.js';
import { Corporate } from '../models/Corporate.js';
import {
  assignEmployeesToRole,
  createCorporateRole,
  deleteCorporateRole,
  listCorporateRoles,
  makeRoleDefault,
  updateCorporateRole,
} from '../services/corporateRoleService.js';
import { getEmployeeAllowance } from '../services/corporateEmployeeService.js';
import { listCompanyAllowanceUsage, serializeUsage } from '../services/corporateAllowanceService.js';
import { getCorporateTravelZone, updateCorporateTravelZone } from '../services/corporateService.js';
import {
  cancelTravelDeskBooking,
  createTravelDeskBooking,
  listTravelDeskBookings,
  quoteTravelDeskBooking,
} from '../services/corporateTravelDeskService.js';
import { getCorporateInvoice } from '../services/corporateInvoiceService.js';
import { exportFilename, invoiceAnnexToCsv, invoiceAnnexToXlsx } from '../services/corporateInvoiceExport.js';
import { getAllowancePeriodKey } from '../services/corporateV2Rules.js';
import { serializeRoleRef } from '../services/corporateRoleService.js';

/// Corporate v2 endpoints (docs/plans/corporate-v2.md §3), panel and admin.
/// Panel handlers take the company from `req.corporate`; admin handlers from
/// `:id`.

const ok = (res, data, status = 200) => res.status(status).json({ success: true, data });

const adminCorporateId = async (req) => {
  if (!mongoose.Types.ObjectId.isValid(String(req.params.id))) throw new ApiError(400, 'Invalid corporate id');
  const exists = await Corporate.exists({ _id: req.params.id });
  if (!exists) throw new ApiError(404, 'Corporate not found');
  return req.params.id;
};

// --- roles (panel + admin share the handlers through `corporateIdOf`) -------

const roleHandlers = (corporateIdOf) => ({
  list: async (req, res) => ok(res, await listCorporateRoles({ corporateId: await corporateIdOf(req) })),
  create: async (req, res) => ok(res, await createCorporateRole({ corporateId: await corporateIdOf(req), body: req.body }), 201),
  update: async (req, res) => ok(res, await updateCorporateRole({ corporateId: await corporateIdOf(req), roleId: req.params.roleId, body: req.body })),
  remove: async (req, res) =>
    ok(res, await deleteCorporateRole({
      corporateId: await corporateIdOf(req),
      roleId: req.params.roleId,
      reassignToRoleId: req.query.reassignToRoleId || req.body?.reassignToRoleId || null,
    })),
  makeDefault: async (req, res) => ok(res, await makeRoleDefault({ corporateId: await corporateIdOf(req), roleId: req.params.roleId })),
  assign: async (req, res) =>
    ok(res, await assignEmployeesToRole({ corporateId: await corporateIdOf(req), roleId: req.params.roleId, employeeIds: req.body?.employeeIds })),
});

export const panelRoles = roleHandlers(async (req) => req.corporate._id);
export const adminRoles = roleHandlers(adminCorporateId);

// --- panel ------------------------------------------------------------------

export const employeeAllowance = async (req, res) =>
  ok(res, await getEmployeeAllowance({ corporateId: req.corporate._id, employeeId: req.params.employeeId, periods: req.query.periods }));

export const getTravelZone = async (req, res) => ok(res, getCorporateTravelZone(req.corporate));
export const putTravelZone = async (req, res) => ok(res, await updateCorporateTravelZone({ corporateId: req.corporate._id, body: req.body }));

export const quoteBooking = async (req, res) => ok(res, await quoteTravelDeskBooking({ corporate: req.corporate, body: req.body }));
export const createBooking = async (req, res) =>
  ok(res, await createTravelDeskBooking({ corporate: req.corporate, admin: req.corporateAdmin, body: req.body }), 201);
export const listBookings = async (req, res) => ok(res, await listTravelDeskBookings({ corporateId: req.corporate._id, ...req.query }));
export const cancelBooking = async (req, res) =>
  ok(res, await cancelTravelDeskBooking({ corporate: req.corporate, admin: req.corporateAdmin, rideId: req.params.rideId, reason: req.body?.reason }));

// --- invoice exports ----------------------------------------------------------

const sendInvoiceExport = async (res, invoice, format) => {
  if (format === 'xlsx') {
    const buffer = await invoiceAnnexToXlsx(invoice);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${exportFilename(invoice, 'xlsx')}"`);
    return res.send(buffer);
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${exportFilename(invoice, 'csv')}"`);
  return res.send(`﻿${invoiceAnnexToCsv(invoice)}`);
};

const panelInvoice = async (req) => {
  const invoice = await getCorporateInvoice({ invoiceId: req.params.invoiceId, corporateId: req.corporate._id });
  if (invoice.status === 'draft') throw new ApiError(404, 'Invoice not found');
  return invoice;
};

export const panelInvoiceCsv = async (req, res) => sendInvoiceExport(res, await panelInvoice(req), 'csv');
export const panelInvoiceXlsx = async (req, res) => sendInvoiceExport(res, await panelInvoice(req), 'xlsx');
export const adminInvoiceCsv = async (req, res) => sendInvoiceExport(res, await getCorporateInvoice({ invoiceId: req.params.invoiceId }), 'csv');
export const adminInvoiceXlsx = async (req, res) => sendInvoiceExport(res, await getCorporateInvoice({ invoiceId: req.params.invoiceId }), 'xlsx');

// --- admin allowance ----------------------------------------------------------

/// GET /admin/corporates/:id/allowance?periodKey= (contract §5). Defaults to
/// the current IST month.
export const adminAllowance = async (req, res) => {
  const corporateId = await adminCorporateId(req);
  const periodKey = String(req.query.periodKey || '').trim() || getAllowancePeriodKey('monthly', new Date());
  if (!/^\d{4}-(\d{2}|W\d{2})$/.test(periodKey)) throw new ApiError(400, 'periodKey must be YYYY-MM or YYYY-Www');
  const rows = await listCompanyAllowanceUsage({ corporateId, periodKey });
  ok(res, {
    periodKey,
    results: rows.map((row) => {
      const usage = serializeUsage(row, { period: row.period, periodKey: row.periodKey, allowanceKm: row.allowanceKm, enabled: true });
      return {
        employeeId: row.employeeId?._id ? String(row.employeeId._id) : String(row.employeeId || ''),
        name: row.employeeId?.name || '',
        employeeCode: row.employeeId?.employeeCode || '',
        role: row.roleId?._id ? serializeRoleRef(row.roleId) : null,
        period: usage.period,
        allowanceKm: usage.allowanceKm,
        usedKm: usage.usedKm,
        reservedKm: usage.reservedKm,
        remainingKm: usage.remainingKm,
        rides: usage.rides,
      };
    }),
  });
};
