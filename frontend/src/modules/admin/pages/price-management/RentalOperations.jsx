import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Car, Loader2, RefreshCw, Settings, ShieldCheck, Timer, Wrench } from 'lucide-react';
import toast from 'react-hot-toast';
import { adminService } from '../../services/adminService';

/// Rental operations: vehicle units, security deposits, extensions, damage
/// reports and the rental switches. Backed by the rental module endpoints
/// (docs/api/rental.md).

const inputClass =
  'w-full border border-slate-200 rounded-lg px-3 py-2 text-sm text-slate-800 font-semibold bg-white focus:border-amber-400 focus:ring-1 focus:ring-amber-400 outline-none';
const labelClass = 'block text-[11px] font-bold text-slate-500 mb-1 uppercase tracking-wide';
const buttonClass =
  'inline-flex items-center gap-2 rounded-lg px-3 py-2 text-xs font-bold transition-colors disabled:opacity-50';

const TABS = [
  { key: 'units', label: 'Vehicle Units', icon: Car },
  { key: 'deposits', label: 'Deposits', icon: ShieldCheck },
  { key: 'extensions', label: 'Extensions', icon: Timer },
  { key: 'damage', label: 'Damage Reports', icon: Wrench },
  { key: 'settings', label: 'Settings', icon: Settings },
];

/// The axios wrapper returns a compatibility view; the payload can sit at
/// res.data, res.data.data or res itself depending on the endpoint.
const pick = (res, key) => res?.data?.[key] ?? res?.data?.data?.[key] ?? res?.[key];
const listOf = (res) => {
  const value = pick(res, 'results');
  return Array.isArray(value) ? value : [];
};
const errorText = (error, fallback) => error?.response?.data?.message || error?.message || fallback;
const money = (value) => `Rs ${Number(value || 0).toLocaleString('en-IN')}`;
const when = (value) => (value ? new Date(value).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : '-');

const StatusPill = ({ value }) => {
  const tone = {
    available: 'bg-emerald-50 text-emerald-700',
    held: 'bg-amber-50 text-amber-700',
    pending: 'bg-slate-100 text-slate-600',
    requested: 'bg-amber-50 text-amber-700',
    approved: 'bg-emerald-50 text-emerald-700',
    paid: 'bg-emerald-50 text-emerald-700',
    released: 'bg-emerald-50 text-emerald-700',
    partially_released: 'bg-sky-50 text-sky-700',
    forfeited: 'bg-rose-50 text-rose-700',
    rejected: 'bg-rose-50 text-rose-700',
    booked: 'bg-sky-50 text-sky-700',
    maintenance: 'bg-orange-50 text-orange-700',
    inactive: 'bg-slate-100 text-slate-500',
    open: 'bg-amber-50 text-amber-700',
    assessed: 'bg-sky-50 text-sky-700',
    charged: 'bg-rose-50 text-rose-700',
    waived: 'bg-slate-100 text-slate-600',
    disputed: 'bg-purple-50 text-purple-700',
  }[value] || 'bg-slate-100 text-slate-600';
  return <span className={`rounded-full px-2.5 py-1 text-[11px] font-bold ${tone}`}>{String(value || '-').replace(/_/g, ' ')}</span>;
};

const Table = ({ columns, rows, empty }) => (
  <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
    <table className="min-w-full text-sm">
      <thead className="bg-slate-50 text-left text-[11px] font-bold uppercase tracking-wide text-slate-500">
        <tr>{columns.map((column) => <th key={column} className="px-4 py-3">{column}</th>)}</tr>
      </thead>
      <tbody className="divide-y divide-slate-100">
        {rows.length ? rows : (
          <tr><td colSpan={columns.length} className="px-4 py-8 text-center text-slate-400">{empty}</td></tr>
        )}
      </tbody>
    </table>
  </div>
);

// --- units --------------------------------------------------------------------

