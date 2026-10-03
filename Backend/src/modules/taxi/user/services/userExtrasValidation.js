import { ApiError } from '../../../../utils/ApiError.js';

/**
 * Input validation for the rider's saved addresses, profile extras and SOS
 * contacts. Pure (no models) so it is unit tested without Mongo; the
 * controllers in `userExtrasController.js` do the reads and writes.
 */

export const MAX_SAVED_ADDRESSES = 20;
export const MAX_USER_EMERGENCY_CONTACTS = 5;

const ADDRESS_LABELS = new Map([
  ['home', 'Home'],
  ['office', 'Office'],
  ['work', 'Office'],
  ['other', 'Other'],
]);
export const USER_GENDERS = new Set(['male', 'female', 'other', 'prefer-not-to-say', '']);

const has = (body, key) => Object.prototype.hasOwnProperty.call(body || {}, key);
const clean = (value, max = 300) => String(value ?? '').trim().slice(0, max);

const readCoordinates = (body = {}) => {
  const fromArray = Array.isArray(body.location?.coordinates)
    ? body.location.coordinates
    : Array.isArray(body.coordinates)
      ? body.coordinates
      : null;

  const lng = Number(fromArray ? fromArray[0] : body.lng ?? body.longitude);
  const lat = Number(fromArray ? fromArray[1] : body.lat ?? body.latitude);

  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return null;
  }
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    throw new ApiError(400, 'lat must be within -90..90 and lng within -180..180');
  }
  return [lng, lat];
};

/**
 * Normalises an address body for create (`partial: false`) or update
 * (`partial: true`, only the fields sent are returned).
 *
 * Coordinates are required on create. The schema has a 2dsphere index on
 * `addresses.location`, and a GeoJSON Point without coordinates cannot be
 * indexed, so saving one would fail the whole user document. Requiring them
 * is also what makes a saved address usable as a pickup in one tap.
 */
export const normalizeAddressInput = (body = {}, { partial = false } = {}) => {
  const out = {};

  if (!partial || has(body, 'label')) {
    const rawLabel = clean(body.label || 'Home', 20).toLowerCase();
    const label = ADDRESS_LABELS.get(rawLabel);
    if (!label) {
      throw new ApiError(400, 'label must be Home, Office or Other');
    }
    out.label = label;
  }

  for (const field of ['street', 'city', 'state']) {
    if (!partial || has(body, field)) {
      const value = clean(body[field]);
      if (!value) {
        throw new ApiError(400, `${field} is required`);
      }
      out[field] = value;
    }
  }

  if (!partial || has(body, 'additionalDetails')) out.additionalDetails = clean(body.additionalDetails);
  if (!partial || has(body, 'zipCode')) {
    const zip = clean(body.zipCode, 12);
    if (zip && !/^[A-Za-z0-9 -]{3,12}$/.test(zip)) {
      throw new ApiError(400, 'zipCode is not valid');
    }
    out.zipCode = zip;
  }
  if (!partial || has(body, 'phone')) {
    const phone = String(body.phone ?? '').replace(/\D/g, '').slice(-10);
    if (phone && !/^\d{10}$/.test(phone)) {
      throw new ApiError(400, 'phone must be a 10-digit number');
    }
    out.phone = phone;
  }

  const touchesLocation = ['lat', 'lng', 'latitude', 'longitude', 'location', 'coordinates'].some((key) => has(body, key));
  if (!partial || touchesLocation) {
    const coordinates = readCoordinates(body);
    if (!coordinates) {
      throw new ApiError(400, 'lat and lng are required');
    }
    out.location = { type: 'Point', coordinates };
  }

  if (has(body, 'isDefault')) {
    out.isDefault = body.isDefault === true || String(body.isDefault).toLowerCase() === 'true';
  }

  return out;
};

export const serializeAddress = (address = {}) => {
  const coordinates = Array.isArray(address?.location?.coordinates) ? address.location.coordinates : [];
  return {
    id: String(address._id || address.id || ''),
    label: address.label || 'Home',
    street: address.street || '',
    additionalDetails: address.additionalDetails || '',
    city: address.city || '',
    state: address.state || '',
    zipCode: address.zipCode || '',
    phone: address.phone || '',
    lat: coordinates.length === 2 ? coordinates[1] : null,
    lng: coordinates.length === 2 ? coordinates[0] : null,
    location: coordinates.length === 2 ? { type: 'Point', coordinates } : null,
    isDefault: Boolean(address.isDefault),
    createdAt: address.createdAt || null,
    updatedAt: address.updatedAt || null,
  };
};

/// Exactly one default once there is at least one address: `preferredId` wins
/// if given, else the first already-flagged one, else the first address.
export const enforceSingleDefault = (addresses = [], preferredId = null) => {
  if (!addresses.length) return addresses;

  const preferred = preferredId
    ? addresses.find((address) => String(address._id) === String(preferredId))
    : null;
  const winner = preferred || addresses.find((address) => address.isDefault) || addresses[0];

  for (const address of addresses) {
    address.isDefault = String(address._id) === String(winner._id);
  }
  return addresses;
};

