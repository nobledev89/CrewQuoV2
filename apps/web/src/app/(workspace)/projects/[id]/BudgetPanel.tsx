'use client';

import { useState } from 'react';
import {
  BUDGET_CATEGORIES,
  BUDGET_FIELD,
  FEATURE_KEYS,
  type FeatureKey,
  type BudgetVarianceRow,
  type ProjectBudgetView,
  type SetProjectBudget,
} from '@crewquo/shared';
import {
  Badge,
  Button,
  EmptyState,
  ErrorText,
  Field,
  Input,
  Notice,
  Row,
  Section,
  Stack,
  Table,
} from '@crewquo/ui';
import { api, ApiError, refusedFeature } from '@/api/client';
import { useSessionCtx } from '@/auth/AuthProvider';
import { useAsyncData } from '@/lib/useAsyncData';
import { FeatureLocked } from '@/components/FeatureLock';
import { centsToInput, formatCents, formatDateTime, inputToCents } from '@/lib/format';

/**
 * Budget vs actual (§30.2) — step 11.6's screen.
 *
 * **This panel exists to render six empty cells honestly**, which is the whole of
 * packet finding 2. Six of §30.2's ten categories have no source of money anywhere
 * in the schema: asset movements and activities carry mass, distance, fuel and
 * energy and not one money column between them. The row a literal implementation
 * renders is
 *
 *     Vehicles      Budget £3,000    Actual £0    Variance −£3,000 / −100%
 *
 * — an absence with a percentage attached, on a screen a contractor reads
 * immediately before a client meeting. So: `actualCents === null` renders **not
 * tracked** with the reason the server supplied, and there is no `?? 0` anywhere
 * below. The `??` is the bug; the null is the answer.
 *
 * **Colour communicates direction only** (§40), on the number, and never as a
 * coloured card per row. `reading` is a direction rather than a severity — there is
 * deliberately no threshold, because a threshold would be a judgement about
 * somebody else's business made by a constant in this file.
 *
 * And a budget is **freely rewritable**: no supersession chain, no reason required.
 * It is a plan, and a plan that needs ceremony to revise is a plan people keep in a
 * spreadsheet instead — which is the state this feature exists to replace. Its
 * history is `record_revisions`.
 */

function VarianceCell({ row, currency }: { row: BudgetVarianceRow; currency: string }) {
  if (row.actualCents === null) {
    return <span className="cq-muted">—</span>;
  }
  if (row.varianceCents === null) return <span className="cq-muted">—</span>;
  const sign = row.varianceCents > 0 ? '+' : '';
  return (
    <span
      className={
        row.reading === 'FAVOURABLE'
          ? 'cq-figure cq-figure--good'
          : row.reading === 'ADVERSE'
            ? 'cq-figure cq-figure--bad'
            : undefined
      }
    >
      {sign}
      {formatCents(row.varianceCents, currency)}
      {/*
        * The percentage is withheld when the budget is zero, because "what
        * percentage over a budget of nothing is £840?" has no answer and both
        * available wrong answers — Infinity and a confident-looking 0 — get
        * rendered.
        */}
      {row.variancePct === null ? '' : ` / ${sign}${row.variancePct.toFixed(1)}%`}
    </span>
  );
}

