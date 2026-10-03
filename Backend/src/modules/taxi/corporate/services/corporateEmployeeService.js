import ExcelJS from 'exceljs';
import mongoose from 'mongoose';
import { ApiError } from '../../../../utils/ApiError.js';
import { User } from '../../user/models/User.js';
import { CorporateDepartment } from '../models/CorporateDepartment.js';
import { CorporateEmployee } from '../models/CorporateEmployee.js';
import { sendEmployeeInvite } from './corporateNotifyService.js';
import { CorporateAllowanceUsage } from '../models/CorporateAllowanceUsage.js';
import { CorporateRole } from '../models/CorporateRole.js';
import { saveWithEmployeeCode } from './corporateEmployeeCodeService.js';
import { assertRoleId, buildRoleLookup, ensureCorporateRoles, getDefaultRole, serializeRoleRef } from './corporateRoleService.js';
import { listEmployeeAllowanceHistory, resolveRoleAllowance, serializeUsage } from './corporateAllowanceService.js';
import { getCorporateSettings } from './corporateSettingsService.js';
import { getAllowancePeriodKey, normalizeEmployeeCode } from './corporateV2Rules.js';
import {
  CORPORATE_SERVICE_TYPES,
  normalizeEmployeeImportRow,
  normalizeHeader,
  normalizeIndianPhone,
  parseCsv,
} from './corporatePolicyEngine.js';

/// Corporate employees (SOW 8.2): CRUD, bulk import, invites.

const MAX_IMPORT_ROWS = 2000;

const cleanServices = (list) =>
  Array.isArray(list) ? [...new Set(list.map((item) => String(item).trim().toLowerCase()).filter((item) => CORPORATE_SERVICE_TYPES.includes(item)))] : [];

/// Finds the rider account for a phone, creating one if the person has never
/// used the app. The account is an ordinary rider: they log in with OTP on
/// that number as anyone else does.
export const findOrCreateRiderForEmployee = async ({ phone, name, email }) => {
  const existing = await User.findOne({ phone });
  if (existing) return { user: existing, created: false };

  try {
    const user = await User.create({ phone, countryCode: '+91', name: name || 'Employee', email: email || '' });
    return { user, created: true };
  } catch (error) {
    // Another request created the same phone between the find and the create.
    if (error?.code === 11000) return { user: await User.findOne({ phone }), created: false };
    throw error;
  }
};

const assertDepartment = async (corporateId, departmentId) => {
  if (!departmentId) return null;
  if (!mongoose.Types.ObjectId.isValid(String(departmentId))) throw new ApiError(400, 'departmentId is invalid');
  const department = await CorporateDepartment.findOne({ _id: departmentId, corporateId }).select('_id').lean();
  if (!department) throw new ApiError(400, 'Department not found for this company');
  return department._id;
};

const duplicateError = (error) => {
  if (error?.code !== 11000) return error;
  const keys = JSON.stringify(error.keyPattern || error.keyValue || {});
  if (keys.includes('employeeCode')) return new ApiError(409, 'Another employee already uses this employee code');
  return new ApiError(409, 'Another employee already uses this phone');
};

const pickEmployeeFields = (body = {}) => {
  const fields = {};
  if (body.name !== undefined) fields.name = String(body.name || '').trim();
  if (body.email !== undefined) fields.email = String(body.email || '').trim().toLowerCase();
  if (body.employeeCode !== undefined) fields.employeeCode = normalizeEmployeeCode(body.employeeCode);
  if (body.designation !== undefined) fields.designation = String(body.designation || '').trim();
  if (body.monthlyLimit !== undefined) fields.monthlyLimit = Math.max(0, Number(body.monthlyLimit) || 0);
  if (body.requiresApproval !== undefined) fields.requiresApproval = body.requiresApproval === true || body.requiresApproval === 'true';
  if (body.allowedServices !== undefined) fields.allowedServices = cleanServices(body.allowedServices);
  return fields;
};

