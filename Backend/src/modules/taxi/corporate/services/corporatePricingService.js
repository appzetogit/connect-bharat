import { computeCorporateDiscount, round2 } from './corporatePolicyEngine.js';
import {
  checkTravelZone,
  computeCorporateSplit,
  computeCorporateTariffFare,
  estimateTripKm,
  isRoundTripService,
  normalizeExcessMethods,
  serializeOffices,
  tariffAppliesTo,
} from './corporateV2Rules.js';
import { getAllowanceSnapshot } from './corporateAllowanceService.js';
import { findActiveMembership } from './corporateMembership.js';
import { resolveEmployeeRole } from './corporateRoleService.js';
import { getCorporateSettings, isFlagOn } from './corporateSettingsService.js';
import { ApiError } from '../../../../utils/ApiError.js';

/// Company tariff, office boundary and the estimate-time split, shared by
/// booking (validateCorporateBooking), `/rides/estimate` and the travel desk
/// quote, so all three come out at the same numbers.

/// ApiError whose `body` fields are also sent at the top level of the error
/// JSON (errorMiddleware), as the contract asks for `code` / `offices`.
export const corporateApiError = (status, message, body) => {
  const error = new ApiError(status, message, body);
  error.body = body;
  return error;
};

/// The fare a corporate trip is booked at: the company tariff when it is on
/// for this service, else the standard server fare passed in.
export const priceCorporateTrip = ({
  corporate,
  settings,
  serviceType,
  vehicleTypeId,
  distanceMeters,
  durationMinutes,
  intercity = null,
  pricingRule = null,
  standardFare,
  standardFareSource = 'server',
  standardBreakdown = null,
}) => {
  const applies = tariffAppliesTo({
    tariff: corporate?.tariff,
    serviceType,
    masterEnabled: isFlagOn(settings?.tariff_enabled),
  });
  if (!applies) {
    return {
      pricing: 'standard',
      fare: round2(Math.max(0, Number(standardFare) || 0)),
      fareSource: standardFareSource,
      fareBreakdown: standardBreakdown,
    };
  }
  const roundTrip = isRoundTripService(serviceType, intercity?.tripType);
  const breakdown = computeCorporateTariffFare({
    tariff: corporate.tariff,
    vehicleTypeId,
    distanceMeters: (Number(distanceMeters) || 0) * (roundTrip ? 2 : 1),
    durationMinutes: (Number(durationMinutes) || 0) * (roundTrip ? 2 : 1),
    serviceTaxPercent: pricingRule?.service_tax,
  });
  return { pricing: 'company_tariff', fare: breakdown.total, fareSource: 'corporate_tariff', fareBreakdown: breakdown };
};

/// Throws 403 `corporate_outside_boundary` when the company only allows trips
/// around its offices and this one is not. Returns the check either way.
export const assertTravelZone = ({ corporate, settings, pickup, drop }) => {
  const zone = checkTravelZone({
    travelZone: corporate?.travelZone,
    pickup,
    drop,
    enabled: isFlagOn(settings?.travel_zone_enabled),
  });
  if (zone.applies && !zone.withinBoundary) {
    throw corporateApiError(
      403,
      zone.rule === 'either_end'
        ? 'Your company only allows trips that start or end near one of its offices'
        : 'Your company only allows trips within the area around its offices',
      { code: 'corporate_outside_boundary', rule: zone.rule, offices: serializeOffices(corporate.travelZone?.offices) },
    );
  }
  return zone;
};

/// Everything an estimate needs about the rider's corporate membership,
/// loaded once per estimate. `{ error }` when the rider cannot bill a company.
export const loadCorporateEstimateContext = async ({ userId, corporateId = null, pickup, drop, at = new Date() }) => {
  try {
    if (!userId) return { error: 'Sign in to bill a trip to your company' };
    const settings = await getCorporateSettings();
    if (!isFlagOn(settings.booking_enabled)) return { error: 'Corporate billing is not available right now' };
    const membership = await findActiveMembership({ userId, corporateId });
    if (!membership?.employee) return { error: 'You are not registered as an employee of any company' };
    const { employee, corporate } = membership;
    if (!corporate || corporate.status !== 'approved') return { error: 'Your company account is not active for billing' };
    const role = await resolveEmployeeRole(employee);
    const allowance = await getAllowanceSnapshot({ employee, role, settings, at });
    const zone = checkTravelZone({
      travelZone: corporate.travelZone,
      pickup,
      drop,
      enabled: isFlagOn(settings.travel_zone_enabled),
    });
    return { settings, employee, corporate, role, allowance, zone };
  } catch (error) {
    return { error: error.message || 'Corporate billing could not be checked' };
  }
};

/// The `corporate` block of one `/rides/estimate` quote (contract §3.3).
export const buildCorporateEstimateQuote = (context, {
  vehicleTypeId,
  pricingRule = null,
  fare,
  fareSource,
  fareBreakdown,
  distanceMeters,
  durationMinutes,
  serviceType,
  intercity = null,
}) => {
  if (!context || context.error) return { eligible: false, reason: context?.error || 'Not available' };
  const { corporate, settings, allowance, zone } = context;
  const priced = priceCorporateTrip({
    corporate,
    settings,
    serviceType,
    vehicleTypeId,
    distanceMeters,
    durationMinutes,
    intercity,
    pricingRule,
    standardFare: fareSource === 'server' ? fare : null,
    standardFareSource: fareSource,
    standardBreakdown: fareBreakdown,
  });
  const estimatedKm = estimateTripKm({ distanceMeters, serviceType, tripType: intercity?.tripType });
  const split = computeCorporateSplit({
    fare: priced.fare,
    km: estimatedKm,
    remainingKm: allowance.remainingKm,
    allowanceEnabled: allowance.enabled,
  });
  const discount = computeCorporateDiscount({ discount: corporate.discount, serviceType, fare: split.companyAmount });
  const allowedMethods = normalizeExcessMethods(corporate.excessPayment?.allowedMethods);
  return {
    eligible: priced.fare > 0,
    fare: priced.fare > 0 ? priced.fare : null,
    pricing: priced.pricing,
    breakdown: priced.fareBreakdown,
    allowance: {
      enabled: allowance.enabled,
      period: allowance.period,
      periodKey: allowance.periodKey,
      allowanceKm: allowance.allowanceKm,
      remainingKm: allowance.remainingKm,
      remainingKmAtBooking: allowance.remainingKm,
      estimatedKm,
      coveredKm: split.coveredKm,
      excessKm: split.excessKm,
    },
    split: {
      companyAmount: split.companyAmount,
      employeeAmount: split.employeeAmount,
      discountAmount: discount.amount,
      billedAmount: discount.billableAmount,
    },
    employeePaymentRequired: split.employeeAmount > 0,
    allowedMethods,
    withinBoundary: zone.withinBoundary,
  };
};
