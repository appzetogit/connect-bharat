import { Router } from 'express';
import { asyncHandler } from '../../../../utils/asyncHandler.js';
import { authenticate } from '../../middlewares/authMiddleware.js';
import * as admin from '../controllers/adminLogisticsController.js';
import { requireAdminPermission } from '../middleware/hubAuth.js';

/// /admin/logistics/* — mounted by admin/routes/index.js. Authenticated
/// here as well as by the admin router, so it stays safe if it is ever
/// mounted ahead of the admin router's own `authenticate`.
export const adminLogisticsRouter = Router();

adminLogisticsRouter.use(authenticate(['admin']), requireAdminPermission('deliveries.view'));

adminLogisticsRouter.get('/hubs', asyncHandler(admin.hubsList));
adminLogisticsRouter.post('/hubs', asyncHandler(admin.hubCreate));
adminLogisticsRouter.get('/hubs/league-table', asyncHandler(admin.leagueTable));
adminLogisticsRouter.get('/hubs/:id', asyncHandler(admin.hubGet));
adminLogisticsRouter.patch('/hubs/:id', asyncHandler(admin.hubUpdate));
adminLogisticsRouter.delete('/hubs/:id', asyncHandler(admin.hubDelete));
adminLogisticsRouter.get('/hubs/:id/performance', asyncHandler(admin.hubPerformance));
adminLogisticsRouter.get('/hubs/:id/revenue', asyncHandler(admin.hubRevenue));

adminLogisticsRouter.get('/staff', asyncHandler(admin.staffList));
adminLogisticsRouter.post('/staff', asyncHandler(admin.staffCreate));
adminLogisticsRouter.patch('/staff/:id', asyncHandler(admin.staffUpdate));
adminLogisticsRouter.delete('/staff/:id', asyncHandler(admin.staffDelete));

adminLogisticsRouter.get('/rate-cards', asyncHandler(admin.rateCardsList));
adminLogisticsRouter.post('/rate-cards', asyncHandler(admin.rateCardCreate));
adminLogisticsRouter.put('/rate-cards/:id', asyncHandler(admin.rateCardUpdate));
adminLogisticsRouter.delete('/rate-cards/:id', asyncHandler(admin.rateCardDelete));

adminLogisticsRouter.get('/shipments', asyncHandler(admin.shipmentsSearch));
adminLogisticsRouter.get('/shipments/:awb', asyncHandler(admin.shipmentGet));

adminLogisticsRouter.get('/settings', asyncHandler(admin.settingsGet));
adminLogisticsRouter.put('/settings', asyncHandler(admin.settingsUpdate));
