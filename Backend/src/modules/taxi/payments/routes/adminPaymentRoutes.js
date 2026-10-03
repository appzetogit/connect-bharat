import { Router } from 'express';
import { asyncHandler } from '../../../../utils/asyncHandler.js';
import { authenticate } from '../../middlewares/authMiddleware.js';
import {
  adminApproveOwnerWithdrawal,
  adminApproveRefund,
  adminCreateRefund,
  adminGetPaymentSettings,
  adminGetRefund,
  adminListLedger,
  adminListOwnerWithdrawals,
  adminListPaymentEvents,
  adminListPayouts,
  adminListRefunds,
  adminPaymentSummary,
  adminProcessDueEvents,
  adminRejectOwnerWithdrawal,
  adminRejectRefund,
  adminUpdatePaymentSettings,
  requireAdminPermission,
} from '../controllers/paymentController.js';

/// Admin payments API (refunds, ledger, reports, payouts, owner
/// withdrawals). Mounted from admin/routes/index.js.
export const adminPaymentRouter = Router();

const admin = authenticate(['admin']);
const wallet = requireAdminPermission('wallet.view');
const settings = requireAdminPermission('settings.view');

adminPaymentRouter.get('/admin/payments/refunds', admin, wallet, asyncHandler(adminListRefunds));
adminPaymentRouter.post('/admin/payments/refunds', admin, wallet, asyncHandler(adminCreateRefund));
adminPaymentRouter.get('/admin/payments/refunds/:id', admin, wallet, asyncHandler(adminGetRefund));
adminPaymentRouter.post('/admin/payments/refunds/:id/approve', admin, wallet, asyncHandler(adminApproveRefund));
adminPaymentRouter.post('/admin/payments/refunds/:id/reject', admin, wallet, asyncHandler(adminRejectRefund));

adminPaymentRouter.get('/admin/payments/ledger', admin, wallet, asyncHandler(adminListLedger));
adminPaymentRouter.get('/admin/payments/reports/summary', admin, wallet, asyncHandler(adminPaymentSummary));
adminPaymentRouter.get('/admin/payments/events', admin, wallet, asyncHandler(adminListPaymentEvents));
adminPaymentRouter.post('/admin/payments/events/process-due', admin, wallet, asyncHandler(adminProcessDueEvents));
adminPaymentRouter.get('/admin/payments/payouts', admin, wallet, asyncHandler(adminListPayouts));

adminPaymentRouter.get('/admin/payments/settings', admin, settings, asyncHandler(adminGetPaymentSettings));
adminPaymentRouter.patch('/admin/payments/settings', admin, settings, asyncHandler(adminUpdatePaymentSettings));

// Owner withdrawals: the owners list existed, approve/reject did not (gap 2.15).
adminPaymentRouter.get('/admin/wallet/owners/:id/withdrawals', admin, wallet, asyncHandler(adminListOwnerWithdrawals));
adminPaymentRouter.patch('/admin/wallet/owners/withdrawals/:requestId/approve', admin, wallet, asyncHandler(adminApproveOwnerWithdrawal));
adminPaymentRouter.patch('/admin/wallet/owners/withdrawals/:requestId/reject', admin, wallet, asyncHandler(adminRejectOwnerWithdrawal));
