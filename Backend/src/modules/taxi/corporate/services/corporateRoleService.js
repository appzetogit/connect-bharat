import mongoose from 'mongoose';
import { ApiError } from '../../../../utils/ApiError.js';
import { CORPORATE_SERVICES } from '../models/Corporate.js';
import { CorporateEmployee } from '../models/CorporateEmployee.js';
import { ALLOWANCE_PERIODS, CorporateRole } from '../models/CorporateRole.js';

/// Company roles (docs/plans/corporate-v2.md §1.1, §3.1): seeding, CRUD, and
/// resolving an employee's effective role.

export const DEFAULT_ROLE_SEEDS = Object.freeze([
  { name: 'CEO', code: 'CEO', level: 30, isDefault: false },
  { name: 'VP', code: 'VP', level: 20, isDefault: false },
  { name: 'Employee', code: 'EMP', level: 10, isDefault: true },
]);

const str = (value) => String(value ?? '').trim();
const isId = (value) => mongoose.Types.ObjectId.isValid(String(value || ''));
const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/// Seeds CEO / VP / Employee for a company that has no roles yet. Idempotent
/// and safe to race: each seed is an upsert keyed on (corporateId, code). A
/// company that already has roles is left alone, so deleting "VP" sticks.
export const ensureCorporateRoles = async (corporateId) => {
  if (!isId(corporateId)) return;
  const has = await CorporateRole.exists({ corporateId });
  if (has) return;
  for (const seed of DEFAULT_ROLE_SEEDS) {
    try {
      await CorporateRole.updateOne(
        { corporateId, code: seed.code },
        {
          $setOnInsert: {
            corporateId,
            ...seed,
            active: true,
            allowance: { enabled: false, km: 0, period: 'monthly' },
          },
        },
        { upsert: true },
      );
    } catch (error) {
      if (error?.code !== 11000) throw error;
    }
  }
};

export const getDefaultRole = async (corporateId) => {
  await ensureCorporateRoles(corporateId);
  return (await CorporateRole.findOne({ corporateId, isDefault: true }).lean())
    || CorporateRole.findOne({ corporateId }).sort({ level: 1 }).lean();
};

/// The role an employee books under: their own if it still exists, else the
/// company default.
export const resolveEmployeeRole = async (employee) => {
  if (!employee?.corporateId) return null;
  if (employee.roleId) {
    const role = await CorporateRole.findOne({ _id: employee.roleId, corporateId: employee.corporateId }).lean();
    if (role) return role;
  }
  return getDefaultRole(employee.corporateId);
};

export const serializeRoleRef = (role) => (role ? { id: String(role._id), name: role.name, code: role.code } : null);

/// Throws 400 unless `roleId` is a role of this company. Returns its id (or
/// null for "use the default").
export const assertRoleId = async (corporateId, roleId) => {
  if (roleId === undefined) return undefined;
  if (roleId === null || roleId === '') return null;
  if (!isId(roleId)) throw new ApiError(400, 'roleId is invalid');
  const role = await CorporateRole.findOne({ _id: roleId, corporateId }).select('_id').lean();
  if (!role) throw new ApiError(400, 'Role not found for this company');
  return role._id;
};

const cleanServices = (list) =>
  Array.isArray(list) ? [...new Set(list.map((item) => str(item).toLowerCase()).filter((item) => CORPORATE_SERVICES.includes(item)))] : undefined;
const cleanIds = (list) => (Array.isArray(list) ? list.filter(isId).map((id) => new mongoose.Types.ObjectId(String(id))) : undefined);
const nullableNumber = (value) => (value === null || value === '' ? null : Math.max(0, Number(value) || 0));

