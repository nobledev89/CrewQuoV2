'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import {
  PROJECT_STATUSES,
  type AssignmentView,
  type ExpenseView,
  type ProjectStatus,
  type ProjectSummary,
  type ProjectView,
  type ProviderView,
  type TimeLogView,
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
import { api, ApiError, refusedFeature } from '@/api/client';
import { useAuth, useSessionCtx } from '@/auth/AuthProvider';
import { useAsyncData } from '@/lib/useAsyncData';
import { useAsyncList } from '@/lib/useAsyncList';
import { useEntitlements } from '@/lib/useEntitlements';
import { ProjectStatusBadge, WorkStatusBadge } from '@/components/Status';
import { formatCents, formatDate, formatPct, titleCase, totalHours } from '@/lib/format';

/**
 * Project detail — the owner's view: what it cost, what it bills, who is assigned,
 * and the work behind those numbers.
 *
 * Every figure here comes from `GET /v1/projects/:id/summary`, which is the same
 * `computeProjectSummary` the exports and the client portal use. Nothing on this page
 * recomputes money client-side — that is what keeps the screen, the PDF and the
 * portal from disagreeing (§29.4 is the eventual formalisation of the same rule).
 */
export default function ProjectDetailPage() {
  return (
    <Shell>
      <ProjectDetail />
    </Shell>
  );
}

function ProjectDetail() {
  const params = useParams<{ id: string }>();
  const id = typeof params.id === 'string' ? params.id : '';
  const ctx = useSessionCtx();
  const router = useRouter();
  const { activeMembership } = useAuth();
  const canManage =
    activeMembership?.role === 'OWNER' ||
    activeMembership?.role === 'ADMIN' ||
    activeMembership?.role === 'MANAGER';

  const project = useAsyncData<ProjectView>(
    ctx ? () => api.getProject(ctx.accessToken, ctx.companyId, id).then((r) => r.project) : null,
    [ctx?.companyId, id]
  );
  const summary = useAsyncData<ProjectSummary>(
    ctx ? () => api.projectSummary(ctx.accessToken, ctx.companyId, id).then((r) => r.summary) : null,
    [ctx?.companyId, id]
  );
  const assignments = useAsyncList<AssignmentView>(
    ctx ? () => api.listAssignments(ctx.accessToken, ctx.companyId, id).then((r) => r.data) : null,
    [ctx?.companyId, id]
  );
  const timeLogs = useAsyncList<TimeLogView>(
    ctx
      ? () => api.listTimeLogs(ctx.accessToken, ctx.companyId, { projectId: id }).then((r) => r.data)
      : null,
    [ctx?.companyId, id]
  );
  const expenses = useAsyncList<ExpenseView>(
    ctx
      ? () => api.listExpenses(ctx.accessToken, ctx.companyId, { projectId: id }).then((r) => r.data)
      : null,
    [ctx?.companyId, id]
  );

  const currency = summary.data?.currency ?? activeMembership?.currency ?? 'USD';

  if (project.loading) {
    return (
      <Stack>
        <PageHeader eyebrow="Delivery" title="Project" />
        <p className="cq-muted">Loading project…</p>
      </Stack>
    );
  }

  if (project.error || !project.data) {
    return (
      <Stack>
        <PageHeader eyebrow="Delivery" title="Project" />
        <EmptyState title="Project not found">
          {project.error ?? 'This project does not exist, or it belongs to another company.'}{' '}
          <Link href="/projects">Back to projects</Link>
        </EmptyState>
      </Stack>
    );
  }

  const p = project.data;

  return (
    <Stack>
      <PageHeader
        eyebrow={p.clientCompanyName ? `For ${p.clientCompanyName}` : 'Internal project'}
        title={p.name}
        description={
          p.startsOn || p.endsOn
            ? `${formatDate(p.startsOn)} to ${formatDate(p.endsOn)}`
            : 'No dates set'
        }
        actions={
          <Row>
            <ProjectStatusBadge status={p.status} />
            {p.clientVisible ? <Badge tone="accent">Shared with client</Badge> : null}
          </Row>
        }
      />

      <SummaryPanel summary={summary} currency={currency} />

      <ExportPanel projectId={p.id} projectName={p.name} />

      <AssignmentsPanel
        projectId={p.id}
        assignments={assignments}
        canManage={canManage}
        onChanged={() => {
          assignments.reload();
          summary.reload();
        }}
      />

      <WorkPanel
        timeLogs={timeLogs}
        expenses={expenses}
        assignments={assignments.items}
        currency={currency}
      />

      {canManage ? (
        <EditPanel
          project={p}
          onSaved={() => {
            project.reload();
            summary.reload();
          }}
          onDeleted={() => router.replace('/projects')}
        />
      ) : null}
    </Stack>
  );
}

