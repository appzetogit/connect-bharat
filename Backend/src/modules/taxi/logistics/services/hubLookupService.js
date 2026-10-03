import mongoose from 'mongoose';
import { ApiError } from '../../../../utils/ApiError.js';
import { Hub } from '../models/Hub.js';
import { HubStaff } from '../models/HubStaff.js';
import { nextSequence } from '../models/LogisticsCounter.js';
import { buildAwb, buildQrPayload, formatAwbDate, normalizeCityCode } from './awb.js';

/// Nearest active hub that may serve [end] ('origin' for the sender,
/// 'destination' for the receiver) within [maxKm], via the 2dsphere index.
export const findNearestHub = async ({ coordinates, end = 'origin', maxKm = 50 }) => {
  const types = end === 'destination' ? ['destination', 'any'] : ['origin', 'any'];
  return Hub.findOne({
    status: 'active',
    type: { $in: types },
    location: {
      $near: {
        $geometry: { type: 'Point', coordinates: coordinates.map(Number) },
        $maxDistance: Math.max(1, Math.round(Number(maxKm) * 1000)),
      },
    },
  }).lean();
};

/// The next AWB for a booking that starts at [hub]. The sequence is per
/// city code per local day, so numbers stay short and a day's volume in a
/// city reads straight off the AWB.
export const generateAwb = async ({ hub, offsetMinutes = 330, trackingBaseUrl = '' }) => {
  const cityCode = normalizeCityCode(hub?.cityCode || hub?.code || 'HUB');
  const now = new Date();
  const sequence = await nextSequence(`awb:${cityCode}:${formatAwbDate(now, offsetMinutes)}`);
  const awb = buildAwb({ cityCode, date: now, sequence, offsetMinutes });
  return { awb, qrPayload: buildQrPayload(awb, trackingBaseUrl) };
};

export const generateManifestCode = async ({ hub, offsetMinutes = 330 }) => {
  const day = formatAwbDate(new Date(), offsetMinutes);
  const sequence = await nextSequence(`manifest:${hub.code}:${day}`);
  return `MF${hub.code}${day}${String(sequence).padStart(4, '0')}`;
};

/// The hubs a staff member may act for: their own, plus any hub that lists
/// them as a manager. The active one is picked with `?hubId=` (a query
/// parameter rather than a header, because the API's CORS policy only
/// allows Content-Type and Authorization).
export const resolveStaffHubs = async (staff) => {
  const hubs = await Hub.find({
    $or: [{ _id: staff.hubId }, { managerIds: staff._id }],
  }).lean();
  return hubs;
};

export const resolveActiveHub = async (staff, requestedHubId) => {
  const hubs = await resolveStaffHubs(staff);
  if (!hubs.length) throw new ApiError(403, 'Your hub no longer exists');
  const wanted = String(requestedHubId || '').trim();
  if (wanted) {
    if (!mongoose.Types.ObjectId.isValid(wanted)) throw new ApiError(400, 'hubId is invalid');
    const hub = hubs.find((item) => String(item._id) === wanted);
    if (!hub) throw new ApiError(403, 'You do not have access to that hub');
    return { hub, hubs };
  }
  const own = hubs.find((item) => String(item._id) === String(staff.hubId)) || hubs[0];
  return { hub: own, hubs };
};

export const loadActiveStaff = async (staffId) => {
  const staff = await HubStaff.findById(staffId);
  if (!staff || staff.active === false) throw new ApiError(403, 'Hub staff account is inactive');
  return staff;
};
