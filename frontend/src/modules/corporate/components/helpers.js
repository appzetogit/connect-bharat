import { HAS_VALID_GOOGLE_MAPS_KEY } from '../../admin/utils/googleMaps';

/**
 * Plain helpers for the corporate v2 pieces (roles, allowance, travel zone,
 * travel desk), kept out of the .jsx files so those export components only.
 * Shared with the admin corporate pages.
 */

/** Kilometres with one decimal, e.g. "12.5 km". */
export const formatKm = (value) =>
  `${Number(value || 0).toLocaleString('en-IN', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} km`;

/** How an employee may pay the share of a trip beyond their km allowance. */
export const PAYMENT_METHOD_OPTIONS = [
  { value: 'cash', label: 'Cash to driver' },
  { value: 'online', label: 'Online (UPI / card)' },
  { value: 'wallet', label: 'Rider wallet' },
];

export const allowanceLabel = (allowance) =>
  allowance?.enabled ? `${formatKm(allowance.km)} / ${allowance.period === 'weekly' ? 'week' : 'month'}` : 'No km limit';

// --- maps ------------------------------------------------------------------

export const MAPS_AVAILABLE = HAS_VALID_GOOGLE_MAPS_KEY;

const toNumber = (value) => {
  const number = Number(value);
  return value === '' || value === null || value === undefined || !Number.isFinite(number) ? null : number;
};

/** True when { lat, lng } holds two usable numbers. */
export const hasPoint = (point) => toNumber(point?.lat) !== null && toNumber(point?.lng) !== null;

// --- travel zone -----------------------------------------------------------

export const travelZoneToForm = (zone = {}) => ({
  mode: zone?.mode || 'free_roaming',
  rule: zone?.rule || 'both_ends',
  offices: (zone?.offices || []).map((office) => ({
    _id: office._id,
    name: office.name || '',
    address: office.address || '',
    lat: office.location?.coordinates?.[1] ?? office.lat ?? '',
    lng: office.location?.coordinates?.[0] ?? office.lng ?? '',
    radiusKm: office.radiusKm ?? 5,
  })),
});

export const travelZoneToBody = (form) => ({
  mode: form.mode,
  rule: form.rule,
  offices: form.offices.map((office) => ({
    ...(office._id ? { _id: office._id } : {}),
    name: office.name.trim(),
    address: (office.address || '').trim(),
    location: { type: 'Point', coordinates: [Number(office.lng), Number(office.lat)] },
    radiusKm: Number(office.radiusKm),
  })),
});

/** Returns an error message, or '' when the form can be saved. */
export const validateTravelZone = (form) => {
  if (form.mode !== 'office_boundary') return '';
  if (!form.offices.length) return 'Add at least one office for an office boundary.';
  const bad = form.offices.findIndex((office) => !office.name.trim() || !hasPoint(office) || !(Number(office.radiusKm) > 0));
  return bad >= 0 ? `Office ${bad + 1} needs a name, a location and a radius above 0 km.` : '';
};
