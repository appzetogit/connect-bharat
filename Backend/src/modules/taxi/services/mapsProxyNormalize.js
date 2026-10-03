/**
 * Turns Google Geocoding / Places responses into the small, stable shape the
 * apps consume. Pure so it is unit tested without network.
 */

export const roundCoordinate = (value, digits = 4) => Number(Number(value).toFixed(digits));

/// `{ city, state, country, zipCode, locality, sublocality, route }` from
/// Google's address_components.
export const pickAddressParts = (components = []) => {
  const find = (...types) => {
    const match = (Array.isArray(components) ? components : []).find((component) =>
      types.some((type) => (component?.types || []).includes(type)));
    return match ? String(match.long_name || '') : '';
  };

  return {
    route: find('route'),
    sublocality: find('sublocality_level_1', 'sublocality', 'neighborhood'),
    locality: find('locality'),
    city: find('locality', 'administrative_area_level_3', 'administrative_area_level_2'),
    district: find('administrative_area_level_2'),
    state: find('administrative_area_level_1'),
    country: find('country'),
    zipCode: find('postal_code'),
  };
};

const toLatLng = (geometry) => {
  const lat = Number(geometry?.location?.lat);
  const lng = Number(geometry?.location?.lng);
  return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : { lat: null, lng: null };
};

export const normalizeGeocodeResults = (body = {}) => ({
  results: (Array.isArray(body?.results) ? body.results : []).slice(0, 5).map((result) => ({
    placeId: String(result.place_id || ''),
    formattedAddress: String(result.formatted_address || ''),
    ...toLatLng(result.geometry),
    types: Array.isArray(result.types) ? result.types : [],
    ...pickAddressParts(result.address_components),
  })),
});

export const normalizeAutocomplete = (body = {}) => ({
  predictions: (Array.isArray(body?.predictions) ? body.predictions : []).slice(0, 10).map((prediction) => ({
    placeId: String(prediction.place_id || ''),
    description: String(prediction.description || ''),
    mainText: String(prediction.structured_formatting?.main_text || prediction.description || ''),
    secondaryText: String(prediction.structured_formatting?.secondary_text || ''),
    distanceMeters: Number.isFinite(Number(prediction.distance_meters)) ? Number(prediction.distance_meters) : null,
    types: Array.isArray(prediction.types) ? prediction.types : [],
  })),
});

export const normalizePlaceDetails = (body = {}) => {
  const result = body?.result;
  if (!result) return null;
  return {
    placeId: String(result.place_id || ''),
    name: String(result.name || ''),
    formattedAddress: String(result.formatted_address || ''),
    ...toLatLng(result.geometry),
    types: Array.isArray(result.types) ? result.types : [],
    ...pickAddressParts(result.address_components),
  };
};
