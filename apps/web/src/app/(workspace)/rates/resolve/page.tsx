'use client';

import { useState } from 'react';
import {
  RATE_KINDS,
  SHIFT_TYPES,
  type ResolveRateResponse,
  type RoleCatalogView,
} from '@crewquo/shared';
import { Badge, Button, Card, ErrorText, Field, Input, PageHeader, Section, Select, Stack } from '@crewquo/ui';
import { Shell } from '@/components/Shell';
import { api, ApiError } from '@/api/client';
import { useSessionCtx } from '@/auth/AuthProvider';
import { useAsyncList } from '@/lib/useAsyncList';
import { formatCents } from '@/lib/format';

export default function ResolvePage() {
  return (
    <Shell>
      <Resolve />
    </Shell>
  );
}

function Resolve() {
  const ctx = useSessionCtx();
  const roles = useAsyncList<RoleCatalogView>(
    ctx ? () => api.listRoles(ctx.accessToken, ctx.companyId).then((r) => r.data) : null,
    [ctx?.companyId]
  );

  const [roleId, setRoleId] = useState('');
  const [shiftType, setShiftType] = useState<string>('WEEKDAY_DAY');
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [kind, setKind] = useState<string>('PAY');
  const [result, setResult] = useState<ResolveRateResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function resolve(e: React.FormEvent) {
    e.preventDefault();
    if (!ctx) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const res = await api.resolveRate(ctx.accessToken, ctx.companyId, {
        roleId,
        shiftType,
        date,
        kind,
      });
      setResult(res);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to resolve');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Stack>
      <PageHeader eyebrow="Rate management" title="Rate resolver" description="Verify the exact pay or bill rate the costing engine will select for a dated shift." />

      <Section title="Resolution criteria" description="Choose the operational context used to match an effective rate card.">
        <form onSubmit={resolve}>
          <Stack>
            <div className="cq-form-grid">
              <Field label="Role">
                <Select value={roleId} onChange={(e) => setRoleId(e.target.value)} required>
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
              <Field label="Shift type">
                <Select value={shiftType} onChange={(e) => setShiftType(e.target.value)}>
                  {SHIFT_TYPES.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Date">
                <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
              </Field>
              <Field label="Kind">
                <Select value={kind} onChange={(e) => setKind(e.target.value)}>
                  {RATE_KINDS.map((k) => (
                    <option key={k} value={k}>
                      {k}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            <Button type="submit" disabled={busy || roleId === ''}>
              {busy ? 'Resolving…' : 'Resolve'}
            </Button>
          </Stack>
        </form>
      </Section>

      {error ? <ErrorText>{error}</ErrorText> : null}

      {result ? (
        <Card>
          <Stack>
            <div className="cq-row" style={{ gap: 10 }}>
              <h2 className="cq-h2">Resolved</h2>
              <Badge tone="success">Matched</Badge>
              <Badge tone="accent">{result.label}</Badge>
              <Badge>{result.rateMode}</Badge>
            </div>
            <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))' }}>
              <Stat label="Base rate" value={formatCents(result.baseCents)} />
              <Stat label="OT rate" value={formatCents(result.otCents)} />
              <Stat label="Rate card" value={result.rateCardId.slice(0, 8)} />
            </div>
          </Stack>
        </Card>
      ) : null}
    </Stack>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="cq-label">{label}</div>
      <div className="cq-numeric" style={{ fontSize: 20, fontWeight: 650 }}>{value}</div>
    </div>
  );
}
