import { Router } from 'express';
import { driverRouter } from './driverRoutes.js';
import { driverExtrasRouter } from './driverExtrasRoutes.js';

export const driverModuleRouter = Router();

driverModuleRouter.use('/drivers', driverExtrasRouter);
driverModuleRouter.use('/drivers', driverRouter);
