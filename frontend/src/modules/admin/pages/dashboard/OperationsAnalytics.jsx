import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Activity,
  ArrowLeft,
  ArrowUpDown,
  BarChart3,
  CheckCircle,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  Clock,
  CreditCard,
  Hand,
  IndianRupee,
  Loader2,
  RefreshCw,
  ThumbsUp,
  XCircle,
} from 'lucide-react';
import { operationsApi, ADMIN_FEED_EVENTS, unwrap } from '../../services/operationsApi';
import { adminService } from '../../services/adminService';
import { socketService } from '../../../../shared/api/socket';

// ─── Helpers ─────────────────────────────────────────────────────────────────

const IST = 'Asia/Kolkata';
const LIVE_REFETCH_DEBOUNCE_MS = 5000;
const DRIVER_PAGE_SIZE = 25;
const MAX_RANGE_DAYS = 366;

const SERVICES = [
  { key: 'ride', label: 'Ride' },
  { key: 'parcel', label: 'Parcel' },
  { key: 'intercity', label: 'Intercity' },
  { key: 'rental', label: 'Rental' },
  { key: 'bus', label: 'Bus' },
  { key: 'pooling', label: 'Pooling' },
];

const ACTORS = [
  { key: 'user', label: 'User', color: 'bg-sky-500' },
  { key: 'driver', label: 'Driver', color: 'bg-amber-500' },
  { key: 'admin', label: 'Admin', color: 'bg-violet-500' },
  { key: 'system', label: 'System', color: 'bg-slate-500' },
  { key: 'unknown', label: 'Unknown', color: 'bg-slate-300' },
];

const PAYMENT_METHODS = [
  { key: 'cash', label: 'Cash' },
  { key: 'online', label: 'Online' },
  { key: 'wallet', label: 'Wallet' },
];

const DRIVER_SORTS = [
  { key: 'trips', label: 'Trips' },
  { key: 'earnings', label: 'Earnings' },
  { key: 'utilization', label: 'Utilization' },
  { key: 'rating', label: 'Rating' },
  { key: 'online', label: 'Online time' },
];

const PRESETS = [
  { key: 'today', label: 'Today', days: 1 },
  { key: '7d', label: '7d', days: 7 },
  { key: '30d', label: '30d', days: 30 },
  { key: '90d', label: '90d', days: 90 },
];

/** Today's date in IST as YYYY-MM-DD (the backend reads bare dates as IST days). */
const todayIST = () => new Date().toLocaleDateString('en-CA', { timeZone: IST });

/** Adds whole days to a YYYY-MM-DD string. */
const addDays = (ymd, days) => {
  const [y, m, d] = String(ymd).split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d + days));
  return date.toISOString().slice(0, 10);
};

const daysBetween = (fromYmd, toYmd) => {
  const a = Date.parse(`${fromYmd}T00:00:00Z`);
  const b = Date.parse(`${toYmd}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return NaN;
  return Math.round((b - a) / 86400000) + 1;
};

const presetRange = (days) => {
  const to = todayIST();
  return { from: addDays(to, -(days - 1)), to };
};

const num = (value) => Number(value || 0).toLocaleString('en-IN');
const inr = (value) => `₹${Number(value || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
const pct = (value) => (value === null || value === undefined || Number.isNaN(Number(value)) ? '—' : `${Number(value).toFixed(1)}%`);
const hours = (minutes) => (Number(minutes || 0) / 60).toLocaleString('en-IN', { maximumFractionDigits: 1 });
const rating = (value) => (value === null || value === undefined ? '—' : Number(value).toFixed(1));

const errorMessage = (err, fallback) =>
  err?.response?.data?.message || err?.data?.message || err?.message || fallback;

const extractList = (response) => {
  const payload = response?.data ?? response;
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.results)) return payload.results;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.data?.results)) return payload.data.results;
  return [];
};

const shortDate = (ymd) => {
  const [y, m, d] = String(ymd || '').split('-').map(Number);
  if (!y || !m || !d) return String(ymd || '');
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', timeZone: 'UTC' });
};

// ─── Small building blocks ───────────────────────────────────────────────────

