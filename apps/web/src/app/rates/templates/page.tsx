'use client';

import { useMemo, useState } from 'react';
import {
  SHIFT_TYPES,
  RATE_LABELS,
  type LabelRule,
  type RateCardTemplateCreate,
  type RateCardTemplateView,
  type RateLabel,
  type ShiftType,
  type TimeframeDefinitionInput,
} from '@crewquo/shared';
import { Badge, Button, EmptyState, ErrorText, Field, Input, Notice, PageHeader, Row, SearchInput, Section, Select, Stack, Table } from '@crewquo/ui';
import { Shell } from '@/components/Shell';
import { api, ApiError } from '@/api/client';
import { useSessionCtx } from '@/auth/AuthProvider';
import { useAsyncList } from '@/lib/useAsyncList';
import { useUrlQuery } from '@/lib/useUrlQuery';

/**
 * Rate card templates — holiday calendars and **label rules**.
 *
 * Label rules are the company's answer to "which days send a shift to a
 * different rate label". Nothing about that is hardcoded in the engine any more
 * (owner decision, 2026-08-17), so this screen is the only place the rule exists
 * — which is why rules are editable here and not just creatable. Exactly one
 * template is the *default*: the one the engine reads when it resolves a rate.
 */

const DAYS = [
  { value: 1, label: 'Mon' },
  { value: 2, label: 'Tue' },
  { value: 3, label: 'Wed' },
  { value: 4, label: 'Thu' },
  { value: 5, label: 'Fri' },
  { value: 6, label: 'Sat' },
  { value: 0, label: 'Sun' },
];

function dayNames(days: number[]): string {
  if (days.length === 0) return 'Every day';
  return DAYS.filter((d) => days.includes(d.value))
    .map((d) => d.label)
    .join(', ');
}

function isLabelRule(d: TimeframeDefinitionInput): d is LabelRule {
  return d.type === 'label_rule';
}

/** A rule draft the user is composing, before it joins a template. */
interface RuleDraft {
  shiftType: ShiftType;
  label: RateLabel;
  daysOfWeek: number[];
}

const EMPTY_DRAFT: RuleDraft = { shiftType: 'NIGHT', label: 'FRI_SAT_NIGHT', daysOfWeek: [] };

