'use client';

import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';

/* =============================================================================
   Toasts
   =============================================================================
   Deliberately tiny — no dependency, no portal library, no animation engine.
   Its whole job is to acknowledge a mutation that has no other visible result,
   because the old build acknowledged nothing: a rejected POST rendered exactly
   like a successful one and the dispatcher believed the shipment was closed.

   Errors do NOT auto-dismiss. A message that disappears before someone looks
   up from the phone is the same as no message.
   ========================================================================== */

type Tone = 'success' | 'error' | 'info';

interface Toast {
  id: number;
  tone: Tone;
  title: string;
  message?: string;
}

interface ToastCtx {
  push: (t: Omit<Toast, 'id'>) => void;
  success: (title: string, message?: string) => void;
  error: (title: string, message?: string) => void;
}

const Ctx = createContext<ToastCtx>({ push: () => {}, success: () => {}, error: () => {} });

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);
  const seq = useRef(0);

  const dismiss = useCallback((id: number) => {
    setItems((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const push = useCallback(
    (t: Omit<Toast, 'id'>) => {
      const id = ++seq.current;
      setItems((prev) => [...prev.slice(-3), { ...t, id }]);
      if (t.tone !== 'error') setTimeout(() => dismiss(id), 4500);
    },
    [dismiss],
  );

  const value = useMemo<ToastCtx>(
    () => ({
      push,
      success: (title, message) => push({ tone: 'success', title, message }),
      error: (title, message) => push({ tone: 'error', title, message }),
    }),
    [push],
  );

  return (
    <Ctx.Provider value={value}>
      {children}
      <div
        // aria-live on the container, so entries are announced as they arrive.
        aria-live="polite"
        className="pointer-events-none fixed bottom-4 left-1/2 z-50 flex w-[min(28rem,calc(100vw-2rem))] -translate-x-1/2 flex-col gap-2"
      >
        {items.map((t) => (
          <ToastCard key={t.id} toast={t} onDismiss={() => dismiss(t.id)} />
        ))}
      </div>
    </Ctx.Provider>
  );
}

function ToastCard({ toast, onDismiss }: { toast: Toast; onDismiss: () => void }) {
  const tones = {
    success: 'bg-success-bg text-success ring-live-ring/40',
    error: 'bg-danger-bg text-danger ring-danger-ring',
    info: 'bg-surface text-ink ring-line',
  } as const;

  return (
    <div
      role={toast.tone === 'error' ? 'alert' : 'status'}
      className={clsx(
        'kh-enter pointer-events-auto flex items-start gap-2.5 rounded-md px-3 py-2.5 shadow-lg ring-1 ring-inset',
        tones[toast.tone],
      )}
    >
      <span className="mt-0.5 shrink-0" aria-hidden>
        {toast.tone === 'success' ? (
          <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none">
            <circle cx="8" cy="8" r="6.75" stroke="currentColor" strokeWidth="1.5" />
            <path d="m5.25 8.25 1.9 1.9 3.6-3.9" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        ) : toast.tone === 'error' ? (
          <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none">
            <circle cx="8" cy="8" r="6.75" stroke="currentColor" strokeWidth="1.5" />
            <path d="M8 4.75v3.9" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            <circle cx="8" cy="11.3" r="0.85" fill="currentColor" />
          </svg>
        ) : (
          <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none">
            <circle cx="8" cy="8" r="6.75" stroke="currentColor" strokeWidth="1.5" />
            <path d="M8 7.25v4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            <circle cx="8" cy="4.9" r="0.85" fill="currentColor" />
          </svg>
        )}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-base font-medium">{toast.title}</p>
        {toast.message && <p className="mt-0.5 break-words text-sm opacity-90">{toast.message}</p>}
      </div>
      <button
        onClick={onDismiss}
        aria-label="Kapat"
        className="-mr-1 shrink-0 rounded p-1 opacity-60 transition-opacity hover:opacity-100"
      >
        <svg viewBox="0 0 12 12" className="h-3 w-3" fill="none" aria-hidden>
          <path d="m3 3 6 6M9 3l-6 6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      </button>
    </div>
  );
}

export const useToast = () => useContext(Ctx);
