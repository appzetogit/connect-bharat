import React, { useCallback, useEffect, useState } from 'react';
import { Check, FileSearch, Loader2, Plus, RefreshCw, X } from 'lucide-react';

import AdminPageHeader from '../../components/ui/AdminPageHeader';
import { adminService } from '../../services/adminService';

// Refund queue. With payments.auto_refund_enabled off (the default) every
// cancel that owes money lands here as "requested" for an admin to approve.

const STATUS_TABS = [
  { id: 'requested', label: 'Awaiting approval' },
  { id: 'processing', label: 'Processing' },
  { id: 'processed', label: 'Processed' },
  { id: 'failed', label: 'Failed' },
  { id: 'rejected', label: 'Rejected' },
  { id: '', label: 'All' },
];

const REFERENCE_KINDS = [
  { id: 'ride', label: 'Ride / parcel / outstation' },
  { id: 'bus_booking', label: 'Bus booking' },
  { id: 'pooling_booking', label: 'Pooling booking' },
  { id: 'rental_booking', label: 'Rental booking' },
];

const statusClass = (status) => {
  switch (String(status || '').toLowerCase()) {
    case 'processed':
      return 'bg-emerald-50 text-emerald-700';
    case 'failed':
    case 'rejected':
      return 'bg-red-50 text-red-600';
    case 'processing':
      return 'bg-sky-50 text-sky-700';
    default:
      return 'bg-amber-50 text-amber-700';
  }
};

const formatDateTime = (value) => {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  return date.toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
};

const money = (value) => `₹${Number(value || 0).toFixed(2)}`;

const emptyForm = { referenceKind: 'ride', referenceId: '', amount: '', destination: 'source', reason: '' };

