import { Loader2 } from 'lucide-react';
import { STATUS_TONES, formatDateTime } from './format';

/** Small shared building blocks for the hub panel. Plain Tailwind, slate. */


export const StatusBadge = ({ status, label }) => (
  <span className={`inline-flex items-center px-2 py-0.5 rounded-md text-[11px] font-semibold whitespace-nowrap ${STATUS_TONES[status] || 'bg-slate-100 text-slate-700'}`}>
    {label || String(status || '').replace(/_/g, ' ')}
  </span>
);

export const Card = ({ title, right, children, className = '' }) => (
  <section className={`bg-white border border-slate-200 rounded-xl ${className}`}>
    {(title || right) && (
      <header className="flex items-center justify-between gap-3 px-4 py-3 border-b border-slate-100">
        <h2 className="text-[14px] font-semibold text-slate-900">{title}</h2>
        {right}
      </header>
    )}
    <div className="p-4">{children}</div>
  </section>
);

export const Button = ({ children, variant = 'primary', loading = false, className = '', ...props }) => {
  const tones = {
    primary: 'bg-slate-900 text-white hover:bg-slate-800 disabled:bg-slate-400',
    secondary: 'bg-white text-slate-800 border border-slate-300 hover:bg-slate-50 disabled:text-slate-400',
    danger: 'bg-rose-600 text-white hover:bg-rose-700 disabled:bg-rose-300',
    success: 'bg-emerald-600 text-white hover:bg-emerald-700 disabled:bg-emerald-300',
  };
  return (
    <button
      type="button"
      className={`inline-flex items-center justify-center gap-2 px-3.5 py-2 rounded-lg text-[13px] font-medium transition disabled:cursor-not-allowed ${tones[variant]} ${className}`}
      disabled={loading || props.disabled}
      {...props}
    >
      {loading && <Loader2 size={14} className="animate-spin" />}
      {children}
    </button>
  );
};


export const Field = ({ label, children, hint }) => (
  <label className="block">
    <span className="block text-[12px] font-medium text-slate-600 mb-1">{label}</span>
    {children}
    {hint && <span className="block text-[11px] text-slate-400 mt-1">{hint}</span>}
  </label>
);

export const Stat = ({ label, value, tone = 'text-slate-900', hint }) => (
  <div className="bg-white border border-slate-200 rounded-xl px-4 py-3">
    <div className="text-[12px] text-slate-500">{label}</div>
    <div className={`text-2xl font-semibold mt-1 tabular-nums ${tone}`}>{value ?? '—'}</div>
    {hint && <div className="text-[11px] text-slate-400 mt-0.5">{hint}</div>}
  </div>
);

export const Empty = ({ children = 'Nothing here.' }) => (
  <div className="py-10 text-center text-[13px] text-slate-400">{children}</div>
);

export const PageTitle = ({ title, subtitle, right }) => (
  <div className="flex flex-wrap items-end justify-between gap-3 mb-5">
    <div>
      <h1 className="text-xl font-semibold text-slate-900">{title}</h1>
      {subtitle && <p className="text-[13px] text-slate-500 mt-0.5">{subtitle}</p>}
    </div>
    {right}
  </div>
);

/** A compact shipment table used by most hub screens. */
export const ShipmentTable = ({ rows = [], onOpen, actions }) => {
  if (!rows.length) return <Empty>No parcels.</Empty>;
  return (
    <div className="overflow-x-auto -mx-4">
      <table className="w-full text-[13px]">
        <thead>
          <tr className="text-left text-[11px] uppercase tracking-wide text-slate-400 border-b border-slate-100">
            <th className="px-4 py-2 font-medium">AWB</th>
            <th className="px-4 py-2 font-medium">Status</th>
            <th className="px-4 py-2 font-medium">Route</th>
            <th className="px-4 py-2 font-medium">Receiver</th>
            <th className="px-4 py-2 font-medium">Weight</th>
            <th className="px-4 py-2 font-medium">Updated</th>
            {actions && <th className="px-4 py-2" />}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id} className="border-b border-slate-50 hover:bg-slate-50/60">
              <td className="px-4 py-2 font-mono text-[12px]">
                <button type="button" className="text-slate-900 hover:underline" onClick={() => onOpen?.(row)}>
                  {row.awb}
                </button>
                <div className="flex gap-1 mt-0.5">
                  {row.express && <span className="text-[10px] font-semibold text-amber-700">EXPRESS</span>}
                  {row.fragile && <span className="text-[10px] font-semibold text-rose-700">FRAGILE</span>}
                  {row.payment?.method === 'cod' && <span className="text-[10px] font-semibold text-emerald-700">COD</span>}
                </div>
              </td>
              <td className="px-4 py-2"><StatusBadge status={row.status} label={row.displayStatus} /></td>
              <td className="px-4 py-2 text-slate-600 whitespace-nowrap">
                {(row.originHub?.code || '—')} → {(row.destinationHub?.code || '—')}
              </td>
              <td className="px-4 py-2 text-slate-600">{row.receiver?.name}<div className="text-[11px] text-slate-400">{row.receiver?.phone}</div></td>
              <td className="px-4 py-2 tabular-nums">{row.chargeableWeight} kg</td>
              <td className="px-4 py-2 text-slate-500 whitespace-nowrap">{formatDateTime(row.statusUpdatedAt)}</td>
              {actions && <td className="px-4 py-2 text-right whitespace-nowrap">{actions(row)}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

export const Modal = ({ open, title, onClose, children, footer }) => {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4" onClick={onClose}>
      <div className="w-full max-w-lg bg-white rounded-xl shadow-xl" onClick={(event) => event.stopPropagation()}>
        <header className="px-5 py-3 border-b border-slate-100 flex items-center justify-between">
          <h3 className="text-[15px] font-semibold text-slate-900">{title}</h3>
          <button type="button" onClick={onClose} className="text-slate-400 hover:text-slate-700 text-lg leading-none">×</button>
        </header>
        <div className="p-5 space-y-3 max-h-[70vh] overflow-y-auto">{children}</div>
        {footer && <footer className="px-5 py-3 border-t border-slate-100 flex justify-end gap-2">{footer}</footer>}
      </div>
    </div>
  );
};
