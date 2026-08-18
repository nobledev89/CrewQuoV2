'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import type {
  EngagementView,
  ExpenseView,
  ProjectView,
  SubmissionView,
  TimeLogView,
} from '@crewquo/shared';
import {
  Badge,
  Button,
  EmptyState,
  ErrorText,
  Field,
  Input,
  Notice,
  PageHeader,
  Row,
  Section,
  Select,
  Stack,
  Table,
} from '@crewquo/ui';
import { Shell } from '@/components/Shell';
import { api, ApiError } from '@/api/client';
import { useAuth, useSessionCtx } from '@/auth/AuthProvider';
import { useAsyncList } from '@/lib/useAsyncList';
import { formatCents, formatDate, titleCase, totalHours } from '@/lib/format';

/**
 * Bulk review — the screen the plan calls the clearest case for web over mobile
 * (§9.1): approving 200 time logs across 12 subcontractors is a table with filters
 * and multi-select, not a swipe deck.
 *
 * Three things worth knowing about how this is built:
 *
 * 1. **Only the client side of an engagement may approve** (§4). The worklist
 *    endpoints return rows for *both* endpoints of every edge the company sits on, so
 *    this screen intersects them with `/v1/engagements` and shows only the rows where
 *    the active company is the client. Otherwise a subcontractor would find their own
 *    submissions in an "Approvals" inbox and collect 403s.
 *
 * 2. **There is no bulk endpoint.** Approving a selection is N requests, run a few at
 *    a time. That makes partial failure a real outcome, so the result is reported per
 *    item: successes disappear from the list, failures stay selected with their
 *    reason. Reporting "approved" for a batch where three calls 409'd would be a lie,
 *    and the operator would find out from the totals a week later.
 *
 * 3. **Rejection takes a reason.** It is optional on the API, but the reason is the
 *    only thing that tells a crew what to fix, so the UI asks for it once for the
 *    batch and sends it with each call.
 */
export default function ReviewPage() {
  return (
    <Shell>
      <Review />
    </Shell>
  );
}

type Tab = 'time' | 'expenses' | 'submissions';

/** Outcome of one bulk run, kept so partial failure can be shown honestly. */
interface BulkResult {
  action: 'approve' | 'reject';
  succeeded: number;
  failures: { id: string; message: string }[];
}

