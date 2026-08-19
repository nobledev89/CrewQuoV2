import type {
  ExpenseView,
  ResolvedRateSnapshot,
  ShiftType,
  SubmissionView,
  TimeLogView,
  WorkStatus,
} from '@crewquo/shared';
import { effectiveTimeZone } from '@crewquo/shared';
import { query, queryOne, type Queryable } from '../../db';

/**
 * Work-capture persistence (CREWQUO_V2_PLAN.md §3.4): time logs, expenses and
 * submissions. The workflow invariant (provider edits DRAFT/REJECTED, drives only
 * DRAFT→SUBMITTED; client approves/rejects) is enforced in routes via policies.ts.
 */

// ── Provider work context ────────────────────────────────────────────────────────

/**
 * Projects the provider is assigned to (active on the engagement), each with the
 * client's role catalog — everything the mobile log-time screen needs in one call.
 */
export async function listProviderWorkContext(providerCompanyId: string) {
  const assignments = await query<{
    project_id: string;
    project_name: string;
    client_company_id: string;
    client_company_name: string;
    engagement_id: string;
    project_time_zone: string | null;
    owner_time_zone: string;
  }>(
    `select a.project_id, p.name as project_name,
            e.client_company_id, cc.name as client_company_name, a.engagement_id,
            p.time_zone as project_time_zone, oc.time_zone as owner_time_zone
       from project_assignments a
       join projects p on p.id = a.project_id
       join companies oc on oc.id = p.owner_company_id
       join engagements e on e.id = a.engagement_id
       join companies cc on cc.id = e.client_company_id
      where a.provider_company_id = $1 and e.status = 'ACTIVE'
        and p.status in ('PLANNED','ACTIVE')
      order by p.name asc`,
    [providerCompanyId]
  );

  const clientIds = [...new Set(assignments.map((a) => a.client_company_id))];
  const rolesByClient = new Map<string, { id: string; name: string }[]>();
  if (clientIds.length > 0) {
    const roles = await query<{ company_id: string; id: string; name: string }>(
      `select company_id, id, name from role_catalog where company_id = any($1) order by name asc`,
      [clientIds]
    );
    for (const r of roles) {
      const list = rolesByClient.get(r.company_id) ?? [];
      list.push({ id: r.id, name: r.name });
      rolesByClient.set(r.company_id, list);
    }
  }

  return assignments.map((a) => ({
    projectId: a.project_id,
    projectName: a.project_name,
    clientCompanyId: a.client_company_id,
    clientCompanyName: a.client_company_name,
    engagementId: a.engagement_id,
    // The *owner* company's zone is the fallback, not the provider's: the
    // project's days belong to whoever runs the project, the same "resolve on the
    // hiring side" rule the commercial module already follows. A Manila crew on a
    // Dubai project asserts a Dubai day.
    timeZone: effectiveTimeZone(a.project_time_zone, a.owner_time_zone),
    roles: rolesByClient.get(a.client_company_id) ?? [],
  }));
}

// ── Time logs ─────────────────────────────────────────────────────────────────

interface TimeLogRow {
  id: string;
  engagement_id: string;
  project_id: string;
  provider_company_id: string;
  logged_by_user_id: string;
  role_id: string;
  shift_type: ShiftType;
  work_date: string;
  hours_regular: string;
  hours_ot: string;
  status: WorkStatus;
  resolved_rate: ResolvedRateSnapshot | null;
  reject_reason: string | null;
  created_at: Date;
  updated_at: Date;
}

