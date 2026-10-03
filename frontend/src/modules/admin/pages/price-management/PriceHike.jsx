import React, { useCallback, useEffect, useState } from 'react';
import { Plus, Trash2, Loader2, TrendingUp, ChevronRight } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import api from '../../../../shared/api/axiosInstance';
import toast from 'react-hot-toast';

const inputClass =
  'w-full border border-gray-200 rounded-md px-2 py-1 text-xs text-gray-800 bg-white focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 outline-none transition-colors shadow-sm';
const labelClass = 'block text-[10px] font-semibold text-gray-500 mb-1';

const DAYS = [
  { value: 0, label: 'Sun' },
  { value: 1, label: 'Mon' },
  { value: 2, label: 'Tue' },
  { value: 3, label: 'Wed' },
  { value: 4, label: 'Thu' },
  { value: 5, label: 'Fri' },
  { value: 6, label: 'Sat' },
];

const blankHike = () => ({
  id: null,
  label: '',
  days: [],
  start_time: '09:00',
  end_time: '11:00',
  multiplier: 1.5,
  active: false,
  service_location_ids: [],
  zone_ids: [],
});

// The list endpoints answer in a few shapes; take the array wherever it is.
const unwrapList = (response) => {
  const payload = response?.data ?? response;
  const list = payload?.results || payload?.data?.results || payload?.data || payload;
  return Array.isArray(list) ? list : [];
};

const toOption = (item) => ({
  id: String(item?._id || item?.id || ''),
  name: item?.name || item?.service_location_name || item?.zone_name || 'Unnamed',
});

const selectedValues = (event) => Array.from(event.target.selectedOptions).map((option) => option.value);

