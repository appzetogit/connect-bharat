import { Admin } from '../admin/models/Admin.js';
import { Owner } from '../admin/models/Owner.js';
import { ServiceStore } from '../admin/models/ServiceStore.js';
import { ServiceCenterStaff } from '../admin/models/ServiceCenterStaff.js';
import { ApiError } from '../../../utils/ApiError.js';
import { Driver } from '../driver/models/Driver.js';
import { BusDriver } from '../driver/models/BusDriver.js';
import { PoolingVehicle } from '../admin/models/PoolingVehicle.js';
import { User } from '../user/models/User.js';
import { CorporateAdmin } from '../corporate/models/CorporateAdmin.js';
import { verifyAccessToken } from '../services/tokenService.js';
import {
  normalizeAdminPermissions,
  normalizeAdminType,
} from '../admin/services/adminAccessService.js';

const roleModelMap = {
  admin: Admin,
  'super-admin': Admin,
  driver: Driver,
  pooling_driver: PoolingVehicle,
  bus_driver: BusDriver,
  owner: Owner,
  service_center: ServiceStore,
  service_center_staff: ServiceCenterStaff,
  user: User,
  // Corporate web panel users. MERGE NOTE: becomes a registerAuthRole() call
  // once the extensible auth middleware lands; the active/company-status
  // checks live in corporate/middlewares/corporateAccess.js.
  corporate_admin: CorporateAdmin,
};

/// Role names reserved for modules that register their own models (hub panel,
/// corporate panel). Listed here so every module agrees on the spelling; until
/// a module calls `registerAuthRole` for one, a token with that role is
/// rejected as unsupported.
export const AUTH_ROLES = Object.freeze({
  ADMIN: 'admin',
  DRIVER: 'driver',
  POOLING_DRIVER: 'pooling_driver',
  BUS_DRIVER: 'bus_driver',
  OWNER: 'owner',
  SERVICE_CENTER: 'service_center',
  SERVICE_CENTER_STAFF: 'service_center_staff',
  USER: 'user',
  HUB_MANAGER: 'hub_manager',
  CORPORATE_ADMIN: 'corporate_admin',
});

/// Per-role "is this account allowed in" checks registered by other modules.
const registeredRoleGuards = new Map();

/// Lets a module plug a new account type into `authenticate` without this
/// file importing its model (which would create import cycles and couple the
/// auth layer to every feature module).
///
///   registerAuthRole('hub_manager', HubManager, {
///     isActive: (entity) => entity.active !== false,  // or throw an ApiError
///   });
///
/// `isActive(entity, { allowPending })` may return false (-> 403 "account is
/// inactive") or throw its own ApiError. Re-registering a role replaces it.
export const registerAuthRole = (role, model, { isActive } = {}) => {
  const key = String(role || '').trim().toLowerCase();
  if (!key) {
    throw new Error('registerAuthRole requires a role name');
  }
  if (!model || typeof model.findById !== 'function') {
    throw new Error(`registerAuthRole(${key}) requires a Mongoose model`);
  }
  if (['admin', 'super-admin'].includes(key)) {
    throw new Error('The admin role cannot be re-registered');
  }

  roleModelMap[key] = model;
  if (typeof isActive === 'function') {
    registeredRoleGuards.set(key, isActive);
  } else {
    registeredRoleGuards.delete(key);
  }
};

export const isAuthRoleRegistered = (role) => Boolean(roleModelMap[String(role || '').toLowerCase()]);

const normalizeRole = (role = '') => {
  const value = String(role || '').toLowerCase();
  if (value === 'super-admin') {
    return 'admin';
  }
  return value;
};

const attachResolvedAuth = (req, payload) => {
  req.auth = {
    sub: payload.sub,
    role: normalizeRole(payload.role),
    originalRole: payload.role,
  };
};

