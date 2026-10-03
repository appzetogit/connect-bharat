/// Hub-network parcel pricing. Pure functions only: the rate card is looked
/// up by the caller (shipmentService) and handed in, so every rule here can
/// be unit-tested without a database and the quote and the booking run the
/// exact same arithmetic.
///
/// Order of operations, chosen so each surcharge has an obvious base:
///   1. chargeable weight = max(actual, volumetric), rounded up to the card's step
///   2. freight = weight-slab price (+ per-extra-kg beyond the last slab)
///   3. distance band (intercity / long-distance): freight × multiplier + flat
///   4. minimum freight
///   5. express = freight × (multiplier − 1); fragile = flat or % of freight
///   6. pickup charge (first mile), insurance premium, COD fee
///   7. tax on the lot (GST is levied on insurance and COD fees too)

export const DEFAULT_VOLUMETRIC_DIVISOR = 5000;
export const DEFAULT_WEIGHT_STEP_KG = 0.5;

/// The SOW's slab boundaries. A card stores its own prices against them;
/// these are the shape a new card starts from in the admin panel.
export const DEFAULT_WEIGHT_SLABS = Object.freeze([
  { upToKg: 0.5, price: 0 },
  { upToKg: 1, price: 0 },
  { upToKg: 2, price: 0 },
  { upToKg: 5, price: 0 },
  { upToKg: 10, price: 0 },
]);

const round2 = (value) => Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
const nonNegative = (value) => Math.max(0, Number(value) || 0);

export const computeVolumetricWeight = (dimensions = {}, divisor = DEFAULT_VOLUMETRIC_DIVISOR) => {
  const l = nonNegative(dimensions?.l ?? dimensions?.length);
  const w = nonNegative(dimensions?.w ?? dimensions?.width);
  const h = nonNegative(dimensions?.h ?? dimensions?.height);
  const safeDivisor = Number(divisor) > 0 ? Number(divisor) : DEFAULT_VOLUMETRIC_DIVISOR;
  if (!l || !w || !h) return 0;
  return round2((l * w * h) / safeDivisor);
};

/// Rounds up to the next step (0.5kg by default), the way couriers bill: a
/// 1.1kg parcel is billed as 1.5kg, never 1kg.
export const roundUpToStep = (value, step = DEFAULT_WEIGHT_STEP_KG) => {
  const safeStep = Number(step) > 0 ? Number(step) : DEFAULT_WEIGHT_STEP_KG;
  const units = Math.ceil(round2(nonNegative(value) / safeStep) - 1e-9);
  return round2(Math.max(units, 1) * safeStep);
};

export const computeChargeableWeight = ({ weightKg, dimensions, divisor, stepKg } = {}) => {
  const actualWeightKg = round2(nonNegative(weightKg));
  const volumetricWeightKg = computeVolumetricWeight(dimensions, divisor);
  const chargeableWeightKg = roundUpToStep(Math.max(actualWeightKg, volumetricWeightKg), stepKg);
  return {
    actualWeightKg,
    volumetricWeightKg,
    chargeableWeightKg,
    billedOn: volumetricWeightKg > actualWeightKg ? 'volumetric' : 'actual',
  };
};

/// A coarse size label for apps and hub shelving. Driven by chargeable
/// weight because that already folds in the dimensions.
export const resolveSizeCategory = (chargeableWeightKg) => {
  const kg = nonNegative(chargeableWeightKg);
  if (kg <= 0.5) return 'envelope';
  if (kg <= 2) return 'small';
  if (kg <= 10) return 'medium';
  if (kg <= 25) return 'large';
  return 'extra_large';
};

const sortedSlabs = (slabs = []) =>
  (Array.isArray(slabs) ? slabs : [])
    .map((slab) => ({ upToKg: nonNegative(slab?.upToKg), price: nonNegative(slab?.price) }))
    .filter((slab) => slab.upToKg > 0)
    .sort((a, b) => a.upToKg - b.upToKg);

/// Slab prices are the full price for a parcel up to that weight (not
/// cumulative). Beyond the last slab every started kg costs extraPerKg.
export const computeWeightCharge = ({ chargeableWeightKg, slabs, extraPerKg = 0 }) => {
  const ordered = sortedSlabs(slabs);
  if (!ordered.length) {
    return null;
  }
  const kg = nonNegative(chargeableWeightKg);
  const slab = ordered.find((item) => kg <= item.upToKg + 1e-9);
  if (slab) {
    return { amount: round2(slab.price), slab: { upToKg: slab.upToKg, price: slab.price }, extraKg: 0 };
  }
  const last = ordered[ordered.length - 1];
  const extraKg = Math.ceil(round2(kg - last.upToKg) - 1e-9);
  return {
    amount: round2(last.price + extraKg * nonNegative(extraPerKg)),
    slab: { upToKg: last.upToKg, price: last.price },
    extraKg,
  };
};

