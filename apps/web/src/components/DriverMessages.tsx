'use client';

import { useEffect, useState } from 'react';
import clsx from 'clsx';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, type DriverMessage } from '@/lib/api';
import { getSocket } from '@/lib/useRealtime';
import { useFormat, useT, type Dictionary } from '@/lib/i18n';
import { useToast } from './ui/Toast';
import { Button } from './ui/Button';
import { Badge } from './ui/Badge';
import { Textarea } from './ui/Form';

/*
 * The desk writing to the driver of one shipment.
 *
 * Before this, telling a driver anything meant telephoning a number the carrier
 * wrote down at the gate, on a road where the call drops. The message goes to
 * the phone carrying THIS order — the recipient is chosen by opening the order,
 * not picked from a list where the wrong lorry is one row away — and it lands
 * as a notification and a card in the driver's app.
 *
 * Each message carries its own receipts, because "did they see it?" is the
 * question that follows every message ever sent to somebody driving.
 */

/** Mirrors MAX_MESSAGE_LENGTH in apps/api/src/messages/dto.ts. */
const MAX_LENGTH = 500;

/**
 * The first driver build that fetches and shows messages, 1.9.0 (24).
 *
 * An older phone still has its messages kept for it, and they arrive the day it
 * updates — but until then the dispatcher has to know nobody is reading.
 */
export const MESSAGES_MIN_APP_BUILD = 24;

const CLOSED = new Set(['COMPLETED', 'CANCELLED', 'EXPIRED']);

