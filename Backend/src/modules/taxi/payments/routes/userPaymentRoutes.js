import { Router } from 'express';
import { asyncHandler } from '../../../../utils/asyncHandler.js';
import { authenticate } from '../../middlewares/authMiddleware.js';
import { getMyRefunds, getMyWalletTransactions } from '../controllers/paymentController.js';

/// Rider-facing payments API. Mounted under /users from user/routes/index.js.
export const userPaymentRouter = Router();

userPaymentRouter.get('/wallet/transactions', authenticate(['user']), asyncHandler(getMyWalletTransactions));
userPaymentRouter.get('/payments/refunds', authenticate(['user']), asyncHandler(getMyRefunds));
