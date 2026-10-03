import mongoose from 'mongoose';
import { ApiError } from '../../../../utils/ApiError.js';
import { Hub } from '../models/Hub.js';
import { Manifest } from '../models/Manifest.js';
import { Shipment } from '../models/Shipment.js';
import { ShipmentLeg } from '../models/ShipmentLeg.js';
import { generateManifestCode } from './hubLookupService.js';
import { inboundShipment } from './inboundService.js';
import { emitManifestUpdated } from './logisticsRealtime.js';
import { getLogisticsSettings, settingFlag, settingNumber } from './logisticsSettingsService.js';
import { logShipmentScan, recordScanEvent, transitionShipment } from './shipmentLifecycle.js';
import { findShipmentByAwb } from './shipmentService.js';
import { resolveHubRole, resolveScanOutcome } from './shipmentStateMachine.js';

/// Hub-to-hub transfer. A manifest is built at the sending hub by scanning
/// parcels into it, sealed, dispatched (every parcel goes in_transit in one
/// step), and reconciled at the receiving hub against what actually came
/// off the vehicle.

const OPEN_STATUSES = ['created'];

const loadManifest = async (manifestId) => {
  if (!mongoose.Types.ObjectId.isValid(String(manifestId || ''))) throw new ApiError(400, 'manifestId is invalid');
  const manifest = await Manifest.findById(manifestId);
  if (!manifest) throw new ApiError(404, 'Manifest not found');
  return manifest;
};

const assertFromHub = (manifest, hub) => {
  if (String(manifest.fromHubId) !== String(hub._id)) throw new ApiError(403, 'This manifest belongs to another hub');
};

const assertEditable = (manifest) => {
  if (!OPEN_STATUSES.includes(manifest.status)) throw new ApiError(409, `Manifest is ${manifest.status} and can no longer be changed`);
  if (manifest.sealedAt) throw new ApiError(409, 'Manifest is sealed; it can no longer be changed');
};

export const serializeManifest = async (manifest, { withShipments = false } = {}) => {
  const m = manifest.toObject ? manifest.toObject() : manifest;
  const hubs = await Hub.find({ _id: { $in: [m.fromHubId, m.toHubId] } }).select('code name').lean();
  const hubRef = (id) => {
    const hub = hubs.find((item) => String(item._id) === String(id));
    return hub ? { id: String(hub._id), code: hub.code, name: hub.name } : { id: String(id) };
  };
  const received = new Set((m.receivedShipmentIds || []).map(String));
  const base = {
    id: String(m._id),
    code: m.code,
    status: m.status,
    fromHub: hubRef(m.fromHubId),
    toHub: hubRef(m.toHubId),
    count: (m.shipmentIds || []).length,
    receivedCount: received.size,
    vehicle: m.vehicle,
    driver: m.driver,
    sealNumber: m.sealNumber,
    sealedAt: m.sealedAt,
    dispatchedAt: m.dispatchedAt,
    receivedAt: m.receivedAt,
    closedAt: m.closedAt,
    discrepancies: m.discrepancies || [],
    createdAt: m.createdAt,
  };
  if (!withShipments) return base;
  const shipments = await Shipment.find({ _id: { $in: m.shipmentIds || [] } })
    .select('awb status chargeableWeight fragile express receiver.name destinationHubId')
    .lean();
  return {
    ...base,
    shipments: shipments.map((item) => ({
      id: String(item._id),
      awb: item.awb,
      status: item.status,
      chargeableWeight: item.chargeableWeight,
      fragile: item.fragile,
      express: item.express,
      received: received.has(String(item._id)),
    })),
  };
};

export const createManifest = async ({ hub, staff, toHubId, vehicle = {}, driver = {} }) => {
  if (!mongoose.Types.ObjectId.isValid(String(toHubId || ''))) throw new ApiError(400, 'toHubId is required');
  if (String(toHubId) === String(hub._id)) throw new ApiError(400, 'A manifest must go to a different hub');
  const toHub = await Hub.findById(toHubId).lean();
  if (!toHub || toHub.status !== 'active') throw new ApiError(404, 'Destination hub not found or inactive');
  const settings = await getLogisticsSettings();
  const manifest = await Manifest.create({
    code: await generateManifestCode({ hub, offsetMinutes: settingNumber(settings, 'timezone_offset_minutes', 330) }),
    fromHubId: hub._id,
    toHubId: toHub._id,
    vehicle: { number: String(vehicle.number || '').trim(), type: String(vehicle.type || '').trim() },
    driver: {
      driverId: mongoose.Types.ObjectId.isValid(String(driver.driverId || '')) ? driver.driverId : null,
      name: String(driver.name || '').trim(),
      phone: String(driver.phone || '').trim(),
    },
    createdBy: staff?._id || null,
  });
  emitManifestUpdated(manifest);
  return serializeManifest(manifest);
};

