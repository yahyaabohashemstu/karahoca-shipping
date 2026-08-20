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
import { useI18n, useT } from '@/lib/i18n';
import { searchFold } from '@/lib/search';

const COLS = 7;

export default function CustomersPage() {
  const { locale } = useI18n();
  const t = useT();
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
    const q = searchFold(search.trim());
    const all = data ?? [];
    if (!q) return all;
    return all.filter((c) =>
      [c.name, c.code, c.city, c.contactName, countryLabel(c.countryCode, locale)].filter(Boolean).some((v) =>
        searchFold(String(v)).includes(q),
      ),
    );
  }, [data, search, locale]);

  if (!authed) return null;

  return (
    <AppShell>
      <PageHeader
        title={t.customers.title}
        subtitle={t.customers.subtitle}
        actions={
          <Button variant="primary" onClick={() => { setEditing(null); setDialog(true); }}>
            {t.customers.create}
          </Button>
        }
      />

      <div className="flex items-center gap-3 px-5 py-3">
        <SearchInput
          value={search}
          onValueChange={setSearch}
          placeholder={t.customers.searchPlaceholder}
          className="ms-auto w-72"
        />
      </div>

      <div className="min-h-0 flex-1 px-5 pb-5">
        <div className="overflow-hidden rounded-xl bg-surface ring-1 ring-line">
          <Table>
            <THead>
              <TR>
                <TH>{t.customers.colCode}</TH>
                <TH>{t.customers.colName}</TH>
                <TH>{t.customers.colCountry}</TH>
                <TH>{t.customers.colCity}</TH>
                <TH>{t.customers.colContact}</TH>
                <TH>{t.customers.colPhone}</TH>
                <TH>{t.customers.colLocation}</TH>
                <TH></TH>
              </TR>
            </THead>
            <tbody>
              {isLoading ? (
                <TableSkeletonRows rows={8} cols={COLS} />
              ) : isError ? (
                <TRMessage colSpan={COLS} tone="danger">
                  <ErrorState
                    className="mx-auto max-w-md text-start"
                    title={t.customers.loadFailed}
                    message={(error as Error)?.message}
                    onRetry={() => refetch()}
                    retrying={isFetching}
                  />
                </TRMessage>
              ) : items.length === 0 ? (
                <TRMessage colSpan={COLS}>
                  <EmptyState
                    title={search ? t.customers.emptyMatch : t.customers.empty}
                    description={
                      search
                        ? undefined
                        : t.customers.emptyBody
                    }
                    action={
                      <Button variant="primary" size="sm" onClick={() => { setEditing(null); setDialog(true); }}>
                        {t.customers.createShort}
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
                        <Badge tone="neutral" className="ms-2">
                          {t.carriers.inactive}
                        </Badge>
                      )}
                    </TD>
                    <TD>
                      {/* An export shipment needs customs paperwork a domestic
                          one does not, so it is worth spotting in a list. */}
                      {isExport(c.countryCode) ? (
                        <Badge tone="brand">{countryLabel(c.countryCode, locale)}</Badge>
                      ) : (
                        <span className="text-ink-2">{countryLabel(c.countryCode, locale)}</span>
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
                        <Badge tone="success">{t.customers.located}</Badge>
                      ) : (
                        <Badge tone="warn">{t.customers.noCoordinates}</Badge>
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
                        {t.common.edit}
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
