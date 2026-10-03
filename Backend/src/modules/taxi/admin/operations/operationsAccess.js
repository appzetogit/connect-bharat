import mongoose from 'mongoose';
import { ApiError } from '../../../../utils/ApiError.js';
import { hasAdminPermission, normalizeAdminType } from '../services/adminAccessService.js';

/// Route guard for one admin permission.
///
/// The operations routes sit behind authenticate(['admin']) already, which
/// lets any subadmin in. Each of these actions moves money, drivers or riders,
/// so each one checks the matching panel permission too. Super admins pass.
export const requireAdminPermission = (permission, label = 'this resource') => (req, _res, next) => {
  if (!hasAdminPermission(req.auth?.admin, permission)) {
    next(new ApiError(403, `You do not have permission to access ${label}`));
    return;
  }
  next();
};

export const isSuperAdmin = (admin = {}) =>
  normalizeAdminType(admin?.admin_type || admin?.role) === 'superadmin';

export const getAdminServiceLocationIds = (admin = {}) =>
  (Array.isArray(admin?.service_location_ids) ? admin.service_location_ids : [])
    .map((value) => String(value || '').trim())
    .filter((value) => mongoose.isValidObjectId(value));

/// A subadmin may only act on records in the cities they were given. A record
/// with no city (older data) is left to super admins.
export const assertServiceLocationScope = (admin, serviceLocationId) => {
  if (!admin || isSuperAdmin(admin)) return;
  const normalized = String(serviceLocationId || '').trim();
  if (!normalized || !getAdminServiceLocationIds(admin).includes(normalized)) {
    throw new ApiError(403, 'This record is outside your assigned service locations');
  }
};

/// The service-location ids a query should be limited to, or null for "all".
/// A requested id outside a subadmin's scope is refused rather than silently
/// widened or emptied.
export const resolveServiceLocationFilter = (admin, requestedId = '') => {
  const requested = String(requestedId || '').trim();
  if (requested && !mongoose.isValidObjectId(requested)) {
    throw new ApiError(400, 'service_location_id is not a valid id');
  }

  if (!admin || isSuperAdmin(admin)) {
    return requested ? [requested] : null;
  }

  const allowed = getAdminServiceLocationIds(admin);
  if (requested) {
    if (!allowed.includes(requested)) {
      throw new ApiError(403, 'This service location is outside your assigned scope');
    }
    return [requested];
  }
  return allowed;
};

export const assertObjectId = (value, label = 'id') => {
  if (!mongoose.isValidObjectId(value)) {
    throw new ApiError(400, `${label} is not a valid id`);
  }
};

export const getAdminActorId = (req) => {
  const id = req.auth?.admin?.id || req.auth?.sub || null;
  return id && mongoose.isValidObjectId(id) ? id : null;
};
