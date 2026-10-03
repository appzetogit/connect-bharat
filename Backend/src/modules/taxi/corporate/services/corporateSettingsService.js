import { AdminBusinessSetting } from '../../admin/models/AdminBusinessSetting.js';
import { getOrLoadCachedValue, invalidateCachedValue } from '../../../../utils/cache.js';
import { createDefaultCorporateSettings } from '../data/defaultCorporateSettings.js';

const CACHE_KEY = 'cache:settings:corporate';
const SETTINGS_CACHE_TTL_MS = 30_000;

export const isFlagOn = (value) => ['1', 'true', 'yes', 'on'].includes(String(value ?? '').trim().toLowerCase());

/// The stored `corporate` section over the defaults. Read with `strict: false`
/// semantics (lean, raw path) so it works whether or not the merged schema
/// declares the section.
export const getCorporateSettings = async () =>
  getOrLoadCachedValue(CACHE_KEY, {
    ttlMs: SETTINGS_CACHE_TTL_MS,
    load: async () => {
      const doc = await AdminBusinessSetting.collection.findOne(
        { scope: 'default' },
        { projection: { corporate: 1 } },
      );
      return { ...createDefaultCorporateSettings(), ...(doc?.corporate || {}) };
    },
  });

/// Only keys that exist in the defaults are accepted, so a typo in the admin
/// panel cannot plant a setting nothing reads.
export const updateCorporateSettings = async (patch = {}) => {
  const defaults = createDefaultCorporateSettings();
  const $set = {};
  for (const [key, value] of Object.entries(patch || {})) {
    if (!(key in defaults)) continue;
    $set[`corporate.${key}`] = typeof defaults[key] === 'number' ? Math.max(0, Number(value) || 0) : String(value ?? '');
  }

  if (Object.keys($set).length) {
    await AdminBusinessSetting.collection.updateOne({ scope: 'default' }, { $set }, { upsert: true });
  }

  await invalidateCachedValue(CACHE_KEY).catch(() => null);
  const doc = await AdminBusinessSetting.collection.findOne({ scope: 'default' }, { projection: { corporate: 1 } });
  return { ...defaults, ...(doc?.corporate || {}) };
};