const SectionCard = ({ title, subtitle, right, children, className = '' }) => (
  <div className={`admin-card hover:shadow-md transition-shadow ${className}`}>
    <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between mb-4">
      <div>
        <div className="flex items-center gap-2">
          <h3 className="text-xs text-[#0B1220] uppercase tracking-wider font-bold">{title}</h3>
          <div className="h-1.5 w-1.5 rounded-full bg-[#FFC400]" />
        </div>
        {subtitle && <p className="text-[11px] text-[#64748B] mt-1">{subtitle}</p>}
      </div>
      {right}
    </div>
    {children}
  </div>
);

const KpiTile = ({ label, value, icon, cardBg, loading }) => {
  const Icon = icon;
  return (
  <div className={`admin-card !p-4 border-none !text-white shadow-lg ${cardBg}`}>
    <div className="flex items-center justify-between mb-2">
      <span className="card-label text-[10px] font-bold opacity-80 uppercase tracking-wider">{label}</span>
      <div className="p-2 rounded-full bg-white/20 backdrop-blur-sm">
        <Icon size={16} strokeWidth={2.5} />
      </div>
    </div>
    <h4 className="text-xl font-black tracking-tight mt-1">{loading ? '...' : value}</h4>
  </div>
  );
};

const MiniStat = ({ label, value }) => (
  <div className="bg-slate-50 border border-slate-100 rounded-lg p-3">
    <span className="text-[9px] text-[#64748B] block uppercase font-bold tracking-wider">{label}</span>
    <span className="text-sm font-black text-[#0B1220] block mt-1">{value}</span>
  </div>
);

const EmptyState = ({ text }) => (
  <div className="flex items-center justify-center border border-dashed border-[#E5E7EB] rounded-2xl bg-slate-50/50 p-6 text-center">
    <p className="text-[11px] text-[#64748B]">{text}</p>
  </div>
);

const th = 'px-3 py-2 text-left text-[9px] font-bold uppercase tracking-wider text-[#64748B] whitespace-nowrap';
const td = 'px-3 py-2 text-xs text-slate-700 whitespace-nowrap';

/**
 * Bar chart drawn in SVG. One bar per day; the viewBox is as wide as the
 * series so it scales from a single day to a full 366-day range.
 */
const DailyBarChart = ({ data, valueKey, color, format }) => {
  const [hovered, setHovered] = useState(null);
  const series = Array.isArray(data) ? data : [];
  if (series.length === 0) return <EmptyState text="No daily data for this range." />;

  const n = series.length;
  const height = 100;
  const max = Math.max(...series.map((d) => Number(d?.[valueKey] || 0)), 1);
  const gap = n > 120 ? 0 : n > 40 ? 0.15 : 0.25;
  const labelIdx = n === 1 ? [0] : n === 2 ? [0, 1] : [0, Math.floor((n - 1) / 2), n - 1];
  const total = series.reduce((sum, d) => sum + Number(d?.[valueKey] || 0), 0);
  const point = hovered !== null ? series[hovered] : null;

  return (
    <div>
      <div className="flex items-center justify-between mb-2 text-[10px] text-[#64748B]">
        <span>Total: <span className="font-bold text-[#0B1220]">{format(total)}</span> · Peak: <span className="font-bold text-[#0B1220]">{format(max === 1 && total === 0 ? 0 : max)}</span></span>
        <span className="font-semibold text-[#0B1220]">
          {point ? `${shortDate(point.date)}: ${format(point[valueKey])}` : ' '}
        </span>
      </div>
      <svg
        viewBox={`0 0 ${n} ${height}`}
        preserveAspectRatio="none"
        className="w-full h-[140px] bg-slate-50/60 rounded-lg"
        onMouseLeave={() => setHovered(null)}
      >
        {series.map((d, i) => {
          const value = Number(d?.[valueKey] || 0);
          const h = (value / max) * (height - 4);
          return (
            <g key={d?.date || i} onMouseEnter={() => setHovered(i)}>
              <rect x={i} y={0} width={1} height={height} fill="transparent" />
              <rect
                x={i + gap / 2}
                y={height - h}
                width={1 - gap}
                height={h}
                fill={color}
                opacity={hovered === null || hovered === i ? 1 : 0.45}
              >
                <title>{`${d?.date}: ${format(value)}`}</title>
              </rect>
            </g>
          );
        })}
      </svg>
      <div className="relative h-4 mt-1 text-[9px] text-[#64748B]">
        {labelIdx.map((i, k) => (
          <span
            key={i}
            className="absolute whitespace-nowrap"
            style={
              k === 0
                ? { left: 0 }
                : k === labelIdx.length - 1
                  ? { right: 0 }
                  : { left: `${((i + 0.5) / n) * 100}%`, transform: 'translateX(-50%)' }
            }
          >
            {shortDate(series[i]?.date)}
          </span>
        ))}
      </div>
    </div>
  );
};

