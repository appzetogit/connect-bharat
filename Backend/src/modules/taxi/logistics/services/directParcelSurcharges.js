/// Surcharges on the EXISTING single-driver parcel (POST /deliveries) for
/// the new weight / fragile / express / insurance fields.
///
/// Pure, and a no-op unless `delivery.enable_parcel_surcharges` is '1': a
/// parcel booked by an app that has never heard of these fields, or in a
/// deployment that has not turned them on, is priced exactly as before.
/// Applied to the trip subtotal before service tax, so tax is charged on the
/// surcharges just as on the fare.

const round2 = (value) => Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
const num = (value) => Math.max(0, Number(value) || 0);
const isOn = (value) => ['1', 'true', 'yes', 'on'].includes(String(value ?? '').trim().toLowerCase());

export const computeDirectParcelSurcharges = ({ parcel = {}, subtotal = 0, settings = {} }) => {
  const empty = { enabled: false, total: 0, weightCharge: 0, fragileCharge: 0, expressCharge: 0, insurancePremium: 0 };
  if (!isOn(settings.enable_parcel_surcharges)) return empty;

  const weightKg = num(parcel?.weightKg);
  const extraKg = Math.max(0, Math.ceil(weightKg - num(settings.free_weight_kg) - 1e-9));
  const weightCharge = round2(extraKg * num(settings.per_extra_kg_charge));

  const fragileValue = num(settings.fragile_surcharge_value);
  const fragileCharge = parcel?.fragile
    ? round2(String(settings.fragile_surcharge_type || 'flat') === 'percent' ? (num(subtotal) * fragileValue) / 100 : fragileValue)
    : 0;

  const multiplier = Number(settings.express_multiplier) > 1 ? Number(settings.express_multiplier) : 1;
  const expressCharge = parcel?.express ? round2(num(subtotal) * (multiplier - 1)) : 0;

  let insurancePremium = 0;
  if (parcel?.insurance?.opted && num(parcel?.declaredValue) > 0 && num(settings.insurance_percent) > 0) {
    insurancePremium = Math.max((num(parcel.declaredValue) * num(settings.insurance_percent)) / 100, num(settings.insurance_min));
    if (num(settings.insurance_max) > 0) insurancePremium = Math.min(insurancePremium, num(settings.insurance_max));
    insurancePremium = round2(insurancePremium);
  }

  return {
    enabled: true,
    weightCharge,
    fragileCharge,
    expressCharge,
    insurancePremium,
    total: round2(weightCharge + fragileCharge + expressCharge + insurancePremium),
  };
};