/** Shift type + weekday picker + target label. Used by both create and edit. */
function RuleFields({
  draft,
  onChange,
  disabled,
  idPrefix,
}: {
  draft: RuleDraft;
  onChange: (next: RuleDraft) => void;
  disabled?: boolean;
  idPrefix: string;
}) {
  return (
    <Stack>
      <div className="cq-form-grid">
        <Field label="When the shift type is">
          <Select
            name={`${idPrefix}-shift-type`}
            value={draft.shiftType}
            disabled={disabled}
            onChange={(e) => onChange({ ...draft, shiftType: e.target.value as ShiftType })}
          >
            {SHIFT_TYPES.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </Select>
        </Field>
        <Field label="Use the rate label">
          <Select
            name={`${idPrefix}-label`}
            value={draft.label}
            disabled={disabled}
            onChange={(e) => onChange({ ...draft, label: e.target.value as RateLabel })}
          >
            {RATE_LABELS.map((l) => (
              <option key={l} value={l}>{l}</option>
            ))}
          </Select>
        </Field>
      </div>
      <Field label="On these days">
        <Row>
          {DAYS.map((d) => (
            <label key={d.value} className="cq-row" style={{ gap: '0.35rem', alignItems: 'center' }}>
              <input
                type="checkbox"
                name={`${idPrefix}-day-${d.value}`}
                checked={draft.daysOfWeek.includes(d.value)}
                disabled={disabled}
                onChange={() =>
                  onChange({
                    ...draft,
                    daysOfWeek: draft.daysOfWeek.includes(d.value)
                      ? draft.daysOfWeek.filter((x) => x !== d.value)
                      : [...draft.daysOfWeek, d.value],
                  })
                }
              />
              <span>{d.label}</span>
            </label>
          ))}
        </Row>
      </Field>
    </Stack>
  );
}

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
  const [drafts, setDrafts] = useState<RuleDraft[]>([]);
  const [makeDefault, setMakeDefault] = useState(false);
  const [query, setQuery] = useUrlQuery();
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // The template whose rules are being edited, plus the rule being added to it.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<RuleDraft>(EMPTY_DRAFT);

  const filteredItems = useMemo(
    () => items.filter((template) => template.name.toLowerCase().includes(query.trim().toLowerCase())),
    [items, query]
  );
  const hasDefault = items.some((t) => t.isDefault);
  const editing = items.find((t) => t.id === editingId) ?? null;

  function draftsToDefinitions(list: RuleDraft[]): TimeframeDefinitionInput[] {
    return list.map((d) => ({
      type: 'label_rule' as const,
      shiftType: d.shiftType,
      daysOfWeek: d.daysOfWeek,
      label: d.label,
    }));
  }

  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (!ctx) return;
    setBusy(true);
    setFormError(null);

    const holidayDates = dates
      .split(/[\s,]+/)
      .map((d) => d.trim())
      .filter(Boolean);
    const definitions: TimeframeDefinitionInput[] = [];
    if (holidayDates.length) {
      definitions.push({ type: 'holiday', holidayDates, holidayMultiplier: Number(multiplier) || 1 });
    }
    definitions.push(...draftsToDefinitions(drafts));

    const body: RateCardTemplateCreate = {
      name,
      timeframeDefinitions: definitions,
      // The first template a company creates has to be the default, or the engine
      // reads nothing and every label falls back to the baseline mapping.
      isDefault: makeDefault || !hasDefault,
    };
    try {
      await api.createTemplate(ctx.accessToken, ctx.companyId, body);
      setName('');
      setDates('');
      setMultiplier('2');
      setDrafts([]);
      setMakeDefault(false);
      reload();
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : 'Failed to create template');
    } finally {
      setBusy(false);
    }
  }

  /** Replace a template's whole definition list — the API patch is not additive. */
  async function saveDefinitions(
    template: RateCardTemplateView,
    definitions: TimeframeDefinitionInput[]
  ) {
    if (!ctx) return;
    setBusy(true);
    setFormError(null);
    try {
      await api.updateTemplate(ctx.accessToken, ctx.companyId, template.id, {
        timeframeDefinitions: definitions,
      });
      reload();
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : 'Failed to save the label rules');
    } finally {
      setBusy(false);
    }
  }

  async function addRule(template: RateCardTemplateView) {
    await saveDefinitions(template, [
      ...template.timeframeDefinitions,
      ...draftsToDefinitions([editDraft]),
    ]);
    setEditDraft(EMPTY_DRAFT);
  }

  async function removeRule(template: RateCardTemplateView, index: number) {
    const rules = template.timeframeDefinitions.filter(isLabelRule);
    const target = rules[index];
    if (!target) return;
    let seen = -1;
    await saveDefinitions(
      template,
      template.timeframeDefinitions.filter((d) => {
        if (!isLabelRule(d)) return true;
        seen += 1;
        return seen !== index;
      })
    );
  }

  async function makeTemplateDefault(id: string) {
    if (!ctx) return;
    setFormError(null);
    try {
      await api.updateTemplate(ctx.accessToken, ctx.companyId, id, { isDefault: true });
      reload();
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : 'Failed to set the default template');
    }
  }

  async function remove(id: string) {
    if (!ctx || !window.confirm('Delete this template? This action cannot be undone.')) return;
    setFormError(null);
    try {
      await api.deleteTemplate(ctx.accessToken, ctx.companyId, id);
      if (editingId === id) setEditingId(null);
      reload();
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : 'Failed to delete template');
    }
  }

  return (
    <Stack>
      <PageHeader
        eyebrow="Rate management"
        title="Templates"
        description="Holiday calendars and the label rules the rate engine reads when it resolves a shift."
      />

      {!loading && !error && items.length > 0 && !hasDefault ? (
        <Notice>
          No template is marked as default, so the engine resolves every shift on the baseline
          mapping and your label rules are being ignored. Pick one below.
        </Notice>
      ) : null}

      <Section
        title="Add template"
        description="A holiday schedule, any number of label rules, or both. The default template is the one the rate engine reads."
      >
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

            <Section
              title="Label rules"
              description="Send a shift type to a different rate label on the days you choose — a night shift priced as a weekend night, for example. Add as many as you need; two rules may not claim the same shift type on the same day."
            >
              <Stack>
                {drafts.length === 0 ? (
                  <p className="cq-muted">
                    No label rules. Without one, every shift resolves on the baseline mapping.
                  </p>
                ) : (
                  drafts.map((draft, i) => (
                    <div className="cq-card" key={i}>
                      <Stack>
                        <RuleFields
                          idPrefix={`new-rule-${i}`}
                          draft={draft}
                          onChange={(next) =>
                            setDrafts(drafts.map((d, j) => (j === i ? next : d)))
                          }
                        />
                        <Row>
                          <span className="cq-muted">
                            {draft.shiftType} on {dayNames(draft.daysOfWeek)} → {draft.label}
                          </span>
                          <Button variant="secondary" size="sm" onClick={() => setDrafts(drafts.filter((_, j) => j !== i))}>
                            Remove rule
                          </Button>
                        </Row>
                      </Stack>
                    </div>
                  ))
                )}
                <Row>
                  <Button variant="secondary" size="sm" onClick={() => setDrafts([...drafts, EMPTY_DRAFT])}>
                    Add a label rule
                  </Button>
                </Row>
              </Stack>
            </Section>

            <Row>
              <label className="cq-row" style={{ gap: '0.4rem', alignItems: 'center' }}>
                <input
                  type="checkbox"
                  name="make-default"
                  checked={makeDefault || !hasDefault}
                  disabled={!hasDefault}
                  onChange={(e) => setMakeDefault(e.target.checked)}
                />
                <span>
                  {hasDefault
                    ? 'Make this the default template'
                    : 'This will be the default template (your first one)'}
                </span>
              </label>
            </Row>

            <Row>
              <Button type="submit" disabled={busy || name.trim() === ''}>
                {busy ? 'Saving…' : 'Add template'}
              </Button>
              <ErrorText>{formError}</ErrorText>
            </Row>
          </Stack>
        </form>
      </Section>

      {editing ? (
        <Section
          title={`Label rules — ${editing.name}`}
          description="Rules are matched in order, top first, so the first rule covering a shift and day decides the label."
          actions={
            <Button variant="secondary" size="sm" onClick={() => setEditingId(null)}>
              Done
            </Button>
          }
        >
          <Stack>
            {editing.timeframeDefinitions.filter(isLabelRule).length === 0 ? (
              <EmptyState title="No label rules on this template">
                Every shift resolves on the baseline mapping until you add one.
              </EmptyState>
            ) : (
              <Table label={`Label rules on ${editing.name}`}>
                <thead>
                  <tr>
                    <th scope="col">#</th>
                    <th scope="col">Shift type</th>
                    <th scope="col">Days</th>
                    <th scope="col">Resolves to</th>
                    <th scope="col" className="cq-table__actions">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {editing.timeframeDefinitions.filter(isLabelRule).map((rule, i) => (
                    <tr key={`${rule.shiftType}-${rule.label}-${i}`}>
                      <td className="cq-numeric">{i + 1}</td>
                      <td>{rule.shiftType}</td>
                      <td className="cq-muted">{dayNames(rule.daysOfWeek)}</td>
                      <td>{rule.label}</td>
                      <td style={{ textAlign: 'right' }}>
                        <Button variant="danger" size="sm" disabled={busy} onClick={() => void removeRule(editing, i)}>
                          Remove
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}

            <Section title="Add a rule to this template">
              <Stack>
                <RuleFields idPrefix="edit-rule" draft={editDraft} onChange={setEditDraft} disabled={busy} />
                <Row>
                  <Button disabled={busy} onClick={() => void addRule(editing)}>
                    {busy ? 'Saving…' : 'Add rule'}
                  </Button>
                  <span className="cq-muted">
                    {editDraft.shiftType} on {dayNames(editDraft.daysOfWeek)} → {editDraft.label}
                  </span>
                </Row>
              </Stack>
            </Section>
          </Stack>
        </Section>
      ) : null}

      <Section title="Template register" description="Holiday adjustments and label rules available to the rate engine" className="cq-section--table">
        <div className="cq-table-toolbar">
          <SearchInput value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search templates…" aria-label="Search templates" />
          <span className="cq-table-toolbar__meta cq-numeric">{filteredItems.length} of {items.length}</span>
        </div>
      {loading ? (
        <p className="cq-muted">Loading…</p>
      ) : error ? (
        <ErrorText>{error}</ErrorText>
      ) : filteredItems.length === 0 ? (
        <EmptyState title={items.length === 0 ? 'No templates yet' : 'No templates found'}>{items.length === 0 ? 'Add a template when holiday pricing or a label rule applies.' : 'Try a different search term.'}</EmptyState>
      ) : (
        <Table label="Rate card template register">
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Holiday dates</th>
              <th scope="col">Multiplier</th>
              <th scope="col">Label rules</th>
              <th scope="col" className="cq-table__actions">Actions</th>
            </tr>
          </thead>
          <tbody>
            {filteredItems.map((t) => {
              const holiday = t.timeframeDefinitions.find((d) => d.type === 'holiday');
              const rules = t.timeframeDefinitions.filter(isLabelRule);
              return (
                <tr key={t.id}>
                  <td>
                    <Row>
                      <span>{t.name}</span>
                      {t.isDefault ? <Badge tone="accent">Default</Badge> : null}
                    </Row>
                  </td>
                  <td className="cq-muted">
                    {holiday ? holiday.holidayDates.join(', ') || '—' : '—'}
                  </td>
                  <td>{holiday ? `×${holiday.holidayMultiplier}` : '—'}</td>
                  <td className="cq-muted">
                    {rules.length === 0
                      ? '—'
                      : rules.map((r, i) => (
                          <div key={`${r.shiftType}-${r.label}-${i}`}>
                            {r.shiftType} on {dayNames(r.daysOfWeek)} → {r.label}
                          </div>
                        ))}
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    <Row>
                      <Button variant="secondary" size="sm" onClick={() => { setEditingId(t.id); setEditDraft(EMPTY_DRAFT); }}>
                        Edit rules
                      </Button>
                      {t.isDefault ? null : (
                        <Button variant="secondary" size="sm" onClick={() => void makeTemplateDefault(t.id)}>
                          Make default
                        </Button>
                      )}
                      <Button variant="danger" size="sm" onClick={() => void remove(t.id)}>
                        Delete
                      </Button>
                    </Row>
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
