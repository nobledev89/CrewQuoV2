'use client';

import { useMemo, useState } from 'react';
import type { RateCardTemplateCreate, RateCardTemplateView } from '@crewquo/shared';
import { Button, EmptyState, ErrorText, Field, Input, PageHeader, Row, SearchInput, Section, Stack, Table } from '@crewquo/ui';
import { Shell } from '@/components/Shell';
import { api, ApiError } from '@/api/client';
import { useSessionCtx } from '@/auth/AuthProvider';
import { useAsyncList } from '@/lib/useAsyncList';
import { useUrlQuery } from '@/lib/useUrlQuery';

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
  const [query, setQuery] = useUrlQuery();
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const filteredItems = useMemo(() => items.filter((template) => template.name.toLowerCase().includes(query.trim().toLowerCase())), [items, query]);

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
    if (!ctx || !window.confirm('Delete this template? This action cannot be undone.')) return;
    try {
      await api.deleteTemplate(ctx.accessToken, ctx.companyId, id);
      reload();
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : 'Failed to delete template');
    }
  }

  return (
    <Stack>
      <PageHeader eyebrow="Rate management" title="Templates" description="Define holiday calendars and multipliers used when the rate engine resolves a shift." />

      <Section title="Add template" description="Create a named holiday schedule with one consistent rate multiplier.">
        <form onSubmit={create}>
          <Stack>
            <div className="cq-form-grid">
              <Field label="Template name">
                <Input name="template-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. 2026 PH holidays…" required />
              </Field>
              <Field label="Holiday multiplier">
                <Input name="holiday-multiplier" value={multiplier} onChange={(e) => setMultiplier(e.target.value)} inputMode="decimal" />
              </Field>
            </div>
            <Field label="Holiday dates (comma or space separated, YYYY-MM-DD)">
              <Input name="holiday-dates" value={dates} onChange={(e) => setDates(e.target.value)} placeholder="2026-12-25, 2026-01-01…" />
            </Field>
            <Row>
              <Button type="submit" disabled={busy || name.trim() === ''}>
                {busy ? 'Saving…' : 'Add template'}
              </Button>
              <ErrorText>{formError}</ErrorText>
            </Row>
          </Stack>
        </form>
      </Section>

      <Section title="Template register" description="Holiday adjustments available to the rate engine" className="cq-section--table">
        <div className="cq-table-toolbar">
          <SearchInput value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search templates…" aria-label="Search templates" />
          <span className="cq-table-toolbar__meta cq-numeric">{filteredItems.length} of {items.length}</span>
        </div>
      {loading ? (
        <p className="cq-muted">Loading…</p>
      ) : error ? (
        <ErrorText>{error}</ErrorText>
      ) : filteredItems.length === 0 ? (
        <EmptyState title={items.length === 0 ? 'No templates yet' : 'No templates found'}>{items.length === 0 ? 'Add a template when holiday pricing applies.' : 'Try a different search term.'}</EmptyState>
      ) : (
        <Table label="Rate card template register">
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Holiday dates</th>
              <th scope="col">Multiplier</th>
              <th scope="col" className="cq-table__actions">Actions</th>
            </tr>
          </thead>
          <tbody>
            {filteredItems.map((t) => {
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
      </Section>
    </Stack>
  );
}
