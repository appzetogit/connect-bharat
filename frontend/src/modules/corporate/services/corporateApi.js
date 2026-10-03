import axios from 'axios';
import { API_BASE_URL } from '../../../shared/api/runtimeConfig';

/**
 * API client for the corporate panel.
 *
 * A separate axios instance rather than the shared one: the shared instance
 * picks a token by URL and page path for the rider/driver/admin roles, and a
 * corporate_admin token must never leak into those requests (or theirs into
 * ours). Responses are unwrapped to the `data` payload the backend returns.
 */

export const CORPORATE_TOKEN_KEY = 'corporateToken';
export const CORPORATE_SESSION_KEY = 'corporateSession';
export const CORPORATE_BASE_PATH = '/corporate-panel';

const readToken = () => {
  try {
    return localStorage.getItem(CORPORATE_TOKEN_KEY) || '';
  } catch {
    return '';
  }
};

export const saveCorporateSession = (session) => {
  try {
    localStorage.setItem(CORPORATE_TOKEN_KEY, session?.token || '');
    localStorage.setItem(CORPORATE_SESSION_KEY, JSON.stringify({ admin: session?.admin, corporate: session?.corporate }));
  } catch {
    // storage blocked; the session lasts for this page only
  }
};

export const readCorporateSession = () => {
  try {
    return JSON.parse(localStorage.getItem(CORPORATE_SESSION_KEY) || 'null');
  } catch {
    return null;
  }
};

export const clearCorporateSession = () => {
  try {
    localStorage.removeItem(CORPORATE_TOKEN_KEY);
    localStorage.removeItem(CORPORATE_SESSION_KEY);
  } catch {
    // ignore
  }
};

export const hasCorporateToken = () => Boolean(readToken());

const client = axios.create({ baseURL: API_BASE_URL, timeout: 30000 });

client.interceptors.request.use((config) => {
  const token = readToken();
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

client.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error?.response?.status === 401 && !String(error.config?.url || '').startsWith('/corporate/auth')) {
      clearCorporateSession();
      if (!window.location.pathname.startsWith(`${CORPORATE_BASE_PATH}/login`)) {
        window.location.assign(`${CORPORATE_BASE_PATH}/login`);
      }
    }
    return Promise.reject(error);
  },
);

const unwrap = (promise) => promise.then((response) => response.data?.data ?? response.data);

export const errorMessage = (error, fallback = 'Something went wrong') =>
  error?.response?.data?.message || error?.message || fallback;

/** Downloads a file response (CSV, PDF) through the authenticated client. */
export const downloadFile = async (url, filename, params = {}) => {
  const response = await client.get(url, { params, responseType: 'blob' });
  const href = URL.createObjectURL(response.data);
  const link = document.createElement('a');
  link.href = href;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(href), 1000);
};

