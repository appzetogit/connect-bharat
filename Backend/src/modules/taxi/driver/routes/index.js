import { Router } from 'express';
import { driverRouter } from './driverRoutes.js';
import { rentalDriverRouter } from '../../rental/routes.js';

export const driverModuleRouter = Router();

driverModuleRouter.use('/drivers', driverRouter);
driverModuleRouter.use('/drivers', rentalDriverRouter);
