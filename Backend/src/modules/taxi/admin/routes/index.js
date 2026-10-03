import { Router } from 'express';
import { adminRouter } from './adminRoutes.js';
import { adminPaymentRouter } from '../../payments/routes/adminPaymentRoutes.js';

export const adminModuleRouter = Router();

adminModuleRouter.use('/', adminPaymentRouter);
adminModuleRouter.use('/', adminRouter);
