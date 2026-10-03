import { ApiError } from '../../../../utils/ApiError.js';
import { renderShipmentLabelPdf } from '../services/labelService.js';
import {
  cancelMyShipment,
  createShipment,
  findShipmentByAwb,
  getMyShipment,
  getPickupSlots,
  listActiveHubsPublic,
  listMyShipments,
  quoteShipment,
  rescheduleMyShipment,
  trackShipmentPublic,
} from '../services/shipmentService.js';

export const quote = async (req, res) => {
  res.json({ success: true, data: await quoteShipment(req.body || {}) });
};

export const book = async (req, res) => {
  const result = await createShipment({ userId: req.auth.sub, input: req.body || {} });
  res.status(201).json({ success: true, data: result });
};

export const listMine = async (req, res) => {
  res.json({ success: true, data: await listMyShipments({ userId: req.auth.sub, ...req.query }) });
};

export const getMine = async (req, res) => {
  res.json({ success: true, data: await getMyShipment({ userId: req.auth.sub, awb: req.params.awb }) });
};

export const cancelMine = async (req, res) => {
  res.json({ success: true, data: await cancelMyShipment({ userId: req.auth.sub, awb: req.params.awb, reason: req.body?.reason }) });
};

export const rescheduleMine = async (req, res) => {
  const { date, slot } = req.body || {};
  res.json({ success: true, data: await rescheduleMyShipment({ userId: req.auth.sub, awb: req.params.awb, date, slot }) });
};

export const pickupSlots = async (req, res) => {
  res.json({ success: true, data: { results: await getPickupSlots({ date: req.query.date }) } });
};

export const hubs = async (_req, res) => {
  res.json({ success: true, data: { results: await listActiveHubsPublic() } });
};

export const trackPublic = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ success: true, data: await trackShipmentPublic(req.params.awb) });
};

/// The label: the booking user, any hub staff, or an admin may print it.
export const label = async (req, res) => {
  const shipment = await findShipmentByAwb(req.params.awb);
  const role = req.auth?.role;
  if (role === 'user' && String(shipment.bookingUserId || '') !== String(req.auth.sub)) {
    throw new ApiError(404, 'Shipment not found');
  }
  const pdf = await renderShipmentLabelPdf(shipment);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${shipment.awb}.pdf"`);
  res.send(pdf);
};
