import { createDefaultBusinessSettings } from '../../admin/data/defaultBusinessSettings.js';
import { AdminBusinessSetting } from '../../admin/models/AdminBusinessSetting.js';
import { ApiError } from '../../../../utils/ApiError.js';
import { getOrLoadCachedValue, invalidateCachedValue } from '../../../../utils/cache.js';
import { isEnabledFlag } from '../utils/paymentUtils.js';

/// `payments` section of AdminBusinessSetting, merged over the shipped
/// defaults so an install whose settings document predates this section
/// behaves exactly as before (auto refunds off, manual payouts).
const defaultPaymentSettings = createDefaultBusinessSettings().payments || {};
const CACHE_KEY = 'cache:settings:payments';
const SETTINGS_CACHE_TTL_MS = 30_000;

const PAYOUT_MODES = ['manual', 'razorpayx'];
const TRANSFER_MODES = ['IMPS', 'NEFT', 'RTGS', 'UPI'];

let lastLoaded = null;

/// Settings as last read, for synchronous callers that already awaited once.
export const getLastLoadedPaymentSettings = () => lastLoaded || { ...defaultPaymentSettings };

export const getPaymentSettings = async ({ fresh = false } = {}) => {
  const load = async () => {
    const businessSettings = await AdminBusinessSetting.findOne({ scope: 'default' }).select('payments').lean();
    return { ...defaultPaymentSettings, ...(businessSettings?.payments || {}) };
  };

  if (fresh) {
    lastLoaded = await load();
    return lastLoaded;
  }

  lastLoaded = await getOrLoadCachedValue(CACHE_KEY, { ttlMs: SETTINGS_CACHE_TTL_MS, load });
  return lastLoaded;
};

export const isAutoRefundEnabled = async () => isEnabledFlag((await getPaymentSettings()).auto_refund_enabled, false);

export const getPayoutMode = async () => {
  const mode = String((await getPaymentSettings()).payout_mode || 'manual').trim().toLowerCase();
  return PAYOUT_MODES.includes(mode) ? mode : 'manual';
};

/// Validates and saves the payments section. Returns the merged settings.
export const updatePaymentSettings = async (payload = {}) => {
  const input = payload?.settings && typeof payload.settings === 'object' ? payload.settings : payload;
  const next = {};

  if (input.auto_refund_enabled !== undefined) {
    next.auto_refund_enabled = isEnabledFlag(input.auto_refund_enabled) ? '1' : '0';
  }
  if (input.payout_mode !== undefined) {
    const mode = String(input.payout_mode || '').trim().toLowerCase();
    if (!PAYOUT_MODES.includes(mode)) {
      throw new ApiError(400, `payout_mode must be one of ${PAYOUT_MODES.join(', ')}`);
    }
    next.payout_mode = mode;
  }
  if (input.payout_transfer_mode !== undefined) {
    const mode = String(input.payout_transfer_mode || '').trim().toUpperCase();
    if (!TRANSFER_MODES.includes(mode)) {
      throw new ApiError(400, `payout_transfer_mode must be one of ${TRANSFER_MODES.join(', ')}`);
    }
    next.payout_transfer_mode = mode;
  }
  if (input.razorpayx_account_number !== undefined) {
    next.razorpayx_account_number = String(input.razorpayx_account_number || '').trim();
  }

  const current = await getPaymentSettings({ fresh: true });
  const merged = { ...current, ...next };

  await AdminBusinessSetting.updateOne(
    { scope: 'default' },
    { $set: { payments: merged } },
    { upsert: true },
  );

  await invalidateCachedValue(CACHE_KEY).catch(() => null);
  lastLoaded = merged;
  return merged;
};
