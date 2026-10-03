import {
  addTripExpense,
  buildFareSummary,
  createAdvanceRazorpayOrder,
  getFareSummary,
  listAdminOutstationRides,
  payAdvanceWithWallet,
  recordOdometerReading,
  verifyAdvanceRazorpayPayment,
  waiveAdvance,
} from '../services/outstationService.js';

export const createAdvanceOrder = async (req, res) => {
  const data = await createAdvanceRazorpayOrder({ rideId: req.params.rideId, userId: req.auth.sub });
  res.status(201).json({ success: true, data });
};

export const verifyAdvancePayment = async (req, res) => {
  const ride = await verifyAdvanceRazorpayPayment({ rideId: req.params.rideId, userId: req.auth.sub, body: req.body || {} });
  res.json({ success: true, data: ride });
};

export const payAdvanceFromWallet = async (req, res) => {
  const ride = await payAdvanceWithWallet({ rideId: req.params.rideId, userId: req.auth.sub });
  res.status(201).json({ success: true, data: ride });
};

export const saveOdometerReading = async (req, res) => {
  const ride = await recordOdometerReading({
    rideId: req.params.rideId,
    driverId: req.auth.sub,
    stage: req.body?.stage,
    reading: req.body?.reading,
    photoUrl: req.body?.photoUrl || req.body?.imageUrl || req.body?.url,
  });
  res.json({ success: true, data: { rideId: String(ride._id), odometer: ride.odometer } });
};

export const createTripExpense = async (req, res) => {
  const ride = await addTripExpense({
    rideId: req.params.rideId,
    driverId: req.auth.sub,
    type: req.body?.type,
    label: req.body?.label,
    amount: req.body?.amount,
    receiptUrl: req.body?.receiptUrl || req.body?.imageUrl || req.body?.url,
  });
  res.status(201).json({ success: true, data: buildFareSummary(ride) });
};

export const getRideFareSummary = async (req, res) => {
  const data = await getFareSummary({ rideId: req.params.rideId, role: req.auth.role, entityId: req.auth.sub });
  res.json({ success: true, data });
};

export const listOutstationRidesForAdmin = async (req, res) => {
  const data = await listAdminOutstationRides(req.query || {});
  res.json({ success: true, data });
};

export const waiveOutstationAdvance = async (req, res) => {
  const ride = await waiveAdvance({ rideId: req.params.rideId });
  res.json({ success: true, data: buildFareSummary(ride) });
};
