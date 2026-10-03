import { Plus, Trash2 } from 'lucide-react';
import { Field, SERVICES, inputClass } from './corporateUi';
import { RATE_FIELDS } from './corporateCommercial';
import { PAYMENT_METHOD_OPTIONS } from '../../../corporate/components/helpers';

/**
 * Billing cycle, company tariff, driver commission override and excess
 * payment methods. Controlled, on the `commercialToForm` shape. Shared by
 * the create and detail pages.
 */

const toggle = (list, value) => (list.includes(value) ? list.filter((item) => item !== value) : [...list, value]);

const Section = ({ title, hint, children }) => (
  <div className="border border-gray-200 rounded-lg p-4 space-y-3">
    <div>
      <h3 className="text-sm font-semibold text-gray-900">{title}</h3>
      {hint && <p className="text-xs text-gray-500 mt-0.5">{hint}</p>}
    </div>
    {children}
  </div>
);

const RateInputs = ({ rate, onChange }) => (
  <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
    {RATE_FIELDS.map(({ key, label }) => (
      <Field key={key} label={label}>
        <input type="number" min="0" step="0.01" className={inputClass} value={rate[key]} onChange={(e) => onChange({ ...rate, [key]: e.target.value })} />
      </Field>
    ))}
  </div>
);

export default function CommercialFields({ value, onChange, vehicleTypes = [] }) {
  const set = (patch) => onChange({ ...value, ...patch });
  const tariff = value.tariff;
  const setTariff = (patch) => set({ tariff: { ...tariff, ...patch } });
  const commission = value.driverCommission;
  const setCommission = (patch) => set({ driverCommission: { ...commission, ...patch } });
  const setRow = (index, row) => setTariff({ byVehicleType: tariff.byVehicleType.map((item, i) => (i === index ? row : item)) });
  const usedIds = tariff.byVehicleType.map((row) => row.vehicleTypeId);
  const vehicleId = (vehicle) => String(vehicle._id || vehicle.id);

  return (
    <div className="space-y-4">
      <Section title="Billing cycle" hint="Weekly invoices are raised every Monday (IST) for the previous week; monthly on the 1st for the previous month.">
        <div className="flex gap-4 text-sm">
          {[['monthly', 'Monthly'], ['weekly', 'Weekly']].map(([key, label]) => (
            <label key={key} className="flex items-center gap-1.5">
              <input type="radio" checked={value.billingCycle === key} onChange={() => set({ billingCycle: key })} /> {label}
            </label>
          ))}
        </div>
      </Section>

      <Section title="Company tariff" hint="Off: normal Set Price fares. On: this company's trips are priced on this rate card, which is also what driver earnings are computed from. GST stays at the Set Price rate.">
        <label className="flex items-center gap-2 text-sm font-medium">
          <input type="checkbox" checked={tariff.enabled} onChange={(e) => setTariff({ enabled: e.target.checked })} /> Use a company tariff
        </label>
        {tariff.enabled && (
          <>
            <Field label="Applies to">
              <div className="flex flex-wrap gap-3 text-sm pt-1">
                {SERVICES.map((service) => (
                  <label key={service.value} className="flex items-center gap-1.5">
                    <input type="checkbox" checked={tariff.appliesTo.includes(service.value)} onChange={() => setTariff({ appliesTo: toggle(tariff.appliesTo, service.value) })} /> {service.label}
                  </label>
                ))}
              </div>
            </Field>
            <div>
              <p className="text-xs font-semibold text-gray-700 mb-2">Fallback rate (any vehicle type not listed below)</p>
              <RateInputs rate={tariff} onChange={(rate) => setTariff(rate)} />
            </div>
            <div className="space-y-3">
              <p className="text-xs font-semibold text-gray-700">Per vehicle type</p>
              {tariff.byVehicleType.map((row, index) => (
                <div key={index} className="bg-gray-50 rounded-lg p-3 space-y-2">
                  <div className="flex items-end gap-2">
                    <div className="flex-1">
                      <Field label="Vehicle type">
                        <select className={inputClass} value={row.vehicleTypeId} onChange={(e) => setRow(index, { ...row, vehicleTypeId: e.target.value })}>
                          <option value="">Choose</option>
                          {vehicleTypes
                            .filter((vehicle) => vehicleId(vehicle) === row.vehicleTypeId || !usedIds.includes(vehicleId(vehicle)))
                            .map((vehicle) => <option key={vehicleId(vehicle)} value={vehicleId(vehicle)}>{vehicle.name}{vehicle.transport_type ? ` (${vehicle.transport_type})` : ''}</option>)}
                        </select>
                      </Field>
                    </div>
                    <button type="button" className="text-red-600 text-xs inline-flex items-center gap-1 pb-2" onClick={() => setTariff({ byVehicleType: tariff.byVehicleType.filter((_, i) => i !== index) })}>
                      <Trash2 size={12} /> Remove
                    </button>
                  </div>
                  <RateInputs rate={row} onChange={(rate) => setRow(index, rate)} />
                </div>
              ))}
              <button
                type="button"
                onClick={() => setTariff({ byVehicleType: [...tariff.byVehicleType, { vehicleTypeId: '', baseFare: '', baseKm: '', perKm: '', perMinute: '', minimumFare: '' }] })}
                className="inline-flex items-center gap-1 text-sm font-semibold border border-gray-200 rounded-lg px-3 py-2"
              >
                <Plus size={14} /> Add vehicle rate
              </button>
            </div>
          </>
        )}
      </Section>

      <Section title="Driver commission" hint="What the platform keeps on this company's trips, computed on the full fare. Off: the Set Price commission.">
        <label className="flex items-center gap-2 text-sm font-medium">
          <input type="checkbox" checked={commission.enabled} onChange={(e) => setCommission({ enabled: e.target.checked })} /> Override commission
        </label>
        {commission.enabled && (
          <div className="grid grid-cols-2 gap-3 max-w-md">
            <Field label="Type">
              <select className={inputClass} value={commission.type} onChange={(e) => setCommission({ type: e.target.value })}>
                <option value="percentage">Percentage of fare</option>
                <option value="fixed">Fixed per trip (₹)</option>
              </select>
            </Field>
            <Field label={commission.type === 'fixed' ? 'Amount (₹)' : 'Percent (%)'}>
              <input type="number" min="0" step="0.01" className={inputClass} value={commission.value} onChange={(e) => setCommission({ value: e.target.value })} />
            </Field>
          </div>
        )}
      </Section>

      <Section title="Excess km payment" hint="How employees may pay their share of a trip beyond their role's km allowance.">
        <div className="flex flex-wrap gap-4 text-sm">
          {PAYMENT_METHOD_OPTIONS.map((option) => (
            <label key={option.value} className="flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={value.excessPayment.allowedMethods.includes(option.value)}
                onChange={() => set({ excessPayment: { allowedMethods: toggle(value.excessPayment.allowedMethods, option.value) } })}
              />
              {option.label}
            </label>
          ))}
        </div>
      </Section>
    </div>
  );
}