const pickRole = (body = {}) => {
  const fields = {};
  if (body.name !== undefined) fields.name = str(body.name);
  if (body.code !== undefined) fields.code = str(body.code).toUpperCase().replace(/\s+/g, '');
  if (body.level !== undefined) fields.level = Number(body.level) || 0;
  if (body.active !== undefined) fields.active = body.active !== false && body.active !== 'false';
  if (body.allowance && typeof body.allowance === 'object') {
    const allowance = body.allowance;
    if (allowance.enabled !== undefined) fields['allowance.enabled'] = allowance.enabled === true || allowance.enabled === 'true';
    if (allowance.km !== undefined) {
      const km = Number(allowance.km);
      if (!Number.isFinite(km) || km < 0) throw new ApiError(400, 'allowance.km must be zero or more');
      fields['allowance.km'] = Math.round(km * 100) / 100;
    }
    if (allowance.period !== undefined) {
      if (!ALLOWANCE_PERIODS.includes(allowance.period)) throw new ApiError(400, 'allowance.period must be weekly or monthly');
      fields['allowance.period'] = allowance.period;
    }
  }
  const services = cleanServices(body.allowedServices);
  if (services) fields.allowedServices = services;
  const vehicles = cleanIds(body.allowedVehicleTypeIds);
  if (vehicles) fields.allowedVehicleTypeIds = vehicles;
  if (body.maxFarePerTrip !== undefined) fields.maxFarePerTrip = nullableNumber(body.maxFarePerTrip);
  if (body.requireApprovalAbove !== undefined) fields.requireApprovalAbove = nullableNumber(body.requireApprovalAbove);
  if (body.requireApprovalAlways !== undefined) {
    fields.requireApprovalAlways = body.requireApprovalAlways === null || body.requireApprovalAlways === ''
      ? null
      : body.requireApprovalAlways === true || body.requireApprovalAlways === 'true';
  }
  if (body.monthlySpendLimit !== undefined) fields.monthlySpendLimit = Math.max(0, Number(body.monthlySpendLimit) || 0);
  return fields;
};

const assertUnique = async ({ corporateId, roleId = null, name, code }) => {
  const exclude = roleId ? { _id: { $ne: roleId } } : {};
  if (name && await CorporateRole.exists({ corporateId, name: new RegExp(`^${escapeRegex(name)}$`, 'i'), ...exclude })) {
    throw new ApiError(409, 'A role with this name already exists');
  }
  if (code && await CorporateRole.exists({ corporateId, code, ...exclude })) {
    throw new ApiError(409, 'A role with this code already exists');
  }
};

const toDuplicate = (error) => {
  if (error?.code === 11000) return new ApiError(409, 'A role with this name or code already exists');
  return error;
};

export const listCorporateRoles = async ({ corporateId }) => {
  await ensureCorporateRoles(corporateId);
  const [roles, counts] = await Promise.all([
    CorporateRole.find({ corporateId }).sort({ level: -1, name: 1 }).lean(),
    CorporateEmployee.aggregate([
      { $match: { corporateId: new mongoose.Types.ObjectId(String(corporateId)), active: true } },
      { $group: { _id: '$roleId', count: { $sum: 1 } } },
    ]),
  ]);
  const countById = new Map(counts.map((row) => [String(row._id), row.count]));
  const unassigned = countById.get('null') || 0;
  return {
    results: roles.map((role) => ({
      ...role,
      // Employees with no role book under the default one, so they count there.
      employeeCount: (countById.get(String(role._id)) || 0) + (role.isDefault ? unassigned : 0),
    })),
  };
};

const getRoleOrThrow = async (corporateId, roleId) => {
  if (!isId(roleId)) throw new ApiError(400, 'Invalid role id');
  const role = await CorporateRole.findOne({ _id: roleId, corporateId });
  if (!role) throw new ApiError(404, 'Role not found');
  return role;
};

export const makeRoleDefault = async ({ corporateId, roleId }) => {
  const role = await getRoleOrThrow(corporateId, roleId);
  if (role.active === false) throw new ApiError(409, 'An inactive role cannot be the default');
  await CorporateRole.updateMany({ corporateId, _id: { $ne: role._id }, isDefault: true }, { $set: { isDefault: false } });
  role.isDefault = true;
  await role.save();
  return role.toObject();
};

export const createCorporateRole = async ({ corporateId, body = {} }) => {
  await ensureCorporateRoles(corporateId);
  const fields = pickRole(body);
  if (!fields.name) throw new ApiError(400, 'Role name is required');
  if (!fields.code) fields.code = fields.name.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10) || 'ROLE';
  await assertUnique({ corporateId, name: fields.name, code: fields.code });

  const doc = { corporateId, isDefault: false };
  for (const [key, value] of Object.entries(fields)) {
    if (key.startsWith('allowance.')) {
      doc.allowance = { ...(doc.allowance || {}), [key.slice('allowance.'.length)]: value };
    } else doc[key] = value;
  }
  let role;
  try {
    role = await CorporateRole.create(doc);
  } catch (error) {
    throw toDuplicate(error);
  }
  if (body.isDefault === true || body.isDefault === 'true') return makeRoleDefault({ corporateId, roleId: role._id });
  return role.toObject();
};

