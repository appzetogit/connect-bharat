import axios from 'axios';
import toast from 'react-hot-toast';
import { API_BASE_URL } from '../../../shared/api/runtimeConfig';

/**
 * API client for the Hub panel.
 *
 * Its own axios instance rather than the shared one: the shared client picks
 * a token by URL prefix and role guesses, and a hub token is none of the
 * roles it knows. Here the hub token is always the one sent, and a 401 sends
 * the operator back to the login screen.
 */

const TOKEN_KEY = 'hubToken';
const STAFF_KEY = 'hubStaff';
const ACTIVE_HUB_KEY = 'hubActiveHubId';

const read = (key) => {
  try {
    return localStorage.getItem(key) || '';
  } catch {
    return '';
  }
};

const write = (key, value) => {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch {
    // Private mode: the session simply will not survive a reload.
  }
};

export const hubSession = {
  getToken: () => read(TOKEN_KEY),
  getStaff: () => {
    try {
      return JSON.parse(read(STAFF_KEY) || 'null');
    } catch {
      return null;
    }
  },
  getActiveHubId: () => read(ACTIVE_HUB_KEY),
  setActiveHubId: (hubId) => write(ACTIVE_HUB_KEY, hubId),
  save: ({ token, staff }) => {
    write(TOKEN_KEY, token);
    write(STAFF_KEY, JSON.stringify(staff || null));
  },
  clear: () => {
    write(TOKEN_KEY, '');
    write(STAFF_KEY, '');
    write(ACTIVE_HUB_KEY, '');
  },
};

const client = axios.create({ baseURL: API_BASE_URL, timeout: 30000 });

client.interceptors.request.use((config) => {
  const token = hubSession.getToken();
  if (token) config.headers.Authorization = `Bearer ${token}`;
  // The active hub travels as a query parameter: the API's CORS policy only
  // allows the Content-Type and Authorization headers.
  const hubId = hubSession.getActiveHubId();
  if (hubId && String(config.url || '').startsWith('/logistics/hub/') && !String(config.url).includes('/auth/')) {
    config.params = { ...(config.params || {}), hubId };
  }
  return config;
});

client.interceptors.response.use(
  (response) => response.data,
  (error) => {
    const status = error?.response?.status;
    if (status === 401 && !String(error?.config?.url || '').includes('/auth/')) {
      hubSession.clear();
      if (typeof window !== 'undefined' && !window.location.pathname.startsWith('/hub/login')) {
        window.location.assign('/hub/login');
      }
    }
    const message = error?.response?.data?.message || error.message || 'Request failed';
    const wrapped = new Error(message);
    wrapped.status = status;
    wrapped.details = error?.response?.data?.details;
    return Promise.reject(wrapped);
  },
);

const data = (promise) => promise.then((body) => body?.data);

export const hubApi = {
  // auth
  sendOtp: (phone) => data(client.post('/logistics/hub/auth/send-otp', { phone })),
  verifyOtp: (phone, otp) => data(client.post('/logistics/hub/auth/verify-otp', { phone, otp })),
  passwordLogin: (identifier, password) => data(client.post('/logistics/hub/auth/login', { identifier, password })),
  me: () => data(client.get('/logistics/hub/me')),

  // dashboard & lists
  dashboard: () => data(client.get('/logistics/hub/dashboard')),
  shipments: (params) => data(client.get('/logistics/hub/shipments', { params })),
  shipment: (awb) => data(client.get(`/logistics/hub/shipments/${encodeURIComponent(awb)}`)),
  hubDirectory: () => data(client.get('/logistics/hub/hubs')),
  counterBooking: (payload) => data(client.post('/logistics/hub/shipments', payload)),

  // scanning
  scan: (payload) => data(client.post('/logistics/hub/scan', payload)),

  // manifests
  manifests: (params) => data(client.get('/logistics/hub/manifests', { params })),
  manifest: (id) => data(client.get(`/logistics/hub/manifests/${id}`)),
  createManifest: (payload) => data(client.post('/logistics/hub/manifests', payload)),
  manifestAdd: (id, awb) => data(client.post(`/logistics/hub/manifests/${id}/add`, { awb })),
  manifestRemove: (id, awb) => data(client.post(`/logistics/hub/manifests/${id}/remove`, { awb })),
  manifestSeal: (id, sealNumber) => data(client.post(`/logistics/hub/manifests/${id}/seal`, { sealNumber })),
  manifestDispatch: (id, payload) => data(client.post(`/logistics/hub/manifests/${id}/dispatch`, payload || {})),
  manifestInTransit: (id) => data(client.post(`/logistics/hub/manifests/${id}/in-transit`)),
  manifestReceive: (id, payload) => data(client.post(`/logistics/hub/manifests/${id}/receive`, payload)),
  manifestClose: (id) => data(client.post(`/logistics/hub/manifests/${id}/close`)),
  manifestResolve: (id, index, note) => data(client.post(`/logistics/hub/manifests/${id}/discrepancies/${index}/resolve`, { note })),

  // drivers, legs, delivery
  nearbyDrivers: (params) => data(client.get('/logistics/hub/drivers/nearby', { params })),
  legs: (params) => data(client.get('/logistics/hub/legs', { params })),
  assignLeg: (awb, payload) => data(client.post(`/logistics/hub/shipments/${encodeURIComponent(awb)}/assign-leg`, payload)),
  outForDelivery: (payload) => data(client.post('/logistics/hub/out-for-delivery', payload)),
  deliver: (awb, payload) => data(client.post(`/logistics/hub/shipments/${encodeURIComponent(awb)}/deliver`, payload)),
  fail: (awb, payload) => data(client.post(`/logistics/hub/shipments/${encodeURIComponent(awb)}/fail`, payload)),
  reschedule: (awb, payload) => data(client.post(`/logistics/hub/shipments/${encodeURIComponent(awb)}/reschedule`, payload)),
  rto: (awb, reason) => data(client.post(`/logistics/hub/shipments/${encodeURIComponent(awb)}/rto`, { reason })),
  resendOtp: (awb) => data(client.post(`/logistics/hub/shipments/${encodeURIComponent(awb)}/resend-otp`)),
  pickupSlots: (date) => data(client.get('/logistics/pickup-slots', { params: { date } })),

  // reports
  revenue: (params) => data(client.get('/logistics/hub/reports/revenue', { params })),
  revenueCsv: (params) => client.get('/logistics/hub/reports/revenue', { params: { ...params, format: 'csv' }, responseType: 'blob' }),
  performance: (params) => data(client.get('/logistics/hub/reports/performance', { params })),

  // label (PDF blob)
  label: (awb) => client.get(`/logistics/shipments/${encodeURIComponent(awb)}/label.pdf`, { responseType: 'blob' }),

  // public
  track: (awb) => data(client.get(`/logistics/track/${encodeURIComponent(awb)}`)),
};

/** Opens a blob (PDF, CSV) in a new tab or as a download. */
export const openBlob = (blob, filename, { download = false } = {}) => {
  const url = URL.createObjectURL(blob);
  if (download) {
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
  } else {
    window.open(url, '_blank', 'noopener');
  }
  setTimeout(() => URL.revokeObjectURL(url), 60000);
};

/** Fetches a shipment's label PDF with the hub token and opens it. */
export const printLabel = async (awb) => {
  try {
    const blob = await hubApi.label(awb);
    openBlob(blob, `${awb}.pdf`);
  } catch (error) {
    toast.error(error.message);
  }
};