const Refunds = () => {
  const [status, setStatus] = useState('requested');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [data, setData] = useState({ results: [], counts: {}, paginator: { last_page: 1, total: 0 } });
  const [isLoading, setIsLoading] = useState(true);
  const [busyId, setBusyId] = useState('');
  const [notice, setNotice] = useState(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const load = useCallback(async () => {
    setIsLoading(true);
    try {
      const response = await adminService.getPaymentRefunds({ status: status || undefined, search: search || undefined, page, limit: 20 });
      if (response?.success) setData(response.data);
    } catch (error) {
      setNotice({ type: 'error', text: error?.message || 'Could not load refunds' });
    } finally {
      setIsLoading(false);
    }
  }, [status, search, page]);

  useEffect(() => {
    load();
  }, [load]);

  const act = async (refund, action) => {
    if (action === 'approve' && !window.confirm(`Send ${money(refund.amount)} back via ${refund.provider}?`)) return;
    let reason = '';
    if (action === 'reject') {
      reason = window.prompt('Reason for rejecting this refund?') || '';
      if (!reason) return;
    }

    setBusyId(refund._id);
    try {
      const response = action === 'approve'
        ? await adminService.approvePaymentRefund(refund._id)
        : await adminService.rejectPaymentRefund(refund._id, reason);
      setNotice({ type: response?.data?.refund?.status === 'failed' ? 'error' : 'success', text: response?.message || 'Done' });
      await load();
    } catch (error) {
      setNotice({ type: 'error', text: error?.message || 'Action failed' });
    } finally {
      setBusyId('');
    }
  };

  const submitManualRefund = async (event) => {
    event.preventDefault();
    if (!form.referenceId.trim()) {
      setNotice({ type: 'error', text: 'Booking id is required' });
      return;
    }
    if (!window.confirm('Create this refund? It is sent immediately.')) return;

    setIsSubmitting(true);
    try {
      const response = await adminService.createPaymentRefund({
        referenceKind: form.referenceKind,
        referenceId: form.referenceId.trim(),
        ...(form.amount ? { amount: Number(form.amount) } : {}),
        destination: form.destination,
        reason: form.reason || undefined,
      });
      setNotice({ type: response?.data?.refund?.status === 'failed' ? 'error' : 'success', text: response?.message || 'Refund created' });
      setForm(emptyForm);
      setShowForm(false);
      setStatus('');
      setPage(1);
    } catch (error) {
      setNotice({ type: 'error', text: error?.message || 'Could not create refund' });
    } finally {
      setIsSubmitting(false);
    }
  };

  const counts = data.counts || {};
  const lastPage = Math.max(1, Number(data.paginator?.last_page || 1));

  return (
    <div className="min-h-screen bg-gray-50 font-sans text-gray-950">
      <div className="px-4 py-2 lg:px-6 lg:py-2">
        <AdminPageHeader
          module="Finance"
          page="Refunds"
          title="Refunds"
          right={(
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={load}
                className="flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-600 hover:bg-gray-50"
              >
                <RefreshCw size={15} /> Refresh
              </button>
              <button
                type="button"
                onClick={() => setShowForm((value) => !value)}
                className="flex items-center gap-2 rounded-lg bg-gray-900 px-3 py-2 text-sm font-semibold text-white hover:opacity-90"
              >
                <Plus size={15} /> Manual refund
              </button>
            </div>
          )}
        />

        {notice ? (
          <div className={`mb-4 flex items-start justify-between rounded-lg border px-4 py-3 text-sm ${notice.type === 'error' ? 'border-red-200 bg-red-50 text-red-700' : 'border-emerald-200 bg-emerald-50 text-emerald-700'}`}>
            <span>{notice.text}</span>
            <button type="button" onClick={() => setNotice(null)} aria-label="Dismiss"><X size={16} /></button>
          </div>
        ) : null}

        {showForm ? (
          <form onSubmit={submitManualRefund} className="mb-4 grid grid-cols-1 gap-3 rounded-xl border border-gray-200 bg-white p-5 shadow-sm md:grid-cols-6">
            <label className="text-xs font-medium text-slate-500 md:col-span-1">
              Booking type
              <select
                value={form.referenceKind}
                onChange={(event) => setForm({ ...form, referenceKind: event.target.value })}
                className="mt-1 h-9 w-full rounded border border-gray-300 bg-white px-2 text-sm text-gray-950"
              >
                {REFERENCE_KINDS.map((kind) => <option key={kind.id} value={kind.id}>{kind.label}</option>)}
              </select>
            </label>
            <label className="text-xs font-medium text-slate-500 md:col-span-2">
              Booking id
              <input
                value={form.referenceId}
                onChange={(event) => setForm({ ...form, referenceId: event.target.value })}
                placeholder="Mongo id of the ride/booking"
                className="mt-1 h-9 w-full rounded border border-gray-300 px-2 text-sm text-gray-950"
              />
            </label>
            <label className="text-xs font-medium text-slate-500">
              Amount (₹)
              <input
                type="number"
                min="0"
                step="0.01"
                value={form.amount}
                onChange={(event) => setForm({ ...form, amount: event.target.value })}
                placeholder="Full payment"
                className="mt-1 h-9 w-full rounded border border-gray-300 px-2 text-sm text-gray-950"
              />
            </label>
            <label className="text-xs font-medium text-slate-500">
              Refund to
              <select
                value={form.destination}
                onChange={(event) => setForm({ ...form, destination: event.target.value })}
                className="mt-1 h-9 w-full rounded border border-gray-300 bg-white px-2 text-sm text-gray-950"
              >
                <option value="source">Original payment</option>
                <option value="wallet">User wallet</option>
                <option value="refund_wallet">Refund wallet</option>
              </select>
            </label>
            <div className="flex items-end">
              <button
                type="submit"
                disabled={isSubmitting}
                className="h-9 w-full rounded bg-yellow-400 text-sm font-bold text-black disabled:opacity-60"
              >
                {isSubmitting ? 'Sending...' : 'Refund'}
              </button>
            </div>
            <label className="text-xs font-medium text-slate-500 md:col-span-6">
              Reason
              <input
                value={form.reason}
                onChange={(event) => setForm({ ...form, reason: event.target.value })}
                placeholder="Shown to the customer"
                className="mt-1 h-9 w-full rounded border border-gray-300 px-2 text-sm text-gray-950"
              />
            </label>
          </form>
        ) : null}

        <div className="rounded-xl border border-gray-200 bg-white shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-gray-100 px-5 py-3">
            <div className="flex flex-wrap gap-2">
              {STATUS_TABS.map((tab) => (
                <button
                  key={tab.id || 'all'}
                  type="button"
                  onClick={() => { setStatus(tab.id); setPage(1); }}
                  className={`rounded-full px-3 py-1 text-xs font-semibold ${status === tab.id ? 'bg-gray-900 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}
                >
                  {tab.label}
                  {tab.id && counts[tab.id] ? ` (${counts[tab.id].count})` : ''}
                </button>
              ))}
            </div>
            <input
              value={search}
              onChange={(event) => { setSearch(event.target.value); setPage(1); }}
              placeholder="Search refund no, booking, payment id"
              className="h-9 w-full rounded border border-gray-300 px-3 text-sm sm:w-72"
            />
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left">
              <thead className="bg-gray-50">
                <tr>
                  {['Created', 'Refund', 'Customer', 'For', 'Amount', 'Via', 'Status', 'Action'].map((label) => (
                    <th key={label} className="px-4 py-3 text-xs font-bold uppercase tracking-wide text-gray-600">{label}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {isLoading ? (
                  <tr>
                    <td colSpan="8" className="py-20 text-center text-slate-400">
                      <Loader2 size={30} className="mx-auto animate-spin" />
                    </td>
                  </tr>
                ) : data.results.length === 0 ? (
                  <tr>
                    <td colSpan="8" className="py-16 text-center text-slate-500">
                      <FileSearch size={40} strokeWidth={1.5} className="mx-auto mb-2 text-yellow-500 opacity-80" />
                      <p className="text-sm font-semibold">No refunds here</p>
                    </td>
                  </tr>
                ) : (
                  data.results.map((refund) => (
                    <tr key={refund._id} className="text-sm hover:bg-gray-50">
                      <td className="px-4 py-3 text-gray-700">{formatDateTime(refund.createdAt)}</td>
                      <td className="px-4 py-3">
                        <div className="font-semibold text-gray-950">{refund.refundNumber}</div>
                        <div className="max-w-[220px] truncate text-xs text-gray-500" title={refund.reason}>{refund.reason || '-'}</div>
                      </td>
                      <td className="px-4 py-3 text-gray-700">
                        {refund.user?.name || '-'}
                        <div className="text-xs text-gray-400">{refund.user?.phone || ''}</div>
                      </td>
                      <td className="px-4 py-3 text-gray-700">
                        <div className="capitalize">{String(refund.reference?.kind || '').replace(/_/g, ' ')}</div>
                        <div className="font-mono text-xs text-gray-400">{refund.reference?.id}</div>
                      </td>
                      <td className="px-4 py-3 font-semibold text-gray-950">{money(refund.amount)}</td>
                      <td className="px-4 py-3 text-gray-700">
                        <div className="capitalize">{refund.provider}{refund.destination !== 'source' ? ` (${refund.destination.replace('_', ' ')})` : ''}</div>
                        <div className="font-mono text-xs text-gray-400">{refund.gateway?.refundId || refund.gateway?.paymentId}</div>
                      </td>
                      <td className="px-4 py-3">
                        <span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-semibold capitalize ${statusClass(refund.status)}`}>{refund.status}</span>
                        {refund.failureReason ? <div className="mt-1 max-w-[200px] text-xs text-red-500">{refund.failureReason}</div> : null}
                      </td>
                      <td className="px-4 py-3">
                        {['requested', 'failed'].includes(refund.status) ? (
                          <div className="flex gap-2">
                            <button
                              type="button"
                              disabled={busyId === refund._id}
                              onClick={() => act(refund, 'approve')}
                              className="inline-flex items-center gap-1 rounded bg-emerald-50 px-2.5 py-1.5 text-xs font-semibold text-emerald-700 hover:bg-emerald-100 disabled:opacity-50"
                            >
                              <Check size={14} /> {refund.status === 'failed' ? 'Retry' : 'Approve'}
                            </button>
                            <button
                              type="button"
                              disabled={busyId === refund._id}
                              onClick={() => act(refund, 'reject')}
                              className="inline-flex items-center gap-1 rounded bg-red-50 px-2.5 py-1.5 text-xs font-semibold text-red-600 hover:bg-red-100 disabled:opacity-50"
                            >
                              <X size={14} /> Reject
                            </button>
                          </div>
                        ) : (
                          <span className="text-xs text-gray-400">{refund.processedAt ? formatDateTime(refund.processedAt) : '-'}</span>
                        )}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          <div className="flex items-center justify-between px-5 py-3 text-sm text-slate-500">
            <span>{data.paginator?.total || 0} refunds</span>
            <div className="flex items-center gap-2">
              <button type="button" disabled={page <= 1} onClick={() => setPage(page - 1)} className="rounded border border-gray-200 px-3 py-1.5 disabled:opacity-50">Prev</button>
              <span>{page} / {lastPage}</span>
              <button type="button" disabled={page >= lastPage} onClick={() => setPage(page + 1)} className="rounded border border-gray-200 px-3 py-1.5 disabled:opacity-50">Next</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default Refunds;