export const addToManifest = async ({ hub, staff, manifestId, awb }) => {
  const manifest = await loadManifest(manifestId);
  assertFromHub(manifest, hub);
  assertEditable(manifest);
  const shipment = await findShipmentByAwb(awb);
  if (String(shipment.currentHubId || '') !== String(hub._id)) throw new ApiError(409, 'Parcel is not at this hub; inbound-scan it first');
  const hubRole = resolveHubRole({ hubId: hub._id, originHubId: shipment.originHubId, destinationHubId: shipment.destinationHubId });
  const outcome = resolveScanOutcome({ status: shipment.status, scanType: 'manifest_add', hubRole });
  if (!outcome.allowed) throw new ApiError(409, outcome.reason);
  if (shipment.currentManifestId && String(shipment.currentManifestId) !== String(manifest._id)) {
    throw new ApiError(409, 'Parcel is already on another manifest');
  }
  if ((manifest.shipmentIds || []).some((id) => String(id) === String(shipment._id))) {
    throw new ApiError(409, 'Parcel is already on this manifest');
  }
  const warnings = [];
  const heading = ['rto_initiated', 'rto_in_transit'].includes(shipment.status) ? shipment.originHubId : shipment.destinationHubId;
  if (String(heading) !== String(manifest.toHubId)) {
    warnings.push('This manifest does not go to the parcel’s next hub; it will be routed via a transit hub');
  }
  await Manifest.updateOne({ _id: manifest._id }, { $addToSet: { shipmentIds: shipment._id } });
  await logShipmentScan(shipment, 'manifest_add', {
    hubId: hub._id,
    staffId: staff?._id,
    actorType: 'hub_staff',
    manifestId: manifest._id,
    currentManifestId: manifest._id,
    note: warnings.join(' | '),
  });
  const fresh = await Manifest.findById(manifest._id);
  emitManifestUpdated(fresh);
  return { manifest: await serializeManifest(fresh, { withShipments: true }), warnings };
};

export const removeFromManifest = async ({ hub, staff, manifestId, awb }) => {
  const manifest = await loadManifest(manifestId);
  assertFromHub(manifest, hub);
  assertEditable(manifest);
  const shipment = await findShipmentByAwb(awb);
  if (!(manifest.shipmentIds || []).some((id) => String(id) === String(shipment._id))) {
    throw new ApiError(409, 'Parcel is not on this manifest');
  }
  await Manifest.updateOne({ _id: manifest._id }, { $pull: { shipmentIds: shipment._id } });
  await logShipmentScan(shipment, 'manifest_remove', {
    hubId: hub._id,
    staffId: staff?._id,
    actorType: 'hub_staff',
    manifestId: manifest._id,
    currentManifestId: null,
  });
  const fresh = await Manifest.findById(manifest._id);
  emitManifestUpdated(fresh);
  return serializeManifest(fresh, { withShipments: true });
};

export const sealManifest = async ({ hub, manifestId, sealNumber }) => {
  const manifest = await loadManifest(manifestId);
  assertFromHub(manifest, hub);
  assertEditable(manifest);
  const seal = String(sealNumber || '').trim();
  if (!seal) throw new ApiError(400, 'sealNumber is required');
  if (!manifest.shipmentIds?.length) throw new ApiError(409, 'Cannot seal an empty manifest');
  manifest.sealNumber = seal;
  manifest.sealedAt = new Date();
  await manifest.save();
  emitManifestUpdated(manifest);
  return serializeManifest(manifest, { withShipments: true });
};

