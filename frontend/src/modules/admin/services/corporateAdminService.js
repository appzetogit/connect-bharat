import api from '../../../shared/api/axiosInstance';

/**
 * Admin calls for the corporate module (/admin/corporates/...). Kept apart
 * from adminService.js so this feature does not edit that shared file.
 * Every call resolves to the backend's `data` payload.
 */
/// The shared client resolves to a proxy of `{ success, data }`; `__raw` is
/// the plain object underneath, which is what React state should hold.
const unwrap = (promise) => promise.then((body) => {
  const raw = body?.__raw || body;
  return raw && typeof raw === 'object' && 'data' in raw && 'success' in raw ? raw.data : raw;
});

const base = '/admin/corporates';

export const corporateAdminService = {
  list: (params) => unwrap(api.get(base, { params })),
  create: (body) => unwrap(api.post(base, body)),
  fromEnquiry: (enquiryId, body) => unwrap(api.post(`${base}/from-enquiry/${enquiryId}`, body)),
  detail: (id) => unwrap(api.get(`${base}/${id}`)),
  update: (id, body) => unwrap(api.patch(`${base}/${id}`, body)),
  approve: (id, body) => unwrap(api.post(`${base}/${id}/approve`, body)),
  reject: (id, reason) => unwrap(api.post(`${base}/${id}/reject`, { reason })),
  suspend: (id, reason) => unwrap(api.post(`${base}/${id}/suspend`, { reason })),
  reactivate: (id) => unwrap(api.post(`${base}/${id}/reactivate`)),
  employees: (id, params) => unwrap(api.get(`${base}/${id}/employees`, { params })),
  trips: (id, params) => unwrap(api.get(`${base}/${id}/trips`, { params })),
  usage: (id, params) => unwrap(api.get(`${base}/${id}/reports/usage`, { params })),
  ledger: (id, params) => unwrap(api.get(`${base}/${id}/ledger`, { params })),
  adjustLedger: (id, body) => unwrap(api.post(`${base}/${id}/ledger/adjust`, body)),
  invoices: (id, params) => unwrap(api.get(`${base}/${id}/invoices`, { params })),
  generateInvoice: (id, body) => unwrap(api.post(`${base}/${id}/invoices/generate`, body)),
  issueInvoice: (invoiceId, email) => unwrap(api.post(`${base}/invoices/${invoiceId}/issue`, { email })),
  emailInvoice: (invoiceId) => unwrap(api.post(`${base}/invoices/${invoiceId}/email`, {})),
  recordPayment: (invoiceId, body) => unwrap(api.post(`${base}/invoices/${invoiceId}/payments`, body)),
  voidInvoice: (invoiceId, reason) => unwrap(api.post(`${base}/invoices/${invoiceId}/void`, { reason })),
  paymentLink: (invoiceId) => unwrap(api.post(`${base}/invoices/${invoiceId}/payment-link`)),
  invoice: (invoiceId) => unwrap(api.get(`${base}/invoices/${invoiceId}`)),
  roles: (id) => unwrap(api.get(`${base}/${id}/roles`)),
  createRole: (id, body) => unwrap(api.post(`${base}/${id}/roles`, body)),
  updateRole: (id, roleId, body) => unwrap(api.patch(`${base}/${id}/roles/${roleId}`, body)),
  deleteRole: (id, roleId, reassignToRoleId) =>
    unwrap(api.delete(`${base}/${id}/roles/${roleId}`, { params: reassignToRoleId ? { reassignToRoleId } : {} })),
  assignRole: (id, roleId, employeeIds) => unwrap(api.post(`${base}/${id}/roles/${roleId}/assign`, { employeeIds })),
  makeDefaultRole: (id, roleId) => unwrap(api.post(`${base}/${id}/roles/${roleId}/make-default`)),
  allowance: (id, params) => unwrap(api.get(`${base}/${id}/allowance`, { params })),
  /// The admin vehicle-type listing, for the tariff rows and role vehicle pickers.
  vehicleTypes: () => unwrap(api.get('/admin/types/vehicle-types/list')),
  aging: (params) => unwrap(api.get(`${base}/aging`, { params })),
  settings: () => unwrap(api.get(`${base}/settings`)),
  saveSettings: (body) => unwrap(api.patch(`${base}/settings`, body)),
  downloadInvoicePdf: (invoiceId, filename) => downloadBlob(`${base}/invoices/${invoiceId}/pdf`, filename),
  /// The per-trip annex; format is 'csv' or 'xlsx'.
  exportInvoice: (invoiceId, format, filename) => downloadBlob(`${base}/invoices/${invoiceId}/export.${format}`, filename),
};

async function downloadBlob(url, filename) {
  const response = await api.get(url, { responseType: 'blob' });
  // The shared client's interceptor resolves to the body itself, a Blob here.
  const blob = response instanceof Blob ? response : response?.data;
  const href = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = href;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(href), 1000);
}

export const errorText = (error, fallback = 'Something went wrong') => error?.response?.data?.message || error?.message || fallback;
