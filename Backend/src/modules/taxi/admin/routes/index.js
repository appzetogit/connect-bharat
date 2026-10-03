import { Router } from 'express';
import { adminRouter } from './adminRoutes.js';
import { rentalAdminRouter } from '../../rental/routes.js';

export const adminModuleRouter = Router();

adminModuleRouter.use('/', adminRouter);
adminModuleRouter.use('/', rentalAdminRouter);
