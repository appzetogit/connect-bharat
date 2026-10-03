import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ShieldCheck, Mail, Lock, Loader2, AlertCircle, CheckCircle2, ArrowLeft } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { adminService } from '../../services/adminService';
import { useSettings } from '../../../../shared/context/SettingsContext';

/**
 * Admin sign-in.
 *
 * Deliberately plain. This previously read as a security-cosplay terminal
 * ("Terminal Access", "Security Token", "Encrypted Terminal v4.0") set in 900
 * weight at 10px with 0.4em tracking and 3rem corner radii. It is an internal
 * login form, so it should look like one.
 */

const Field = ({ icon: Icon, id, label, ...props }) => (
  <div className="space-y-1.5">
    <label htmlFor={id} className="block text-[13px] font-medium text-slate-700">
      {label}
    </label>
    <div className="relative">
      <Icon
        size={16}
        className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none"
      />
      <input
        id={id}
        className="w-full pl-9 pr-3 py-2.5 bg-white border border-slate-300 rounded-lg text-[14px] text-slate-900 placeholder:text-slate-400 outline-none focus:border-slate-900 focus:ring-2 focus:ring-slate-900/10 transition"
        {...props}
      />
    </div>
  </div>
);

const AdminLogin = () => {
  const { settings } = useSettings();
  const [view, setView] = useState('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [resetEmail, setResetEmail] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const navigate = useNavigate();

  const appLogo = settings.general?.logo || settings.customization?.logo;
  const appName = settings.general?.app_name || 'Connect Bharat';

  const switchView = (next) => {
    setError('');
    setNotice('');
    setView(next);
  };

  const handleLogin = async (e) => {
    e.preventDefault();
    setIsLoading(true);
    setError('');

    try {
      const response = await adminService.login({ email, password });
      localStorage.setItem('adminToken', response?.token || '');
      localStorage.setItem('adminInfo', JSON.stringify(response?.admin || {}));
      navigate('/admin/dashboard');
    } catch (err) {
      setError(err.response?.data?.message || err.message || 'Sign in failed.');
    } finally {
      setIsLoading(false);
    }
  };

  // The "forgot password" link used to set a view that was never rendered, so it
  // did nothing. Both adminService.forgotPassword and the backend route exist.
  const handleForgot = async (e) => {
    e.preventDefault();
    setIsLoading(true);
    setError('');
    setNotice('');

    try {
      await adminService.forgotPassword(resetEmail);
      setNotice('If that email belongs to an admin account, reset instructions are on their way.');
    } catch (err) {
      // Deliberately generic. The server surfaces raw transport failures here —
      // an unconfigured mail host returns "connect ECONNREFUSED 127.0.0.1:587",
      // which tells a visitor about our infrastructure and nothing useful. The
      // detail still goes to the console for whoever is debugging.
      console.error('[admin] password reset failed:', err.response?.data?.message || err.message);
      setError('Could not send reset instructions right now. Please contact your administrator.');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col">
      <main className="flex-1 flex items-center justify-center px-4 py-12">
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.25 }}
          className="w-full max-w-[380px]"
        >
          <div className="flex flex-col items-center text-center mb-7">
            <button
              type="button"
              onClick={() => navigate('/')}
              className="mb-4 rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-900/20"
              aria-label={`${appName} home`}
            >
              {appLogo ? (
                <img src={appLogo} alt={appName} className="h-11 w-auto object-contain" />
              ) : (
                <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-slate-900 text-white">
                  <ShieldCheck size={22} />
                </span>
              )}
            </button>
            <h1 className="text-[22px] font-semibold text-slate-900">
              {view === 'login' ? 'Sign in' : 'Reset password'}
            </h1>
            <p className="mt-1 text-[13px] text-slate-500">
              {view === 'login' ? `${appName} admin panel` : 'We will email you a reset link'}
            </p>
          </div>

          <div className="bg-white border border-slate-200 rounded-2xl p-6 shadow-sm">
            <AnimatePresence mode="wait">
              {(error || notice) && (
                <motion.div
                  key={error || notice}
                  initial={{ opacity: 0, y: -4 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0 }}
                  className={`mb-5 flex items-start gap-2 rounded-lg border p-3 text-[13px] ${
                    error
                      ? 'border-rose-200 bg-rose-50 text-rose-700'
                      : 'border-emerald-200 bg-emerald-50 text-emerald-700'
                  }`}
                  role={error ? 'alert' : 'status'}
                >
                  {error ? (
                    <AlertCircle size={15} className="mt-0.5 shrink-0" />
                  ) : (
                    <CheckCircle2 size={15} className="mt-0.5 shrink-0" />
                  )}
                  <p className="leading-snug">{error || notice}</p>
                </motion.div>
              )}
            </AnimatePresence>

            {view === 'login' ? (
              <form onSubmit={handleLogin} className="space-y-4">
                <Field
                  icon={Mail}
                  id="admin-email"
                  label="Email"
                  type="email"
                  autoComplete="username"
                  placeholder="you@example.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  autoFocus
                  required
                />
                <Field
                  icon={Lock}
                  id="admin-password"
                  label="Password"
                  type="password"
                  autoComplete="current-password"
                  placeholder="••••••••"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                />

                <button
                  type="submit"
                  disabled={isLoading}
                  className="w-full flex items-center justify-center gap-2 rounded-lg bg-slate-900 py-2.5 text-[14px] font-medium text-white transition hover:bg-slate-800 disabled:opacity-60"
                >
                  {isLoading && <Loader2 className="animate-spin" size={16} />}
                  {isLoading ? 'Signing in…' : 'Sign in'}
                </button>

                <button
                  type="button"
                  onClick={() => switchView('forgot')}
                  className="w-full text-center text-[13px] text-slate-500 hover:text-slate-900 transition"
                >
                  Forgot password?
                </button>
              </form>
            ) : (
              <form onSubmit={handleForgot} className="space-y-4">
                <Field
                  icon={Mail}
                  id="reset-email"
                  label="Email"
                  type="email"
                  autoComplete="username"
                  placeholder="you@example.com"
                  value={resetEmail}
                  onChange={(e) => setResetEmail(e.target.value)}
                  autoFocus
                  required
                />

                <button
                  type="submit"
                  disabled={isLoading}
                  className="w-full flex items-center justify-center gap-2 rounded-lg bg-slate-900 py-2.5 text-[14px] font-medium text-white transition hover:bg-slate-800 disabled:opacity-60"
                >
                  {isLoading && <Loader2 className="animate-spin" size={16} />}
                  {isLoading ? 'Sending…' : 'Send reset link'}
                </button>

                <button
                  type="button"
                  onClick={() => switchView('login')}
                  className="w-full flex items-center justify-center gap-1.5 text-[13px] text-slate-500 hover:text-slate-900 transition"
                >
                  <ArrowLeft size={14} />
                  Back to sign in
                </button>
              </form>
            )}
          </div>

          <p className="mt-6 text-center text-[12px] text-slate-400">
            Authorised access only. Sign-in attempts are logged.
          </p>
        </motion.div>
      </main>

      <footer className="py-6 text-center text-[12px] text-slate-400">
        © {new Date().getFullYear()} {appName}
      </footer>
    </div>
  );
};

export default AdminLogin;
