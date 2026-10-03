import { ApiError } from '../../../utils/ApiError.js';
import { getOrLoadCachedValue } from '../../../utils/cache.js';
import {
  SUPERADMIN_PERMISSION,
  normalizeAdminPermissions,
  normalizeAdminType,
} from '../admin/services/adminAccessService.js';
import { isCustomizationFlagOn } from '../services/securitySettingsService.js';

/// Route-level RBAC for every `/admin/*` request.
///
/// Before this, only ~9 resources called `assertAdminPermission` inside the
/// service layer, so a subadmin could read and write users, trips, wallets,
/// settings and reports regardless of their permission list. This middleware
/// maps the request path to a resource and the method to an action:
///
///   GET/HEAD/OPTIONS  -> `<resource>.view`
///   anything else     -> `<resource>.manage`
///
/// Back-compat: until `customization.strict_admin_permissions` = '1',
/// `<resource>.view` also satisfies `<resource>.manage`, because the admin
/// panel has only ever offered `.view` keys and existing subadmins would
/// otherwise lose every write. Superadmins, and admins holding `*`, bypass.
///
/// It runs after `authenticate(['admin'])`, merges the admin's `AdminRole`
/// permissions into `req.auth.admin.permissions` (so the service-level
/// `assertAdminPermission` calls see them too), and exposes `req.adminScope`
/// for city scoping.
///
/// Paths with no rule are allowed (any authenticated admin), so a new admin
/// route added by another module keeps working until it registers a rule with
/// `registerAdminRoutePermission`.

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/// `prefix` is matched against the path *below* `/admin`, on whole segments.
/// `resource` gives `<resource>.view|manage`; `permission` pins one key for
/// every method; `open: true` means any authenticated admin.
const BUILTIN_RULES = [
  { prefix: '/permissions', open: true },
  { prefix: '/countries', open: true },
  { prefix: '/upload-image', open: true },
  { prefix: '/vehicle_preference', open: true },
  { prefix: '/types/transport-types', open: true },
  { prefix: '/general-settings', methods: ['GET'], open: true },
  // Catalogue reads that other pages use for dropdowns (a driver form lists
  // vehicle types). Open to read for any admin, as they were; writes are not.
  { prefix: '/types/vehicle-types', methods: ['GET'], open: true },
  { prefix: '/goods-types', methods: ['GET'], open: true },
  { prefix: '/languages', methods: ['GET'], open: true },
  { prefix: '/cancellation-reasons', methods: ['GET'], open: true },
  { prefix: '/common/app-modules', methods: ['GET'], open: true },

  // Granting permissions is itself the most privileged action.
  { prefix: '/admin-management', permission: 'subadmins.manage' },
  { prefix: '/roles', permission: 'subadmins.manage' },
  { prefix: '/security/roles', permission: 'subadmins.manage' },
  { prefix: '/security/admins', permission: 'subadmins.manage' },
  { prefix: '/security/permissions', open: true },

  // All dashboard widgets, earnings included, load on the dashboard page, so
  // splitting them by key would blank parts of it for today's subadmins.
  { prefix: '/dashboard', resource: 'dashboard' },
  { prefix: '/safety', resource: 'dashboard' }, // the panel files SOS under the dashboard key

  { prefix: '/users', resource: 'users' },
  { prefix: '/user-subscriptions', resource: 'users' },
  { prefix: '/employees', resource: 'employees' },
  { prefix: '/wallet', resource: 'wallet' },
  { prefix: '/payment-methods', resource: 'wallet' },
  { prefix: '/drivers', resource: 'drivers' },
  { prefix: '/driver-ratings', resource: 'drivers' },
  { prefix: '/driver-subscriptions', resource: 'settings' },
  { prefix: '/referrals', resource: 'referrals' },
  { prefix: '/referral', resource: 'referrals' },
  { prefix: '/owner-management', resource: 'owners' },
  { prefix: '/owner-management/driver-needed-document', resource: 'drivers' },
  { prefix: '/reports', resource: 'reports' },
  { prefix: '/support', resource: 'support' },
  { prefix: '/careers', resource: 'support' },

  { prefix: '/service-locations', resource: 'service_locations' },
  { prefix: '/zones', resource: 'zones' },
  { prefix: '/airports', resource: 'airports' },
  { prefix: '/service-stores', resource: 'service_stores' },
  { prefix: '/types/vehicle-types', resource: 'vehicle_types' },
  { prefix: '/types/set-prices', resource: 'set_prices' },
  { prefix: '/price-hikes', resource: 'set_prices' },
  { prefix: '/types/rental-vehicles', resource: 'rental' },
  { prefix: '/types/rental-packages', resource: 'rental' },
  { prefix: '/rental-booking-requests', resource: 'rental' },
  { prefix: '/rental-quote-requests', resource: 'rental' },
  { prefix: '/rental-tracking', resource: 'rental' },
  { prefix: '/goods-types', resource: 'goods_types' },
  { prefix: '/bus-services', resource: 'bus_service' },
  { prefix: '/bus-bookings', resource: 'bus_service' },
  { prefix: '/pooling-routes', resource: 'pooling' },
  { prefix: '/pooling-vehicles', resource: 'pooling' },
  { prefix: '/pooling-bookings', resource: 'pooling' },
  { prefix: '/heatmap', resource: 'geofencing' },
  { prefix: '/geo', resource: 'geofencing' },

  { prefix: '/trips', resource: 'trips' },
  { prefix: '/deliveries', resource: 'deliveries' },
  { prefix: '/ongoing-rides', resource: 'ongoing' },
  { prefix: '/ride-requests', resource: 'ongoing' },

  { prefix: '/promotions', resource: 'promotions' },
  { prefix: '/promos', resource: 'promotions' },
  { prefix: '/banners', resource: 'promotions' },
  { prefix: '/notifications', resource: 'promotions' },
  { prefix: '/push-notifications', resource: 'promotions' },

  { prefix: '/enquiries', resource: 'enquiries' },
  { prefix: '/landing-content', resource: 'landing_content' },

  { prefix: '/general-settings', resource: 'settings' },
  { prefix: '/integration-settings', resource: 'settings' },
  { prefix: '/languages', resource: 'settings' },
  { prefix: '/preferences', resource: 'settings' },
  { prefix: '/common/app-modules', resource: 'settings' },
  { prefix: '/notification-channels', resource: 'settings' },
  { prefix: '/cancellation-reasons', resource: 'settings' },
];

