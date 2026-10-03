import { AdminThirdPartySetting } from '../models/AdminThirdPartySetting.js';
import { createDefaultThirdPartySettings } from '../data/defaultThirdPartySettings.js';

export const ensureThirdPartySettingsDocument = async () => {
  let settings = await AdminThirdPartySetting.findOne({ scope: 'default' });
  if (!settings) {
    settings = await AdminThirdPartySetting.create(createDefaultThirdPartySettings());
  }
  return settings;
};

const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/// Exotel section, saved values over shipped defaults. A settings document
/// created before the section existed has none, and must read as "off".
export const getExotelSettings = async () => {
  const defaults = createDefaultThirdPartySettings().exotel;
  const doc = await AdminThirdPartySetting.findOne({ scope: 'default' }).select('exotel').lean();
  return { ...defaults, ...(isPlainObject(doc?.exotel) ? doc.exotel : {}) };
};

/// SOS SMS section (lives under `sms` so the existing SMS settings PATCH can
/// edit it too).
export const getSosSmsSettings = async () => {
  const defaults = createDefaultThirdPartySettings().sms.sos_alert;
  const doc = await AdminThirdPartySetting.findOne({ scope: 'default' }).select('sms').lean();
  const saved = isPlainObject(doc?.sms?.sos_alert) ? doc.sms.sos_alert : {};
  return { ...defaults, ...saved };
};

const maskSecret = (value) => {
  const text = String(value || '');
  if (!text) return '';
  return text.length <= 4 ? '****' : `${'*'.repeat(text.length - 4)}${text.slice(-4)}`;
};

/// What the admin panel shows. The token is masked: the panel only needs to
/// know one is set, and settings responses end up in browser devtools.
export const serializeExotelSettingsForAdmin = (settings = {}) => ({
  ...settings,
  api_token: maskSecret(settings.api_token),
  api_token_set: Boolean(settings.api_token),
});

const EXOTEL_FIELDS = ['enabled', 'sid', 'api_key', 'api_token', 'caller_id', 'subdomain', 'time_limit'];

export const updateExotelSettings = async (payload = {}) => {
  const document = await ensureThirdPartySettingsDocument();
  const current = { ...createDefaultThirdPartySettings().exotel, ...(isPlainObject(document.exotel) ? document.exotel : {}) };
  const next = { ...current };

  for (const field of EXOTEL_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(payload || {}, field)) continue;
    const value = payload[field];

    if (field === 'enabled') {
      next.enabled = ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase()) ? '1' : '0';
    } else if (field === 'time_limit') {
      const seconds = Number(value);
      next.time_limit = Number.isFinite(seconds) && seconds > 0 ? Math.min(Math.round(seconds), 14400) : 0;
    } else if (field === 'api_token') {
      // The panel echoes the masked value back on save; never store the mask.
      const token = String(value ?? '').trim();
      if (!/^\*+.{0,4}$/.test(token)) next.api_token = token;
    } else if (field === 'subdomain') {
      next.subdomain = String(value ?? '').trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '') || 'api.exotel.com';
    } else {
      next[field] = String(value ?? '').trim();
    }
  }

  document.exotel = next;
  document.markModified('exotel');
  await document.save();
  return next;
};
