import { useState } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { CORPORATE_BASE_PATH, corporateApi, errorMessage, hasCorporateToken, saveCorporateSession } from '../services/corporateApi';
import { Button, Field, Input } from '../components/ui';

export default function CorporateLogin() {
  const navigate = useNavigate();
  const [mode, setMode] = useState('password');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [phone, setPhone] = useState('');
  const [otp, setOtp] = useState('');
  const [otpSent, setOtpSent] = useState(false);
  const [busy, setBusy] = useState(false);

  if (hasCorporateToken()) return <Navigate to={`${CORPORATE_BASE_PATH}/dashboard`} replace />;

  const finish = (session) => {
    saveCorporateSession(session);
    navigate(`${CORPORATE_BASE_PATH}/dashboard`, { replace: true });
  };

  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    try {
      if (mode === 'password') {
        finish(await corporateApi.login({ email, password }));
      } else if (!otpSent) {
        await corporateApi.sendOtp(phone);
        setOtpSent(true);
        toast.success('If this number has panel access, an OTP is on its way');
      } else {
        finish(await corporateApi.verifyOtp(phone, otp));
      }
    } catch (error) {
      toast.error(errorMessage(error, 'Could not sign in'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="h-screen overflow-y-auto bg-gray-50 p-4">
      <div className="min-h-full flex items-center justify-center">
      <form onSubmit={submit} className="w-full max-w-sm bg-white border border-gray-200 rounded-2xl p-6 space-y-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-widest text-gray-400">Corporate panel</p>
          <h1 className="text-2xl font-bold text-gray-900 mt-1">Sign in</h1>
        </div>
        <div className="grid grid-cols-2 gap-1 bg-gray-100 rounded-lg p-1 text-sm">
          {['password', 'otp'].map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => { setMode(value); setOtpSent(false); }}
              className={`rounded-md py-1.5 ${mode === value ? 'bg-white shadow-sm font-semibold' : 'text-gray-500'}`}
            >
              {value === 'password' ? 'Email' : 'Phone OTP'}
            </button>
          ))}
        </div>
        {mode === 'password' ? (
          <>
            <Field label="Email"><Input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" /></Field>
            <Field label="Password"><Input type="password" required value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" /></Field>
          </>
        ) : (
          <>
            <Field label="Mobile number"><Input inputMode="numeric" required value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="10-digit mobile" /></Field>
            {otpSent && <Field label="OTP"><Input inputMode="numeric" required value={otp} onChange={(e) => setOtp(e.target.value)} /></Field>}
          </>
        )}
        <button type="submit" disabled={busy} className="w-full bg-gray-900 text-white rounded-lg py-2.5 text-sm font-semibold disabled:opacity-50">
          {busy ? 'Please wait…' : mode === 'otp' && !otpSent ? 'Send OTP' : 'Sign in'}
        </button>
        <p className="text-sm text-gray-500 text-center">
          New company? <Link to={`${CORPORATE_BASE_PATH}/register`} className="font-semibold text-gray-900">Register</Link>
        </p>
      </form>
      </div>
    </div>
  );
}

export function CorporateRegister() {
  const navigate = useNavigate();
  const [form, setForm] = useState({ name: '', legalName: '', gstin: '', pan: '', city: '', state: '', line1: '', pincode: '', ownerName: '', ownerEmail: '', ownerPhone: '', password: '' });
  const [busy, setBusy] = useState(false);
  const set = (key) => (event) => setForm((previous) => ({ ...previous, [key]: event.target.value }));

  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    try {
      await corporateApi.register({
        name: form.name,
        legalName: form.legalName,
        gstin: form.gstin,
        pan: form.pan,
        billingAddress: { line1: form.line1, city: form.city, state: form.state, pincode: form.pincode },
        contact: { name: form.ownerName, email: form.ownerEmail, phone: form.ownerPhone },
        owner: { name: form.ownerName, email: form.ownerEmail, phone: form.ownerPhone, password: form.password },
      });
      toast.success('Registered. Sign in to follow your approval.');
      navigate(`${CORPORATE_BASE_PATH}/login`);
    } catch (error) {
      toast.error(errorMessage(error, 'Could not register'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="h-screen overflow-y-auto bg-gray-50 p-4">
      <div className="min-h-full flex items-center justify-center">
      <form onSubmit={submit} className="w-full max-w-2xl bg-white border border-gray-200 rounded-2xl p-6 space-y-5">
        <div>
          <p className="text-xs font-semibold uppercase tracking-widest text-gray-400">Corporate panel</p>
          <h1 className="text-2xl font-bold text-gray-900 mt-1">Register your company</h1>
          <p className="text-sm text-gray-500 mt-1">We review every registration. Once approved, your employees can bill trips to the company.</p>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Field label="Company name"><Input required value={form.name} onChange={set('name')} /></Field>
          <Field label="Legal name"><Input value={form.legalName} onChange={set('legalName')} /></Field>
          <Field label="GSTIN"><Input value={form.gstin} onChange={set('gstin')} placeholder="29ABCDE1234F1Z5" /></Field>
          <Field label="PAN"><Input value={form.pan} onChange={set('pan')} /></Field>
          <Field label="Billing address"><Input value={form.line1} onChange={set('line1')} /></Field>
          <Field label="City"><Input value={form.city} onChange={set('city')} /></Field>
          <Field label="State"><Input value={form.state} onChange={set('state')} /></Field>
          <Field label="Pincode"><Input value={form.pincode} onChange={set('pincode')} /></Field>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 border-t border-gray-100 pt-4">
          <Field label="Your name"><Input required value={form.ownerName} onChange={set('ownerName')} /></Field>
          <Field label="Work email"><Input type="email" required value={form.ownerEmail} onChange={set('ownerEmail')} /></Field>
          <Field label="Mobile"><Input value={form.ownerPhone} onChange={set('ownerPhone')} /></Field>
          <Field label="Password" hint="At least 8 characters"><Input type="password" required minLength={8} value={form.password} onChange={set('password')} /></Field>
        </div>
        <div className="flex items-center justify-between">
          <Link to={`${CORPORATE_BASE_PATH}/login`} className="text-sm text-gray-500">Back to sign in</Link>
          <Button type="submit" busy={busy}>Submit registration</Button>
        </div>
      </form>
      </div>
    </div>
  );
}