const registeredRules = [];

const normalizePath = (path = '') => {
  const value = `/${String(path || '').split('?')[0]}`.replace(/\/+/g, '/').replace(/\/$/, '');
  return value || '/';
};

const prefixMatches = (path, prefix) => path === prefix || path.startsWith(`${prefix}/`);

/// Lets another module guard the admin routes it adds, e.g.
/// `registerAdminRoutePermission({ prefix: '/hubs', resource: 'hubs' })`.
/// `prefix` is relative to `/admin`. Later registrations win over built-ins
/// of the same length.
export const registerAdminRoutePermission = (rule = {}) => {
  const prefix = normalizePath(rule.prefix);
  if (prefix === '/') {
    throw new Error('registerAdminRoutePermission requires a prefix below /admin');
  }
  if (!rule.open && !rule.resource && !rule.permission) {
    throw new Error('registerAdminRoutePermission requires resource, permission or open');
  }
  registeredRules.unshift({ ...rule, prefix });
};

/// Pure: the permission an admin request needs.
///
/// `path` is the path below `/admin` (what `req.path` is inside a router
/// mounted at `/admin`). Returns
/// `{ permission, resource, action, open, matched }`; `matched: false` means
/// no rule covers the path.
export const resolveRequiredAdminPermission = (method = 'GET', path = '/', rules = null) => {
  const normalizedMethod = String(method || 'GET').toUpperCase();
  const normalizedPath = normalizePath(path);
  const action = READ_METHODS.has(normalizedMethod) ? 'view' : 'manage';
  const candidates = rules || [...registeredRules, ...BUILTIN_RULES];

  let best = null;
  for (const rule of candidates) {
    if (rule.methods && !rule.methods.map((m) => m.toUpperCase()).includes(normalizedMethod)) continue;
    if (!prefixMatches(normalizedPath, rule.prefix)) continue;
    // Longest prefix wins; on a tie the earlier rule (registered first) wins.
    if (!best || rule.prefix.length > best.prefix.length) best = rule;
  }

  if (!best) {
    return { permission: null, resource: null, action, open: true, matched: false };
  }

  if (best.open) {
    return { permission: null, resource: best.resource || null, action, open: true, matched: true };
  }

  if (best.permission) {
    return { permission: best.permission, resource: best.resource || null, action, open: false, matched: true };
  }

  return {
    permission: `${best.resource}.${action}`,
    resource: best.resource,
    action,
    open: false,
    matched: true,
  };
};