export const createCorporateEmployee = async ({ corporate, body = {}, invite = false }) => {
  const phone = normalizeIndianPhone(body.phone);
  if (!/^\d{10}$/.test(phone)) throw new ApiError(400, 'A valid 10-digit phone number is required');
  const fields = pickEmployeeFields(body);
  if (!fields.name) throw new ApiError(400, 'name is required');
  const departmentId = await assertDepartment(corporate._id, body.departmentId);
  await ensureCorporateRoles(corporate._id);
  const roleId = await assertRoleId(corporate._id, body.roleId);

  const existing = await CorporateEmployee.findOne({ corporateId: corporate._id, phone });
  if (existing?.active) throw new ApiError(409, 'An employee with this phone already exists');

  const { user } = await findOrCreateRiderForEmployee({ phone, name: fields.name, email: fields.email });
  // A blank code keeps the one a re-added employee already had, else one is generated.
  if (existing && !fields.employeeCode) delete fields.employeeCode;
  const doc = existing || new CorporateEmployee({ corporateId: corporate._id, phone });
  // Re-adding someone who was deactivated keeps their history on one record.
  doc.set({ ...fields, departmentId, userId: user._id, active: true, deactivatedAt: null, ...(roleId !== undefined ? { roleId } : {}) });
  let employee;
  try {
    employee = await saveWithEmployeeCode(doc, corporate);
  } catch (error) {
    throw duplicateError(error);
  }

  if (invite) {
    await inviteCorporateEmployee({ corporate, employeeId: employee._id });
  }
  return employee.toObject();
};

export const updateCorporateEmployee = async ({ corporate, employeeId, body = {} }) => {
  const employee = await CorporateEmployee.findOne({ _id: employeeId, corporateId: corporate._id });
  if (!employee) throw new ApiError(404, 'Employee not found');
  const fields = pickEmployeeFields(body);
  if (body.departmentId !== undefined) fields.departmentId = await assertDepartment(corporate._id, body.departmentId);
  if (body.roleId !== undefined) fields.roleId = await assertRoleId(corporate._id, body.roleId);
  // A blank code never wipes an existing one; it is generated if there is none.
  if (fields.employeeCode === '' && employee.employeeCode) delete fields.employeeCode;
  if (body.active !== undefined) {
    fields.active = body.active === true || body.active === 'true';
    fields.deactivatedAt = fields.active ? null : new Date();
  }
  if (body.phone !== undefined) {
    const phone = normalizeIndianPhone(body.phone);
    if (!/^\d{10}$/.test(phone)) throw new ApiError(400, 'A valid 10-digit phone number is required');
    if (phone !== employee.phone) {
      const { user } = await findOrCreateRiderForEmployee({ phone, name: fields.name || employee.name, email: fields.email || employee.email });
      fields.phone = phone;
      fields.userId = user._id;
    }
  }
  employee.set(fields);
  try {
    await saveWithEmployeeCode(employee, corporate);
  } catch (error) {
    throw duplicateError(error);
  }
  return employee.toObject();
};

export const deactivateCorporateEmployee = async ({ corporate, employeeId }) =>
  updateCorporateEmployee({ corporate, employeeId, body: { active: false } });

export const listCorporateEmployees = async ({ corporateId, search = '', departmentId = '', roleId = '', active = '', page = 1, limit = 25 }) => {
  const filter = { corporateId };
  const defaultRole = await getDefaultRole(corporateId);
  if (roleId && mongoose.Types.ObjectId.isValid(String(roleId))) {
    // Employees without a role book under the default one, so they match it.
    filter.roleId = defaultRole && String(defaultRole._id) === String(roleId) ? { $in: [roleId, null] } : roleId;
  }
  if (departmentId) filter.departmentId = departmentId === 'none' ? null : departmentId;
  if (active === 'true' || active === true) filter.active = true;
  if (active === 'false' || active === false) filter.active = false;
  const term = String(search || '').trim();
  if (term) {
    const pattern = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    filter.$or = [{ name: pattern }, { phone: pattern }, { email: pattern }, { employeeCode: pattern }];
  }
  const safeLimit = Math.min(200, Math.max(1, Number(limit) || 25));
  const safePage = Math.max(1, Number(page) || 1);
  const [items, total] = await Promise.all([
    CorporateEmployee.find(filter)
      .sort({ createdAt: -1 })
      .skip((safePage - 1) * safeLimit)
      .limit(safeLimit)
      .populate('departmentId', 'name code')
      .lean(),
    CorporateEmployee.countDocuments(filter),
  ]);
  return { items: await decorateEmployees(corporateId, items, defaultRole), total, page: safePage, limit: safeLimit };
};

