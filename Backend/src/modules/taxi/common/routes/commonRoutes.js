import { Router } from 'express';
import * as commonController from '../controllers/commonController.js';
import { requireUploadAuth } from '../../middlewares/uploadAuthMiddleware.js';

export const commonRouter = Router();

// Universal image upload endpoint. JWT, or a live signup/onboarding session
// for pre-token callers; see uploadAuthMiddleware.
commonRouter.post('/common/upload/image', requireUploadAuth, commonController.uploadImage);
commonRouter.get('/common/referrals/translation', commonController.getReferralTranslation);
commonRouter.get('/common/referrals/settings', commonController.getReferralSettingsContent);
commonRouter.get('/common/payment-gateway', commonController.getPaymentGatewayConfig);
commonRouter.post('/common/payment-gateway/phonepe/callback', commonController.acknowledgePhonePeCallback);
commonRouter.get('/common/recharge-api/callback', commonController.acknowledgeRechargeApiCallback);
commonRouter.post('/common/recharge-api/callback', commonController.acknowledgeRechargeApiCallback);
