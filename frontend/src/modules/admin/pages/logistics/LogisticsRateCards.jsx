import { useCallback, useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import AdminPageHeader from '../../components/ui/AdminPageHeader';
import { logisticsAdminService as service, plain } from '../../services/logisticsAdminService';
import { Button, Card, Empty, Field, Modal } from '../../../hub/components/ui';
import { inputClass, money } from '../../../hub/components/format';
import { useServiceLocations } from './useServiceLocations';

/**
 * Admin: parcel rate cards per city and scope. Slabs are full prices up to
 * a weight; distance bands multiply and add to the freight for intercity
 * and long-distance cards.
 */
const DEFAULT_CARD = {
  name: '',
  scope: 'intracity',
  serviceLocationId: '',
  volumetricDivisor: 5000,
  weightStepKg: 0.5,
  slabs: [
    { upToKg: 0.5, price: 0 },
    { upToKg: 1, price: 0 },
    { upToKg: 2, price: 0 },
    { upToKg: 5, price: 0 },
    { upToKg: 10, price: 0 },
  ],
  extraPerKg: 0,
  distanceBands: [],
  minCharge: 0,
  expressAllowed: true,
  expressMultiplier: 1.5,
  fragileSurcharge: { type: 'flat', value: 0 },
  insurance: { percent: 0, min: 0, max: 0, maxDeclaredValue: 0 },
  codAllowed: true,
  codFee: { type: 'flat', value: 0, min: 0 },
  pickupCharge: 0,
  taxPercent: 18,
  active: true,
};

const NumberInput = ({ value, onChange, ...props }) => (
  <input className={inputClass} value={value ?? ''} onChange={(event) => onChange(event.target.value)} inputMode="decimal" {...props} />
);

const RateCardForm = ({ initial, locations, onClose, onSaved }) => {
  const [card, setCard] = useState(initial);
  const [saving, setSaving] = useState(false);
  const set = (key, value) => setCard((current) => ({ ...current, [key]: value }));
  const setNested = (key, sub, value) => setCard((current) => ({ ...current, [key]: { ...current[key], [sub]: value } }));
  const setRow = (key, index, sub, value) =>
    setCard((current) => ({ ...current, [key]: current[key].map((row, rowIndex) => (rowIndex === index ? { ...row, [sub]: value } : row)) }));

  const save = async () => {
    setSaving(true);
    try {
      const payload = { ...card, serviceLocationId: card.serviceLocationId || null };
      if (card._id) await service.updateRateCard(card._id, payload);
      else await service.createRateCard(payload);
      toast.success('Rate card saved');
      onSaved();
      onClose();
    } catch (error) {
      toast.error(error?.response?.data?.message || error.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal open title={card._id ? 'Edit rate card' : 'New rate card'} onClose={onClose} footer={<Button onClick={save} loading={saving}>Save</Button>}>
      <div className="grid grid-cols-2 gap-2">
        <Field label="Name"><input className={inputClass} value={card.name} onChange={(event) => set('name', event.target.value)} /></Field>
        <Field label="Scope">
          <select className={inputClass} value={card.scope} onChange={(event) => set('scope', event.target.value)}>
            <option value="intracity">Intracity</option>
            <option value="intercity">Intercity</option>
            <option value="long_distance">Long distance</option>
          </select>
        </Field>
        <Field label="City" hint="Blank = fallback for every city">
          <select className={inputClass} value={card.serviceLocationId || ''} onChange={(event) => set('serviceLocationId', event.target.value)}>
            <option value="">All cities</option>
            {locations.map((location) => <option key={location._id || location.id} value={location._id || location.id}>{location.name || location.service_location_name}</option>)}
          </select>
        </Field>
        <Field label="Volumetric divisor"><NumberInput value={card.volumetricDivisor} onChange={(value) => set('volumetricDivisor', value)} /></Field>
      </div>
      <div>
        <div className="text-[12px] font-medium text-slate-600 mb-1">Weight slabs (price for a parcel up to the weight)</div>
        {card.slabs.map((slab, index) => (
          <div key={index} className="grid grid-cols-[1fr_1fr_auto] gap-2 mb-1">
            <NumberInput value={slab.upToKg} onChange={(value) => setRow('slabs', index, 'upToKg', value)} placeholder="up to kg" />
            <NumberInput value={slab.price} onChange={(value) => setRow('slabs', index, 'price', value)} placeholder="price" />
            <Button variant="secondary" onClick={() => set('slabs', card.slabs.filter((_, rowIndex) => rowIndex !== index))}>×</Button>
          </div>
        ))}
        <Button variant="secondary" onClick={() => set('slabs', [...card.slabs, { upToKg: '', price: '' }])}>Add slab</Button>
        <div className="mt-2 w-1/2"><Field label="Per extra kg beyond last slab"><NumberInput value={card.extraPerKg} onChange={(value) => set('extraPerKg', value)} /></Field></div>
      </div>
      {card.scope !== 'intracity' && (
        <div>
          <div className="text-[12px] font-medium text-slate-600 mb-1">Distance bands (freight × multiplier + flat)</div>
          {card.distanceBands.map((band, index) => (
            <div key={index} className="grid grid-cols-[1fr_1fr_1fr_auto] gap-2 mb-1">
              <NumberInput value={band.upToKm} onChange={(value) => setRow('distanceBands', index, 'upToKm', value)} placeholder="up to km" />
              <NumberInput value={band.multiplier} onChange={(value) => setRow('distanceBands', index, 'multiplier', value)} placeholder="×" />
              <NumberInput value={band.flat} onChange={(value) => setRow('distanceBands', index, 'flat', value)} placeholder="+ flat" />
              <Button variant="secondary" onClick={() => set('distanceBands', card.distanceBands.filter((_, rowIndex) => rowIndex !== index))}>×</Button>
            </div>
          ))}
          <Button variant="secondary" onClick={() => set('distanceBands', [...card.distanceBands, { upToKm: '', multiplier: 1, flat: 0 }])}>Add band</Button>
        </div>
      )}
      <div className="grid grid-cols-2 gap-2">
        <Field label="Minimum freight"><NumberInput value={card.minCharge} onChange={(value) => set('minCharge', value)} /></Field>
        <Field label="Express multiplier"><NumberInput value={card.expressMultiplier} onChange={(value) => set('expressMultiplier', value)} /></Field>
        <Field label="Fragile surcharge">
          <div className="flex gap-1">
            <select className={inputClass} value={card.fragileSurcharge.type} onChange={(event) => setNested('fragileSurcharge', 'type', event.target.value)}>
              <option value="flat">flat</option>
              <option value="percent">%</option>
            </select>
            <NumberInput value={card.fragileSurcharge.value} onChange={(value) => setNested('fragileSurcharge', 'value', value)} />
          </div>
        </Field>
        <Field label="Pickup charge"><NumberInput value={card.pickupCharge} onChange={(value) => set('pickupCharge', value)} /></Field>
        <Field label="Insurance % of declared"><NumberInput value={card.insurance.percent} onChange={(value) => setNested('insurance', 'percent', value)} /></Field>
        <Field label="Insurance min / max">
          <div className="flex gap-1">
            <NumberInput value={card.insurance.min} onChange={(value) => setNested('insurance', 'min', value)} />
            <NumberInput value={card.insurance.max} onChange={(value) => setNested('insurance', 'max', value)} />
          </div>
        </Field>
        <Field label="Max insurable value"><NumberInput value={card.insurance.maxDeclaredValue} onChange={(value) => setNested('insurance', 'maxDeclaredValue', value)} /></Field>
        <Field label="COD fee (type, value, min)">
          <div className="flex gap-1">
            <select className={inputClass} value={card.codFee.type} onChange={(event) => setNested('codFee', 'type', event.target.value)}>
              <option value="flat">flat</option>
              <option value="percent">%</option>
            </select>
            <NumberInput value={card.codFee.value} onChange={(value) => setNested('codFee', 'value', value)} />
            <NumberInput value={card.codFee.min} onChange={(value) => setNested('codFee', 'min', value)} />
          </div>
        </Field>
        <Field label="Tax %"><NumberInput value={card.taxPercent} onChange={(value) => set('taxPercent', value)} /></Field>
      </div>
      <div className="flex flex-wrap gap-4 text-[13px]">
        {[['expressAllowed', 'Express available'], ['codAllowed', 'COD available'], ['active', 'Active']].map(([key, label]) => (
          <label key={key} className="flex items-center gap-2"><input type="checkbox" checked={Boolean(card[key])} onChange={(event) => set(key, event.target.checked)} /> {label}</label>
        ))}
      </div>
    </Modal>
  );
};

const LogisticsRateCards = () => {
  const [cards, setCards] = useState([]);
  const [editing, setEditing] = useState(null);
  const locations = useServiceLocations();
  const cityName = (id) => {
    const location = locations.find((item) => String(item._id || item.id) === String(id));
    return location ? location.name || location.service_location_name : id ? 'Unknown city' : 'All cities';
  };

  const load = useCallback(() => {
    service.rateCards().then((data) => setCards(plain(data?.results || []))).catch((error) => toast.error(error.message));
  }, []);
  useEffect(load, [load]);

  const remove = async (card) => {
    if (!window.confirm('Delete this rate card?')) return;
    await service.deleteRateCard(card._id).catch((error) => toast.error(error.message));
    load();
  };

  return (
    <div className="p-6 lg:p-8 space-y-5">
      <AdminPageHeader module="Parcel network" page="Rate cards" title="Parcel rate cards" right={<Button onClick={() => setEditing(plain(DEFAULT_CARD))}>New rate card</Button>} />
      <Card>
        {cards.length ? (
          <div className="overflow-x-auto -mx-4">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="text-left text-[11px] uppercase text-slate-400 border-b border-slate-100">
                  {['Name', 'Scope', 'City', 'Slabs', 'Express', 'Tax', 'Active', ''].map((label) => <th key={label} className="px-4 py-2 font-medium">{label}</th>)}
                </tr>
              </thead>
              <tbody>
                {cards.map((card) => (
                  <tr key={card._id} className="border-b border-slate-50">
                    <td className="px-4 py-2">{card.name || '—'}</td>
                    <td className="px-4 py-2">{card.scope.replace('_', ' ')}</td>
                    <td className="px-4 py-2">{cityName(card.serviceLocationId)}</td>
                    <td className="px-4 py-2 text-slate-500">{card.slabs.map((slab) => `${slab.upToKg}kg ${money(slab.price)}`).join(' · ')}</td>
                    <td className="px-4 py-2">×{card.expressMultiplier}</td>
                    <td className="px-4 py-2">{card.taxPercent}%</td>
                    <td className="px-4 py-2">{card.active ? 'yes' : 'no'}</td>
                    <td className="px-4 py-2 text-right whitespace-nowrap">
                      <Button variant="secondary" onClick={() => setEditing({ ...plain(DEFAULT_CARD), ...card, serviceLocationId: card.serviceLocationId || '' })}>Edit</Button>{' '}
                      <Button variant="danger" onClick={() => remove(card)}>Delete</Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>No rate cards. Hub shipments cannot be quoted until one exists for the scope.</Empty>
        )}
      </Card>
      {editing && <RateCardForm initial={editing} locations={locations} onClose={() => setEditing(null)} onSaved={load} />}
    </div>
  );
};

export default LogisticsRateCards;
