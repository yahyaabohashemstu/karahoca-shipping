'use client';

import { useEffect, useState } from 'react';
import {
  clearFailures,
  formatFailures,
  readFailures,
  subscribeFailures,
  type DiagEntry,
} from '@/lib/diagnostics';
import { useToast } from './ui/Toast';
import { Button, IconButton } from './ui/Button';

/*
 * The error log, in the top bar.
 *
 * A dispatcher hit "Oturum oluşturulamadı" with an empty message and had no
 * way to tell anyone what had happened — and the server had no record either,
 * because the request had failed before reaching it. This is the record: the
 * last fifty failed requests, with the status, the code and the server's own
 * message, copyable as plain text into a WhatsApp message.
 *
 * Hidden entirely when there is nothing wrong. A permanent icon that is
 * usually grey is a permanent invitation to ignore it.
 */
export function DiagnosticsLog() {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<DiagEntry[]>([]);

  // Read after mount only: localStorage does not exist during the server
  // render, and reading it in useState's initialiser is a hydration mismatch.
  useEffect(() => {
    const sync = () => setEntries(readFailures());
    sync();
    return subscribeFailures(sync);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  if (entries.length === 0) return null;

  const newest = entries[0];
  const recent = Date.now() - new Date(newest.at).getTime() < 5 * 60_000;

  return (
    <div className="relative">
      <IconButton
        label={`Hata kaydı — ${entries.length} kayıt`}
        size="sm"
        onClick={() => setOpen((v) => !v)}
      >
        <span className="relative">
          <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none" aria-hidden>
            <path d="M8 1.6 15 14H1z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
            <path d="M8 6.2v3.4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
            <circle cx="8" cy="11.6" r="0.75" fill="currentColor" />
          </svg>
          {/* Only whether something broke *just now* deserves colour. */}
          {recent && (
            <span className="absolute -right-1 -top-1 h-1.5 w-1.5 rounded-full bg-danger" />
          )}
        </span>
      </IconButton>

      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} aria-hidden />
          <div className="absolute right-0 top-full z-40 mt-1 w-[30rem] max-w-[92vw] rounded-md border border-line bg-surface shadow-panel">
            <div className="flex items-center justify-between border-b border-line px-3 py-2">
              <p className="text-sm font-medium">Hata kaydı</p>
              <p className="text-2xs text-ink-3">son {entries.length} başarısız istek</p>
            </div>

            <div className="kh-scroll max-h-[22rem] overflow-y-auto">
              {entries.map((e, i) => (
                <div key={`${e.at}-${i}`} className="border-b border-line/60 px-3 py-2 last:border-0">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="kh-num text-2xs text-ink-3">
                      {new Date(e.at).toLocaleString('tr-TR')}
                    </span>
                    <span
                      className={`kh-num text-2xs font-medium ${
                        e.status === 0 || e.status >= 500 ? 'text-danger' : 'text-warn-text'
                      }`}
                    >
                      {e.status === 0 ? 'bağlantı yok' : `HTTP ${e.status}`} · {e.code}
                    </span>
                  </div>
                  <p className="mt-0.5 text-sm text-ink">{e.message}</p>
                  <p className="kh-num mt-0.5 truncate text-2xs text-ink-3">
                    {e.method} {e.path}
                    {e.requestId ? ` · ${e.requestId}` : ''}
                  </p>
                </div>
              ))}
            </div>

            <div className="flex gap-2 border-t border-line px-3 py-2">
              <Button
                size="sm"
                variant="primary"
                onClick={() => {
                  navigator.clipboard
                    ?.writeText(formatFailures(entries))
                    .then(() => toast.success('Hata kaydı kopyalandı', 'Destek için gönderebilirsiniz.'))
                    .catch(() => toast.error('Kopyalanamadı'));
                }}
              >
                Kaydı kopyala
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  clearFailures();
                  setOpen(false);
                }}
              >
                Temizle
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
