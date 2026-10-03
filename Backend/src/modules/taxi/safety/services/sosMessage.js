/**
 * SOS SMS text. Pure so it is unit tested.
 *
 * The admin's template has to match the DLT template registered for it word
 * for word, so this only substitutes placeholders - it never rewords. SMS is
 * billed per 160-character segment and long texts split badly on cheap
 * handsets, so each substituted value is capped.
 */

export const DEFAULT_SOS_TEMPLATE =
  'SOS from {app}: {name} ({phone}) needs help. Location: {link} Trip: {trip} Vehicle: {vehicle}';

const cap = (value, max) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

/// Map link for the alert's position. A point, not a live feed: there is no
/// public tracking page yet, and the alert stores where SOS was pressed.
export const locationLinkFor = (alert = {}) => {
  const coordinates = alert?.location?.coordinates;
  if (Array.isArray(coordinates) && coordinates.length >= 2) {
    const [lng, lat] = coordinates.map(Number);
    if (Number.isFinite(lat) && Number.isFinite(lng)) {
      return `https://maps.google.com/?q=${lat.toFixed(6)},${lng.toFixed(6)}`;
    }
  }
  const lat = Number(alert?.location?.lat);
  const lng = Number(alert?.location?.lng);
  if (Number.isFinite(lat) && Number.isFinite(lng)) {
    return `https://maps.google.com/?q=${lat.toFixed(6)},${lng.toFixed(6)}`;
  }
  return cap(alert?.locationLabel, 60) || 'unavailable';
};

export const buildSosSmsText = ({ template, appName, name, phone, link, trip, vehicle } = {}) => {
  const values = {
    app: cap(appName, 30) || 'App',
    name: cap(name, 40) || 'Your contact',
    phone: cap(phone, 15) || '-',
    link: cap(link, 80) || 'unavailable',
    trip: cap(trip, 30) || '-',
    vehicle: cap(vehicle, 60) || '-',
  };

  const text = String(template || '').trim() || DEFAULT_SOS_TEMPLATE;
  return text.replace(/\{(app|name|phone|link|trip|vehicle)\}/g, (_match, key) => values[key]);
};
