import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import toast from 'react-hot-toast';
import { Loader2 } from 'lucide-react';
import { corporateAdminService, errorText } from '../../services/corporateAdminService';
import { Field, formatMoney, inputClass } from './corporateUi';

const BUCKETS = [
  ['current', 'Not yet due'],
  ['1_30', '1-30 days'],
  ['31_60', '31-60 days'],
  ['61_90', '61-90 days'],
  ['90_plus', '90+ days'],
];

/** Outstanding and aging across all corporates (SOW 8.9), plus module settings. */
export default function CorporateOutstanding() {
  const [aging, setAging] = useState(null);
  const [settings, setSettings] = useState(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    corporateAdminService.aging().then(setAging).catch((error) => toast.error(errorText(error)));
    corporateAdminService.settings().then(setSettings).catch((error) => toast.error(errorText(error)));
  }, []);

  const save = async () => {
    setSaving(true);
    try {
      setSettings(await corporateAdminService.saveSettings(settings));
      toast.success('Settings saved');
    } catch (error) {
      toast.error(errorText(error));
    } finally {
      setSaving(false);
    }
  };

  const flag = (key, label, hint) => (
    <label className="flex items-start gap-2 text-sm">
      <input type="checkbox" className="mt-1" checked={String(settings[key]) === '1'} onChange={(e) => setSettings({ ...settings, [key]: e.target.checked ? '1' : '0' })} />
      <span>{label}{hint && <span className="block text-xs text-gray-400">{hint}</span>}</span>
    </label>
  );
  const text = (key, label, type = 'text', hint = '') => (
    <Field label={label} hint={hint}>
      <input type={type} className={inputClass} value={settings[key] ?? ''} onChange={(e) => setSettings({ ...settings, [key]: e.target.value })} />
    </Field>
  );

  return (
    <div className="p-4 lg:p-6 space-y-6">
      <div>
        <h1 className="text-xl font-bold text-gray-900">Corporate Outstanding</h1>
        <p className="text-sm text-gray-500 mt-1">Invoiced balances by age, per company.</p>
      </div>
      {!aging ? <Loader2 className="animate-spin text-gray-400" /> : (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-6 gap-3">
            <div className="bg-white border border-gray-200 rounded-xl p-4"><p className="text-xs text-gray-500">Total due</p><p className="text-xl font-bold tabular-nums">{formatMoney(aging.totalDue)}</p></div>
            {BUCKETS.map(([key, label]) => (
              <div key={key} className="bg-white border border-gray-200 rounded-xl p-4">
                <p className="text-xs text-gray-500">{label}</p>
                <p className={`text-xl font-bold tabular-nums ${key !== 'current' && aging.buckets[key]?.amount ? 'text-red-700' : ''}`}>{formatMoney(aging.buckets[key]?.amount)}</p>
                <p className="text-xs text-gray-400">{aging.buckets[key]?.count || 0} invoices</p>
              </div>
            ))}
          </div>
          <div className="bg-white border border-gray-200 rounded-xl overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-gray-600">
                <tr>
                  <th className="text-left font-medium px-4 py-3">Company</th>
                  <th className="text-right font-medium px-4 py-3">Account outstanding</th>
                  <th className="text-right font-medium px-4 py-3">Invoiced due</th>
                  {BUCKETS.map(([key, label]) => <th key={key} className="text-right font-medium px-4 py-3">{label}</th>)}
                </tr>
              </thead>
              <tbody>
                {aging.corporates.map((row) => (
                  <tr key={row.corporateId} className="border-t border-gray-100">
                    <td className="px-4 py-3"><Link to={`/admin/corporates/${row.corporateId}`} className="font-medium text-gray-900 hover:underline">{row.name}</Link></td>
                    <td className="px-4 py-3 text-right tabular-nums">{formatMoney(row.currentOutstanding)}</td>
                    <td className="px-4 py-3 text-right tabular-nums">{formatMoney(row.totalDue)}</td>
                    {BUCKETS.map(([key]) => <td key={key} className="px-4 py-3 text-right tabular-nums">{row.buckets[key]?.amount ? formatMoney(row.buckets[key].amount) : '-'}</td>)}
                  </tr>
                ))}
                {!aging.corporates.length && <tr><td colSpan={8} className="px-4 py-8 text-center text-gray-500">Nothing outstanding.</td></tr>}
              </tbody>
            </table>
          </div>
        </>
      )}

      {settings && (
        <section className="bg-white border border-gray-200 rounded-xl p-5 space-y-4 max-w-4xl">
          <h2 className="font-semibold text-gray-900">Corporate settings</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {flag('booking_enabled', 'Corporate billing enabled', 'Riders can choose "corporate" as the payment method')}
            {flag('registration_enabled', 'Public corporate registration open')}
            {flag('auto_generate_invoices', 'Draft last month’s invoices automatically on the 1st')}
            {flag('auto_issue_invoices', 'Issue and email those drafts automatically')}
            {flag('block_booking_when_overdue', 'Pause corporate billing while an invoice is overdue')}
            {flag('invoice_fare_includes_tax', 'Fares are GST-inclusive', 'Off = GST is added on top of the trip fares')}
            {flag('approver_email_enabled', 'Email approvers when a trip needs approval')}
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {text('default_approval_expiry_minutes', 'Approval expiry (minutes)', 'number')}
            {text('credit_grace_percent', 'Credit grace (% of limit)', 'number')}
            {text('credit_grace_amount', 'Credit grace (₹)', 'number')}
            {text('invoice_gst_percent', 'GST %', 'number')}
            {text('invoice_prefix', 'Invoice prefix')}
            {text('supplier_gstin', 'Our GSTIN', 'text', 'Decides CGST+SGST vs IGST')}
            {text('supplier_legal_name', 'Our legal name')}
            {text('supplier_address', 'Our address')}
            {text('invoice_footer_note', 'Invoice footer')}
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 border-t border-gray-100 pt-4">
            {flag('invite_sms_enabled', 'Send employee invites by SMS', 'Needs a DLT-registered template')}
            {text('invite_sms_template_id', 'Invite SMS DLT template id')}
            {flag('approver_sms_enabled', 'SMS approvers', 'Needs a DLT-registered template')}
            {text('approver_sms_template_id', 'Approver SMS DLT template id')}
          </div>
          <button type="button" disabled={saving} onClick={save} className="text-sm font-semibold bg-gray-900 text-white rounded-lg px-4 py-2 disabled:opacity-50">Save settings</button>
        </section>
      )}
    </div>
  );
}
