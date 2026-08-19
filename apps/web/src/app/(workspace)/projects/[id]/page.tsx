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
  RecordHeader,
  Row,
  Section,
  SectionRail,
  Select,
  Stack,
  Table,
  type RailSection,
} from '@crewquo/ui';
import { Shell } from '@/components/Shell';
import { api, ApiError, refusedFeature } from '@/api/client';
import { useAuth, useSessionCtx } from '@/auth/AuthProvider';
import { useAsyncData } from '@/lib/useAsyncData';
import { useAsyncList } from '@/lib/useAsyncList';
import { useEntitlements } from '@/lib/useEntitlements';
import { useUrlQuery } from '@/lib/useUrlQuery';
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

  // The project's reporting currency, which is what the summary is denominated in
  // (§3.3 decision #5). The project row is the fallback rather than the company,
  // because a company that changed currency must not relabel a closed project.
  const currency =
    summary.data?.currency ?? project.data?.reportingCurrency ?? activeMembership?.currency ?? 'USD';
  // In the URL so a section is linkable and survives a reload — "look at the expenses on
  // Pier 9" should be a link, not an instruction to click twice.
  const [section, setSection] = useUrlQuery('section');

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
  const s = summary.data;

  /**
   * A project is one record with sections, not a stack of dashboards (§20). The rail
   * carries the section list and marks which ones hold anything, which is §20's
   * progressive-disclosure rule: an empty section says so in one dim line instead of
   * shouting an empty panel at the same volume as a populated one.
   *
   * Phases 7-12 add Locations, Evidence, Documents, Site Diary, Assets, Sustainability,
   * Variations, Schedule, Sign-Off and Reports here — as rail entries, not as ten more
   * full-width panels on an ever-longer page. Only sections that exist are listed:
   * advertising a section that is not built yet is a promise, not navigation.
   */
  const sections: RailSection[] = [
    { id: 'overview', label: 'Overview' },
    { id: 'crew', label: 'Crew', count: assignments.items.length, populated: assignments.items.length > 0 },
    { id: 'time', label: 'Time & costs', count: timeLogs.items.length, populated: timeLogs.items.length > 0 },
    { id: 'expenses', label: 'Expenses', count: expenses.items.length, populated: expenses.items.length > 0 },
    { id: 'reports', label: 'Reports' },
    ...(canManage ? [{ id: 'settings', label: 'Settings' } satisfies RailSection] : []),
  ];
  const active = sections.some((x) => x.id === section) ? section : 'overview';

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

      {/* The dense figure strip §20 asks for: it belongs to the record, so it stays put
          whichever section is open rather than scrolling away with the Overview. */}
      <RecordHeader
        figures={[
          {
            label: 'Cost to you',
            value: s ? formatCents(s.totalCostCents, currency) : '—',
            note: s
              ? `Labour ${formatCents(s.laborCostCents, currency)} + expenses ${formatCents(s.expenseCostCents, currency)}`
              : 'Loading',
          },
          {
            label: 'Billed to client',
            value: s ? formatCents(s.billCents, currency) : '—',
            note:
              s && s.billCents === null ? 'No client, or no BILL rate covers this work' : 'At your BILL rates',
          },
          {
            label: 'Margin',
            value: s ? formatCents(s.marginCents, currency) : '—',
            note: s ? `${formatPct(s.marginPct)} of the billed total` : 'Loading',
          },
          {
            label: 'Approved work',
            value: s ? s.approvedTimeLogs : '—',
            note: s
              ? `${s.approvedExpenses} approved ${s.approvedExpenses === 1 ? 'expense' : 'expenses'}`
              : 'Loading',
          },
        ]}
      />

      <ErrorText>{summary.error}</ErrorText>

      <div className="cq-record">
        <SectionRail sections={sections} active={active} onSelect={setSection} groupLabel="Project" />

        <Stack>
          {active === 'overview' ? (
            <SummaryPanel summary={summary} currency={currency} />
          ) : null}

          {active === 'crew' ? (
            <AssignmentsPanel
              projectId={p.id}
              assignments={assignments}
              canManage={canManage}
              onChanged={() => {
                assignments.reload();
                summary.reload();
              }}
            />
          ) : null}

          {active === 'time' ? (
            <TimePanel timeLogs={timeLogs} assignments={assignments.items} currency={currency} />
          ) : null}

          {active === 'expenses' ? (
            <ExpensePanel expenses={expenses} assignments={assignments.items} currency={currency} />
          ) : null}

          {active === 'reports' ? <ExportPanel projectId={p.id} projectName={p.name} /> : null}

          {active === 'settings' && canManage ? (
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
      </div>
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
              <th scope="col">Accepted</th>
            </tr>
          </thead>
          <tbody>
            {assignments.items.map((a) => (
              <tr key={a.id}>
                <td className="cq-table__primary">{a.providerCompanyName}</td>
                <td>{formatDate(a.createdAt.slice(0, 10))}</td>
                <td>
                  {/* Acceptance is the provider's to give and never blocks work
                      capture, so this column reports where things stand rather than
                      warning about a blocker. A decline is worth the reason inline. */}
                  {a.acceptance === 'ACCEPTED' ? (
                    <Badge tone="success">Yes</Badge>
                  ) : a.acceptance === 'DECLINED' ? (
                    <>
                      <Badge tone="warning">Declined</Badge>
                      {a.decisionReason ? (
                        <span className="cq-table__note">{a.decisionReason}</span>
                      ) : null}
                    </>
                  ) : (
                    <Badge tone="neutral">Awaiting them</Badge>
                  )}
                </td>
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

// ── Time & costs ───────────────────────────────────────────────────────────────

function TimePanel({
  timeLogs,
  assignments,
  currency,
}: {
  timeLogs: ReturnType<typeof useAsyncList<TimeLogView>>;
  assignments: AssignmentView[];
  currency: string;
}) {
  const providerName = (companyId: string) =>
    assignments.find((a) => a.providerCompanyId === companyId)?.providerCompanyName ?? 'Unknown';

  const pending = timeLogs.items.filter((l) => l.status === 'SUBMITTED').length;

  return (
    <Section
      title="Time & costs"
      description="Every time log on this project, whatever its state. Costs are each log's frozen snapshot."
      className="cq-section--table"
      actions={
        pending > 0 ? (
          <Link className="cq-btn cq-btn--sm" href="/review">
            Review {pending} pending
          </Link>
        ) : null
      }
    >
      <ErrorText>{timeLogs.error}</ErrorText>

      {timeLogs.loading ? (
        <p className="cq-muted">Loading time logs…</p>
      ) : timeLogs.items.length === 0 ? (
        <EmptyState title="No time logged yet">
          Assigned crews log time from their own workspace; it appears here as soon as they do.
        </EmptyState>
      ) : (
        <Table label="Time logs" compact>
          <thead>
            <tr>
              <th scope="col" className="cq-numeric">Work date</th>
              <th scope="col">Subcontractor</th>
              <th scope="col">Shift</th>
              <th scope="col" className="cq-numeric">Hours</th>
              <th scope="col" className="cq-numeric">Cost to you</th>
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
                    <div className="cq-table__note">{l.rejectReason}</div>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </Section>
  );
}

// ── Expenses ───────────────────────────────────────────────────────────────────

function ExpensePanel({
  expenses,
  assignments,
  currency,
}: {
  expenses: ReturnType<typeof useAsyncList<ExpenseView>>;
  assignments: AssignmentView[];
  currency: string;
}) {
  const providerName = (companyId: string) =>
    assignments.find((a) => a.providerCompanyId === companyId)?.providerCompanyName ?? 'Unknown';

  return (
    <Section
      title="Expenses"
      description="Costs a subcontractor passed through, at the amount they entered."
      className="cq-section--table"
    >
      <ErrorText>{expenses.error}</ErrorText>
      {expenses.loading ? (
        <p className="cq-muted">Loading expenses…</p>
      ) : expenses.items.length === 0 ? (
        <EmptyState title="No expenses on this project">
          Expenses a subcontractor raises against this project appear here once they submit them.
        </EmptyState>
      ) : (
        <Table label="Expenses" compact>
          <thead>
            <tr>
              {/* "Raised" not "Date": this is when the expense was entered, which is not
                  the work date a time log carries. One column heading cannot honestly
                  cover both, so the two tables name their own. */}
              <th scope="col" className="cq-numeric">Raised</th>
              <th scope="col">Subcontractor</th>
              <th scope="col">Category</th>
              <th scope="col">Description</th>
              <th scope="col" className="cq-numeric">Amount</th>
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
                  {x.rejectReason ? <div className="cq-table__note">{x.rejectReason}</div> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </Section>
  );
}

// ── Edit / delete ──────────────────────────────────────────────────────────────

/**
 * Every zone the runtime knows, or nothing on a browser without
 * `supportedValuesOf`. Deliberately not a curated list — the same reasoning as
 * the company settings screen, and the server validates against Postgres's own
 * `pg_timezone_names` regardless.
 */
function timeZoneOptions(): string[] {
  const intl = Intl as typeof Intl & { supportedValuesOf?: (key: string) => string[] };
  try {
    return intl.supportedValuesOf?.('timeZone') ?? [];
  } catch {
    return [];
  }
}

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
  const [reportingCurrency, setReportingCurrency] = useState(project.reportingCurrency);
  // Empty means "inherit the company", which is what `null` means on the wire.
  const [timeZone, setTimeZone] = useState(project.timeZone ?? '');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const nextZone = timeZone.trim() === '' ? null : timeZone.trim();
  const dirty =
    name.trim() !== project.name ||
    status !== project.status ||
    (startsOn || null) !== project.startsOn ||
    (endsOn || null) !== project.endsOn ||
    (notes.trim() || null) !== project.notes ||
    clientVisible !== project.clientVisible ||
    reportingCurrency.toUpperCase() !== project.reportingCurrency ||
    nextZone !== project.timeZone;

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
        ...(reportingCurrency.toUpperCase() !== project.reportingCurrency
          ? { reportingCurrency: reportingCurrency.toUpperCase() }
          : {}),
        ...(nextZone !== project.timeZone ? { timeZone: nextZone } : {}),
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

        <div className="cq-form-grid">
          <Field
            label="Reporting currency"
            hint="The unit every cost, bill and margin figure on this project is shown in. Owner or admin only, and fixed once the project holds approved work or a live invoice."
          >
            <Input
              value={reportingCurrency}
              onChange={(e) => setReportingCurrency(e.target.value.toUpperCase().slice(0, 3))}
              maxLength={3}
              required
            />
          </Field>
          <Field
            label="Time zone"
            hint={`Which day work on this project counts against. Leave blank to follow the company (${project.effectiveTimeZone}). Owner or admin only, and fixed once the project holds approved work.`}
          >
            <Input
              name="project-time-zone"
              list="cq-project-time-zones"
              value={timeZone}
              onChange={(e) => setTimeZone(e.target.value)}
              placeholder={`Inherits ${project.effectiveTimeZone}`}
            />
          </Field>
        </div>

        {/*
          * The browser's own IANA list rather than a bundled one, for the same
          * reason the company settings screen uses it: a hard-coded list goes
          * stale whenever a country changes its rules, and the server validates
          * against Postgres's list regardless.
          */}
        <datalist id="cq-project-time-zones">
          {timeZoneOptions().map((zone) => (
            <option key={zone} value={zone} />
          ))}
        </datalist>

        {nextZone !== project.timeZone ? (
          <Notice>
            {nextZone
              ? <>Work on this project will count against days in <strong>{nextZone}</strong> from
                now on. <strong>Nothing already recorded moves</strong> — every work date stays
                exactly as it was asserted.</>
              : <>This project will follow the company zone again. Nothing already recorded
                moves.</>}
          </Notice>
        ) : null}

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
