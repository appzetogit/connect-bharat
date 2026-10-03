import { getExotelSettings } from '../admin/services/thirdPartySettingsService.js';

/**
 * Call masking: bridges rider and driver through a virtual number so neither
 * learns the other's phone.
 *
 * A provider is an object with `name` and `connect({ from, to, callerId })`.
 * Two exist:
 *
 *   exotel - Exotel's Connect API: Exotel rings `from` first, and once that
 *            leg answers, dials `to` and joins them. Both see the ExoPhone.
 *   none   - no bridging. The caller falls back to the old behaviour of
 *            handing out the other party's number, which the apps already
 *            display today, so turning masking off can never strand a call.
 *
 * The provider is chosen from the `exotel` third-party settings section, read
 * on every call so an admin can switch it on or off without a deploy.
 */

const REQUEST_TIMEOUT_MS = 10_000;

const isEnabled = (value) => ['1', 'true', 'yes', 'on'].includes(String(value ?? '').trim().toLowerCase());

/// E.164 for Indian numbers, which is what Exotel documents. Anything that
/// already carries a country code is passed through.
export const toE164 = (phone, countryCode = '+91') => {
  const raw = String(phone || '').trim();
  if (raw.startsWith('+')) return `+${raw.replace(/\D/g, '')}`;
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 10) {
    const code = String(countryCode || '+91').replace(/\D/g, '') || '91';
    return `+${code}${digits}`;
  }
  if (digits.length === 12 && digits.startsWith('91')) return `+${digits}`;
  if (digits.length === 11 && digits.startsWith('0')) return `+91${digits.slice(1)}`;
  return digits ? `+${digits}` : '';
};

export const isExotelConfigured = (settings = {}) =>
  isEnabled(settings.enabled)
  && Boolean(String(settings.sid || '').trim())
  && Boolean(String(settings.api_key || '').trim())
  && Boolean(String(settings.api_token || '').trim())
  && Boolean(String(settings.caller_id || '').trim());

/**
 * The HTTP request for an Exotel Connect call, built separately from sending
 * it so it can be tested. Credentials go in a Basic auth header: fetch refuses
 * a URL with embedded credentials, which is how Exotel's docs show it.
 */
export const buildExotelConnectRequest = ({ settings, from, to, customField = '' }) => {
  const subdomain = String(settings.subdomain || 'api.exotel.com').trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  const sid = String(settings.sid).trim();
  const url = `https://${subdomain}/v1/Accounts/${encodeURIComponent(sid)}/Calls/connect.json`;
  const body = new URLSearchParams({
    From: from,
    To: to,
    CallerId: String(settings.caller_id).trim(),
    CallType: 'trans',
  });
  const timeLimit = Number(settings.time_limit);
  if (Number.isFinite(timeLimit) && timeLimit > 0) body.set('TimeLimit', String(Math.round(timeLimit)));
  if (customField) body.set('CustomField', String(customField).slice(0, 200));

  const auth = Buffer.from(`${String(settings.api_key).trim()}:${String(settings.api_token).trim()}`).toString('base64');

  return {
    url,
    init: {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: body.toString(),
    },
  };
};

const createExotelProvider = (settings) => ({
  name: 'exotel',
  async connect({ from, to, customField }) {
    const { url, init } = buildExotelConnectRequest({ settings, from, to, customField });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(url, { ...init, signal: controller.signal });
      const text = await response.text();
      let parsed = null;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }

      if (!response.ok) {
        const message = parsed?.RestException?.Message || text || response.statusText;
        return { ok: false, status: 'failed', error: String(message).slice(0, 300) };
      }

      return {
        ok: true,
        status: String(parsed?.Call?.Status || 'queued').toLowerCase(),
        callSid: String(parsed?.Call?.Sid || ''),
      };
    } catch (error) {
      return {
        ok: false,
        status: 'failed',
        error: error?.name === 'AbortError' ? 'Exotel did not respond in time' : String(error?.message || error),
      };
    } finally {
      clearTimeout(timer);
    }
  },
});

const noneProvider = {
  name: 'none',
  async connect() {
    return { ok: true, status: 'direct', callSid: '' };
  },
};

/// The provider in force right now. Never throws: a settings read failure
/// means no masking, not no call.
export const resolveCallMaskingProvider = async () => {
  try {
    const settings = await getExotelSettings();
    return isExotelConfigured(settings) ? createExotelProvider(settings) : noneProvider;
  } catch (error) {
    console.error('[callMasking] could not read settings, falling back to direct calls:', error?.message || error);
    return noneProvider;
  }
};