const PriceHike = () => {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [savingId, setSavingId] = useState(null);
  const [hikes, setHikes] = useState([]);
  const [activeMultiplier, setActiveMultiplier] = useState(1);
  const [cities, setCities] = useState([]);
  const [zones, setZones] = useState([]);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const [res, cityRes, zoneRes] = await Promise.all([
        api.get('/admin/price-hikes'),
        // Scope pickers are a nicety: a failure here must not hide the hikes.
        api.get('/admin/service-locations').catch(() => null),
        api.get('/admin/zones').catch(() => null),
      ]);
      const payload = res.data || res;
      setHikes((Array.isArray(payload.results) ? payload.results : []).map((row) => ({
        ...row,
        service_location_ids: Array.isArray(row.service_location_ids) ? row.service_location_ids : [],
        zone_ids: Array.isArray(row.zone_ids) ? row.zone_ids : [],
      })));
      setCities(unwrapList(cityRes).map(toOption).filter((item) => item.id));
      setZones(unwrapList(zoneRes).map(toOption).filter((item) => item.id));
      setActiveMultiplier(Number(payload.active_multiplier || 1));
    } catch (err) {
      console.error('Fetch price hikes failed:', err);
      toast.error('Could not load price hikes');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const updateLocal = (index, field, value) => {
    setHikes((prev) => prev.map((row, i) => (i === index ? { ...row, [field]: value } : row)));
  };

  const toggleDay = (index, day) => {
    setHikes((prev) =>
      prev.map((row, i) => {
        if (i !== index) return row;
        const days = row.days.includes(day)
          ? row.days.filter((d) => d !== day)
          : [...row.days, day].sort((a, b) => a - b);
        return { ...row, days };
      }),
    );
  };

  const save = async (index) => {
    const row = hikes[index];

    if (row.start_time === row.end_time) {
      toast.error('Start and end time cannot be the same');
      return;
    }
    if (Number(row.multiplier) < 1) {
      toast.error('Multiplier must be at least 1');
      return;
    }

    const payload = {
      label: row.label,
      days: row.days,
      start_time: row.start_time,
      end_time: row.end_time,
      multiplier: Number(row.multiplier),
      active: row.active,
      service_location_ids: row.service_location_ids || [],
      zone_ids: row.zone_ids || [],
    };

    try {
      setSavingId(row.id ?? `new-${index}`);
      if (row.id) {
        await api.patch(`/admin/price-hikes/${row.id}`, payload);
      } else {
        await api.post('/admin/price-hikes', payload);
      }
      toast.success('Price hike saved');
      await load();
    } catch (err) {
      console.error('Save price hike failed:', err);
      toast.error(err?.message || 'Failed to save');
    } finally {
      setSavingId(null);
    }
  };

  const remove = async (index) => {
    const row = hikes[index];

    if (!row.id) {
      setHikes((prev) => prev.filter((_, i) => i !== index));
      return;
    }

    try {
      setSavingId(row.id);
      await api.delete(`/admin/price-hikes/${row.id}`);
      toast.success('Price hike removed');
      await load();
    } catch (err) {
      console.error('Delete price hike failed:', err);
      toast.error('Failed to remove');
    } finally {
      setSavingId(null);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <Loader2 className="w-10 h-10 text-indigo-600 animate-spin" />
      </div>
    );
  }

  const surging = activeMultiplier > 1;

  return (
    <div className="min-h-screen bg-[#F8F9FD] p-3 lg:p-4 font-sans">
      <div className="mb-4 flex flex-col lg:flex-row lg:items-center justify-between border-b border-gray-100 pb-2">
        <div>
          <h1 className="text-xl font-bold text-[#1E293B]">Price Hike</h1>
          <div className="flex items-center gap-1.5 text-[11px] text-gray-400 mt-1 font-medium">
            <span
              className="cursor-pointer hover:text-indigo-600 transition-colors"
              onClick={() => navigate('/admin/pricing/set-price')}
            >
              Pricing
            </span>
            <ChevronRight size={10} />
            <span className="text-slate-800 font-bold uppercase">Surge Windows</span>
          </div>
        </div>

        <div className="flex items-center gap-2 mt-2 lg:mt-0">
          <div
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold ${
              surging ? 'bg-emerald-50 text-emerald-700' : 'bg-gray-100 text-gray-500'
            }`}
          >
            <TrendingUp size={13} />
            {surging ? `Live now — ${activeMultiplier}x` : 'No hike active'}
          </div>
          <button
            onClick={() => setHikes((prev) => [blankHike(), ...prev])}
            className="flex items-center gap-1 bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-semibold px-3 py-1.5 rounded-md transition-colors"
          >
            <Plus size={14} /> Add Slot
          </button>
        </div>
      </div>

      <p className="text-[11px] text-gray-500 mb-3">
        While a slot is active, every vehicle&apos;s base fare, per-km rate and per-minute rate are
        multiplied. Distance and time allowances, taxes and commissions are not changed. Times are
        local to the timezone shown on each slot. Leave cities and zones empty to apply a slot
        everywhere; otherwise it applies to bookings in any selected city or zone. Fares are only
        surged when &quot;Enable surge pricing&quot; is on in Transport Ride settings.
      </p>

      {hikes.length === 0 ? (
        <div className="bg-white border border-gray-100 rounded-lg p-8 text-center">
          <p className="text-sm text-gray-500">No price hike slots yet.</p>
          <p className="text-[11px] text-gray-400 mt-1">
            Add one to raise fares during peak hours.
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {hikes.map((row, index) => {
            const busy = savingId === (row.id ?? `new-${index}`);

            return (
              <div
                key={row.id || `new-${index}`}
                className="bg-white border border-gray-100 rounded-lg p-3 shadow-sm"
              >
                <div className="grid grid-cols-2 lg:grid-cols-6 gap-3 items-end">
                  <div className="col-span-2 lg:col-span-2">
                    <label className={labelClass}>Name</label>
                    <input
                      className={inputClass}
                      value={row.label}
                      placeholder="Evening peak"
                      onChange={(e) => updateLocal(index, 'label', e.target.value)}
                    />
                  </div>

                  <div>
                    <label className={labelClass}>Start</label>
                    <input
                      type="time"
                      className={inputClass}
                      value={row.start_time}
                      onChange={(e) => updateLocal(index, 'start_time', e.target.value)}
                    />
                  </div>

                  <div>
                    <label className={labelClass}>End</label>
                    <input
                      type="time"
                      className={inputClass}
                      value={row.end_time}
                      onChange={(e) => updateLocal(index, 'end_time', e.target.value)}
                    />
                  </div>

                  <div>
                    <label className={labelClass}>Multiplier</label>
                    <input
                      type="number"
                      step="0.1"
                      min="1"
                      className={inputClass}
                      value={row.multiplier}
                      onChange={(e) => updateLocal(index, 'multiplier', e.target.value)}
                    />
                  </div>

                  <div className="flex items-center gap-2 justify-end">
                    <label className="flex items-center gap-1.5 cursor-pointer select-none">
                      <input
                        type="checkbox"
                        checked={row.active}
                        onChange={(e) => updateLocal(index, 'active', e.target.checked)}
                        className="w-4 h-4 accent-indigo-600"
                      />
                      <span className="text-[11px] font-semibold text-gray-600">On</span>
                    </label>
                    <button
                      onClick={() => remove(index)}
                      disabled={busy}
                      className="p-1.5 text-red-500 hover:bg-red-50 rounded-md transition-colors disabled:opacity-40"
                      title="Remove slot"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>

                <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 mt-3">
                  <div>
                    <label className={labelClass}>
                      Cities {row.service_location_ids.length === 0 ? '(all)' : `(${row.service_location_ids.length})`}
                    </label>
                    <select
                      multiple
                      size={4}
                      className={inputClass}
                      value={row.service_location_ids}
                      onChange={(e) => updateLocal(index, 'service_location_ids', selectedValues(e))}
                    >
                      {cities.map((city) => (
                        <option key={city.id} value={city.id}>{city.name}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className={labelClass}>
                      Zones {row.zone_ids.length === 0 ? '(all)' : `(${row.zone_ids.length})`}
                    </label>
                    <select
                      multiple
                      size={4}
                      className={inputClass}
                      value={row.zone_ids}
                      onChange={(e) => updateLocal(index, 'zone_ids', selectedValues(e))}
                    >
                      {zones.map((zone) => (
                        <option key={zone.id} value={zone.id}>{zone.name}</option>
                      ))}
                    </select>
                  </div>
                  {(row.service_location_ids.length > 0 || row.zone_ids.length > 0) && (
                    <button
                      onClick={() => setHikes((prev) => prev.map((item, i) => (
                        i === index ? { ...item, service_location_ids: [], zone_ids: [] } : item
                      )))}
                      className="text-[10px] text-indigo-600 font-semibold text-left"
                    >
                      Clear scope (apply everywhere)
                    </button>
                  )}
                </div>

                <div className="flex flex-wrap items-center gap-1.5 mt-3">
                  <span className="text-[10px] font-semibold text-gray-500 mr-1">Days</span>
                  {DAYS.map((day) => {
                    const on = row.days.includes(day.value);
                    return (
                      <button
                        key={day.value}
                        onClick={() => toggleDay(index, day.value)}
                        className={`px-2 py-0.5 rounded text-[10px] font-semibold border transition-colors ${
                          on
                            ? 'bg-indigo-600 border-indigo-600 text-white'
                            : 'bg-white border-gray-200 text-gray-500 hover:border-indigo-300'
                        }`}
                      >
                        {day.label}
                      </button>
                    );
                  })}
                  <span className="text-[10px] text-gray-400 ml-1">
                    {row.days.length === 0 ? 'every day' : `${row.days.length} selected`}
                  </span>

                  <div className="ml-auto flex items-center gap-2">
                    {row.end_time < row.start_time && (
                      <span className="text-[10px] text-amber-600 font-medium">
                        overnight — ends next day
                      </span>
                    )}
                    <button
                      onClick={() => save(index)}
                      disabled={busy}
                      className="flex items-center gap-1 bg-slate-800 hover:bg-slate-900 text-white text-[11px] font-semibold px-3 py-1 rounded-md transition-colors disabled:opacity-50"
                    >
                      {busy && <Loader2 size={11} className="animate-spin" />}
                      Save
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

export default PriceHike;