/// Adds `role {id,name,code}` and the current-period `allowance` to employee
/// rows (contract §3.1).
export const decorateEmployees = async (corporateId, items, defaultRole = null) => {
  const roles = await CorporateRole.find({ corporateId }).lean();
  const roleById = new Map(roles.map((role) => [String(role._id), role]));
  const fallback = defaultRole || roles.find((role) => role.isDefault) || null;
  const settings = await getCorporateSettings();
  const now = new Date();
  const keyed = items.map((item) => {
    const role = (item.roleId && roleById.get(String(item.roleId?._id || item.roleId))) || fallback;
    const allowance = resolveRoleAllowance(role, settings);
    return { item, role, allowance, periodKey: getAllowancePeriodKey(allowance.period, now) };
  });
  const usages = keyed.length
    ? await CorporateAllowanceUsage.find({ $or: keyed.map(({ item, periodKey }) => ({ employeeId: item._id, periodKey })) }).lean()
    : [];
  const usageByKey = new Map(usages.map((usage) => [`${usage.employeeId}:${usage.periodKey}`, usage]));
  return keyed.map(({ item, role, allowance, periodKey }) => {
    const usage = serializeUsage(usageByKey.get(`${item._id}:${periodKey}`), { ...allowance, periodKey });
    return {
      ...item,
      role: serializeRoleRef(role),
      allowance: {
        enabled: usage.enabled,
        period: usage.period,
        periodKey: usage.periodKey,
        allowanceKm: usage.allowanceKm,
        usedKm: usage.usedKm,
        reservedKm: usage.reservedKm,
        remainingKm: usage.remainingKm,
      },
    };
  });
};

/// GET /employees/:id/allowance: this period and the last `periods`.
export const getEmployeeAllowance = async ({ corporateId, employeeId, periods = 6 }) => {
  if (!mongoose.Types.ObjectId.isValid(String(employeeId))) throw new ApiError(400, 'Invalid employee id');
  const employee = await CorporateEmployee.findOne({ _id: employeeId, corporateId }).lean();
  if (!employee) throw new ApiError(404, 'Employee not found');
  const [decorated] = await decorateEmployees(corporateId, [employee]);
  const history = await listEmployeeAllowanceHistory({ employeeId: employee._id, limit: periods });
  return {
    role: decorated.role,
    current: decorated.allowance,
    history: history.map((usage) => ({
      ...usage,
      ...serializeUsage(usage, { period: usage.period, periodKey: usage.periodKey, allowanceKm: usage.allowanceKm, enabled: true }),
    })),
  };
};

export const inviteCorporateEmployee = async ({ corporate, employeeId }) => {
  const employee = await CorporateEmployee.findOne({ _id: employeeId, corporateId: corporate._id });
  if (!employee) throw new ApiError(404, 'Employee not found');
  if (!employee.active) throw new ApiError(409, 'Employee is deactivated');
  const result = await sendEmployeeInvite({ employee, corporate });
  employee.invitedAt = new Date();
  await employee.save();
  return result;
};

/// Rows from `{ csv }` text, `{ rows: [...] }` objects, or `{ fileBase64 }`
/// holding an .xlsx/.csv file. The first sheet's first row is the header.
const readImportRows = async ({ csv, rows, fileBase64, fileName = '' }) => {
  if (Array.isArray(rows)) {
    return rows.map((row) => Object.fromEntries(Object.entries(row || {}).map(([key, value]) => [normalizeHeader(key), String(value ?? '').trim()])));
  }
  if (typeof csv === 'string' && csv.trim()) return parseCsv(csv);
  if (typeof fileBase64 === 'string' && fileBase64.trim()) {
    const buffer = Buffer.from(fileBase64.replace(/^data:[^,]+,/, ''), 'base64');
    if (/\.csv$/i.test(fileName)) return parseCsv(buffer.toString('utf8'));
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);
    const sheet = workbook.worksheets[0];
    if (!sheet) return [];
    const headers = [];
    const result = [];
    sheet.eachRow((row, rowNumber) => {
      const values = row.values.slice(1).map((value) => {
        if (value && typeof value === 'object') return String(value.text ?? value.result ?? value.richText?.map((part) => part.text).join('') ?? '');
        return String(value ?? '');
      });
      if (rowNumber === 1) headers.push(...values.map(normalizeHeader));
      else result.push(Object.fromEntries(headers.map((header, index) => [header, (values[index] || '').trim()])));
    });
    return result;
  }
  throw new ApiError(400, 'Provide csv text, rows, or fileBase64');
};

