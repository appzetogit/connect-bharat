import { Router } from 'express';
import { adminRouter } from './adminRoutes.js';
import { callMaskingSettingsRouter } from './callMaskingSettingsRoutes.js';
import { adminSecurityRouter } from './adminSecurityRoutes.js';

export const adminModuleRouter = Router();

adminModuleRouter.use('/', adminRouter);
adminModuleRouter.use(callMaskingSettingsRouter);
adminModuleRouter.use('/', adminSecurityRouter);
