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
import { Badge, Button, Card, ErrorText, Field, Input, Row, Select, Stack, Table } from '@crewquo/ui';
import { Shell } from '@/components/Shell';
import { api, ApiError } from '@/api/client';
import { useSessionCtx } from '@/auth/AuthProvider';
import { useAsyncList } from '@/lib/useAsyncList';
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
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const set = (patch: Partial<FormState>) => setForm((f) => ({ ...f, ...patch }));

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
      setForm({ ...EMPTY_FORM, roleId: form.roleId, kind: form.kind });
      cards.reload();
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : 'Failed to create rate card');
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    if (!ctx) return;
    try {
      await api.deleteRateCard(ctx.accessToken, ctx.companyId, id);
      cards.reload();
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : 'Failed to delete rate card');
    }
  }

  const noRoles = !roles.loading && roles.items.length === 0;

  return (
    <Stack style={{ paddingTop: 24 }}>
      <h1 className="cq-h1">Rate cards</h1>

      {noRoles ? (
        <div className="cq-notice">
          Add a role first — rate cards attach to a role.
        </div>
      ) : (
        <Card>
          <form onSubmit={create}>
            <Stack>
              <div style={{ display: 'grid', gap: 14, gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))' }}>
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
              <Row>
                <Button type="submit" disabled={busy || form.roleId === ''}>
                  {busy ? 'Saving…' : 'Add rate card'}
                </Button>
                <ErrorText>{formError}</ErrorText>
              </Row>
            </Stack>
          </form>
        </Card>
      )}

      {cards.loading ? (
        <p className="cq-muted">Loading…</p>
      ) : cards.error ? (
        <ErrorText>{cards.error}</ErrorText>
      ) : cards.items.length === 0 ? (
        <div className="cq-notice">No rate cards yet.</div>
      ) : (
        <Table>
          <thead>
            <tr>
              <th>Kind</th>
              <th>Role</th>
              <th>Label</th>
              <th>Mode</th>
              <th>Rate</th>
              <th>Effective</th>
              <th aria-label="actions" />
            </tr>
          </thead>
          <tbody>
            {cards.items.map((c) => (
              <tr key={c.id}>
                <td>
                  <Badge accent={c.kind === 'BILL'}>{c.kind}</Badge>
                </td>
                <td>{roleName(c.roleId)}</td>
                <td>{c.rateLabel}</td>
                <td>{c.rateMode}</td>
                <td>{formatCents(rateForMode(c))}</td>
                <td className="cq-muted">
                  {c.effectiveFrom} → {c.effectiveTo ?? '∞'}
                </td>
                <td style={{ textAlign: 'right' }}>
                  <Button variant="danger" size="sm" onClick={() => void remove(c.id)}>
                    Delete
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </Stack>
  );
}

/** The headline rate for a card's mode (used in the table). */
function rateForMode(c: RateCardView): number | null {
  if (c.rateMode === 'HOURLY') return c.hourlyRateCents;
  if (c.rateMode === 'SHIFT') return c.shiftRateCents;
  return c.dailyRateCents;
}
