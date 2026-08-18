'use client';

import { useMemo, useState } from 'react';
import {
  SHIFT_TYPES,
  type ExpenseView,
  type PendingAssignmentView,
  type ShiftType,
  type TimeLogView,
  type WorkContext,
} from '@crewquo/shared';
import {
  Badge,
  Button,
  Drawer,
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
import { useAsyncData } from '@/lib/useAsyncData';
import { useAsyncList } from '@/lib/useAsyncList';
import { WorkStatusBadge } from '@/components/Status';
import { formatCents, formatDate, inputToCents, titleCase, todayIso, totalHours } from '@/lib/format';

/**
 * Log work — the provider side of an engagement, on the web.
 *
 * The counterpart of the mobile log-time screen, reading the same
 * `/v1/work-context` (the assignments this company can log against, each with the
 * *client's* role catalog, because rates resolve against the client's roles).
 *
 * The workflow invariant is the whole shape of this screen (§3.4): a provider may
 * create and edit only while DRAFT or REJECTED, and the only transition they drive is
 * DRAFT to SUBMITTED. So drafts and rejections are editable here, and anything
 * submitted or approved is read-only — not disabled-looking, just stated.
 *
 * The rate is *not* previewed before submit. It is resolved and frozen server-side at
 * submit time from the client's PAY card, and showing a guess beforehand would invite
 * an argument with the number that actually gets stored.
 */
export default function WorkPage() {
  return (
    <Shell>
      <Work />
    </Shell>
  );
}

function Work() {
  const ctx = useSessionCtx();
  const { activeMembership, companyId } = useAuth();
  const currency = activeMembership?.currency ?? 'USD';

  const context = useAsyncData<WorkContext>(
    ctx ? () => api.workContext(ctx.accessToken, ctx.companyId) : null,
    [ctx?.companyId]
  );
  const timeLogs = useAsyncList<TimeLogView>(
    ctx ? () => api.listTimeLogs(ctx.accessToken, ctx.companyId).then((r) => r.data) : null,
    [ctx?.companyId]
  );
  const expenses = useAsyncList<ExpenseView>(
    ctx ? () => api.listExpenses(ctx.accessToken, ctx.companyId).then((r) => r.data) : null,
    [ctx?.companyId]
  );

  /**
   * Assignments this company has been offered and not answered (Phase 6 acceptance
   * rules). This screen rather than `/projects`, because the project belongs to the
   * hiring company: `GET /v1/projects` is scoped to `owner_company_id`, so a
   * provider cannot see it there at all. `/work` is the provider's own surface.
   */
  const pendingAssignments = useAsyncList<PendingAssignmentView>(
    ctx
      ? () => api.listPendingAssignments(ctx.accessToken, ctx.companyId).then((r) => r.data)
      : null,
    [ctx?.companyId]
  );

  // Only work *this* company delivers. The endpoints also return the rows we are the
  // client on — those belong on the Approvals screen, not here.
  const mine = useMemo(
    () => timeLogs.items.filter((l) => l.providerCompanyId === companyId),
    [timeLogs.items, companyId]
  );
  const myExpenses = useMemo(
    () => expenses.items.filter((x) => x.providerCompanyId === companyId),
    [expenses.items, companyId]
  );

  const assignments = context.data?.assignments ?? [];
  const openItems = mine.filter((l) => l.status === 'DRAFT' || l.status === 'REJECTED');
  const openExpenses = myExpenses.filter((x) => x.status === 'DRAFT' || x.status === 'REJECTED');

  // Entry happens in side panels (§40). This is the screen a crew opens daily to see
  // what is still theirs to fix; two stacked entry forms pushed that list off the
  // bottom of the page, so the work you have to act on came second to the form.
  const [entry, setEntry] = useState<'time' | 'expense' | null>(null);

  return (
    <Stack>
      <PageHeader
        eyebrow="Workspace"
        title="Log work"
        description="Time and expenses on the projects you have been assigned to. Submit them for approval when they are ready."
        actions={
          assignments.length > 0 ? (
            <>
              <Button onClick={() => setEntry('time')}>Log time</Button>
              <Button variant="secondary" onClick={() => setEntry('expense')}>Add expense</Button>
            </>
          ) : null
        }
      />

      {pendingAssignments.items.length > 0 ? (
        <PendingAssignments
          items={pendingAssignments.items}
          onChanged={() => {
            pendingAssignments.reload();
            context.reload();
          }}
        />
      ) : null}

      {context.loading ? (
        <p className="cq-muted">Loading your assignments…</p>
      ) : assignments.length === 0 ? (
        <EmptyState title="No projects assigned to you">
          A client assigns your company to one of their projects, and it appears here. If you
          are expecting work, ask them to assign you — or check that your invitation has been
          accepted under Network.
        </EmptyState>
      ) : (
        <>
          <NewTimeLog
            open={entry === 'time'}
            onClose={() => setEntry(null)}
            context={context.data!}
            onCreated={() => {
              timeLogs.reload();
            }}
          />

          <NewExpense
            open={entry === 'expense'}
            onClose={() => setEntry(null)}
            context={context.data!}
            currency={currency}
            onCreated={() => {
              expenses.reload();
            }}
          />

          <OpenWork
            logs={openItems}
            expenses={openExpenses}
            context={context.data!}
            currency={currency}
            onChanged={() => {
              timeLogs.reload();
              expenses.reload();
            }}
          />

          <SubmittedWork logs={mine} expenses={myExpenses} currency={currency} />
        </>
      )}

      <ErrorText>{context.error ?? timeLogs.error ?? expenses.error}</ErrorText>
    </Stack>
  );
}


// ── Assignments offered to this company ────────────────────────────────────────

/**
 * Accepting or declining a project assignment.
 *
 * Deliberately **not** a gate on logging work: an unaccepted assignment still
 * accepts time, because blocking it would stop a crew recording hours they had
 * already worked, hours after a decision made by a different company. So this is an
 * acknowledgement surface, placed first because an unanswered offer outranks a
 * timesheet — not a blocker the crew has to clear before they can work.
 */
function PendingAssignments({
  items,
  onChanged,
}: {
  items: PendingAssignmentView[];
  onChanged: () => void;
}) {
  const ctx = useSessionCtx();
  const { activeMembership } = useAuth();
  const canManage =
    activeMembership?.role === 'OWNER' ||
    activeMembership?.role === 'ADMIN' ||
    activeMembership?.role === 'MANAGER';
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function decide(id: string, accept: boolean, projectName: string) {
    if (!ctx) return;
    let reason: string | null = null;
    if (!accept) {
      const entered = window.prompt(`Decline "${projectName}"? Your reason is recorded.`);
      if (entered === null) return;
      reason = entered.trim() === '' ? null : entered.trim();
    }
    setBusyId(id);
    setError(null);
    try {
      if (accept) await api.acceptAssignment(ctx.accessToken, ctx.companyId, id);
      else await api.declineAssignment(ctx.accessToken, ctx.companyId, id, reason);
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not record your decision');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <Section
      title="Projects you have been added to"
      description="Confirm you are taking these on. You can still log time either way — this tells the client where they stand."
      className="cq-section--table"
    >
      <ErrorText>{error}</ErrorText>
      <Table label="Assignments awaiting your decision" compact>
        <thead>
          <tr>
            <th scope="col">Project</th>
            <th scope="col">
              <span className="cq-table__actions">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {items.map((a) => (
            <tr key={a.id}>
              <td className="cq-table__primary">{a.projectName}</td>
              <td className="cq-table__actions">
                {!canManage ? (
                  <span className="cq-muted">Manager role required</span>
                ) : (
                  <Row>
                    <Button
                      size="sm"
                      disabled={busyId === a.id}
                      onClick={() => void decide(a.id, true, a.projectName)}
                    >
                      Accept
                    </Button>
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={busyId === a.id}
                      onClick={() => void decide(a.id, false, a.projectName)}
                    >
                      Decline
                    </Button>
                  </Row>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </Table>
    </Section>
  );
}

// ── New time log ───────────────────────────────────────────────────────────────

function NewTimeLog({
  open,
  onClose,
  context,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  context: WorkContext;
  onCreated: () => void;
}) {
  const ctx = useSessionCtx();
  const [projectId, setProjectId] = useState(context.assignments[0]?.projectId ?? '');
  const [roleId, setRoleId] = useState('');
  const [shiftType, setShiftType] = useState<ShiftType>('WEEKDAY_DAY');
  const [workDate, setWorkDate] = useState(todayIso());
  const [hoursRegular, setHoursRegular] = useState('8');
  const [hoursOt, setHoursOt] = useState('0');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const assignment = context.assignments.find((a) => a.projectId === projectId) ?? null;
  const roles = assignment?.roles ?? [];
  // The chosen role must belong to the selected project's client, so reset it when the
  // project changes rather than sending a role the API will reject.
  const effectiveRoleId = roles.some((r) => r.id === roleId) ? roleId : (roles[0]?.id ?? '');

  const unitBased = shiftType === 'SHIFT' || shiftType === 'DAILY';

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!ctx || !effectiveRoleId) return;
    setBusy(true);
    setError(null);
    setSaved(null);
    try {
      await api.createTimeLog(ctx.accessToken, ctx.companyId, {
        projectId,
        roleId: effectiveRoleId,
        shiftType,
        workDate,
        hoursRegular: Number(hoursRegular) || 0,
        hoursOt: unitBased ? 0 : Number(hoursOt) || 0,
      });
      setSaved(workDate);
      onCreated();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save the time log');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Drawer
      open={open}
      title="Log time"
      description="Saved as a draft. Nothing reaches the client until you submit it."
      onClose={onClose}
      footer={
        <>
          <Button type="submit" form="log-time" disabled={busy || !effectiveRoleId}>
            {busy ? 'Saving…' : 'Save draft'}
          </Button>
          <Button variant="secondary" onClick={onClose}>Done</Button>
          {saved ? <Badge tone="success">Draft saved for {formatDate(saved)}</Badge> : null}
        </>
      }
    >
      <form id="log-time" onSubmit={submit} className="cq-stack" aria-busy={busy}>
        <div className="cq-form-grid cq-form-grid--drawer">
          <Field label="Project">
            <Select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
              {context.assignments.map((a) => (
                <option key={a.projectId} value={a.projectId}>
                  {a.projectName} · {a.clientCompanyName}
                </option>
              ))}
            </Select>
          </Field>
          <Field
            label="Role"
            hint={roles.length === 0 ? 'The client has no roles set up — ask them to add one.' : undefined}
          >
            <Select
              value={effectiveRoleId}
              onChange={(e) => setRoleId(e.target.value)}
              disabled={roles.length === 0}
            >
              {roles.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Shift type">
            <Select value={shiftType} onChange={(e) => setShiftType(e.target.value as ShiftType)}>
              {SHIFT_TYPES.map((s) => (
                <option key={s} value={s}>
                  {titleCase(s)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Work date">
            <Input
              type="date"
              value={workDate}
              onChange={(e) => setWorkDate(e.target.value)}
              required
            />
          </Field>
          <Field label={unitBased ? 'Units' : 'Regular hours'}>
            <Input
              type="number"
              min="0"
              max="24"
              step="0.25"
              value={hoursRegular}
              onChange={(e) => setHoursRegular(e.target.value)}
              required
            />
          </Field>
          {!unitBased ? (
            <Field label="Overtime hours">
              <Input
                type="number"
                min="0"
                max="24"
                step="0.25"
                value={hoursOt}
                onChange={(e) => setHoursOt(e.target.value)}
              />
            </Field>
          ) : null}
        </div>

        {unitBased ? (
          <p className="cq-muted">
            {titleCase(shiftType)} rates are priced per unit, not per hour, so overtime does not
            apply — enter the number of {shiftType === 'SHIFT' ? 'shifts' : 'days'} worked.
          </p>
        ) : null}

        <ErrorText>{error}</ErrorText>
      </form>
    </Drawer>
  );
}

// ── New expense ────────────────────────────────────────────────────────────────

function NewExpense({
  open,
  onClose,
  context,
  currency,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  context: WorkContext;
  currency: string;
  onCreated: () => void;
}) {
  const ctx = useSessionCtx();
  const [projectId, setProjectId] = useState(context.assignments[0]?.projectId ?? '');
  const [amount, setAmount] = useState('');
  const [category, setCategory] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cents = inputToCents(amount);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!ctx || cents === null) return;
    setBusy(true);
    setError(null);
    try {
      await api.createExpense(ctx.accessToken, ctx.companyId, {
        projectId,
        amountCents: cents,
        category: category.trim() || null,
        description: description.trim() || null,
      });
      setAmount('');
      setCategory('');
      setDescription('');
      onClose();
      onCreated();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save the expense');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Drawer
      open={open}
      title="Add expense"
      description="Also saved as a draft, and submitted the same way."
      onClose={onClose}
      footer={
        <>
          <Button type="submit" form="log-expense" disabled={busy || cents === null}>
            {busy ? 'Saving…' : 'Save draft'}
          </Button>
          <Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
        </>
      }
    >
        <form id="log-expense" onSubmit={submit} className="cq-stack" aria-busy={busy}>
          <div className="cq-form-grid cq-form-grid--drawer">
            <Field label="Project">
              <Select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
                {context.assignments.map((a) => (
                  <option key={a.projectId} value={a.projectId}>
                    {a.projectName} · {a.clientCompanyName}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={`Amount (${currency})`}>
              <Input
                type="number"
                min="0"
                step="0.01"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                required
                autoFocus
              />
            </Field>
            <Field label="Category" hint="Optional, e.g. Travel, Parking, Materials.">
              <Input value={category} onChange={(e) => setCategory(e.target.value)} maxLength={80} />
            </Field>
          </div>
          <Field label="Description">
            <Input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={500}
            />
          </Field>
          <Notice>
            Attaching a receipt is not available yet — file storage arrives with Phase 7. Keep
            the paper copy until then.
          </Notice>
          <ErrorText>{error}</ErrorText>
        </form>
    </Drawer>
  );
}

// ── Drafts & rejections ────────────────────────────────────────────────────────

function OpenWork({
  logs,
  expenses,
  context,
  currency,
  onChanged,
}: {
  logs: TimeLogView[];
  expenses: ExpenseView[];
  context: WorkContext;
  currency: string;
  onChanged: () => void;
}) {
  const ctx = useSessionCtx();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);

  const projectName = (id: string) =>
    context.assignments.find((a) => a.projectId === id)?.projectName ?? 'Unknown project';

  async function act(id: string, fn: () => Promise<unknown>) {
    setBusyId(id);
    setError(null);
    try {
      await fn();
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'That did not work');
    } finally {
      setBusyId(null);
    }
  }

  /** Submit every draft at once — the common end-of-week action. */
  async function submitAll() {
    if (!ctx) return;
    setBulkBusy(true);
    setError(null);
    const targets = [
      ...logs.map((l) => ({ kind: 'time' as const, id: l.id })),
      ...expenses.map((x) => ({ kind: 'expense' as const, id: x.id })),
    ];
    const failures: string[] = [];
    for (const t of targets) {
      try {
        if (t.kind === 'time') await api.submitTimeLog(ctx.accessToken, ctx.companyId, t.id);
        else await api.submitExpense(ctx.accessToken, ctx.companyId, t.id);
      } catch (err) {
        failures.push(err instanceof ApiError ? err.message : 'Request failed');
      }
    }
    if (failures.length > 0) {
      setError(
        `${targets.length - failures.length} submitted, ${failures.length} failed: ${failures[0]}`
      );
    }
    setBulkBusy(false);
    onChanged();
  }

  const total = logs.length + expenses.length;

  return (
    <Section
      title="Not yet submitted"
      description="Drafts and anything sent back to you. These are the only items you can still change."
      className="cq-section--table"
      actions={
        total > 0 ? (
          <Button size="sm" disabled={bulkBusy} onClick={() => void submitAll()}>
            {bulkBusy ? 'Submitting…' : `Submit all ${total}`}
          </Button>
        ) : null
      }
    >
      <ErrorText>{error}</ErrorText>
      {total === 0 ? (
        <EmptyState title="Nothing waiting on you">
          Everything you have logged is submitted. Add time or an expense above to start
          another entry.
        </EmptyState>
      ) : (
        <Table label="Drafts and returned work">
          <thead>
            <tr>
              <th scope="col">Item</th>
              <th scope="col">Project</th>
              <th scope="col">Detail</th>
              <th scope="col">Status</th>
              <th scope="col">
                <span className="cq-table__actions">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {logs.map((l) => (
              <tr key={l.id}>
                <td className="cq-table__primary cq-numeric">{formatDate(l.workDate)}</td>
                <td>{projectName(l.projectId)}</td>
                <td>
                  {titleCase(l.shiftType)} · {totalHours(l)}h
                  {l.hoursOt > 0 ? ` (${l.hoursOt} OT)` : ''}
                </td>
                <td>
                  <WorkStatusBadge status={l.status} />
                  {l.rejectReason ? (
                    <div className="cq-table__note">Returned: {l.rejectReason}</div>
                  ) : null}
                </td>
                <td className="cq-table__actions">
                  <Row>
                    <Button
                      size="sm"
                      disabled={busyId === l.id || bulkBusy}
                      onClick={() =>
                        void act(l.id, () =>
                          api.submitTimeLog(ctx!.accessToken, ctx!.companyId, l.id)
                        )
                      }
                    >
                      Submit
                    </Button>
                    <Button
                      size="sm"
                      variant="danger"
                      disabled={busyId === l.id || bulkBusy}
                      onClick={() => {
                        if (window.confirm(`Delete the time log for ${formatDate(l.workDate)}?`)) {
                          void act(l.id, () =>
                            api.deleteTimeLog(ctx!.accessToken, ctx!.companyId, l.id)
                          );
                        }
                      }}
                    >
                      Delete
                    </Button>
                  </Row>
                </td>
              </tr>
            ))}
            {expenses.map((x) => (
              <tr key={x.id}>
                <td className="cq-table__primary cq-numeric">
                  {formatCents(x.amountCents, currency)}
                </td>
                <td>{projectName(x.projectId)}</td>
                <td>
                  {x.category ? `${x.category} · ` : ''}
                  {x.description ?? <span className="cq-muted">Expense</span>}
                </td>
                <td>
                  <WorkStatusBadge status={x.status} />
                  {x.rejectReason ? (
                    <div className="cq-table__note">Returned: {x.rejectReason}</div>
                  ) : null}
                </td>
                <td className="cq-table__actions">
                  <Row>
                    <Button
                      size="sm"
                      disabled={busyId === x.id || bulkBusy}
                      onClick={() =>
                        void act(x.id, () =>
                          api.submitExpense(ctx!.accessToken, ctx!.companyId, x.id)
                        )
                      }
                    >
                      Submit
                    </Button>
                    <Button
                      size="sm"
                      variant="danger"
                      disabled={busyId === x.id || bulkBusy}
                      onClick={() => {
                        if (window.confirm('Delete this expense?')) {
                          void act(x.id, () =>
                            api.deleteExpense(ctx!.accessToken, ctx!.companyId, x.id)
                          );
                        }
                      }}
                    >
                      Delete
                    </Button>
                  </Row>
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </Section>
  );
}

// ── Submitted history ──────────────────────────────────────────────────────────

function SubmittedWork({
  logs,
  expenses,
  currency,
}: {
  logs: TimeLogView[];
  expenses: ExpenseView[];
  currency: string;
}) {
  const submitted = logs.filter((l) => l.status === 'SUBMITTED' || l.status === 'APPROVED');
  const submittedExpenses = expenses.filter(
    (x) => x.status === 'SUBMITTED' || x.status === 'APPROVED'
  );

  const awaiting = submitted.filter((l) => l.status === 'SUBMITTED').length;

  return (
    <Section
      title="Submitted"
      description="Handed up for approval. These are read-only — the workflow only lets the client side change them from here."
      className="cq-section--table"
      actions={awaiting > 0 ? <Badge tone="accent">{awaiting} awaiting a decision</Badge> : null}
    >
      {submitted.length === 0 && submittedExpenses.length === 0 ? (
        <EmptyState title="Nothing submitted yet">
          Submitted work appears here with what you will be paid for it, once a rate has been
          resolved.
        </EmptyState>
      ) : (
        <Table label="Submitted work">
          <thead>
            <tr>
              <th scope="col">Item</th>
              <th scope="col">Detail</th>
              <th scope="col">You are paid</th>
              <th scope="col">Status</th>
            </tr>
          </thead>
          <tbody>
            {submitted.map((l) => (
              <tr key={l.id}>
                <td className="cq-table__primary cq-numeric">{formatDate(l.workDate)}</td>
                <td>
                  {titleCase(l.shiftType)} · {totalHours(l)}h
                </td>
                <td className="cq-numeric">
                  {l.resolvedRate ? (
                    formatCents(l.resolvedRate.costCents, currency)
                  ) : (
                    <span className="cq-muted">No rate resolved</span>
                  )}
                </td>
                <td>
                  <WorkStatusBadge status={l.status} />
                </td>
              </tr>
            ))}
            {submittedExpenses.map((x) => (
              <tr key={x.id}>
                <td className="cq-table__primary cq-numeric">
                  {formatCents(x.amountCents, currency)}
                </td>
                <td>{x.description ?? x.category ?? 'Expense'}</td>
                <td className="cq-numeric">{formatCents(x.amountCents, currency)}</td>
                <td>
                  <WorkStatusBadge status={x.status} />
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </Section>
  );
}
