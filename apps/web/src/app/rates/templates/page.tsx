'use client';

import { useState } from 'react';
import type { RateCardTemplateCreate, RateCardTemplateView } from '@crewquo/shared';
import { Button, Card, ErrorText, Field, Input, Row, Stack, Table } from '@crewquo/ui';
import { Shell } from '@/components/Shell';
import { api, ApiError } from '@/api/client';
import { useSessionCtx } from '@/auth/AuthProvider';
import { useAsyncList } from '@/lib/useAsyncList';

export default function TemplatesPage() {
  return (
    <Shell>
      <Templates />
    </Shell>
  );
}

function Templates() {
  const ctx = useSessionCtx();
  const { items, loading, error, reload } = useAsyncList<RateCardTemplateView>(
    ctx ? () => api.listTemplates(ctx.accessToken, ctx.companyId).then((r) => r.data) : null,
    [ctx?.companyId]
  );

  const [name, setName] = useState('');
  const [dates, setDates] = useState('');
  const [multiplier, setMultiplier] = useState('2');
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (!ctx) return;
    setBusy(true);
    setFormError(null);
    const holidayDates = dates
      .split(/[\s,]+/)
      .map((d) => d.trim())
      .filter(Boolean);
    const body: RateCardTemplateCreate = {
      name,
      timeframeDefinitions: holidayDates.length
        ? [{ type: 'holiday', holidayDates, holidayMultiplier: Number(multiplier) || 1 }]
        : [],
    };
    try {
      await api.createTemplate(ctx.accessToken, ctx.companyId, body);
      setName('');
      setDates('');
      setMultiplier('2');
      reload();
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : 'Failed to create template');
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    if (!ctx) return;
    try {
      await api.deleteTemplate(ctx.accessToken, ctx.companyId, id);
      reload();
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : 'Failed to delete template');
    }
  }

  return (
    <Stack style={{ paddingTop: 24 }}>
      <h1 className="cq-h1">Rate card templates</h1>
      <p className="cq-muted" style={{ marginTop: -8 }}>
        Holiday timeframes multiply resolved rates on the listed dates.
      </p>

      <Card>
        <form onSubmit={create}>
          <Stack>
            <div style={{ display: 'grid', gap: 14, gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))' }}>
              <Field label="Template name">
                <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. 2026 PH Holidays" required />
              </Field>
              <Field label="Holiday multiplier">
                <Input value={multiplier} onChange={(e) => setMultiplier(e.target.value)} inputMode="decimal" />
              </Field>
            </div>
            <Field label="Holiday dates (comma or space separated, YYYY-MM-DD)">
              <Input value={dates} onChange={(e) => setDates(e.target.value)} placeholder="2026-12-25, 2026-01-01" />
            </Field>
            <Row>
              <Button type="submit" disabled={busy || name.trim() === ''}>
                {busy ? 'Saving…' : 'Add template'}
              </Button>
              <ErrorText>{formError}</ErrorText>
            </Row>
          </Stack>
        </form>
      </Card>

      {loading ? (
        <p className="cq-muted">Loading…</p>
      ) : error ? (
        <ErrorText>{error}</ErrorText>
      ) : items.length === 0 ? (
        <div className="cq-notice">No templates yet.</div>
      ) : (
        <Table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Holiday dates</th>
              <th>Multiplier</th>
              <th aria-label="actions" />
            </tr>
          </thead>
          <tbody>
            {items.map((t) => {
              const holiday = t.timeframeDefinitions.find((d) => d.type === 'holiday');
              return (
                <tr key={t.id}>
                  <td>{t.name}</td>
                  <td className="cq-muted">
                    {holiday ? holiday.holidayDates.join(', ') || '—' : '—'}
                  </td>
                  <td>{holiday ? `×${holiday.holidayMultiplier}` : '—'}</td>
                  <td style={{ textAlign: 'right' }}>
                    <Button variant="danger" size="sm" onClick={() => void remove(t.id)}>
                      Delete
                    </Button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      )}
    </Stack>
  );
}
