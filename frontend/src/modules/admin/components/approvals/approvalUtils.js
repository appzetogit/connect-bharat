// Shared helpers for the admin approval screens (users, driver documents, vehicles).

// The shared axios instance rejects with `{ ...response.data, status }`, but a raw
// axios error keeps the body under `response.data`. Read both shapes.
export const getApiErrorMessage = (error, fallback = 'Something went wrong') =>
  error?.response?.data?.message || error?.message || fallback;

export const getApiErrorStatus = (error) => error?.response?.status ?? error?.status ?? null;

export const getApiErrorDetails = (error) => error?.response?.data?.details || error?.details || null;

/** "drivingLicenseFront" / "rc_book" -> "Driving License Front" / "Rc Book" */
export const humanizeDocumentKey = (key = '') =>
  String(key || '')
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());

export const formatReviewDate = (value) => {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
};

/** A driver attached to a fleet owner / company vehicle is approved through the FleetVehicle. */
export const isFleetAttachedDriver = (driver) =>
  Boolean(
    driver?.owner_id ||
      driver?.ownerId ||
      driver?.assignedFleetVehicleId ||
      driver?.assigned_fleet_vehicle_id ||
      driver?.fleet_vehicle_id,
  );