const EMPTY_UNIT = { rentalVehicleTypeId: '', registrationNumber: '', serviceStoreId: '', status: 'available', odometer: 0, fuel: '', color: '', notes: '' };

const UnitsTab = () => {
  const [units, setUnits] = useState([]);
  const [vehicleTypes, setVehicleTypes] = useState([]);
  const [stores, setStores] = useState([]);
  const [form, setForm] = useState(EMPTY_UNIT);
  const [editingId, setEditingId] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [availability, setAvailability] = useState({ vehicleTypeId: '', from: '', to: '', result: null });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [unitRes, typeRes, storeRes] = await Promise.all([
        adminService.getRentalVehicleUnits(),
        adminService.getRentalVehicleTypes(),
        adminService.getServiceStores ? adminService.getServiceStores() : Promise.resolve(null),
      ]);
      setUnits(listOf(unitRes));
      setVehicleTypes(listOf(typeRes));
      const storeList = listOf(storeRes);
      setStores(storeList.length ? storeList : pick(storeRes, 'stores') || []);
    } catch (error) {
      toast.error(errorText(error, 'Could not load vehicle units'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const save = async () => {
    if (!form.rentalVehicleTypeId || !form.registrationNumber.trim()) {
      toast.error('Vehicle type and registration number are required');
      return;
    }
    setSaving(true);
    try {
      const payload = { ...form, serviceStoreId: form.serviceStoreId || null, odometer: Number(form.odometer || 0) };
      if (editingId) await adminService.updateRentalVehicleUnit(editingId, payload);
      else await adminService.createRentalVehicleUnit(payload);
      toast.success(editingId ? 'Unit updated' : 'Unit added');
      setForm(EMPTY_UNIT);
      setEditingId('');
      load();
    } catch (error) {
      toast.error(errorText(error, 'Could not save unit'));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (unit) => {
    if (!window.confirm(`Delete ${unit.registrationNumber}?`)) return;
    try {
      await adminService.deleteRentalVehicleUnit(unit.id);
      toast.success('Unit deleted');
      load();
    } catch (error) {
      toast.error(errorText(error, 'Could not delete unit'));
    }
  };

  const checkAvailability = async () => {
    if (!availability.vehicleTypeId || !availability.from || !availability.to) {
      toast.error('Pick a vehicle type and a time window');
      return;
    }
    try {
      const res = await adminService.getRentalAvailability(availability.vehicleTypeId, {
        from: new Date(availability.from).toISOString(),
        to: new Date(availability.to).toISOString(),
      });
      setAvailability((current) => ({ ...current, result: res?.data?.data || res?.data || res }));
    } catch (error) {
      toast.error(errorText(error, 'Could not check availability'));
    }
  };

  const set = (key) => (event) => setForm((current) => ({ ...current, [key]: event.target.value }));

  return (
    <div className="space-y-6">
      <div className="rounded-xl border border-slate-200 bg-white p-4">
        <h3 className="mb-3 text-sm font-bold text-slate-900">{editingId ? 'Edit unit' : 'Add a vehicle unit'}</h3>
        <div className="grid gap-3 md:grid-cols-4">
          <div>
            <label className={labelClass}>Vehicle type</label>
            <select className={inputClass} value={form.rentalVehicleTypeId} onChange={set('rentalVehicleTypeId')}>
              <option value="">Select</option>
              {vehicleTypes.map((type) => <option key={type.id || type._id} value={type.id || type._id}>{type.name}</option>)}
            </select>
          </div>
          <div>
            <label className={labelClass}>Registration number</label>
            <input className={inputClass} value={form.registrationNumber} onChange={set('registrationNumber')} placeholder="KA01AB1234" />
          </div>
          <div>
            <label className={labelClass}>Service centre</label>
            <select className={inputClass} value={form.serviceStoreId || ''} onChange={set('serviceStoreId')}>
              <option value="">None</option>
              {stores.map((store) => <option key={store.id || store._id} value={store.id || store._id}>{store.name}</option>)}
            </select>
          </div>
          <div>
            <label className={labelClass}>Status</label>
            <select className={inputClass} value={form.status} onChange={set('status')}>
              {['available', 'booked', 'maintenance', 'inactive'].map((status) => <option key={status} value={status}>{status}</option>)}
            </select>
          </div>
          <div>
            <label className={labelClass}>Odometer (km)</label>
            <input type="number" className={inputClass} value={form.odometer} onChange={set('odometer')} />
          </div>
          <div>
            <label className={labelClass}>Fuel</label>
            <input className={inputClass} value={form.fuel} onChange={set('fuel')} placeholder="Full / 3/4 ..." />
          </div>
          <div>
            <label className={labelClass}>Colour</label>
            <input className={inputClass} value={form.color} onChange={set('color')} />
          </div>
          <div>
            <label className={labelClass}>Notes</label>
            <input className={inputClass} value={form.notes} onChange={set('notes')} />
          </div>
        </div>
        <div className="mt-3 flex gap-2">
          <button type="button" onClick={save} disabled={saving} className={`${buttonClass} bg-slate-900 text-white hover:bg-slate-800`}>
            {saving ? <Loader2 size={14} className="animate-spin" /> : null}
            {editingId ? 'Update unit' : 'Add unit'}
          </button>
          {editingId ? (
            <button type="button" onClick={() => { setEditingId(''); setForm(EMPTY_UNIT); }} className={`${buttonClass} bg-slate-100 text-slate-700`}>Cancel</button>
          ) : null}
        </div>
      </div>

      <div className="rounded-xl border border-slate-200 bg-white p-4">
        <h3 className="mb-3 text-sm font-bold text-slate-900">Check availability</h3>
        <div className="grid gap-3 md:grid-cols-4">
          <select className={inputClass} value={availability.vehicleTypeId} onChange={(e) => setAvailability((c) => ({ ...c, vehicleTypeId: e.target.value, result: null }))}>
            <option value="">Vehicle type</option>
            {vehicleTypes.map((type) => <option key={type.id || type._id} value={type.id || type._id}>{type.name}</option>)}
          </select>
          <input type="datetime-local" className={inputClass} value={availability.from} onChange={(e) => setAvailability((c) => ({ ...c, from: e.target.value, result: null }))} />
          <input type="datetime-local" className={inputClass} value={availability.to} onChange={(e) => setAvailability((c) => ({ ...c, to: e.target.value, result: null }))} />
          <button type="button" onClick={checkAvailability} className={`${buttonClass} justify-center bg-amber-500 text-white hover:bg-amber-600`}>Check</button>
        </div>
        {availability.result ? (
          <p className="mt-3 text-sm text-slate-700">
            <strong>{availability.result.available}</strong> of {availability.result.usableUnits} usable units free
            ({availability.result.overlappingBookings} overlapping bookings, peak {availability.result.peakConcurrent}).
            {availability.result.enforced ? ' Inventory is enforced.' : ' Inventory is not enforced.'}
          </p>
        ) : null}
      </div>

      {loading ? <Loader2 className="animate-spin text-slate-400" /> : (
        <Table
          columns={['Registration', 'Vehicle type', 'Service centre', 'Status', 'Odometer', '']}
          empty="No vehicle units yet"
          rows={units.map((unit) => (
            <tr key={unit.id}>
              <td className="px-4 py-3 font-bold">{unit.registrationNumber}</td>
              <td className="px-4 py-3">{unit.rentalVehicleTypeName || unit.rentalVehicleTypeId}</td>
              <td className="px-4 py-3">{unit.serviceStoreName || '-'}</td>
              <td className="px-4 py-3"><StatusPill value={unit.status} /></td>
              <td className="px-4 py-3">{unit.odometer} km</td>
              <td className="px-4 py-3 text-right">
                <button type="button" className="mr-3 text-xs font-bold text-sky-600" onClick={() => { setEditingId(unit.id); setForm({ ...EMPTY_UNIT, ...unit }); }}>Edit</button>
                <button type="button" className="text-xs font-bold text-rose-600" onClick={() => remove(unit)}>Delete</button>
              </td>
            </tr>
          ))}
        />
      )}
    </div>
  );
};

// --- deposits -----------------------------------------------------------------

const DepositsTab = () => {
  const [items, setItems] = useState([]);
  const [status, setStatus] = useState('held');
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setItems(listOf(await adminService.getRentalDeposits(status ? { status } : {})));
    } catch (error) {
      toast.error(errorText(error, 'Could not load deposits'));
    } finally {
      setLoading(false);
    }
  }, [status]);

  useEffect(() => { load(); }, [load]);

  const collect = async (booking) => {
    const paidVia = window.prompt('Collected how? (cash, upi, card, bank_transfer)', 'cash');
    if (!paidVia) return;
    try {
      await adminService.collectRentalDeposit(booking.id, { paidVia });
      toast.success('Deposit marked as held');
      load();
    } catch (error) {
      toast.error(errorText(error, 'Could not mark deposit'));
    }
  };

  const release = async (booking) => {
    const raw = window.prompt('Deduction amount (0 for a full refund)', '0');
    if (raw === null) return;
    const amount = Number(raw || 0);
    let deductions = [];
    if (amount > 0) {
      const reason = window.prompt('Reason for the deduction');
      if (!reason) return;
      deductions = [{ amount, reason }];
    }
    try {
      await adminService.releaseRentalDeposit(booking.id, { deductions });
      toast.success('Deposit released');
      load();
    } catch (error) {
      toast.error(errorText(error, 'Could not release deposit'));
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <select className={`${inputClass} max-w-xs`} value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">All</option>
          {['pending', 'held', 'partially_released', 'released', 'forfeited'].map((value) => <option key={value} value={value}>{value.replace(/_/g, ' ')}</option>)}
        </select>
        <button type="button" onClick={load} className={`${buttonClass} bg-slate-100 text-slate-700`}><RefreshCw size={14} /> Refresh</button>
      </div>
      {loading ? <Loader2 className="animate-spin text-slate-400" /> : (
        <Table
          columns={['Booking', 'Customer', 'Rental status', 'Deposit', 'Deducted', 'Released', '']}
          empty="No deposits"
          rows={items.map((booking) => {
            const deducted = (booking.deposit?.deductions || []).reduce((sum, entry) => sum + Number(entry.amount || 0), 0);
            return (
              <tr key={booking.id}>
                <td className="px-4 py-3 font-bold">{booking.bookingReference}<div className="text-xs font-normal text-slate-500">{booking.vehicleName}</div></td>
                <td className="px-4 py-3">{booking.customer?.name}<div className="text-xs text-slate-500">{booking.customer?.phone}</div></td>
                <td className="px-4 py-3"><StatusPill value={booking.status} /></td>
                <td className="px-4 py-3">{money(booking.deposit?.amount)} <StatusPill value={booking.deposit?.status} /></td>
                <td className="px-4 py-3">{money(deducted)}</td>
                <td className="px-4 py-3">{money(booking.deposit?.releasedAmount)}</td>
                <td className="px-4 py-3 text-right">
                  {booking.deposit?.status === 'pending' ? (
                    <button type="button" className="text-xs font-bold text-sky-600" onClick={() => collect(booking)}>Mark collected</button>
                  ) : null}
                  {booking.deposit?.status === 'held' ? (
                    <button type="button" className="text-xs font-bold text-emerald-600" onClick={() => release(booking)}>Release</button>
                  ) : null}
                </td>
              </tr>
            );
          })}
        />
      )}
    </div>
  );
};

// --- extensions ---------------------------------------------------------------

const ExtensionsTab = () => {
  const [items, setItems] = useState([]);
  const [status, setStatus] = useState('requested');
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setItems(listOf(await adminService.getRentalExtensions(status ? { status } : {})));
    } catch (error) {
      toast.error(errorText(error, 'Could not load extensions'));
    } finally {
      setLoading(false);
    }
  }, [status]);

  useEffect(() => { load(); }, [load]);

  const decide = async (item, nextStatus) => {
    try {
      await adminService.decideRentalExtension(item.bookingId, item.id, { status: nextStatus });
      toast.success(`Extension ${nextStatus}`);
      load();
    } catch (error) {
      toast.error(errorText(error, 'Could not update extension'));
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <select className={`${inputClass} max-w-xs`} value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">All</option>
          {['requested', 'approved', 'paid', 'rejected'].map((value) => <option key={value} value={value}>{value}</option>)}
        </select>
        <button type="button" onClick={load} className={`${buttonClass} bg-slate-100 text-slate-700`}><RefreshCw size={14} /> Refresh</button>
      </div>
      {loading ? <Loader2 className="animate-spin text-slate-400" /> : (
        <Table
          columns={['Booking', 'Customer', 'From', 'To', 'Amount', 'Status', '']}
          empty="No extensions"
          rows={items.map((item) => (
            <tr key={item.id}>
              <td className="px-4 py-3 font-bold">{item.bookingReference}<div className="text-xs font-normal text-slate-500">{item.vehicleName}</div></td>
              <td className="px-4 py-3">{item.customer?.name}<div className="text-xs text-slate-500">{item.customer?.phone}</div></td>
              <td className="px-4 py-3">{when(item.from)}</td>
              <td className="px-4 py-3">{when(item.to)}</td>
              <td className="px-4 py-3">{money(item.amount)}</td>
              <td className="px-4 py-3"><StatusPill value={item.status} />{item.autoApproved ? <span className="ml-2 text-[11px] text-slate-400">auto</span> : null}</td>
              <td className="px-4 py-3 text-right">
                {item.status === 'requested' ? (
                  <>
                    <button type="button" className="mr-3 text-xs font-bold text-emerald-600" onClick={() => decide(item, 'approved')}>Approve</button>
                    <button type="button" className="text-xs font-bold text-rose-600" onClick={() => decide(item, 'rejected')}>Reject</button>
                  </>
                ) : null}
              </td>
            </tr>
          ))}
        />
      )}
    </div>
  );
};

