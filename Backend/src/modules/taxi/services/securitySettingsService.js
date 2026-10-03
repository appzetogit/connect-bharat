import { createDefaultBusinessSettings } from '../admin/data/defaultBusinessSettings.js';
import { AdminBusinessSetting } from '../admin/models/AdminBusinessSetting.js';
import { getOrLoadCachedValue } from '../../../utils/cache.js';

const SETTINGS_CACHE_TTL_MS = 30_000;
const CUSTOMIZATION_CACHE_KEY = 'cache:settings:customization';

/// Defaults for the security switches this module reads.
///
/// They also live in `defaultBusinessSettings.customization` so the admin
/// panel shows them, but they are repeated here on purpose: a database whose
/// customization document predates these keys, or a merge that drops them from
/// the defaults file, must still resolve to the safe value (today's behaviour)
/// instead of `undefined`.
export const SECURITY_SETTING_DEFAULTS = Object.freeze({
  // Start-of-trip OTP for taxi and outstation rides.
  enable_ride_start_otp_verification: '0',
  // Master switch for parcel OTPs. `enable_delivery_otp_load` /
  // `enable_delivery_otp_unload` have shipped as '1' but were never read, so
  // honouring them directly would suddenly gate every live parcel.
  enforce_delivery_otp: '0',
  // Newly created drivers start unapproved (pending) when '1'.
  require_driver_approval: '0',
  // When '0', `<resource>.view` also grants `<resource>.manage`.
  strict_admin_permissions: '0',
  // Route-level admin permission checks; '0' turns them off entirely.
  enforce_admin_permissions: '1',
  // Kill switch for the upload auth gate, in case a mobile build in the field
  // still uploads with no credentials at all. Secure by default.
  require_upload_auth: '1',
});

const isOn = (value) => ['1', 'true', 'yes', 'on'].includes(String(value ?? '').trim().toLowerCase());

export const getCustomizationSettings = async () =>
  getOrLoadCachedValue(CUSTOMIZATION_CACHE_KEY, {
    ttlMs: SETTINGS_CACHE_TTL_MS,
    load: async () => {
      const businessSettings = await AdminBusinessSetting.findOne({ scope: 'default' })
        .select('customization')
        .lean();

      return {
        ...(createDefaultBusinessSettings().customization || {}),
        ...SECURITY_SETTING_DEFAULTS,
        ...(businessSettings?.customization || {}),
      };
    },
  });

/// Reads one customization flag as a boolean. Falls back to the security
/// default (and then to off) if the settings document can't be read, so a
/// Mongo hiccup never flips a gate into a state nobody configured.
export const isCustomizationFlagOn = async (key) => {
  try {
    const settings = await getCustomizationSettings();
    return isOn(settings?.[key] ?? SECURITY_SETTING_DEFAULTS[key]);
  } catch {
    return isOn(SECURITY_SETTING_DEFAULTS[key]);
  }
};

export const isSettingValueOn = isOn;
