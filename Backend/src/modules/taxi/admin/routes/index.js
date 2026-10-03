import { Router } from 'express';
import { adminRouter } from './adminRoutes.js';
import { callMaskingSettingsRouter } from './callMaskingSettingsRoutes.js';
import { adminSecurityRouter } from './adminSecurityRoutes.js';
import { rentalAdminRouter } from '../../rental/routes.js';
import { adminPaymentRouter } from '../../payments/routes/adminPaymentRoutes.js';
import { adminLogisticsRouter } from '../../logistics/routes/adminLogisticsRoutes.js';

export const adminModuleRouter = Router();

// Hub parcel network admin; ahead of adminRouter so its paths are matched first.
adminModuleRouter.use('/admin/logistics', adminLogisticsRouter);
adminModuleRouter.use('/', adminPaymentRouter);
adminModuleRouter.use('/', adminRouter);
adminModuleRouter.use(callMaskingSettingsRouter);
adminModuleRouter.use('/', adminSecurityRouter);
adminModuleRouter.use('/', rentalAdminRouter);