export function DriverMessages({
  sessionId,
  status,
  driverName,
  vehiclePlate,
  device,
}: {
  sessionId: string;
  status: string | null;
  driverName?: string | null;
  vehiclePlate?: string | null;
  device: Record<string, unknown> | null;
}) {
  const t = useT();
  const f = useFormat();
  const toast = useToast();
  const qc = useQueryClient();
  const [draft, setDraft] = useState('');

  const key = ['driver-messages', sessionId];
  const thread = useQuery({
    queryKey: key,
    queryFn: () => api.driverMessages(sessionId),
    // The socket moves the ticks; this is the floor for when it is down.
    refetchInterval: 30_000,
  });

  /*
   * Receipts arrive over the session room the page has already joined. A frame
   * is a prompt to refetch rather than a patch to apply: the thread is a
   * hundred rows at most, and refetching keeps exactly one source of truth.
   */
  useEffect(() => {
    const socket = getSocket();
    const onMessage = (frame: { sessionId?: string }) => {
      if (frame?.sessionId === sessionId) {
        void qc.invalidateQueries({ queryKey: ['driver-messages', sessionId] });
      }
    };
    socket.on('session:message', onMessage);
    return () => {
      socket.off('session:message', onMessage);
    };
  }, [sessionId, qc]);

  const send = useMutation({
    mutationFn: (body: string) => api.sendDriverMessage(sessionId, body),
    onSuccess: (message) => {
      setDraft('');
      qc.setQueryData<DriverMessage[]>(key, (old) => [
        message,
        ...(old ?? []).filter((m) => m.id !== message.id),
      ]);
      toast.success(t.driverMessages.sent, t.driverMessages.sentBody);
    },
    onError: (e) => {
      // A colleague closed the shipment while this was being typed.
      if (e instanceof ApiError && e.code === 'SESSION_CLOSED') {
        void qc.invalidateQueries({ queryKey: ['session', sessionId] });
      }
      toast.error(t.driverMessages.sendFailed, describe(e, t));
    },
  });

  const closed = status !== null && CLOSED.has(status);
  const length = Array.from(draft.trim()).length;
  const over = length > MAX_LENGTH;
  const canSend = !closed && length > 0 && !over && !send.isPending;

  const submit = () => {
    if (canSend) send.mutate(draft);
  };

  const appBuild = typeof device?.app_build === 'number' ? device.app_build : null;
  const appVersion = typeof device?.app_version === 'string' ? device.app_version : null;
  const oldApp = appBuild !== null && appBuild < MESSAGES_MIN_APP_BUILD;

  const recipient = [driverName, vehiclePlate].filter(Boolean).join(' · ') || t.driverMessages.thisDriver;
  const messages = thread.data ?? [];

  return (
    <section className="m-3 rounded-xl border border-line bg-surface-2 p-3.5">
      <p className="text-2xs font-semibold uppercase tracking-[0.16em] text-ink-3">
        {t.driverMessages.heading}
      </p>
      <p className="mt-1 truncate text-sm text-ink-2">
        <span className="text-ink-3">{t.driverMessages.to}: </span>
        <span className="font-medium text-ink">{recipient}</span>
      </p>

      {closed ? (
        <p className="mt-2.5 rounded-lg bg-surface-3/70 px-2.5 py-2 text-sm text-ink-2">
          {t.driverMessages.closed}
        </p>
      ) : (
        <>
          {/*
            The two reasons a message can be sent and not yet be read by
            anybody. Neither stops the send: the message is kept and handed
            over the moment there is a phone that can take it.
          */}
          {!device && (
            <p className="mt-2.5 rounded-lg bg-surface-3/70 px-2.5 py-2 text-sm text-ink-2">
              {t.driverMessages.noDevice}
            </p>
          )}
          {oldApp && (
            <p className="mt-2.5 rounded-lg bg-warn-bg px-2.5 py-2 text-sm text-warn ring-1 ring-inset ring-delayed-ring/35">
              {t.driverMessages.oldApp(appVersion ?? String(appBuild))}
            </p>
          )}

          <Textarea
            className="mt-2.5"
            rows={3}
            value={draft}
            // dir="auto": a dispatcher reading Turkish writes to a driver who
            // reads Arabic, and the box should lay the text out the way the
            // driver will see it.
            dir="auto"
            placeholder={t.driverMessages.placeholder}
            aria-label={t.driverMessages.heading}
            aria-invalid={over || undefined}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                submit();
              }
            }}
          />
          <div className="mt-2 flex items-center gap-2">
            <span
              className={clsx('kh-num text-2xs', over ? 'font-semibold text-danger' : 'text-ink-3')}
              aria-live="polite"
            >
              {length}/{MAX_LENGTH}
            </span>
            <span className="truncate text-2xs text-ink-3">{t.driverMessages.shortcut}</span>
            <Button
              size="sm"
              variant="primary"
              className="ms-auto"
              loading={send.isPending}
              disabled={!canSend}
              onClick={submit}
            >
              {t.driverMessages.send}
            </Button>
          </div>
          {over && (
            <p className="mt-1.5 text-2xs text-danger">{t.driverMessages.tooLong(String(MAX_LENGTH))}</p>
          )}
        </>
      )}

      {thread.isError && (
        <p className="mt-3 text-sm text-danger">{t.driverMessages.loadFailed}</p>
      )}
      {thread.isSuccess && messages.length === 0 && (
        <p className="mt-3 text-sm text-ink-3">{t.driverMessages.none}</p>
      )}

      {messages.length > 0 && (
        <ol className="mt-3 space-y-2">
          {messages.map((m) => (
            <li key={m.id} className="rounded-lg border border-line bg-surface p-2.5">
              <p dir="auto" className="whitespace-pre-wrap break-words text-sm text-ink">
                {m.body}
              </p>
              <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-2xs text-ink-3">
                <span className="kh-num">{f.dayTime(m.sentAt)}</span>
                {m.sentByName && <span className="truncate">{m.sentByName}</span>}
                <span className="ms-auto">
                  <Receipt message={m} t={t} time={f.time} />
                </span>
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

/** Sent, on the phone, or read — the furthest state reached, with its time. */
function Receipt({
  message,
  t,
  time,
}: {
  message: DriverMessage;
  t: Dictionary;
  time: (value: string | null) => string;
}) {
  if (message.readAt) {
    return <Badge tone="success">{t.driverMessages.stateRead(time(message.readAt))}</Badge>;
  }
  if (message.deliveredAt) {
    return <Badge tone="brand">{t.driverMessages.stateDelivered(time(message.deliveredAt))}</Badge>;
  }
  return <Badge tone="neutral">{t.driverMessages.stateSent}</Badge>;
}

function describe(e: unknown, t: Dictionary): string {
  if (e instanceof ApiError) {
    if (e.code === 'EMPTY_MESSAGE') return t.driverMessages.empty;
    if (e.code === 'MESSAGE_TOO_LONG') return t.driverMessages.tooLong(String(MAX_LENGTH));
    if (e.code === 'SESSION_CLOSED') return t.driverMessages.closed;
  }
  return (e as Error).message;
}
