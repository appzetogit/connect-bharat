import { Router } from 'express';
import { asyncHandler } from '../../../../utils/asyncHandler.js';
import { authenticate } from '../../middlewares/authMiddleware.js';
import { loginRateLimit, otpSendRateLimit, otpVerifyRateLimit } from '../../middlewares/rateLimitMiddleware.js';
import { requireCorporateAccess, requireCorporatesPermission } from '../middlewares/corporateAccess.js';
import * as panel from '../controllers/corporatePanelController.js';
import * as admin from '../controllers/adminCorporateController.js';
import { getMyCorporate } from '../controllers/riderCorporateController.js';
import * as v2 from '../controllers/corporateV2Controller.js';

/// Every corporate route, mounted from routes/index.js with one line. Three
/// surfaces:
///   /corporate/...         corporate web panel (role corporate_admin) + public register/login
///   /admin/corporates/...  platform admin
///   /users/me/corporate    rider app
/// See docs/api/corporate.md.

const h = asyncHandler;

// --- corporate panel -------------------------------------------------------

const panelRouter = Router();
const signedIn = authenticate(['corporate_admin']);
const anyRole = requireCorporateAccess();
const managers = requireCorporateAccess({ roles: ['owner', 'admin'] });
const deciders = requireCorporateAccess({ roles: ['owner', 'admin', 'approver'] });
const money = requireCorporateAccess({ roles: ['owner', 'admin', 'finance'] });
const inactiveOk = requireCorporateAccess({ allowInactive: true });

panelRouter.post('/register', loginRateLimit, h(panel.register));
panelRouter.post('/auth/login', loginRateLimit, h(panel.login));
panelRouter.post('/auth/send-otp', otpSendRateLimit, h(panel.sendOtp));
panelRouter.post('/auth/verify-otp', otpVerifyRateLimit, h(panel.verifyOtp));

panelRouter.use(signedIn);
panelRouter.get('/me', inactiveOk, h(panel.getMe));
panelRouter.patch('/me/password', inactiveOk, h(panel.changePassword));
panelRouter.patch('/profile', requireCorporateAccess({ roles: ['owner', 'admin', 'finance'], allowInactive: true }), h(panel.updateProfile));
panelRouter.get('/dashboard', anyRole, h(panel.getDashboard));

panelRouter.get('/employees/import-template', anyRole, h(panel.employeeImportTemplate));
panelRouter.post('/employees/import', managers, h(panel.importEmployees));
panelRouter.get('/employees', anyRole, h(panel.listEmployees));
panelRouter.post('/employees', managers, h(panel.createEmployee));
panelRouter.get('/employees/:employeeId', anyRole, h(panel.getEmployee));
panelRouter.get('/employees/:employeeId/allowance', anyRole, h(v2.employeeAllowance));
panelRouter.patch('/employees/:employeeId', managers, h(panel.updateEmployee));
panelRouter.post('/employees/:employeeId/deactivate', managers, h(panel.deactivateEmployee));
panelRouter.post('/employees/:employeeId/invite', managers, h(panel.inviteEmployee));

// Corporate v2: roles, travel zone, travel desk (docs/plans/corporate-v2.md §3.1).
panelRouter.get('/roles', anyRole, h(v2.panelRoles.list));
panelRouter.post('/roles', managers, h(v2.panelRoles.create));
panelRouter.patch('/roles/:roleId', managers, h(v2.panelRoles.update));
panelRouter.delete('/roles/:roleId', managers, h(v2.panelRoles.remove));
panelRouter.post('/roles/:roleId/make-default', managers, h(v2.panelRoles.makeDefault));
panelRouter.post('/roles/:roleId/assign', managers, h(v2.panelRoles.assign));
panelRouter.get('/travel-zone', anyRole, h(v2.getTravelZone));
panelRouter.put('/travel-zone', managers, h(v2.putTravelZone));
panelRouter.post('/bookings/quote', deciders, h(v2.quoteBooking));
panelRouter.post('/bookings', deciders, h(v2.createBooking));
panelRouter.get('/bookings', anyRole, h(v2.listBookings));
panelRouter.post('/bookings/:rideId/cancel', deciders, h(v2.cancelBooking));

panelRouter.get('/departments', anyRole, h(panel.getDepartments));
panelRouter.post('/departments', managers, h(panel.postDepartment));
panelRouter.patch('/departments/:departmentId', managers, h(panel.patchDepartment));
panelRouter.delete('/departments/:departmentId', managers, h(panel.removeDepartment));

panelRouter.get('/policies', anyRole, h(panel.getPolicies));
panelRouter.put('/policies/company', managers, h(panel.putCompanyPolicy));
panelRouter.put('/policies/departments/:departmentId', managers, h(panel.putDepartmentPolicy));
panelRouter.delete('/policies/:policyId', managers, h(panel.removePolicy));

panelRouter.get('/trip-requests', deciders, h(panel.getTripRequests));
panelRouter.post('/trip-requests/:tripRequestId/approve', deciders, h(panel.approveTrip));
panelRouter.post('/trip-requests/:tripRequestId/reject', deciders, h(panel.rejectTrip));

