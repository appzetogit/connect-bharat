import { getOrLoadCachedValue, invalidateCachedValue } from '../../../../utils/cache.js';
import { AdminBusinessSetting } from '../../admin/models/AdminBusinessSetting.js';
import {
  createDefaultDeliverySettings,
  createDefaultLogisticsSettings,
} from '../data/defaultLogisticsSettings.js';

/// Reads and writes the `delivery` and `logistics` settings sections, each
/// merged over the module's defaults, with the same 30s cache the transport
/// settings use. Writes go through the raw collection with `$set` on the one
/// section, so saving logistics settings can never clobber another section
/// another admin screen is editing.
const SETTINGS_CACHE_TTL_MS = 30_000;
const DEFAULTS = {
  delivery: createDefaultDeliverySettings,
  logistics: createDefaultLogisticsSettings,
};

const cacheKey = (section) => `cache:settings:${section}`;

const loadSection = (section) =>
  getOrLoadCachedValue(cacheKey(section), {
    ttlMs: SETTINGS_CACHE_TTL_MS,
    load: async () => {
      const stored = await AdminBusinessSetting.collection
        .findOne({ scope: 'default' }, { projection: { [section]: 1 } })
        .catch(() => null);
      return { ...DEFAULTS[section](), ...(stored?.[section] || {}) };
    },
  });

export const getLogisticsSettings = () => loadSection('logistics');
export const getDeliverySurchargeSettings = () => loadSection('delivery');

const ALLOWED_KEYS = {
  delivery: Object.keys(createDefaultDeliverySettings()),
  logistics: Object.keys(createDefaultLogisticsSettings()),
};

export const updateSettingsSection = async (section, patch = {}) => {
  if (!DEFAULTS[section]) {
    throw new Error(`Unknown settings section ${section}`);
  }
  const updates = {};
  for (const key of ALLOWED_KEYS[section]) {
    if (patch[key] === undefined) continue;
    updates[`${section}.${key}`] = Array.isArray(patch[key]) ? patch[key].map(String) : String(patch[key]);
  }
  if (Object.keys(updates).length) {
    await AdminBusinessSetting.collection.updateOne({ scope: 'default' }, { $set: updates }, { upsert: true });
  }
  await invalidateCachedValue(cacheKey(section)).catch(() => null);
  return loadSection(section);
};

/// Settings values are stored as strings; these read them as the type the
/// code needs, falling back when a value is blank or junk.
export const settingNumber = (settings, key, fallback) => {
  const value = Number(settings?.[key]);
  return Number.isFinite(value) ? value : fallback;
};

export const settingFlag = (settings, key) =>
  ['1', 'true', 'yes', 'on'].includes(String(settings?.[key] ?? '').trim().toLowerCase());
