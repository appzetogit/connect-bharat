import { Router } from 'express';
import { deliveryRouter } from './deliveryRoutes.js';
import { fareEstimateRouter } from './fareEstimateRoutes.js';
import { promoRouter } from './promoRoutes.js';
import { rideRouter } from './rideRoutes.js';
import { userRouter } from './userRoutes.js';
import { userExtrasRouter } from './userExtrasRoutes.js';
import { tripSecurityRouter } from './tripSecurityRoutes.js';
import { getUserHomeManagement } from '../../admin/controllers/adminController.js';
import { asyncHandler } from '../../../../utils/asyncHandler.js';

export const userModuleRouter = Router();

// Driver OTP redaction + GET /rides/:rideId/delivery-otp. Must sit before the
// /rides and /deliveries routers so its res.json wrapper is in place.
userModuleRouter.use(tripSecurityRouter);
userModuleRouter.get('/user-home-management', asyncHandler(getUserHomeManagement));
userModuleRouter.use(userExtrasRouter);
userModuleRouter.use('/users', userRouter);
userModuleRouter.use('/rides', fareEstimateRouter);
userModuleRouter.use('/rides', rideRouter);
userModuleRouter.use('/deliveries', deliveryRouter);
userModuleRouter.use('/promos', promoRouter);
