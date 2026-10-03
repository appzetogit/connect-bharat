import { ApiError } from '../../../../utils/ApiError.js';
import { FAILURE_REASON_CODES, initiateRto, markDelivered, markDeliveryFailed, markOutForDelivery } from '../services/deliveryOutcomeService.js';
import { issueDeliveryOtp } from '../services/deliveryOtpService.js';
import { passwordHubLogin, serializeHubStaff, startHubOtpLogin, verifyHubOtpLogin } from '../services/hubAuthService.js';
import {
  getHubDashboard,
  getHubPerformance,
  getHubRevenueReport,
  listHubShipments,
  revenueReportToCsv,
} from '../services/hubReportService.js';
import { assignTaxiLeg, listHubLegs, listNearbyDriversForHub } from '../services/legDispatchService.js';
import {
  addToManifest,
  closeManifest,
  createManifest,
  dispatchManifest,
  getManifest,
  listManifests,
  markManifestInTransit,
  receiveManifest,
  removeFromManifest,
  resolveManifestDiscrepancy,
  sealManifest,
} from '../services/manifestService.js';
import { scanAtHub } from '../services/scanService.js';
import { serializeShipment } from '../services/shipmentLifecycle.js';
import { createShipment, findShipmentByAwb, getShipmentTimeline, rescheduleDelivery } from '../services/shipmentService.js';
import { Hub } from '../models/Hub.js';
import { ShipmentLeg } from '../models/ShipmentLeg.js';

const ctx = (req) => ({ hub: req.hub, staff: req.hubStaff });

/// Delivery outcomes belong to the hub that delivers the parcel.
const assertDestinationHub = (shipment, hub) => {
  if (String(shipment.destinationHubId) !== String(hub._id)) {
    throw new ApiError(403, 'Only the destination hub can do this for this parcel');
  }
};
const ok = (res, data, status = 200) => res.status(status).json({ success: true, data });

// --- auth -------------------------------------------------------------------

export const sendOtp = async (req, res) => ok(res, await startHubOtpLogin({ phone: req.body?.phone }));
export const verifyOtp = async (req, res) => ok(res, await verifyHubOtpLogin({ phone: req.body?.phone, otp: req.body?.otp }));
export const passwordLogin = async (req, res) => ok(res, await passwordHubLogin(req.body || {}));

export const me = async (req, res) =>
  ok(res, {
    staff: serializeHubStaff(req.hubStaff, req.hub),
    activeHub: {
      id: String(req.hub._id),
      code: req.hub.code,
      name: req.hub.name,
      address: req.hub.address,
      type: req.hub.type,
      location: req.hub.location?.coordinates || null,
    },
    hubs: req.hubs.map((hub) => ({ id: String(hub._id), code: hub.code, name: hub.name, status: hub.status })),
    failureReasonCodes: FAILURE_REASON_CODES,
  });

// --- dashboard & lists ------------------------------------------------------

export const dashboard = async (req, res) => ok(res, await getHubDashboard(req.hub));

export const shipments = async (req, res) => ok(res, await listHubShipments({ hub: req.hub, ...req.query }));

export const shipmentDetail = async (req, res) => {
  const shipment = await findShipmentByAwb(req.params.awb, { populateHubs: true });
  const [timeline, legs] = await Promise.all([
    getShipmentTimeline(shipment._id, 'hub'),
    ShipmentLeg.find({ shipmentId: shipment._id }).sort({ createdAt: 1 }).lean(),
  ]);
  ok(res, { ...serializeShipment(shipment, { audience: 'hub' }), timeline, legDetails: legs });
};

/// Other active hubs, for the manifest "to" picker.
export const hubDirectory = async (req, res) => {
  const hubs = await Hub.find({ status: 'active', _id: { $ne: req.hub._id } }).select('code name type address').sort({ code: 1 }).lean();
  ok(res, { results: hubs.map((hub) => ({ id: String(hub._id), code: hub.code, name: hub.name, type: hub.type, address: hub.address })) });
};

// --- scanning -----------------------------------------------------------------

export const scan = async (req, res) => ok(res, await scanAtHub({ ...ctx(req), body: req.body || {} }));

