import { Router } from 'express';
import { chatModuleRouter } from '../chat/routes/index.js';
import { adminModuleRouter } from '../admin/routes/index.js';
import { driverModuleRouter } from '../driver/routes/index.js';
import { supportModuleRouter } from '../support/routes/index.js';
import { userModuleRouter } from '../user/routes/index.js';
import { commonRouter } from '../common/routes/commonRoutes.js';
import { careerRouter } from '../career/routes/careerRoutes.js';
import { outstationRouter } from '../outstation/routes.js';
import { corporateModuleRouter } from '../corporate/routes/index.js';

export const taxiRouter = Router();

// First, so /admin/corporates and /users/me/corporate match before the admin
// and user routers' blanket auth.
taxiRouter.use(corporateModuleRouter);
taxiRouter.use(chatModuleRouter);
taxiRouter.use(adminModuleRouter);
taxiRouter.use(userModuleRouter);
taxiRouter.use(driverModuleRouter);
taxiRouter.use(supportModuleRouter);
taxiRouter.use(commonRouter);
taxiRouter.use(careerRouter);
taxiRouter.use(outstationRouter);
