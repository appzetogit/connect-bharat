/** Non-component helpers shared by the hub panel and the admin logistics pages. */

export const STATUS_TONES = {
  booked: 'bg-slate-100 text-slate-700',
  pickup_scheduled: 'bg-sky-50 text-sky-700',
  picked_up: 'bg-sky-100 text-sky-800',
  received_at_origin_hub: 'bg-indigo-50 text-indigo-700',
  in_transit: 'bg-amber-50 text-amber-800',
  received_at_destination_hub: 'bg-indigo-100 text-indigo-800',
  out_for_delivery: 'bg-violet-100 text-violet-800',
  delivered: 'bg-emerald-100 text-emerald-800',
  delivery_failed: 'bg-rose-100 text-rose-800',
  reattempt_scheduled: 'bg-orange-100 text-orange-800',
  rto_initiated: 'bg-fuchsia-100 text-fuchsia-800',
  rto_in_transit: 'bg-fuchsia-100 text-fuchsia-800',
  rto_delivered: 'bg-slate-200 text-slate-800',
  cancelled: 'bg-slate-100 text-slate-500',
  lost: 'bg-red-200 text-red-900',
  damaged: 'bg-red-100 text-red-800',
};

export const inputClass =
  'w-full px-3 py-2 bg-white border border-slate-300 rounded-lg text-[13px] text-slate-900 placeholder:text-slate-400 outline-none focus:border-slate-900 focus:ring-2 focus:ring-slate-900/10';

export const formatDateTime = (value) => {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
};

export const money = (value) => `₹${(Number(value) || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