/// Dispatch moves every parcel on the manifest out of the hub in one step.
/// Each parcel is checked against the state machine first, and nothing is
/// dispatched if any of them fails, so a manifest never leaves half-sent.
export const dispatchManifest = async ({ hub, staff, manifestId, vehicle, driver }) => {
  const manifest = await loadManifest(manifestId);
  assertFromHub(manifest, hub);
  if (manifest.status !== 'created') throw new ApiError(409, `Manifest is already ${manifest.status}`);
  const settings = await getLogisticsSettings();
  if (settingFlag(settings, 'require_manifest_seal') && !manifest.sealedAt) throw new ApiError(409, 'Seal the manifest before dispatch');
  if (!manifest.shipmentIds?.length) throw new ApiError(409, 'Cannot dispatch an empty manifest');

  const shipments = await Shipment.find({ _id: { $in: manifest.shipmentIds } });
  const plans = shipments.map((shipment) => {
    const hubRole = resolveHubRole({ hubId: hub._id, originHubId: shipment.originHubId, destinationHubId: shipment.destinationHubId });
    const outcome = resolveScanOutcome({ status: shipment.status, scanType: 'outbound', hubRole });
    const atHub = String(shipment.currentHubId || '') === String(hub._id);
    return { shipment, outcome, atHub };
  });
  const blocked = plans.filter((plan) => !plan.outcome.allowed || !plan.atHub);
  if (blocked.length) {
    throw new ApiError(409, 'Some parcels on this manifest cannot be dispatched', {
      blocked: blocked.map((plan) => ({ awb: plan.shipment.awb, status: plan.shipment.status, reason: plan.atHub ? plan.outcome.reason : 'not at this hub' })),
    });
  }

  if (vehicle) manifest.vehicle = { number: String(vehicle.number || manifest.vehicle?.number || ''), type: String(vehicle.type || manifest.vehicle?.type || '') };
  if (driver) manifest.driver = { ...manifest.driver?.toObject?.(), ...driver };
  manifest.status = 'dispatched';
  manifest.dispatchedAt = new Date();
  manifest.dispatchedBy = staff?._id || null;
  await manifest.save();

  for (const { shipment, outcome } of plans) {
    const leg = await ShipmentLeg.create({
      shipmentId: shipment._id,
      awb: shipment.awb,
      type: 'linehaul',
      fromHubId: hub._id,
      toHubId: manifest.toHubId,
      assignmentMode: 'manifest',
      manifestId: manifest._id,
      vehicle: { number: manifest.vehicle?.number || '', type: manifest.vehicle?.type || '' },
      assignee: { name: manifest.driver?.name || '', phone: manifest.driver?.phone || '' },
      driverId: manifest.driver?.driverId || null,
      status: 'in_progress',
      assignedAt: new Date(),
      startedAt: new Date(),
      createdBy: staff?._id || null,
    });
    const ctx = {
      hubId: hub._id,
      staffId: staff?._id,
      actorType: 'hub_staff',
      manifestId: manifest._id,
      currentHubId: null,
      currentManifestId: manifest._id,
      note: `Dispatched on ${manifest.code}`,
      extraSet: { legs: [...new Set([...(shipment.legs || []).map(String), String(leg._id)])] },
    };
    if (outcome.nextStatus) await transitionShipment(shipment, outcome.nextStatus, { ...ctx, scanType: 'outbound' });
    else await logShipmentScan(shipment, 'outbound', ctx);
  }
  emitManifestUpdated(manifest);
  return serializeManifest(manifest, { withShipments: true });
};

export const markManifestInTransit = async ({ hub, manifestId }) => {
  const manifest = await loadManifest(manifestId);
  assertFromHub(manifest, hub);
  if (manifest.status !== 'dispatched') throw new ApiError(409, 'Only a dispatched manifest can be marked in transit');
  manifest.status = 'in_transit';
  await manifest.save();
  emitManifestUpdated(manifest);
  return serializeManifest(manifest);
};