const DriverTable = ({ rows, emptyText }) => {
  if (!rows || rows.length === 0) return <EmptyState text={emptyText} />;
  return (
    <div className="overflow-x-auto -mx-2">
      <table className="min-w-full">
        <thead className="border-b border-[#E5E7EB]">
          <tr>
            <th className={th}>Driver</th>
            <th className={th}>Phone</th>
            <th className={th}>Vehicle</th>
            <th className={`${th} text-right`}>Trips</th>
            <th className={`${th} text-right`}>Earnings</th>
            <th className={`${th} text-right`}>Online h</th>
            <th className={`${th} text-right`}>On-trip h</th>
            <th className={`${th} text-right`}>Util.</th>
            <th className={`${th} text-right`}>Rating</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {rows.map((d, idx) => (
            <tr key={d.driverId || idx} className="hover:bg-slate-50/70">
              <td className={`${td} font-semibold text-[#0B1220]`}>
                <span className="inline-flex items-center gap-1.5">
                  <span className={`h-1.5 w-1.5 rounded-full ${d.isOnline ? 'bg-emerald-500' : 'bg-slate-300'}`} />
                  {d.name || '—'}
                </span>
              </td>
              <td className={td}>{d.phone || '—'}</td>
              <td className={td}>
                <span className="capitalize">{d.vehicleType || '—'}</span>
                {d.vehicleNumber && <span className="text-[#64748B]"> · {d.vehicleNumber}</span>}
              </td>
              <td className={`${td} text-right`}>{num(d.trips)}</td>
              <td className={`${td} text-right`}>{inr(d.earnings)}</td>
              <td className={`${td} text-right`}>{hours(d.onlineMinutes)}</td>
              <td className={`${td} text-right`}>{hours(d.onTripMinutes)}</td>
              <td className={`${td} text-right font-semibold`}>{pct(d.utilization)}</td>
              <td className={`${td} text-right`}>
                {rating(d.rating)}
                {d.ratingCount ? <span className="text-[#64748B]"> ({d.ratingCount})</span> : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

// ─── Page ────────────────────────────────────────────────────────────────────

const OperationsAnalytics = () => {
  const navigate = useNavigate();
  const initial = useMemo(() => presetRange(30), []);
  const [from, setFrom] = useState(initial.from);
  const [to, setTo] = useState(initial.to);
  const [preset, setPreset] = useState('30d');
  const [cityId, setCityId] = useState('');
  const [cities, setCities] = useState([]);

  const [overview, setOverview] = useState(null);
  const [overviewLoading, setOverviewLoading] = useState(true);
  const [overviewRefreshing, setOverviewRefreshing] = useState(false);
  const [overviewError, setOverviewError] = useState('');
  const [lastUpdatedAt, setLastUpdatedAt] = useState(null);

  const [drivers, setDrivers] = useState(null);
  const [driversLoading, setDriversLoading] = useState(true);
  const [driversError, setDriversError] = useState('');
  const [driverSort, setDriverSort] = useState('trips');
  const [driverPage, setDriverPage] = useState(1);

  const [chartMetric, setChartMetric] = useState('bookings');

  const overviewReq = useRef(0);
  const driversReq = useRef(0);

  const rangeDays = daysBetween(from, to);
  const rangeError = !from || !to
    ? 'Pick both dates.'
    : Number.isNaN(rangeDays) || rangeDays < 1
      ? '"From" must be on or before "To".'
      : rangeDays > MAX_RANGE_DAYS
        ? `The range can be at most ${MAX_RANGE_DAYS} days.`
        : '';

  const baseParams = useMemo(() => {
    const params = { from, to };
    if (cityId) params.service_location_id = cityId;
    return params;
  }, [from, to, cityId]);

  // Service locations for the city filter.
  useEffect(() => {
    let cancelled = false;
    adminService
      .getServiceLocations()
      .then((res) => {
        if (!cancelled) setCities(extractList(res));
      })
      .catch(() => {
        if (!cancelled) setCities([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const fetchOverview = useCallback(
    async (silent = false) => {
      if (rangeError) return;
      const reqId = ++overviewReq.current;
      silent ? setOverviewRefreshing(true) : setOverviewLoading(true);
      try {
        const res = await operationsApi.getDashboardOverview(baseParams);
        if (reqId !== overviewReq.current) return;
        setOverview(unwrap(res) || null);
        setOverviewError('');
        setLastUpdatedAt(new Date());
      } catch (err) {
        if (reqId !== overviewReq.current) return;
        setOverviewError(errorMessage(err, 'Could not load the operations overview.'));
      } finally {
        if (reqId === overviewReq.current) {
          setOverviewLoading(false);
          setOverviewRefreshing(false);
        }
      }
    },
    [baseParams, rangeError]
  );

  const fetchDrivers = useCallback(async () => {
    if (rangeError) return;
    const reqId = ++driversReq.current;
    setDriversLoading(true);
    try {
      const res = await operationsApi.getDriverAnalytics({
        ...baseParams,
        sort: driverSort,
        page: driverPage,
        page_size: DRIVER_PAGE_SIZE,
        limit: 10,
      });
      if (reqId !== driversReq.current) return;
      setDrivers(unwrap(res) || null);
      setDriversError('');
    } catch (err) {
      if (reqId !== driversReq.current) return;
      setDriversError(errorMessage(err, 'Could not load driver analytics.'));
    } finally {
      if (reqId === driversReq.current) setDriversLoading(false);
    }
  }, [baseParams, driverSort, driverPage, rangeError]);

  useEffect(() => {
    fetchOverview(Boolean(overview));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetchOverview]);

  useEffect(() => {
    fetchDrivers();
  }, [fetchDrivers]);

  // Live refresh: ride lifecycle events debounce a refetch of the overview,
  // but only while the selected range includes today.
  const includesToday = !rangeError && to >= todayIST() && from <= todayIST();
  const liveRef = useRef({ includesToday, fetchOverview });
  liveRef.current = { includesToday, fetchOverview };

  useEffect(() => {
    socketService.connect({ role: 'admin' });
    let timer = null;
    const onLifecycle = () => {
      if (!liveRef.current.includesToday) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        liveRef.current.fetchOverview(true);
      }, LIVE_REFETCH_DEBOUNCE_MS);
    };
    socketService.on(ADMIN_FEED_EVENTS.RIDE_LIFECYCLE, onLifecycle);
    return () => {
      if (timer) clearTimeout(timer);
      socketService.off(ADMIN_FEED_EVENTS.RIDE_LIFECYCLE, onLifecycle);
    };
  }, []);

  const applyPreset = (p) => {
    const range = presetRange(p.days);
    setFrom(range.from);
    setTo(range.to);
    setPreset(p.key);
    setDriverPage(1);
  };

  const refreshAll = () => {
    fetchOverview(true);
    fetchDrivers();
  };

  // Derived overview data
  const totals = overview?.totals || {};
  const rates = overview?.rates || {};
  const acceptance = overview?.acceptance || {};
  const services = overview?.services || {};
  const byActor = overview?.cancellationsByActor || {};
  const byMethod = overview?.payments?.byMethod || {};
  const outcomes = overview?.payments?.outcomes || {};
  const cityRows = Array.isArray(overview?.cities) ? overview.cities : [];
  const daily = Array.isArray(overview?.daily) ? overview.daily : [];
  const actorMax = Math.max(...ACTORS.map((a) => Number(byActor[a.key] || 0)), 1);
  const actorTotal = ACTORS.reduce((s, a) => s + Number(byActor[a.key] || 0), 0);
  const paymentTotal = PAYMENT_METHODS.reduce((s, m) => s + Number(byMethod[m.key]?.amount || 0), 0);

  const summary = drivers?.summary || {};
  const pagination = drivers?.pagination || {};
  const totalDriverPages = Math.max(1, Math.ceil(Number(pagination.total || 0) / Number(pagination.pageSize || DRIVER_PAGE_SIZE)));
  const loadingTiles = overviewLoading && !overview;

  return (
    <div className="min-h-screen bg-[#F6F8FC] p-6 lg:p-8 font-sans redigo-admin-root animate-in fade-in duration-300">
      <div className="max-w-7xl mx-auto space-y-6">
        {/* HEADER */}
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div>
            <button
              onClick={() => navigate('/admin/dashboard')}
              className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-[0.22em] text-[#64748B] hover:text-[#0B1220] mb-1.5"
            >
              <ArrowLeft size={12} /> Dashboard
            </button>
            <h1>Operations Analytics</h1>
            <p className="text-[11px] text-[#64748B] mt-1">
              Bookings, revenue, cancellations, payments and driver performance (IST days).
            </p>
          </div>
          <div className="flex items-center gap-3 text-xs">
            <div className="flex items-center gap-2 px-4 py-2 bg-white rounded-lg border border-[#E5E7EB] shadow-sm">
              <Clock size={14} className="text-[#64748B]" />
              <span className="font-semibold text-slate-700">
                Last updated:{' '}
                {lastUpdatedAt
                  ? lastUpdatedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
                  : '—'}
              </span>
              {includesToday && (
                <span className="flex items-center gap-1 text-[9px] font-bold uppercase tracking-wider text-emerald-600">
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" /> Live
                </span>
              )}
            </div>
            <button
              onClick={refreshAll}
              disabled={Boolean(rangeError)}
              className="flex items-center justify-center bg-white border border-slate-200 hover:bg-slate-50 transition-colors h-9 w-9 rounded-lg disabled:opacity-50"
              title="Refresh"
            >
              <RefreshCw size={15} className={overviewRefreshing || driversLoading ? 'animate-spin text-slate-900' : 'text-slate-600'} />
            </button>
          </div>
        </div>

        {/* FILTERS */}
        <div className="admin-card !p-4 flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1">
              <span className="text-[9px] font-bold uppercase tracking-wider text-[#64748B]">From</span>
              <input
                type="date"
                value={from}
                max={to || undefined}
                onChange={(e) => {
                  setFrom(e.target.value);
                  setPreset('');
                  setDriverPage(1);
                }}
                className="h-9 rounded-lg border border-[#E5E7EB] bg-white px-3 text-xs font-semibold text-[#0B1220] outline-none focus:border-[#FFC400]"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[9px] font-bold uppercase tracking-wider text-[#64748B]">To</span>
              <input
                type="date"
                value={to}
                min={from || undefined}
                onChange={(e) => {
                  setTo(e.target.value);
                  setPreset('');
                  setDriverPage(1);
                }}
                className="h-9 rounded-lg border border-[#E5E7EB] bg-white px-3 text-xs font-semibold text-[#0B1220] outline-none focus:border-[#FFC400]"
              />
            </label>
            <div className="flex gap-1">
              {PRESETS.map((p) => (
                <button
                  key={p.key}
                  onClick={() => applyPreset(p)}
                  className={`h-9 text-[10px] font-bold px-3 rounded-lg border transition-all ${preset === p.key ? 'bg-[#FFC400] text-[#0B1220] border-[#FFC400]' : 'bg-white text-[#64748B] border-[#E5E7EB] hover:bg-slate-50'}`}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>
          <label className="flex flex-col gap-1 lg:min-w-[220px]">
            <span className="text-[9px] font-bold uppercase tracking-wider text-[#64748B]">City</span>
            <select
              value={cityId}
              onChange={(e) => {
                setCityId(e.target.value);
                setDriverPage(1);
              }}
              className="h-9 rounded-lg border border-[#E5E7EB] bg-white px-3 text-xs font-semibold text-[#0B1220] outline-none focus:border-[#FFC400]"
            >
              <option value="">All cities</option>
              {cities.map((c) => {
                const id = c?._id || c?.id;
                if (!id) return null;
                return (
                  <option key={id} value={id}>
                    {c?.name || c?.service_location_name || 'Unnamed'}
                  </option>
                );
              })}
            </select>
          </label>
        </div>

        {rangeError && (
          <div className="rounded-xl bg-amber-50 border border-amber-100 p-3 text-xs font-semibold text-amber-800">{rangeError}</div>
        )}

        {overviewError && (
          <div className="rounded-xl bg-rose-50 border border-rose-100 p-4 flex items-center gap-4">
            <div className="h-10 w-10 bg-white rounded-lg flex items-center justify-center text-rose-500 shadow-sm shrink-0">
              <CircleAlert size={20} />
            </div>
            <div className="flex-1">
              <p className="text-xs font-bold text-rose-900">Overview unavailable</p>
              <p className="text-[10px] text-rose-600 mt-0.5">{overviewError}</p>
            </div>
            <button
              onClick={() => fetchOverview(Boolean(overview))}
              className="text-[10px] font-bold uppercase tracking-wider text-rose-700 border border-rose-200 bg-white rounded-lg px-3 py-1.5 hover:bg-rose-50"
            >
              Retry
            </button>
          </div>
        )}

        {/* KPI TILES */}
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-7">
          <KpiTile label="Total Bookings" value={num(totals.bookings)} icon={BarChart3} cardBg="!bg-violet-500" loading={loadingTiles} />
          <KpiTile label="Revenue" value={inr(totals.revenue)} icon={IndianRupee} cardBg="!bg-emerald-500" loading={loadingTiles} />
          <KpiTile label="Completion" value={pct(rates.completionRate)} icon={CheckCircle} cardBg="!bg-sky-500" loading={loadingTiles} />
          <KpiTile label="Cancellation" value={pct(rates.cancellationRate)} icon={XCircle} cardBg="!bg-rose-500" loading={loadingTiles} />
          <KpiTile label="Acceptance" value={pct(rates.acceptanceRate)} icon={ThumbsUp} cardBg="!bg-teal-500" loading={loadingTiles} />
          <KpiTile label="Payment Success" value={pct(rates.paymentSuccessRate)} icon={CreditCard} cardBg="!bg-blue-500" loading={loadingTiles} />
          <KpiTile label="Manual Assigns" value={num(acceptance.manuallyAssigned)} icon={Hand} cardBg="!bg-orange-500" loading={loadingTiles} />
        </div>

        {/* SERVICES */}
        <SectionCard
          title="Bookings & revenue by service"
          subtitle={`Commission total ${inr(totals.commission)} · completed ${num(totals.completed)} · cancelled ${num(totals.cancelled)}`}
        >
          {loadingTiles ? (
            <div className="flex justify-center py-8"><Loader2 className="animate-spin text-slate-400" size={22} /></div>
          ) : (
            <div className="overflow-x-auto -mx-2">
              <table className="min-w-full">
                <thead className="border-b border-[#E5E7EB]">
                  <tr>
                    <th className={th}>Service</th>
                    <th className={`${th} text-right`}>Bookings</th>
                    <th className={`${th} text-right`}>Completed</th>
                    <th className={`${th} text-right`}>Cancelled</th>
                    <th className={`${th} text-right`}>Ongoing</th>
                    <th className={`${th} text-right`}>Revenue</th>
                    <th className={`${th} text-right`}>Commission</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {SERVICES.map((s) => {
                    const row = services[s.key];
                    if (row === null || row === undefined) {
                      return (
                        <tr key={s.key}>
                          <td className={`${td} font-semibold text-[#0B1220]`}>{s.label}</td>
                          <td className={`${td} text-right text-[#94A3B8] italic`} colSpan={6}>
                            {row === null ? 'n/a (no city data)' : '—'}
                          </td>
                        </tr>
                      );
                    }
                    return (
                      <tr key={s.key} className="hover:bg-slate-50/70">
                        <td className={`${td} font-semibold text-[#0B1220]`}>{s.label}</td>
                        <td className={`${td} text-right`}>{num(row.bookings)}</td>
                        <td className={`${td} text-right text-emerald-600`}>{num(row.completed)}</td>
                        <td className={`${td} text-right text-rose-600`}>{num(row.cancelled)}</td>
                        <td className={`${td} text-right text-sky-600`}>{num(row.ongoing)}</td>
                        <td className={`${td} text-right font-semibold`}>{inr(row.revenue)}</td>
                        <td className={`${td} text-right`}>{inr(row.commission)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </SectionCard>

        {/* CANCELLATIONS + PAYMENTS */}
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <SectionCard title="Cancellations by actor" subtitle={`${num(actorTotal)} cancellations in range`}>
            <div className="space-y-3">
              {ACTORS.map((a) => {
                const value = Number(byActor[a.key] || 0);
                return (
                  <div key={a.key} className="flex items-center gap-3">
                    <span className="w-16 text-[11px] font-semibold text-slate-700">{a.label}</span>
                    <div className="flex-1 h-3 rounded-full bg-slate-100 overflow-hidden">
                      <div className={`h-full rounded-full ${a.color}`} style={{ width: `${(value / actorMax) * 100}%` }} />
                    </div>
                    <span className="w-20 text-right text-[11px] font-bold text-[#0B1220]">
                      {num(value)}
                      <span className="text-[#94A3B8] font-semibold"> {actorTotal ? `${Math.round((value / actorTotal) * 100)}%` : ''}</span>
                    </span>
                  </div>
                );
              })}
            </div>
          </SectionCard>

          <SectionCard
            title="Payments by method"
            subtitle={`Settled: ${num(outcomes.success)} success · ${num(outcomes.failed)} failed · success rate ${pct(outcomes.successRate ?? rates.paymentSuccessRate)}`}
          >
            <div className="grid grid-cols-3 gap-3">
              {PAYMENT_METHODS.map((m) => {
                const row = byMethod[m.key] || {};
                const share = paymentTotal ? Math.round((Number(row.amount || 0) / paymentTotal) * 100) : 0;
                return (
                  <div key={m.key} className="bg-slate-50 border border-slate-100 rounded-lg p-3">
                    <span className="text-[9px] text-[#64748B] block uppercase font-bold tracking-wider">{m.label}</span>
                    <span className="text-sm font-black text-[#0B1220] block mt-1">{inr(row.amount)}</span>
                    <span className="text-[10px] text-[#64748B] block mt-0.5">{num(row.count)} payments · {share}%</span>
                    <div className="mt-2 h-1.5 rounded-full bg-slate-200 overflow-hidden">
                      <div className="h-full bg-[#FFC400]" style={{ width: `${share}%` }} />
                    </div>
                  </div>
                );
              })}
            </div>
          </SectionCard>
        </div>

        {/* DAILY SERIES */}
        <SectionCard
          title="Daily trend"
          subtitle={`${daily.length} day${daily.length === 1 ? '' : 's'}`}
          right={
            <div className="flex gap-1">
              {[
                { key: 'bookings', label: 'Bookings' },
                { key: 'revenue', label: 'Revenue' },
              ].map((t) => (
                <button
                  key={t.key}
                  onClick={() => setChartMetric(t.key)}
                  className={`text-[9px] font-bold px-2 py-0.5 rounded border transition-all ${chartMetric === t.key ? 'bg-[#FFC400] text-[#0B1220] border-[#FFC400]' : 'bg-transparent text-[#64748B] border-[#E5E7EB]'}`}
                >
                  {t.label}
                </button>
              ))}
            </div>
          }
        >
          {loadingTiles ? (
            <div className="flex justify-center py-8"><Loader2 className="animate-spin text-slate-400" size={22} /></div>
          ) : chartMetric === 'bookings' ? (
            <DailyBarChart data={daily} valueKey="bookings" color="#8B5CF6" format={num} />
          ) : (
            <DailyBarChart data={daily} valueKey="revenue" color="#10B981" format={inr} />
          )}
        </SectionCard>

        {/* CITIES */}
        <SectionCard title="By city" subtitle="Sorted by revenue">
          {cityRows.length === 0 ? (
            <EmptyState text={loadingTiles ? 'Loading…' : 'No city data for this range.'} />
          ) : (
            <div className="overflow-x-auto -mx-2">
              <table className="min-w-full">
                <thead className="border-b border-[#E5E7EB]">
                  <tr>
                    <th className={th}>City</th>
                    <th className={`${th} text-right`}>Bookings</th>
                    <th className={`${th} text-right`}>Completed</th>
                    <th className={`${th} text-right`}>Cancelled</th>
                    <th className={`${th} text-right`}>Completion</th>
                    <th className={`${th} text-right`}>Revenue</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {cityRows.map((c, idx) => (
                    <tr key={c.serviceLocationId || idx} className="hover:bg-slate-50/70">
                      <td className={`${td} font-semibold text-[#0B1220]`}>{c.name || 'Unassigned'}</td>
                      <td className={`${td} text-right`}>{num(c.bookings)}</td>
                      <td className={`${td} text-right text-emerald-600`}>{num(c.completed)}</td>
                      <td className={`${td} text-right text-rose-600`}>{num(c.cancelled)}</td>
                      <td className={`${td} text-right`}>{pct(c.completionRate)}</td>
                      <td className={`${td} text-right font-semibold`}>{inr(c.revenue)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </SectionCard>

        {/* DRIVER PERFORMANCE */}
        <div className="flex items-center gap-2 pt-2">
          <Activity size={16} className="text-[#0B1220]" />
          <h2 className="text-sm font-black uppercase tracking-wider text-[#0B1220]">Driver performance</h2>
        </div>

        {driversError && (
          <div className="rounded-xl bg-rose-50 border border-rose-100 p-4 flex items-center gap-4">
            <CircleAlert size={18} className="text-rose-500 shrink-0" />
            <p className="flex-1 text-xs font-semibold text-rose-800">{driversError}</p>
            <button
              onClick={fetchDrivers}
              className="text-[10px] font-bold uppercase tracking-wider text-rose-700 border border-rose-200 bg-white rounded-lg px-3 py-1.5 hover:bg-rose-50"
            >
              Retry
            </button>
          </div>
        )}

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <MiniStat label="Active drivers" value={driversLoading && !drivers ? '...' : `${num(summary.activeDrivers)} / ${num(summary.drivers)}`} />
          <MiniStat label="Trips" value={driversLoading && !drivers ? '...' : num(summary.trips)} />
          <MiniStat label="Earnings" value={driversLoading && !drivers ? '...' : inr(summary.earnings)} />
          <MiniStat label="Online hours" value={driversLoading && !drivers ? '...' : hours(summary.onlineMinutes)} />
          <MiniStat label="On-trip hours" value={driversLoading && !drivers ? '...' : hours(summary.onTripMinutes)} />
          <MiniStat label="Utilization" value={driversLoading && !drivers ? '...' : pct(summary.utilization)} />
        </div>

        <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
          <SectionCard title="Top drivers" subtitle="Best performers in range">
            <DriverTable rows={drivers?.top} emptyText={driversLoading ? 'Loading…' : 'No drivers in this range.'} />
          </SectionCard>
          <SectionCard title="Lowest utilization" subtitle="Drivers online at least an hour">
            <DriverTable rows={drivers?.bottom} emptyText={driversLoading ? 'Loading…' : 'No drivers in this range.'} />
          </SectionCard>
        </div>

        <SectionCard
          title="All drivers"
          subtitle={`${num(pagination.total)} drivers`}
          right={
            <label className="flex items-center gap-2">
              <ArrowUpDown size={13} className="text-[#64748B]" />
              <span className="text-[9px] font-bold uppercase tracking-wider text-[#64748B]">Sort by</span>
              <select
                value={driverSort}
                onChange={(e) => {
                  setDriverSort(e.target.value);
                  setDriverPage(1);
                }}
                className="h-8 rounded-lg border border-[#E5E7EB] bg-white px-2 text-xs font-semibold text-[#0B1220] outline-none focus:border-[#FFC400]"
              >
                {DRIVER_SORTS.map((s) => (
                  <option key={s.key} value={s.key}>{s.label}</option>
                ))}
              </select>
            </label>
          }
        >
          <div className={driversLoading && drivers ? 'opacity-60 transition-opacity' : ''}>
            <DriverTable rows={drivers?.items} emptyText={driversLoading ? 'Loading…' : 'No drivers in this range.'} />
          </div>
          <div className="flex items-center justify-between mt-4 pt-3 border-t border-[#E5E7EB]">
            <span className="text-[10px] text-[#64748B]">
              Page {driverPage} of {totalDriverPages}
            </span>
            <div className="flex gap-1">
              <button
                onClick={() => setDriverPage((p) => Math.max(1, p - 1))}
                disabled={driverPage <= 1 || driversLoading}
                className="flex items-center justify-center h-8 w-8 rounded-lg border border-[#E5E7EB] bg-white hover:bg-slate-50 disabled:opacity-40"
                title="Previous page"
              >
                <ChevronLeft size={14} />
              </button>
              <button
                onClick={() => setDriverPage((p) => Math.min(totalDriverPages, p + 1))}
                disabled={driverPage >= totalDriverPages || driversLoading}
                className="flex items-center justify-center h-8 w-8 rounded-lg border border-[#E5E7EB] bg-white hover:bg-slate-50 disabled:opacity-40"
                title="Next page"
              >
                <ChevronRight size={14} />
              </button>
            </div>
          </div>
        </SectionCard>
      </div>
    </div>
  );
};

export default OperationsAnalytics;