/// Distance bands: the first band whose upToKm covers the distance; a
/// distance past every band uses the last one. No bands → no adjustment.
export const resolveDistanceBand = (bands = [], distanceKm = 0) => {
  const ordered = (Array.isArray(bands) ? bands : [])
    .map((band) => ({
      upToKm: nonNegative(band?.upToKm),
      multiplier: Number(band?.multiplier) > 0 ? Number(band.multiplier) : 1,
      flat: nonNegative(band?.flat),
    }))
    .filter((band) => band.upToKm > 0)
    .sort((a, b) => a.upToKm - b.upToKm);
  if (!ordered.length) return null;
  const km = nonNegative(distanceKm);
  return ordered.find((band) => km <= band.upToKm) || ordered[ordered.length - 1];
};

const flatOrPercent = (rule = {}, base = 0) => {
  const value = nonNegative(rule?.value);
  if (!value) return 0;
  return String(rule?.type || 'flat').toLowerCase() === 'percent' ? (nonNegative(base) * value) / 100 : value;
};

export const computeInsurancePremium = ({ declaredValue, insurance = {} }) => {
  const value = nonNegative(declaredValue);
  const percent = nonNegative(insurance?.percent);
  if (!value || !percent) return 0;
  const raw = (value * percent) / 100;
  const min = nonNegative(insurance?.min);
  const max = nonNegative(insurance?.max);
  let premium = Math.max(raw, min);
  if (max > 0) premium = Math.min(premium, max);
  return round2(premium);
};

/// The full price of one shipment on one rate card.
///
/// Throws when the card cannot price it (no slabs), rather than returning
/// zero: a free shipment because a card was half-configured is the failure
/// this guards against.
export const computeShipmentPrice = ({
  rateCard,
  chargeableWeightKg,
  distanceKm = 0,
  express = false,
  fragile = false,
  insuranceOpted = false,
  declaredValue = 0,
  paymentMethod = 'online',
  withPickup = false,
}) => {
  if (!rateCard) {
    throw new Error('No rate card to price this shipment');
  }
  const weight = computeWeightCharge({
    chargeableWeightKg,
    slabs: rateCard.slabs,
    extraPerKg: rateCard.extraPerKg,
  });
  if (!weight) {
    throw new Error('The rate card has no weight slabs');
  }

  const band = resolveDistanceBand(rateCard.distanceBands, distanceKm);
  let freight = weight.amount;
  if (band) {
    freight = freight * band.multiplier + band.flat;
  }
  const minFreight = nonNegative(rateCard.minCharge);
  freight = round2(Math.max(freight, minFreight));
  const distanceAdjustment = round2(freight - weight.amount);

  const expressMultiplier = Number(rateCard.expressMultiplier) > 1 ? Number(rateCard.expressMultiplier) : 1;
  const expressCharge = express ? round2(freight * (expressMultiplier - 1)) : 0;
  const fragileCharge = fragile ? round2(flatOrPercent(rateCard.fragileSurcharge, freight)) : 0;
  const pickupCharge = withPickup ? round2(nonNegative(rateCard.pickupCharge)) : 0;
  const maxDeclared = nonNegative(rateCard.insurance?.maxDeclaredValue);
  if (insuranceOpted && maxDeclared > 0 && nonNegative(declaredValue) > maxDeclared) {
    throw new Error(`Declared value above ${maxDeclared} cannot be insured`);
  }
  const insurancePremium = insuranceOpted ? computeInsurancePremium({ declaredValue, insurance: rateCard.insurance }) : 0;

  const beforeCod = freight + expressCharge + fragileCharge + pickupCharge + insurancePremium;
  const isCod = String(paymentMethod || '').toLowerCase() === 'cod';
  let codFee = 0;
  if (isCod) {
    codFee = flatOrPercent(rateCard.codFee, beforeCod);
    codFee = Math.max(codFee, nonNegative(rateCard.codFee?.min));
    codFee = round2(codFee);
  }

  const subtotal = round2(beforeCod + codFee);
  const taxPercent = nonNegative(rateCard.taxPercent);
  const taxAmount = round2((subtotal * taxPercent) / 100);
  const total = round2(subtotal + taxAmount);

  return {
    currency: rateCard.currency || 'INR',
    chargeableWeightKg: round2(chargeableWeightKg),
    weightCharge: weight.amount,
    slab: weight.slab,
    extraKg: weight.extraKg,
    distanceKm: round2(distanceKm),
    distanceBand: band,
    distanceAdjustment,
    freight,
    expressCharge,
    fragileCharge,
    pickupCharge,
    insurancePremium,
    insuranceCoverAmount: insuranceOpted ? round2(declaredValue) : 0,
    codFee,
    subtotal,
    taxPercent,
    taxAmount,
    total,
  };
};

/// Pure: is the measured chargeable weight outside the tolerance?
export const checkWeightDiscrepancy = ({ bookedChargeableKg, measuredChargeableKg, tolerancePercent = 10 }) => {
  const booked = Math.max(0, Number(bookedChargeableKg) || 0);
  const measured = Math.max(0, Number(measuredChargeableKg) || 0);
  if (!booked) return { flagged: measured > 0, differencePercent: measured > 0 ? 100 : 0 };
  const differencePercent = Math.round((Math.abs(measured - booked) / booked) * 10000) / 100;
  return { flagged: differencePercent > Math.max(0, Number(tolerancePercent) || 0), differencePercent };
};
