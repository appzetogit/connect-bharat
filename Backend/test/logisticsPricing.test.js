import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { computeDirectParcelSurcharges } from '../src/modules/taxi/logistics/services/directParcelSurcharges.js';
import {
  checkWeightDiscrepancy,
  computeChargeableWeight,
  computeInsurancePremium,
  computeShipmentPrice,
  computeVolumetricWeight,
  computeWeightCharge,
  resolveDistanceBand,
  resolveSizeCategory,
  roundUpToStep,
} from '../src/modules/taxi/logistics/services/shipmentPricing.js';

const SLABS = [
  { upToKg: 0.5, price: 40 },
  { upToKg: 1, price: 60 },
  { upToKg: 2, price: 90 },
  { upToKg: 5, price: 150 },
  { upToKg: 10, price: 250 },
];

const card = (overrides = {}) => ({
  slabs: SLABS,
  extraPerKg: 20,
  volumetricDivisor: 5000,
  weightStepKg: 0.5,
  distanceBands: [],
  minCharge: 0,
  expressMultiplier: 1.5,
  fragileSurcharge: { type: 'flat', value: 30 },
  insurance: { percent: 2, min: 25, max: 1000, maxDeclaredValue: 100000 },
  codFee: { type: 'percent', value: 2, min: 30 },
  pickupCharge: 20,
  taxPercent: 18,
  ...overrides,
});

describe('chargeable weight', () => {
  it('volumetric = l×w×h / divisor', () => {
    assert.equal(computeVolumetricWeight({ l: 50, w: 40, h: 30 }), 12);
    assert.equal(computeVolumetricWeight({ l: 50, w: 40, h: 30 }, 6000), 10);
    assert.equal(computeVolumetricWeight({ l: 50, w: 40 }), 0, 'missing a side means no volumetric weight');
    assert.equal(computeVolumetricWeight({ l: 10, w: 10, h: 10 }, 0), 0.2, 'bad divisor falls back to 5000');
  });

  it('rounds up to the next step and never below one step', () => {
    assert.equal(roundUpToStep(1.1), 1.5);
    assert.equal(roundUpToStep(1.5), 1.5);
    assert.equal(roundUpToStep(0.01), 0.5);
    assert.equal(roundUpToStep(0), 0.5);
    assert.equal(roundUpToStep(2.01, 1), 3);
  });

  it('bills the greater of actual and volumetric', () => {
    assert.deepEqual(computeChargeableWeight({ weightKg: 2, dimensions: { l: 50, w: 40, h: 30 } }), {
      actualWeightKg: 2,
      volumetricWeightKg: 12,
      chargeableWeightKg: 12,
      billedOn: 'volumetric',
    });
    const dense = computeChargeableWeight({ weightKg: 3.2, dimensions: { l: 10, w: 10, h: 10 } });
    assert.equal(dense.chargeableWeightKg, 3.5);
    assert.equal(dense.billedOn, 'actual');
  });

  it('size category follows chargeable weight', () => {
    assert.equal(resolveSizeCategory(0.5), 'envelope');
    assert.equal(resolveSizeCategory(1.5), 'small');
    assert.equal(resolveSizeCategory(10), 'medium');
    assert.equal(resolveSizeCategory(20), 'large');
    assert.equal(resolveSizeCategory(40), 'extra_large');
  });
});