function toTimeLogView(r: TimeLogRow): TimeLogView {
  return {
    id: r.id,
    engagementId: r.engagement_id,
    projectId: r.project_id,
    providerCompanyId: r.provider_company_id,
    loggedByUserId: r.logged_by_user_id,
    roleId: r.role_id,
    shiftType: r.shift_type,
    workDate: r.work_date,
    hoursRegular: Number(r.hours_regular),
    hoursOt: Number(r.hours_ot),
    status: r.status,
    resolvedRate: r.resolved_rate,
    rejectReason: r.reject_reason,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
}

const TIME_LOG_SELECT = `
  select id, engagement_id, project_id, provider_company_id, logged_by_user_id, role_id,
         shift_type, to_char(work_date, 'YYYY-MM-DD') as work_date, hours_regular, hours_ot,
         status, resolved_rate, reject_reason, created_at, updated_at
    from time_logs`;

export async function getTimeLog(id: string): Promise<TimeLogView | null> {
  const row = await queryOne<TimeLogRow>(`${TIME_LOG_SELECT} where id = $1`, [id]);
  return row ? toTimeLogView(row) : null;
}

/** Time logs on an engagement, optionally filtered by status (approvals inbox). */
export async function listTimeLogs(filter: {
  engagementId?: string;
  projectId?: string;
  status?: WorkStatus;
}): Promise<TimeLogView[]> {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (filter.engagementId) {
    params.push(filter.engagementId);
    clauses.push(`engagement_id = $${params.length}`);
  }
  if (filter.projectId) {
    params.push(filter.projectId);
    clauses.push(`project_id = $${params.length}`);
  }
  if (filter.status) {
    params.push(filter.status);
    clauses.push(`status = $${params.length}`);
  }
  const where = clauses.length ? `where ${clauses.join(' and ')}` : '';
  const rows = await query<TimeLogRow>(
    `${TIME_LOG_SELECT} ${where} order by work_date desc, created_at desc`,
    params
  );
  return rows.map(toTimeLogView);
}

export async function insertTimeLog(input: {
  engagementId: string;
  projectId: string;
  providerCompanyId: string;
  loggedByUserId: string;
  roleId: string;
  shiftType: ShiftType;
  workDate: string;
  hoursRegular: number;
  hoursOt: number;
}): Promise<TimeLogView> {
  const row = await queryOne<TimeLogRow>(
    `insert into time_logs (engagement_id, project_id, provider_company_id, logged_by_user_id,
                            role_id, shift_type, work_date, hours_regular, hours_ot)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     returning ${timeLogReturning()}`,
    [
      input.engagementId,
      input.projectId,
      input.providerCompanyId,
      input.loggedByUserId,
      input.roleId,
      input.shiftType,
      input.workDate,
      input.hoursRegular,
      input.hoursOt,
    ]
  );
  return toTimeLogView(row!);
}

export async function updateTimeLogFields(
  id: string,
  patch: {
    roleId?: string;
    shiftType?: ShiftType;
    workDate?: string;
    hoursRegular?: number;
    hoursOt?: number;
  }
): Promise<TimeLogView> {
  const row = await queryOne<TimeLogRow>(
    `update time_logs set
       role_id = coalesce($2, role_id),
       shift_type = coalesce($3, shift_type),
       work_date = coalesce($4::date, work_date),
       hours_regular = coalesce($5, hours_regular),
       hours_ot = coalesce($6, hours_ot),
       updated_at = now()
     where id = $1 returning ${timeLogReturning()}`,
    [
      id,
      patch.roleId ?? null,
      patch.shiftType ?? null,
      patch.workDate ?? null,
      patch.hoursRegular ?? null,
      patch.hoursOt ?? null,
    ]
  );
  return toTimeLogView(row!);
}

/** Submit: DRAFT → SUBMITTED, freezing the resolved rate snapshot. */
export async function submitTimeLog(
  id: string,
  snapshot: ResolvedRateSnapshot | null,
  runner?: Queryable
): Promise<TimeLogView> {
  const row = await queryOne<TimeLogRow>(
    `update time_logs set status = 'SUBMITTED', resolved_rate = $2::jsonb, reject_reason = null,
       updated_at = now()
     where id = $1 returning ${timeLogReturning()}`,
    [id, snapshot ? JSON.stringify(snapshot) : null],
    runner
  );
  return toTimeLogView(row!);
}

/** Review: SUBMITTED → APPROVED / REJECTED. */
export async function reviewTimeLog(
  id: string,
  decision: 'APPROVED' | 'REJECTED',
  reviewerUserId: string,
  rejectReason: string | null,
  runner?: Queryable
): Promise<TimeLogView> {
  const row = await queryOne<TimeLogRow>(
    `update time_logs set status = $2, reviewed_by_user_id = $3, reviewed_at = now(),
       reject_reason = $4, updated_at = now()
     where id = $1 returning ${timeLogReturning()}`,
    [id, decision, reviewerUserId, rejectReason],
    runner
  );
  return toTimeLogView(row!);
}

export async function deleteTimeLog(id: string): Promise<void> {
  await query(`delete from time_logs where id = $1`, [id]);
}

function timeLogReturning(): string {
  return `id, engagement_id, project_id, provider_company_id, logged_by_user_id, role_id,
    shift_type, to_char(work_date, 'YYYY-MM-DD') as work_date, hours_regular, hours_ot,
    status, resolved_rate, reject_reason, created_at, updated_at`;
}

// ── Expenses ────────────────────────────────────────────────────────────────────

interface ExpenseRow {
  id: string;
  engagement_id: string;
  project_id: string;
  provider_company_id: string;
  logged_by_user_id: string;
  amount_cents: number;
  category: string | null;
  description: string | null;
  receipt_url: string | null;
  status: WorkStatus;
  reject_reason: string | null;
  created_at: Date;
  updated_at: Date;
}

function toExpenseView(r: ExpenseRow): ExpenseView {
  return {
    id: r.id,
    engagementId: r.engagement_id,
    projectId: r.project_id,
    providerCompanyId: r.provider_company_id,
    loggedByUserId: r.logged_by_user_id,
    amountCents: r.amount_cents,
    category: r.category,
    description: r.description,
    receiptUrl: r.receipt_url,
    status: r.status,
    rejectReason: r.reject_reason,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
}

const EXPENSE_COLS = `id, engagement_id, project_id, provider_company_id, logged_by_user_id,
  amount_cents, category, description, receipt_url, status, reject_reason, created_at, updated_at`;

export async function getExpense(id: string): Promise<ExpenseView | null> {
  const row = await queryOne<ExpenseRow>(`select ${EXPENSE_COLS} from expenses where id = $1`, [id]);
  return row ? toExpenseView(row) : null;
}

export async function listExpenses(filter: {
  engagementId?: string;
  projectId?: string;
  status?: WorkStatus;
}): Promise<ExpenseView[]> {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (filter.engagementId) {
    params.push(filter.engagementId);
    clauses.push(`engagement_id = $${params.length}`);
  }
  if (filter.projectId) {
    params.push(filter.projectId);
    clauses.push(`project_id = $${params.length}`);
  }
  if (filter.status) {
    params.push(filter.status);
    clauses.push(`status = $${params.length}`);
  }
  const where = clauses.length ? `where ${clauses.join(' and ')}` : '';
  const rows = await query<ExpenseRow>(
    `select ${EXPENSE_COLS} from expenses ${where} order by created_at desc`,
    params
  );
  return rows.map(toExpenseView);
}

export async function insertExpense(input: {
  engagementId: string;
  projectId: string;
  providerCompanyId: string;
  loggedByUserId: string;
  amountCents: number;
  category: string | null;
  description: string | null;
}): Promise<ExpenseView> {
  const row = await queryOne<ExpenseRow>(
    `insert into expenses (engagement_id, project_id, provider_company_id, logged_by_user_id,
                           amount_cents, category, description)
     values ($1,$2,$3,$4,$5,$6,$7) returning ${EXPENSE_COLS}`,
    [
      input.engagementId,
      input.projectId,
      input.providerCompanyId,
      input.loggedByUserId,
      input.amountCents,
      input.category,
      input.description,
    ]
  );
  return toExpenseView(row!);
}

export async function updateExpenseFields(
  id: string,
  patch: { amountCents?: number; category?: string | null; description?: string | null }
): Promise<ExpenseView> {
  const row = await queryOne<ExpenseRow>(
    `update expenses set
       amount_cents = coalesce($2, amount_cents),
       category = case when $3::boolean then $4 else category end,
       description = case when $5::boolean then $6 else description end,
       updated_at = now()
     where id = $1 returning ${EXPENSE_COLS}`,
    [
      id,
      patch.amountCents ?? null,
      'category' in patch,
      patch.category ?? null,
      'description' in patch,
      patch.description ?? null,
    ]
  );
  return toExpenseView(row!);
}

export async function transitionExpense(
  id: string,
  status: WorkStatus,
  review?: { reviewerUserId: string; rejectReason: string | null },
  runner?: Queryable
): Promise<ExpenseView> {
  // `$3` is cast explicitly: it appears only inside `case when $3 is null`, where
  // Postgres has no column to infer a type from and fails to parse the statement
  // outright ("could not determine data type of parameter $3"). Without the cast
  // every expense transition 500s — submit, approve and reject alike.
  const row = await queryOne<ExpenseRow>(
    `update expenses set status = $2,
       reviewed_by_user_id = $3::uuid,
       reviewed_at = case when $3::uuid is null then reviewed_at else now() end,
       reject_reason = $4, updated_at = now()
     where id = $1 returning ${EXPENSE_COLS}`,
    [id, status, review?.reviewerUserId ?? null, review?.rejectReason ?? null],
    runner
  );
  return toExpenseView(row!);
}

export async function deleteExpense(id: string): Promise<void> {
  await query(`delete from expenses where id = $1`, [id]);
}

// ── Submissions ───────────────────────────────────────────────────────────────

interface SubmissionRow {
  id: string;
  engagement_id: string;
  project_id: string;
  provider_company_id: string;
  period_start: string | null;
  period_end: string | null;
  status: WorkStatus;
  reject_reason: string | null;
  created_at: Date;
  updated_at: Date;
}

function toSubmissionView(r: SubmissionRow): SubmissionView {
  return {
    id: r.id,
    engagementId: r.engagement_id,
    projectId: r.project_id,
    providerCompanyId: r.provider_company_id,
    periodStart: r.period_start,
    periodEnd: r.period_end,
    status: r.status,
    rejectReason: r.reject_reason,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
}

const SUBMISSION_SELECT = `
  select id, engagement_id, project_id, provider_company_id,
         to_char(period_start, 'YYYY-MM-DD') as period_start,
         to_char(period_end, 'YYYY-MM-DD') as period_end,
         status, reject_reason, created_at, updated_at
    from project_submissions`;

export async function getSubmission(id: string): Promise<SubmissionView | null> {
  const row = await queryOne<SubmissionRow>(`${SUBMISSION_SELECT} where id = $1`, [id]);
  return row ? toSubmissionView(row) : null;
}

export async function listSubmissions(filter: {
  engagementId?: string;
  projectId?: string;
  status?: WorkStatus;
}): Promise<SubmissionView[]> {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (filter.engagementId) {
    params.push(filter.engagementId);
    clauses.push(`engagement_id = $${params.length}`);
  }
  if (filter.projectId) {
    params.push(filter.projectId);
    clauses.push(`project_id = $${params.length}`);
  }
  if (filter.status) {
    params.push(filter.status);
    clauses.push(`status = $${params.length}`);
  }
  const where = clauses.length ? `where ${clauses.join(' and ')}` : '';
  const rows = await query<SubmissionRow>(
    `${SUBMISSION_SELECT} ${where} order by created_at desc`,
    params
  );
  return rows.map(toSubmissionView);
}

export async function insertSubmission(input: {
  engagementId: string;
  projectId: string;
  providerCompanyId: string;
  periodStart: string | null;
  periodEnd: string | null;
  submittedByUserId: string;
}): Promise<SubmissionView> {
  const row = await queryOne<SubmissionRow>(
    `insert into project_submissions (engagement_id, project_id, provider_company_id,
       period_start, period_end, submitted_by_user_id)
     values ($1,$2,$3,$4,$5,$6)
     returning id, engagement_id, project_id, provider_company_id,
       to_char(period_start, 'YYYY-MM-DD') as period_start,
       to_char(period_end, 'YYYY-MM-DD') as period_end,
       status, reject_reason, created_at, updated_at`,
    [
      input.engagementId,
      input.projectId,
      input.providerCompanyId,
      input.periodStart,
      input.periodEnd,
      input.submittedByUserId,
    ]
  );
  return toSubmissionView(row!);
}

export async function transitionSubmission(
  id: string,
  status: WorkStatus,
  review?: { reviewerUserId: string; rejectReason: string | null },
  runner?: Queryable
): Promise<SubmissionView> {
  const row = await queryOne<SubmissionRow>(
    // Same explicit cast as `transitionExpense` — see the note there.
    `update project_submissions set status = $2,
       reviewed_by_user_id = $3::uuid,
       reviewed_at = case when $3::uuid is null then reviewed_at else now() end,
       reject_reason = $4, updated_at = now()
     where id = $1
     returning id, engagement_id, project_id, provider_company_id,
       to_char(period_start, 'YYYY-MM-DD') as period_start,
       to_char(period_end, 'YYYY-MM-DD') as period_end,
       status, reject_reason, created_at, updated_at`,
    [id, status, review?.reviewerUserId ?? null, review?.rejectReason ?? null],
    runner
  );
  return toSubmissionView(row!);
}
