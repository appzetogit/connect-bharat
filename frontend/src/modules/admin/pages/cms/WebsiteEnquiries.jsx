import React, { useCallback, useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { Loader2, Mail, Phone, RefreshCw } from 'lucide-react';
import { adminService } from '../../services/adminService';

/**
 * Leads captured from the public marketing forms.
 *
 * Before this existed the corporate, partner, driver, advertise and contact
 * forms discarded every submission, so this list starts empty rather than
 * showing history — there is none to show.
 */

const TYPES = [
  { key: '', label: 'All' },
  { key: 'corporate', label: 'Corporate' },
  { key: 'partner', label: 'Partner' },
  { key: 'driver', label: 'Driver' },
  { key: 'advertise', label: 'Advertise' },
  { key: 'contact', label: 'Contact' },
];

const STATUSES = ['new', 'contacted', 'closed'];

const STATUS_STYLES = {
  new: 'bg-yellow-100 text-yellow-800',
  contacted: 'bg-blue-100 text-blue-800',
  closed: 'bg-gray-100 text-gray-600',
};

const formatDate = (value) => {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? '' : date.toLocaleString();
};

export default function WebsiteEnquiries() {
  const [rows, setRows] = useState([]);
  const [newCount, setNewCount] = useState(0);
  const [type, setType] = useState('');
  const [status, setStatus] = useState('');
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await adminService.getWebsiteEnquiries({
        type: type || undefined,
        status: status || undefined,
        limit: 100,
      });
      const data = response?.data?.data || response?.data || {};
      setRows(Array.isArray(data.results) ? data.results : []);
      setNewCount(Number(data.newCount) || 0);
    } catch (error) {
      toast.error(error?.response?.data?.message || 'Could not load enquiries');
    } finally {
      setLoading(false);
    }
  }, [type, status]);

  useEffect(() => { load(); }, [load]);

  const setRowStatus = async (row, nextStatus) => {
    try {
      await adminService.updateWebsiteEnquiry(row._id, { status: nextStatus });
      setRows((previous) => previous.map((item) => (item._id === row._id ? { ...item, status: nextStatus } : item)));
      if (row.status === 'new' && nextStatus !== 'new') setNewCount((n) => Math.max(0, n - 1));
      toast.success(`Marked ${nextStatus}`);
    } catch (error) {
      toast.error(error?.response?.data?.message || 'Could not update');
    }
  };

  return (
    <div className="p-4 lg:p-6">
      <div className="flex items-start justify-between gap-4 mb-5">
        <div>
          <h1 className="text-xl font-bold text-gray-900">Website Enquiries</h1>
          <p className="text-sm text-gray-500 mt-1">
            Leads from the corporate, partner, driver, advertise and contact forms.
            {newCount > 0 && <span className="ml-1 font-semibold text-gray-900">{newCount} new.</span>}
          </p>
        </div>
        <button
          type="button"
          onClick={load}
          className="inline-flex items-center gap-2 text-sm font-medium text-gray-700 border border-gray-200 rounded-lg px-3 py-2 hover:bg-gray-50"
        >
          <RefreshCw size={14} /> Refresh
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-2 mb-4">
        {TYPES.map((item) => (
          <button
            key={item.key}
            type="button"
            onClick={() => setType(item.key)}
            className={`text-sm rounded-lg px-3 py-1.5 border transition-colors ${
              type === item.key
                ? 'bg-yellow-400 border-yellow-400 text-gray-900 font-semibold'
                : 'bg-white border-gray-200 text-gray-600 hover:bg-gray-50'
            }`}
          >
            {item.label}
          </button>
        ))}
        <span className="mx-2 h-5 w-px bg-gray-200" />
        <select
          value={status}
          onChange={(event) => setStatus(event.target.value)}
          className="text-sm border border-gray-200 rounded-lg px-3 py-1.5 bg-white"
        >
          <option value="">Any status</option>
          {STATUSES.map((value) => <option key={value} value={value}>{value}</option>)}
        </select>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-gray-500 py-16 justify-center">
          <Loader2 size={18} className="animate-spin" /> Loading…
        </div>
      ) : rows.length === 0 ? (
        <div className="bg-white border border-gray-200 rounded-xl p-10 text-center">
          <p className="text-sm text-gray-600">No enquiries yet.</p>
          <p className="text-xs text-gray-400 mt-1">
            New submissions from the website forms will appear here.
          </p>
        </div>
      ) : (
        <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-gray-600">
                <tr>
                  <th className="text-left font-medium px-4 py-3">Received</th>
                  <th className="text-left font-medium px-4 py-3">Type</th>
                  <th className="text-left font-medium px-4 py-3">Name</th>
                  <th className="text-left font-medium px-4 py-3">Contact</th>
                  <th className="text-left font-medium px-4 py-3">Details</th>
                  <th className="text-left font-medium px-4 py-3">Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row._id} className="border-t border-gray-100 align-top">
                    <td className="px-4 py-3 text-gray-500 whitespace-nowrap">{formatDate(row.createdAt)}</td>
                    <td className="px-4 py-3">
                      <span className="text-xs font-semibold uppercase tracking-wide text-gray-700">{row.type}</span>
                      {row.type === 'corporate' && (
                        <a
                          href={`/admin/corporates/create?enquiryId=${encodeURIComponent(row._id)}`}
                          className="block text-xs font-semibold text-emerald-700 mt-1 hover:underline"
                        >
                          Convert to corporate
                        </a>
                      )}
                    </td>
                    <td className="px-4 py-3 font-medium text-gray-900">{row.name}</td>
                    <td className="px-4 py-3">
                      {row.phone && (
                        <a href={`tel:${row.phone}`} className="flex items-center gap-1.5 text-gray-700 hover:text-gray-900">
                          <Phone size={12} /> {row.phone}
                        </a>
                      )}
                      {row.email && (
                        <a href={`mailto:${row.email}`} className="flex items-center gap-1.5 text-gray-700 hover:text-gray-900 mt-1">
                          <Mail size={12} /> {row.email}
                        </a>
                      )}
                    </td>
                    <td className="px-4 py-3 text-gray-600 max-w-sm">
                      {Object.entries(row.details || {}).map(([key, value]) => (
                        <div key={key} className="text-xs">
                          <span className="text-gray-400">{key}:</span> {String(value)}
                        </div>
                      ))}
                      {row.message && <p className="text-xs mt-1 whitespace-pre-wrap">{row.message}</p>}
                    </td>
                    <td className="px-4 py-3">
                      <select
                        value={row.status}
                        onChange={(event) => setRowStatus(row, event.target.value)}
                        className={`text-xs rounded-full px-2.5 py-1 font-semibold border-0 ${STATUS_STYLES[row.status] || ''}`}
                      >
                        {STATUSES.map((value) => <option key={value} value={value}>{value}</option>)}
                      </select>
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
