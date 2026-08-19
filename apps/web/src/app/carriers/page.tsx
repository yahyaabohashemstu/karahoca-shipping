'use client';

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type Driver, type ShippingCompany, type Vehicle } from '@/lib/api';
import { AppShell, useRequireAuth } from '@/components/AppShell';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  Input,
  Modal,
  PageHeader,
  SearchInput,
  Skeleton,
  Table,
  TableSkeletonRows,
  TD,
  TH,
  THead,
  TR,
  TRMessage,
  useToast,
} from '@/components/ui';
import { useT } from '@/lib/i18n';
import { upperIdentifier } from '@/lib/identifier';
import { searchFold } from '@/lib/search';

const COLS = 6;

/**
 * Carriers, with their vehicles and drivers.
 *
 * One page rather than a list plus a detail route, because the API has no
 * GET /shipping-companies/:id — and because a dispatcher checking whether a
 * carrier has a plate on file is doing it mid-call, not navigating a hierarchy.
 */
export default function CarriersPage() {
  const t = useT();
  const authed = useRequireAuth();
  const [search, setSearch] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [dialog, setDialog] = useState(false);

  const { data, isLoading, isError, error, isFetching, refetch } = useQuery({
    queryKey: ['companies'],
    queryFn: api.companies,
    enabled: authed,
  });

  const items = useMemo(() => {
    const q = searchFold(search.trim());
    const all = data ?? [];
    if (!q) return all;
    return all.filter((c) =>
      [c.name, c.code, c.contactName].filter(Boolean).some((v) =>
        searchFold(String(v)).includes(q),
      ),
    );
  }, [data, search]);

  if (!authed) return null;

  return (
    <AppShell>
      <PageHeader
        title={t.carriers.title}
        subtitle={t.carriers.subtitle}
        actions={
          <Button variant="primary" onClick={() => setDialog(true)}>
            {t.carriers.create}
          </Button>
        }
      />

      <div className="flex items-center gap-3 px-5 py-3">
        <SearchInput
          value={search}
          onValueChange={setSearch}
          placeholder={t.carriers.searchPlaceholder}
          className="ms-auto w-72"
        />
      </div>

      <div className="min-h-0 flex-1 px-5 pb-5">
        <div className="overflow-hidden rounded-md bg-surface ring-1 ring-line">
          <Table>
            <THead>
              <TR>
                <TH>{t.carriers.colCode}</TH>
                <TH>{t.carriers.colName}</TH>
                <TH>{t.carriers.colContact}</TH>
                <TH>{t.carriers.colPhone}</TH>
                <TH numeric>{t.carriers.colFleet}</TH>
                <TH numeric>{t.carriers.colSla}</TH>
              </TR>
            </THead>
            <tbody>
              {isLoading ? (
                <TableSkeletonRows rows={6} cols={COLS} />
              ) : isError ? (
                <TRMessage colSpan={COLS} tone="danger">
                  <ErrorState
                    className="mx-auto max-w-md text-start"
                    title={t.carriers.loadFailed}
                    message={(error as Error)?.message}
                    onRetry={() => refetch()}
                    retrying={isFetching}
                  />
                </TRMessage>
              ) : items.length === 0 ? (
                <TRMessage colSpan={COLS}>
                  <EmptyState
                    title={search ? t.carriers.emptyMatch : t.carriers.empty}
                    description={
                      search
                        ? undefined
                        : t.carriers.emptyBody
                    }
                    action={
                      <Button variant="primary" size="sm" onClick={() => setDialog(true)}>
                        {t.carriers.createShort}
                      </Button>
                    }
                  />
                </TRMessage>
              ) : (
                items.map((c) => (
                  <CarrierRow
                    key={c.id}
                    carrier={c}
                    expanded={expanded === c.id}
                    onToggle={() => setExpanded(expanded === c.id ? null : c.id)}
                  />
                ))
              )}
            </tbody>
          </Table>
        </div>
      </div>

      <CarrierDialog open={dialog} onClose={() => setDialog(false)} />
    </AppShell>
  );
}

/* -------------------------------------------------------------------------- */

function CarrierRow({
  carrier,
  expanded,
  onToggle,
}: {
  carrier: ShippingCompany;
  expanded: boolean;
  onToggle: () => void;
}) {
  const t = useT();
  return (
    <>
      <TR onClick={onToggle} selected={expanded}>
        <TD>
          <span className="flex items-center gap-1.5">
            <svg
              viewBox="0 0 10 10"
              className={`h-2.5 w-2.5 shrink-0 text-ink-3 transition-transform ${expanded ? 'rotate-90' : ''}`}
              fill="none"
              aria-hidden
            >
              <path d="m3.5 2 3.5 3-3.5 3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <span className="kh-num text-ink-2">{carrier.code}</span>
          </span>
        </TD>
        <TD>
          <span className="font-medium">{carrier.name}</span>
          {!carrier.isActive && (
            <Badge tone="neutral" className="ms-2">
              {t.carriers.inactive}
            </Badge>
          )}
        </TD>
        <TD muted>{carrier.contactName ?? '—'}</TD>
        <TD>
          {carrier.contactPhone ? (
            <a
              href={`tel:${carrier.contactPhone}`}
              className="kh-num text-brand-text hover:underline"
              onClick={(e) => e.stopPropagation()}
            >
              {carrier.contactPhone}
            </a>
          ) : (
            <span className="text-ink-3">—</span>
          )}
        </TD>
        <TD numeric muted>
          {carrier.vehicleCount} / {carrier.driverCount}
        </TD>
        <TD numeric muted>{carrier.slaHours !== null ? `${carrier.slaHours} sa` : '—'}</TD>
      </TR>

      {expanded && (
        <tr>
          <td colSpan={COLS} className="bg-surface-2 px-3 py-3">
            <FleetOfCarrier carrier={carrier} />
          </td>
        </tr>
      )}
    </>
  );
}