export const updateCorporateRole = async ({ corporateId, roleId, body = {} }) => {
  const role = await getRoleOrThrow(corporateId, roleId);
  const fields = pickRole(body);
  if (fields.name === '') throw new ApiError(400, 'Role name cannot be empty');
  if (fields.code === '') throw new ApiError(400, 'Role code cannot be empty');
  if (fields.active === false && role.isDefault) throw new ApiError(409, 'The default role cannot be deactivated; make another role the default first');
  await assertUnique({ corporateId, roleId: role._id, name: fields.name, code: fields.code });
  role.set(fields);
  try {
    await role.save();
  } catch (error) {
    throw toDuplicate(error);
  }
  if (body.isDefault === true || body.isDefault === 'true') return makeRoleDefault({ corporateId, roleId: role._id });
  return role.toObject();
};

/// Any role may be deleted, seeded ones included, unless it is the current
/// default or an active employee still has it (409). With `reassignToRoleId`
/// every employee on the role (active or not) is moved there first. Inactive
/// employees left pointing at a deleted role fall back to the default role.
export const deleteCorporateRole = async ({ corporateId, roleId, reassignToRoleId = null }) => {
  const role = await getRoleOrThrow(corporateId, roleId);
  if (role.isDefault) throw new ApiError(409, 'The default role cannot be deleted; make another role the default first');
  let reassigned = 0;
  if (reassignToRoleId) {
    if (String(reassignToRoleId) === String(role._id)) throw new ApiError(400, 'reassignToRoleId must be a different role');
    const target = await getRoleOrThrow(corporateId, reassignToRoleId);
    const result = await CorporateEmployee.updateMany({ corporateId, roleId: role._id }, { $set: { roleId: target._id } });
    reassigned = result.modifiedCount || 0;
  }
  const inUse = await CorporateEmployee.countDocuments({ corporateId, roleId: role._id, active: true });
  if (inUse) {
    throw new ApiError(409, `${inUse} active employee(s) have this role; reassign them first (or pass reassignToRoleId)`, { employeeCount: inUse });
  }
  await CorporateRole.deleteOne({ _id: role._id });
  return { deleted: true, reassigned };
};

/// Bulk move: puts the listed employees of this company on `roleId`.
export const assignEmployeesToRole = async ({ corporateId, roleId, employeeIds = [] }) => {
  const role = await getRoleOrThrow(corporateId, roleId);
  if (role.active === false) throw new ApiError(409, 'Employees cannot be assigned to an inactive role');
  if (!Array.isArray(employeeIds) || !employeeIds.length) throw new ApiError(400, 'employeeIds must be a non-empty array');
  if (employeeIds.length > 5000) throw new ApiError(400, 'At most 5000 employees per call');
  const ids = [...new Set(employeeIds.map(String))];
  const invalid = ids.filter((id) => !isId(id));
  if (invalid.length) throw new ApiError(400, 'employeeIds contains an invalid id', { invalid });
  const found = await CorporateEmployee.find({ corporateId, _id: { $in: ids } }).select('_id').lean();
  const foundIds = new Set(found.map((item) => String(item._id)));
  const notFound = ids.filter((id) => !foundIds.has(id));
  const result = await CorporateEmployee.updateMany({ corporateId, _id: { $in: [...foundIds] } }, { $set: { roleId: role._id } });
  return { role: serializeRoleRef(role), matched: foundIds.size, updated: result.modifiedCount || 0, notFound };
};

/// Role by name or code, for imports. Case-insensitive.
export const buildRoleLookup = async (corporateId) => {
  await ensureCorporateRoles(corporateId);
  const roles = await CorporateRole.find({ corporateId }).lean();
  const byKey = new Map();
  for (const role of roles) {
    byKey.set(role.name.toLowerCase(), role);
    byKey.set(role.code.toLowerCase(), role);
  }
  return (value) => (value ? byKey.get(String(value).trim().toLowerCase()) || null : null);
};
