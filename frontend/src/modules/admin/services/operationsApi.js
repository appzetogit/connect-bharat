import api from '../../../shared/api/axiosInstance';

/**
 * Admin operations endpoints (Backend admin/operations, docs/api/admin-operations.md).
 * Kept apart from adminService.js so these pages don't touch that shared file.
 * Like every call through `api`, each resolves to the response body
 * ({ success, data }), viewed through createCompatibleResponseView.
 */
export const operationsApi = {
  // Manual driver assignment
  getCandidateDrivers: (rideId, params = {}) =>
    api.get(`/admin/rides/${rideId}/candidate-drivers`, { params }),
  assignDriver: (rideId, driverId, force = false) =>
    api.post(`/admin/rides/${rideId}/assign-driver`, { driverId, force }),

  // Live tracking
  getDriverLocationHistory: (driverId, params = {}) =>
    api.get(`/admin/drivers/${driverId}/location-history`, { params }),

  // Dashboard and analytics
  getDashboardOverview: (params = {}) => api.get('/admin/dashboard/overview', { params }),
  getDriverAnalytics: (params = {}) => api.get('/admin/analytics/drivers', { params }),

  // Users
  setUserVerified: (userId, verified, note = '') =>
    api.patch(`/admin/users/${userId}/verify`, { verified, note }),
  setUserBlocked: (userId, blocked, reason = '') =>
    api.patch(`/admin/users/${userId}/block`, { blocked, reason }),

  // Driver documents and approval
  getDriverDocumentReview: (driverId) => api.get(`/admin/drivers/${driverId}/documents/review`),
  reviewDriverDocument: (driverId, documentKey, status, reason = '') =>
    api.patch(`/admin/drivers/${driverId}/documents/${encodeURIComponent(documentKey)}`, { status, reason }),
  approveDriver: (driverId) => api.post(`/admin/drivers/${driverId}/approve`),
  rejectDriver: (driverId, reason) => api.post(`/admin/drivers/${driverId}/reject`, { reason }),

  // Vehicles
  approveDriverVehicle: (driverId) => api.post(`/admin/drivers/${driverId}/vehicle/approve`),
  rejectDriverVehicle: (driverId, reason) => api.post(`/admin/drivers/${driverId}/vehicle/reject`, { reason }),
  approveFleetVehicle: (vehicleId) => api.post(`/admin/fleet-vehicles/${vehicleId}/approve`),
  rejectFleetVehicle: (vehicleId, reason) => api.post(`/admin/fleet-vehicles/${vehicleId}/reject`, { reason }),
};

/** Socket events the backend pushes to the admin:broadcast room. */
export const ADMIN_FEED_EVENTS = Object.freeze({
  RIDE_LIFECYCLE: 'admin:ride:lifecycle',
  DRIVER_LOCATION: 'admin:driver:location',
});

/** Pulls `data` out of an api response regardless of how it was wrapped. */
export const unwrap = (response) => response?.data?.data ?? response?.data ?? response;