/// Counter booking: the hub books a parcel a walk-in sender hands over.
export const counterBooking = async (req, res) => {
  const result = await createShipment({
    userId: null,
    input: { ...(req.body || {}), pickupMode: 'drop_at_hub', forceHub: true },
    bookedVia: 'hub_counter',
    staff: req.hubStaff,
    staffHub: req.hub,
  });
  ok(res, result, 201);
};

// --- manifests ----------------------------------------------------------------

export const manifestsList = async (req, res) =>
  ok(res, { results: await listManifests({ hub: req.hub, direction: req.query.direction, status: req.query.status }) });
export const manifestCreate = async (req, res) => ok(res, await createManifest({ ...ctx(req), ...(req.body || {}) }), 201);
export const manifestGet = async (req, res) => ok(res, await getManifest({ hub: req.hub, manifestId: req.params.id }));
export const manifestAdd = async (req, res) => ok(res, await addToManifest({ ...ctx(req), manifestId: req.params.id, awb: req.body?.awb }));
export const manifestRemove = async (req, res) => ok(res, await removeFromManifest({ ...ctx(req), manifestId: req.params.id, awb: req.body?.awb }));
export const manifestSeal = async (req, res) => ok(res, await sealManifest({ hub: req.hub, manifestId: req.params.id, sealNumber: req.body?.sealNumber }));
export const manifestDispatch = async (req, res) =>
  ok(res, await dispatchManifest({ ...ctx(req), manifestId: req.params.id, vehicle: req.body?.vehicle, driver: req.body?.driver }));
export const manifestInTransit = async (req, res) => ok(res, await markManifestInTransit({ hub: req.hub, manifestId: req.params.id }));
export const manifestReceive = async (req, res) =>
  ok(res, await receiveManifest({ ...ctx(req), manifestId: req.params.id, ...(req.body || {}) }));
export const manifestClose = async (req, res) => ok(res, await closeManifest({ hub: req.hub, manifestId: req.params.id }));
export const manifestResolve = async (req, res) =>
  ok(res, await resolveManifestDiscrepancy({ hub: req.hub, manifestId: req.params.id, index: req.params.index, note: req.body?.note }));

// --- drivers & legs -------------------------------------------------------------

export const nearbyDrivers = async (req, res) =>
  ok(res, { results: await listNearbyDriversForHub({ hub: req.hub, vehicleTypeId: req.query.vehicleTypeId, radiusKm: req.query.radiusKm }) });

export const legs = async (req, res) => ok(res, { results: await listHubLegs({ hubId: req.hub._id, ...req.query }) });

/// (a) auto taxi dispatch, (b) a chosen online driver, or (c) for last mile,
/// the hub's own runner (mode 'runner' → straight to out for delivery).
export const assignLeg = async (req, res) => {
  const shipment = await findShipmentByAwb(req.params.awb);
  const body = req.body || {};
  const legType = String(body.legType || '').trim();
  const mode = String(body.mode || 'auto').trim();
  if (mode === 'runner') {
    if (legType !== 'last_mile') throw new ApiError(400, 'A hub runner can only take a last-mile leg');
    if (!body.assignee?.name) throw new ApiError(400, 'assignee.name is required for a hub runner');
    if (String(shipment.currentHubId || '') !== String(req.hub._id)) throw new ApiError(409, 'Parcel is not at this hub');
    const result = await markOutForDelivery({ shipment, hubId: req.hub._id, staffId: req.hubStaff._id, assignee: body.assignee });
    ok(res, { leg: result.leg, shipment: serializeShipment(result.shipment, { audience: 'hub' }), deliveryOtp: result.otp || undefined });
    return;
  }
  if (!['auto', 'manual'].includes(mode)) throw new ApiError(400, 'mode must be auto, manual or runner');
  const result = await assignTaxiLeg({
    shipment,
    legType,
    mode,
    driverId: body.driverId,
    vehicleTypeId: body.vehicleTypeId,
    hub: req.hub,
    staff: req.hubStaff,
    scheduledAt: legType === 'first_mile' ? body.scheduledAt || shipment.scheduledPickupAt : body.scheduledAt,
  });
  ok(res, result, 201);
};