// ── Summary ────────────────────────────────────────────────────────────────────

function SummaryPanel({
  summary,
  currency,
}: {
  summary: ReturnType<typeof useAsyncData<ProjectSummary>>;
  currency: string;
}) {
  const s = summary.data;

  return (
    <>
      <div className="cq-metrics" aria-label="Project financials">
        <div className="cq-metric">
          <div className="cq-overline">Cost to you</div>
          <div className="cq-metric__value">
            {s ? formatCents(s.totalCostCents, currency) : '—'}
          </div>
          <div className="cq-metric__context">
            {s ? `Labour ${formatCents(s.laborCostCents, currency)} + expenses ${formatCents(s.expenseCostCents, currency)}` : 'Loading'}
          </div>
        </div>
        <div className="cq-metric">
          <div className="cq-overline">Billed to client</div>
          <div className="cq-metric__value">{s ? formatCents(s.billCents, currency) : '—'}</div>
          <div className="cq-metric__context">
            {s && s.billCents === null
              ? 'No client, or no BILL rate covers this work'
              : 'At your BILL rates'}
          </div>
        </div>
        <div className="cq-metric">
          <div className="cq-overline">Margin</div>
          <div className="cq-metric__value">{s ? formatCents(s.marginCents, currency) : '—'}</div>
          <div className="cq-metric__context">
            {s ? `${formatPct(s.marginPct)} of the billed total` : 'Loading'}
          </div>
        </div>
        <div className="cq-metric">
          <div className="cq-overline">Approved work</div>
          <div className="cq-metric__value">{s ? s.approvedTimeLogs : '—'}</div>
          <div className="cq-metric__context">
            {s ? `${s.approvedExpenses} approved ${s.approvedExpenses === 1 ? 'expense' : 'expenses'}` : 'Loading'}
          </div>
        </div>
      </div>

      <ErrorText>{summary.error}</ErrorText>

      {s && s.billCents === null && s.totalCostCents > 0 ? (
        <Notice>
          This project has cost but no billable total. Either it has no client, or no BILL rate
          card covers the approved work — a missing figure here means <em>not known</em>, not
          zero, so it is left blank rather than shown as nil margin.
        </Notice>
      ) : null}

      <Section
        title="By subcontractor"
        description="Only approved work counts. Costs come from each log's frozen rate snapshot, not from today's rate card."
        className="cq-section--table"
      >
        {summary.loading ? (
          <p className="cq-muted">Loading summary…</p>
        ) : !s || s.byProvider.length === 0 ? (
          <EmptyState title="No approved work yet">
            Once a subcontractor submits time and you approve it, the cost breakdown appears
            here.
          </EmptyState>
        ) : (
          <Table label="Cost by subcontractor">
            <thead>
              <tr>
                <th scope="col">Subcontractor</th>
                <th scope="col">Approved logs</th>
                <th scope="col">Labour</th>
                <th scope="col">Expenses</th>
                <th scope="col">Total</th>
              </tr>
            </thead>
            <tbody>
              {s.byProvider.map((row) => (
                <tr key={row.providerCompanyId}>
                  <td className="cq-table__primary">{row.providerCompanyName}</td>
                  <td className="cq-numeric">{row.approvedTimeLogs}</td>
                  <td className="cq-numeric">{formatCents(row.laborCostCents, currency)}</td>
                  <td className="cq-numeric">{formatCents(row.expenseCostCents, currency)}</td>
                  <td className="cq-numeric">
                    {formatCents(row.laborCostCents + row.expenseCostCents, currency)}
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Section>
    </>
  );
}

// ── Exports ────────────────────────────────────────────────────────────────────

/**
 * Owner-side export (§7). The file is fetched with the auth headers and handed to the
 * browser as a blob — the endpoint is not a plain link, because a bare `<a href>`
 * cannot carry `Authorization` or `X-Company-Id`.
 */
function ExportPanel({ projectId, projectName }: { projectId: string; projectName: string }) {
  const ctx = useSessionCtx();
  const ent = useEntitlements();
  const [busy, setBusy] = useState<'pdf' | 'xlsx' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const allowed = ent.has('exports');

  async function run(format: 'pdf' | 'xlsx') {
    if (!ctx) return;
    setBusy(format);
    setError(null);
    try {
      const blob = await api.exportProject(ctx.accessToken, ctx.companyId, projectId, format);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${projectName.replace(/[^\w.-]+/g, '-')}.${format}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(
        refusedFeature(err) === 'exports'
          ? 'Exports are not on your plan.'
          : err instanceof ApiError
            ? err.message
            : 'Could not produce the export'
      );
    } finally {
      setBusy(null);
    }
  }

  return (
    <Section
      title="Export"
      description="The numbers in the file are the summary above — the export reads the same computation, so the two cannot disagree."
    >
      {ent.data && !allowed ? (
        <Notice>
          <strong>Exports are not on your plan.</strong> See <Link href="/plan">plan &amp; usage</Link>{' '}
          for what includes them.
        </Notice>
      ) : (
        <Stack>
          <Row>
            <Button
              variant="secondary"
              disabled={!allowed || busy !== null}
              onClick={() => void run('pdf')}
            >
              {busy === 'pdf' ? 'Preparing…' : 'Download PDF'}
            </Button>
            <Button
              variant="secondary"
              disabled={!allowed || busy !== null}
              onClick={() => void run('xlsx')}
            >
              {busy === 'xlsx' ? 'Preparing…' : 'Download spreadsheet'}
            </Button>
          </Row>
          <p className="cq-muted">
            This is your internal copy: it includes cost, margin and which subcontractor did
            the work. The client-facing document is a separate, BILL-only report.
          </p>
          <ErrorText>{error}</ErrorText>
        </Stack>
      )}
    </Section>
  );
}

// ── Assignments ────────────────────────────────────────────────────────────────

function AssignmentsPanel({
  projectId,
  assignments,
  canManage,
  onChanged,
}: {
  projectId: string;
  assignments: ReturnType<typeof useAsyncList<AssignmentView>>;
  canManage: boolean;
  onChanged: () => void;
}) {
  const ctx = useSessionCtx();
  const providers = useAsyncList<ProviderView>(
    ctx ? () => api.listProviders(ctx.accessToken, ctx.companyId).then((r) => r.data) : null,
    [ctx?.companyId]
  );
  const [providerId, setProviderId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const assignedIds = new Set(assignments.items.map((a) => a.providerCompanyId));
  const available = providers.items.filter((p) => !assignedIds.has(p.providerCompanyId));

  async function assign() {
    if (!ctx || !providerId) return;
    setBusy(true);
    setError(null);
    try {
      await api.createAssignment(ctx.accessToken, ctx.companyId, projectId, {
        providerCompanyId: providerId,
      });
      setProviderId('');
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not assign the subcontractor');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section
      title="Assigned subcontractors"
      description="Assigning a subcontractor is what lets their crew log time against this project."
      className="cq-section--table"
      actions={
        canManage && available.length > 0 ? (
          <Row>
            <Select
              value={providerId}
              onChange={(e) => setProviderId(e.target.value)}
              aria-label="Subcontractor to assign"
            >
              <option value="">Choose a subcontractor…</option>
              {available.map((p) => (
                <option key={p.providerCompanyId} value={p.providerCompanyId}>
                  {p.name}
                </option>
              ))}
            </Select>
            <Button size="sm" disabled={!providerId || busy} onClick={() => void assign()}>
              {busy ? 'Assigning…' : 'Assign'}
            </Button>
          </Row>
        ) : null
      }
    >
      <ErrorText>{error ?? assignments.error}</ErrorText>
      {assignments.loading ? (
        <p className="cq-muted">Loading assignments…</p>
      ) : assignments.items.length === 0 ? (
        <EmptyState title="Nobody assigned yet">
          {providers.items.length === 0 ? (
            <>
              You have no subcontractors yet — <Link href="/network/providers">add one</Link>{' '}
              first.
            </>
          ) : (
            'Assign a subcontractor so their crew can log time and expenses against this project.'
          )}
        </EmptyState>
      ) : (
        <Table label="Assigned subcontractors">
          <thead>
            <tr>
              <th scope="col">Subcontractor</th>
              <th scope="col">Assigned</th>
            </tr>
          </thead>
          <tbody>
            {assignments.items.map((a) => (
              <tr key={a.id}>
                <td className="cq-table__primary">{a.providerCompanyName}</td>
                <td>{formatDate(a.createdAt.slice(0, 10))}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      {canManage && assignments.items.length > 0 && available.length === 0 && providers.items.length > 0 ? (
        <p className="cq-muted">Every subcontractor you have is already assigned to this project.</p>
      ) : null}
    </Section>
  );
}

// ── Work on this project ───────────────────────────────────────────────────────

function WorkPanel({
  timeLogs,
  expenses,
  assignments,
  currency,
}: {
  timeLogs: ReturnType<typeof useAsyncList<TimeLogView>>;
  expenses: ReturnType<typeof useAsyncList<ExpenseView>>;
  assignments: AssignmentView[];
  currency: string;
}) {
  const providerName = (companyId: string) =>
    assignments.find((a) => a.providerCompanyId === companyId)?.providerCompanyName ?? 'Unknown';

  const pending = timeLogs.items.filter((l) => l.status === 'SUBMITTED').length;

  return (
    <Section
      title="Work logged"
      description="Every time log and expense on this project, whatever its state."
      className="cq-section--table"
      actions={
        pending > 0 ? (
          <Link className="cq-btn cq-btn--sm" href="/review">
            Review {pending} pending
          </Link>
        ) : null
      }
    >
      <ErrorText>{timeLogs.error ?? expenses.error}</ErrorText>

      {timeLogs.loading ? (
        <p className="cq-muted">Loading time logs…</p>
      ) : timeLogs.items.length === 0 ? (
        <EmptyState title="No time logged yet">
          Assigned crews log time from their own workspace; it appears here as soon as they do.
        </EmptyState>
      ) : (
        <Table label="Time logs">
          <thead>
            <tr>
              <th scope="col">Date</th>
              <th scope="col">Subcontractor</th>
              <th scope="col">Shift</th>
              <th scope="col">Hours</th>
              <th scope="col">Cost to you</th>
              <th scope="col">Status</th>
            </tr>
          </thead>
          <tbody>
            {timeLogs.items.map((l) => (
              <tr key={l.id}>
                <td className="cq-table__primary cq-numeric">{formatDate(l.workDate)}</td>
                <td>{providerName(l.providerCompanyId)}</td>
                <td>{titleCase(l.shiftType)}</td>
                <td className="cq-numeric">
                  {totalHours(l)}
                  {l.hoursOt > 0 ? <span className="cq-muted"> ({l.hoursOt} OT)</span> : null}
                </td>
                <td className="cq-numeric">
                  {l.resolvedRate ? (
                    formatCents(l.resolvedRate.costCents, currency)
                  ) : (
                    <span className="cq-muted">Not priced</span>
                  )}
                </td>
                <td>
                  <WorkStatusBadge status={l.status} />
                  {l.rejectReason ? (
                    <div className="cq-muted">{l.rejectReason}</div>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}

      {expenses.items.length > 0 ? (
        <Table label="Expenses">
          <thead>
            <tr>
              <th scope="col">Logged</th>
              <th scope="col">Subcontractor</th>
              <th scope="col">Category</th>
              <th scope="col">Description</th>
              <th scope="col">Amount</th>
              <th scope="col">Status</th>
            </tr>
          </thead>
          <tbody>
            {expenses.items.map((x) => (
              <tr key={x.id}>
                <td className="cq-table__primary cq-numeric">
                  {formatDate(x.createdAt.slice(0, 10))}
                </td>
                <td>{providerName(x.providerCompanyId)}</td>
                <td>{x.category ?? <span className="cq-muted">—</span>}</td>
                <td>{x.description ?? <span className="cq-muted">—</span>}</td>
                <td className="cq-numeric">{formatCents(x.amountCents, currency)}</td>
                <td>
                  <WorkStatusBadge status={x.status} />
                  {x.rejectReason ? <div className="cq-muted">{x.rejectReason}</div> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      ) : null}
    </Section>
  );
}

// ── Edit / delete ──────────────────────────────────────────────────────────────

function EditPanel({
  project,
  onSaved,
  onDeleted,
}: {
  project: ProjectView;
  onSaved: () => void;
  onDeleted: () => void;
}) {
  const ctx = useSessionCtx();
  const [name, setName] = useState(project.name);
  const [status, setStatus] = useState<ProjectStatus>(project.status);
  const [startsOn, setStartsOn] = useState(project.startsOn ?? '');
  const [endsOn, setEndsOn] = useState(project.endsOn ?? '');
  const [notes, setNotes] = useState(project.notes ?? '');
  const [clientVisible, setClientVisible] = useState(project.clientVisible);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dirty =
    name.trim() !== project.name ||
    status !== project.status ||
    (startsOn || null) !== project.startsOn ||
    (endsOn || null) !== project.endsOn ||
    (notes.trim() || null) !== project.notes ||
    clientVisible !== project.clientVisible;

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!ctx) return;
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      // Send only what changed — an unchanged field would still write an audit row
      // claiming it moved.
      await api.updateProject(ctx.accessToken, ctx.companyId, project.id, {
        ...(name.trim() !== project.name ? { name: name.trim() } : {}),
        ...(status !== project.status ? { status } : {}),
        ...((startsOn || null) !== project.startsOn ? { startsOn: startsOn || null } : {}),
        ...((endsOn || null) !== project.endsOn ? { endsOn: endsOn || null } : {}),
        ...((notes.trim() || null) !== project.notes ? { notes: notes.trim() || null } : {}),
        ...(clientVisible !== project.clientVisible ? { clientVisible } : {}),
      });
      setSaved(true);
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save the project');
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!ctx) return;
    if (
      !window.confirm(
        `Delete "${project.name}"? This cannot be undone. Logged work and its history go with it.`
      )
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.deleteProject(ctx.accessToken, ctx.companyId, project.id);
      onDeleted();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not delete the project');
      setBusy(false);
    }
  }

  const publishing = clientVisible && !project.clientVisible;
  const unpublishing = !clientVisible && project.clientVisible;

  return (
    <Section title="Project settings" description="Manager role and above.">
      <form onSubmit={save} className="cq-stack" aria-busy={busy}>
        <div className="cq-form-grid">
          <Field label="Project name">
            <Input value={name} onChange={(e) => setName(e.target.value)} required />
          </Field>
          <Field label="Status">
            <Select value={status} onChange={(e) => setStatus(e.target.value as ProjectStatus)}>
              {PROJECT_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s.charAt(0) + s.slice(1).toLowerCase()}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Starts on">
            <Input type="date" value={startsOn} onChange={(e) => setStartsOn(e.target.value)} />
          </Field>
          <Field label="Ends on">
            <Input type="date" value={endsOn} onChange={(e) => setEndsOn(e.target.value)} />
          </Field>
        </div>

        <Field label="Notes">
          <Input value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={2000} />
        </Field>

        <label className="cq-row" style={{ gap: 8 }}>
          <input
            type="checkbox"
            checked={clientVisible}
            disabled={!project.clientCompanyId}
            onChange={(e) => setClientVisible(e.target.checked)}
          />
          <span>
            Publish to the client portal
            {!project.clientCompanyId ? (
              <span className="cq-muted"> — this project has no client</span>
            ) : null}
          </span>
        </label>

        {publishing ? (
          <Notice>
            <strong>{project.clientCompanyName}</strong> will be able to see this project and
            its line items at your BILL rates as soon as you save. They never see your cost,
            your margin, or which subcontractor did the work.
          </Notice>
        ) : null}
        {unpublishing ? (
          <Notice>
            Unpublishing hides the project from <strong>{project.clientCompanyName}</strong>{' '}
            immediately. Notes already left on it are kept, not deleted.
          </Notice>
        ) : null}

        <ErrorText>{error}</ErrorText>
        <Row between>
          <Row>
            <Button type="submit" disabled={busy || !dirty}>
              {busy ? 'Saving…' : 'Save changes'}
            </Button>
            {saved && !dirty ? <Badge tone="success">Saved</Badge> : null}
          </Row>
          <Button variant="danger" disabled={busy} onClick={() => void remove()}>
            Delete project
          </Button>
        </Row>
      </form>
    </Section>
  );
}
