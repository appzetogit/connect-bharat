import { buildOutstationInvoiceLines } from '../outstation/services/outstationFare.js';
/**
 * The itemised part of a trip invoice, derived from the ride alone.
 *
 * Pure (no models, no env) so the arithmetic is unit tested. Used by
 * `invoiceService.js` for both the PDF and the JSON the apps render natively.
 *
 * Source of truth is `ride.pricingSnapshot.fare_breakdown`, the quote the ride
 * was booked at (see fareEngineService.computeFareBreakdown). Charges added
 * after booking - waiting, the rider platform fee - and the promo discount
 * come from their own ride fields. Rides booked before the breakdown existed
 * have none and get today's single "Trip Fare" line.
 *
 * The lines always add up to `ride.fare`, the amount actually charged. A bid,
 * a whole-rupee rounding or a later fare change can move the total away from
 * the quote; rather than print lines that don't sum, the difference is shown
 * as an explicit "Fare adjustment" line.
 */

const roundMoney = (value) => Math.round((Number(value) || 0) * 100) / 100;
const positive = (value) => {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
};
const trimNumber = (value, digits = 2) => {
  const number = Number(value) || 0;
  return Number(number.toFixed(digits)).toString();
};

const line = (key, label, amount, kind = 'charge') => ({ key, label, amount: roundMoney(amount), kind });

export const buildInvoiceLineItems = (ride = {}) => {
  const total = roundMoney(ride.fare);

  // Outstation trips carry their own itemisation: allowances, extra km from the
  // final fare adjustment, tolls, and the advance already paid. The renderer
  // prints the total itself, so that row is dropped here.
  const outstationLines = buildOutstationInvoiceLines(ride);
  const isItemisedOutstation = outstationLines.length > 0
    && (ride.pricingSnapshot?.fare_breakdown?.tariff === 'outstation' || ride.fareAdjustment?.applied);
  if (isItemisedOutstation) {
    const items = outstationLines
      .filter((row) => row.label !== 'Total fare')
      .map((row, index) => line(`outstation_${index}`, row.label, row.amount, row.amount < 0 ? 'discount' : 'charge'));
    return { itemised: true, items, total };
  }

  const snapshot = ride.pricingSnapshot || {};
  const breakdown = snapshot.fare_breakdown && typeof snapshot.fare_breakdown === 'object'
    ? snapshot.fare_breakdown
    : null;

  if (!breakdown) {
    return { itemised: false, items: [line('trip_fare', 'Trip Fare', total)], total };
  }

  const items = [];

  if (breakdown.tariff === 'package') {
    items.push(line('package_fare', 'Package fare', breakdown.baseFare));
    const multiplier = Number(breakdown.roundTripMultiplier) || 1;
    if (multiplier > 1) {
      items.push(line('round_trip', `Round trip (x${trimNumber(multiplier)})`, positive(breakdown.subtotal) - positive(breakdown.baseFare)));
    }
  } else {
    items.push(line('base_fare', 'Base fare', breakdown.baseFare));

    if (positive(breakdown.distanceFare)) {
      const km = positive(breakdown.distanceKm);
      const extraKm = Math.max(0, km - positive(breakdown.baseDistanceKm));
      const label = extraKm > 0 && positive(breakdown.pricePerKm)
        ? `Distance (${trimNumber(extraKm, 1)} km)`
        : 'Distance';
      items.push(line('distance_fare', label, breakdown.distanceFare));
    }
    if (positive(breakdown.timeFare)) {
      const minutes = positive(breakdown.durationMinutes);
      items.push(line('time_fare', minutes ? `Time (${Math.round(minutes)} min)` : 'Time', breakdown.timeFare));
    }
    if (positive(breakdown.surgeAmount)) {
      items.push(line('surge', `Surge (x${trimNumber(breakdown.surgeMultiplier)})`, breakdown.surgeAmount));
    }
    if (positive(breakdown.nightCharge)) {
      items.push(line('night_charge', 'Night charge', breakdown.nightCharge));
    }
    if (positive(breakdown.minimumFareAdjustment)) {
      items.push(line('minimum_fare_topup', 'Minimum fare top-up', breakdown.minimumFareAdjustment));
    }
  }

  if (positive(breakdown.tax)) {
    const percent = positive(breakdown.serviceTaxPercent);
    items.push(line('tax', percent ? `Tax (${trimNumber(percent)}%)` : 'Tax', breakdown.tax, 'tax'));
  }

  if (positive(ride.waitingCharge)) {
    const minutes = positive(ride.waitingMinutes);
    items.push(line('waiting_charge', minutes ? `Waiting (${Math.round(minutes)} min)` : 'Waiting charge', ride.waitingCharge));
  }

  if (positive(snapshot.rider_platform_fee)) {
    items.push(line('platform_fee', 'Platform fee', snapshot.rider_platform_fee));
  }

  const promoDiscount = positive(ride.promo?.discount_amount);
  if (promoDiscount) {
    const code = String(ride.promo?.code || '').trim();
    items.push(line('promo_discount', code ? `Promo discount (${code})` : 'Promo discount', -promoDiscount, 'discount'));
  }

  const sum = roundMoney(items.reduce((acc, item) => acc + item.amount, 0));
  const difference = roundMoney(total - sum);
  if (Math.abs(difference) >= 0.01) {
    items.push(line('fare_adjustment', 'Fare adjustment', difference, 'adjustment'));
  }

  return { itemised: true, items, total };
};

/// Outstation details worth printing, or null for a city ride.
export const buildIntercityDetails = (ride = {}) => {
  const intercity = ride.intercity || {};
  const isIntercity = ride.serviceType === 'intercity' || Boolean(intercity.fromCity || intercity.toCity);
  if (!isIntercity) return null;

  const tripType = String(intercity.tripType || '').trim();
  return {
    fromCity: String(intercity.fromCity || '').trim(),
    toCity: String(intercity.toCity || '').trim(),
    tripType,
    tripTypeLabel: /round/i.test(tripType) ? 'Round trip' : tripType ? 'One way' : '',
    travelDate: String(intercity.travelDate || '').trim(),
    passengers: Number(intercity.passengers || 0) || null,
    distanceKm: Number(intercity.distance || 0) || null,
    vehicleName: String(intercity.vehicleName || '').trim(),
    packageName: String(intercity.packageTypeName || '').trim(),
    bookingId: String(intercity.bookingId || '').trim(),
  };
};

/// Parcel details worth printing, or null when the ride isn't a delivery.
export const buildParcelDetails = (ride = {}) => {
  const parcel = (ride.deliveryId && typeof ride.deliveryId === 'object' && ride.deliveryId.parcel) || ride.parcel || null;
  if (ride.serviceType !== 'parcel' && !parcel?.category && !parcel?.receiverName) return null;
  const source = parcel || {};

  return {
    category: String(source.category || source.deliveryCategory || '').trim(),
    weight: String(source.weight || '').trim(),
    description: String(source.description || '').trim(),
    senderName: String(source.senderName || '').trim(),
    receiverName: String(source.receiverName || '').trim(),
    deliveryScope: String(source.deliveryScope || '').trim() || (source.isOutstation ? 'outstation' : ''),
    deliveredAt: source.deliveryProof?.at || null,
  };
};
