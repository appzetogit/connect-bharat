import mongoose from 'mongoose';
import { Hub } from '../models/Hub.js';
import { Manifest } from '../models/Manifest.js';
import { ScanEvent } from '../models/ScanEvent.js';
import { Shipment } from '../models/Shipment.js';
import { ShipmentLeg } from '../models/ShipmentLeg.js';
import { summarizeHubPerformance, rankHubs } from './hubMetrics.js';
import { getLogisticsSettings, settingNumber } from './logisticsSettingsService.js';
import { localDateString, localToUtc } from './pickupSlots.js';
import { serializeShipment } from './shipmentLifecycle.js';
import { SHIPMENT_STATUS } from './shipmentStateMachine.js';

/// Hub dashboard, revenue and performance reports. Day boundaries are the
/// operating timezone's (IST by default), not UTC, so "today" on the
/// dashboard is the hub's today.

const S = SHIPMENT_STATUS;
const oid = (value) => new mongoose.Types.ObjectId(String(value));

const offsetMinutes = async () => settingNumber(await getLogisticsSettings(), 'timezone_offset_minutes', 330);

const startOfLocalDay = (date, offset) => localToUtc(localDateString(date, offset), 0, offset);

/// [from, to) as UTC instants for local YYYY-MM-DD dates; defaults to the
/// last 7 days including today.
export const resolveRange = async ({ from, to } = {}) => {
  const offset = await offsetMinutes();
  const today = localDateString(new Date(), offset);
  const toDate = /^\d{4}-\d{2}-\d{2}$/.test(String(to || '')) ? String(to) : today;
  const fromDate = /^\d{4}-\d{2}-\d{2}$/.test(String(from || ''))
    ? String(from)
    : localDateString(new Date(localToUtc(toDate, 0, offset).getTime() - 6 * 86400000), offset);
  const start = localToUtc(fromDate, 0, offset);
  const end = new Date(localToUtc(toDate, 0, offset).getTime() + 86400000);
  return { fromDate, toDate, start, end, offset };
};

export const getHubDashboard = async (hub) => {
  const hubId = oid(hub._id);
  const offset = await offsetMinutes();
  const todayStart = startOfLocalDay(new Date(), offset);

  const [atHubByStatus, expectedInbound, pendingPickups, failedToday, deliveredToday, openLegs, outForDelivery] = await Promise.all([
    Shipment.aggregate([{ $match: { currentHubId: hubId } }, { $group: { _id: '$status', count: { $sum: 1 } } }]),
    Manifest.find({ toHubId: hubId, status: { $in: ['dispatched', 'in_transit'] } })
      .select('code fromHubId shipmentIds dispatchedAt status')
      .populate('fromHubId', 'code name')
      .lean(),
    Shipment.countDocuments({ originHubId: hubId, status: { $in: [S.BOOKED, S.PICKUP_SCHEDULED, S.PICKED_UP] } }),
    ScanEvent.countDocuments({ hubId, type: 'failed', at: { $gte: todayStart } }),
    ScanEvent.countDocuments({ hubId, type: 'delivered', at: { $gte: todayStart } }),
    ShipmentLeg.countDocuments({ $or: [{ fromHubId: hubId }, { toHubId: hubId }], status: { $in: ['pending', 'assigned', 'in_progress'] }, type: { $ne: 'linehaul' } }),
    Shipment.countDocuments({ destinationHubId: hubId, status: S.OUT_FOR_DELIVERY }),
  ]);

  const counts = Object.fromEntries(atHubByStatus.map((row) => [row._id, row.count]));
  const onHand = atHubByStatus.reduce((sum, row) => sum + row.count, 0);
  // Pending outbound: at this hub, received, and heading somewhere else.
  const pendingOutbound = await Shipment.countDocuments({
    currentHubId: hubId,
    currentManifestId: null,
    $or: [
      { status: S.RECEIVED_AT_ORIGIN_HUB, destinationHubId: { $ne: hubId } },
      { status: S.IN_TRANSIT },
      { status: { $in: [S.RTO_INITIATED, S.RTO_IN_TRANSIT] }, originHubId: { $ne: hubId } },
    ],
  });
  const pendingDelivery = await Shipment.countDocuments({
    currentHubId: hubId,
    $or: [
      { status: { $in: [S.RECEIVED_AT_DESTINATION_HUB, S.REATTEMPT_SCHEDULED, S.DELIVERY_FAILED] } },
      { status: S.RECEIVED_AT_ORIGIN_HUB, destinationHubId: hubId },
    ],
  });

  return {
    hub: { id: String(hub._id), code: hub.code, name: hub.name, capacity: hub.capacity || 0 },
    onHand,
    utilisationPercent: hub.capacity > 0 ? Math.round((onHand / hub.capacity) * 10000) / 100 : null,
    countsByStatus: counts,
    pendingPickups,
    pendingOutbound,
    pendingDelivery,
    outForDelivery,
    openDriverLegs: openLegs,
    failedToday,
    deliveredToday,
    expectedInbound: expectedInbound.map((manifest) => ({
      id: String(manifest._id),
      code: manifest.code,
      status: manifest.status,
      fromHub: manifest.fromHubId ? { code: manifest.fromHubId.code, name: manifest.fromHubId.name } : null,
      count: manifest.shipmentIds?.length || 0,
      dispatchedAt: manifest.dispatchedAt,
    })),
  };
};

