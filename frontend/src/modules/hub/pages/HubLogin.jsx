import { useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { Warehouse } from 'lucide-react';
import { hubApi, hubSession } from '../services/hubApi';
import { Button, Field } from '../components/ui';
import { inputClass } from '../components/format';

/** Hub staff sign-in: phone OTP (default) or password. */
const HubLogin = () => {
  const navigate = useNavigate();
  const [mode, setMode] = useState('otp');
  const [phone, setPhone] = useState('');
  const [otp, setOtp] = useState('');
  const [otpSent, setOtpSent] = useState(false);
  const [debugOtp, setDebugOtp] = useState('');
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  if (hubSession.getToken()) return <Navigate to="/hub/dashboard" replace />;

  const finish = (session) => {
    hubSession.save(session);
    hubSession.setActiveHubId(session?.staff?.hubId || '');
    navigate('/hub/dashboard', { replace: true });
  };

  const run = async (fn) => {
    setLoading(true);
    setError('');
    try {
      await fn();
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const sendOtp = () =>
    run(async () => {
      const result = await hubApi.sendOtp(phone);
      setOtpSent(true);
      setDebugOtp(result?.debugOtp || '');
    });

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50 p-4">
      <div className="w-full max-w-sm bg-white border border-slate-200 rounded-xl p-6">
        <div className="flex items-center gap-2 mb-1">
          <Warehouse size={20} className="text-slate-900" />
          <h1 className="text-lg font-semibold text-slate-900">Hub panel</h1>
        </div>
        <p className="text-[13px] text-slate-500 mb-5">Sign in with the phone number your admin registered.</p>

        <div className="flex gap-1 mb-4 bg-slate-100 rounded-lg p-1 text-[12px]">
          {['otp', 'password'].map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => { setMode(value); setError(''); }}
              className={`flex-1 py-1.5 rounded-md ${mode === value ? 'bg-white shadow-sm text-slate-900' : 'text-slate-500'}`}
            >
              {value === 'otp' ? 'Phone OTP' : 'Password'}
            </button>
          ))}
        </div>

        {mode === 'otp' ? (
          <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); otpSent ? run(async () => finish(await hubApi.verifyOtp(phone, otp))) : sendOtp(); }}>
            <Field label="Mobile number">
              <input className={inputClass} value={phone} onChange={(event) => setPhone(event.target.value)} inputMode="numeric" maxLength={13} placeholder="10-digit mobile" disabled={otpSent} />
            </Field>
            {otpSent && (
              <Field label="OTP" hint={debugOtp ? `Dev OTP: ${debugOtp}` : 'Sent by SMS'}>
                <input className={`${inputClass} tracking-[0.4em] font-mono`} value={otp} onChange={(event) => setOtp(event.target.value)} inputMode="numeric" maxLength={4} autoFocus />
              </Field>
            )}
            <Button type="submit" loading={loading} className="w-full">{otpSent ? 'Verify and sign in' : 'Send OTP'}</Button>
            {otpSent && (
              <button type="button" className="w-full text-[12px] text-slate-500" onClick={() => { setOtpSent(false); setOtp(''); }}>
                Use a different number
              </button>
            )}
          </form>
        ) : (
          <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); run(async () => finish(await hubApi.passwordLogin(identifier, password))); }}>
            <Field label="Phone or email">
              <input className={inputClass} value={identifier} onChange={(event) => setIdentifier(event.target.value)} autoComplete="username" />
            </Field>
            <Field label="Password">
              <input className={inputClass} type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" />
            </Field>
            <Button type="submit" loading={loading} className="w-full">Sign in</Button>
          </form>
        )}
        {error && <p className="mt-3 text-[12px] text-rose-600">{error}</p>}
      </div>
    </div>
  );
};

export default HubLogin;
