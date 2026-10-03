import { env } from '../../../config/env.js';
import { ApiError } from '../../../utils/ApiError.js';
import { getOrLoadCachedValue } from '../../../utils/cache.js';
import { AdminThirdPartySetting } from '../admin/models/AdminThirdPartySetting.js';
import {
  normalizeAutocomplete,
  normalizeGeocodeResults,
  normalizePlaceDetails,
  roundCoordinate,
} from './mapsProxyNormalize.js';

/**
 * Geocoding and Places through the server's Google key.
 *
 * The apps could call Google directly, but then the key ships inside the APK
 * where anyone can extract it and run up the bill. Proxying keeps the key on
 * the server, lets us cache (the same "Home" address or airport gets looked up
 * thousands of times), and puts a per-account rate limit in front of it.
 *
 * Uses the same key as Directions (`GOOGLE_MAPS_API_KEY`, see routeService),
 * falling back to the admin panel's distance-matrix key. The legacy Geocoding
 * and Places web services are used because that key already has them; the
 * responses are normalised so the apps don't depend on Google's shape.
 */

const GOOGLE_BASE = 'https://maps.googleapis.com/maps/api';
const REQUEST_TIMEOUT_MS = 6000;

const TTL = {
  geocode: 24 * 60 * 60 * 1000,
  reverse: 24 * 60 * 60 * 1000,
  autocomplete: 10 * 60 * 1000,
  details: 24 * 60 * 60 * 1000,
  key: 5 * 60 * 1000,
};

const resolveApiKey = async () => {
  if (env.googleMapsApiKey) return env.googleMapsApiKey;

  return getOrLoadCachedValue('maps:proxy:key', {
    ttlMs: TTL.key,
    load: async () => {
      const doc = await AdminThirdPartySetting.findOne({ scope: 'default' }).select('map_apis').lean();
      return String(doc?.map_apis?.google_map_key_for_distance_matrix || '').trim();
    },
  }).catch(() => '');
};

/// Calls Google and returns the parsed body. Throws for anything that should
/// not be cached (network failure, quota, denied) so a transient error doesn't
/// stick for a day; ZERO_RESULTS is a real answer and comes back normally.
const callGoogle = async (path, params) => {
  const key = await resolveApiKey();
  if (!key) {
    throw new ApiError(503, 'Maps lookup is not configured on the server');
  }

  const query = new URLSearchParams({ ...params, key });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let body;
  try {
    const response = await fetch(`${GOOGLE_BASE}/${path}?${query.toString()}`, { signal: controller.signal });
    body = await response.json();
  } catch {
    throw new ApiError(502, 'Maps provider did not respond');
  } finally {
    clearTimeout(timer);
  }

  const status = String(body?.status || '');
  if (status === 'NOT_FOUND') {
    throw new ApiError(404, 'Place not found');
  }
  if (status !== 'OK' && status !== 'ZERO_RESULTS') {
    // Google's error_message can echo request details; log it, don't return it.
    console.error(`[maps] ${path} returned ${status}: ${body?.error_message || ''}`);
    throw new ApiError(502, status === 'OVER_QUERY_LIMIT' ? 'Maps lookups are temporarily unavailable' : 'Maps lookup failed');
  }
  return body;
};

const cleanText = (value, max = 200) => String(value ?? '').trim().slice(0, max);
const countryComponent = (country) => {
  const code = cleanText(country || 'in', 2).toLowerCase();
  return /^[a-z]{2}$/.test(code) ? `country:${code}` : 'country:in';
};

export const geocodeAddress = async ({ address, country }) => {
  const text = cleanText(address);
  if (text.length < 3) throw new ApiError(400, 'address must be at least 3 characters');
  const components = countryComponent(country);

  return getOrLoadCachedValue(`maps:geocode:${components}:${text.toLowerCase()}`, {
    ttlMs: TTL.geocode,
    load: async () => normalizeGeocodeResults(await callGoogle('geocode/json', { address: text, components })),
  });
};

export const reverseGeocode = async ({ lat, lng }) => {
  const latitude = Number(lat);
  const longitude = Number(lng);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) {
    throw new ApiError(400, 'lat and lng must be valid coordinates');
  }

  // ~11 m grid: a phone's GPS jitter shouldn't turn into a fresh billed call.
  const rLat = roundCoordinate(latitude, 4);
  const rLng = roundCoordinate(longitude, 4);

  return getOrLoadCachedValue(`maps:reverse:${rLat},${rLng}`, {
    ttlMs: TTL.reverse,
    load: async () => normalizeGeocodeResults(await callGoogle('geocode/json', { latlng: `${rLat},${rLng}` })),
  });
};

export const autocompletePlaces = async ({ input, lat, lng, sessiontoken, country, radius }) => {
  const text = cleanText(input, 120);
  if (text.length < 2) throw new ApiError(400, 'input must be at least 2 characters');

  const params = { input: text, components: countryComponent(country) };
  const latitude = Number(lat);
  const longitude = Number(lng);
  let bias = '';
  if (Number.isFinite(latitude) && Number.isFinite(longitude)) {
    // Biased to ~1 km cells so nearby riders share cache entries.
    bias = `${roundCoordinate(latitude, 2)},${roundCoordinate(longitude, 2)}`;
    params.location = bias;
    params.radius = String(Math.min(Math.max(Number(radius) || 50000, 1000), 100000));
  }
  const token = cleanText(sessiontoken, 100);
  if (token) params.sessiontoken = token;

  // The session token is a billing hint, not part of the answer, so it stays
  // out of the cache key.
  return getOrLoadCachedValue(`maps:auto:${params.components}:${bias}:${params.radius || ''}:${text.toLowerCase()}`, {
    ttlMs: TTL.autocomplete,
    load: async () => normalizeAutocomplete(await callGoogle('place/autocomplete/json', params)),
  });
};

export const getPlaceDetails = async ({ placeId, sessiontoken }) => {
  const id = cleanText(placeId, 300);
  if (!/^[A-Za-z0-9_-]{10,300}$/.test(id)) throw new ApiError(400, 'placeId is not valid');

  const params = { place_id: id, fields: 'place_id,name,formatted_address,geometry,address_component,type' };
  const token = cleanText(sessiontoken, 100);
  if (token) params.sessiontoken = token;

  const result = await getOrLoadCachedValue(`maps:place:${id}`, {
    ttlMs: TTL.details,
    load: async () => normalizePlaceDetails(await callGoogle('place/details/json', params)),
  });

  if (!result) throw new ApiError(404, 'Place not found');
  return result;
};
