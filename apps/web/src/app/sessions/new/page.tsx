'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type SessionDetail } from '@/lib/api';
import { AppShell, useRequireAuth } from '@/components/AppShell';
import {
  Button,
  Card,
  EmptyState,
  ErrorState,
  Input,
  PageHeader,
  Select,
  useToast,
} from '@/components/ui';
import {
  CadencePicker,
  DEFAULT_CADENCE,
  cadenceToPolicy,
  validateCadence,
  type Cadence,
} from '@/components/CadencePicker';
import {
  ConsignmentEditor,
  EMPTY_LINE,
  consignmentToItems,
  type Consignment,
} from '@/components/ConsignmentEditor';
import { useFormat, useT } from '@/lib/i18n';
import { upperIdentifier } from '@/lib/identifier';

/**
 * Create a tracking session and print the hand-off.
 *
 * The screen ends on a big code and a QR because that is the physical moment
 * the system lives or dies: a dispatcher reads eight characters to a driver
 * over a bad phone line, or hands them a printed slip at the gate.
 */
export default function NewSessionPage() {
  const t = useT();
  const fmt = useFormat();
  const authed = useRequireAuth();
  const toast = useToast();
  const qc = useQueryClient();

  const [orderId, setOrderId] = useState('');
  const [shippingCompanyId, setShippingCompanyId] = useState('');
  const [driverName, setDriverName] = useState('');
  const [driverPhone, setDriverPhone] = useState('');
  const [vehiclePlate, setVehiclePlate] = useState('');
  const [cadence, setCadence] = useState<Cadence>(DEFAULT_CADENCE);
  const [consignment, setConsignment] = useState<Consignment>({
    customerId: '',
    lines: [{ ...EMPTY_LINE }],
  });
  const [created, setCreated] = useState<SessionDetail | null>(null);

  // Only orders that do not already have a live session — creating a second one
  // is rejected server-side by uq_sessions_one_live_per_order anyway.
  const orders = useQuery({
    queryKey: ['orders', 'untracked'],
    queryFn: () => api.orders({ untracked: true, limit: 200 }),
    enabled: authed,
  });

  const companies = useQuery({
    queryKey: ['companies'],
    queryFn: api.companies,
    enabled: authed,
  });

  const selectedOrder = orders.data?.items.find((o) => o.id === orderId);

  const mutation = useMutation({
    mutationFn: async () => {
      /*
       * The consignee and the load go to the ORDER, the cadence goes to the
       * SESSION. Two calls, in that order.
       *
       * The order update runs first and is allowed to fail loudly: creating a
       * tracking session that says it carries products the order does not
       * record is worse than not creating it at all, because the dispatcher
       * would walk away believing the manifest was saved.
       */
      const items = consignmentToItems(consignment.lines);
      const consigneeChanged =
        consignment.customerId && consignment.customerId !== selectedOrder?.customerId;

      if (items.length > 0 || consigneeChanged) {
        await api.updateOrder(orderId, {
          customerId: consigneeChanged ? consignment.customerId : undefined,
          // Only send items when there are some. An empty array CLEARS the
          // list server-side, and a dispatcher who left the section untouched
          // did not ask to erase a manifest entered on the order screen.
          items: items.length > 0 ? items : undefined,
        });
      }

      return api.createSession({
        orderId,
        shippingCompanyId,
        driverName: driverName.trim() || undefined,
        driverPhone: driverPhone.trim() || undefined,
        vehiclePlate: vehiclePlate.trim() || undefined,
        ...cadenceToPolicy(cadence),
      });
    },
    onSuccess: (s) => {
      setCreated(s);
      qc.invalidateQueries({ queryKey: ['orders'] });
      toast.success(t.sessionNew.created, s.reference);
    },
    onError: (e) => toast.error(t.sessionNew.createFailed, (e as Error).message),
  });

  if (!authed) return null;

  if (created?.handoff) return <Handoff session={created} />;

  const loadFailed = orders.isError || companies.isError;
  const noOrders = !orders.isLoading && (orders.data?.items.length ?? 0) === 0;
  const noCompanies = !companies.isLoading && (companies.data?.length ?? 0) === 0;

  return (
    <AppShell>
      <PageHeader
        title={t.sessionNew.title}
        subtitle={t.sessionNew.subtitle}
        breadcrumb={
          <Link href="/sessions" className="hover:text-ink-2 hover:underline">
            {t.sessionNew.back}
          </Link>
        }
      />

      <div className="mx-auto w-full max-w-xl px-5 py-6">
        {loadFailed && (
          <ErrorState
            className="mb-4"
            title={t.sessionNew.loadFailed}
            message={((orders.error ?? companies.error) as Error)?.message}
            onRetry={() => {
              orders.refetch();
              companies.refetch();
            }}
          />
        )}

        {/* The old form rendered two empty dropdowns and a submit button when
            there was nothing to select — a dead end with no explanation. */}
        {!loadFailed && (noOrders || noCompanies) ? (
          <Card>
            <EmptyState
              title={noOrders ? t.sessionNew.noOrders : t.sessionNew.noCarriers}
              description={
                noOrders
                  ? t.sessionNew.noOrdersBody
                  : t.sessionNew.noCarriersBody
              }
              action={
                <Link href={noOrders ? '/orders/new' : '/carriers/new'}>
                  <Button variant="primary" size="sm">
                    {noOrders ? t.orders.createShort : t.carriers.createShort}
                  </Button>
                </Link>
              }
            />
          </Card>
        ) : (
          <Card>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                mutation.mutate();
              }}
              className="space-y-4"
            >
              <Select
                label={t.sessionNew.order}
                required
                value={orderId}
                onChange={(e) => setOrderId(e.target.value)}
                disabled={orders.isLoading}
              >
                <option value="">{orders.isLoading ? t.common.loading : t.consignment.choose}</option>
                {orders.data?.items.map((o) => (
                  <option key={String(o.id)} value={String(o.id)}>
                    {String(o.orderNumber)} — {String(o.customerName)}
                    {o.destinationLabel ? ` · ${String(o.destinationLabel)}` : ''}
                  </option>
                ))}
              </Select>

              <Select
                label={t.sessionNew.carrier}
                required
                value={shippingCompanyId}
                onChange={(e) => setShippingCompanyId(e.target.value)}
                disabled={companies.isLoading}
              >
                <option value="">{companies.isLoading ? t.common.loading : t.consignment.choose}</option>
                {companies.data?.map((c) => (
                  <option key={String(c.id)} value={String(c.id)}>
                    {String(c.name)}
                  </option>
                ))}
              </Select>

              <div className="grid grid-cols-2 gap-4">
                <Input
                  label={t.sessionNew.driverName}
                  value={driverName}
                  onChange={(e) => setDriverName(e.target.value)}
                  placeholder={t.sessionNew.driverNamePlaceholder}
                />
                <Input
                  label={t.sessionNew.driverPhone}
                  type="tel"
                  inputMode="tel"
                  value={driverPhone}
                  onChange={(e) => setDriverPhone(e.target.value)}
                  placeholder="+90…"
                  hint={t.sessionNew.driverPhoneHint}
                />
              </div>

              <Input
                label={t.sessionNew.plate}
                value={vehiclePlate}
                onChange={(e) => setVehiclePlate(upperIdentifier(e.target.value))}
                placeholder={t.sessionNew.platePlaceholder}
                numeric
              />

              {/* Appears only once an order is chosen: without one there is
                  nothing to attach a consignee or a load to, and an empty
                  section invites the dispatcher to fill in fields that will be
                  thrown away. */}
              {orderId && (
                <ConsignmentEditor
                  value={consignment}
                  onChange={setConsignment}
                  defaultCustomerId={selectedOrder?.customerId}
                />
              )}

              <CadencePicker value={cadence} onChange={setCadence} />

              {mutation.isError && (
                <ErrorState
                  compact
                  title={t.sessionNew.createFailed}
                  message={(mutation.error as Error).message}
                />
              )}

              <Button
                type="submit"
                variant="primary"
                size="lg"
                block
                loading={mutation.isPending}
                disabled={!orderId || !shippingCompanyId || validateCadence(cadence) !== null}
              >
                {mutation.isPending ? t.sessionNew.creating : t.sessionNew.submit}
              </Button>
            </form>
          </Card>
        )}
      </div>
    </AppShell>
  );
}

