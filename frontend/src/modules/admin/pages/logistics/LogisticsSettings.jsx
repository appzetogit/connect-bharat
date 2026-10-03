import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import AdminPageHeader from '../../components/ui/AdminPageHeader';
import { logisticsAdminService as service, plain } from '../../services/logisticsAdminService';
import { Button, Card, Field } from '../../../hub/components/ui';
import { inputClass } from '../../../hub/components/format';

/**
 * Admin: SLA and operating settings for the hub network, plus the opt-in
 * surcharges on the existing single-driver parcel (POST /deliveries).
 */
const LOGISTICS_FIELDS = [
  ['intracity_fulfilment', 'Same-city parcels go', 'select:direct,hub'],
  ['intracity_max_km', 'Intracity max km'],
  ['intercity_max_km', 'Intercity max km (beyond = long distance)'],
  ['hub_search_radius_km', 'Hub search radius km'],
  ['sla_hours_intracity', 'SLA hours · intracity'],
  ['sla_hours_intercity', 'SLA hours · intercity'],
  ['sla_hours_long_distance', 'SLA hours · long distance'],
  ['express_sla_factor', 'Express SLA factor (0.5 = half)'],
  ['max_delivery_attempts', 'Max delivery attempts'],
  ['auto_rto_on_max_attempts', 'Auto RTO after max attempts', 'flag'],
  ['rto_on_refusal', 'RTO immediately on refusal', 'flag'],
  ['require_delivery_otp', 'Require receiver OTP', 'flag'],
  ['delivery_otp_max_attempts', 'OTP max wrong attempts'],
  ['weight_tolerance_percent', 'Inbound weight tolerance %'],
  ['require_manifest_seal', 'Seal manifests before dispatch', 'flag'],
  ['pickup_lead_minutes', 'Pickup lead time (min)'],
  ['pickup_booking_days_ahead', 'Pickup bookable days ahead'],
  ['leg_fallback_fare', 'Fallback fare for a driver leg'],
  ['leg_vehicle_type_id', 'Default vehicle type id for legs'],
  ['tracking_base_url', 'Tracking page URL (printed in QR)'],
];

const DELIVERY_FIELDS = [
  ['enable_parcel_surcharges', 'Charge parcel surcharges on direct deliveries', 'flag'],
  ['free_weight_kg', 'Free weight kg'],
  ['per_extra_kg_charge', 'Per extra kg'],
  ['fragile_surcharge_type', 'Fragile surcharge type', 'select:flat,percent'],
  ['fragile_surcharge_value', 'Fragile surcharge value'],
  ['express_multiplier', 'Express multiplier'],
  ['insurance_percent', 'Insurance % of declared value'],
  ['insurance_min', 'Insurance min'],
  ['insurance_max', 'Insurance max'],
];

const Section = ({ title, fields, values, onChange }) => (
  <Card title={title}>
    <div className="grid md:grid-cols-3 gap-3">
      {fields.map(([key, label, kind]) => (
        <Field key={key} label={label}>
          {kind === 'flag' ? (
            <select className={inputClass} value={String(values[key] ?? '0')} onChange={(event) => onChange(key, event.target.value)}>
              <option value="1">On</option>
              <option value="0">Off</option>
            </select>
          ) : kind?.startsWith('select:') ? (
            <select className={inputClass} value={values[key] ?? ''} onChange={(event) => onChange(key, event.target.value)}>
              {kind.slice(7).split(',').map((option) => <option key={option} value={option}>{option}</option>)}
            </select>
          ) : (
            <input className={inputClass} value={values[key] ?? ''} onChange={(event) => onChange(key, event.target.value)} />
          )}
        </Field>
      ))}
    </div>
  </Card>
);

const LogisticsSettings = () => {
  const [logistics, setLogistics] = useState(null);
  const [delivery, setDelivery] = useState(null);
  const [slots, setSlots] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    service
      .settings()
      .then((data) => {
        const value = plain(data);
        setLogistics(value.logistics);
        setDelivery(value.delivery);
        setSlots((value.logistics.pickup_slots || []).join('\n'));
      })
      .catch((error) => toast.error(error.message));
  }, []);

  if (!logistics) return <div className="p-8 text-slate-400 text-sm">Loading…</div>;

  const save = async () => {
    setSaving(true);
    try {
      await service.updateSettings({
        logistics: { ...logistics, pickup_slots: slots.split('\n').map((line) => line.trim()).filter(Boolean) },
        delivery,
      });
      toast.success('Settings saved');
    } catch (error) {
      toast.error(error?.response?.data?.message || error.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="p-6 lg:p-8 space-y-5">
      <AdminPageHeader module="Parcel network" page="Settings" title="Parcel network settings" right={<Button onClick={save} loading={saving}>Save</Button>} />
      <Section title="Hub network & SLA" fields={LOGISTICS_FIELDS} values={logistics} onChange={(key, value) => setLogistics({ ...logistics, [key]: value })} />
      <Card title="Pickup / delivery slots (one per line, HH:MM-HH:MM local time)">
        <textarea className={`${inputClass} font-mono h-32`} value={slots} onChange={(event) => setSlots(event.target.value)} />
      </Card>
      <Section title="Direct parcel surcharges (POST /deliveries)" fields={DELIVERY_FIELDS} values={delivery} onChange={(key, value) => setDelivery({ ...delivery, [key]: value })} />
    </div>
  );
};

export default LogisticsSettings;
