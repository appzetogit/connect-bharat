import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { Loader2, Plus, RefreshCw } from 'lucide-react';
import { corporateAdminService, errorText } from '../../services/corporateAdminService';
import { StatusPill, formatMoney } from './corporateUi';

const TABS = [
  { key: 'pending', label: 'Pending approval' },
  { key: 'approved', label: 'Approved' },
  { key: 'suspended', label: 'Suspended' },
  { key: 'rejected', label: 'Rejected' },
  { key: '', label: 'All' },
];

/** Corporate accounts: approval queue and the list of companies (SOW 8.1, 2.13). */
export default function CorporateList() {
  const navigate = useNavigate();
  const [status, setStatus] = useState('pending');
  const [search, setSearch] = useState('');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await corporateAdminService.list({ status: status || undefined, search: search || undefined, limit: 50 }));
    } catch (error) {
      toast.error(errorText(error, 'Could not load corporates'));
    } finally {
      setLoading(false);
    }
  }, [status, search]);

  useEffect(() => { load(); }, [load]);

  const reject = async (row) => {
    const reason = window.prompt(`Reason for rejecting ${row.name}`);
    if (!reason) return;
    try {
      await corporateAdminService.reject(row._id, reason);
      toast.success('Rejected');
      load();
    } catch (error) {
      toast.error(errorText(error));
    }
  };

  const counts = data?.statusCounts || {};

  return (
    <div className="p-4 lg:p-6">
      <div className="flex items-start justify-between gap-4 mb-5">
        <div>
          <h1 className="text-xl font-bold text-gray-900">Corporate Accounts</h1>
          <p className="text-sm text-gray-500 mt-1">Companies that bill employee trips on credit.</p>
        </div>
        <div className="flex gap-2">
          <button type="button" onClick={load} className="inline-flex items-center gap-2 text-sm font-medium text-gray-700 border border-gray-200 rounded-lg px-3 py-2 hover:bg-gray-50">
            <RefreshCw size={14} /> Refresh
          </button>
          <Link to="/admin/corporates/create" className="inline-flex items-center gap-2 text-sm font-semibold bg-gray-900 text-white rounded-lg px-3 py-2">
            <Plus size={14} /> New corporate
          </Link>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 mb-4">
        {TABS.map((tab) => (
          <button
            key={tab.key}
            type="button"
            onClick={() => setStatus(tab.key)}
            className={`text-sm rounded-lg px-3 py-1.5 border ${status === tab.key ? 'bg-yellow-400 border-yellow-400 text-gray-900 font-semibold' : 'bg-white border-gray-200 text-gray-600 hover:bg-gray-50'}`}
          >
            {tab.label}{tab.key && counts[tab.key] ? ` (${counts[tab.key]})` : ''}
          </button>
        ))}
        <input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search name, code, GSTIN"
          className="ml-auto text-sm border border-gray-200 rounded-lg px-3 py-1.5 bg-white w-64"
        />
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-gray-500 py-16 justify-center"><Loader2 size={18} className="animate-spin" /> Loading…</div>
      ) : !data?.items?.length ? (
        <div className="bg-white border border-gray-200 rounded-xl p-10 text-center text-sm text-gray-600">No corporates here.</div>
      ) : (
        <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-gray-600">
                <tr>
                  <th className="text-left font-medium px-4 py-3">Company</th>
                  <th className="text-left font-medium px-4 py-3">Contact</th>
                  <th className="text-right font-medium px-4 py-3">Employees</th>
                  <th className="text-right font-medium px-4 py-3">Credit limit</th>
                  <th className="text-right font-medium px-4 py-3">Outstanding</th>
                  <th className="text-left font-medium px-4 py-3">Status</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody>
                {data.items.map((row) => (
                  <tr key={row._id} className="border-t border-gray-100 align-top hover:bg-gray-50 cursor-pointer" onClick={() => navigate(`/admin/corporates/${row._id}`)}>
                    <td className="px-4 py-3">
                      <p className="font-medium text-gray-900">{row.name}</p>
                      <p className="text-xs text-gray-500">{row.code} {row.gstin ? `· ${row.gstin}` : ''} · {row.source}</p>
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-600">
                      <p>{row.contact?.name}</p>
                      <p>{row.contact?.email}</p>
                      <p>{row.contact?.phone}</p>
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">{row.activeEmployees}</td>
                    <td className="px-4 py-3 text-right tabular-nums">{formatMoney(row.creditLimit)}</td>
                    <td className="px-4 py-3 text-right tabular-nums">{formatMoney(row.currentOutstanding)}</td>
                    <td className="px-4 py-3"><StatusPill value={row.status} /></td>
                    <td className="px-4 py-3 text-right whitespace-nowrap" onClick={(event) => event.stopPropagation()}>
                      {row.status === 'pending' && (
                        <>
                          <Link to={`/admin/corporates/${row._id}?approve=1`} className="text-xs font-semibold text-emerald-700 mr-3">Review &amp; approve</Link>
                          <button type="button" onClick={() => reject(row)} className="text-xs font-semibold text-red-600">Reject</button>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
