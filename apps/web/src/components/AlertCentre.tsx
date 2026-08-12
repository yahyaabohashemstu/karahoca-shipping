'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import type { Alert, AlertKind, AlertSeverity } from '@/lib/api';
import { useAlerts } from '@/lib/useAlerts';
import { useNow } from '@/lib/signal';
import {
  Button,
  EmptyState,
  ErrorState,
  IconButton,
  SkeletonList,
  Spinner,
  useToast,
} from './ui';

/* =============================================================================
   The exception desk
   =============================================================================
   Everything this system detects used to be published to `session:<id>` and
   nowhere else, so it reached exactly one person: whoever already had that
   truck's detail page open. Nobody has that page open at 02:00 on the Habur
   road. Seventy-four signal losses were recorded and nobody was ever told.

   So: one bell, on every screen, that answers "what is wrong right now" and
   gets a dispatcher from that question to the truck in one click.

   Three rules the design is built around.

   SILENT AT ZERO. A badge that is always showing something is furniture. This
   one has nothing to draw when there is nothing to do.

   NEVER GREEN BY ACCIDENT. A failed request must not render as an empty badge —
   "I could not ask" and "nothing is wrong" are the two states this product has
   spent the most effort keeping apart, and the alert bell is the worst possible
   place to collapse them.

   THE COLOUR IS THE NOW, THE NUMBER IS THE BACKLOG. The count is everything
   unacknowledged, including alerts the world already fixed — those still need a
   human to look, because six self-healing outages on one run is a pattern and
   the only place it is visible is this list. The colour is the worst severity
   still open, because that is what a dispatcher must react to this minute.
   ========================================================================== */