/// Receipt and reconciliation at the destination hub. [awbs] are parcels
/// scanned off the vehicle now (on top of any already inbound-scanned one
/// at a time). Missing, extra and seal problems become discrepancies; the
/// parcels that did arrive are inbound-scanned here.
export const receiveManifest = async ({ hub, staff, manifestId, awbs = [], sealNumber, sealIntact = true, note = '' }) => {
  const manifest = await loadManifest(manifestId);
  if (String(manifest.toHubId) !== String(hub._id)) throw new ApiError(403, 'This manifest is not bound for your hub');
  if (!['dispatched', 'in_transit'].includes(manifest.status)) throw new ApiError(409, `Manifest is ${manifest.status}`);

  const discrepancies = [];
  const results = [];
  const expected = new Set((manifest.shipmentIds || []).map(String));

  for (const raw of Array.isArray(awbs) ? awbs : []) {
    let shipment;
    try {
      shipment = await findShipmentByAwb(raw);
    } catch (error) {
      results.push({ awb: String(raw), ok: false, error: error.message });
      continue;
    }
    if (!expected.has(String(shipment._id))) {
      discrepancies.push({ type: 'extra', shipmentId: shipment._id, awb: shipment.awb, note: 'Arrived but not on this manifest' });
    }
    try {
      const outcome = await inboundShipment({ shipment, hub, staff, note: `Received off ${manifest.code}` });
      if (expected.has(String(shipment._id))) {
        await Manifest.updateOne({ _id: manifest._id }, { $addToSet: { receivedShipmentIds: shipment._id } });
      }
      results.push({ awb: shipment.awb, ok: true, status: outcome.shipment.status, warnings: outcome.warnings });
    } catch (error) {
      results.push({ awb: shipment.awb, ok: false, error: error.message });
    }
  }

  const fresh = await Manifest.findById(manifest._id);
  const received = new Set((fresh.receivedShipmentIds || []).map(String));
  const missingIds = [...expected].filter((id) => !received.has(id));
  const missing = await Shipment.find({ _id: { $in: missingIds } });
  for (const shipment of missing) {
    discrepancies.push({ type: 'missing', shipmentId: shipment._id, awb: shipment.awb, note: 'On the manifest but did not arrive' });
    await recordScanEvent({
      shipment,
      type: 'exception',
      hubId: hub._id,
      staffId: staff?._id,
      actorType: 'hub_staff',
      fromStatus: shipment.status,
      toStatus: shipment.status,
      manifestId: manifest._id,
      discrepancy: true,
      note: `Missing from manifest ${manifest.code} at receipt`,
    });
  }
  const seal = String(sealNumber || '').trim();
  if ((seal && fresh.sealNumber && seal !== fresh.sealNumber) || sealIntact === false || String(sealIntact) === 'false') {
    discrepancies.push({
      type: 'seal_mismatch',
      note: sealIntact === false || String(sealIntact) === 'false' ? 'Seal broken on arrival' : `Seal ${seal} does not match ${fresh.sealNumber}`,
    });
  }

  fresh.discrepancies.push(...discrepancies.map((item) => ({ ...item, at: new Date() })));
  fresh.status = 'received';
  fresh.receivedAt = new Date();
  fresh.receivedBy = staff?._id || null;
  await fresh.save();
  emitManifestUpdated(fresh);
  return { manifest: await serializeManifest(fresh, { withShipments: true }), results, discrepancies, note };
};

export const closeManifest = async ({ hub, manifestId }) => {
  const manifest = await loadManifest(manifestId);
  if (String(manifest.toHubId) !== String(hub._id)) throw new ApiError(403, 'Only the receiving hub can close a manifest');
  if (manifest.status !== 'received') throw new ApiError(409, 'Receive the manifest before closing it');
  if (manifest.discrepancies.some((item) => !item.resolved)) throw new ApiError(409, 'Resolve every discrepancy before closing');
  manifest.status = 'closed';
  manifest.closedAt = new Date();
  await manifest.save();
  emitManifestUpdated(manifest);
  return serializeManifest(manifest);
};

export const resolveManifestDiscrepancy = async ({ hub, manifestId, index, note = '' }) => {
  const manifest = await loadManifest(manifestId);
  if (![String(manifest.toHubId), String(manifest.fromHubId)].includes(String(hub._id))) throw new ApiError(403, 'Not your manifest');
  const item = manifest.discrepancies[Number(index)];
  if (!item) throw new ApiError(404, 'Discrepancy not found');
  item.resolved = true;
  if (note) item.note = `${item.note} | Resolved: ${String(note).slice(0, 300)}`;
  manifest.markModified('discrepancies');
  await manifest.save();
  return serializeManifest(manifest, { withShipments: true });
};

export const listManifests = async ({ hub, direction = 'outbound', status }) => {
  const query = direction === 'inbound' ? { toHubId: hub._id } : { fromHubId: hub._id };
  if (status) query.status = { $in: String(status).split(',') };
  else if (direction === 'inbound') query.status = { $in: ['dispatched', 'in_transit', 'received'] };
  const manifests = await Manifest.find(query).sort({ createdAt: -1 }).limit(200);
  return Promise.all(manifests.map((manifest) => serializeManifest(manifest)));
};

export const getManifest = async ({ hub, manifestId }) => {
  const manifest = await loadManifest(manifestId);
  if (![String(manifest.toHubId), String(manifest.fromHubId)].includes(String(hub._id))) throw new ApiError(403, 'Not your manifest');
  return serializeManifest(manifest, { withShipments: true });
};
