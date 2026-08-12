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

const COLS = 6;

/**
 * Carriers, with their vehicles and drivers.
 *
 * One page rather than a list plus a detail route, because the API has no
 * GET /shipping-companies/:id — and because a dispatcher checking whether a
 * carrier has a plate on file is doing it mid-call, not navigating a hierarchy.
 */
export default function CarriersPage() {
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
    const q = search.trim().toLocaleLowerCase('tr');
    const all = data ?? [];
    if (!q) return all;
    return all.filter((c) =>
      [c.name, c.code, c.contactName].filter(Boolean).some((v) =>
        String(v).toLocaleLowerCase('tr').includes(q),
      ),
    );
  }, [data, search]);

  if (!authed) return null;

  return (
    <AppShell>
      <PageHeader
        title="Nakliyeciler"
        subtitle="Sevkiyatları taşıyan üçüncü taraf firmalar, araçları ve sürücüleri"
        actions={
          <Button variant="primary" onClick={() => setDialog(true)}>
            + Yeni nakliyeci
          </Button>
        }
      />

      <div className="flex items-center gap-3 px-5 py-3">
        <SearchInput
          value={search}
          onValueChange={setSearch}
          placeholder="Firma adı, kod…"
          className="ml-auto w-72"
        />
      </div>

      <div className="min-h-0 flex-1 px-5 pb-5">
        <div className="overflow-hidden rounded-md bg-surface ring-1 ring-line">
          <Table>
            <THead>
              <TR>
                <TH>Kod</TH>
                <TH>Firma</TH>
                <TH>Yetkili</TH>
                <TH>Telefon</TH>
                <TH numeric>Araç / Sürücü</TH>
                <TH numeric>SLA</TH>
              </TR>
            </THead>
            <tbody>
              {isLoading ? (
                <TableSkeletonRows rows={6} cols={COLS} />
              ) : isError ? (
                <TRMessage colSpan={COLS} tone="danger">
                  <ErrorState
                    className="mx-auto max-w-md text-left"
                    title="Nakliyeci listesi yüklenemedi"
                    message={(error as Error)?.message}
                    onRetry={() => refetch()}
                    retrying={isFetching}
                  />
                </TRMessage>
              ) : items.length === 0 ? (
                <TRMessage colSpan={COLS}>
                  <EmptyState
                    title={search ? 'Eşleşen firma yok' : 'Henüz nakliyeci yok'}
                    description={
                      search
                        ? undefined
                        : 'Takip oturumu açabilmek için sevkiyatı taşıyan firmayı tanımlamalısınız.'
                    }
                    action={
                      <Button variant="primary" size="sm" onClick={() => setDialog(true)}>
                        Nakliyeci ekle
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
            <Badge tone="neutral" className="ml-2">
              Pasif
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
          <h3 className="text-sm font-semibold">Araçlar</h3>
          <Button size="sm" onClick={() => setAdding('vehicle')}>
            + Araç
          </Button>
        </div>
        <div className="px-3 py-2">
          {vehicles.isLoading ? (
            <Skeleton className="h-3 w-40" />
          ) : vehicles.isError ? (
            <ErrorState compact title="Araçlar alınamadı" onRetry={() => vehicles.refetch()} />
          ) : (vehicles.data?.length ?? 0) === 0 ? (
            <p className="py-2 text-sm text-ink-3">Kayıtlı araç yok.</p>
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
          <h3 className="text-sm font-semibold">Sürücüler</h3>
          <Button size="sm" onClick={() => setAdding('driver')}>
            + Sürücü
          </Button>
        </div>
        <div className="px-3 py-2">
          {drivers.isLoading ? (
            <Skeleton className="h-3 w-40" />
          ) : drivers.isError ? (
            <ErrorState compact title="Sürücüler alınamadı" onRetry={() => drivers.refetch()} />
          ) : (drivers.data?.length ?? 0) === 0 ? (
            <p className="py-2 text-sm text-ink-3">Kayıtlı sürücü yok.</p>
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
      toast.success('Nakliyeci eklendi', c.name);
      setCode('');
      setName('');
      setContactName('');
      setContactPhone('');
      setSlaHours('');
      create.reset();
      onClose();
    },
    onError: (e) => toast.error('Eklenemedi', (e as Error).message),
  });

  const valid = code.trim().length >= 2 && name.trim().length >= 2;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Yeni nakliyeci"
      description="Sevkiyatı taşıyan üçüncü taraf firma"
      footer={
        <>
          <Button onClick={onClose} disabled={create.isPending}>
            Vazgeç
          </Button>
          <Button variant="primary" loading={create.isPending} disabled={!valid} onClick={() => create.mutate()}>
            Ekle
          </Button>
        </>
      }
    >
      <div className="space-y-3.5">
        <div className="grid grid-cols-[8rem_1fr] gap-3">
          <Input
            label="Kod"
            required
            value={code}
            onChange={(e) => setCode(e.target.value.toLocaleUpperCase('tr'))}
            placeholder="NAK-01"
            numeric
          />
          <Input
            label="Firma ünvanı"
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Örnek Nakliyat Ltd. Şti."
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Input label="Yetkili" value={contactName} onChange={(e) => setContactName(e.target.value)} />
          <Input
            label="Telefon"
            type="tel"
            value={contactPhone}
            onChange={(e) => setContactPhone(e.target.value)}
            placeholder="+90…"
            numeric
          />
        </div>
        <Input
          label="SLA (saat)"
          type="number"
          min={0}
          value={slaHours}
          onChange={(e) => setSlaHours(e.target.value)}
          numeric
          hint="Teslimatın kaç saat içinde tamamlanması beklendiği. Performans raporunda kullanılır."
        />
        {create.isError && <ErrorState compact title="Eklenemedi" message={(create.error as Error).message} />}
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
      toast.success(kind === 'vehicle' ? 'Araç eklendi' : 'Sürücü eklendi');
      reset();
      onClose();
    },
    onError: (e) => toast.error('Eklenemedi', (e as Error).message),
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
      title={kind === 'vehicle' ? 'Araç ekle' : 'Sürücü ekle'}
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
            Vazgeç
          </Button>
          <Button variant="primary" loading={create.isPending} disabled={!valid} onClick={() => create.mutate()}>
            Ekle
          </Button>
        </>
      }
    >
      <div className="space-y-3.5">
        {kind === 'vehicle' ? (
          <>
            <Input
              label="Plaka"
              required
              value={a}
              onChange={(e) => setA(e.target.value.toLocaleUpperCase('tr'))}
              placeholder="34 ABC 123"
              numeric
            />
            <Input label="Marka / model" value={b} onChange={(e) => setB(e.target.value)} placeholder="Mercedes Actros" />
            <Input
              label="Kapasite (kg)"
              type="number"
              min={0}
              value={c}
              onChange={(e) => setC(e.target.value)}
              numeric
            />
          </>
        ) : (
          <>
            <Input label="Ad soyad" required value={a} onChange={(e) => setA(e.target.value)} />
            <Input
              label="Telefon"
              required
              type="tel"
              value={b}
              onChange={(e) => setB(e.target.value)}
              placeholder="+90…"
              numeric
            />
            <Input
              label="TC son 4 hane"
              value={c}
              onChange={(e) => setC(e.target.value.replace(/\D/g, '').slice(0, 4))}
              maxLength={4}
              numeric
              hint="Kapıda kimlik doğrulaması için. Tam kimlik numarası saklanmaz."
            />
          </>
        )}
        {create.isError && <ErrorState compact title="Eklenemedi" message={(create.error as Error).message} />}
      </div>
    </Modal>
  );
}
