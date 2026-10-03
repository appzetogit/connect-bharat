import { ApiError } from '../../../../utils/ApiError.js';
import { Manifest } from '../models/Manifest.js';
import { ParcelRateCard } from '../models/ParcelRateCard.js';
import { ShipmentLeg } from '../models/ShipmentLeg.js';
import { getLogisticsSettings, settingNumber } from './logisticsSettingsService.js';
import { logShipmentScan, transitionShipment } from './shipmentLifecycle.js';
import { checkWeightDiscrepancy, computeChargeableWeight } from './shipmentPricing.js';
import { resolveHubRole, resolveScanOutcome } from './shipmentStateMachine.js';

/// Inbound: a parcel arriving at a hub, from a pickup driver, a sender at
/// the counter, or off a manifest. Re-weighs when the operator enters a
/// weight, and ticks the parcel off its manifest when it came on one.

const reweigh = async ({ shipment, weightKg, dimensions, hubId }) => {
  if (weightKg === undefined || weightKg === null || weightKg === '') return null;
  const measuredWeightKg = Number(weightKg);
  if (!Number.isFinite(measuredWeightKg) || measuredWeightKg <= 0) throw new ApiError(400, 'weightKg must be a positive number');
  const settings = await getLogisticsSettings();
  const card = shipment.rateCardId ? await ParcelRateCard.findById(shipment.rateCardId).select('volumetricDivisor weightStepKg').lean() : null;
  const measured = computeChargeableWeight({
    weightKg: measuredWeightKg,
    dimensions: dimensions || shipment.dimensions,
    divisor: card?.volumetricDivisor,
    stepKg: card?.weightStepKg,
  });
  const check = checkWeightDiscrepancy({
    bookedChargeableKg: shipment.chargeableWeight,
    measuredChargeableKg: measured.chargeableWeightKg,
    tolerancePercent: settingNumber(settings, 'weight_tolerance_percent', 10),
  });
  return {
    ...check,
    measured,
    extraSet: check.flagged
      ? {
          'weightDiscrepancy.flagged': true,
          'weightDiscrepancy.bookedChargeableKg': shipment.chargeableWeight,
          'weightDiscrepancy.measuredChargeableKg': measured.chargeableWeightKg,
          'weightDiscrepancy.measuredWeightKg': measuredWeightKg,
          'weightDiscrepancy.hubId': hubId,
          'weightDiscrepancy.at': new Date(),
          'weightDiscrepancy.resolved': false,
        }
      : {},
  };
};

export const inboundShipment = async ({ shipment, hub, staff, weightKg, dimensions, note = '', photo = '', coordinates = null }) => {
  const hubRole = resolveHubRole({ hubId: hub._id, originHubId: shipment.originHubId, destinationHubId: shipment.destinationHubId });
  const outcome = resolveScanOutcome({ status: shipment.status, scanType: 'inbound', hubRole });
  if (!outcome.allowed) throw new ApiError(409, outcome.reason);
  if (shipment.currentHubId && String(shipment.currentHubId) === String(hub._id) && !outcome.nextStatus) {
    throw new ApiError(409, 'Parcel is already at this hub');
  }

  const weight = await reweigh({ shipment, weightKg, dimensions, hubId: hub._id });
  const warnings = [];
  if (weight?.flagged) {
    warnings.push(`Weight discrepancy: booked ${shipment.chargeableWeight}kg, measured ${weight.measured.chargeableWeightKg}kg`);
  }

  // Ticking off a manifest: the parcel came in on one bound for this hub.
  let manifestId = null;
  if (shipment.currentManifestId) {
    const manifest = await Manifest.findById(shipment.currentManifestId);
    if (manifest && ['dispatched', 'in_transit'].includes(manifest.status)) {
      manifestId = manifest._id;
      if (String(manifest.toHubId) === String(hub._id)) {
        await Manifest.updateOne({ _id: manifest._id }, { $addToSet: { receivedShipmentIds: shipment._id } });
      } else {
        warnings.push(`Misrouted: this parcel is on manifest ${manifest.code} bound for another hub`);
      }
      await ShipmentLeg.updateMany(
        { shipmentId: shipment._id, manifestId: manifest._id, status: { $in: ['assigned', 'in_progress'] } },
        { $set: { status: 'completed', completedAt: new Date(), toHubId: hub._id } },
      );
    }
  }

  const ctx = {
    hubId: hub._id,
    staffId: staff?._id || null,
    actorType: 'hub_staff',
    currentHubId: hub._id,
    currentManifestId: null,
    manifestId,
    note: [note, ...warnings].filter(Boolean).join(' | '),
    photo,
    coordinates,
    discrepancy: Boolean(weight?.flagged) || warnings.length > 0,
    meta: weight ? { measuredWeightKg: Number(weightKg), measuredChargeableKg: weight.measured.chargeableWeightKg, differencePercent: weight.differencePercent } : null,
    extraSet: weight?.extraSet || {},
  };
  const result = outcome.nextStatus
    ? await transitionShipment(shipment, outcome.nextStatus, { ...ctx, scanType: 'inbound' })
    : await logShipmentScan(shipment, 'inbound', ctx);
  return { ...result, warnings, weightCheck: weight ? { flagged: weight.flagged, differencePercent: weight.differencePercent, measured: weight.measured } : null };
};
