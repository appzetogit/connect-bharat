import mongoose from 'mongoose';
import { Router } from 'express';
import { asyncHandler } from '../../../../utils/asyncHandler.js';
import { ApiError } from '../../../../utils/ApiError.js';
import { invalidateCachedPrefix } from '../../../../utils/cache.js';
import { authenticate } from '../../middlewares/authMiddleware.js';
import { enforceAdminPermissions } from '../../middlewares/adminPermissionMiddleware.js';
import { isCustomizationFlagOn } from '../../services/securitySettingsService.js';
import { Admin } from '../models/Admin.js';
import { AdminRole } from '../models/AdminRole.js';
import {
  ADMIN_MANAGE_PERMISSIONS,
  ADMIN_PERMISSIONS,
  ALL_ADMIN_PERMISSIONS,
  normalizeAdminPermissions,
  normalizeAdminType,
} from '../services/adminAccessService.js';

/// Endpoints that make `AdminRole` real: give a role permissions, attach a
/// role to an admin, and let an admin client see its effective access.
/// Guarded by the same RBAC middleware (rules for `/security/*` live in
/// adminPermissionMiddleware's table).
export const adminSecurityRouter = Router();

/// adminRouter (mounted before this one) already authenticated and ran RBAC
/// for every `/admin` path; this only re-runs them if that ever stops being
/// true, so the routes below can never be reached unauthenticated.
const ensureAdminAccess = (req, res, next) => {
  if (req.auth?.admin && req.adminScope) {
    next();
    return;
  }
  authenticate(['admin'])(req, res, (error) => (error ? next(error) : enforceAdminPermissions(req, res, next)));
};

adminSecurityRouter.use('/admin/security', ensureAdminAccess);

const ROLE_CACHE_PREFIX = 'cache:admin-role-permissions:';

const serializeRole = (role) => ({
  id: String(role._id),
  name: role.name || '',
  slug: role.slug || '',
  description: role.description || '',
  permissions: normalizeAdminPermissions(role.permissions || []),
  updatedAt: role.updatedAt || null,
});

const assertObjectId = (value, label) => {
  if (!mongoose.isValidObjectId(String(value || ''))) {
    throw new ApiError(400, `Invalid ${label}`);
  }
};

const cleanPermissionList = (permissions) => {
  if (!Array.isArray(permissions)) {
    throw new ApiError(400, 'permissions must be an array');
  }
  const normalized = normalizeAdminPermissions(permissions);
  // Roles may not carry the superadmin wildcard; that is what admin_type is for.
  if (normalized.includes('*')) {
    throw new ApiError(400, 'A role cannot grant superadmin access');
  }
  const unknown = normalized.filter((key) => !ALL_ADMIN_PERMISSIONS.includes(key));
  if (unknown.length) {
    throw new ApiError(400, `Unknown permissions: ${unknown.join(', ')}`);
  }
  return normalized;
};

adminSecurityRouter.get(
  '/admin/security/permissions',
  asyncHandler(async (_req, res) => {
    res.json({
      success: true,
      data: {
        view: ADMIN_PERMISSIONS,
        manage: ADMIN_MANAGE_PERMISSIONS,
        all: ALL_ADMIN_PERMISSIONS,
        strict: await isCustomizationFlagOn('strict_admin_permissions'),
      },
    });
  }),
);

adminSecurityRouter.get(
  '/admin/security/me',
  asyncHandler(async (req, res) => {
    const admin = req.auth.admin;
    res.json({
      success: true,
      data: {
        id: admin.id,
        admin_type: normalizeAdminType(admin.admin_type || admin.role),
        role: admin.role || '',
        role_id: req.auth.entity?.role_id ? String(req.auth.entity.role_id) : null,
        permissions: admin.permissions,
        scope: req.adminScope,
        strict: await isCustomizationFlagOn('strict_admin_permissions'),
      },
    });
  }),
);

adminSecurityRouter.get(
  '/admin/security/roles',
  asyncHandler(async (_req, res) => {
    const roles = await AdminRole.find().sort({ createdAt: -1 }).lean();
    res.json({ success: true, data: roles.map(serializeRole) });
  }),
);

adminSecurityRouter.patch(
  '/admin/security/roles/:id',
  asyncHandler(async (req, res) => {
    assertObjectId(req.params.id, 'role id');
    const update = {};
    if (req.body?.permissions !== undefined) update.permissions = cleanPermissionList(req.body.permissions);
    if (req.body?.name !== undefined) update.name = String(req.body.name || '').trim();
    if (req.body?.description !== undefined) update.description = String(req.body.description || '').trim();

    if (update.name === '') {
      throw new ApiError(400, 'Role name cannot be empty');
    }

    const role = await AdminRole.findByIdAndUpdate(req.params.id, { $set: update }, { returnDocument: 'after' }).lean();
    if (!role) {
      throw new ApiError(404, 'Role not found');
    }

    await invalidateCachedPrefix(ROLE_CACHE_PREFIX);
    res.json({ success: true, data: serializeRole(role) });
  }),
);

adminSecurityRouter.patch(
  '/admin/security/admins/:id/role',
  asyncHandler(async (req, res) => {
    assertObjectId(req.params.id, 'admin id');

    if (String(req.params.id) === String(req.auth.admin.id)) {
      throw new ApiError(400, 'You cannot change your own role');
    }

    const roleId = req.body?.role_id ?? req.body?.roleId ?? null;
    let role = null;
    if (roleId) {
      assertObjectId(roleId, 'role id');
      role = await AdminRole.findById(roleId).lean();
      if (!role) {
        throw new ApiError(404, 'Role not found');
      }
    }

    const admin = await Admin.findByIdAndUpdate(
      req.params.id,
      { $set: { role_id: role ? role._id : null } },
      { returnDocument: 'after' },
    )
      .select('name email admin_type role role_id permissions')
      .lean();

    if (!admin) {
      throw new ApiError(404, 'Admin account not found');
    }

    res.json({
      success: true,
      data: {
        id: String(admin._id),
        name: admin.name,
        email: admin.email,
        admin_type: admin.admin_type,
        role_id: admin.role_id ? String(admin.role_id) : null,
        role: role ? serializeRole(role) : null,
      },
    });
  }),
);