export function BudgetPanel({
  projectId,
  currency,
  canManage,
}: {
  projectId: string;
  currency: string;
  canManage: boolean;
}) {
  const ctx = useSessionCtx();
  const budget = useAsyncData<{ budget: ProjectBudgetView; categories: unknown[] }>(
    ctx ? () => api.getProjectBudget(ctx.accessToken, ctx.companyId, projectId) : null,
    [ctx?.companyId, projectId]
  );

  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState('');

  const locked = refusedFeature(budget.error);
  // `refusedFeature` returns the raw string the API put in `details.feature`,
  // which is untrusted shape rather than a `FeatureKey` — narrowed against the
  // catalog so a response naming something this build has never heard of renders
  // the generic error rather than an empty explanation.
  if (locked !== null && (FEATURE_KEYS as readonly string[]).includes(locked)) {
    return <FeatureLocked feature={locked as FeatureKey} />;
  }

  const view = budget.data?.budget;

  const startEditing = () => {
    if (!view) return;
    const next: Record<string, string> = {};
    for (const row of view.rows) next[row.key] = centsToInput(row.budgetCents);
    setDraft(next);
    setNotes(view.notes ?? '');
    setError(null);
    setEditing(true);
  };

  const save = async () => {
    if (!ctx) return;
    setBusy(true);
    setError(null);
    try {
      const body = { notes: notes.trim() === '' ? null : notes.trim() } as Record<string, unknown>;
      for (const key of BUDGET_CATEGORIES) {
        body[BUDGET_FIELD[key]] = inputToCents(draft[key] ?? '') ?? 0;
      }
      await api.setProjectBudget(
        ctx.accessToken,
        ctx.companyId,
        projectId,
        body as unknown as SetProjectBudget
      );
      setEditing(false);
      budget.reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save that budget');
    } finally {
      setBusy(false);
    }
  };

  if (budget.loading) return <p className="cq-muted">Loading budget…</p>;
  if (!view) {
    return (
      <Section title="Budget vs actual">
        <ErrorText>{budget.error}</ErrorText>
      </Section>
    );
  }

  const untracked = view.rows.filter((r) => r.coverage === 'NO_SOURCE');
  const untrackedBudgeted = untracked.filter((r) => r.budgetCents > 0);

  return (
    <Stack>
      <Section
        title="Budget vs actual"
        description="What you planned, against what the project has actually cost and earned. Actuals are computed from approved work — they are never typed in."
        actions={
          canManage && !editing ? (
            <Button onClick={startEditing}>{view.budgetSet ? 'Revise budget' : 'Set a budget'}</Button>
          ) : null
        }
      >
        <ErrorText>{error}</ErrorText>

        {!view.budgetSet && !editing ? (
          <EmptyState title="No budget set">
            Set one and this table fills in the variance against what the project has
            already cost. You can revise it whenever the job changes — a budget is a
            plan, and its history is kept for you.
          </EmptyState>
        ) : null}

        {editing ? (
          <Stack>
            <Notice>
              Enter what you planned. Every figure is in {currency}, and the actuals
              below are computed — you never type one.
            </Notice>
            {view.rows.map((row) => (
              <Field
                key={row.key}
                label={row.label}
                hint={row.coverage === 'NO_SOURCE' ? row.sources : undefined}
              >
                <Input
                  inputMode="decimal"
                  value={draft[row.key] ?? ''}
                  onChange={(e) => setDraft((prev) => ({ ...prev, [row.key]: e.target.value }))}
                />
              </Field>
            ))}
            <Field label="Notes" wide>
              <Input value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={2000} />
            </Field>
            <Row>
              <Button disabled={busy} onClick={() => void save()}>
                {busy ? 'Saving…' : 'Save budget'}
              </Button>
              <Button variant="secondary" onClick={() => setEditing(false)}>
                Cancel
              </Button>
            </Row>
          </Stack>
        ) : (
          <>
            <Table label="Budget versus actual">
              <thead>
                <tr>
                  <th scope="col">Category</th>
                  <th scope="col" className="cq-num">
                    Budget
                  </th>
                  <th scope="col" className="cq-num">
                    Actual
                  </th>
                  <th scope="col" className="cq-num">
                    Variance
                  </th>
                </tr>
              </thead>
              <tbody>
                {view.rows.map((row) => (
                  <tr key={row.key}>
                    <td>
                      {row.label}
                      {/*
                        * The reason, on the row rather than in a footnote. "Not
                        * tracked" on its own sends somebody to support to ask
                        * whether it is a bug.
                        */}
                      {row.coverage === 'NO_SOURCE' ? (
                        <div className="cq-muted">{row.sources}</div>
                      ) : null}
                    </td>
                    <td className="cq-num">{formatCents(row.budgetCents, currency)}</td>
                    <td className="cq-num">
                      {row.actualCents === null ? (
                        <Badge tone="neutral">Not tracked</Badge>
                      ) : (
                        formatCents(row.actualCents, currency)
                      )}
                    </td>
                    <td className="cq-num">
                      <VarianceCell row={row} currency={currency} />
                    </td>
                  </tr>
                ))}
                <tr>
                  <th scope="row">Profit</th>
                  <td className="cq-num">{formatCents(view.plannedProfitCents, currency)}</td>
                  <td className="cq-num">
                    {/*
                      * Null when revenue is, and it deliberately does not net "the
                      * costs we do know about" against a revenue we do not: a profit
                      * assembled from four of ten categories is not a profit.
                      */}
                    {view.actualProfitCents === null ? (
                      <Badge tone="neutral">Not yet</Badge>
                    ) : (
                      formatCents(view.actualProfitCents, currency)
                    )}
                  </td>
                  <td className="cq-num">—</td>
                </tr>
              </tbody>
            </Table>

            {untrackedBudgeted.length > 0 ? (
              <Notice>
                <strong>
                  {untrackedBudgeted.length} budgeted{' '}
                  {untrackedBudgeted.length === 1 ? 'category has' : 'categories have'} no actual to
                  compare against
                  {view.untrackedShare === null
                    ? ''
                    : ` — ${view.untrackedShare.toFixed(0)}% of your budgeted cost`}
                  .
                </strong>{' '}
                CrewQuo records what material and fuel a project used, not what they
                cost. Record that spend as expenses and it shows up in Expenses, and in
                the breakdown below.
              </Notice>
            ) : null}

            {view.expenseBreakdown.length > 0 ? (
              <Section
                title="Where the expense money went"
                description="Approved expenses grouped by the category you typed. Shown because six budget lines above cannot be matched to it automatically."
              >
                <Table label="Approved expenses by category" compact>
                  <thead>
                    <tr>
                      <th scope="col">Category</th>
                      <th scope="col" className="cq-num">
                        Count
                      </th>
                      <th scope="col" className="cq-num">
                        Total
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {view.expenseBreakdown.map((entry) => (
                      <tr key={entry.category ?? 'uncategorised'}>
                        <td>{entry.category ?? 'Uncategorised'}</td>
                        <td className="cq-num">{entry.count}</td>
                        <td className="cq-num">{formatCents(entry.actualCents, currency)}</td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              </Section>
            ) : null}

            {view.updatedAt ? (
              <p className="cq-muted">
                Last revised {formatDateTime(view.updatedAt)}
                {view.updatedByName ? ` by ${view.updatedByName}` : ''}
                {view.notes ? ` — ${view.notes}` : ''}
              </p>
            ) : null}
          </>
        )}
      </Section>
    </Stack>
  );
}