export const corporateApi = {
  register: (body) => unwrap(client.post('/corporate/register', body)),
  login: (body) => unwrap(client.post('/corporate/auth/login', body)),
  sendOtp: (phone) => unwrap(client.post('/corporate/auth/send-otp', { phone })),
  verifyOtp: (phone, otp) => unwrap(client.post('/corporate/auth/verify-otp', { phone, otp })),
  me: () => unwrap(client.get('/corporate/me')),
  changePassword: (body) => unwrap(client.patch('/corporate/me/password', body)),
  updateProfile: (body) => unwrap(client.patch('/corporate/profile', body)),
  dashboard: (params) => unwrap(client.get('/corporate/dashboard', { params })),

  employees: (params) => unwrap(client.get('/corporate/employees', { params })),
  createEmployee: (body) => unwrap(client.post('/corporate/employees', body)),
  updateEmployee: (id, body) => unwrap(client.patch(`/corporate/employees/${id}`, body)),
  deactivateEmployee: (id) => unwrap(client.post(`/corporate/employees/${id}/deactivate`)),
  inviteEmployee: (id) => unwrap(client.post(`/corporate/employees/${id}/invite`)),
  importEmployees: (body) => unwrap(client.post('/corporate/employees/import', body)),
  employeeAllowance: (id, periods = 6) => unwrap(client.get(`/corporate/employees/${id}/allowance`, { params: { periods } })),

  roles: () => unwrap(client.get('/corporate/roles')),
  createRole: (body) => unwrap(client.post('/corporate/roles', body)),
  updateRole: (id, body) => unwrap(client.patch(`/corporate/roles/${id}`, body)),
  /// reassignToRoleId moves the role's employees first; without it the backend refuses (409) a role still in use.
  deleteRole: (id, reassignToRoleId) =>
    unwrap(client.delete(`/corporate/roles/${id}`, { params: reassignToRoleId ? { reassignToRoleId } : {} })),
  assignRole: (roleId, employeeIds) => unwrap(client.post(`/corporate/roles/${roleId}/assign`, { employeeIds })),
  makeDefaultRole: (id) => unwrap(client.post(`/corporate/roles/${id}/make-default`)),

  travelZone: () => unwrap(client.get('/corporate/travel-zone')),
  saveTravelZone: (body) => unwrap(client.put('/corporate/travel-zone', body)),

  quoteBooking: (body) => unwrap(client.post('/corporate/bookings/quote', body)),
  createBooking: (body) => unwrap(client.post('/corporate/bookings', body)),
  bookings: (params) => unwrap(client.get('/corporate/bookings', { params })),
  cancelBooking: (rideId, reason) => unwrap(client.post(`/corporate/bookings/${rideId}/cancel`, { reason })),

  /// Public vehicle catalogue (no auth needed), for the role vehicle pickers.
  vehicleTypes: () => unwrap(client.get('/users/vehicle-types')),

  departments: () => unwrap(client.get('/corporate/departments')),
  createDepartment: (body) => unwrap(client.post('/corporate/departments', body)),
  updateDepartment: (id, body) => unwrap(client.patch(`/corporate/departments/${id}`, body)),
  deleteDepartment: (id) => unwrap(client.delete(`/corporate/departments/${id}`)),

  policies: () => unwrap(client.get('/corporate/policies')),
  saveCompanyPolicy: (body) => unwrap(client.put('/corporate/policies/company', body)),
  saveDepartmentPolicy: (departmentId, body) => unwrap(client.put(`/corporate/policies/departments/${departmentId}`, body)),
  deletePolicy: (id) => unwrap(client.delete(`/corporate/policies/${id}`)),

  tripRequests: (params) => unwrap(client.get('/corporate/trip-requests', { params })),
  approveTrip: (id, note) => unwrap(client.post(`/corporate/trip-requests/${id}/approve`, { note })),
  rejectTrip: (id, note) => unwrap(client.post(`/corporate/trip-requests/${id}/reject`, { note })),

  trips: (params) => unwrap(client.get('/corporate/trips', { params })),
  usage: (params) => unwrap(client.get('/corporate/reports/usage', { params })),
  departmentReport: (params) => unwrap(client.get('/corporate/reports/departments', { params })),
  employeeReport: (params) => unwrap(client.get('/corporate/reports/employees', { params })),
  outstanding: (params) => unwrap(client.get('/corporate/outstanding', { params })),

  invoices: (params) => unwrap(client.get('/corporate/invoices', { params })),
  invoice: (id) => unwrap(client.get(`/corporate/invoices/${id}`)),
  payInvoice: (id) => unwrap(client.post(`/corporate/invoices/${id}/pay`)),
  syncInvoicePayment: (id) => unwrap(client.post(`/corporate/invoices/${id}/sync-payment`)),

  admins: () => unwrap(client.get('/corporate/admins')),
  createAdmin: (body) => unwrap(client.post('/corporate/admins', body)),
  updateAdmin: (id, body) => unwrap(client.patch(`/corporate/admins/${id}`, body)),
};
