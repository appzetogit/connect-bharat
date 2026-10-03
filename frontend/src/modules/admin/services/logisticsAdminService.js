import api from '../../../shared/api/axiosInstance';

/**
 * Admin API for the hub parcel network (/admin/logistics/*). The shared
 * client attaches the admin token for /admin paths and unwraps `data`.
 */
const unwrap = (promise) => promise.then((response) => response?.data);

export const logisticsAdminService = {
  hubs: (params) => unwrap(api.get('/admin/logistics/hubs', { params })),
  createHub: (payload) => unwrap(api.post('/admin/logistics/hubs', payload)),
  updateHub: (id, payload) => unwrap(api.patch(`/admin/logistics/hubs/${id}`, payload)),
  deleteHub: (id) => unwrap(api.delete(`/admin/logistics/hubs/${id}`)),
  leagueTable: (params) => unwrap(api.get('/admin/logistics/hubs/league-table', { params })),
  hubRevenue: (id, params) => unwrap(api.get(`/admin/logistics/hubs/${id}/revenue`, { params })),

  staff: (params) => unwrap(api.get('/admin/logistics/staff', { params })),
  createStaff: (payload) => unwrap(api.post('/admin/logistics/staff', payload)),
  updateStaff: (id, payload) => unwrap(api.patch(`/admin/logistics/staff/${id}`, payload)),
  deleteStaff: (id) => unwrap(api.delete(`/admin/logistics/staff/${id}`)),

  rateCards: (params) => unwrap(api.get('/admin/logistics/rate-cards', { params })),
  createRateCard: (payload) => unwrap(api.post('/admin/logistics/rate-cards', payload)),
  updateRateCard: (id, payload) => unwrap(api.put(`/admin/logistics/rate-cards/${id}`, payload)),
  deleteRateCard: (id) => unwrap(api.delete(`/admin/logistics/rate-cards/${id}`)),

  shipments: (params) => unwrap(api.get('/admin/logistics/shipments', { params })),
  shipment: (awb) => unwrap(api.get(`/admin/logistics/shipments/${encodeURIComponent(awb)}`)),

  settings: () => unwrap(api.get('/admin/logistics/settings')),
  updateSettings: (payload) => unwrap(api.put('/admin/logistics/settings', payload)),

  serviceLocations: () => api.get('/admin/service-locations').then((response) => response?.data),
};

/** Plain JS copy of a proxied API response, safe to put in form state. */
export const plain = (value) => JSON.parse(JSON.stringify(value ?? null));
