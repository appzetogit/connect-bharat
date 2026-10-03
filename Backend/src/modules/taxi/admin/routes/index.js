import { Router } from 'express';
import { adminRouter } from './adminRoutes.js';
import { adminSecurityRouter } from './adminSecurityRoutes.js';

export const adminModuleRouter = Router();

adminModuleRouter.use('/', adminRouter);
adminModuleRouter.use('/', adminSecurityRouter);
