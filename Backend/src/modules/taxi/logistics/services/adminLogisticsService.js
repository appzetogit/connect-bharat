import mongoose from 'mongoose';
import { ApiError } from '../../../../utils/ApiError.js';
import { normalizePoint } from '../../../../utils/geo.js';
import { hashPassword } from '../../services/passwordService.js';
import { Hub } from '../models/Hub.js';
import { HubStaff } from '../models/HubStaff.js';
import { ParcelRateCard } from '../models/ParcelRateCard.js';
import { Shipment } from '../models/Shipment.js';
import { ShipmentLeg } from '../models/ShipmentLeg.js';
import { serializeHubStaff } from './hubAuthService.js';
import { serializeShipment } from './shipmentLifecycle.js';
import { getShipmentTimeline } from './shipmentService.js';
import { DEFAULT_WEIGHT_SLABS } from './shipmentPricing.js';
import { SHIPMENT_STATUSES } from './shipmentStateMachine.js';

/// Admin control of the parcel network: hubs, their staff, rate cards and a
/// search over every shipment.

const assertId = (value, label = 'id') => {
  if (!mongoose.Types.ObjectId.isValid(String(value || ''))) throw new ApiError(400, `${label} is invalid`);
  return String(value);
};

const optionalId = (value) => (value && mongoose.Types.ObjectId.isValid(String(value)) ? value : null);

const pickHubFields = (body = {}, { partial = false } = {}) => {
  const out = {};
  if (!partial || body.code !== undefined) {
    const code = String(body.code || '').trim().toUpperCase();
    if (!/^[A-Z0-9]{3,10}$/.test(code)) throw new ApiError(400, 'code must be 3-10 letters/digits');
    out.code = code;
  }
  if (!partial || body.name !== undefined) {
    if (!String(body.name || '').trim()) throw new ApiError(400, 'name is required');
    out.name = String(body.name).trim();
  }
  if (body.type !== undefined) {
    if (!['origin', 'transit', 'destination', 'any'].includes(body.type)) throw new ApiError(400, 'type must be origin, transit, destination or any');
    out.type = body.type;
  }
  if (!partial || body.location !== undefined || body.coordinates !== undefined) {
    out.location = { type: 'Point', coordinates: normalizePoint(body.location?.coordinates || body.location || body.coordinates, 'location') };
  }
  for (const key of ['address', 'contactPhone', 'cityCode']) if (body[key] !== undefined) out[key] = String(body[key] || '').trim();
  if (body.serviceLocationId !== undefined) out.serviceLocationId = optionalId(body.serviceLocationId);
  if (body.zoneId !== undefined) out.zoneId = optionalId(body.zoneId);
  if (body.capacity !== undefined) out.capacity = Math.max(0, Number(body.capacity) || 0);
  if (body.status !== undefined) out.status = body.status === 'inactive' ? 'inactive' : 'active';
  if (Array.isArray(body.operatingHours)) out.operatingHours = body.operatingHours;
  if (Array.isArray(body.managerIds)) out.managerIds = body.managerIds.filter((id) => mongoose.Types.ObjectId.isValid(String(id)));
  return out;
};

const serializeHub = (hub, staffCount = undefined) => ({
  ...(hub.toObject ? hub.toObject() : hub),
  id: String(hub._id),
  coordinates: hub.location?.coordinates || null,
  ...(staffCount !== undefined ? { staffCount } : {}),
});

