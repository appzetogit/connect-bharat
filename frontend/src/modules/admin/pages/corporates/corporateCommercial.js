import { useEffect, useState } from 'react';
import { corporateAdminService } from '../../services/corporateAdminService';

/** Admin vehicle types (for tariff rows and role pickers); [] until loaded or on failure. */
export const useAdminVehicleTypes = () => {
  const [vehicles, setVehicles] = useState([]);
  useEffect(() => {
    let alive = true;
    corporateAdminService
      .vehicleTypes()
      .then((data) => { if (alive) setVehicles(Array.isArray(data) ? data : data?.results || []); })
      .catch(() => null);
    return () => { alive = false; };
  }, []);
  return vehicles;
};

/**
 * Corporate v2 commercial settings (billing cycle, company tariff, driver
 * commission override, excess payment methods): form <-> API shape.
 * See docs/plans/corporate-v2.md §1.3.
 */

export const RATE_FIELDS = [
  { key: 'baseFare', label: 'Base fare (₹)' },
  { key: 'baseKm', label: 'Base covers (km)' },
  { key: 'perKm', label: 'Per km (₹)' },
  { key: 'perMinute', label: 'Per minute (₹)' },
  { key: 'minimumFare', label: 'Minimum fare (₹)' },
];

const rateToForm = (rate = {}) => Object.fromEntries(RATE_FIELDS.map(({ key }) => [key, rate?.[key] ?? '']));
const rateToBody = (rate = {}) => Object.fromEntries(RATE_FIELDS.map(({ key }) => [key, Number(rate[key]) || 0]));

export const commercialToForm = (corporate = {}) => ({
  billingCycle: corporate.billingCycle || 'monthly',
  tariff: {
    enabled: Boolean(corporate.tariff?.enabled),
    ...rateToForm(corporate.tariff),
    byVehicleType: (corporate.tariff?.byVehicleType || []).map((row) => ({
      vehicleTypeId: String(row.vehicleTypeId?._id || row.vehicleTypeId || ''),
      ...rateToForm(row),
    })),
    appliesTo: corporate.tariff?.appliesTo?.length ? corporate.tariff.appliesTo : ['ride', 'intercity'],
  },
  driverCommission: {
    enabled: Boolean(corporate.driverCommission?.enabled),
    type: corporate.driverCommission?.type || 'percentage',
    value: corporate.driverCommission?.value ?? '',
  },
  excessPayment: {
    allowedMethods: corporate.excessPayment?.allowedMethods?.length ? corporate.excessPayment.allowedMethods : ['cash', 'online', 'wallet'],
  },
});

export const commercialPayload = (form) => ({
  billingCycle: form.billingCycle,
  tariff: {
    enabled: form.tariff.enabled,
    ...rateToBody(form.tariff),
    byVehicleType: form.tariff.byVehicleType
      .filter((row) => row.vehicleTypeId)
      .map((row) => ({ vehicleTypeId: row.vehicleTypeId, ...rateToBody(row) })),
    appliesTo: form.tariff.appliesTo,
  },
  driverCommission: {
    enabled: form.driverCommission.enabled,
    type: form.driverCommission.type,
    value: Number(form.driverCommission.value) || 0,
  },
  excessPayment: { allowedMethods: form.excessPayment.allowedMethods },
});

/** Returns an error message, or '' when the commercial settings can be saved. */
export const validateCommercial = (form) => {
  if (form.tariff.enabled) {
    if (!(Number(form.tariff.perKm) > 0) && !form.tariff.byVehicleType.length) return 'A company tariff needs a per-km rate (fallback or per vehicle).';
    if (!form.tariff.appliesTo.length) return 'Choose which services the company tariff applies to.';
    const ids = form.tariff.byVehicleType.map((row) => row.vehicleTypeId).filter(Boolean);
    if (new Set(ids).size !== ids.length) return 'Each vehicle type can have only one tariff row.';
  }
  if (form.driverCommission.enabled) {
    const value = Number(form.driverCommission.value);
    if (!(value >= 0) || form.driverCommission.value === '') return 'Enter the driver commission value.';
    if (form.driverCommission.type === 'percentage' && value > 100) return 'A percentage commission cannot exceed 100.';
  }
  if (!form.excessPayment.allowedMethods.length) return 'Allow at least one way for employees to pay their excess share.';
  return '';
};
