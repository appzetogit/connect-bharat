import { useCallback, useEffect, useState } from 'react';
import { Loader2, X } from 'lucide-react';

/** Small shared pieces for the corporate panel pages. */

export const formatMoney = (value) =>
  `₹${Number(value || 0).toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;

export const formatDate = (value, withTime = false) => {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return '-';
  return withTime
    ? date.toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
    : date.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
};

/** Runs `loader` on mount and whenever `deps` change. */
export const useLoad = (loader, deps = []) => {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const run = useCallback(loader, deps);

  const reload = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      setData(await run());
    } catch (err) {
      setError(err?.response?.data?.message || err?.message || 'Could not load');
    } finally {
      setLoading(false);
    }
  }, [run]);

  useEffect(() => {
    reload();
  }, [reload]);

  return { data, loading, error, reload, setData };
};

export const PageHeader = ({ title, subtitle, actions }) => (
  <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3 mb-5">
    <div>
      <h1 className="text-xl font-bold text-gray-900">{title}</h1>
      {subtitle && <p className="text-sm text-gray-500 mt-1">{subtitle}</p>}
    </div>
    {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
  </div>
);

export const Card = ({ children, className = '' }) => (
  <div className={`bg-white border border-gray-200 rounded-xl ${className}`}>{children}</div>
);

export const StatCard = ({ label, value, hint }) => (
  <Card className="p-4">
    <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">{label}</p>
    <p className="text-2xl font-bold text-gray-900 mt-1 tabular-nums">{value}</p>
    {hint && <p className="text-xs text-gray-400 mt-1">{hint}</p>}
  </Card>
);

const BUTTON_STYLES = {
  primary: 'bg-gray-900 text-white hover:bg-gray-800',
  secondary: 'bg-white text-gray-700 border border-gray-200 hover:bg-gray-50',
  danger: 'bg-red-600 text-white hover:bg-red-700',
  success: 'bg-emerald-600 text-white hover:bg-emerald-700',
};

export const Button = ({ variant = 'primary', className = '', busy = false, children, ...props }) => (
  <button
    type="button"
    disabled={busy || props.disabled}
    className={`inline-flex items-center justify-center gap-2 text-sm font-medium rounded-lg px-3 py-2 disabled:opacity-50 ${BUTTON_STYLES[variant]} ${className}`}
    {...props}
  >
    {busy && <Loader2 size={14} className="animate-spin" />}
    {children}
  </button>
);

export const Field = ({ label, children, hint }) => (
  <label className="block">
    <span className="block text-xs font-medium text-gray-600 mb-1">{label}</span>
    {children}
    {hint && <span className="block text-xs text-gray-400 mt-1">{hint}</span>}
  </label>
);

export const inputClass = 'w-full text-sm border border-gray-200 rounded-lg px-3 py-2 bg-white focus:outline-none focus:ring-2 focus:ring-gray-900/10';

export const Input = (props) => <input className={inputClass} {...props} />;

export const Select = ({ children, ...props }) => (
  <select className={inputClass} {...props}>
    {children}
  </select>
);

const BADGE_STYLES = {
  pending: 'bg-yellow-100 text-yellow-800',
  approved: 'bg-emerald-100 text-emerald-800',
  booked: 'bg-emerald-100 text-emerald-800',
  paid: 'bg-emerald-100 text-emerald-800',
  completed: 'bg-emerald-100 text-emerald-800',
  active: 'bg-emerald-100 text-emerald-800',
  issued: 'bg-blue-100 text-blue-800',
  partially_paid: 'bg-blue-100 text-blue-800',
  searching: 'bg-blue-100 text-blue-800',
  accepted: 'bg-blue-100 text-blue-800',
  ongoing: 'bg-blue-100 text-blue-800',
  overdue: 'bg-red-100 text-red-800',
  rejected: 'bg-red-100 text-red-800',
  suspended: 'bg-red-100 text-red-800',
  inactive: 'bg-gray-100 text-gray-600',
  cancelled: 'bg-gray-100 text-gray-600',
  expired: 'bg-gray-100 text-gray-600',
  void: 'bg-gray-100 text-gray-600',
  draft: 'bg-gray-100 text-gray-600',
};

export const Badge = ({ value }) => (
  <span className={`inline-block text-xs font-semibold rounded-full px-2.5 py-0.5 ${BADGE_STYLES[value] || 'bg-gray-100 text-gray-700'}`}>
    {String(value || '-').replace(/_/g, ' ')}
  </span>
);

export const Loading = () => (
  <div className="flex items-center gap-2 text-gray-500 py-16 justify-center">
    <Loader2 size={18} className="animate-spin" /> Loading…
  </div>
);

export const ErrorNote = ({ message }) =>
  message ? <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg p-3 mb-4">{message}</div> : null;

export const Empty = ({ title, hint }) => (
  <Card className="p-10 text-center">
    <p className="text-sm text-gray-600">{title}</p>
    {hint && <p className="text-xs text-gray-400 mt-1">{hint}</p>}
  </Card>
);

/** Plain table. `columns` = [{ key, label, render?, align? }] */
export const Table = ({ columns, rows, rowKey = (row) => row._id || row.id }) => (
  <Card className="overflow-hidden">
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="bg-gray-50 text-gray-600">
          <tr>
            {columns.map((column) => (
              <th key={column.key} className={`font-medium px-4 py-3 whitespace-nowrap ${column.align === 'right' ? 'text-right' : 'text-left'}`}>
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={rowKey(row) || index} className="border-t border-gray-100 align-top">
              {columns.map((column) => (
                <td key={column.key} className={`px-4 py-3 ${column.align === 'right' ? 'text-right tabular-nums' : ''}`}>
                  {column.render ? column.render(row) : row[column.key] ?? '-'}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  </Card>
);

export const Modal = ({ open, title, onClose, children, footer }) => {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="bg-white rounded-xl w-full max-w-lg max-h-[90vh] overflow-y-auto shadow-xl" onClick={(event) => event.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
          <h2 className="font-semibold text-gray-900">{title}</h2>
          <button type="button" onClick={onClose} className="text-gray-400 hover:text-gray-700" aria-label="Close">
            <X size={18} />
          </button>
        </div>
        <div className="p-5 space-y-4">{children}</div>
        {footer && <div className="px-5 py-4 border-t border-gray-100 flex justify-end gap-2">{footer}</div>}
      </div>
    </div>
  );
};

export const Pager = ({ page, total, limit, onPage }) => {
  const pages = Math.max(1, Math.ceil((total || 0) / (limit || 25)));
  if (pages <= 1) return null;
  return (
    <div className="flex items-center justify-end gap-2 mt-3 text-sm text-gray-600">
      <Button variant="secondary" disabled={page <= 1} onClick={() => onPage(page - 1)}>Previous</Button>
      <span>Page {page} of {pages}</span>
      <Button variant="secondary" disabled={page >= pages} onClick={() => onPage(page + 1)}>Next</Button>
    </div>
  );
};

/** Month picker that yields a { from, to } ISO range for the reports. */
export const monthRange = (month) => {
  const [year, mon] = String(month).split('-').map(Number);
  const from = new Date(year, mon - 1, 1);
  const to = new Date(year, mon, 1);
  return { from: from.toISOString(), to: to.toISOString() };
};

export const currentMonth = () => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
};

export const SERVICE_OPTIONS = [
  { value: 'ride', label: 'Ride' },
  { value: 'parcel', label: 'Parcel' },
  { value: 'intercity', label: 'Outstation' },
  { value: 'rental', label: 'Rental' },
];
