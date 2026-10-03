import { Router } from 'express';
import { adminRouter } from './adminRoutes.js';
import { adminLogisticsRouter } from '../../logistics/routes/adminLogisticsRoutes.js';

export const adminModuleRouter = Router();

// Hub parcel network admin; ahead of adminRouter so its paths are matched first.
adminModuleRouter.use('/admin/logistics', adminLogisticsRouter);
adminModuleRouter.use('/', adminRouter);
