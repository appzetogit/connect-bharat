import { Router } from 'express';
import { adminRouter } from './adminRoutes.js';
import { callMaskingSettingsRouter } from './callMaskingSettingsRoutes.js';
import { adminSecurityRouter } from './adminSecurityRoutes.js';
import { rentalAdminRouter } from '../../rental/routes.js';
import { adminPaymentRouter } from '../../payments/routes/adminPaymentRoutes.js';

export const adminModuleRouter = Router();

adminModuleRouter.use('/', adminPaymentRouter);
adminModuleRouter.use('/', adminRouter);
adminModuleRouter.use(callMaskingSettingsRouter);
adminModuleRouter.use('/', adminSecurityRouter);
adminModuleRouter.use('/', rentalAdminRouter);