export function AlertCentre() {
  const [panelOpen, setPanelOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const pathname = usePathname();
  const toast = useToast();

  // The shared clock, not a private timer: the panel says "12 dk önce" about
  // the same truck the fleet list is ageing, and two clocks means two answers.
  const now = useNow();

  const alerts = useAlerts();

  // Clicking a row navigates without unmounting the shell, so without this the
  // panel stays parked over the page the dispatcher just asked for.
  useEffect(() => setPanelOpen(false), [pathname]);

  useEffect(() => {
    if (!panelOpen) return;

    const onPointerDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setPanelOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setPanelOpen(false);
      // Focus would drop to <body> when the panel unmounts, which strands a
      // keyboard user at the top of the document. IconButton does not forward a
      // ref, and the bell is the first button inside this container.
      rootRef.current?.querySelector<HTMLButtonElement>('button')?.focus();
    };

    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [panelOpen]);

  const { unacknowledged, worstOpen, isError } = alerts;

  const label = isError
    ? 'Uyarılar alınamadı'
    : unacknowledged > 0
      ? `Uyarılar — ${unacknowledged} bekleyen`
      : 'Uyarılar — bekleyen yok';

  return (
    <div ref={rootRef} className="relative">
      <IconButton
        label={label}
        size="sm"
        className="relative"
        aria-expanded={panelOpen}
        aria-haspopup="dialog"
        onClick={() => setPanelOpen((v) => !v)}
      >
        <BellIcon ringing={worstOpen === 'CRITICAL'} />
        {isError ? (
          /* Not a zero. An unreachable endpoint is the one case where an empty
             bell would be actively misleading. */
          <span
            aria-hidden
            className="absolute -right-0.5 -top-0.5 grid h-3.5 w-3.5 place-items-center rounded-full bg-surface text-2xs font-bold leading-none text-danger ring-1 ring-danger-ring"
          >
            !
          </span>
        ) : (
          unacknowledged > 0 && (
            <span
              aria-hidden
              className={clsx(
                'kh-num absolute -right-1 -top-1 min-w-[1.05rem] rounded-full px-1 text-2xs font-semibold leading-[1.05rem]',
                BADGE_TONE[worstOpen ?? 'INFO'],
                // Only CRITICAL pulses. If a warning pulsed too, the movement
                // would stop meaning "drop what you are doing".
                worstOpen === 'CRITICAL' && 'kh-pulse',
              )}
            >
              {unacknowledged > 99 ? '99+' : unacknowledged}
            </span>
          )
        )}
      </IconButton>

      {panelOpen && (
        <AlertPanel
          alerts={alerts}
          now={now}
          onNavigate={() => setPanelOpen(false)}
          onAcknowledgeAll={() =>
            alerts.acknowledgeAll({
              onError: (e: Error) => toast.error('Uyarılar işaretlenemedi', e.message),
            })
          }
          onAcknowledge={(id) =>
            alerts.acknowledge(id, {
              onError: (e: Error) => toast.error('Uyarı işaretlenemedi', e.message),
            })
          }
        />
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */

function AlertPanel({
  alerts,
  now,
  onNavigate,
  onAcknowledge,
  onAcknowledgeAll,
}: {
  alerts: ReturnType<typeof useAlerts>;
  now: number;
  onNavigate: () => void;
  onAcknowledge: (id: string) => void;
  onAcknowledgeAll: () => void;
}) {
  const { open, resolved, truncated, connected } = alerts;
  const empty = open.length === 0 && resolved.length === 0;

  return (
    <div
      role="dialog"
      aria-label="Uyarı merkezi"
      /* z-40 keeps it over the map's own absolutely-positioned furniture — the
         legend, the selected-vehicle panel — and under the toasts at z-50,
         which must stay readable even with this open. */
      className="kh-enter absolute right-0 top-full z-40 mt-1.5 w-[26rem] max-w-[calc(100vw-1.5rem)] overflow-hidden rounded-md bg-surface shadow-panel ring-1 ring-line"
    >
      <div className="flex items-center justify-between gap-3 border-b border-line px-3 py-2">
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-ink">Uyarılar</h2>
          <p className="kh-num mt-0.5 text-2xs text-ink-3">
            {open.length} açık · son 24 saatte {resolved.length} kapandı
          </p>
        </div>
        {alerts.canAcknowledgeAll && (
          <Button
            size="sm"
            onClick={onAcknowledgeAll}
            loading={alerts.isAcknowledgingAll}
            title="Listedeki tüm uyarıları gördüm olarak işaretle"
          >
            Tümünü gördüm
          </Button>
        )}
      </div>

      {/* The feed is down but rows are still on screen. Say so — a frozen alert
          list is the one list where "no news" must not read as good news. */}
      {!connected && !alerts.isLoading && (
        <p
          role="status"
          className="flex items-center gap-1.5 bg-warn-bg px-3 py-1 text-2xs text-warn"
        >
          <span className="kh-pulse h-1.5 w-1.5 shrink-0 rounded-full bg-current" aria-hidden />
          Canlı bağlantı yok — liste 20 saniyede bir yenileniyor.
        </p>
      )}

      <div className="kh-scroll max-h-[min(70vh,32rem)] overflow-y-auto">
        {alerts.isLoading ? (
          <SkeletonList rows={4} />
        ) : alerts.isError ? (
          <ErrorState
            className="m-3"
            title="Uyarılar alınamadı"
            message={alerts.error?.message}
            onRetry={alerts.refetch}
            retrying={alerts.isFetching}
          />
        ) : empty ? (
          <EmptyState
            title="Açık uyarı yok"
            description="Bir araç sessizleştiğinde, varışa ulaştığında veya bataryası bittiğinde burada görünür."
          />
        ) : (
          <>
            {open.length > 0 && (
              <Group title="Şu anda açık" count={open.length}>
                {open.map((a) => (
                  <AlertRow
                    key={a.id}
                    alert={a}
                    now={now}
                    acknowledging={alerts.acknowledgingId === a.id}
                    onAcknowledge={onAcknowledge}
                    onNavigate={onNavigate}
                  />
                ))}
              </Group>
            )}

            {resolved.length > 0 && (
              /* Kept, not hidden. A truck that went dark six times on one run
                 looks fine at every single moment you check it; the pattern
                 only exists in the history. */
              <Group title="Kendiliğinden düzeldi" count={resolved.length}>
                {resolved.map((a) => (
                  <AlertRow
                    key={a.id}
                    alert={a}
                    now={now}
                    acknowledging={alerts.acknowledgingId === a.id}
                    onAcknowledge={onAcknowledge}
                    onNavigate={onNavigate}
                  />
                ))}
              </Group>
            )}

            {truncated > 0 && (
              <p className="border-t border-line px-3 py-2 text-2xs text-ink-3">
                <span className="kh-num">{truncated}</span> uyarı daha var — listeye
                sığmadı.
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function Group({
  title,
  count,
  children,
}: {
  title: string;
  count: number;
  children: React.ReactNode;
}) {
  return (
    <section>
      {/* Sticky: scrolling twenty rows must not cost you the answer to "am I
          still looking at open ones?". */}
      <h3 className="sticky top-0 z-[1] flex items-baseline justify-between gap-2 border-b border-line bg-surface-2 px-3 py-1 text-2xs font-medium uppercase tracking-wider text-ink-3">
        {title}
        <span className="kh-num">{count}</span>
      </h3>
      <ul>{children}</ul>
    </section>
  );
}

function AlertRow({
  alert,
  now,
  acknowledging,
  onAcknowledge,
  onNavigate,
}: {
  alert: Alert;
  now: number;
  acknowledging: boolean;
  onAcknowledge: (id: string) => void;
  onNavigate: () => void;
}) {
  const resolved = alert.resolvedAt !== null;
  const acknowledged = alert.acknowledgedAt !== null;

  return (
    <li
      className={clsx(
        'flex items-start gap-1 border-b border-line/70 py-2 pr-1.5 transition-colors last:border-b-0',
        // A coloured left edge, the same device the fleet list uses for a
        // paused truck: it is what a dispatcher notices while scanning a
        // column, which a badge at the far right of the row is not.
        'border-l-[3px] pl-[9px]',
        SEVERITY_STRIPE[alert.severity],
        // Handled work recedes but never disappears — it is still the record of
        // who owns this shipment.
        (resolved || acknowledged) && 'opacity-70',
        'hover:bg-surface-2 hover:opacity-100',
      )}
    >
      {/*
        The whole text block is the link. "Something is wrong" to "the truck" is
        one click, which is the entire justification for this panel existing —
        the alternative is reading a plate off a row and searching for it.
      */}
      <Link
        href={`/sessions/${alert.sessionId}`}
        onClick={onNavigate}
        className="min-w-0 flex-1 rounded"
      >
        <div className="flex items-start gap-1.5">
          <span className={clsx('mt-0.5 shrink-0', SEVERITY_TEXT[alert.severity])}>
            <KindIcon kind={alert.kind} />
            <span className="sr-only">
              {SEVERITY_LABEL[alert.severity]} — {KIND_LABEL[alert.kind] ?? alert.kind}
            </span>
          </span>
          <span className="min-w-0 flex-1 text-base font-medium leading-tight text-ink">
            {alert.title}
          </span>
          <time
            dateTime={alert.raisedAt}
            title={absolute(alert.raisedAt)}
            className="kh-num shrink-0 text-2xs leading-5 text-ink-3"
          >
            {formatAgo(alert.raisedAt, now)}
          </time>
        </div>

        <div className="mt-1 flex min-w-0 items-center gap-1.5 text-sm text-ink-2">
          <span className="kh-num shrink-0 font-medium">
            {alert.vehiclePlate ?? alert.sessionReference}
          </span>
          {alert.orderNumber && (
            <>
              <Dot />
              <span className="kh-num shrink-0">{alert.orderNumber}</span>
            </>
          )}
          {alert.customerName && (
            <>
              <Dot />
              <span className="truncate">{alert.customerName}</span>
            </>
          )}
        </div>

        {alert.detail && (
          <p className="mt-0.5 truncate text-sm text-ink-3">{alert.detail}</p>
        )}

        <div className="mt-1 flex flex-wrap items-center gap-1.5 empty:hidden">
          {alert.resolvedAt && (
            <span className="inline-flex items-center rounded-full bg-surface-3 px-1.5 py-px text-2xs text-ink-2 ring-1 ring-inset ring-line-strong">
              {formatAgo(alert.resolvedAt, now)} düzeldi
            </span>
          )}
          {acknowledged && (
            <span className="inline-flex items-center gap-1 text-2xs text-ink-3">
              <CheckIcon />
              {alert.acknowledgedByName ?? 'Görüldü'}
            </span>
          )}
        </div>
      </Link>

      <div className="flex shrink-0 items-center gap-0.5">
        {/*
          A separate <a>, never nested inside the row link — nested anchors are
          invalid HTML and the browser resolves them by dropping one. The first
          thing a dispatcher does about a silent truck is ring its driver, and
          the number is already on the alert.
        */}
        {alert.driverPhone && (
          <a
            href={`tel:${alert.driverPhone}`}
            title={`Sürücüyü ara — ${alert.driverName ?? alert.driverPhone}`}
            className="inline-flex h-7 w-7 items-center justify-center rounded text-ink-3 transition-colors hover:bg-surface-3 hover:text-ink"
          >
            <PhoneIcon />
            <span className="sr-only">Sürücüyü ara</span>
          </a>
        )}

        {acknowledged ? (
          <span
            title={`Gören: ${alert.acknowledgedByName ?? 'bilinmiyor'}`}
            className="inline-flex h-7 w-7 items-center justify-center text-success"
          >
            <CheckIcon />
            <span className="sr-only">Gördüm olarak işaretlendi</span>
          </span>
        ) : (
          <IconButton
            label="Gördüm olarak işaretle"
            size="sm"
            disabled={acknowledging}
            onClick={() => onAcknowledge(alert.id)}
          >
            {acknowledging ? <Spinner className="h-3.5 w-3.5" /> : <CheckIcon />}
          </IconButton>
        )}
      </div>
    </li>
  );
}

/* -----------------------------------------------------------------------------
   Tokens and labels
   -------------------------------------------------------------------------- */

const BADGE_TONE: Record<AlertSeverity, string> = {
  // Solid fills, the same inversion trick the LOST badge uses: at 10px on a
  // 28px button, a tinted pill with a ring is not legible across a room.
  // `text-ink-inverse` rather than white, so both themes stay above 4.5:1.
  CRITICAL: 'bg-danger text-ink-inverse',
  WARNING: 'bg-warn text-ink-inverse',
  // An INFO-only backlog is bookkeeping, not an emergency, and it must not look
  // like one. Brand blue is reserved for interactive affordances.
  INFO: 'bg-surface-3 text-ink-2 ring-1 ring-inset ring-line-strong',
};

const SEVERITY_STRIPE: Record<AlertSeverity, string> = {
  CRITICAL: 'border-l-danger',
  // The amber ring rather than the warn text colour: `warn` is a dark brown in
  // the light theme and reads as a smudge at 3px wide.
  WARNING: 'border-l-delayed-ring',
  INFO: 'border-l-line-strong',
};

const SEVERITY_TEXT: Record<AlertSeverity, string> = {
  CRITICAL: 'text-danger',
  WARNING: 'text-warn',
  INFO: 'text-ink-3',
};

const SEVERITY_LABEL: Record<AlertSeverity, string> = {
  CRITICAL: 'Kritik',
  WARNING: 'Uyarı',
  INFO: 'Bilgi',
};

/* The API writes the visible sentence, so these are for the screen reader and
   the icon's meaning only — duplicating the title in the row would waste the
   one line of width this panel has. */
const KIND_LABEL: Record<AlertKind, string> = {
  SIGNAL_LOST: 'Sinyal kesildi',
  ARRIVED: 'Varışa ulaştı',
  BATTERY_LOW: 'Batarya düşük',
  MOCK_LOCATION: 'Sahte konum',
  NOT_STARTED: 'Takip başlamadı',
  STOPPED_TOO_LONG: 'Uzun süredir duruyor',
};

/* -----------------------------------------------------------------------------
   Time
   -------------------------------------------------------------------------- */

/**
 * Relative age for the row, absolute time in the tooltip.
 *
 * "14:02" is useless for "how long has this truck been dark"; "22 dk önce" is
 * useless in a shift handover note. Both exist, one is visible.
 */
function formatAgo(iso: string, nowMs: number): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '—';
  // Clamped: a server a second ahead of the browser must not render "-1 dk".
  const secs = Math.max(0, Math.round((nowMs - t) / 1000));
  if (secs < 60) return 'az önce';
  if (secs < 3600) return `${Math.floor(secs / 60)} dk önce`;
  if (secs < 86_400) return `${Math.floor(secs / 3600)} sa önce`;
  return `${Math.floor(secs / 86_400)} gün önce`;
}

function absolute(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ''
    : d.toLocaleString('tr-TR', {
        day: '2-digit',
        month: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      });
}

/* -----------------------------------------------------------------------------
   Icons
   -------------------------------------------------------------------------- */

function Dot() {
  return (
    <span className="shrink-0 text-ink-3" aria-hidden>
      ·
    </span>
  );
}

function BellIcon({ ringing }: { ringing: boolean }) {
  return (
    <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none" aria-hidden>
      <path
        d="M4 6.6a4 4 0 0 1 8 0c0 2.2.5 3.3 1.1 4H2.9C3.5 9.9 4 8.8 4 6.6Z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
      <path d="M6.6 12.9a1.6 1.6 0 0 0 2.8 0" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      {/* Two sound arcs only when something critical is open: motionless chrome
          for the normal case, a shape change for the one that matters. */}
      {ringing && (
        <path
          d="M13.6 3.1a5.6 5.6 0 0 1 1.3 2.4M2.4 3.1a5.6 5.6 0 0 0-1.3 2.4"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinecap="round"
        />
      )}
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" aria-hidden>
      <path
        d="m3.5 8.4 3 3 6-6.8"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function PhoneIcon() {
  return (
    <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" aria-hidden>
      <path
        d="M5.3 2.2 6.6 5 5.3 6.3a8.4 8.4 0 0 0 4.4 4.4L11 9.4l2.8 1.3v2.1c0 .6-.5 1.1-1.1 1a11.4 11.4 0 0 1-10.5-10.5c0-.6.4-1.1 1-1.1h2.1Z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * One glyph per kind.
 *
 * Colour carries severity and is therefore unavailable for type — roughly 8% of
 * men would read six identical amber rows. The shape is what makes "batarya
 * bitiyor" and "sahte konum" different objects at a glance.
 */
function KindIcon({ kind }: { kind: AlertKind }) {
  const p = { stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round', strokeLinejoin: 'round' } as const;
  switch (kind) {
    case 'SIGNAL_LOST':
      return (
        <svg viewBox="0 0 14 14" className="h-3.5 w-3.5" fill="none" aria-hidden>
          <path d="M2.2 5.6a6.8 6.8 0 0 1 9.6 0M4.4 8a3.7 3.7 0 0 1 5.2 0" {...p} />
          <circle cx="7" cy="10.6" r="0.8" fill="currentColor" />
          <path d="M1.8 12.2 12.2 1.8" {...p} strokeWidth={1.5} />
        </svg>
      );
    case 'ARRIVED':
      return (
        <svg viewBox="0 0 14 14" className="h-3.5 w-3.5" fill="none" aria-hidden>
          <path d="M7 12.4S2.6 8.9 2.6 6a4.4 4.4 0 1 1 8.8 0c0 2.9-4.4 6.4-4.4 6.4Z" {...p} />
          <circle cx="7" cy="5.9" r="1.5" {...p} />
        </svg>
      );
    case 'BATTERY_LOW':
      return (
        <svg viewBox="0 0 14 14" className="h-3.5 w-3.5" fill="none" aria-hidden>
          <rect x="1" y="4" width="10" height="6" rx="1.4" {...p} />
          <rect x="2.4" y="5.4" width="2.2" height="3.2" rx="0.5" fill="currentColor" />
          <path d="M12.6 5.9v2.2" {...p} strokeWidth={1.6} />
        </svg>
      );
    case 'MOCK_LOCATION':
      return (
        <svg viewBox="0 0 14 14" className="h-3.5 w-3.5" fill="none" aria-hidden>
          <path d="M7 1.7 13 12.3H1z" {...p} />
          <path d="M7 5.7v2.7" {...p} strokeWidth={1.5} />
          <circle cx="7" cy="10.3" r="0.7" fill="currentColor" />
        </svg>
      );
    case 'NOT_STARTED':
      return (
        <svg viewBox="0 0 14 14" className="h-3.5 w-3.5" fill="none" aria-hidden>
          <circle cx="7" cy="7" r="5.4" {...p} />
          <path d="M7 4.1V7l2 1.5" {...p} />
        </svg>
      );
    case 'STOPPED_TOO_LONG':
      return (
        <svg viewBox="0 0 14 14" className="h-3.5 w-3.5" fill="none" aria-hidden>
          <circle cx="7" cy="7" r="5.4" {...p} />
          <path d="M5.7 5.2v3.6M8.3 5.2v3.6" {...p} strokeWidth={1.5} />
        </svg>
      );
  }
}