describe('weight slabs', () => {
  it('picks the first slab that covers the weight, at the boundary inclusive', () => {
    assert.equal(computeWeightCharge({ chargeableWeightKg: 0.5, slabs: SLABS }).amount, 40);
    assert.equal(computeWeightCharge({ chargeableWeightKg: 1, slabs: SLABS }).amount, 60);
    assert.equal(computeWeightCharge({ chargeableWeightKg: 1.5, slabs: SLABS }).amount, 90);
    assert.equal(computeWeightCharge({ chargeableWeightKg: 5, slabs: SLABS }).amount, 150);
    assert.equal(computeWeightCharge({ chargeableWeightKg: 7, slabs: SLABS }).amount, 250);
  });

  it('charges every started kg beyond the last slab', () => {
    const over = computeWeightCharge({ chargeableWeightKg: 12.5, slabs: SLABS, extraPerKg: 20 });
    assert.equal(over.extraKg, 3);
    assert.equal(over.amount, 250 + 3 * 20);
  });

  it('works on unsorted slabs and returns null with none', () => {
    assert.equal(computeWeightCharge({ chargeableWeightKg: 1.5, slabs: [...SLABS].reverse() }).amount, 90);
    assert.equal(computeWeightCharge({ chargeableWeightKg: 1, slabs: [] }), null);
  });
});

describe('distance bands', () => {
  const bands = [
    { upToKm: 500, multiplier: 1.4, flat: 0 },
    { upToKm: 100, multiplier: 1, flat: 20 },
    { upToKm: 1500, multiplier: 2, flat: 50 },
  ];
  it('first covering band, sorted; past the last uses the last', () => {
    assert.deepEqual(resolveDistanceBand(bands, 80), { upToKm: 100, multiplier: 1, flat: 20 });
    assert.deepEqual(resolveDistanceBand(bands, 100), { upToKm: 100, multiplier: 1, flat: 20 });
    assert.deepEqual(resolveDistanceBand(bands, 101), { upToKm: 500, multiplier: 1.4, flat: 0 });
    assert.deepEqual(resolveDistanceBand(bands, 4000), { upToKm: 1500, multiplier: 2, flat: 50 });
    assert.equal(resolveDistanceBand([], 50), null);
  });
});

describe('insurance premium', () => {
  it('percent of declared value clamped to min and max', () => {
    assert.equal(computeInsurancePremium({ declaredValue: 10000, insurance: { percent: 2, min: 25, max: 1000 } }), 200);
    assert.equal(computeInsurancePremium({ declaredValue: 500, insurance: { percent: 2, min: 25, max: 1000 } }), 25);
    assert.equal(computeInsurancePremium({ declaredValue: 90000, insurance: { percent: 2, min: 25, max: 1000 } }), 1000);
    assert.equal(computeInsurancePremium({ declaredValue: 0, insurance: { percent: 2 } }), 0);
  });
});

