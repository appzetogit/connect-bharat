import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import toast from 'react-hot-toast';
import { ArrowLeft, Loader2 } from 'lucide-react';
import { corporateAdminService, errorText } from '../../services/corporateAdminService';
import { Field, TermsFields, inputClass, termsPayload } from './corporateUi';

/**
 * Admin-created corporate (SOW 2.13). With ?enquiryId=... it converts a
 * website corporate lead: blank fields are filled from the enquiry server-side.
 */
export default function CorporateCreate() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const enquiryId = params.get('enquiryId') || '';
  const [form, setForm] = useState({
    name: params.get('name') || '',
    legalName: '',
    gstin: '',
    pan: '',
    billingEmail: '',
    line1: '',
    city: '',
    state: '',
    pincode: '',
    ownerName: params.get('contactName') || '',
    ownerEmail: params.get('email') || '',
    ownerPhone: params.get('phone') || '',
    ownerPassword: '',
    approveNow: true,
  });
  const [terms, setTerms] = useState({ creditLimit: 50000, paymentTermsDays: 30, discount: { type: 'percentage', value: 0, maxPerTrip: 0, appliesTo: ['ride', 'parcel', 'intercity', 'rental'] } });
  const [busy, setBusy] = useState(false);
  const set = (key) => (event) => setForm((previous) => ({ ...previous, [key]: event.target.value }));

  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    const body = {
      ...(form.name ? { name: form.name } : {}),
      legalName: form.legalName,
      gstin: form.gstin,
      pan: form.pan,
      billingEmail: form.billingEmail,
      billingAddress: { line1: form.line1, city: form.city, state: form.state, pincode: form.pincode },
      ...(form.ownerName || form.ownerEmail ? { contact: { name: form.ownerName, email: form.ownerEmail, phone: form.ownerPhone } } : {}),
      owner: {
        ...(form.ownerName ? { name: form.ownerName } : {}),
        ...(form.ownerEmail ? { email: form.ownerEmail } : {}),
        ...(form.ownerPhone ? { phone: form.ownerPhone } : {}),
        ...(form.ownerPassword ? { password: form.ownerPassword } : {}),
      },
      status: form.approveNow ? 'approved' : 'pending',
      ...termsPayload(terms),
    };
    try {
      const result = enquiryId
        ? await corporateAdminService.fromEnquiry(enquiryId, body)
        : await corporateAdminService.create(body);
      toast.success('Corporate created');
      navigate(`/admin/corporates/${result.corporate._id}`);
    } catch (error) {
      toast.error(errorText(error, 'Could not create corporate'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="p-4 lg:p-6 max-w-4xl">
      <Link to="/admin/corporates" className="inline-flex items-center gap-1 text-sm text-gray-500 mb-3"><ArrowLeft size={14} /> Corporates</Link>
      <h1 className="text-xl font-bold text-gray-900 mb-1">{enquiryId ? 'Convert enquiry to corporate' : 'New corporate'}</h1>
      <p className="text-sm text-gray-500 mb-5">
        {enquiryId ? 'Blank fields are filled from the website enquiry.' : 'The owner can sign in to the corporate panel with this email, or with phone OTP if no password is set.'}
      </p>
      <form onSubmit={submit} className="space-y-5">
        <section className="bg-white border border-gray-200 rounded-xl p-5 grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="Company name"><input className={inputClass} required={!enquiryId} value={form.name} onChange={set('name')} /></Field>
          <Field label="Legal name"><input className={inputClass} value={form.legalName} onChange={set('legalName')} /></Field>
          <Field label="GSTIN"><input className={inputClass} value={form.gstin} onChange={set('gstin')} /></Field>
          <Field label="PAN"><input className={inputClass} value={form.pan} onChange={set('pan')} /></Field>
          <Field label="Billing email" hint="Invoices are sent here"><input type="email" className={inputClass} value={form.billingEmail} onChange={set('billingEmail')} /></Field>
          <Field label="Address"><input className={inputClass} value={form.line1} onChange={set('line1')} /></Field>
          <Field label="City"><input className={inputClass} value={form.city} onChange={set('city')} /></Field>
          <Field label="State"><input className={inputClass} value={form.state} onChange={set('state')} /></Field>
          <Field label="Pincode"><input className={inputClass} value={form.pincode} onChange={set('pincode')} /></Field>
        </section>
        <section className="bg-white border border-gray-200 rounded-xl p-5 grid grid-cols-1 sm:grid-cols-2 gap-3">
          <h2 className="sm:col-span-2 font-semibold text-gray-900">Owner (panel login)</h2>
          <Field label="Name"><input className={inputClass} required={!enquiryId} value={form.ownerName} onChange={set('ownerName')} /></Field>
          <Field label="Email"><input type="email" className={inputClass} required={!enquiryId} value={form.ownerEmail} onChange={set('ownerEmail')} /></Field>
          <Field label="Mobile"><input className={inputClass} value={form.ownerPhone} onChange={set('ownerPhone')} /></Field>
          <Field label="Password" hint="Optional, 8+ characters"><input type="password" className={inputClass} value={form.ownerPassword} onChange={set('ownerPassword')} /></Field>
        </section>
        <section className="bg-white border border-gray-200 rounded-xl p-5 space-y-3">
          <h2 className="font-semibold text-gray-900">Credit and discount</h2>
          <TermsFields value={terms} onChange={setTerms} />
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.approveNow} onChange={(e) => setForm({ ...form, approveNow: e.target.checked })} /> Approve now</label>
        </section>
        <button type="submit" disabled={busy} className="inline-flex items-center gap-2 bg-gray-900 text-white text-sm font-semibold rounded-lg px-4 py-2.5 disabled:opacity-50">
          {busy && <Loader2 size={14} className="animate-spin" />} Create corporate
        </button>
      </form>
    </div>
  );
}
