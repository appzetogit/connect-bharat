import { ApiError } from '../../../../utils/ApiError.js';
import { hasAdminPermission } from '../../admin/services/adminAccessService.js';
import { Corporate } from '../models/Corporate.js';

/// Runs after `authenticate(['corporate_admin'])`. Loads the signed-in panel
/// user's company onto `req.corporate` and enforces panel roles.
///
/// A company that is pending or suspended can still sign in and read its own
/// status and profile (`allowInactive`), but nothing that books, approves or
/// changes employees.
export const requireCorporateAccess = ({ roles = [], allowInactive = false } = {}) => async (req, _res, next) => {
  try {
    const admin = req.auth?.entity;
    if (!admin || req.auth.role !== 'corporate_admin') throw new ApiError(403, 'Corporate panel access required');
    if (admin.active === false) throw new ApiError(403, 'This panel account is deactivated');
    if (roles.length && !roles.includes(admin.role)) throw new ApiError(403, 'Your panel role cannot do this');

    const corporate = await Corporate.findById(admin.corporateId);
    if (!corporate) throw new ApiError(403, 'Company not found');
    if (!allowInactive && corporate.status !== 'approved') {
      throw new ApiError(403, `Company account is ${corporate.status}`);
    }

    req.corporateAdmin = admin;
    req.corporate = corporate;
    next();
  } catch (error) {
    next(error);
  }
};

/// Admin-side guard. Superadmins pass; subadmins need `corporates.view`.
export const requireCorporatesPermission = (req, _res, next) => {
  if (!hasAdminPermission(req.auth?.admin || {}, 'corporates.view')) {
    next(new ApiError(403, 'You do not have permission to access corporates'));
    return;
  }
  next();
};