function FleetOfCarrier({ carrier }: { carrier: ShippingCompany }) {
  const t = useT();
  const [adding, setAdding] = useState<'vehicle' | 'driver' | null>(null);

  const vehicles = useQuery({
    queryKey: ['vehicles', carrier.id],
    queryFn: () => api.vehicles(carrier.id),
  });
  const drivers = useQuery({
    queryKey: ['drivers', carrier.id],
    queryFn: () => api.drivers(carrier.id),
  });

  return (
    <div className="grid gap-3 lg:grid-cols-2">
      <Card padded={false}>
        <div className="flex items-center justify-between border-b border-line px-3 py-2">
          <h3 className="text-sm font-semibold">{t.carriers.vehicles}</h3>
          <Button size="sm" onClick={() => setAdding('vehicle')}>
            {t.carriers.addVehicle}
          </Button>
        </div>
        <div className="px-3 py-2">
          {vehicles.isLoading ? (
            <Skeleton className="h-3 w-40" />
          ) : vehicles.isError ? (
            <ErrorState compact title={t.carriers.vehiclesFailed} onRetry={() => vehicles.refetch()} />
          ) : (vehicles.data?.length ?? 0) === 0 ? (
            <p className="py-2 text-sm text-ink-3">{t.carriers.noVehicles}</p>
          ) : (
            <ul className="divide-y divide-line">
              {vehicles.data!.map((v) => (
                <li key={v.id} className="flex items-baseline justify-between gap-3 py-1.5">
                  <span className="kh-num font-medium">{v.plate}</span>
                  <span className="truncate text-sm text-ink-2">{v.makeModel ?? '—'}</span>
                  <span className="kh-num shrink-0 text-sm text-ink-3">
                    {v.capacityKg ? `${v.capacityKg.toLocaleString('tr-TR')} kg` : '—'}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Card>

      <Card padded={false}>
        <div className="flex items-center justify-between border-b border-line px-3 py-2">
          <h3 className="text-sm font-semibold">{t.carriers.drivers}</h3>
          <Button size="sm" onClick={() => setAdding('driver')}>
            {t.carriers.addDriver}
          </Button>
        </div>
        <div className="px-3 py-2">
          {drivers.isLoading ? (
            <Skeleton className="h-3 w-40" />
          ) : drivers.isError ? (
            <ErrorState compact title={t.carriers.driversFailed} onRetry={() => drivers.refetch()} />
          ) : (drivers.data?.length ?? 0) === 0 ? (
            <p className="py-2 text-sm text-ink-3">{t.carriers.noDrivers}</p>
          ) : (
            <ul className="divide-y divide-line">
              {drivers.data!.map((d) => (
                <li key={d.id} className="flex items-baseline justify-between gap-3 py-1.5">
                  <span className="truncate font-medium">{d.fullName}</span>
                  <a href={`tel:${d.phone}`} className="kh-num shrink-0 text-sm text-brand-text hover:underline">
                    {d.phone}
                  </a>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Card>

      <VehicleOrDriverDialog
        kind={adding}
        carrier={carrier}
        onClose={() => setAdding(null)}
      />
    </div>
  );
}

/* -------------------------------------------------------------------------- */

function CarrierDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useT();
  const qc = useQueryClient();
  const toast = useToast();
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [contactName, setContactName] = useState('');
  const [contactPhone, setContactPhone] = useState('');
  const [slaHours, setSlaHours] = useState('');

  const create = useMutation({
    mutationFn: () =>
      api.createCompany({
        code: code.trim(),
        name: name.trim(),
        contactName: contactName.trim() || undefined,
        contactPhone: contactPhone.trim() || undefined,
        slaHours: slaHours ? Number(slaHours) : undefined,
      }),
    onSuccess: (c) => {
      qc.invalidateQueries({ queryKey: ['companies'] });
      toast.success(t.carriers.added, c.name);
      setCode('');
      setName('');
      setContactName('');
      setContactPhone('');
      setSlaHours('');
      create.reset();
      onClose();
    },
    onError: (e) => toast.error(t.carriers.addFailed, (e as Error).message),
  });

  const valid = code.trim().length >= 2 && name.trim().length >= 2;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t.carriers.newTitle}
      description={t.carriers.newDescription}
      footer={
        <>
          <Button onClick={onClose} disabled={create.isPending}>
            {t.common.cancel}
          </Button>
          <Button variant="primary" loading={create.isPending} disabled={!valid} onClick={() => create.mutate()}>
            {t.common.add}
          </Button>
        </>
      }
    >
      <div className="space-y-3.5">
        <div className="grid grid-cols-[8rem_1fr] gap-3">
          <Input
            label={t.carriers.code}
            required
            value={code}
            onChange={(e) => setCode(upperIdentifier(e.target.value))}
            placeholder={t.carriers.codePlaceholder}
            numeric
          />
          <Input
            label={t.carriers.name}
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t.carriers.namePlaceholder}
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Input label={t.carriers.colContact} value={contactName} onChange={(e) => setContactName(e.target.value)} />
          <Input
            label={t.carriers.colPhone}
            type="tel"
            value={contactPhone}
            onChange={(e) => setContactPhone(e.target.value)}
            placeholder="+90…"
            numeric
          />
        </div>
        <Input
          label={t.carriers.sla}
          type="number"
          min={0}
          value={slaHours}
          onChange={(e) => setSlaHours(e.target.value)}
          numeric
          hint={t.carriers.slaHint}
        />
        {create.isError && <ErrorState compact title={t.carriers.addFailed} message={(create.error as Error).message} />}
      </div>
    </Modal>
  );
}

function VehicleOrDriverDialog({
  kind,
  carrier,
  onClose,
}: {
  kind: 'vehicle' | 'driver' | null;
  carrier: ShippingCompany;
  onClose: () => void;
}) {
  const t = useT();
  const qc = useQueryClient();
  const toast = useToast();
  const [a, setA] = useState('');
  const [b, setB] = useState('');
  const [c, setC] = useState('');

  function reset() {
    setA('');
    setB('');
    setC('');
    create.reset();
  }

  const create = useMutation<Vehicle | Driver>({
    mutationFn: () =>
      kind === 'vehicle'
        ? api.createVehicle({
            shippingCompanyId: carrier.id,
            plate: a.trim(),
            makeModel: b.trim() || undefined,
            capacityKg: c ? Number(c) : undefined,
          })
        : api.createDriver({
            shippingCompanyId: carrier.id,
            fullName: a.trim(),
            phone: b.trim(),
            nationalIdLast4: c.trim() || undefined,
          }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [kind === 'vehicle' ? 'vehicles' : 'drivers', carrier.id] });
      qc.invalidateQueries({ queryKey: ['companies'] });
      toast.success(kind === 'vehicle' ? t.carriers.vehicleAdded : t.carriers.driverAdded);
      reset();
      onClose();
    },
    onError: (e) => toast.error(t.carriers.addFailed, (e as Error).message),
  });

  const valid =
    kind === 'vehicle' ? a.trim().length >= 2 : a.trim().length >= 2 && b.trim().length >= 5;

  return (
    <Modal
      open={kind !== null}
      onClose={() => {
        reset();
        onClose();
      }}
      title={kind === 'vehicle' ? t.carriers.vehicleDialog : t.carriers.driverDialog}
      description={carrier.name}
      size="sm"
      footer={
        <>
          <Button
            onClick={() => {
              reset();
              onClose();
            }}
            disabled={create.isPending}
          >
            {t.common.cancel}
          </Button>
          <Button variant="primary" loading={create.isPending} disabled={!valid} onClick={() => create.mutate()}>
            {t.common.add}
          </Button>
        </>
      }
    >
      <div className="space-y-3.5">
        {kind === 'vehicle' ? (
          <>
            <Input
              label={t.carriers.plate}
              required
              value={a}
              onChange={(e) => setA(upperIdentifier(e.target.value))}
              placeholder={t.carriers.platePlaceholder}
              numeric
            />
            <Input
              label={t.carriers.model}
              value={b}
              onChange={(e) => setB(e.target.value)}
              placeholder={t.carriers.modelPlaceholder}
            />
            <Input
              label={t.carriers.capacity}
              type="number"
              min={0}
              value={c}
              onChange={(e) => setC(e.target.value)}
              numeric
            />
          </>
        ) : (
          <>
            <Input label={t.carriers.fullName} required value={a} onChange={(e) => setA(e.target.value)} />
            <Input
              label={t.carriers.colPhone}
              required
              type="tel"
              value={b}
              onChange={(e) => setB(e.target.value)}
              placeholder="+90…"
              numeric
            />
            <Input
              label={t.carriers.idLast4}
              value={c}
              onChange={(e) => setC(e.target.value.replace(/\D/g, '').slice(0, 4))}
              maxLength={4}
              numeric
              hint={t.carriers.idLast4Hint}
            />
          </>
        )}
        {create.isError && <ErrorState compact title={t.carriers.addFailed} message={(create.error as Error).message} />}
      </div>
    </Modal>
  );
}
