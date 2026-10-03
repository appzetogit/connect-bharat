import { useEffect, useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import toast from 'react-hot-toast';
import { ArrowDown, Calculator, CheckCircle2, MapPinOff, Search, X } from 'lucide-react';
import { corporateApi, errorMessage } from '../services/corporateApi';
import {
  Badge, Button, Card, Empty, ErrorNote, Field, Input, Loading, PageHeader, Pager, Select, Table, currentMonth, formatDate, formatMoney, monthRange, useLoad,
} from '../components/ui';
import { LocationInput } from '../components/maps';
import { PAYMENT_METHOD_OPTIONS, formatKm, hasPoint } from '../components/helpers';

/// Services the travel desk books. Rentals need a package and parcels a
/// receiver, neither of which this form collects.
const DESK_SERVICES = [
  { value: 'ride', label: 'Ride' },
  { value: 'intercity', label: 'Outstation' },
];

const NOT_STARTED = ['pending', 'pending_approval', 'awaiting_approval', 'scheduled', 'searching', 'accepted', 'arrived'];

const EMPTY_POINT = { address: '', lat: '', lng: '' };

const toPoint = (point) => ({ lat: Number(point.lat), lng: Number(point.lng), address: (point.address || '').trim() });

const localDateTime = (date) => {
  const offset = date.getTimezoneOffset() * 60000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
};

function EmployeePicker({ value, onChange }) {
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query.trim()), 300);
    return () => clearTimeout(timer);
  }, [query]);
  const { data, loading } = useLoad(
    () => (debounced.length >= 2 ? corporateApi.employees({ search: debounced, active: 'true', limit: 8 }) : Promise.resolve(null)),
    [debounced],
  );

  if (value) {
    const allowance = value.allowance;
    return (
      <div className="flex items-start justify-between gap-3 border border-gray-200 rounded-lg p-3">
        <div className="text-sm">
          <p className="font-medium text-gray-900">{value.name} <span className="font-mono text-xs text-gray-500">{value.employeeCode}</span></p>
          <p className="text-xs text-gray-500">{value.phone}{value.role?.name ? ` · ${value.role.name}` : ''}{value.departmentId?.name ? ` · ${value.departmentId.name}` : ''}</p>
          {allowance && Number(allowance.allowanceKm) > 0 && (
            <p className="text-xs text-gray-600 mt-1">Allowance {allowance.periodKey}: {formatKm(allowance.remainingKm)} left of {formatKm(allowance.allowanceKm)}</p>
          )}
        </div>
        <button type="button" className="text-gray-400 hover:text-gray-700" onClick={() => onChange(null)} aria-label="Change employee"><X size={16} /></button>
      </div>
    );
  }

  const results = data?.items || [];
  return (
    <div className="relative">
      <Search size={14} className="absolute left-3 top-[1.1rem] -translate-y-1/2 text-gray-400" />
      <input
        className="w-full text-sm border border-gray-200 rounded-lg pl-8 pr-3 py-2 bg-white focus:outline-none focus:ring-2 focus:ring-gray-900/10"
        placeholder="Search name, phone or employee ID"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {debounced.length >= 2 && (
        <div className="mt-1 border border-gray-200 rounded-lg divide-y divide-gray-100 max-h-64 overflow-y-auto bg-white">
          {loading ? <p className="text-xs text-gray-400 p-3">Searching…</p> : !results.length ? <p className="text-xs text-gray-400 p-3">No active employee matches.</p> : results.map((employee) => (
            <button key={employee._id} type="button" className="w-full text-left px-3 py-2 hover:bg-gray-50" onClick={() => { onChange(employee); setQuery(''); }}>
              <p className="text-sm font-medium text-gray-900">{employee.name} <span className="font-mono text-xs text-gray-500">{employee.employeeCode}</span></p>
              <p className="text-xs text-gray-500">{employee.phone}{employee.role?.name ? ` · ${employee.role.name}` : ''}</p>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function QuoteCard({ quote, selected, onSelect }) {
  const allowance = quote.allowance || {};
  const split = quote.split || {};
  const outside = quote.withinBoundary === false;
  const hasAllowance = Number(allowance.allowanceKm) > 0;
  return (
    <button
      type="button"
      disabled={outside}
      onClick={onSelect}
      className={`text-left w-full border rounded-xl p-4 space-y-2 transition ${selected ? 'border-gray-900 ring-2 ring-gray-900/10' : 'border-gray-200 hover:border-gray-400'} ${outside ? 'opacity-60 cursor-not-allowed' : ''}`}
    >
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="font-semibold text-gray-900">{quote.vehicleName || 'Vehicle'}</p>
          <div className="flex flex-wrap gap-1 mt-1">
            {quote.pricing === 'company_tariff' && <span className="text-[11px] font-semibold rounded-full px-2 py-0.5 bg-violet-100 text-violet-800">Company tariff</span>}
            {outside
              ? <span className="text-[11px] font-semibold rounded-full px-2 py-0.5 bg-red-100 text-red-800">Outside office boundary</span>
              : quote.withinBoundary === true && <span className="text-[11px] font-semibold rounded-full px-2 py-0.5 bg-emerald-100 text-emerald-800">Within boundary</span>}
          </div>
        </div>
        <p className="text-lg font-bold text-gray-900 tabular-nums">{formatMoney(quote.fare)}</p>
      </div>
      <div className="text-xs text-gray-600 space-y-1">
        <p>Estimated {formatKm(allowance.estimatedKm)}</p>
        {hasAllowance ? (
          <p>
            Allowance covers <span className="font-medium text-gray-900">{formatKm(allowance.coveredKm)}</span>
            {Number(allowance.excessKm) > 0 && <> · excess <span className="font-medium text-red-700">{formatKm(allowance.excessKm)}</span></>}
            <span className="text-gray-400"> ({formatKm(allowance.remainingKmAtBooking)} left of {formatKm(allowance.allowanceKm)})</span>
          </p>
        ) : <p>No km limit for this role: the company pays the full fare.</p>}
      </div>
      <div className="grid grid-cols-2 gap-2 text-xs border-t border-gray-100 pt-2">
        <div><p className="text-gray-500">Company pays</p><p className="font-semibold text-gray-900 tabular-nums">{formatMoney(split.companyAmount ?? quote.fare)}</p></div>
        <div><p className="text-gray-500">Employee pays</p><p className={`font-semibold tabular-nums ${Number(split.employeeAmount) > 0 ? 'text-red-700' : 'text-gray-900'}`}>{formatMoney(split.employeeAmount)}</p></div>
      </div>
    </button>
  );
}

function BookTrip({ allowedMethods, onBooked }) {
  const [employee, setEmployee] = useState(null);
  const [pickup, setPickup] = useState(EMPTY_POINT);
  const [drop, setDrop] = useState(EMPTY_POINT);
  const [serviceType, setServiceType] = useState('ride');
  const [when, setWhen] = useState('now');
  const [scheduledAt, setScheduledAt] = useState(() => localDateTime(new Date(Date.now() + 60 * 60000)));
  const [quotes, setQuotes] = useState(null);
  const [selectedId, setSelectedId] = useState('');
  const [paymentMethod, setPaymentMethod] = useState('');
  const [note, setNote] = useState('');
  const [quoteError, setQuoteError] = useState(null);
  const [busy, setBusy] = useState('');

  const resetQuote = () => { setQuotes(null); setSelectedId(''); setQuoteError(null); };
  const change = (setter) => (value) => { setter(value); resetQuote(); };

  const tripBody = () => ({
    employeeId: employee._id,
    pickup: toPoint(pickup),
    drop: toPoint(drop),
    serviceType,
    ...(when === 'later' ? { scheduledAt: new Date(scheduledAt).toISOString() } : {}),
  });

  const ready = employee && hasPoint(pickup) && hasPoint(drop) && (when === 'now' || scheduledAt);

  const handleError = (err) => {
    const body = err?.response?.data || {};
    const code = body.code || body.data?.code || body.error?.code;
    if (err?.response?.status === 403 && code === 'corporate_outside_boundary') {
      setQuoteError({ boundary: true, message: body.message, offices: body.offices || body.data?.offices || [] });
    } else {
      setQuoteError({ message: errorMessage(err) });
    }
  };

  const getQuote = async () => {
    if (!ready) {
      toast.error('Choose an employee, a pickup and a drop with coordinates');
      return;
    }
    if (when === 'later' && new Date(scheduledAt).getTime() < Date.now()) {
      toast.error('The scheduled time is in the past');
      return;
    }
    setBusy('quote');
    resetQuote();
    try {
      const result = await corporateApi.quoteBooking(tripBody());
      const list = result?.quotes || [];
      setQuotes(list);
      const first = list.find((quote) => quote.withinBoundary !== false);
      setSelectedId(first ? String(first.vehicleTypeId) : '');
      if (allowedMethods.length === 1) setPaymentMethod(allowedMethods[0]);
    } catch (err) {
      handleError(err);
    } finally {
      setBusy('');
    }
  };

  const selected = (quotes || []).find((quote) => String(quote.vehicleTypeId) === selectedId);
  const needsPayment = Number(selected?.split?.employeeAmount) > 0;

  const book = async () => {
    if (!selected) return;
    if (needsPayment && !paymentMethod) {
      toast.error('Choose how the employee pays their share');
      return;
    }
    setBusy('book');
    try {
      const result = await corporateApi.createBooking({
        ...tripBody(),
        vehicleTypeId: selected.vehicleTypeId,
        ...(needsPayment ? { employeePaymentMethod: paymentMethod } : {}),
        ...(note.trim() ? { note: note.trim() } : {}),
      });
      toast.success(`Trip booked for ${employee.name}`);
      onBooked(result?.ride);
      setPickup(EMPTY_POINT);
      setDrop(EMPTY_POINT);
      setNote('');
      setPaymentMethod('');
      resetQuote();
    } catch (err) {
      handleError(err);
      toast.error(errorMessage(err));
    } finally {
      setBusy('');
    }
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">
      <Card className="p-5 space-y-4 lg:col-span-2">
        <Field label="Employee"><EmployeePicker value={employee} onChange={change(setEmployee)} /></Field>
        <LocationInput label="Pickup" value={pickup} onChange={change(setPickup)} placeholder="Search pickup" />
        <div className="flex justify-center text-gray-300"><ArrowDown size={16} /></div>
        <LocationInput label="Drop" value={drop} onChange={change(setDrop)} placeholder="Search drop" />
        <div className="grid grid-cols-2 gap-3">
          <Field label="Service">
            <Select value={serviceType} onChange={(e) => change(setServiceType)(e.target.value)}>
              {DESK_SERVICES.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </Select>
          </Field>
          <Field label="When">
            <Select value={when} onChange={(e) => change(setWhen)(e.target.value)}>
              <option value="now">Now</option>
              <option value="later">Schedule</option>
            </Select>
          </Field>
        </div>
        {when === 'later' && (
          <Field label="Pickup time"><Input type="datetime-local" min={localDateTime(new Date())} value={scheduledAt} onChange={(e) => change(setScheduledAt)(e.target.value)} /></Field>
        )}
        <Button className="w-full" busy={busy === 'quote'} disabled={!ready} onClick={getQuote}><Calculator size={14} /> Get fares</Button>
      </Card>

      <div className="lg:col-span-3 space-y-4">
        {quoteError && (
          <div className="bg-red-50 border border-red-200 text-red-800 text-sm rounded-lg p-3">
            {quoteError.boundary ? (
              <>
                <p className="font-medium flex items-center gap-2"><MapPinOff size={14} /> {quoteError.message || 'This trip is outside your company’s office boundary.'}</p>
                {quoteError.offices.length > 0 && (
                  <ul className="text-xs mt-2 space-y-0.5 list-disc pl-5">
                    {quoteError.offices.map((office, index) => <li key={office._id || index}>{office.name}{office.radiusKm ? ` · within ${formatKm(office.radiusKm)}` : ''}{office.address ? ` · ${office.address}` : ''}</li>)}
                  </ul>
                )}
              </>
            ) : quoteError.message}
          </div>
        )}
        {!quotes ? (
          !quoteError && <Empty title="Choose an employee and a route, then get fares." hint="Fares show the company and employee share against the employee's km allowance." />
        ) : !quotes.length ? (
          <Empty title="No vehicles available for this trip." hint="The employee's role or company policy may not allow any vehicle here." />
        ) : (
          <>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {quotes.map((quote) => (
                <QuoteCard key={quote.vehicleTypeId} quote={quote} selected={String(quote.vehicleTypeId) === selectedId} onSelect={() => setSelectedId(String(quote.vehicleTypeId))} />
              ))}
            </div>
            {selected && (
              <Card className="p-5 space-y-3">
                {needsPayment && (
                  <Field label={`${employee?.name || 'The employee'} pays ${formatMoney(selected.split.employeeAmount)} for the km beyond the allowance, by`}>
                    <div className="flex flex-wrap gap-3 text-sm pt-1">
                      {PAYMENT_METHOD_OPTIONS.filter((option) => allowedMethods.includes(option.value)).map((option) => (
                        <label key={option.value} className="flex items-center gap-1.5">
                          <input type="radio" name="employeePaymentMethod" checked={paymentMethod === option.value} onChange={() => setPaymentMethod(option.value)} /> {option.label}
                        </label>
                      ))}
                    </div>
                  </Field>
                )}
                <Field label="Note for the employee (optional)"><Input value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} /></Field>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <p className="text-sm text-gray-600">
                    {selected.vehicleName} · {when === 'later' ? `pickup ${formatDate(scheduledAt, true)}` : 'pickup now'} · company pays <span className="font-semibold text-gray-900">{formatMoney(selected.split?.companyAmount ?? selected.fare)}</span>
                  </p>
                  <Button busy={busy === 'book'} onClick={book}><CheckCircle2 size={14} /> Book trip</Button>
                </div>
                <p className="text-xs text-gray-400">Booked in the employee’s name; they get a notification with the trip details.</p>
              </Card>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function Bookings({ canBook, refreshKey }) {
  const [month, setMonth] = useState(currentMonth());
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [busyId, setBusyId] = useState('');
  const range = monthRange(month);
  const { data, loading, error, reload } = useLoad(
    () => corporateApi.bookings({ ...range, status: status || undefined, page, limit: 25 }),
    [month, status, page, refreshKey],
  );

  const cancel = async (row) => {
    const reason = window.prompt(`Cancel the trip for ${row.employee?.name || 'this employee'}? Reason (optional)`, '');
    if (reason === null) return;
    const id = row.rideId || row._id || row.id;
    setBusyId(id);
    try {
      await corporateApi.cancelBooking(id, reason);
      toast.success('Booking cancelled');
      reload();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusyId('');
    }
  };

  return (
    <>
      <div className="flex flex-wrap gap-2 mb-4">
        <div className="w-44"><Input type="month" value={month} onChange={(e) => { setMonth(e.target.value); setPage(1); }} /></div>
        <div className="w-44">
          <Select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
            <option value="">Any status</option>
            <option value="scheduled">Scheduled</option>
            <option value="searching">Searching</option>
            <option value="accepted">Accepted</option>
            <option value="ongoing">Ongoing</option>
            <option value="completed">Completed</option>
            <option value="cancelled">Cancelled</option>
          </Select>
        </div>
      </div>
      <ErrorNote message={error} />
      {loading ? <Loading /> : !data?.items?.length ? <Empty title="No travel-desk bookings in this period." /> : (
        <>
          <Table
            rowKey={(row) => row.rideId || row._id || row.id}
            columns={[
              { key: 'when', label: 'Pickup', render: (row) => <div><p className="whitespace-nowrap">{formatDate(row.scheduledAt || row.createdAt, true)}</p>{row.scheduledAt && <p className="text-xs text-gray-400">scheduled</p>}</div> },
              { key: 'employee', label: 'Employee', render: (row) => <div><p className="font-medium">{row.employee?.name || '-'}</p><p className="text-xs text-gray-500 font-mono">{row.employee?.employeeCode || ''}</p></div> },
              { key: 'route', label: 'Route', render: (row) => <div className="max-w-xs text-xs"><p>{row.pickupAddress}</p><p className="text-gray-500">→ {row.dropAddress}</p><p className="text-gray-400 mt-0.5">{row.vehicleName}{row.bookedBy?.name ? ` · by ${row.bookedBy.name}` : ''}</p></div> },
              { key: 'status', label: 'Status', render: (row) => <Badge value={row.status} /> },
              { key: 'fare', label: 'Fare', align: 'right', render: (row) => formatMoney(row.fare ?? row.grossFare) },
              {
                key: 'split',
                label: 'Company / employee',
                align: 'right',
                render: (row) => (
                  <div className="text-xs">
                    <p>{formatMoney(row.split?.companyAmount ?? row.billedAmount)}</p>
                    {Number(row.split?.employeeAmount) > 0 && <p className="text-red-700">{formatMoney(row.split.employeeAmount)} · {row.split.employeePaymentMethod || '-'}</p>}
                  </div>
                ),
              },
              {
                key: 'actions',
                label: '',
                render: (row) => canBook && NOT_STARTED.includes(row.status) && (
                  <Button variant="secondary" busy={busyId === (row.rideId || row._id || row.id)} onClick={() => cancel(row)}>Cancel</Button>
                ),
              },
            ]}
            rows={data.items}
          />
          <Pager page={data.page} total={data.total} limit={data.limit} onPage={setPage} />
        </>
      )}
    </>
  );
}

export default function CorporateTravelDesk() {
  const { session } = useOutletContext() || {};
  const canBook = ['owner', 'admin', 'approver'].includes(session?.admin?.role);
  const [tab, setTab] = useState(canBook ? 'book' : 'bookings');
  const [refreshKey, setRefreshKey] = useState(0);
  const allowedMethods = session?.corporate?.excessPayment?.allowedMethods?.length
    ? session.corporate.excessPayment.allowedMethods
    : ['cash', 'online', 'wallet'];

  return (
    <>
      <PageHeader title="Travel desk" subtitle="Book trips for employees. The trip is billed to the company, within each employee's role allowance and travel rules." />
      <div className="flex gap-2 mb-4 border-b border-gray-200">
        {[canBook && ['book', 'Book a trip'], ['bookings', 'Bookings']].filter(Boolean).map(([key, label]) => (
          <button key={key} type="button" onClick={() => setTab(key)} className={`text-sm px-3 py-2 -mb-px border-b-2 ${tab === key ? 'border-gray-900 font-semibold text-gray-900' : 'border-transparent text-gray-500'}`}>{label}</button>
        ))}
      </div>
      {tab === 'book' && canBook && (
        <BookTrip
          allowedMethods={allowedMethods}
          onBooked={() => { setRefreshKey((value) => value + 1); setTab('bookings'); }}
        />
      )}
      {tab === 'bookings' && <Bookings canBook={canBook} refreshKey={refreshKey} />}
    </>
  );
}
