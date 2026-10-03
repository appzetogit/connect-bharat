import { Router } from 'express';
import { asyncHandler } from '../../../../utils/asyncHandler.js';
import { authenticate } from '../../middlewares/authMiddleware.js';
import {
  getExotelSettings,
  serializeExotelSettingsForAdmin,
  updateExotelSettings,
} from '../services/thirdPartySettingsService.js';
import { isExotelConfigured } from '../../services/callMaskingService.js';

/**
 * Admin settings for rider-driver call masking (Exotel). Same URL family as
 * the other integration settings; its own file so adminRoutes.js is untouched.
 */

export const callMaskingSettingsRouter = Router();

const adminOnly = authenticate(['admin']);

const respond = (res, settings) =>
  res.json({
    success: true,
    data: {
      settings: serializeExotelSettingsForAdmin(settings),
      // What POST /rides/:rideId/call will actually use with these settings.
      active_provider: isExotelConfigured(settings) ? 'exotel' : 'none',
    },
  });

callMaskingSettingsRouter.get('/admin/integration-settings/call-masking', adminOnly, asyncHandler(async (_req, res) => {
  respond(res, await getExotelSettings());
}));

callMaskingSettingsRouter.patch('/admin/integration-settings/call-masking', adminOnly, asyncHandler(async (req, res) => {
  respond(res, await updateExotelSettings(req.body?.exotel || req.body || {}));
}));
