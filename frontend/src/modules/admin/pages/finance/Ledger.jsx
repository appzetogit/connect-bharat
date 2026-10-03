import React, { useCallback, useEffect, useState } from 'react';
import { FileSearch, Loader2, RefreshCw } from 'lucide-react';

import AdminPageHeader from '../../components/ui/AdminPageHeader';
import { adminService } from '../../services/adminService';

// Unified money ledger: every wallet credit/debit, gateway capture, refund,
// payout and commission, as double-entry lines.

const ACCOUNT_TYPES = ['', 'user', 'driver', 'owner', 'corporate', 'platform', 'gateway'];
const CATEGORIES = [
  '', 'ride_fare', 'commission', 'tip', 'wallet_topup', 'wallet_transfer', 'refund', 'cancellation_fee',
  'withdrawal', 'withdrawal_reversal', 'payout', 'payout_reversal', 'gateway_collection', 'subscription',
  'corporate_charge', 'referral_bonus', 'bonus', 'adjustment', 'wallet_credit', 'wallet_debit', 'other',
];

const formatDateTime = (value) => {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  return date.toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
};

const money = (value) => `₹${Number(value || 0).toFixed(2)}`;
const label = (value) => String(value || '').replace(/_/g, ' ');

const emptyFilters = { accountType: '', accountId: '', category: '', direction: 'credit', service: '', from: '', to: '', search: '' };

