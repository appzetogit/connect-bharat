/// City scoping for admin list/report services.
///
/// `req.adminScope` (set by middlewares/adminPermissionMiddleware.js) is
/// `{ adminId, unrestricted, service_location_ids, zone_ids }`. Superadmins
/// are unrestricted; a subadmin only sees records in their service locations.
/// A missing scope (a service called from a script or another service) means
/// unrestricted, which is what every caller got before scoping existed.

const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const isScopeRestricted = (scope) => Boolean(scope && scope.unrestricted === false);

/// Pure: `{ [field]: { $in: ids } }`, `{}` when unrestricted. A restricted
/// admin with no locations gets `$in: []`, i.e. nothing, matching
/// `buildServiceLocationScopeQuery` in adminService.
export const buildServiceLocationFilter = (scope, field = 'service_location_id') => {
  if (!isScopeRestricted(scope)) return {};
  return { [field]: { $in: [...(scope.service_location_ids || [])] } };
};

/// Users have no service location of their own, so a user is "in" a city if
/// they have booked a ride there, or their profile city names one of the
/// admin's service locations.
export const resolveUserScopeFilter = async (scope) => {
  if (!isScopeRestricted(scope)) return {};

  const locationIds = scope.service_location_ids || [];
  if (!locationIds.length) return { _id: { $in: [] } };

  const [{ Ride }, { ServiceLocation }] = await Promise.all([
    import('../../user/models/Ride.js'),
    import('../models/ServiceLocation.js'),
  ]);

  const [riderIds, locations] = await Promise.all([
    Ride.distinct('userId', { service_location_id: { $in: locationIds } }),
    ServiceLocation.find({ _id: { $in: locationIds } }).select('name service_location_name').lean(),
  ]);

  const cityNames = [
    ...new Set(
      locations
        .flatMap((location) => [location.service_location_name, location.name])
        .map((name) => String(name || '').trim())
        .filter(Boolean),
    ),
  ];

  const clauses = [{ _id: { $in: riderIds } }];
  if (cityNames.length) {
    clauses.push({ city: { $in: cityNames.map((name) => new RegExp(`^${escapeRegex(name)}$`, 'i')) } });
  }

  return { $or: clauses };
};

/// Filters for each collection the dashboard counts.
export const resolveDashboardScopeFilters = async (scope) => {
  if (!isScopeRestricted(scope)) {
    return { restricted: false, user: {}, driver: {}, owner: {}, ride: {} };
  }

  return {
    restricted: true,
    user: await resolveUserScopeFilter(scope),
    driver: buildServiceLocationFilter(scope),
    owner: buildServiceLocationFilter(scope),
    ride: buildServiceLocationFilter(scope),
  };
};

/// Merges a scope filter into an existing query without clobbering a `$or`
/// the caller already built (e.g. a search box).
export const mergeScopeIntoQuery = (query = {}, scopeFilter = {}) => {
  if (!scopeFilter || !Object.keys(scopeFilter).length) return query;
  if (query.$and) return { ...query, $and: [...query.$and, scopeFilter] };
  return { ...query, $and: [scopeFilter] };
};