/// Pure: does this permission list satisfy `required`?
export const permissionListGrants = (permissions = [], required, { strict = false } = {}) => {
  if (!required) return true;
  const list = normalizeAdminPermissions(permissions);
  if (list.includes(SUPERADMIN_PERMISSION) || list.includes(required)) return true;

  if (!strict && required.endsWith('.manage')) {
    return list.includes(required.replace(/\.manage$/, '.view'));
  }

  return false;
};

/// Pure: merges an admin's own permissions with their role's.
export const mergeRolePermissions = (adminPermissions = [], rolePermissions = []) =>
  normalizeAdminPermissions([...(adminPermissions || []), ...(rolePermissions || [])]);

/// Pure: the scope a service should filter by. `unrestricted` for
/// superadmins; otherwise the admin's assigned service locations and zones
/// (empty lists mean "nothing", matching buildServiceLocationScopeQuery).
export const buildAdminScope = (admin = {}) => {
  const adminType = normalizeAdminType(admin.admin_type || admin.role);
  const toIds = (values) => (Array.isArray(values) ? values.map((v) => String(v)).filter(Boolean) : []);
  return {
    adminId: admin.id ? String(admin.id) : null,
    unrestricted: adminType === 'superadmin',
    service_location_ids: adminType === 'superadmin' ? [] : toIds(admin.service_location_ids),
    zone_ids: adminType === 'superadmin' ? [] : toIds(admin.zone_ids),
  };
};

const RESERVED_ROLE_NAMES = new Set(['', 'superadmin', 'subadmin', 'admin', 'super-admin']);

const loadRolePermissions = async (entity) => {
  const roleId = entity?.role_id ? String(entity.role_id) : '';
  const roleSlug = String(entity?.role || '').trim().toLowerCase();
  if (!roleId && RESERVED_ROLE_NAMES.has(roleSlug)) return [];

  return getOrLoadCachedValue(`cache:admin-role-permissions:${roleId || `slug:${roleSlug}`}`, {
    ttlMs: 30_000,
    load: async () => {
      const { AdminRole } = await import('../admin/models/AdminRole.js');
      const role = roleId
        ? await AdminRole.findById(roleId).select('permissions').lean()
        : await AdminRole.findOne({ slug: roleSlug }).select('permissions').lean();
      return Array.isArray(role?.permissions) ? role.permissions : [];
    },
  });
};

export const enforceAdminPermissions = async (req, _res, next) => {
  try {
    const admin = req.auth?.admin;
    if (!admin) {
      // Mounted after authenticate(['admin']); reaching here without it is a
      // wiring bug, and failing closed is the safe answer.
      throw new ApiError(401, 'Authorization token is required');
    }

    const isSuper = normalizeAdminType(admin.admin_type || admin.role) === 'superadmin';

    if (!isSuper && !req.auth.rolePermissionsMerged) {
      const rolePermissions = await loadRolePermissions(req.auth.entity).catch(() => []);
      admin.permissions = mergeRolePermissions(admin.permissions, rolePermissions);
      req.auth.rolePermissionsMerged = true;
    }

    req.adminScope = buildAdminScope(admin);

    if (isSuper) {
      next();
      return;
    }

    // Kill switch. Enforcement is on by default because leaving every area open
    // to every subadmin was the bug, but a subadmin whose permission list was
    // never filled in now gets 403s; '0' restores the old open behaviour while
    // their permissions are sorted out.
    const enforcing = await isCustomizationFlagOn('enforce_admin_permissions');
    const required = resolveRequiredAdminPermission(req.method, req.path);
    if (required.open || !enforcing) {
      next();
      return;
    }

    const strict = await isCustomizationFlagOn('strict_admin_permissions');
    if (!permissionListGrants(admin.permissions, required.permission, { strict })) {
      throw new ApiError(403, 'You do not have permission to access this resource', {
        code: 'admin_permission_denied',
        required: required.permission,
      });
    }

    next();
  } catch (error) {
    next(error);
  }
};