/// Shipments for a hub screen. `view`:
///   on_hand        physically at the hub
///   inbound        heading here (in transit / on an inbound manifest)
///   outbound       at the hub and waiting to leave for another hub
///   delivery       at the hub and waiting for a delivery run
///   out_for_delivery, failed, rto, pickups
export const listHubShipments = async ({ hub, view = 'on_hand', status, search, page = 1, limit = 50 }) => {
  const hubId = oid(hub._id);
  const views = {
    on_hand: { currentHubId: hubId },
    inbound: { $or: [{ destinationHubId: hubId, status: S.IN_TRANSIT }, { originHubId: hubId, status: S.RTO_IN_TRANSIT, currentHubId: { $ne: hubId } }] },
    outbound: {
      currentHubId: hubId,
      $or: [
        { status: S.RECEIVED_AT_ORIGIN_HUB, destinationHubId: { $ne: hubId } },
        { status: S.IN_TRANSIT },
        { status: { $in: [S.RTO_INITIATED, S.RTO_IN_TRANSIT] }, originHubId: { $ne: hubId } },
      ],
    },
    delivery: {
      currentHubId: hubId,
      $or: [
        { status: { $in: [S.RECEIVED_AT_DESTINATION_HUB, S.REATTEMPT_SCHEDULED] } },
        { status: S.RECEIVED_AT_ORIGIN_HUB, destinationHubId: hubId },
      ],
    },
    out_for_delivery: { destinationHubId: hubId, status: S.OUT_FOR_DELIVERY },
    failed: { destinationHubId: hubId, status: { $in: [S.DELIVERY_FAILED, S.REATTEMPT_SCHEDULED] } },
    rto: { $or: [{ originHubId: hubId }, { destinationHubId: hubId }], status: { $in: [S.RTO_INITIATED, S.RTO_IN_TRANSIT] } },
    pickups: { originHubId: hubId, status: { $in: [S.BOOKED, S.PICKUP_SCHEDULED, S.PICKED_UP] } },
    all: { $or: [{ originHubId: hubId }, { destinationHubId: hubId }, { currentHubId: hubId }] },
  };
  const query = { ...(views[view] || views.on_hand) };
  if (status) query.status = { $in: String(status).split(',') };
  if (search) {
    const term = String(search).trim().toUpperCase();
    query.$and = [{ $or: [{ awb: { $regex: term.replace(/[^A-Z0-9]/g, '') } }, { 'receiver.phone': term }, { 'sender.phone': term }] }];
  }
  const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const safePage = Math.max(Number(page) || 1, 1);
  const [items, total] = await Promise.all([
    Shipment.find(query)
      .sort({ statusUpdatedAt: -1 })
      .skip((safePage - 1) * safeLimit)
      .limit(safeLimit)
      .populate('originHubId', 'code name')
      .populate('destinationHubId', 'code name')
      .populate('currentHubId', 'code name'),
    Shipment.countDocuments(query),
  ]);
  return { results: items.map((item) => serializeShipment(item, { audience: 'hub' })), total, page: safePage, limit: safeLimit };
};