panelRouter.get('/trips', anyRole, h(panel.getTrips));
panelRouter.get('/reports/usage', anyRole, h(panel.getUsageReport));
panelRouter.get('/reports/departments', anyRole, h(panel.getDepartmentsReport));
panelRouter.get('/reports/employees', anyRole, h(panel.getEmployeesReport));
panelRouter.get('/outstanding', money, h(panel.getOutstanding));

panelRouter.get('/invoices', money, h(panel.getInvoices));
panelRouter.get('/invoices/:invoiceId', money, h(panel.getInvoice));
panelRouter.get('/invoices/:invoiceId/pdf', money, h(panel.downloadInvoicePdf));
panelRouter.get('/invoices/:invoiceId/export.csv', money, h(v2.panelInvoiceCsv));
panelRouter.get('/invoices/:invoiceId/export.xlsx', money, h(v2.panelInvoiceXlsx));
panelRouter.post('/invoices/:invoiceId/pay', money, h(panel.payInvoice));
panelRouter.post('/invoices/:invoiceId/sync-payment', money, h(panel.syncInvoicePayment));

panelRouter.get('/admins', managers, h(panel.getAdmins));
panelRouter.post('/admins', managers, h(panel.postAdmin));
panelRouter.patch('/admins/:adminUserId', managers, h(panel.patchAdmin));

// --- platform admin --------------------------------------------------------

const adminRouter = Router();
adminRouter.use(authenticate(['admin']), requireCorporatesPermission);

adminRouter.get('/', h(admin.list));
adminRouter.post('/', h(admin.create));
adminRouter.get('/settings', h(admin.getSettings));
adminRouter.patch('/settings', h(admin.patchSettings));
adminRouter.get('/aging', h(admin.aging));
adminRouter.post('/from-enquiry/:enquiryId', h(admin.fromEnquiry));

adminRouter.get('/invoices', h(admin.allInvoices));
adminRouter.get('/invoices/:invoiceId', h(admin.invoice));
adminRouter.get('/invoices/:invoiceId/pdf', h(admin.invoicePdf));
adminRouter.get('/invoices/:invoiceId/export.csv', h(v2.adminInvoiceCsv));
adminRouter.get('/invoices/:invoiceId/export.xlsx', h(v2.adminInvoiceXlsx));
adminRouter.post('/invoices/:invoiceId/issue', h(admin.issueInvoice));
adminRouter.post('/invoices/:invoiceId/email', h(admin.emailInvoice));
adminRouter.post('/invoices/:invoiceId/payments', h(admin.recordPayment));
adminRouter.post('/invoices/:invoiceId/void', h(admin.voidInvoice));
adminRouter.post('/invoices/:invoiceId/payment-link', h(admin.paymentLink));
adminRouter.post('/invoices/:invoiceId/payment-link/sync', h(admin.syncPaymentLink));

adminRouter.get('/:id', h(admin.detail));
adminRouter.patch('/:id', h(admin.update));
adminRouter.post('/:id/approve', h(admin.approve));
adminRouter.post('/:id/reject', h(admin.reject));
adminRouter.post('/:id/suspend', h(admin.suspend));
adminRouter.post('/:id/reactivate', h(admin.reactivate));
adminRouter.get('/:id/employees', h(admin.employees));
adminRouter.post('/:id/employees', h(admin.addEmployee));
adminRouter.patch('/:id/employees/:employeeId', h(admin.editEmployee));
adminRouter.post('/:id/employees/import', h(admin.importEmployees));
adminRouter.get('/:id/departments', h(admin.departments));
adminRouter.get('/:id/roles', h(v2.adminRoles.list));
adminRouter.post('/:id/roles', h(v2.adminRoles.create));
adminRouter.patch('/:id/roles/:roleId', h(v2.adminRoles.update));
adminRouter.delete('/:id/roles/:roleId', h(v2.adminRoles.remove));
adminRouter.post('/:id/roles/:roleId/make-default', h(v2.adminRoles.makeDefault));
adminRouter.post('/:id/roles/:roleId/assign', h(v2.adminRoles.assign));
adminRouter.get('/:id/allowance', h(v2.adminAllowance));
adminRouter.get('/:id/trip-requests', h(admin.tripRequests));
adminRouter.get('/:id/trips', h(admin.trips));
adminRouter.get('/:id/reports/usage', h(admin.usage));
adminRouter.get('/:id/ledger', h(admin.ledger));
adminRouter.post('/:id/ledger/adjust', h(admin.adjustLedger));
adminRouter.post('/:id/ledger/recompute', h(admin.recomputeLedger));
adminRouter.get('/:id/invoices', h(admin.corporateInvoices));
adminRouter.post('/:id/invoices/generate', h(admin.generateInvoice));

// --- module router ---------------------------------------------------------

export const corporateModuleRouter = Router();

corporateModuleRouter.get('/users/me/corporate', authenticate(['user']), h(getMyCorporate));
corporateModuleRouter.use('/corporate', panelRouter);
corporateModuleRouter.use('/admin/corporates', adminRouter);