function Review() {
  const ctx = useSessionCtx();
  const { activeMembership } = useAuth();
  const canReview =
    activeMembership?.role === 'OWNER' ||
    activeMembership?.role === 'ADMIN' ||
    activeMembership?.role === 'MANAGER';

  const engagements = useAsyncList<EngagementView>(
    ctx ? () => api.listEngagements(ctx.accessToken, ctx.companyId).then((r) => r.data) : null,
    [ctx?.companyId]
  );
  const projects = useAsyncList<ProjectView>(
    ctx ? () => api.listProjects(ctx.accessToken, ctx.companyId).then((r) => r.data) : null,
    [ctx?.companyId]
  );
  const timeLogs = useAsyncList<TimeLogView>(
    ctx
      ? () => api.listTimeLogs(ctx.accessToken, ctx.companyId, { status: 'SUBMITTED' }).then((r) => r.data)
      : null,
    [ctx?.companyId]
  );
  const expenses = useAsyncList<ExpenseView>(
    ctx
      ? () => api.listExpenses(ctx.accessToken, ctx.companyId, { status: 'SUBMITTED' }).then((r) => r.data)
      : null,
    [ctx?.companyId]
  );
  const submissions = useAsyncList<SubmissionView>(
    ctx
      ? () =>
          api
            .listSubmissions(ctx.accessToken, ctx.companyId, { status: 'SUBMITTED' })
            .then((r) => r.data)
      : null,
    [ctx?.companyId]
  );

  const [tab, setTab] = useState<Tab>('time');
  const [providerFilter, setProviderFilter] = useState('ALL');
  const [projectFilter, setProjectFilter] = useState('ALL');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [result, setResult] = useState<BulkResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState('');
  const [rejecting, setRejecting] = useState(false);

  const currency = activeMembership?.currency ?? 'USD';

  /** Engagements where we are the client — the only rows we may approve. */
  const clientEngagements = useMemo(() => {
    const map = new Map<string, EngagementView>();
    for (const e of engagements.items) {
      if (e.side === 'client') map.set(e.id, e);
    }
    return map;
  }, [engagements.items]);

  const projectName = (id: string) =>
    projects.items.find((p) => p.id === id)?.name ?? 'Unknown project';
  const providerName = (engagementId: string) =>
    clientEngagements.get(engagementId)?.providerCompanyName ?? 'Unknown';

  /** Subcontractors with something waiting, for the filter dropdown. */
  const providersInQueue = useMemo(() => {
    const names = new Map<string, string>();
    for (const l of timeLogs.items) {
      const e = clientEngagements.get(l.engagementId);
      if (e) names.set(e.providerCompanyId, e.providerCompanyName);
    }
    for (const x of expenses.items) {
      const e = clientEngagements.get(x.engagementId);
      if (e) names.set(e.providerCompanyId, e.providerCompanyName);
    }
    return [...names.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [timeLogs.items, expenses.items, clientEngagements]);

  function inScope(row: { engagementId: string; projectId: string; providerCompanyId: string }): boolean {
    if (!clientEngagements.has(row.engagementId)) return false;
    if (projectFilter !== 'ALL' && row.projectId !== projectFilter) return false;
    if (providerFilter !== 'ALL' && row.providerCompanyId !== providerFilter) return false;
    return true;
  }

  const visibleTime = useMemo(
    () =>
      timeLogs.items
        .filter(inScope)
        .filter((l) => (fromDate ? l.workDate >= fromDate : true))
        .filter((l) => (toDate ? l.workDate <= toDate : true))
        .sort((a, b) => a.workDate.localeCompare(b.workDate) || a.id.localeCompare(b.id)),
    [timeLogs.items, clientEngagements, projectFilter, providerFilter, fromDate, toDate]
  );

  const visibleExpenses = useMemo(
    () => expenses.items.filter(inScope),
    [expenses.items, clientEngagements, projectFilter, providerFilter]
  );

  const visibleSubmissions = useMemo(
    () => submissions.items.filter(inScope),
    [submissions.items, clientEngagements, projectFilter, providerFilter]
  );

  const visibleIds =
    tab === 'time'
      ? visibleTime.map((l) => l.id)
      : tab === 'expenses'
        ? visibleExpenses.map((x) => x.id)
        : visibleSubmissions.map((s) => s.id);

  const selectedVisible = visibleIds.filter((id) => selected.has(id));
  const allSelected = visibleIds.length > 0 && selectedVisible.length === visibleIds.length;

  const loading =
    engagements.loading ||
    projects.loading ||
    timeLogs.loading ||
    expenses.loading ||
    submissions.loading;

  const listError =
    engagements.error ?? projects.error ?? timeLogs.error ?? expenses.error ?? submissions.error;

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allSelected) visibleIds.forEach((id) => next.delete(id));
      else visibleIds.forEach((id) => next.add(id));
      return next;
    });
  }

  function switchTab(next: Tab) {
    setTab(next);
    setSelected(new Set());
    setResult(null);
    setRejecting(false);
  }

  /** The total labour cost of what is selected — worth knowing before approving it. */
  const selectedCostCents = useMemo(() => {
    if (tab === 'time') {
      return visibleTime
        .filter((l) => selected.has(l.id))
        .reduce((sum, l) => sum + (l.resolvedRate?.costCents ?? 0), 0);
    }
    if (tab === 'expenses') {
      return visibleExpenses
        .filter((x) => selected.has(x.id))
        .reduce((sum, x) => sum + x.amountCents, 0);
    }
    return 0;
  }, [tab, visibleTime, visibleExpenses, selected]);

  const unpricedSelected =
    tab === 'time' && visibleTime.filter((l) => selected.has(l.id) && !l.resolvedRate).length;

  async function runBulk(action: 'approve' | 'reject') {
    if (!ctx || selectedVisible.length === 0) return;
    const reason = action === 'reject' ? rejectReason.trim() : '';
    setBusy(true);
    setError(null);
    setResult(null);
    setProgress({ done: 0, total: selectedVisible.length });

    const call = (id: string): Promise<unknown> => {
      if (tab === 'time') {
        return action === 'approve'
          ? api.approveTimeLog(ctx.accessToken, ctx.companyId, id)
          : api.rejectTimeLog(ctx.accessToken, ctx.companyId, id, reason || undefined);
      }
      if (tab === 'expenses') {
        return action === 'approve'
          ? api.approveExpense(ctx.accessToken, ctx.companyId, id)
          : api.rejectExpense(ctx.accessToken, ctx.companyId, id, reason || undefined);
      }
      return action === 'approve'
        ? api.approveSubmission(ctx.accessToken, ctx.companyId, id)
        : api.rejectSubmission(ctx.accessToken, ctx.companyId, id, reason || undefined);
    };

    // No bulk endpoint exists, so this is N requests. Four at a time keeps a 200-row
    // batch quick without opening 200 sockets at once.
    const queue = [...selectedVisible];
    const failures: { id: string; message: string }[] = [];
    let succeeded = 0;
    let done = 0;

    async function worker() {
      for (;;) {
        const id = queue.shift();
        if (id === undefined) return;
        try {
          await call(id);
          succeeded += 1;
        } catch (err) {
          failures.push({
            id,
            message: err instanceof ApiError ? err.message : 'Request failed',
          });
        } finally {
          done += 1;
          setProgress({ done, total: selectedVisible.length });
        }
      }
    }

    await Promise.all(Array.from({ length: Math.min(4, queue.length) }, worker));

    // Keep only the failures selected: everything else is finished, and re-running
    // an already-approved row would just collect a 409.
    setSelected(new Set(failures.map((f) => f.id)));
    setResult({ action, succeeded, failures });
    setProgress(null);
    setBusy(false);
    setRejecting(false);
    setRejectReason('');

    if (tab === 'time') timeLogs.reload();
    else if (tab === 'expenses') expenses.reload();
    else submissions.reload();
  }

  if (!canReview) {
    return (
      <Stack>
        <PageHeader eyebrow="Delivery" title="Approvals" />
        <EmptyState title="Approving needs a manager role">
          Only an owner, admin or manager of the hiring company can approve or reject
          submitted work. Your role in this company is {titleCase(activeMembership?.role ?? '')}.
        </EmptyState>
      </Stack>
    );
  }

  return (
    <Stack>
      <PageHeader
        eyebrow="Delivery"
        title="Approvals"
        description="Everything your subcontractors have submitted and are waiting on. Select many, decide once."
      />

      <div className="cq-metrics" aria-label="Pending work">
        <div className="cq-metric">
          <div className="cq-overline">Time logs</div>
          <div className="cq-metric__value">{loading ? '—' : visibleTime.length}</div>
          <div className="cq-metric__context">Awaiting your decision</div>
        </div>
        <div className="cq-metric">
          <div className="cq-overline">Expenses</div>
          <div className="cq-metric__value">{loading ? '—' : visibleExpenses.length}</div>
          <div className="cq-metric__context">Awaiting your decision</div>
        </div>
        <div className="cq-metric">
          <div className="cq-overline">Submissions</div>
          <div className="cq-metric__value">{loading ? '—' : visibleSubmissions.length}</div>
          <div className="cq-metric__context">Period packages handed up</div>
        </div>
        <div className="cq-metric">
          <div className="cq-overline">Subcontractors waiting</div>
          <div className="cq-metric__value">{loading ? '—' : providersInQueue.length}</div>
          <div className="cq-metric__context">With something in the queue</div>
        </div>
      </div>

      {result ? (
        <Notice>
          {result.failures.length === 0 ? (
            <>
              <strong>
                {result.succeeded} {result.succeeded === 1 ? 'item' : 'items'}{' '}
                {result.action === 'approve' ? 'approved' : 'rejected'}.
              </strong>{' '}
              Project totals have been recalculated.
            </>
          ) : (
            <>
              <strong>
                {result.succeeded} {result.action === 'approve' ? 'approved' : 'rejected'},{' '}
                {result.failures.length} failed.
              </strong>{' '}
              The failures are still selected so you can retry them:
              <ul>
                {result.failures.slice(0, 5).map((f) => (
                  <li key={f.id}>{f.message}</li>
                ))}
              </ul>
              {result.failures.length > 5 ? (
                <span>and {result.failures.length - 5} more with the same kinds of error.</span>
              ) : null}
            </>
          )}
        </Notice>
      ) : null}

      <Section className="cq-section--table">
        <div className="cq-table-toolbar">
          <Select value={tab} onChange={(e) => switchTab(e.target.value as Tab)} aria-label="What to review">
            <option value="time">Time logs ({visibleTime.length})</option>
            <option value="expenses">Expenses ({visibleExpenses.length})</option>
            <option value="submissions">Submissions ({visibleSubmissions.length})</option>
          </Select>
          <Select
            value={providerFilter}
            onChange={(e) => setProviderFilter(e.target.value)}
            aria-label="Filter by subcontractor"
          >
            <option value="ALL">All subcontractors</option>
            {providersInQueue.map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </Select>
          <Select
            value={projectFilter}
            onChange={(e) => setProjectFilter(e.target.value)}
            aria-label="Filter by project"
          >
            <option value="ALL">All projects</option>
            {projects.items.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
          {tab === 'time' ? (
            <>
              <Input
                type="date"
                value={fromDate}
                onChange={(e) => setFromDate(e.target.value)}
                aria-label="Work date from"
              />
              <Input
                type="date"
                value={toDate}
                onChange={(e) => setToDate(e.target.value)}
                aria-label="Work date to"
              />
            </>
          ) : null}
          <span className="cq-table-toolbar__meta">
            {selectedVisible.length > 0
              ? `${selectedVisible.length} selected${tab !== 'submissions' ? ` · ${formatCents(selectedCostCents, currency)}` : ''}`
              : `${visibleIds.length} ${visibleIds.length === 1 ? 'item' : 'items'}`}
          </span>
        </div>

        <ErrorText>{error ?? listError}</ErrorText>

        {selectedVisible.length > 0 ? (
          <Stack>
            {unpricedSelected ? (
              <Notice>
                {unpricedSelected} of the selected {unpricedSelected === 1 ? 'log has' : 'logs have'} no
                rate snapshot, so {unpricedSelected === 1 ? 'it' : 'they'} will approve at no cost.
                That happens when no PAY rate card covered the role, shift and date at submit
                time. Approving is allowed, but the cost will read as nil until a card is added
                and the work is re-submitted.
              </Notice>
            ) : null}

            {rejecting ? (
              <div className="cq-stack">
                <Field
                  label="Reason for rejection"
                  hint="Sent with every item in this batch. This is the only thing that tells the crew what to fix."
                >
                  <Input
                    value={rejectReason}
                    onChange={(e) => setRejectReason(e.target.value)}
                    maxLength={500}
                    autoFocus
                  />
                </Field>
                <Row>
                  <Button
                    variant="danger"
                    disabled={busy}
                    onClick={() => void runBulk('reject')}
                  >
                    {busy
                      ? `Rejecting ${progress?.done ?? 0} of ${progress?.total ?? 0}…`
                      : `Reject ${selectedVisible.length}`}
                  </Button>
                  <Button variant="secondary" disabled={busy} onClick={() => setRejecting(false)}>
                    Cancel
                  </Button>
                </Row>
              </div>
            ) : (
              <Row>
                <Button disabled={busy} onClick={() => void runBulk('approve')}>
                  {busy
                    ? `Approving ${progress?.done ?? 0} of ${progress?.total ?? 0}…`
                    : `Approve ${selectedVisible.length}`}
                </Button>
                <Button variant="danger" disabled={busy} onClick={() => setRejecting(true)}>
                  Reject {selectedVisible.length}…
                </Button>
                <Button
                  variant="secondary"
                  disabled={busy}
                  onClick={() => setSelected(new Set())}
                >
                  Clear selection
                </Button>
              </Row>
            )}
          </Stack>
        ) : null}

        {loading ? (
          <p className="cq-muted">Loading the queue…</p>
        ) : visibleIds.length === 0 ? (
          <EmptyState title="Nothing waiting">
            {clientEngagements.size === 0
              ? 'You have no subcontractors yet, so nothing can be submitted to you. Add one under Network.'
              : 'Every submitted item has been decided. New submissions appear here as they arrive.'}
          </EmptyState>
        ) : tab === 'time' ? (
          <Table label="Submitted time logs">
            <thead>
              <tr>
                <th scope="col">
                  <input
                    type="checkbox"
                    checked={allSelected}
                    onChange={toggleAll}
                    aria-label="Select all visible time logs"
                  />
                </th>
                <th scope="col" className="cq-numeric">Work date</th>
                <th scope="col">Subcontractor</th>
                <th scope="col">Project</th>
                <th scope="col">Shift</th>
                <th scope="col" className="cq-numeric">Hours</th>
                <th scope="col" className="cq-numeric">Cost to you</th>
              </tr>
            </thead>
            <tbody>
              {visibleTime.map((l) => (
                <tr key={l.id}>
                  <td>
                    <input
                      type="checkbox"
                      checked={selected.has(l.id)}
                      onChange={() => toggle(l.id)}
                      aria-label={`Select time log for ${l.workDate}`}
                    />
                  </td>
                  <td className="cq-table__primary cq-numeric">{formatDate(l.workDate)}</td>
                  <td>{providerName(l.engagementId)}</td>
                  <td>
                    <Link href={`/projects/${l.projectId}`}>{projectName(l.projectId)}</Link>
                  </td>
                  <td>{titleCase(l.shiftType)}</td>
                  <td className="cq-numeric">
                    {totalHours(l)}
                    {l.hoursOt > 0 ? <span className="cq-muted"> ({l.hoursOt} OT)</span> : null}
                  </td>
                  <td className="cq-numeric">
                    {l.resolvedRate ? (
                      formatCents(l.resolvedRate.costCents, currency)
                    ) : (
                      <Badge tone="warning">Not priced</Badge>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        ) : tab === 'expenses' ? (
          <Table label="Submitted expenses">
            <thead>
              <tr>
                <th scope="col">
                  <input
                    type="checkbox"
                    checked={allSelected}
                    onChange={toggleAll}
                    aria-label="Select all visible expenses"
                  />
                </th>
                <th scope="col" className="cq-numeric">Raised</th>
                <th scope="col">Subcontractor</th>
                <th scope="col">Project</th>
                <th scope="col">Category</th>
                <th scope="col">Description</th>
                <th scope="col" className="cq-numeric">Amount</th>
              </tr>
            </thead>
            <tbody>
              {visibleExpenses.map((x) => (
                <tr key={x.id}>
                  <td>
                    <input
                      type="checkbox"
                      checked={selected.has(x.id)}
                      onChange={() => toggle(x.id)}
                      aria-label="Select expense"
                    />
                  </td>
                  <td className="cq-table__primary cq-numeric">
                    {formatDate(x.createdAt.slice(0, 10))}
                  </td>
                  <td>{providerName(x.engagementId)}</td>
                  <td>
                    <Link href={`/projects/${x.projectId}`}>{projectName(x.projectId)}</Link>
                  </td>
                  <td>{x.category ?? <span className="cq-muted">—</span>}</td>
                  <td>{x.description ?? <span className="cq-muted">—</span>}</td>
                  <td className="cq-numeric">{formatCents(x.amountCents, currency)}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        ) : (
          <Table label="Submitted work packages">
            <thead>
              <tr>
                <th scope="col">
                  <input
                    type="checkbox"
                    checked={allSelected}
                    onChange={toggleAll}
                    aria-label="Select all visible submissions"
                  />
                </th>
                <th scope="col">Submitted</th>
                <th scope="col">Subcontractor</th>
                <th scope="col">Project</th>
                <th scope="col">Period</th>
              </tr>
            </thead>
            <tbody>
              {visibleSubmissions.map((s) => (
                <tr key={s.id}>
                  <td>
                    <input
                      type="checkbox"
                      checked={selected.has(s.id)}
                      onChange={() => toggle(s.id)}
                      aria-label="Select submission"
                    />
                  </td>
                  <td className="cq-table__primary cq-numeric">
                    {formatDate(s.createdAt.slice(0, 10))}
                  </td>
                  <td>{providerName(s.engagementId)}</td>
                  <td>
                    <Link href={`/projects/${s.projectId}`}>{projectName(s.projectId)}</Link>
                  </td>
                  <td className="cq-numeric">
                    {s.periodStart || s.periodEnd ? (
                      `${formatDate(s.periodStart)} to ${formatDate(s.periodEnd)}`
                    ) : (
                      <span className="cq-muted">No period given</span>
                    )}
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