export const listHubs = async ({ status, search } = {}) => {
  const query = {};
  if (status) query.status = status;
  if (search) query.$or = [{ code: { $regex: String(search).toUpperCase().replace(/[^A-Z0-9]/g, '') } }, { name: { $regex: String(search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' } }];
  const hubs = await Hub.find(query).sort({ code: 1 }).lean();
  const counts = await HubStaff.aggregate([{ $group: { _id: '$hubId', count: { $sum: 1 } } }]);
  const byHub = new Map(counts.map((row) => [String(row._id), row.count]));
  return hubs.map((hub) => serializeHub(hub, byHub.get(String(hub._id)) || 0));
};

export const getHub = async (id) => {
  const hub = await Hub.findById(assertId(id)).lean();
  if (!hub) throw new ApiError(404, 'Hub not found');
  return serializeHub(hub);
};

export const createHub = async (body) => {
  const fields = pickHubFields(body);
  if (await Hub.exists({ code: fields.code })) throw new ApiError(409, `Hub code ${fields.code} already exists`);
  return serializeHub(await Hub.create(fields));
};

export const updateHub = async (id, body) => {
  const fields = pickHubFields(body, { partial: true });
  if (fields.code && (await Hub.exists({ code: fields.code, _id: { $ne: assertId(id) } }))) {
    throw new ApiError(409, `Hub code ${fields.code} already exists`);
  }
  const hub = await Hub.findByIdAndUpdate(assertId(id), { $set: fields }, { returnDocument: 'after', runValidators: true });
  if (!hub) throw new ApiError(404, 'Hub not found');
  return serializeHub(hub);
};

/// Hubs holding parcels are deactivated, never deleted: deleting one would
/// orphan every shipment and scan that points at it.
export const deleteHub = async (id) => {
  const hubId = assertId(id);
  const inUse = await Shipment.exists({ $or: [{ originHubId: hubId }, { destinationHubId: hubId }, { currentHubId: hubId }] });
  if (inUse) {
    await Hub.updateOne({ _id: hubId }, { $set: { status: 'inactive' } });
    return { deleted: false, deactivated: true };
  }
  await Promise.all([Hub.deleteOne({ _id: hubId }), HubStaff.updateMany({ hubId }, { $set: { active: false } })]);
  return { deleted: true };
};

const normalizeStaffPhone = (phone) => {
  const digits = String(phone || '').replace(/\D/g, '');
  return digits.length === 12 && digits.startsWith('91') ? digits.slice(2) : digits;
};

export const listHubStaff = async ({ hubId } = {}) => {
  const query = hubId ? { hubId: assertId(hubId, 'hubId') } : {};
  const staff = await HubStaff.find(query).sort({ createdAt: -1 }).lean();
  const hubs = await Hub.find({ _id: { $in: [...new Set(staff.map((item) => String(item.hubId)))] } }).select('code name address').lean();
  return staff.map((item) => serializeHubStaff(item, hubs.find((hub) => String(hub._id) === String(item.hubId))));
};

export const createHubStaff = async (body = {}) => {
  const hubId = assertId(body.hubId, 'hubId');
  if (!(await Hub.exists({ _id: hubId }))) throw new ApiError(404, 'Hub not found');
  const phone = normalizeStaffPhone(body.phone);
  if (!/^\d{10}$/.test(phone)) throw new ApiError(400, 'phone must be a 10-digit mobile number');
  if (!String(body.name || '').trim()) throw new ApiError(400, 'name is required');
  if (await HubStaff.exists({ phone })) throw new ApiError(409, 'A hub staff account already uses this phone');
  const staff = await HubStaff.create({
    hubId,
    name: String(body.name).trim(),
    phone,
    email: String(body.email || '').trim().toLowerCase(),
    role: body.role === 'hub_manager' ? 'hub_manager' : 'hub_operator',
    active: body.active !== false,
    passwordHash: body.password ? await hashPassword(String(body.password)) : '',
  });
  if (staff.role === 'hub_manager') await Hub.updateOne({ _id: hubId }, { $addToSet: { managerIds: staff._id } });
  return serializeHubStaff(staff);
};

export const updateHubStaff = async (id, body = {}) => {
  const staff = await HubStaff.findById(assertId(id));
  if (!staff) throw new ApiError(404, 'Hub staff not found');
  if (body.name !== undefined) staff.name = String(body.name).trim();
  if (body.email !== undefined) staff.email = String(body.email || '').trim().toLowerCase();
  if (body.phone !== undefined) {
    const phone = normalizeStaffPhone(body.phone);
    if (!/^\d{10}$/.test(phone)) throw new ApiError(400, 'phone must be a 10-digit mobile number');
    if (await HubStaff.exists({ phone, _id: { $ne: staff._id } })) throw new ApiError(409, 'A hub staff account already uses this phone');
    staff.phone = phone;
  }
  if (body.role !== undefined) staff.role = body.role === 'hub_manager' ? 'hub_manager' : 'hub_operator';
  if (body.active !== undefined) staff.active = Boolean(body.active);
  if (body.hubId !== undefined) staff.hubId = assertId(body.hubId, 'hubId');
  if (body.password) staff.passwordHash = await hashPassword(String(body.password));
  await staff.save();
  if (staff.role === 'hub_manager') await Hub.updateOne({ _id: staff.hubId }, { $addToSet: { managerIds: staff._id } });
  else await Hub.updateMany({ managerIds: staff._id }, { $pull: { managerIds: staff._id } });
  return serializeHubStaff(staff);
};

export const deleteHubStaff = async (id) => {
  const staffId = assertId(id);
  await Promise.all([HubStaff.deleteOne({ _id: staffId }), Hub.updateMany({ managerIds: staffId }, { $pull: { managerIds: staffId } })]);
  return { deleted: true };
};

const num = (value, fallback = 0) => (Number.isFinite(Number(value)) ? Number(value) : fallback);

const pickRateCard = (body = {}) => {
  if (!['intracity', 'intercity', 'long_distance'].includes(body.scope)) throw new ApiError(400, 'scope must be intracity, intercity or long_distance');
  const slabs = (Array.isArray(body.slabs) && body.slabs.length ? body.slabs : DEFAULT_WEIGHT_SLABS).map((slab) => ({
    upToKg: num(slab.upToKg),
    price: Math.max(0, num(slab.price)),
  }));
  if (slabs.some((slab) => !(slab.upToKg > 0))) throw new ApiError(400, 'Every slab needs upToKg > 0');
  return {
    name: String(body.name || '').trim(),
    serviceLocationId: optionalId(body.serviceLocationId),
    scope: body.scope,
    currency: String(body.currency || 'INR'),
    volumetricDivisor: Math.max(1, num(body.volumetricDivisor, 5000)),
    weightStepKg: Math.max(0.01, num(body.weightStepKg, 0.5)),
    slabs: slabs.sort((a, b) => a.upToKg - b.upToKg),
    extraPerKg: Math.max(0, num(body.extraPerKg)),
    distanceBands: (Array.isArray(body.distanceBands) ? body.distanceBands : []).map((band) => ({
      upToKm: num(band.upToKm),
      multiplier: num(band.multiplier, 1) > 0 ? num(band.multiplier, 1) : 1,
      flat: Math.max(0, num(band.flat)),
    })),
    minCharge: Math.max(0, num(body.minCharge)),
    expressAllowed: body.expressAllowed !== false,
    expressMultiplier: Math.max(1, num(body.expressMultiplier, 1.5)),
    fragileSurcharge: { type: body.fragileSurcharge?.type === 'percent' ? 'percent' : 'flat', value: Math.max(0, num(body.fragileSurcharge?.value)) },
    insurance: {
      percent: Math.max(0, num(body.insurance?.percent)),
      min: Math.max(0, num(body.insurance?.min)),
      max: Math.max(0, num(body.insurance?.max)),
      maxDeclaredValue: Math.max(0, num(body.insurance?.maxDeclaredValue)),
    },
    codAllowed: body.codAllowed !== false,
    codFee: { type: body.codFee?.type === 'percent' ? 'percent' : 'flat', value: Math.max(0, num(body.codFee?.value)), min: Math.max(0, num(body.codFee?.min)) },
    pickupCharge: Math.max(0, num(body.pickupCharge)),
    taxPercent: Math.max(0, num(body.taxPercent, 18)),
    active: body.active !== false,
  };
};

export const listRateCards = async ({ scope, serviceLocationId } = {}) => {
  const query = {};
  if (scope) query.scope = scope;
  if (serviceLocationId) query.serviceLocationId = serviceLocationId === 'global' ? null : assertId(serviceLocationId, 'serviceLocationId');
  return ParcelRateCard.find(query).sort({ scope: 1, updatedAt: -1 }).lean();
};

export const createRateCard = async (body) => ParcelRateCard.create(pickRateCard(body));

export const updateRateCard = async (id, body) => {
  const card = await ParcelRateCard.findByIdAndUpdate(assertId(id), { $set: pickRateCard(body) }, { returnDocument: 'after', runValidators: true });
  if (!card) throw new ApiError(404, 'Rate card not found');
  return card;
};

export const deleteRateCard = async (id) => {
  await ParcelRateCard.deleteOne({ _id: assertId(id) });
  return { deleted: true };
};

export const searchShipments = async ({ awb, phone, status, hubId, scope, from, to, page = 1, limit = 50 } = {}) => {
  const query = {};
  if (awb) query.awb = { $regex: String(awb).toUpperCase().replace(/[^A-Z0-9]/g, '') };
  if (phone) {
    const digits = String(phone).replace(/\D/g, '').slice(-10);
    query.$or = [{ 'sender.phone': digits }, { 'receiver.phone': digits }];
  }
  if (status) {
    const statuses = String(status).split(',').filter((item) => SHIPMENT_STATUSES.includes(item));
    if (statuses.length) query.status = { $in: statuses };
  }
  if (scope) query.scope = scope;
  if (hubId) {
    const id = assertId(hubId, 'hubId');
    query.$and = [{ $or: [{ originHubId: id }, { destinationHubId: id }, { currentHubId: id }] }];
  }
  if (from || to) {
    query.createdAt = {};
    if (from) query.createdAt.$gte = new Date(from);
    if (to) query.createdAt.$lte = new Date(`${String(to).slice(0, 10)}T23:59:59.999Z`);
  }
  const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const safePage = Math.max(Number(page) || 1, 1);
  const [items, total] = await Promise.all([
    Shipment.find(query)
      .sort({ createdAt: -1 })
      .skip((safePage - 1) * safeLimit)
      .limit(safeLimit)
      .populate('originHubId', 'code name')
      .populate('destinationHubId', 'code name')
      .populate('currentHubId', 'code name'),
    Shipment.countDocuments(query),
  ]);
  return { results: items.map((item) => serializeShipment(item, { audience: 'hub' })), total, page: safePage, limit: safeLimit };
};

export const getShipmentForAdmin = async (awb) => {
  const shipment = await Shipment.findOne({ awb: String(awb).toUpperCase().replace(/[^A-Z0-9]/g, '') })
    .populate('originHubId', 'code name address')
    .populate('destinationHubId', 'code name address')
    .populate('currentHubId', 'code name address');
  if (!shipment) throw new ApiError(404, 'Shipment not found');
  const [timeline, legs] = await Promise.all([
    getShipmentTimeline(shipment._id, 'hub'),
    ShipmentLeg.find({ shipmentId: shipment._id }).sort({ createdAt: 1 }).lean(),
  ]);
  return { ...serializeShipment(shipment, { audience: 'hub' }), timeline, legDetails: legs };
};