// --- damage -------------------------------------------------------------------

const DamageTab = () => {
  const [items, setItems] = useState([]);
  const [status, setStatus] = useState('');
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setItems(listOf(await adminService.getRentalDamageReports(status ? { status } : {})));
    } catch (error) {
      toast.error(errorText(error, 'Could not load damage reports'));
    } finally {
      setLoading(false);
    }
  }, [status]);

  useEffect(() => { load(); }, [load]);

  const act = async (report, action) => {
    const body = { action };
    if (action === 'assess') {
      const value = window.prompt('Assessed repair cost (Rs)', String(report.assessedAmount ?? report.totalEstimatedCost ?? 0));
      if (value === null) return;
      body.assessedAmount = Number(value || 0);
    }
    if (action === 'charge') {
      const value = window.prompt('Amount to charge (taken from the deposit first)', String(report.assessedAmount ?? report.totalEstimatedCost ?? 0));
      if (value === null) return;
      body.amount = Number(value || 0);
    }
    if (action === 'waive') {
      body.resolution = window.prompt('Reason for waiving') || '';
    }
    if (action === 'resolve_dispute') {
      const outcome = window.prompt('Outcome: uphold, waive or adjust', 'uphold');
      if (!outcome) return;
      body.outcome = outcome;
      if (outcome === 'adjust') body.amount = Number(window.prompt('New charge amount', String(report.chargedAmount || 0)) || 0);
      body.resolution = window.prompt('Resolution note') || '';
    }
    try {
      await adminService.actOnRentalDamageReport(report.id, body);
      toast.success('Damage report updated');
      load();
    } catch (error) {
      toast.error(errorText(error, 'Could not update damage report'));
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <select className={`${inputClass} max-w-xs`} value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">All</option>
          {['open', 'assessed', 'charged', 'waived', 'disputed'].map((value) => <option key={value} value={value}>{value}</option>)}
        </select>
        <button type="button" onClick={load} className={`${buttonClass} bg-slate-100 text-slate-700`}><RefreshCw size={14} /> Refresh</button>
      </div>
      {loading ? <Loader2 className="animate-spin text-slate-400" /> : (
        <Table
          columns={['Booking', 'Stage', 'Reported by', 'Items', 'Estimate', 'Charged', 'Status', '']}
          empty="No damage reports"
          rows={items.flatMap((report) => [
            <tr key={report.id}>
              <td className="px-4 py-3 font-bold">{report.bookingReference}</td>
              <td className="px-4 py-3">{report.stage}</td>
              <td className="px-4 py-3">{report.reportedBy?.role}{report.reportedBy?.name ? ` (${report.reportedBy.name})` : ''}</td>
              <td className="px-4 py-3">
                <button type="button" className="text-xs font-bold text-sky-600" onClick={() => setExpanded(expanded === report.id ? '' : report.id)}>
                  {report.items?.length || 0} item(s)
                </button>
              </td>
              <td className="px-4 py-3">{money(report.totalEstimatedCost)}</td>
              <td className="px-4 py-3">{money(report.chargedAmount)}{report.chargedFromDeposit ? <div className="text-[11px] text-slate-500">{money(report.chargedFromDeposit)} from deposit</div> : null}</td>
              <td className="px-4 py-3"><StatusPill value={report.status} /></td>
              <td className="px-4 py-3 text-right whitespace-nowrap">
                {['open', 'assessed'].includes(report.status) ? <button type="button" className="mr-2 text-xs font-bold text-sky-600" onClick={() => act(report, 'assess')}>Assess</button> : null}
                {report.stage !== 'pre' && ['open', 'assessed', 'charged'].includes(report.status) ? <button type="button" className="mr-2 text-xs font-bold text-rose-600" onClick={() => act(report, 'charge')}>Charge</button> : null}
                {report.status !== 'waived' && report.status !== 'disputed' ? <button type="button" className="mr-2 text-xs font-bold text-slate-500" onClick={() => act(report, 'waive')}>Waive</button> : null}
                {report.status === 'disputed' ? <button type="button" className="text-xs font-bold text-purple-600" onClick={() => act(report, 'resolve_dispute')}>Resolve dispute</button> : null}
              </td>
            </tr>,
            expanded === report.id ? (
              <tr key={`${report.id}-items`}>
                <td colSpan={8} className="bg-slate-50 px-4 py-3">
                  {report.dispute?.reason ? <p className="mb-2 text-xs text-purple-700">Dispute: {report.dispute.reason}</p> : null}
                  {report.notes ? <p className="mb-2 text-xs text-slate-600">{report.notes}</p> : null}
                  <div className="grid gap-3 md:grid-cols-2">
                    {(report.items || []).map((item) => (
                      <div key={item.id} className="rounded-lg border border-slate-200 bg-white p-3 text-xs">
                        <p className="font-bold text-slate-800">{item.part || 'Item'} <span className="font-normal text-slate-500">({item.severity})</span> - {money(item.estimatedCost)}</p>
                        <p className="text-slate-600">{item.description}</p>
                        <div className="mt-2 flex flex-wrap gap-2">
                          {(item.photos || []).map((url) => <a key={url} href={url} target="_blank" rel="noreferrer"><img src={url} alt="" className="h-16 w-16 rounded object-cover" /></a>)}
                        </div>
                      </div>
                    ))}
                  </div>
                </td>
              </tr>
            ) : null,
          ].filter(Boolean))}
        />
      )}
    </div>
  );
};

