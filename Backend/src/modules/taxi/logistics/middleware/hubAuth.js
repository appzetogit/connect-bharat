import { ApiError } from '../../../../utils/ApiError.js';
import { hasAdminPermission } from '../../admin/services/adminAccessService.js';
import { resolveActiveHub } from '../services/hubLookupService.js';

/// Runs after authenticate(['hub_manager']). The shared auth middleware
/// only checks that the HubStaff row exists; this also refuses deactivated
/// staff and resolves which hub the request acts for (their own, or one
/// they manage, picked with ?hubId=).
export const requireHubStaff = async (req, _res, next) => {
  try {
    const staff = req.auth?.entity;
    if (!staff || staff.active === false) throw new ApiError(403, 'Hub staff account is inactive');
    const { hub, hubs } = await resolveActiveHub(staff, req.query?.hubId || req.body?.hubId);
    if (hub.status !== 'active') throw new ApiError(403, 'This hub is inactive');
    req.hubStaff = staff;
    req.hub = hub;
    req.hubs = hubs;
    next();
  } catch (error) {
    next(error);
  }
};

/// Money screens (revenue) are for hub managers, not operators.
export const requireHubManagerRole = (req, _res, next) => {
  if (req.hubStaff?.role !== 'hub_manager') {
    next(new ApiError(403, 'Only a hub manager can view this'));
    return;
  }
  next();
};

/// Admin logistics screens use the existing `deliveries.view` permission
/// (the admin permission list has no separate parcel-network entry), so a
/// subadmin who can see deliveries can manage the parcel network.
export const requireAdminPermission = (permission) => (req, _res, next) => {
  if (!hasAdminPermission(req.auth?.admin, permission)) {
    next(new ApiError(403, 'You do not have permission to manage the parcel network'));
    return;
  }
  next();
};
