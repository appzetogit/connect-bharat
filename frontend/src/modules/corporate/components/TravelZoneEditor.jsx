import { useState } from 'react';
import { MapPin, Plus, Trash2 } from 'lucide-react';
import { Button, Field, inputClass } from './ui';
import { LocationInput, OfficesMap } from './maps';
import { MAPS_AVAILABLE, travelZoneToForm } from './helpers';

/**
 * Office boundary editor, shared by the corporate panel (Travel zone page) and
 * the admin corporate create / detail pages. Controlled: works on the form
 * shape from `travelZoneToForm` (helpers.js) and hands it back through
 * onChange; callers send `travelZoneToBody(form)` to the API.
 */

const NEW_OFFICE = { name: '', address: '', lat: '', lng: '', radiusKm: 5 };

export default function TravelZoneEditor({ value, onChange, readOnly = false }) {
  const [selected, setSelected] = useState(0);
  const form = value || travelZoneToForm();
  const set = (patch) => onChange({ ...form, ...patch });
  const setOffice = (index, patch) => set({ offices: form.offices.map((office, i) => (i === index ? { ...office, ...patch } : office)) });
  const boundary = form.mode === 'office_boundary';

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Field label="Where can employees travel?">
          <div className="space-y-2 text-sm pt-1">
            <label className="flex items-start gap-2">
              <input type="radio" disabled={readOnly} checked={!boundary} onChange={() => set({ mode: 'free_roaming' })} className="mt-0.5" />
              <span><span className="font-medium">Free roaming</span><span className="block text-xs text-gray-500">Company-billed trips can start and end anywhere.</span></span>
            </label>
            <label className="flex items-start gap-2">
              <input type="radio" disabled={readOnly} checked={boundary} onChange={() => set({ mode: 'office_boundary' })} className="mt-0.5" />
              <span><span className="font-medium">Within our office boundary</span><span className="block text-xs text-gray-500">Only trips near one of the offices below.</span></span>
            </label>
          </div>
        </Field>
        {boundary && (
          <Field label="Boundary rule">
            <div className="space-y-2 text-sm pt-1">
              <label className="flex items-start gap-2">
                <input type="radio" disabled={readOnly} checked={form.rule === 'both_ends'} onChange={() => set({ rule: 'both_ends' })} className="mt-0.5" />
                <span><span className="font-medium">Both ends</span><span className="block text-xs text-gray-500">Pickup and drop must each be inside an office circle.</span></span>
              </label>
              <label className="flex items-start gap-2">
                <input type="radio" disabled={readOnly} checked={form.rule === 'either_end'} onChange={() => set({ rule: 'either_end' })} className="mt-0.5" />
                <span><span className="font-medium">Either end</span><span className="block text-xs text-gray-500">At least the pickup or the drop is inside one.</span></span>
              </label>
            </div>
          </Field>
        )}
      </div>

      {boundary && (
        <>
          {MAPS_AVAILABLE && (
            <div>
              <OfficesMap offices={form.offices} selectedIndex={selected} onMapClick={readOnly || !form.offices[selected] ? undefined : (point) => setOffice(selected, point)} />
              {!readOnly && form.offices[selected] && <p className="text-xs text-gray-400 mt-1">Click the map to move office {selected + 1}.</p>}
            </div>
          )}
          <div className="space-y-3">
            {form.offices.map((office, index) => (
              <div
                key={office._id || index}
                className={`border rounded-lg p-3 space-y-3 ${index === selected ? 'border-gray-900' : 'border-gray-200'}`}
                onFocusCapture={() => setSelected(index)}
                onClick={() => setSelected(index)}
              >
                <div className="flex items-center justify-between gap-2">
                  <p className="text-sm font-semibold text-gray-900 flex items-center gap-1.5"><MapPin size={14} /> Office {index + 1}</p>
                  {!readOnly && (
                    <button
                      type="button"
                      className="text-red-600 text-xs inline-flex items-center gap-1"
                      onClick={(event) => {
                        event.stopPropagation();
                        set({ offices: form.offices.filter((_, i) => i !== index) });
                        setSelected(0);
                      }}
                    >
                      <Trash2 size={12} /> Remove
                    </button>
                  )}
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <Field label="Name"><input className={inputClass} disabled={readOnly} value={office.name} onChange={(e) => setOffice(index, { name: e.target.value })} placeholder="Head office" /></Field>
                  <Field label="Radius (km)"><input className={inputClass} disabled={readOnly} type="number" min="0.1" step="0.1" value={office.radiusKm} onChange={(e) => setOffice(index, { radiusKm: e.target.value })} /></Field>
                </div>
                <LocationInput
                  label="Location"
                  disabled={readOnly}
                  value={{ address: office.address, lat: office.lat, lng: office.lng }}
                  onChange={(location) => setOffice(index, location)}
                  placeholder="Search the office address"
                />
              </div>
            ))}
            {!readOnly && (
              <Button variant="secondary" onClick={() => { set({ offices: [...form.offices, { ...NEW_OFFICE }] }); setSelected(form.offices.length); }}>
                <Plus size={14} /> Add office
              </Button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