// --- settings -----------------------------------------------------------------

const SETTING_LABELS = {
  self_drive_enabled: ['Self-drive rentals', 'Riders drive the car themselves (driving licence KYC).'],
  with_driver_enabled: ['With-driver rentals', 'Riders can book a car with a driver; admins assign the driver.'],
  enforce_inventory: ['Enforce vehicle inventory', 'Reject bookings when no unit of the vehicle type is free. Needs units entered.'],
  auto_approve_extensions: ['Auto-approve extensions', 'Approve extension requests automatically when a car is free.'],
  bill_extra_km: ['Bill extra km', 'Charge km beyond the package allowance from the odometer readings (new bookings only).'],
  require_self_drive_kyc: ['Require driving licence', 'Reject self-drive bookings without a driving licence image.'],
  email_invoice_on_completion: ['Email invoice on completion', 'Send the rental invoice PDF to the rider when the rental completes.'],
};

const SettingsTab = () => {
  const [settings, setSettings] = useState(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    adminService
      .getRentalSettings()
      .then((res) => setSettings(pick(res, 'settings') || {}))
      .catch((error) => toast.error(errorText(error, 'Could not load rental settings')));
  }, []);

  const save = async () => {
    setSaving(true);
    try {
      const res = await adminService.updateRentalSettings(settings);
      setSettings(pick(res, 'settings') || settings);
      toast.success('Rental settings saved');
    } catch (error) {
      toast.error(errorText(error, 'Could not save rental settings'));
    } finally {
      setSaving(false);
    }
  };

  if (!settings) return <Loader2 className="animate-spin text-slate-400" />;

  return (
    <div className="space-y-3">
      {Object.entries(SETTING_LABELS).map(([key, [label, help]]) => {
        const on = String(settings[key] ?? '0') === '1';
        return (
          <div key={key} className="flex items-center justify-between rounded-xl border border-slate-200 bg-white p-4">
            <div>
              <p className="text-sm font-bold text-slate-900">{label}</p>
              <p className="text-xs text-slate-500">{help}</p>
            </div>
            <button
              type="button"
              onClick={() => setSettings((current) => ({ ...current, [key]: on ? '0' : '1' }))}
              className={`relative h-7 w-14 rounded-full transition-all ${on ? 'bg-emerald-500' : 'bg-slate-300'}`}
              aria-pressed={on}
            >
              <span className={`absolute top-1 h-5 w-5 rounded-full bg-white transition-all ${on ? 'left-8' : 'left-1'}`} />
            </button>
          </div>
        );
      })}
      <button type="button" onClick={save} disabled={saving} className={`${buttonClass} bg-slate-900 text-white hover:bg-slate-800`}>
        {saving ? <Loader2 size={14} className="animate-spin" /> : null} Save settings
      </button>
    </div>
  );
};

const RentalOperations = () => {
  const [tab, setTab] = useState('units');
  const Active = useMemo(
    () => ({ units: UnitsTab, deposits: DepositsTab, extensions: ExtensionsTab, damage: DamageTab, settings: SettingsTab }[tab]),
    [tab],
  );

  return (
    <div className="space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-black text-slate-900">Rental Operations</h1>
        <p className="text-sm text-slate-500">Vehicle units and availability, security deposits, extensions, damage reports and rental settings.</p>
      </div>
      <div className="flex flex-wrap gap-2">
        {TABS.map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            type="button"
            onClick={() => setTab(key)}
            className={`${buttonClass} ${tab === key ? 'bg-slate-900 text-white' : 'bg-white text-slate-600 border border-slate-200 hover:bg-slate-50'}`}
          >
            <Icon size={14} /> {label}
          </button>
        ))}
      </div>
      <Active />
    </div>
  );
};

export default RentalOperations;
