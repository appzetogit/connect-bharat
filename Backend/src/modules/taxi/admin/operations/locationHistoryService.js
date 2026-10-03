import mongoose from 'mongoose';
import simplify from 'simplify-js';
import { ApiError } from '../../../../utils/ApiError.js';
import { Driver } from '../../driver/models/Driver.js';
import { DriverLocationHistory } from '../../driver/models/DriverLocationHistory.js';
import { assertObjectId, assertServiceLocationScope } from './operationsAccess.js';

/// Trail / replay of where a driver went, read from DriverLocationHistory
/// (written on the socket location throttle, kept 30 days by TTL).
///
/// A shift is thousands of fixes; the map needs the shape, not every point.
/// Douglas-Peucker (simplify-js) keeps the corners and drops the straight runs,
/// and the original fix objects come back so each kept point still carries its
/// own timestamp for the replay slider.

const DEFAULT_WINDOW_MS = 2 * 60 * 60 * 1000;
const MAX_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_RAW_POINTS = 20_000;
const DEFAULT_TOLERANCE_METERS = 5;
/// Rough metres per degree of latitude. simplify-js works in the units it is
/// given, so the tolerance is converted to degrees; at Indian latitudes the
/// longitude stretch is under 15%, which is fine for a display tolerance.
const METERS_PER_DEGREE = 111_320;

const parseDate = (value, label) => {
  if (value === undefined || value === null || value === '') return null;
  const numeric = Number(value);
  const date = Number.isFinite(numeric) && String(value).trim() !== '' && /^\d+$/.test(String(value).trim())
    ? new Date(numeric)
    : new Date(String(value));
  if (Number.isNaN(date.getTime())) {
    throw new ApiError(400, `${label} is not a valid date`);
  }
  return date;
};

/// The window to read. Defaults to the last two hours, refuses an inverted
/// range, and caps the span at seven days. Pure, so it is unit-tested.
export const resolveHistoryWindow = ({ from, to } = {}, now = new Date()) => {
  const end = parseDate(to, 'to') || now;
  const start = parseDate(from, 'from') || new Date(end.getTime() - DEFAULT_WINDOW_MS);
  if (start > end) throw new ApiError(400, 'from must be before to');
  if (end.getTime() - start.getTime() > MAX_WINDOW_MS) {
    throw new ApiError(400, 'The range can be at most 7 days');
  }
  return { start, end };
};

const toRadians = (value) => (Number(value) * Math.PI) / 180;

export const haversineMeters = ([lng1, lat1], [lng2, lat2]) => {
  const dLat = toRadians(lat2 - lat1);
  const dLng = toRadians(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6_371_000 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

/// Simplify a time-ordered list of fixes. Each input is
/// { lng, lat, at, heading?, speed?, rideId? }; output keeps that shape.
export const simplifyTrail = (fixes = [], toleranceMeters = DEFAULT_TOLERANCE_METERS) => {
  const valid = fixes.filter((fix) => Number.isFinite(fix?.lng) && Number.isFinite(fix?.lat));
  if (valid.length <= 2) return valid;
  const points = valid.map((fix) => ({ x: fix.lng, y: fix.lat, fix }));
  const tolerance = Math.max(0, Number(toleranceMeters) || 0) / METERS_PER_DEGREE;
  return simplify(points, tolerance, true).map((point) => point.fix);
};

export const totalDistanceMeters = (fixes = []) => {
  let total = 0;
  for (let index = 1; index < fixes.length; index += 1) {
    total += haversineMeters([fixes[index - 1].lng, fixes[index - 1].lat], [fixes[index].lng, fixes[index].lat]);
  }
  return Math.round(total);
};

export const getDriverLocationHistory = async ({ driverId, query = {}, admin = null }) => {
  assertObjectId(driverId, 'driverId');
  const driver = await Driver.findById(driverId).select('name service_location_id').lean();
  if (!driver) throw new ApiError(404, 'Driver not found');
  assertServiceLocationScope(admin, driver.service_location_id);

  const { start, end } = resolveHistoryWindow(query);
  const filter = {
    driverId: new mongoose.Types.ObjectId(String(driverId)),
    createdAt: { $gte: start, $lte: end },
  };
  const rideId = String(query.ride_id || query.rideId || '').trim();
  if (rideId) {
    assertObjectId(rideId, 'ride_id');
    filter.rideId = new mongoose.Types.ObjectId(rideId);
  }

  const rows = await DriverLocationHistory.find(filter)
    .sort({ createdAt: 1 })
    .limit(MAX_RAW_POINTS + 1)
    .select('location heading speed createdAt rideId')
    .lean();

  const truncated = rows.length > MAX_RAW_POINTS;
  const fixes = rows.slice(0, MAX_RAW_POINTS).map((row) => ({
    lng: Number(row.location?.coordinates?.[0]),
    lat: Number(row.location?.coordinates?.[1]),
    at: row.createdAt,
    heading: row.heading ?? null,
    speed: row.speed ?? null,
    rideId: row.rideId ? String(row.rideId) : null,
  }));

  const toleranceMeters = Number.isFinite(Number(query.tolerance_m))
    ? Math.min(200, Math.max(0, Number(query.tolerance_m)))
    : DEFAULT_TOLERANCE_METERS;
  const points = simplifyTrail(fixes, toleranceMeters);

  return {
    driverId: String(driver._id),
    driverName: driver.name || '',
    from: start,
    to: end,
    rideId: rideId || null,
    rawCount: fixes.length,
    count: points.length,
    truncated,
    toleranceMeters,
    distanceMeters: totalDistanceMeters(fixes),
    startedAt: fixes[0]?.at || null,
    endedAt: fixes[fixes.length - 1]?.at || null,
    points,
  };
};