export const authenticate = (allowedRoles = [], options = {}) => async (req, _res, next) => {
  try {
    const allowPending = options?.allowPending === true;
    const authorization = req.headers.authorization || '';
    const [, token] = authorization.split(' ');

    if (!token) {
      throw new ApiError(401, 'Authorization token is required');
    }

    const payload = verifyAccessToken(token);

    const normalizedRole = normalizeRole(payload.role);
    const normalizedAllowedRoles = allowedRoles.map(normalizeRole);

    if (normalizedAllowedRoles.length > 0 && !normalizedAllowedRoles.includes(normalizedRole)) {
      throw new ApiError(403, 'Insufficient permissions for this resource');
    }

    const Model = roleModelMap[payload.role] || roleModelMap[normalizedRole];

    if (!Model) {
      throw new ApiError(401, 'Unsupported auth role');
    }

    const entity = await Model.findById(payload.sub);

    if (!entity) {
      throw new ApiError(401, 'Authenticated account no longer exists');
    }

    if (
      normalizedRole === 'user' &&
      (entity.deletedAt || entity.isActive === false || entity.active === false)
    ) {
      throw new ApiError(401, 'User account is not active');
    }

    // A blocked driver is out even on allowPending routes: pending means "not
    // yet approved", blocked means "removed by an admin".
    if (normalizedRole === 'driver' && String(entity.status || '').toLowerCase() === 'blocked') {
      throw new ApiError(403, 'Driver account is blocked');
    }

    if (
      normalizedRole === 'driver' &&
      !allowPending &&
      (entity.approve === false || String(entity.status || '').toLowerCase() === 'pending')
    ) {
      throw new ApiError(403, 'Driver account is pending approval');
    }

    if (
      normalizedRole === 'owner' &&
      !allowPending &&
      (entity.active === false ||
        entity.approve === false ||
        String(entity.status || '').toLowerCase() === 'pending')
    ) {
      throw new ApiError(403, 'Owner account is pending approval');
    }

    if (
      normalizedRole === 'bus_driver' &&
      !allowPending &&
      (entity.active === false ||
        entity.approve === false ||
        ['pending', 'blocked'].includes(String(entity.status || '').toLowerCase()))
    ) {
      throw new ApiError(403, 'Bus driver account is pending approval');
    }

    if (
      normalizedRole === 'pooling_driver' &&
      !allowPending &&
      (entity.approve === false || String(entity.status || '').toLowerCase() === 'pending')
    ) {
      throw new ApiError(403, 'Pooling driver account is pending approval');
    }

    if (
      normalizedRole === 'pooling_driver' &&
      (entity.poolingEnabled === false ||
        ['inactive', 'maintenance'].includes(String(entity.status || '').toLowerCase()))
    ) {
      throw new ApiError(403, 'Pooling driver account is inactive');
    }

    if (
      normalizedRole === 'service_center' &&
      !allowPending &&
      (entity.active === false ||
        entity.approve === false ||
        String(entity.status || '').toLowerCase() === 'inactive')
    ) {
      throw new ApiError(403, 'Service center account is inactive');
    }

    if (
      normalizedRole === 'service_center_staff' &&
      !allowPending &&
      (entity.active === false ||
        entity.approve === false ||
        String(entity.status || '').toLowerCase() === 'inactive')
    ) {
      throw new ApiError(403, 'Service center staff account is inactive');
    }

    const registeredGuard = registeredRoleGuards.get(normalizedRole);
    if (registeredGuard) {
      const allowed = await registeredGuard(entity, { allowPending });
      if (allowed === false) {
        throw new ApiError(403, 'Account is inactive');
      }
    }

    attachResolvedAuth(req, payload);
    req.auth.entity = entity;

    if (normalizedRole === 'admin') {
      req.auth.admin = {
        id: String(entity._id),
        email: entity.email || '',
        name: entity.name || '',
        role: entity.role || '',
        admin_type: normalizeAdminType(entity.admin_type || entity.role),
        permissions: normalizeAdminPermissions(entity.permissions || []),
        service_location_ids: Array.isArray(entity.service_location_ids)
          ? entity.service_location_ids.map((item) => String(item))
          : [],
        zone_ids: Array.isArray(entity.zone_ids)
          ? entity.zone_ids.map((item) => String(item))
          : [],
        active: entity.active !== false,
        status: entity.status || 'active',
      };

      if (req.auth.admin.active === false || String(req.auth.admin.status).toLowerCase() === 'inactive') {
        throw new ApiError(403, 'Admin account is inactive');
      }
    }

    next();
  } catch (error) {
    next(error);
  }
};
