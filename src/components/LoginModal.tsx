import { useState, type FormEvent } from 'react';
import { Lock, ShieldCheck, X } from 'lucide-react';
import type { AuthUser } from '../shared/types';
import { apiFetch, setStoredToken } from '../utils/api';

interface LoginModalProps {
  open: boolean;
  onClose: () => void;
  onSuccess: (user: AuthUser) => void;
}

export function LoginModal({ open, onClose, onSuccess }: LoginModalProps) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  if (!open) return null;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const res = await apiFetch<{ token: string; user: AuthUser }>('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email, password }),
      });
      setStoredToken(res.token);
      onSuccess(res.user);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign-in failed.');
    } finally {
      setSubmitting(false);
    }
  }

  function fillDemoCredentials(role: 'admin' | 'teacher') {
    setError(null);
    if (role === 'admin') {
      setEmail('admin@aegiscampus.edu.in');
      setPassword('Admin@2026');
    } else {
      setEmail('priya.menon@aegiscampus.edu.in');
      setPassword('Teacher@2026');
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 backdrop-blur-sm p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="login-dialog-title"
    >
      <div className="glass-panel-active w-full max-w-md rounded-xl p-6 text-slate-100">
        <div className="flex items-start justify-between gap-4 pb-4 border-b border-sky-500/20">
          <div>
            <h2 id="login-dialog-title" className="text-xl font-semibold text-white">
              Staff & Role Authentication
            </h2>
            <p className="text-xs text-slate-400 mt-1">
              Sign in as an authorized Teacher or School Administrator
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close sign in modal"
            className="p-2 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800/80 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="mt-5 space-y-4">
          <div>
            <label htmlFor="auth-email" className="block text-xs font-medium text-slate-300 mb-1.5">
              Institutional Email
            </label>
            <input
              id="auth-email"
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="name@aegiscampus.edu.in"
              className="w-full rounded-lg bg-slate-900/90 border border-slate-700 px-3.5 py-2.5 text-sm text-white placeholder:text-slate-500 focus:outline-none focus:border-sky-400"
            />
          </div>

          <div>
            <label htmlFor="auth-password" className="block text-xs font-medium text-slate-300 mb-1.5">
              Password
            </label>
            <input
              id="auth-password"
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Enter account password"
              className="w-full rounded-lg bg-slate-900/90 border border-slate-700 px-3.5 py-2.5 text-sm text-white placeholder:text-slate-500 focus:outline-none focus:border-sky-400"
            />
          </div>

          {error && (
            <div role="alert" className="rounded-lg bg-red-950/60 border border-red-500/40 px-3.5 py-2.5 text-xs text-red-200">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={submitting}
            className="w-full flex items-center justify-center gap-2 rounded-lg bg-sky-500 hover:bg-sky-400 disabled:opacity-50 text-slate-950 font-semibold text-sm py-2.5 px-4 transition-colors whitespace-nowrap"
          >
            <Lock className="w-4 h-4" />
            {submitting ? 'Verifying Credentials...' : 'Sign In to Workspace'}
          </button>
        </form>

        <div className="mt-5 pt-4 border-t border-slate-800">
          <div className="flex items-center gap-2 text-xs text-slate-400 mb-2.5">
            <ShieldCheck className="w-4 h-4 text-sky-400 shrink-0" />
            <span>Seeded Verification Accounts (8-hour expiring session)</span>
          </div>
          <div className="grid grid-cols-2 gap-2.5">
            <button
              type="button"
              onClick={() => fillDemoCredentials('admin')}
              className="px-3 py-2 rounded-lg border border-sky-500/30 bg-slate-900/80 hover:bg-slate-800 text-xs font-medium text-sky-200 transition-colors whitespace-nowrap"
            >
              Use Admin Account
            </button>
            <button
              type="button"
              onClick={() => fillDemoCredentials('teacher')}
              className="px-3 py-2 rounded-lg border border-slate-700 bg-slate-900/80 hover:bg-slate-800 text-xs font-medium text-slate-200 transition-colors whitespace-nowrap"
            >
              Use Teacher Account
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
