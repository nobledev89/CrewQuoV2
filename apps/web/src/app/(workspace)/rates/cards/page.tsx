'use client';

import { useMemo, useState } from 'react';
import {
  RATE_KINDS,
  RATE_LABELS,
  RATE_MODES,
  type RateCardCreate,
  type RateCardView,
  type RoleCatalogView,
} from '@crewquo/shared';
import Link from 'next/link';
import { Badge, Button, Drawer, EmptyState, ErrorText, Field, Input, PageHeader, SearchInput, Section, Select, SortableTh, Stack, Table } from '@crewquo/ui';
import { Shell } from '@/components/Shell';
import { api, ApiError } from '@/api/client';
import { useSessionCtx } from '@/auth/AuthProvider';
import { useAsyncList } from '@/lib/useAsyncList';
import { useSort } from '@/lib/useSort';
import { useUrlQuery } from '@/lib/useUrlQuery';
import { formatCents, inputToCents } from '@/lib/format';

export default function RateCardsPage() {
  return (
    <Shell>
      <RateCards />
    </Shell>
  );
}

interface FormState {
  kind: string;
  roleId: string;
  rateMode: string;
  rateLabel: string;
  hourly: string;
  ot: string;
  shift: string;
  daily: string;
  minHours: string;
  effectiveFrom: string;
  effectiveTo: string;
}

const EMPTY_FORM: FormState = {
  kind: 'PAY',
  roleId: '',
  rateMode: 'HOURLY',
  rateLabel: 'MON_FRI_DAY',
  hourly: '',
  ot: '',
  shift: '',
  daily: '',
  minHours: '',
  effectiveFrom: new Date().toISOString().slice(0, 10),
  effectiveTo: '',
};