const Ledger = () => {
  const [filters, setFilters] = useState(emptyFilters);
  const [page, setPage] = useState(1);
  const [data, setData] = useState({ results: [], totals: {}, paginator: { last_page: 1, total: 0 } });
  const [summary, setSummary] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setIsLoading(true);
    setError('');
    try {
      const params = Object.fromEntries(Object.entries({ ...filters, page, limit: 50 }).filter(([, value]) => value !== ''));
      const [ledger, report] = await Promise.all([
        adminService.getPaymentLedger(params),
        adminService.getPaymentSummary({ from: filters.from || undefined, to: filters.to || undefined }),
      ]);
      if (ledger?.success) setData(ledger.data);
      if (report?.success) setSummary(report.data);
    } catch (loadError) {
      setError(loadError?.message || 'Could not load the ledger');
    } finally {
      setIsLoading(false);
    }
  }, [filters, page]);

  useEffect(() => {
    load();
  }, [load]);

  const update = (key, value) => {
    setFilters((current) => ({ ...current, [key]: value }));
    setPage(1);
  };

  const lastPage = Math.max(1, Number(data.paginator?.last_page || 1));
  const headline = summary?.headline || {};
  const tiles = [
    { key: 'gateway_collections', title: 'Gateway collections' },
    { key: 'wallet_topups', title: 'Wallet top-ups' },
    { key: 'commission', title: 'Commission' },
    { key: 'refunds', title: 'Refunds' },
    { key: 'payouts', title: 'Payouts' },
    { key: 'withdrawals', title: 'Withdrawals' },
  ];

  return (
    <div className="min-h-screen bg-gray-50 font-sans text-gray-950">
      <div className="px-4 py-2 lg:px-6 lg:py-2">
        <AdminPageHeader
          module="Finance"
          page="Ledger"
          title="Transaction Ledger"
          right={(
            <button
              type="button"
              onClick={load}
              className="flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-600 hover:bg-gray-50"
            >
              <RefreshCw size={15} /> Refresh
            </button>
          )}
        />

        <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
          {tiles.map((tile) => (
            <div key={tile.key} className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">{tile.title}</p>
              <p className="mt-1 text-lg font-bold text-gray-950">{money(headline[tile.key]?.amount)}</p>
              <p className="text-xs text-gray-400">{headline[tile.key]?.count || 0} entries</p>
            </div>
          ))}
        </div>

        <div className="mb-4 grid grid-cols-1 gap-3 rounded-xl border border-gray-200 bg-white p-4 shadow-sm sm:grid-cols-2 lg:grid-cols-8">
          <select value={filters.accountType} onChange={(event) => update('accountType', event.target.value)} className="h-9 rounded border border-gray-300 bg-white px-2 text-sm">
            {ACCOUNT_TYPES.map((type) => <option key={type || 'all'} value={type}>{type ? label(type) : 'All accounts'}</option>)}
          </select>
          <input value={filters.accountId} onChange={(event) => update('accountId', event.target.value.trim())} placeholder="Account id" className="h-9 rounded border border-gray-300 px-2 text-sm" />
          <select value={filters.category} onChange={(event) => update('category', event.target.value)} className="h-9 rounded border border-gray-300 bg-white px-2 text-sm">
            {CATEGORIES.map((category) => <option key={category || 'all'} value={category}>{category ? label(category) : 'All categories'}</option>)}
          </select>
          <select value={filters.direction} onChange={(event) => update('direction', event.target.value)} className="h-9 rounded border border-gray-300 bg-white px-2 text-sm" title="Each transfer has one credit and one debit line">
            <option value="credit">Credit lines</option>
            <option value="debit">Debit lines</option>
            <option value="">Both sides</option>
          </select>
          <input value={filters.service} onChange={(event) => update('service', event.target.value.trim())} placeholder="Service (ride, bus...)" className="h-9 rounded border border-gray-300 px-2 text-sm" />
          <input type="date" value={filters.from} onChange={(event) => update('from', event.target.value)} className="h-9 rounded border border-gray-300 px-2 text-sm" />
          <input type="date" value={filters.to} onChange={(event) => update('to', event.target.value ? `${event.target.value}T23:59:59` : '')} className="h-9 rounded border border-gray-300 px-2 text-sm" />
          <input value={filters.search} onChange={(event) => update('search', event.target.value)} placeholder="Search" className="h-9 rounded border border-gray-300 px-2 text-sm" />
        </div>

        {error ? <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div> : null}

        <div className="rounded-xl border border-gray-200 bg-white shadow-sm">
          <div className="overflow-x-auto">
            <table className="w-full text-left">
              <thead className="bg-gray-50">
                <tr>
                  {['Date', 'Account', 'Side', 'Amount', 'Category', 'Description', 'Reference', 'Gateway'].map((heading) => (
                    <th key={heading} className="px-4 py-3 text-xs font-bold uppercase tracking-wide text-gray-600">{heading}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {isLoading ? (
                  <tr><td colSpan="8" className="py-20 text-center text-slate-400"><Loader2 size={30} className="mx-auto animate-spin" /></td></tr>
                ) : data.results.length === 0 ? (
                  <tr>
                    <td colSpan="8" className="py-16 text-center text-slate-500">
                      <FileSearch size={40} strokeWidth={1.5} className="mx-auto mb-2 text-yellow-500 opacity-80" />
                      <p className="text-sm font-semibold">No ledger entries match these filters</p>
                    </td>
                  </tr>
                ) : (
                  data.results.map((entry) => (
                    <tr key={entry.entryId} className="text-sm hover:bg-gray-50">
                      <td className="whitespace-nowrap px-4 py-3 text-gray-700">{formatDateTime(entry.createdAt)}</td>
                      <td className="px-4 py-3">
                        <div className="capitalize text-gray-950">{entry.account?.type}{entry.account?.wallet ? ` · ${label(entry.account.wallet)}` : ''}</div>
                        <div className="font-mono text-xs text-gray-400">{entry.account?.id}</div>
                      </td>
                      <td className="px-4 py-3">
                        <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${entry.direction === 'credit' ? 'bg-emerald-50 text-emerald-700' : 'bg-rose-50 text-rose-600'}`}>{entry.direction}</span>
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 font-semibold text-gray-950">
                        {money(entry.amount)}
                        {entry.balanceAfter !== null && entry.balanceAfter !== undefined ? <div className="text-xs font-normal text-gray-400">bal {money(entry.balanceAfter)}</div> : null}
                      </td>
                      <td className="px-4 py-3 capitalize text-gray-700">{label(entry.category)}{entry.service ? <div className="text-xs text-gray-400">{entry.service}</div> : null}</td>
                      <td className="max-w-[240px] truncate px-4 py-3 text-gray-700" title={entry.description}>{entry.description || '-'}</td>
                      <td className="px-4 py-3 text-xs text-gray-500">
                        <div className="capitalize">{label(entry.reference?.kind)}</div>
                        <div className="font-mono text-gray-400">{entry.reference?.id}</div>
                      </td>
                      <td className="px-4 py-3 text-xs text-gray-500">
                        <div>{entry.gateway?.provider || '-'}</div>
                        <div className="font-mono text-gray-400">{entry.gateway?.paymentId || entry.gateway?.refundId || entry.gateway?.payoutId}</div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 px-5 py-3 text-sm text-slate-500">
            <span>
              {data.paginator?.total || 0} lines · credits {money(data.totals?.credit?.amount)} · debits {money(data.totals?.debit?.amount)}
            </span>
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

export default Ledger;
