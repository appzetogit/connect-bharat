import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import toast from 'react-hot-toast';
import { ArrowLeft, Download, Loader2 } from 'lucide-react';
import { corporateAdminService, errorText } from '../../services/corporateAdminService';
import { Field, StatusPill, TermsFields, formatDate, formatMoney, inputClass, termsPayload } from './corporateUi';
import CommercialFields from './CommercialFields';
import { commercialPayload, commercialToForm, useAdminVehicleTypes, validateCommercial } from './corporateCommercial';
import TravelZoneEditor from '../../../corporate/components/TravelZoneEditor';
import RolesManager from '../../../corporate/components/RolesManager';
import ChangeRoleModal from '../../../corporate/components/ChangeRoleModal';
import InvoiceBreakdown from '../../../corporate/components/InvoiceBreakdown';
import { Drawer } from '../../../corporate/components/ui';
import { formatKm, travelZoneToBody, travelZoneToForm, validateTravelZone } from '../../../corporate/components/helpers';

const TABS = ['overview', 'employees', 'roles', 'allowance', 'invoices', 'ledger', 'trips'];

/** ISO week key, e.g. "2026-W41" — the same format as `<input type="week">`. */
const isoWeekKey = (date = new Date()) => {
  const day = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const weekday = day.getUTCDay() || 7;
  day.setUTCDate(day.getUTCDate() + 4 - weekday);
  const yearStart = new Date(Date.UTC(day.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((day - yearStart) / 864e5 + 1) / 7);
  return `${day.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
};

const thisMonth = () => {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
};

function AllowanceTab({ corporateId }) {
  const [period, setPeriod] = useState('monthly');
  const [month, setMonth] = useState(thisMonth());
  const [week, setWeek] = useState(isoWeekKey());
  const [rows, setRows] = useState(null);
  const periodKey = period === 'weekly' ? week : month;

  useEffect(() => {
    let alive = true;
    corporateAdminService
      .allowance(corporateId, { periodKey })
      .then((data) => { if (alive) setRows(Array.isArray(data) ? data : data?.results || data?.items || []); })
      .catch((error) => { if (alive) { toast.error(errorText(error)); setRows([]); } });
    return () => { alive = false; };
  }, [corporateId, periodKey]);

  return (
    <div className="space-y-4">
      <div className="bg-white border border-gray-200 rounded-xl p-4 flex flex-wrap items-end gap-3">
        <Field label="Period type">
          <select className={inputClass} value={period} onChange={(e) => { setPeriod(e.target.value); setRows(null); }}>
            <option value="monthly">Monthly allowances</option>
            <option value="weekly">Weekly allowances</option>
          </select>
        </Field>
        {period === 'weekly'
          ? <Field label="Week"><input type="week" className={inputClass} value={week} onChange={(e) => { if (e.target.value) { setWeek(e.target.value); setRows(null); } }} /></Field>
          : <Field label="Month"><input type="month" className={inputClass} value={month} onChange={(e) => { if (e.target.value) { setMonth(e.target.value); setRows(null); } }} /></Field>}
        <p className="text-xs text-gray-500">Each employee's km usage for <span className="font-mono">{periodKey}</span>. Only roles with an allowance on a {period === 'weekly' ? 'weekly' : 'monthly'} period have usage here.</p>
      </div>
      {!rows ? <Loader2 className="animate-spin text-gray-400" /> : !rows.length ? (
        <p className="text-sm text-gray-500">No allowance usage for this period.</p>
      ) : (
        <div className="bg-white border border-gray-200 rounded-xl overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-gray-600">
              <tr>
                <th className="text-left font-medium px-4 py-3">Employee</th>
                <th className="text-left font-medium px-4 py-3">Role</th>
                <th className="text-right font-medium px-4 py-3">Allowance</th>
                <th className="text-right font-medium px-4 py-3">Used</th>
                <th className="text-right font-medium px-4 py-3">Reserved</th>
                <th className="text-right font-medium px-4 py-3">Remaining</th>
                <th className="text-right font-medium px-4 py-3">Trips</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const remaining = row.remainingKm ?? Math.max(0, (row.allowanceKm || 0) - (row.usedKm || 0) - (row.reservedKm || 0));
                return (
                  <tr key={row.employeeId || row._id} className="border-t border-gray-100">
                    <td className="px-4 py-3"><p className="font-medium">{row.name || row.employee?.name || '-'}</p><p className="text-xs text-gray-500 font-mono">{row.employeeCode || row.employee?.employeeCode || ''}</p></td>
                    <td className="px-4 py-3">{row.role?.name || row.roleName || '-'}</td>
                    <td className="px-4 py-3 text-right tabular-nums">{formatKm(row.allowanceKm)}</td>
                    <td className="px-4 py-3 text-right tabular-nums">{formatKm(row.usedKm)}</td>
                    <td className="px-4 py-3 text-right tabular-nums">{formatKm(row.reservedKm)}</td>
                    <td className={`px-4 py-3 text-right tabular-nums ${remaining <= 0 ? 'text-red-600 font-semibold' : ''}`}>{formatKm(remaining)}</td>
                    <td className="px-4 py-3 text-right tabular-nums">{row.rides || 0}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function EmployeesTab({ corporateId }) {
  const [rows, setRows] = useState(null);
  const [roles, setRoles] = useState([]);
  const [roleFilter, setRoleFilter] = useState('');
  const [selected, setSelected] = useState([]);
  const [changing, setChanging] = useState(false);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let alive = true;
    corporateAdminService
      .employees(corporateId, { limit: 200, ...(roleFilter ? { roleId: roleFilter } : {}) })
      .then((data) => { if (alive) setRows(data.items || []); })
      .catch((error) => { if (alive) { toast.error(errorText(error)); setRows([]); } });
    corporateAdminService
      .roles(corporateId)
      .then((data) => { if (alive) setRoles([...(data?.results || [])].sort((a, b) => (b.level || 0) - (a.level || 0))); })
      .catch(() => null);
    return () => { alive = false; };
  }, [corporateId, roleFilter, version]);

  const ids = (rows || []).map((row) => row._id);
  const all = ids.length > 0 && ids.every((rowId) => selected.includes(rowId));
  const toggle = (rowId) => setSelected((previous) => (previous.includes(rowId) ? previous.filter((item) => item !== rowId) : [...previous, rowId]));

  const assign = async (roleId) => {
    try {
      await corporateAdminService.assignRole(corporateId, roleId, selected);
      toast.success('Role changed');
      setSelected([]);
      setChanging(false);
      setVersion((value) => value + 1);
    } catch (error) {
      toast.error(errorText(error));
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <select className={`${inputClass} w-48`} value={roleFilter} onChange={(e) => { setRoleFilter(e.target.value); setSelected([]); setRows(null); }}>
          <option value="">All roles</option>
          {roles.map((role) => <option key={role._id || role.id} value={role._id || role.id}>{role.name}</option>)}
        </select>
        {selected.length > 0 && (
          <>
            <span className="text-sm text-gray-600">{selected.length} selected</span>
            <button type="button" onClick={() => setChanging(true)} className="text-sm font-semibold bg-gray-900 text-white rounded-lg px-3 py-2">Change role</button>
            <button type="button" onClick={() => setSelected([])} className="text-sm text-gray-500">Clear</button>
          </>
        )}
      </div>
      {!rows ? <Loader2 className="animate-spin text-gray-400" /> : !rows.length ? (
        <p className="text-sm text-gray-500">No employees yet. The company adds them from its panel.</p>
      ) : (
        <div className="bg-white border border-gray-200 rounded-xl overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-gray-600">
              <tr>
                <th className="px-4 py-3 text-left"><input type="checkbox" aria-label="Select all" checked={all} onChange={() => setSelected(all ? [] : ids)} /></th>
                <th className="text-left font-medium px-4 py-3">Name</th>
                <th className="text-left font-medium px-4 py-3">Phone</th>
                <th className="text-left font-medium px-4 py-3">Role</th>
                <th className="text-left font-medium px-4 py-3">Department</th>
                <th className="text-right font-medium px-4 py-3">Km allowance</th>
                <th className="text-right font-medium px-4 py-3">Monthly limit</th>
                <th className="text-left font-medium px-4 py-3">Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row._id} className="border-t border-gray-100">
                  <td className="px-4 py-3"><input type="checkbox" aria-label={`Select ${row.name}`} checked={selected.includes(row._id)} onChange={() => toggle(row._id)} /></td>
                  <td className="px-4 py-3"><p className="font-medium">{row.name}</p><p className="text-xs text-gray-500 font-mono">{row.employeeCode}</p></td>
                  <td className="px-4 py-3">{row.phone}</td>
                  <td className="px-4 py-3">{row.role?.name || '-'}</td>
                  <td className="px-4 py-3">{row.departmentId?.name || 'Unassigned'}</td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    {Number(row.allowance?.allowanceKm) > 0
                      ? <span>{formatKm(row.allowance.usedKm)} / {formatKm(row.allowance.allowanceKm)}<span className="block text-xs text-gray-500">{formatKm(row.allowance.remainingKm)} left · {row.allowance.periodKey}</span></span>
                      : '-'}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">{row.monthlyLimit ? formatMoney(row.monthlyLimit) : '-'}</td>
                  <td className="px-4 py-3">{row.active ? 'Active' : 'Deactivated'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <ChangeRoleModal open={changing} count={selected.length} roles={roles} onClose={() => setChanging(false)} onConfirm={assign} />
    </div>
  );
}

function AdminInvoiceDrawer({ invoiceId, onClose }) {
  const [invoice, setInvoice] = useState(null);
  useEffect(() => {
    corporateAdminService.invoice(invoiceId).then(setInvoice).catch((error) => { toast.error(errorText(error)); onClose(); });
  }, [invoiceId, onClose]);
  return (
    <Drawer open title={invoice?.invoiceNumber || 'Invoice'} subtitle={invoice?.periodKey} onClose={onClose}>
      {!invoice ? <Loader2 className="animate-spin text-gray-400" /> : <InvoiceBreakdown invoice={invoice} />}
    </Drawer>
  );
}

const Stat = ({ label, value }) => (
  <div className="bg-white border border-gray-200 rounded-xl p-4">
    <p className="text-xs text-gray-500 uppercase tracking-wide">{label}</p>
    <p className="text-xl font-bold text-gray-900 mt-1 tabular-nums">{value}</p>
  </div>
);

const monthBounds = (month) => {
  const [year, mon] = month.split('-').map(Number);
  return { from: new Date(year, mon - 1, 1).toISOString(), to: new Date(year, mon, 1).toISOString(), periodKey: month };
};

const previousMonth = () => {
  const date = new Date();
  date.setDate(1);
  date.setMonth(date.getMonth() - 1);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
};

function InvoicesTab({ corporateId, onChange }) {
  const [data, setData] = useState(null);
  const [month, setMonth] = useState(previousMonth());
  const [busy, setBusy] = useState('');
  const [viewing, setViewing] = useState('');
  const closeViewing = useCallback(() => setViewing(''), []);
  const fileBase = (invoice) => invoice.invoiceNumber.replace(/\W+/g, '_');
  const exportInvoice = (invoice, format) =>
    corporateAdminService.exportInvoice(invoice._id, format, `${fileBase(invoice)}.${format}`).catch((error) => toast.error(errorText(error)));

  const load = useCallback(async () => {
    try {
      setData(await corporateAdminService.invoices(corporateId, { limit: 50 }));
    } catch (error) {
      toast.error(errorText(error));
    }
  }, [corporateId]);
  useEffect(() => { load(); }, [load]);

  const run = async (key, fn, message) => {
    setBusy(key);
    try {
      await fn();
      if (message) toast.success(message);
      await load();
      onChange?.();
    } catch (error) {
      toast.error(errorText(error));
    } finally {
      setBusy('');
    }
  };

  const recordPayment = (invoice) => {
    const amount = window.prompt(`Amount received for ${invoice.invoiceNumber} (due ${invoice.balanceDue})`, String(invoice.balanceDue));
    if (!amount) return;
    const reference = window.prompt('Reference (UTR / cheque no.)', '') || '';
    run(invoice._id, () => corporateAdminService.recordPayment(invoice._id, { amount: Number(amount), method: 'bank_transfer', reference }), 'Payment recorded');
  };

  return (
    <div className="space-y-4">
      <div className="bg-white border border-gray-200 rounded-xl p-4 flex flex-wrap items-end gap-3">
        <Field label="Billing month"><input type="month" className={inputClass} value={month} onChange={(e) => setMonth(e.target.value)} /></Field>
        <button
          type="button"
          disabled={Boolean(busy)}
          onClick={() => run('generate', () => corporateAdminService.generateInvoice(corporateId, monthBounds(month)), 'Draft invoice generated')}
          className="text-sm font-semibold bg-gray-900 text-white rounded-lg px-3 py-2 disabled:opacity-50"
        >
          {busy === 'generate' ? 'Generating…' : 'Generate / refresh draft'}
        </button>
        <p className="text-xs text-gray-500">A draft can be regenerated until it is issued. Issued invoices are emailed to the billing contact.</p>
      </div>
      {!data ? <Loader2 className="animate-spin text-gray-400" /> : !data.items.length ? (
        <p className="text-sm text-gray-500">No invoices yet.</p>
      ) : (
        <div className="bg-white border border-gray-200 rounded-xl overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-gray-600">
              <tr>
                <th className="text-left font-medium px-4 py-3">Invoice</th>
                <th className="text-right font-medium px-4 py-3">Trips</th>
                <th className="text-right font-medium px-4 py-3">Total</th>
                <th className="text-right font-medium px-4 py-3">Balance</th>
                <th className="text-left font-medium px-4 py-3">Due</th>
                <th className="text-left font-medium px-4 py-3">Status</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {data.items.map((invoice) => (
                <tr key={invoice._id} className="border-t border-gray-100">
                  <td className="px-4 py-3"><p className="font-medium">{invoice.invoiceNumber}</p><p className="text-xs text-gray-500">{invoice.periodKey}</p></td>
                  <td className="px-4 py-3 text-right tabular-nums">{invoice.tripCount}</td>
                  <td className="px-4 py-3 text-right tabular-nums">{formatMoney(invoice.total)}</td>
                  <td className="px-4 py-3 text-right tabular-nums">{formatMoney(invoice.balanceDue)}</td>
                  <td className="px-4 py-3">{formatDate(invoice.dueDate)}</td>
                  <td className="px-4 py-3"><StatusPill value={invoice.status} /></td>
                  <td className="px-4 py-3 whitespace-nowrap text-right space-x-3 text-xs font-semibold">
                    <button type="button" onClick={() => setViewing(invoice._id)} className="text-gray-700">View</button>
                    <button type="button" onClick={() => corporateAdminService.downloadInvoicePdf(invoice._id, `${fileBase(invoice)}.pdf`).catch((error) => toast.error(errorText(error)))} className="text-gray-700 inline-flex items-center gap-1"><Download size={12} /> PDF</button>
                    <button type="button" onClick={() => exportInvoice(invoice, 'csv')} className="text-gray-700 inline-flex items-center gap-1"><Download size={12} /> CSV</button>
                    <button type="button" onClick={() => exportInvoice(invoice, 'xlsx')} className="text-gray-700 inline-flex items-center gap-1"><Download size={12} /> XLSX</button>
                    {invoice.status === 'draft' && (
                      <>
                        <button type="button" disabled={Boolean(busy)} onClick={() => run(invoice._id, () => corporateAdminService.generateInvoice(corporateId, { from: invoice.periodFrom, to: invoice.periodTo, periodKey: invoice.periodKey }), 'Draft refreshed')} className="text-gray-700">Refresh</button>
                        <button type="button" disabled={Boolean(busy)} onClick={() => run(invoice._id, () => corporateAdminService.issueInvoice(invoice._id, true), 'Issued and emailed')} className="text-emerald-700">Issue</button>
                      </>
                    )}
                    {['issued', 'partially_paid', 'overdue'].includes(invoice.status) && (
                      <>
                        <button type="button" disabled={Boolean(busy)} onClick={() => recordPayment(invoice)} className="text-emerald-700">Record payment</button>
                        <button type="button" disabled={Boolean(busy)} onClick={() => run(invoice._id, async () => { const link = await corporateAdminService.paymentLink(invoice._id); window.prompt('Payment link', link.url); })} className="text-blue-700">Payment link</button>
                        <button type="button" disabled={Boolean(busy)} onClick={() => run(invoice._id, () => corporateAdminService.emailInvoice(invoice._id), 'Emailed')} className="text-gray-700">Email</button>
                      </>
                    )}
                    {['draft', 'issued', 'overdue'].includes(invoice.status) && !invoice.amountPaid && (
                      <button type="button" disabled={Boolean(busy)} onClick={() => { const reason = window.prompt('Reason for voiding'); if (reason) run(invoice._id, () => corporateAdminService.voidInvoice(invoice._id, reason), 'Voided'); }} className="text-red-600">Void</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {viewing && <AdminInvoiceDrawer invoiceId={viewing} onClose={closeViewing} />}
    </div>
  );
}

function ListTab({ loader, columns, empty }) {
  const [rows, setRows] = useState(null);
  useEffect(() => {
    loader().then((data) => setRows(data.items || [])).catch((error) => { toast.error(errorText(error)); setRows([]); });
  }, [loader]);
  if (!rows) return <Loader2 className="animate-spin text-gray-400" />;
  if (!rows.length) return <p className="text-sm text-gray-500">{empty}</p>;
  return (
    <div className="bg-white border border-gray-200 rounded-xl overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="bg-gray-50 text-gray-600">
          <tr>{columns.map((column) => <th key={column.label} className={`font-medium px-4 py-3 ${column.right ? 'text-right' : 'text-left'}`}>{column.label}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={row._id || row.rideId || index} className="border-t border-gray-100">
              {columns.map((column) => <td key={column.label} className={`px-4 py-3 ${column.right ? 'text-right tabular-nums' : ''}`}>{column.render(row)}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function CorporateDetail() {
  const { id } = useParams();
  const [params] = useSearchParams();
  const [tab, setTab] = useState('overview');
  const [detail, setDetail] = useState(null);
  const [terms, setTerms] = useState(null);
  const [commercial, setCommercial] = useState(null);
  const [travelZone, setTravelZone] = useState(null);
  const [saving, setSaving] = useState(false);
  const vehicleTypes = useAdminVehicleTypes();

  const rolesApi = useMemo(() => ({
    list: () => corporateAdminService.roles(id),
    create: (body) => corporateAdminService.createRole(id, body),
    update: (roleId, body) => corporateAdminService.updateRole(id, roleId, body),
    remove: (roleId, reassignToRoleId) => corporateAdminService.deleteRole(id, roleId, reassignToRoleId),
    makeDefault: (roleId) => corporateAdminService.makeDefaultRole(id, roleId),
    vehicleTypes: () => corporateAdminService.vehicleTypes(),
  }), [id]);

  const load = useCallback(async () => {
    try {
      const data = await corporateAdminService.detail(id);
      setDetail(data);
      setCommercial(commercialToForm(data.corporate));
      setTravelZone(travelZoneToForm(data.corporate.travelZone));
      setTerms({
        creditLimit: data.corporate.creditLimit,
        paymentTermsDays: data.corporate.paymentTermsDays,
        creditGracePercent: data.corporate.creditGracePercent,
        approvalExpiryMinutes: data.corporate.approvalExpiryMinutes,
        allowedServices: data.corporate.allowedServices,
        discount: data.corporate.discount,
      });
    } catch (error) {
      toast.error(errorText(error, 'Could not load corporate'));
    }
  }, [id]);
  useEffect(() => { load(); }, [load]);

  const ledgerLoader = useCallback(() => corporateAdminService.ledger(id, { limit: 100 }), [id]);
  const tripsLoader = useCallback(() => corporateAdminService.trips(id, { limit: 100, from: new Date(Date.now() - 90 * 864e5).toISOString() }), [id]);

  if (!detail || !terms || !commercial || !travelZone) {
    return <div className="flex items-center gap-2 text-gray-500 py-16 justify-center"><Loader2 size={18} className="animate-spin" /> Loading…</div>;
  }

  const { corporate } = detail;
  const pending = corporate.status === 'pending';

  const act = async (fn, message) => {
    setSaving(true);
    try {
      await fn();
      toast.success(message);
      await load();
    } catch (error) {
      toast.error(errorText(error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="p-4 lg:p-6">
      <Link to="/admin/corporates" className="inline-flex items-center gap-1 text-sm text-gray-500 mb-3"><ArrowLeft size={14} /> Corporates</Link>
      <div className="flex flex-wrap items-start justify-between gap-4 mb-5">
        <div>
          <h1 className="text-xl font-bold text-gray-900 flex items-center gap-3">{corporate.name} <StatusPill value={corporate.status} /></h1>
          <p className="text-sm text-gray-500 mt-1">{corporate.code} · {corporate.legalName || '-'} · GSTIN {corporate.gstin || '-'} · PAN {corporate.pan || '-'}</p>
          {corporate.rejectionReason && <p className="text-sm text-red-600 mt-1">Rejected: {corporate.rejectionReason}</p>}
          {corporate.suspendedReason && <p className="text-sm text-red-600 mt-1">Suspended: {corporate.suspendedReason}</p>}
        </div>
        <div className="flex gap-2">
          {corporate.status === 'approved' && (
            <button type="button" disabled={saving} onClick={() => { const reason = window.prompt('Reason for suspending'); if (reason) act(() => corporateAdminService.suspend(id, reason), 'Suspended'); }} className="text-sm font-semibold text-red-600 border border-red-200 rounded-lg px-3 py-2">Suspend</button>
          )}
          {corporate.status === 'suspended' && (
            <button type="button" disabled={saving} onClick={() => act(() => corporateAdminService.reactivate(id), 'Reactivated')} className="text-sm font-semibold text-emerald-700 border border-emerald-200 rounded-lg px-3 py-2">Reactivate</button>
          )}
          {pending && (
            <button type="button" disabled={saving} onClick={() => { const reason = window.prompt('Reason for rejecting'); if (reason) act(() => corporateAdminService.reject(id, reason), 'Rejected'); }} className="text-sm font-semibold text-red-600 border border-red-200 rounded-lg px-3 py-2">Reject</button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3 mb-5">
        <Stat label="Outstanding" value={formatMoney(corporate.currentOutstanding)} />
        <Stat label="Credit limit" value={formatMoney(corporate.creditLimit)} />
        <Stat label="Invoiced & due" value={formatMoney(detail.invoicedDue)} />
        <Stat label="Active employees" value={detail.employeeCount} />
        <Stat label="Pending approvals" value={detail.pendingApprovals} />
      </div>

      <div className="flex gap-2 mb-4 border-b border-gray-200 overflow-x-auto">
        {TABS.map((item) => (
          <button key={item} type="button" onClick={() => setTab(item)} className={`text-sm capitalize whitespace-nowrap px-3 py-2 -mb-px border-b-2 ${tab === item ? 'border-gray-900 font-semibold text-gray-900' : 'border-transparent text-gray-500'}`}>{item}</button>
        ))}
      </div>

      {tab === 'overview' && (
        <div className="space-y-4">
          <section className={`bg-white border rounded-xl p-5 space-y-3 ${pending || params.get('approve') ? 'border-yellow-300' : 'border-gray-200'}`}>
            <h2 className="font-semibold text-gray-900">{pending ? 'Approve with these terms' : 'Credit, terms and discount'}</h2>
            <TermsFields value={terms} onChange={setTerms} />
            <div className="flex gap-2">
              {pending ? (
                <button type="button" disabled={saving} onClick={() => act(() => corporateAdminService.approve(id, termsPayload(terms)), 'Approved')} className="text-sm font-semibold bg-emerald-600 text-white rounded-lg px-4 py-2">Approve corporate</button>
              ) : (
                <button type="button" disabled={saving} onClick={() => act(() => corporateAdminService.update(id, termsPayload(terms)), 'Saved')} className="text-sm font-semibold bg-gray-900 text-white rounded-lg px-4 py-2">Save terms</button>
              )}
            </div>
          </section>
          <section className="bg-white border border-gray-200 rounded-xl p-5 space-y-3">
            <h2 className="font-semibold text-gray-900">Billing, tariff and commission</h2>
            <CommercialFields value={commercial} onChange={setCommercial} vehicleTypes={vehicleTypes} />
            <button
              type="button"
              disabled={saving}
              onClick={() => {
                const problem = validateCommercial(commercial);
                if (problem) toast.error(problem);
                else act(() => corporateAdminService.update(id, commercialPayload(commercial)), 'Saved');
              }}
              className="text-sm font-semibold bg-gray-900 text-white rounded-lg px-4 py-2 disabled:opacity-50"
            >
              Save billing &amp; tariff
            </button>
          </section>
          <section className="bg-white border border-gray-200 rounded-xl p-5 space-y-3">
            <div>
              <h2 className="font-semibold text-gray-900">Travel zone</h2>
              <p className="text-xs text-gray-500 mt-0.5">The company can also change this from its panel.</p>
            </div>
            <TravelZoneEditor value={travelZone} onChange={setTravelZone} />
            <button
              type="button"
              disabled={saving}
              onClick={() => {
                const problem = validateTravelZone(travelZone);
                if (problem) toast.error(problem);
                else act(() => corporateAdminService.update(id, { travelZone: travelZoneToBody(travelZone) }), 'Travel zone saved');
              }}
              className="text-sm font-semibold bg-gray-900 text-white rounded-lg px-4 py-2 disabled:opacity-50"
            >
              Save travel zone
            </button>
          </section>
          <section className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div className="bg-white border border-gray-200 rounded-xl p-5 text-sm space-y-1">
              <h2 className="font-semibold text-gray-900 mb-2">Contact &amp; billing</h2>
              <p>{corporate.contact?.name} · {corporate.contact?.email} · {corporate.contact?.phone}</p>
              <p className="text-gray-600">Invoices to: {corporate.billingEmail || corporate.contact?.email || '-'}</p>
              <p className="text-gray-600">{[corporate.billingAddress?.line1, corporate.billingAddress?.city, corporate.billingAddress?.state, corporate.billingAddress?.pincode].filter(Boolean).join(', ') || '-'}</p>
              <p className="text-gray-400 text-xs">Source: {corporate.source} · created {formatDate(corporate.createdAt)}{corporate.approvedAt ? ` · approved ${formatDate(corporate.approvedAt)}` : ''}</p>
            </div>
            <div className="bg-white border border-gray-200 rounded-xl p-5 text-sm">
              <h2 className="font-semibold text-gray-900 mb-2">Panel users</h2>
              {detail.admins.map((admin) => (
                <p key={admin.id} className="flex justify-between"><span>{admin.name} <span className="text-gray-400">({admin.role})</span></span><span className="text-gray-500">{admin.email}</span></p>
              ))}
              <h2 className="font-semibold text-gray-900 mt-4 mb-2">Departments</h2>
              <p className="text-gray-600">{detail.departments.map((department) => department.name).join(', ') || 'None yet'}</p>
            </div>
          </section>
        </div>
      )}

      {tab === 'employees' && <EmployeesTab corporateId={id} />}

      {tab === 'roles' && (
        <div className="space-y-2">
          <p className="text-sm text-gray-500">Roles set each group's free km allowance and travel rules. The company manages the same list from its panel.</p>
          <RolesManager api={rolesApi} canManage />
        </div>
      )}

      {tab === 'allowance' && <AllowanceTab corporateId={id} />}

      {tab === 'invoices' && <InvoicesTab corporateId={id} onChange={load} />}

      {tab === 'ledger' && (
        <div className="space-y-3">
          <button
            type="button"
            onClick={() => {
              const amount = window.prompt('Adjustment amount (positive raises outstanding, negative lowers it)');
              if (!amount) return;
              const note = window.prompt('Note') || '';
              act(() => corporateAdminService.adjustLedger(id, { amount: Number(amount), note }), 'Adjusted');
            }}
            className="text-sm font-semibold border border-gray-200 rounded-lg px-3 py-2"
          >
            Manual adjustment
          </button>
          <ListTab
            key={corporate.currentOutstanding}
            loader={ledgerLoader}
            empty="No account activity yet."
            columns={[
              { label: 'Date', render: (row) => formatDate(row.createdAt) },
              { label: 'Kind', render: (row) => row.kind },
              { label: 'Description', render: (row) => row.description },
              { label: 'Amount', right: true, render: (row) => formatMoney(row.amount) },
              { label: 'Balance', right: true, render: (row) => (row.balanceAfter === null ? '-' : formatMoney(row.balanceAfter)) },
            ]}
          />
        </div>
      )}

      {tab === 'trips' && (
        <ListTab
          loader={tripsLoader}
          empty="No corporate trips in the last 90 days."
          columns={[
            { label: 'Date', render: (row) => formatDate(row.completedAt || row.createdAt) },
            { label: 'Employee', render: (row) => row.employee?.name || '-' },
            { label: 'Route', render: (row) => <span className="text-xs">{row.pickupAddress} → {row.dropAddress}</span> },
            { label: 'Status', render: (row) => row.status },
            { label: 'Fare', right: true, render: (row) => formatMoney(row.grossFare) },
            { label: 'Billed', right: true, render: (row) => formatMoney(row.billedAmount) },
          ]}
        />
      )}
    </div>
  );
}