/// Bulk import. Valid rows are created or updated (matched on phone); invalid
/// rows are reported back by row number and nothing about them is saved.
/// Departments named in the sheet are matched by name or code, and created if
/// `createDepartments` is set.
export const importCorporateEmployees = async ({ corporate, body = {} }) => {
  const rawRows = await readImportRows(body);
  if (rawRows.length > MAX_IMPORT_ROWS) throw new ApiError(400, `At most ${MAX_IMPORT_ROWS} rows per import`);

  const departments = await CorporateDepartment.find({ corporateId: corporate._id }).lean();
  const departmentByKey = new Map();
  for (const department of departments) {
    departmentByKey.set(department.name.toLowerCase(), department._id);
    if (department.code) departmentByKey.set(department.code.toLowerCase(), department._id);
  }

  const findRole = await buildRoleLookup(corporate._id);
  const results = { created: 0, updated: 0, failed: 0, errors: [] };
  const seenPhones = new Set();
  const seenCodes = new Set();

  for (let index = 0; index < rawRows.length; index += 1) {
    const rowNumber = index + 2;
    const { errors, value } = normalizeEmployeeImportRow(rawRows[index]);
    if (!errors.length && seenPhones.has(value.phone)) errors.push('duplicate phone in this file');
    const employeeCode = normalizeEmployeeCode(value.employeeCode);
    if (!errors.length && employeeCode && seenCodes.has(employeeCode)) errors.push('duplicate employee code in this file');
    let role = null;
    if (!errors.length && value.roleKey) {
      role = findRole(value.roleKey);
      if (!role) errors.push(`role "${value.roleKey}" does not exist for this company (use an existing role code or name)`);
    }
    if (errors.length) {
      results.failed += 1;
      results.errors.push({ row: rowNumber, phone: value.phone, errors });
      continue;
    }
    seenPhones.add(value.phone);
    if (employeeCode) seenCodes.add(employeeCode);

    let departmentId = null;
    const departmentKey = (value.departmentCode || value.departmentName).toLowerCase();
    if (departmentKey) {
      departmentId = departmentByKey.get(departmentKey) || null;
      if (!departmentId && body.createDepartments && value.departmentName) {
        const created = await CorporateDepartment.create({ corporateId: corporate._id, name: value.departmentName, code: value.departmentCode });
        departmentId = created._id;
        departmentByKey.set(value.departmentName.toLowerCase(), created._id);
      }
      if (!departmentId) {
        results.failed += 1;
        results.errors.push({ row: rowNumber, phone: value.phone, errors: [`department "${value.departmentName || value.departmentCode}" not found`] });
        continue;
      }
    }

    try {
      const existing = await CorporateEmployee.findOne({ corporateId: corporate._id, phone: value.phone });
      const { user } = await findOrCreateRiderForEmployee(value);
      const fields = {
        name: value.name,
        email: value.email,
        ...(employeeCode ? { employeeCode } : {}),
        ...(role ? { roleId: role._id } : {}),
        designation: value.designation,
        monthlyLimit: value.monthlyLimit,
        requiresApproval: value.requiresApproval,
        allowedServices: value.allowedServices,
        departmentId,
        userId: user._id,
        active: true,
        deactivatedAt: null,
      };
      const doc = existing || new CorporateEmployee({ corporateId: corporate._id, phone: value.phone });
      doc.set(fields);
      let employee;
      try {
        employee = await saveWithEmployeeCode(doc, corporate);
      } catch (error) {
        throw duplicateError(error);
      }
      if (existing) results.updated += 1;
      else results.created += 1;
      if (body.sendInvites) {
        await sendEmployeeInvite({ employee, corporate }).catch(() => null);
        await CorporateEmployee.updateOne({ _id: employee._id }, { $set: { invitedAt: new Date() } });
      }
    } catch (error) {
      results.failed += 1;
      results.errors.push({ row: rowNumber, phone: value.phone, errors: [error.message] });
    }
  }

  return { total: rawRows.length, ...results };
};

export const EMPLOYEE_IMPORT_TEMPLATE_CSV = [
  'Name,Phone,Email,Employee Code,Role Code,Department,Designation,Monthly Limit,Requires Approval,Allowed Services',
  'Asha Rao,9876543210,asha@example.com,,EMP,Sales,Manager,5000,no,"ride,intercity"',
].join('\n');