/* -------------------------------------------------------------------------- */

/**
 * The hand-off slip.
 *
 * This is designed to be printed and physically handed over, so the print
 * stylesheet strips the application chrome and everything but the code and the
 * QR. The code is monospace with wide tracking for the same reason a flight
 * number is: it will be read aloud, character by character, over a bad line
 * from inside a truck cab.
 */
function Handoff({ session }: { session: SessionDetail }) {
  const t = useT();
  const fmt = useFormat();
  const toast = useToast();
  const handoff = session.handoff!;

  return (
    <AppShell>
      <div className="mx-auto w-full max-w-lg px-5 py-8 print:max-w-none print:py-0">
        <div className="mb-5 text-center print:mb-3">
          <p className="text-sm text-ink-2 print:hidden">{t.sessionNew.created}</p>
          <h1 className="kh-num text-xl font-semibold tracking-tight">{session.reference}</h1>
          <p className="mt-0.5 text-sm text-ink-2">
            <span className="kh-num">{session.orderNumber}</span> · {session.customerName}
          </p>
        </div>

        <div className="rounded-lg border-2 border-dashed border-brand/40 bg-brand-soft/60 p-7 text-center print:border-black print:bg-white">
          <p className="text-2xs font-semibold uppercase tracking-[0.18em] text-brand-text print:text-black">
            {t.sessionNew.driverCode}
          </p>

          <p className="my-4 select-all font-mono text-[2.6rem] font-bold leading-none tracking-[0.18em] text-ink print:text-black">
            {handoff.prettyCode}
          </p>

          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={handoff.qrDataUrl}
            alt={`${session.reference} oturum kodu QR`}
            className="mx-auto h-48 w-48 rounded bg-white p-1.5"
          />

          <p className="mt-4 text-sm text-ink-2 print:text-black">
            {t.sessionNew.qrHint}
          </p>
          {handoff.expiresAt && (
            <p className="kh-num mt-1 text-sm text-ink-3 print:text-black">
              {t.sessionNew.validUntil(fmt.dateTime(handoff.expiresAt))}
            </p>
          )}
          {/*
            Was plain text pointing at /downloads — a directory with autoindex
            off, so anyone who typed it got a 403. /app is a real page, and this
            line is printed on the dispatch note, so it has to be a URL a driver
            can key into a phone by hand.
          */}
          <p className="mt-3 text-2xs text-ink-3 print:text-black">
            Uygulama yüklü değilse:{' '}
            <a href="/app" target="_blank" rel="noreferrer" className="underline">
              track.karahoca.com/app
            </a>
          </p>
        </div>

        {/*
          The consignee's link, alongside the driver's code rather than behind a
          button on another screen.

          These are the two hand-offs a dispatcher makes at the same moment —
          the code goes to the driver, the link goes to the agent — and
          separating them is why the agent kept phoning. The link is minted with
          the session and shown ONLY here: the server keeps just its sha256, so
          it cannot be read back later, and needing it again means minting a
          fresh one from the session page.
        */}
        {handoff.shareUrl && (
          <div className="mt-5 rounded-lg border border-line bg-surface-2 p-4 print:hidden">
            <p className="text-2xs font-semibold uppercase tracking-[0.16em] text-ink-3">
              {t.sessionNew.consigneeLink}
            </p>
            <p className="mt-2 select-all break-all font-mono text-xs text-ink-2">
              {handoff.shareUrl}
            </p>
            <p className="mt-2 text-2xs text-ink-3">
              Alıcı bu bağlantıdan aracı haritada canlı görür; panele erişemez.
              Bu bağlantı yalnızca şimdi görüntülenir.
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button
                variant="primary"
                size="sm"
                onClick={() => {
                  const text = `${session.customerName} — ${session.orderNumber} sevkiyatınızı buradan canlı takip edebilirsiniz:\n${handoff.shareUrl}`;
                  // wa.me with no number: WhatsApp opens its own contact
                  // picker. Prefilling a number would need the consignee's
                  // mobile in E.164, which the customer record does not
                  // guarantee, and a malformed one silently opens an empty chat.
                  window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, '_blank', 'noreferrer');
                }}
              >
                {t.sessionNew.sendWhatsapp}
              </Button>
              <Button
                size="sm"
                onClick={() => {
                  navigator.clipboard
                    ?.writeText(handoff.shareUrl!)
                    .then(() => toast.success(t.sessionNew.trackCopied, t.sessionNew.trackCopiedBody))
                    .catch(() => toast.error(t.share.copyFailed, t.sessionNew.copyLinkFailedBody));
                }}
              >
                {t.share.copy}
              </Button>
              <a href={handoff.shareUrl} target="_blank" rel="noreferrer">
                <Button size="sm" variant="ghost">{t.share.preview}</Button>
              </a>
            </div>
          </div>
        )}

        <div className="mt-6 flex justify-center gap-2 print:hidden">
          <Button
            onClick={() => {
              navigator.clipboard
                ?.writeText(handoff.prettyCode)
                .then(() => toast.success(t.sessionNew.codeCopied, handoff.prettyCode))
                .catch(() => toast.error(t.share.copyFailed, t.sessionNew.copyCodeFailedBody));
            }}
          >
            {t.sessionNew.copyCode}
          </Button>
          {/*
            The same URL the QR encodes. Pasted into WhatsApp it behaves
            identically — one tap opens the app with the code already in place —
            which is the only hand-off that works when the driver is not
            standing at the desk.
          */}
          <Button
            onClick={() => {
              navigator.clipboard
                ?.writeText(handoff.webLink)
                .then(() => toast.success(t.sessionNew.linkCopied, t.sessionNew.linkCopiedBody))
                .catch(() => toast.error(t.share.copyFailed, t.sessionNew.copyLinkFailedBody));
            }}
          >
            {t.sessionNew.copyLink}
          </Button>
          <Button onClick={() => window.print()}>{t.sessionNew.print}</Button>
          <Link href={`/sessions/${session.sessionId}`}>
            <Button variant="primary">{t.sessionNew.goToSession}</Button>
          </Link>
        </div>
      </div>
    </AppShell>
  );
}
