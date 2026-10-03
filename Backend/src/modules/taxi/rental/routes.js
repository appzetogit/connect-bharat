import { Router } from 'express';
import { asyncHandler } from '../../../utils/asyncHandler.js';
import { authenticate } from '../middlewares/authMiddleware.js';
import * as user from './controllers/rentalUserController.js';
import * as centre from './controllers/rentalServiceCenterController.js';
import * as admin from './controllers/rentalAdminController.js';

/// Rental module routes (SOW 7.2-7.9). Three routers, each mounted with one
/// line next to the router it extends:
///   rentalUserRouter   -> userModuleRouter.use('/users', ...)
///   rentalDriverRouter -> driverModuleRouter.use('/drivers', ...)
///   rentalAdminRouter  -> adminModuleRouter.use('/', ...)
/// They are mounted after the existing routers, so an existing path always
/// wins (e.g. GET /users/rental-bookings/active is never read as an :id).
/// Documented in docs/api/rental.md.

const USER = ['user'];
const CENTRE = ['service_center', 'service_center_staff'];

export const rentalUserRouter = Router();

rentalUserRouter.get('/rental-config', asyncHandler(user.getRentalConfig));
rentalUserRouter.get('/rental-vehicles/:id/availability', asyncHandler(user.getRentalVehicleAvailability));
rentalUserRouter.post('/rental-bookings/quote', authenticate(USER), asyncHandler(user.quoteRentalBookingRequest));
rentalUserRouter.get('/rental-bookings/:id', authenticate(USER), asyncHandler(user.getMyRentalBooking));
rentalUserRouter.post('/rental-bookings/:id/deposit/order', authenticate(USER), asyncHandler(user.createDepositOrder));
rentalUserRouter.post('/rental-bookings/:id/deposit/pay', authenticate(USER), asyncHandler(user.payDeposit));
rentalUserRouter.post('/rental-bookings/:id/extend/quote', authenticate(USER), asyncHandler(user.quoteExtension));
rentalUserRouter.post('/rental-bookings/:id/extend', authenticate(USER), asyncHandler(user.extendMyRentalBooking));
rentalUserRouter.post('/rental-bookings/:id/extensions/:extId/order', authenticate(USER), asyncHandler(user.createExtensionOrder));
rentalUserRouter.post('/rental-bookings/:id/extensions/:extId/pay', authenticate(USER), asyncHandler(user.payExtension));
rentalUserRouter.get('/rental-bookings/:id/damage-reports', authenticate(USER), asyncHandler(user.listMyDamageReports));
rentalUserRouter.post('/rental-bookings/:id/damage-reports', authenticate(USER), asyncHandler(user.reportDamage));
rentalUserRouter.post('/rental-damage-reports/:reportId/dispute', authenticate(USER), asyncHandler(user.disputeMyDamageReport));
rentalUserRouter.get('/rental-bookings/:id/invoice.json', authenticate(USER), asyncHandler(user.getMyRentalInvoiceJson));
rentalUserRouter.get('/rental-bookings/:id/invoice', authenticate(USER), asyncHandler(user.getMyRentalInvoicePdf));

export const rentalDriverRouter = Router();

rentalDriverRouter.get('/rental-assignments', authenticate(['driver']), asyncHandler(centre.listMyRentalAssignments));
rentalDriverRouter.get('/service-center/rental-units', authenticate(CENTRE), asyncHandler(centre.listServiceCenterUnits));
rentalDriverRouter.patch('/service-center/bookings/:bookingId/assignment', authenticate(CENTRE), asyncHandler(centre.assignServiceCenterUnit));
rentalDriverRouter.get('/service-center/bookings/:bookingId/damage-reports', authenticate(CENTRE), asyncHandler(centre.listServiceCenterDamageReports));
rentalDriverRouter.post('/service-center/bookings/:bookingId/damage-reports', authenticate(CENTRE), asyncHandler(centre.reportServiceCenterDamage));
rentalDriverRouter.post('/service-center/bookings/:bookingId/deposit/collect', authenticate(CENTRE), asyncHandler(centre.collectServiceCenterDeposit));
rentalDriverRouter.post('/service-center/bookings/:bookingId/deposit/release', authenticate(CENTRE), asyncHandler(centre.releaseServiceCenterDeposit));
rentalDriverRouter.get('/service-center/bookings/:bookingId/invoice.json', authenticate(CENTRE), asyncHandler(centre.getServiceCenterInvoiceJson));
rentalDriverRouter.get('/service-center/bookings/:bookingId/invoice', authenticate(CENTRE), asyncHandler(centre.getServiceCenterInvoicePdf));

export const rentalAdminRouter = Router();
const ADMIN = authenticate(['admin']);

rentalAdminRouter.get('/admin/rental-settings', ADMIN, asyncHandler(admin.getRentalSettingsAdmin));
rentalAdminRouter.patch('/admin/rental-settings', ADMIN, asyncHandler(admin.updateRentalSettingsAdmin));
rentalAdminRouter.get('/admin/rental-vehicle-units', ADMIN, asyncHandler(admin.listUnits));
rentalAdminRouter.post('/admin/rental-vehicle-units', ADMIN, asyncHandler(admin.createUnit));
rentalAdminRouter.patch('/admin/rental-vehicle-units/:id', ADMIN, asyncHandler(admin.updateUnit));
rentalAdminRouter.delete('/admin/rental-vehicle-units/:id', ADMIN, asyncHandler(admin.deleteUnit));
rentalAdminRouter.get('/admin/rental-vehicles/:id/availability', ADMIN, asyncHandler(admin.getAvailabilityAdmin));
rentalAdminRouter.patch('/admin/rental-booking-requests/:id/assignment', ADMIN, asyncHandler(admin.updateAssignment));
rentalAdminRouter.get('/admin/rental-deposits', ADMIN, asyncHandler(admin.listDeposits));
rentalAdminRouter.post('/admin/rental-booking-requests/:id/deposit/collect', ADMIN, asyncHandler(admin.collectDepositAdmin));
rentalAdminRouter.post('/admin/rental-booking-requests/:id/deposit/release', ADMIN, asyncHandler(admin.releaseDepositAdmin));
rentalAdminRouter.get('/admin/rental-extensions', ADMIN, asyncHandler(admin.listExtensions));
rentalAdminRouter.patch('/admin/rental-booking-requests/:id/extensions/:extId', ADMIN, asyncHandler(admin.decideExtension));
rentalAdminRouter.get('/admin/rental-damage-reports', ADMIN, asyncHandler(admin.listDamage));
rentalAdminRouter.get('/admin/rental-damage-reports/:id', ADMIN, asyncHandler(admin.getDamage));
rentalAdminRouter.patch('/admin/rental-damage-reports/:id', ADMIN, asyncHandler(admin.actOnDamage));
rentalAdminRouter.post('/admin/rental-booking-requests/:id/damage-reports', ADMIN, asyncHandler(admin.reportDamageAdmin));
rentalAdminRouter.get('/admin/rental-booking-requests/:id/invoice.json', ADMIN, asyncHandler(admin.getInvoiceJsonAdmin));
rentalAdminRouter.get('/admin/rental-booking-requests/:id/invoice', ADMIN, asyncHandler(admin.getInvoicePdfAdmin));