/// Bulk hand-over to a runner: every AWB goes out for delivery with them.
export const outForDelivery = async (req, res) => {
  const { awbs = [], assignee = null, driverId = null } = req.body || {};
  if (!Array.isArray(awbs) || !awbs.length) throw new ApiError(400, 'awbs is required');
  const results = [];
  for (const awb of awbs) {
    try {
      const shipment = await findShipmentByAwb(awb);
      if (String(shipment.currentHubId || '') !== String(req.hub._id)) throw new ApiError(409, 'Parcel is not at this hub');
      const result = await markOutForDelivery({ shipment, hubId: req.hub._id, staffId: req.hubStaff._id, assignee, driverId });
      results.push({ awb: shipment.awb, ok: true, status: result.shipment.status, deliveryOtp: result.otp || undefined });
    } catch (error) {
      results.push({ awb: String(awb), ok: false, error: error.message });
    }
  }
  ok(res, { results });
};

// --- delivery outcomes --------------------------------------------------------------

export const deliver = async (req, res) => {
  const shipment = await findShipmentByAwb(req.params.awb);
  // Fields picked one by one: spreading the body would let a client pass
  // skipOtp.
  const { otp, photo, signature, receivedBy, codCollectedAmount } = req.body || {};
  const isRto = ['rto_initiated', 'rto_in_transit'].includes(shipment.status);
  if (isRto && String(shipment.originHubId) !== String(req.hub._id)) {
    throw new ApiError(409, 'Returned parcels are handed back at the origin hub');
  }
  if (!isRto) assertDestinationHub(shipment, req.hub);
  const result = await markDelivered({
    shipment,
    otp,
    photo,
    signature,
    receivedBy,
    codCollectedAmount,
    hubId: req.hub._id,
    staffId: req.hubStaff._id,
  });
  ok(res, serializeShipment(result.shipment, { audience: 'hub' }));
};

export const fail = async (req, res) => {
  const shipment = await findShipmentByAwb(req.params.awb);
  assertDestinationHub(shipment, req.hub);
  const { reasonCode, note, photo } = req.body || {};
  const result = await markDeliveryFailed({ shipment, reasonCode, note, photo, hubId: req.hub._id, staffId: req.hubStaff._id });
  ok(res, { shipment: serializeShipment(result.shipment, { audience: 'hub' }), autoRto: result.autoRto, attemptsMade: result.attemptsMade, maxAttempts: result.maxAttempts });
};

export const reschedule = async (req, res) => {
  const shipment = await findShipmentByAwb(req.params.awb);
  assertDestinationHub(shipment, req.hub);
  const { date, slot, note } = req.body || {};
  ok(res, await rescheduleDelivery({ shipment, date, slot, note, actorType: 'hub_staff', staffId: req.hubStaff._id, hubId: req.hub._id }));
};

export const rto = async (req, res) => {
  const shipment = await findShipmentByAwb(req.params.awb);
  const result = await initiateRto({ shipment, reason: req.body?.reason, hubId: req.hub._id, staffId: req.hubStaff._id });
  ok(res, serializeShipment(result.shipment, { audience: 'hub' }));
};

export const resendOtp = async (req, res) => {
  const shipment = await findShipmentByAwb(req.params.awb);
  assertDestinationHub(shipment, req.hub);
  if (shipment.status !== 'out_for_delivery') throw new ApiError(409, 'OTP can be resent only while the parcel is out for delivery');
  ok(res, await issueDeliveryOtp(shipment));
};

// --- reports ------------------------------------------------------------------------

export const revenue = async (req, res) => {
  const report = await getHubRevenueReport({ hub: req.hub, from: req.query.from, to: req.query.to });
  if (String(req.query.format || '').toLowerCase() === 'csv') {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="hub-${req.hub.code}-revenue-${report.from}-to-${report.to}.csv"`);
    res.send(revenueReportToCsv(report));
    return;
  }
  ok(res, report);
};

export const performance = async (req, res) => ok(res, await getHubPerformance({ hub: req.hub, from: req.query.from, to: req.query.to }));
