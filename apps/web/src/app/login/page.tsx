'use client';

import { useState } from 'react';
import { api, tokens } from '@/lib/api';

export default function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await api.login(email, password);
      tokens.set(result.accessToken, result.refreshToken);
      window.location.href = '/';
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Giriş başarısız');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-900 px-4">
      <form
        onSubmit={submit}
        className="w-full max-w-sm rounded-xl bg-white p-8 shadow-xl"
      >
        <div className="mb-1 text-xs font-extrabold tracking-[0.25em] text-blue-700">
          KARAHOCA
        </div>
        <h1 className="mb-6 text-xl font-semibold">Sevkiyat Takip Merkezi</h1>

        <label className="mb-1 block text-sm text-slate-600" htmlFor="email">
          E-posta
        </label>
        <input
          id="email"
          type="email"
          autoComplete="username"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          className="mb-4 w-full rounded border border-slate-300 px-3 py-2 focus:border-blue-500 focus:outline-none"
        />

        <label className="mb-1 block text-sm text-slate-600" htmlFor="password">
          Parola
        </label>
        <input
          id="password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          className="mb-4 w-full rounded border border-slate-300 px-3 py-2 focus:border-blue-500 focus:outline-none"
        />

        {error && <p className="mb-4 text-sm text-red-600">{error}</p>}

        <button
          type="submit"
          disabled={busy}
          className="w-full rounded bg-blue-600 py-2.5 font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {busy ? 'Giriş yapılıyor…' : 'Giriş yap'}
        </button>
      </form>
    </div>
  );
}