describe('computeShipmentPrice', () => {
  it('prices a plain intracity parcel: slab + tax', () => {
    const price = computeShipmentPrice({ rateCard: card(), chargeableWeightKg: 1.5 });
    assert.equal(price.weightCharge, 90);
    assert.equal(price.freight, 90);
    assert.equal(price.subtotal, 90);
    assert.equal(price.taxAmount, 16.2);
    assert.equal(price.total, 106.2);
    assert.equal(price.expressCharge + price.fragileCharge + price.insurancePremium + price.codFee + price.pickupCharge, 0);
  });

  it('applies band, express, fragile, pickup, insurance, COD and tax in order', () => {
    const price = computeShipmentPrice({
      rateCard: card({ distanceBands: [{ upToKm: 500, multiplier: 1.5, flat: 10 }] }),
      chargeableWeightKg: 2,
      distanceKm: 320,
      express: true,
      fragile: true,
      insuranceOpted: true,
      declaredValue: 5000,
      paymentMethod: 'cod',
      withPickup: true,
    });
    // freight = 90 × 1.5 + 10 = 145
    assert.equal(price.freight, 145);
    assert.equal(price.distanceAdjustment, 55);
    assert.equal(price.expressCharge, 72.5);
    assert.equal(price.fragileCharge, 30);
    assert.equal(price.pickupCharge, 20);
    assert.equal(price.insurancePremium, 100);
    assert.equal(price.insuranceCoverAmount, 5000);
    // COD 2% of (145 + 72.5 + 30 + 20 + 100) = 7.35, raised to the 30 minimum
    assert.equal(price.codFee, 30);
    assert.equal(price.subtotal, 397.5);
    assert.equal(price.taxAmount, 71.55);
    assert.equal(price.total, 469.05);
  });

  it('fragile can be a percent of freight', () => {
    const price = computeShipmentPrice({ rateCard: card({ fragileSurcharge: { type: 'percent', value: 10 } }), chargeableWeightKg: 5, fragile: true });
    assert.equal(price.fragileCharge, 15);
  });

  it('applies the minimum freight', () => {
    const price = computeShipmentPrice({ rateCard: card({ minCharge: 75 }), chargeableWeightKg: 0.5 });
    assert.equal(price.freight, 75);
  });

  it('no COD fee for prepaid; express multiplier 1 adds nothing', () => {
    const price = computeShipmentPrice({ rateCard: card({ expressMultiplier: 1 }), chargeableWeightKg: 1, express: true, paymentMethod: 'online' });
    assert.equal(price.codFee, 0);
    assert.equal(price.expressCharge, 0);
  });

  it('refuses a card with no slabs, no card, and over-limit declared values', () => {
    assert.throws(() => computeShipmentPrice({ rateCard: card({ slabs: [] }), chargeableWeightKg: 1 }), /no weight slabs/);
    assert.throws(() => computeShipmentPrice({ rateCard: null, chargeableWeightKg: 1 }), /No rate card/);
    assert.throws(
      () => computeShipmentPrice({ rateCard: card(), chargeableWeightKg: 1, insuranceOpted: true, declaredValue: 200000 }),
      /cannot be insured/,
    );
  });
});

describe('inbound weight re-check', () => {
  it('flags differences beyond the tolerance', () => {
    assert.deepEqual(checkWeightDiscrepancy({ bookedChargeableKg: 2, measuredChargeableKg: 2.5, tolerancePercent: 10 }), { flagged: true, differencePercent: 25 });
    assert.deepEqual(checkWeightDiscrepancy({ bookedChargeableKg: 10, measuredChargeableKg: 10.5, tolerancePercent: 10 }), { flagged: false, differencePercent: 5 });
    assert.equal(checkWeightDiscrepancy({ bookedChargeableKg: 2, measuredChargeableKg: 1, tolerancePercent: 10 }).flagged, true, 'lighter counts too');
  });
});

describe('direct parcel surcharges (POST /deliveries)', () => {
  const settings = {
    enable_parcel_surcharges: '1',
    free_weight_kg: '5',
    per_extra_kg_charge: '10',
    fragile_surcharge_type: 'flat',
    fragile_surcharge_value: '25',
    express_multiplier: '1.5',
    insurance_percent: '1',
    insurance_min: '20',
    insurance_max: '500',
  };

  it('is a no-op while the setting is off (the default)', () => {
    const result = computeDirectParcelSurcharges({
      parcel: { weightKg: 50, fragile: true, express: true, insurance: { opted: true }, declaredValue: 10000 },
      subtotal: 200,
      settings: { ...settings, enable_parcel_surcharges: '0' },
    });
    assert.equal(result.enabled, false);
    assert.equal(result.total, 0);
  });

  it('adds weight, fragile, express and insurance when on', () => {
    const result = computeDirectParcelSurcharges({
      parcel: { weightKg: 7.2, fragile: true, express: true, insurance: { opted: true }, declaredValue: 10000 },
      subtotal: 200,
      settings,
    });
    assert.equal(result.weightCharge, 30); // 3 started kg above 5
    assert.equal(result.fragileCharge, 25);
    assert.equal(result.expressCharge, 100);
    assert.equal(result.insurancePremium, 100);
    assert.equal(result.total, 255);
  });

  it('a parcel with none of the new fields pays nothing extra', () => {
    assert.equal(computeDirectParcelSurcharges({ parcel: { weight: '2kg' }, subtotal: 200, settings }).total, 0);
  });
});
