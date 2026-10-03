import { AdminBusinessSetting } from '../../admin/models/AdminBusinessSetting.js';
import { getOrLoadCachedValue } from '../../../../utils/cache.js';
import { createDefaultRentalSettings } from '../data/defaultRentalSettings.js';

const SETTINGS_CACHE_TTL_MS = 30_000;

/// The `rental` business-settings section merged over its defaults, the same
/// way transportSettingsService reads `transport_ride`.
export const getRentalSettings = async () =>
  getOrLoadCachedValue('cache:settings:rental', {
    ttlMs: SETTINGS_CACHE_TTL_MS,
    load: async () => {
      const businessSettings = await AdminBusinessSetting.findOne({ scope: 'default' }).select('rental').lean();
      return {
        ...createDefaultRentalSettings(),
        ...(businessSettings?.rental || {}),
      };
    },
  });

export const isRentalFlagOn = (settings, key) => String(settings?.[key] ?? '0').trim() === '1';