/// Daily revenue for shipments that originate at the hub: bookings and
/// their value by booking day, plus COD the hub collected on delivery by
/// collection day.
export const getHubRevenueReport = async ({ hub, from, to }) => {
  const hubId = oid(hub._id);
  const range = await resolveRange({ from, to });
  const tz = `${range.offset >= 0 ? '+' : '-'}${String(Math.floor(Math.abs(range.offset) / 60)).padStart(2, '0')}${String(Math.abs(range.offset) % 60).padStart(2, '0')}`;

  const [booked, cod] = await Promise.all([
    Shipment.aggregate([
      { $match: { originHubId: hubId, createdAt: { $gte: range.start, $lt: range.end }, status: { $ne: S.CANCELLED } } },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: tz } },
          shipments: { $sum: 1 },
          revenue: { $sum: { $ifNull: ['$pricing.total', 0] } },
          tax: { $sum: { $ifNull: ['$pricing.taxAmount', 0] } },
          insurance: { $sum: { $ifNull: ['$pricing.insurancePremium', 0] } },
          prepaid: { $sum: { $cond: [{ $eq: ['$payment.method', 'online'] }, { $ifNull: ['$pricing.total', 0] }, 0] } },
          cashAtPickup: { $sum: { $cond: [{ $eq: ['$payment.method', 'cash'] }, { $ifNull: ['$pricing.total', 0] }, 0] } },
          codBooked: { $sum: { $cond: [{ $eq: ['$payment.method', 'cod'] }, { $ifNull: ['$pricing.total', 0] }, 0] } },
          chargeableKg: { $sum: { $ifNull: ['$chargeableWeight', 0] } },
        },
      },
    ]),
    Shipment.aggregate([
      { $match: { 'payment.codCollectedByHubId': hubId, 'payment.codCollectedAt': { $gte: range.start, $lt: range.end } } },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$payment.codCollectedAt', timezone: tz } },
          codCollected: { $sum: { $ifNull: ['$payment.codCollectedAmount', 0] } },
          codShipments: { $sum: 1 },
        },
      },
    ]),
  ]);

  const days = [];
  for (let t = range.start.getTime(); t < range.end.getTime(); t += 86400000) {
    days.push(localDateString(new Date(t), range.offset));
  }
  const round = (value) => Math.round((Number(value) || 0) * 100) / 100;
  const rows = days.map((day) => {
    const b = booked.find((row) => row._id === day) || {};
    const c = cod.find((row) => row._id === day) || {};
    return {
      date: day,
      shipments: b.shipments || 0,
      revenue: round(b.revenue),
      tax: round(b.tax),
      insurance: round(b.insurance),
      prepaid: round(b.prepaid),
      cashAtPickup: round(b.cashAtPickup),
      codBooked: round(b.codBooked),
      chargeableKg: round(b.chargeableKg),
      codCollected: round(c.codCollected),
      codShipments: c.codShipments || 0,
    };
  });
  const totals = rows.reduce((acc, row) => {
    for (const [key, value] of Object.entries(row)) if (key !== 'date') acc[key] = round((acc[key] || 0) + value);
    return acc;
  }, {});
  return { hub: { id: String(hub._id), code: hub.code, name: hub.name }, from: range.fromDate, to: range.toDate, rows, totals };
};

const csvCell = (value) => {
  const text = String(value ?? '');
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

export const revenueReportToCsv = (report) => {
  const header = ['date', 'shipments', 'revenue', 'tax', 'insurance', 'prepaid', 'cashAtPickup', 'codBooked', 'codCollected', 'codShipments', 'chargeableKg'];
  const lines = [header.join(',')];
  for (const row of report.rows) lines.push(header.map((key) => csvCell(row[key])).join(','));
  lines.push(['TOTAL', ...header.slice(1).map((key) => csvCell(report.totals[key]))].join(','));
  return lines.join('\n');
};

const EVENT_CAP = 50000;

export const getHubPerformance = async ({ hub, from, to }) => {
  const hubId = oid(hub._id);
  const range = await resolveRange({ from, to });
  const [events, shipments] = await Promise.all([
    ScanEvent.find({ hubId, at: { $gte: range.start, $lt: range.end } })
      .select('shipmentId hubId type at')
      .limit(EVENT_CAP)
      .lean(),
    Shipment.find({ destinationHubId: hubId, createdAt: { $gte: range.start, $lt: range.end } })
      .select('status slaDueAt deliveredAt')
      .lean(),
  ]);
  return {
    hub: { id: String(hub._id), code: hub.code, name: hub.name },
    from: range.fromDate,
    to: range.toDate,
    ...summarizeHubPerformance({ hubId, events, shipments }),
    truncated: events.length >= EVENT_CAP,
  };
};

export const getHubLeagueTable = async ({ from, to }) => {
  const hubs = await Hub.find({ status: 'active' }).select('code name').lean();
  const summaries = [];
  for (const hub of hubs) {
    const summary = await getHubPerformance({ hub, from, to });
    summaries.push({ ...summary, hub: summary.hub });
  }
  return rankHubs(summaries);
};