function RateCards() {
  const ctx = useSessionCtx();
  const roles = useAsyncList<RoleCatalogView>(
    ctx ? () => api.listRoles(ctx.accessToken, ctx.companyId).then((r) => r.data) : null,
    [ctx?.companyId]
  );
  const cards = useAsyncList<RateCardView>(
    ctx ? () => api.listRateCards(ctx.accessToken, ctx.companyId).then((r) => r.data) : null,
    [ctx?.companyId]
  );

  const roleName = useMemo(() => {
    const map = new Map(roles.items.map((r) => [r.id, r.name]));
    return (id: string) => map.get(id) ?? id.slice(0, 8);
  }, [roles.items]);

  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [query, setQuery] = useUrlQuery();
  const [open, setOpen] = useState(false);
  const [added, setAdded] = useState(0);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const set = (patch: Partial<FormState>) => setForm((f) => ({ ...f, ...patch }));

  // `roleName` resolves through the roles list, so sorting by role has to sort by the
  // name shown — sorting by the raw uuid would look like no ordering at all.
  const sorts = useMemo(
    () => ({
      kind: (c: RateCardView) => c.kind,
      role: (c: RateCardView) => roleName(c.roleId),
      label: (c: RateCardView) => c.rateLabel,
      mode: (c: RateCardView) => c.rateMode,
      rate: (c: RateCardView) => rateForMode(c),
      from: (c: RateCardView) => c.effectiveFrom,
    }),
    [roleName]
  );
  const { sort, onSort, apply } = useSort<RateCardView>(sorts, { key: 'role', direction: 'asc' });

  const filteredCards = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return apply(cards.items.filter((card) => !needle || [card.kind, card.rateLabel, card.rateMode, roleName(card.roleId)].some((value) => value.toLowerCase().includes(needle))));
  }, [cards.items, query, roleName, apply]);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (!ctx) return;
    setBusy(true);
    setFormError(null);
    const body: RateCardCreate = {
      kind: form.kind as RateCardCreate['kind'],
      counterpartyCompanyId: null,
      roleId: form.roleId,
      rateMode: form.rateMode as RateCardCreate['rateMode'],
      rateLabel: form.rateLabel as RateCardCreate['rateLabel'],
      hourlyRateCents: inputToCents(form.hourly),
      otHourlyRateCents: inputToCents(form.ot),
      shiftRateCents: inputToCents(form.shift),
      dailyRateCents: inputToCents(form.daily),
      minHours: form.minHours.trim() === '' ? null : Number(form.minHours),
      weekendMultiplier: null,
      nightMultiplier: null,
      effectiveFrom: form.effectiveFrom,
      effectiveTo: form.effectiveTo.trim() === '' ? null : form.effectiveTo,
      active: true,
    };
    try {
      await api.createRateCard(ctx.accessToken, ctx.companyId, body);
      // The panel stays open and keeps role + kind: a company sets up a whole rate
      // schedule in one sitting, so closing after each card would mean reopening it
      // twenty times. The count in the toolbar behind it moves as proof it landed.
      setForm({ ...EMPTY_FORM, roleId: form.roleId, kind: form.kind });
      setAdded((n) => n + 1);
      cards.reload();
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : 'Failed to create rate card');
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    if (!ctx || !window.confirm('Delete this rate card? This action cannot be undone.')) return;
    try {
      await api.deleteRateCard(ctx.accessToken, ctx.companyId, id);
      cards.reload();
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : 'Failed to delete rate card');
    }
  }

  const noRoles = !roles.loading && roles.items.length === 0;

  return (
    <Stack>
      <PageHeader
        eyebrow="Rates"
        title="Rate cards"
        description="Effective-dated contractor costs and client charges."
        actions={
          <Button onClick={() => setOpen(true)} disabled={noRoles}>New rate card</Button>
        }
      />

      {noRoles ? (
        <div className="cq-notice">
          Add a <Link href="/rates/roles">role</Link> first — a rate card attaches to one.
        </div>
      ) : null}

      <Drawer
        open={open}
        title="Add rate card"
        description="One pay or bill rule for a role, timeframe and rate mode."
        onClose={() => setOpen(false)}
        footer={
          <>
            <Button type="submit" form="add-rate-card" disabled={busy || form.roleId === ''}>
              {busy ? 'Saving…' : 'Add rate card'}
            </Button>
            <Button variant="secondary" onClick={() => setOpen(false)}>Done</Button>
          </>
        }
      >
          <form id="add-rate-card" onSubmit={create}>
            <Stack>
              <div className="cq-form-grid cq-form-grid--drawer">
                <Field label="Kind">
                  <Select value={form.kind} onChange={(e) => set({ kind: e.target.value })}>
                    {RATE_KINDS.map((k) => (
                      <option key={k} value={k}>
                        {k === 'PAY' ? 'PAY (to provider)' : 'BILL (to client)'}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Role">
                  <Select
                    value={form.roleId}
                    onChange={(e) => set({ roleId: e.target.value })}
                    required
                  >
                    <option value="" disabled>
                      Select a role…
                    </option>
                    {roles.items.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.name}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Mode">
                  <Select value={form.rateMode} onChange={(e) => set({ rateMode: e.target.value })}>
                    {RATE_MODES.map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Label">
                  <Select value={form.rateLabel} onChange={(e) => set({ rateLabel: e.target.value })}>
                    {RATE_LABELS.map((l) => (
                      <option key={l} value={l}>
                        {l}
                      </option>
                    ))}
                  </Select>
                </Field>

                {form.rateMode === 'HOURLY' && (
                  <>
                    <Field label="Hourly rate ($)">
                      <Input value={form.hourly} onChange={(e) => set({ hourly: e.target.value })} inputMode="decimal" />
                    </Field>
                    <Field label="OT rate ($, optional)">
                      <Input value={form.ot} onChange={(e) => set({ ot: e.target.value })} inputMode="decimal" placeholder="× 1.5 if blank" />
                    </Field>
                    <Field label="Min hours">
                      <Input value={form.minHours} onChange={(e) => set({ minHours: e.target.value })} inputMode="decimal" />
                    </Field>
                  </>
                )}
                {form.rateMode === 'SHIFT' && (
                  <Field label="Shift rate ($)">
                    <Input value={form.shift} onChange={(e) => set({ shift: e.target.value })} inputMode="decimal" />
                  </Field>
                )}
                {form.rateMode === 'DAILY' && (
                  <Field label="Daily rate ($)">
                    <Input value={form.daily} onChange={(e) => set({ daily: e.target.value })} inputMode="decimal" />
                  </Field>
                )}

                <Field label="Effective from">
                  <Input type="date" value={form.effectiveFrom} onChange={(e) => set({ effectiveFrom: e.target.value })} required />
                </Field>
                <Field label="Effective to (optional)">
                  <Input type="date" value={form.effectiveTo} onChange={(e) => set({ effectiveTo: e.target.value })} />
                </Field>
              </div>
              <ErrorText>{formError}</ErrorText>
              {added > 0 && !formError ? (
                <Badge tone="success">{added} added in this session</Badge>
              ) : null}
            </Stack>
          </form>
      </Drawer>

      <Section className="cq-section--table">
        <div className="cq-table-toolbar">
          <SearchInput value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search rate cards…" aria-label="Search rate cards" />
          <span className="cq-table-toolbar__meta cq-numeric">{filteredCards.length} of {cards.items.length}</span>
        </div>
      {!open && formError ? <div style={{ padding: '10px 14px' }}><ErrorText>{formError}</ErrorText></div> : null}
      {cards.loading ? (
        <div className="cq-empty"><p className="cq-empty__copy" role="status">Loading rate cards…</p></div>
      ) : cards.error ? (
        <div className="cq-empty"><ErrorText>{cards.error}</ErrorText></div>
      ) : filteredCards.length === 0 ? (
        <EmptyState title={cards.items.length === 0 ? 'No rate cards yet' : 'No rate cards found'}>{cards.items.length === 0 ? 'Add your first rate card to start pricing work.' : 'Try a different search term.'}</EmptyState>
      ) : (
        <Table label="Rate card register" compact>
          <thead>
            <tr>
              <SortableTh label="Kind" sortKey="kind" sort={sort} onSort={onSort} />
              <SortableTh label="Role" sortKey="role" sort={sort} onSort={onSort} />
              <SortableTh label="Label" sortKey="label" sort={sort} onSort={onSort} />
              <SortableTh label="Mode" sortKey="mode" sort={sort} onSort={onSort} />
              <SortableTh label="Rate" sortKey="rate" sort={sort} onSort={onSort} numeric />
              <SortableTh label="From" sortKey="from" sort={sort} onSort={onSort} numeric />
              <th scope="col">To</th>
              <th scope="col" className="cq-table__actions">Actions</th>
            </tr>
          </thead>
          <tbody>
            {filteredCards.map((c) => (
              <tr key={c.id}>
                <td>
                  <Badge tone={c.kind === 'BILL' ? 'accent' : 'neutral'}>{c.kind}</Badge>
                </td>
                <td className="cq-table__primary">{roleName(c.roleId)}</td>
                <td>{c.rateLabel}</td>
                <td>{c.rateMode}</td>
                <td className="cq-numeric">{formatCents(rateForMode(c))}</td>
                <td className="cq-muted cq-numeric">{c.effectiveFrom}</td>
                {/* "∞" would be dropped by the PDF encoder and reads as a symbol nobody
                    asked about; an open-ended card is simply still open. */}
                <td className="cq-muted cq-numeric">{c.effectiveTo ?? 'open'}</td>
                <td className="cq-table__actions">
                  <Button variant="danger" size="sm" onClick={() => void remove(c.id)}>
                    Delete
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      </Section>
    </Stack>
  );
}

/** The headline rate for a card's mode (used in the table). */
function rateForMode(c: RateCardView): number | null {
  if (c.rateMode === 'HOURLY') return c.hourlyRateCents;
  if (c.rateMode === 'SHIFT') return c.shiftRateCents;
  return c.dailyRateCents;
}
