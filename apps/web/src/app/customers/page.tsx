'use client';

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, type Customer } from '@/lib/api';
import { AppShell, useRequireAuth } from '@/components/AppShell';
import { CustomerDialog } from '@/components/CustomerDialog';
import { countryLabel, isExport } from '@/lib/countries';
import {
  Badge,
  Button,
  EmptyState,
  ErrorState,
  PageHeader,
  SearchInput,
  Table,
  TableSkeletonRows,
  TD,
  TH,
  THead,
  TR,
  TRMessage,
} from '@/components/ui';

const COLS = 7;

export default function CustomersPage() {
  const authed = useRequireAuth();
  const [search, setSearch] = useState('');
  const [dialog, setDialog] = useState(false);
  /*
   * Which consignee the dialog is showing. Null is "add a new one".
   *
   * Held beside `dialog` rather than derived from it so the dialog keeps
   * rendering the right customer while it animates closed — clearing this on
   * close would blank every field for the length of the transition.
   */
  const [editing, setEditing] = useState<Customer | null>(null);

  const { data, isLoading, isError, error, isFetching, refetch } = useQuery({
    queryKey: ['customers'],
    queryFn: () => api.customers(),
    enabled: authed,
  });

  // Client-side: the customer list is a few hundred rows at most, and filtering
  // in the browser is instant where a round trip per keystroke is not.
  const items = useMemo(() => {
    const q = search.trim().toLocaleLowerCase('tr');
    const all = data ?? [];
    if (!q) return all;
    return all.filter((c) =>
      [c.name, c.code, c.city, c.contactName, countryLabel(c.countryCode)].filter(Boolean).some((v) =>
        String(v).toLocaleLowerCase('tr').includes(q),
      ),
    );
  }, [data, search]);

  if (!authed) return null;

  return (
    <AppShell>
      <PageHeader
        title="Müşteriler"
        subtitle="Sevkiyatların teslim edildiği taraflar"
        actions={
          <Button variant="primary" onClick={() => { setEditing(null); setDialog(true); }}>
            + Yeni müşteri
          </Button>
        }
      />

      <div className="flex items-center gap-3 px-5 py-3">
        <SearchInput
          value={search}
          onValueChange={setSearch}
          placeholder="Ünvan, kod, şehir…"
          className="ml-auto w-72"
        />
      </div>

      <div className="min-h-0 flex-1 px-5 pb-5">
        <div className="overflow-hidden rounded-md bg-surface ring-1 ring-line">
          <Table>
            <THead>
              <TR>
                <TH>Kod</TH>
                <TH>Ünvan</TH>
                <TH>Ülke</TH>
                <TH>Şehir</TH>
                <TH>Yetkili</TH>
                <TH>Telefon</TH>
                <TH>Konum</TH>
                <TH></TH>
              </TR>
            </THead>
            <tbody>
              {isLoading ? (
                <TableSkeletonRows rows={8} cols={COLS} />
              ) : isError ? (
                <TRMessage colSpan={COLS} tone="danger">
                  <ErrorState
                    className="mx-auto max-w-md text-left"
                    title="Müşteri listesi yüklenemedi"
                    message={(error as Error)?.message}
                    onRetry={() => refetch()}
                    retrying={isFetching}
                  />
                </TRMessage>
              ) : items.length === 0 ? (
                <TRMessage colSpan={COLS}>
                  <EmptyState
                    title={search ? 'Eşleşen müşteri yok' : 'Henüz müşteri yok'}
                    description={
                      search
                        ? undefined
                        : 'Sipariş oluşturabilmek için önce en az bir müşteri tanımlamalısınız.'
                    }
                    action={
                      <Button variant="primary" size="sm" onClick={() => { setEditing(null); setDialog(true); }}>
                        Müşteri ekle
                      </Button>
                    }
                  />
                </TRMessage>
              ) : (
                items.map((c) => (
                  <TR key={c.id}>
                    <TD>
                      <span className="kh-num text-ink-2">{c.code}</span>
                    </TD>
                    <TD>
                      <span className="font-medium">{c.name}</span>
                      {!c.isActive && (
                        <Badge tone="neutral" className="ml-2">
                          Pasif
                        </Badge>
                      )}
                    </TD>
                    <TD>
                      {/* An export shipment needs customs paperwork a domestic
                          one does not, so it is worth spotting in a list. */}
                      {isExport(c.countryCode) ? (
                        <Badge tone="brand">{countryLabel(c.countryCode)}</Badge>
                      ) : (
                        <span className="text-ink-2">{countryLabel(c.countryCode)}</span>
                      )}
                    </TD>
                    <TD muted>{c.city ?? '—'}</TD>
                    <TD muted>{c.contactName ?? '—'}</TD>
                    <TD>
                      {c.contactPhone ? (
                        <a href={`tel:${c.contactPhone}`} className="kh-num text-brand-text hover:underline">
                          {c.contactPhone}
                        </a>
                      ) : (
                        <span className="text-ink-3">—</span>
                      )}
                    </TD>
                    <TD>
                      {/* Whether a customer has coordinates decides whether
                          arrival can ever be detected for their deliveries. */}
                      {c.lat !== null && c.lon !== null ? (
                        <Badge tone="success">Kayıtlı</Badge>
                      ) : (
                        <Badge tone="warn">Koordinat yok</Badge>
                      )}
                    </TD>
                    <TD>
                      {/*
                        The row already said "Koordinat yok" and offered no way
                        to fix it, which is how three consignees out of three
                        ended up with no delivery point: the problem was
                        visible and unactionable in the same place.
                      */}
                      <Button
                        size="sm"
                        onClick={() => {
                          setEditing(c);
                          setDialog(true);
                        }}
                      >
                        Düzenle
                      </Button>
                    </TD>
                  </TR>
                ))
              )}
            </tbody>
          </Table>
        </div>
      </div>

      <CustomerDialog open={dialog} onClose={() => setDialog(false)} customer={editing} />
    </AppShell>
  );
}
