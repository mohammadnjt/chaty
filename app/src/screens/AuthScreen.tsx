import { Eye, EyeOff, Hourglass, Server } from 'lucide-react';
import { useEffect, useState } from 'react';
import Logo from '../components/Logo';
import Scenery from '../components/Scenery';
import { api, ApiError, errorText, type PublicConfig } from '../lib/api';
import { getServerUrl, isNativeShell, normalizeServerUrl, setServerUrl } from '../lib/config';
import { login, register } from '../store/auth';

export default function AuthScreen() {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [phone, setPhone] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [server, setServer] = useState(getServerUrl());
  const [showServer, setShowServer] = useState(isNativeShell);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [pub, setPub] = useState<PublicConfig | null>(null);

  useEffect(() => {
    if (isNativeShell && !getServerUrl()) return;
    api.publicConfig().then(setPub).catch(() => {});
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    if (isNativeShell && !server.trim()) {
      setError('Enter your server address first.');
      return;
    }
    const normalized = normalizeServerUrl(server);
    if (isNativeShell && normalized.startsWith('http://')) {
      setError('The app needs an https:// server address.');
      return;
    }
    if (normalized !== getServerUrl()) setServerUrl(normalized);
    setBusy(true);
    try {
      if (mode === 'login') await login(phone, password);
      else if (await register(phone, name.trim(), password)) {
        setPending(true);
        setBusy(false);
      }
    } catch (err) {
      if (err instanceof ApiError && err.code === 'pending') setPending(true);
      else setError(errorText(err));
      setBusy(false);
    }
  }

  const appName = pub?.appName ?? 'Chaty';

  return (
    <div className="auth">
      <Scenery variant="full" className="auth-bg" />
      <div className="auth-content">
        <div className="auth-brand">
          <Logo size={68} />
          <h1>{appName}</h1>
          <p>Messages, voice and video calls under a calm night sky.</p>
        </div>

        {pending ? (
          <div className="auth-card pending-card">
            <span className="pending-icon">
              <Hourglass size={30} />
            </span>
            <h2>Waiting for approval</h2>
            <p>
              An admin needs to approve this account (Settings → Admin panel → Users) before it can sign in.
              Once it's approved, sign in again with the same phone number and password.
            </p>
            <button
              className="btn btn-primary wide"
              onClick={() => {
                setPending(false);
                setMode('login');
              }}
            >
              Back to sign in
            </button>
          </div>
        ) : (
          <form className="auth-card" onSubmit={submit}>
            <div className="segmented">
              <button type="button" className={mode === 'login' ? 'on' : ''} onClick={() => setMode('login')}>
                Sign in
              </button>
              <button
                type="button"
                className={mode === 'register' ? 'on' : ''}
                onClick={() => setMode('register')}
                disabled={pub?.registrationOpen === false}
              >
                Create account
              </button>
            </div>

            <input
              className="field ltr"
              placeholder="Phone number, e.g. 0912 345 6789"
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              required
            />
            {mode === 'register' && (
              <input
                className="field"
                placeholder="Your name"
                autoComplete="name"
                dir="auto"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
              />
            )}
            <div className="password-field">
              <input
                className="field"
                type={showPassword ? 'text' : 'password'}
                placeholder="Password"
                autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
              <button
                type="button"
                className="icon-btn"
                onClick={() => setShowPassword((v) => !v)}
                aria-label={showPassword ? 'Hide password' : 'Show password'}
              >
                {showPassword ? <EyeOff size={19} /> : <Eye size={19} />}
              </button>
            </div>
            {showServer && (
              <input
                className="field ltr"
                placeholder="Server address, e.g. https://chat.example.com"
                autoCapitalize="none"
                spellCheck={false}
                inputMode="url"
                value={server}
                onChange={(e) => setServer(e.target.value)}
              />
            )}
            {mode === 'register' && pub?.requireApproval && (
              <p className="form-note">New accounts are activated after an admin approves them.</p>
            )}
            {error && <p className="form-error">{error}</p>}
            <button className="btn btn-primary wide" disabled={busy}>
              {busy ? 'Please wait…' : mode === 'login' ? 'Sign in' : 'Create account'}
            </button>
            {!isNativeShell && (
              <button
                type="button"
                className="link-btn"
                onClick={() => {
                  if (showServer) setServer('');
                  setShowServer(!showServer);
                }}
              >
                <Server size={14} />
                {showServer ? 'Use this site as the server' : 'Use another server'}
              </button>
            )}
          </form>
        )}
      </div>
    </div>
  );
}