const parseOptionalDate = (value, field, { now = new Date() } = {}) => {
  if (value === null || value === '') {
    return null;
  }

  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) {
    throw new ApiError(400, `${field} must be a valid date (YYYY-MM-DD)`);
  }
  if (date.getTime() > now.getTime()) {
    throw new ApiError(400, `${field} cannot be in the future`);
  }
  if (date.getUTCFullYear() < 1900) {
    throw new ApiError(400, `${field} is not a plausible date`);
  }
  return date;
};

/**
 * Fields accepted by `PATCH /users/me/profile`. Only keys present in the body
 * are returned, so a partial update never blanks the others. Sending `null`
 * or `""` for a date clears it.
 */
export const normalizeProfileInput = (body = {}, { now = new Date() } = {}) => {
  const out = {};

  if (has(body, 'name')) {
    const name = clean(body.name, 200);
    if (name.length < 2 || name.length > 80) {
      throw new ApiError(400, 'name must be between 2 and 80 characters');
    }
    out.name = name;
  }

  if (has(body, 'email')) {
    const email = clean(body.email, 200).toLowerCase();
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new ApiError(400, 'A valid email address is required');
    }
    out.email = email;
  }

  if (has(body, 'gender')) {
    const gender = clean(body.gender, 30).toLowerCase().replace(/[_\s]+/g, '-');
    if (!USER_GENDERS.has(gender)) {
      throw new ApiError(400, 'gender must be male, female, other or prefer-not-to-say');
    }
    out.gender = gender;
  }

  if (has(body, 'dateOfBirth')) {
    const dob = parseOptionalDate(body.dateOfBirth, 'dateOfBirth', { now });
    if (dob) {
      const ageMs = now.getTime() - dob.getTime();
      if (ageMs < 13 * 365.25 * 24 * 60 * 60 * 1000) {
        throw new ApiError(400, 'You must be at least 13 years old');
      }
    }
    out.dateOfBirth = dob;
  }

  if (has(body, 'anniversary')) {
    out.anniversary = parseOptionalDate(body.anniversary, 'anniversary', { now });
  }

  if (has(body, 'profileImage')) {
    out.profileImage = clean(body.profileImage, 2000);
  }

  return out;
};

export const sanitizeContactPhone = (value) => String(value || '').replace(/\D/g, '').slice(-10);

export const normalizeEmergencyContactInput = (body = {}, existing = []) => {
  const name = clean(body.name, 200);
  const phone = sanitizeContactPhone(body.phone);
  const relation = clean(body.relation, 40);
  const source = String(body.source || 'manual').toLowerCase() === 'device' ? 'device' : 'manual';

  if (!name) {
    throw new ApiError(400, 'Contact name is required');
  }
  if (name.length > 80) {
    throw new ApiError(400, 'Contact name must be at most 80 characters');
  }
  if (!/^\d{10}$/.test(phone)) {
    throw new ApiError(400, 'A valid 10-digit contact number is required');
  }
  if (existing.length >= MAX_USER_EMERGENCY_CONTACTS) {
    throw new ApiError(400, `You can add up to ${MAX_USER_EMERGENCY_CONTACTS} emergency contacts`);
  }
  if (existing.some((contact) => sanitizeContactPhone(contact.phone) === phone)) {
    throw new ApiError(409, 'This contact number is already added');
  }

  return { name, phone, relation, source };
};

export const serializeEmergencyContact = (contact = {}) => ({
  id: String(contact._id || contact.id || ''),
  name: String(contact.name || '').trim(),
  phone: sanitizeContactPhone(contact.phone),
  relation: String(contact.relation || '').trim(),
  source: contact.source === 'device' ? 'device' : 'manual',
});

/// Validates a 1-5 integer rating and an optional comment.
export const normalizeRatingInput = (body = {}) => {
  const rating = Number(body.rating);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    throw new ApiError(400, 'rating must be an integer between 1 and 5');
  }
  return { rating, comment: clean(body.comment, 500) };
};

/// Next running average after adding one rating. Not rounded: rounding on
/// every write compounds, so the stored value stays exact and only the
/// response is rounded (`roundRating`). The database write does the same sum
/// atomically; this mirror exists for tests and for the response.
export const nextRunningAverage = (currentAverage, currentCount, rating) => {
  const count = Math.max(0, Number(currentCount) || 0);
  const average = count > 0 ? Number(currentAverage) || 0 : 0;
  const nextCount = count + 1;
  return {
    rating: ((average * count) + Number(rating)) / nextCount,
    ratingCount: nextCount,
  };
};

export const roundRating = (value) => Number((Number(value) || 0).toFixed(1));
