'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, tokens } from '@/lib/api';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Form';
import { ErrorState } from '@/components/ui/Feedback';

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Someone with a live session who lands here — from a bookmark, or from the
  // old redirect — should not be asked to sign in again.
  useEffect(() => {
    if (tokens.access) router.replace('/');
  }, [router]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await api.login(email.trim(), password);
      tokens.set(result.accessToken, result.refreshToken);
      // A hard navigation, not router.push: it guarantees the socket singleton
      // and every query cache start clean under the new identity.
      window.location.href = '/';
    } catch (err) {
      setError(
        err instanceof Error && err.message
          ? err.message
          : 'Giriş başarısız. E-posta ve parolanızı kontrol edin.',
      );
      setBusy(false);
    }
  }

  return (
    <div className="relative grid min-h-screen place-items-center overflow-hidden bg-bg px-4">
      {/* A quiet grid, the kind printed on a logistics planning sheet. It gives
          the page a subject without a stock photograph or a gradient. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-[0.045]"
        style={{
          backgroundImage:
            'linear-gradient(rgb(var(--kh-text)) 1px, transparent 1px), linear-gradient(90deg, rgb(var(--kh-text)) 1px, transparent 1px)',
          backgroundSize: '28px 28px',
        }}
      />

      <form
        onSubmit={submit}
        className="relative w-full max-w-[22rem] rounded-lg bg-surface p-7 shadow-panel ring-1 ring-line"
      >
        <div className="mb-6">
          <div className="text-2xs font-bold uppercase tracking-[0.22em] text-brand">KaraHoca</div>
          <h1 className="mt-1.5 text-lg font-semibold tracking-tight">Sevkiyat Takip Merkezi</h1>
          <p className="mt-1 text-sm text-ink-2">
            Üçüncü taraf nakliye araçlarının canlı takibi
          </p>
        </div>

        <div className="space-y-3.5">
          <Input
            label="E-posta"
            id="email"
            type="email"
            autoComplete="username"
            autoFocus
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            className="h-10"
          />
          <Input
            label="Parola"
            id="password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            className="h-10"
          />
        </div>

        {error && <ErrorState className="mt-4" title="Giriş yapılamadı" message={error} compact />}

        <Button type="submit" variant="primary" size="lg" block loading={busy} className="mt-5">
          {busy ? 'Giriş yapılıyor…' : 'Giriş yap'}
        </Button>
      </form>
    </div>
  );
}
