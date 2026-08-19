import { Router, type Request } from 'express';
import {
  DEFAULT_CURRENCY,
  calculateCost,
  createExpenseSchema,
  createSubmissionSchema,
  createTimeLogSchema,
  extractRate,
  rejectSchema,
  resolveRateLabel,
  updateExpenseSchema,
  updateTimeLogSchema,
  type ResolvedRateSnapshot,
  type ShiftType,
} from '@crewquo/shared';
import { asyncHandler } from '../../http/asyncHandler';
import { getCompanyCtx } from '../../http/context';
import { AppError } from '../../http/errors';
import { param } from '../../http/params';
import { queryOne, withTransaction } from '../../db';
import {
  canManage,
  canProviderEditWork,
  canProviderSubmit,
  canReviewWork,
  isEngagementProviderSide,
  type EngagementEdge,
} from '../../authorization/policies';
import { findEngagementEdge, type EngagementEdgeRow } from '../engagements/repo';
import { getEffectiveTimeframeDefinitions, listResolveCandidates } from '../rates/repo';
import { pickEffectiveCard } from '../rates/resolve';
import { findCompanyById } from '../companies/repo';
import { recordAudit } from '../audit/record';
import { enqueueOutboxEvent } from '../delivery/repo';
import {
  deleteExpense,
  deleteTimeLog,
  getExpense,
  getSubmission,
  getTimeLog,
  insertExpense,
  insertSubmission,
  insertTimeLog,
  listExpenses,
  listProviderWorkContext,
  listSubmissions,
  listTimeLogs,
  reviewTimeLog,
  submitTimeLog,
  transitionExpense,
  transitionSubmission,
  updateExpenseFields,
  updateTimeLogFields,
} from './repo';

function edgeOf(row: EngagementEdgeRow): EngagementEdge {
  return { clientCompanyId: row.client_company_id, providerCompanyId: row.provider_company_id };
}

/**
 * Resolve the engagement the active (provider) company logs work under for a
 * project — via its assignment. Also validates the role belongs to the client's
 * catalog so rates resolve at submit.
 */
async function providerContextForProject(
  projectId: string,
  providerCompanyId: string
): Promise<EngagementEdgeRow> {
  const assignment = await queryOne<{ engagement_id: string }>(
    `select engagement_id from project_assignments
      where project_id = $1 and provider_company_id = $2`,
    [projectId, providerCompanyId]
  );
  if (!assignment) {
    throw new AppError('FORBIDDEN', 'Your company is not assigned to this project');
  }
  const edge = await findEngagementEdge(assignment.engagement_id);
  if (!edge) throw new AppError('NOT_FOUND', 'Engagement not found');
  return edge;
}

async function assertRoleInCompany(roleId: string, companyId: string): Promise<void> {
  const row = await queryOne(`select 1 from role_catalog where id = $1 and company_id = $2`, [
    roleId,
    companyId,
  ]);
  if (!row) throw new AppError('VALIDATION', 'roleId is not a role in the client company');
}

// A worklist filter honouring the one-hop rule: only the two edge companies see rows.
function scopedFilter(req: Request): { companyId: string; status?: 'DRAFT' | 'SUBMITTED' | 'APPROVED' | 'REJECTED'; engagementId?: string; projectId?: string } {
  const ctx = getCompanyCtx(req);
  const status = ['DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED'].includes(String(req.query.status))
    ? (req.query.status as 'DRAFT' | 'SUBMITTED' | 'APPROVED' | 'REJECTED')
    : undefined;
  const engagementId = typeof req.query.engagementId === 'string' ? req.query.engagementId : undefined;
  const projectId = typeof req.query.projectId === 'string' ? req.query.projectId : undefined;
  return { companyId: ctx.companyId, status, engagementId, projectId };
}

// ── /v1/work-context ─────────────────────────────────────────────────────────────

export const workContextRouter = Router();

// What the active (provider) company can log work against — projects + client roles.
workContextRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    res.json({ assignments: await listProviderWorkContext(ctx.companyId) });
  })
);

// ── /v1/time-logs ──────────────────────────────────────────────────────────────

export const timeLogsRouter = Router();

// List time logs on edges the active company participates in.
timeLogsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const f = scopedFilter(req);
    const all = await listTimeLogs({
      status: f.status,
      engagementId: f.engagementId,
      projectId: f.projectId,
    });
    // One-hop: keep only rows on an engagement the active company is an endpoint of.
    const visible = await filterByParticipation(all, f.companyId, (r) => r.engagementId);
    res.json({ data: visible });
  })
);

timeLogsRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    const input = createTimeLogSchema.parse(req.body);
    const edge = await providerContextForProject(input.projectId, ctx.companyId);
    await assertRoleInCompany(input.roleId, edge.client_company_id);

    const log = await insertTimeLog({
      engagementId: edge.id,
      projectId: input.projectId,
      providerCompanyId: ctx.companyId,
      loggedByUserId: ctx.userId,
      roleId: input.roleId,
      shiftType: input.shiftType,
      workDate: input.workDate,
      hoursRegular: input.hoursRegular,
      hoursOt: input.hoursOt,
    });
    res.status(201).json({ timeLog: log });
  })
);

timeLogsRouter.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    const { log, edge } = await loadTimeLog(param(req, 'id'));
    if (!isEngagementProviderSide(ctx.companyId, edgeOf(edge))) {
      throw new AppError('FORBIDDEN', 'Only the provider side can edit a time log');
    }
    if (!canProviderEditWork(log.status)) {
      throw new AppError('CONFLICT', `Cannot edit a ${log.status} time log`);
    }
    const patch = updateTimeLogSchema.parse(req.body);
    if (patch.roleId) await assertRoleInCompany(patch.roleId, edge.client_company_id);
    res.json({ timeLog: await updateTimeLogFields(log.id, patch) });
  })
);

timeLogsRouter.post(
  '/:id/submit',
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    const { log, edge } = await loadTimeLog(param(req, 'id'));
    if (!isEngagementProviderSide(ctx.companyId, edgeOf(edge))) {
      throw new AppError('FORBIDDEN', 'Only the provider side can submit');
    }
    if (!canProviderSubmit(log.status)) {
      throw new AppError('CONFLICT', `Cannot submit a ${log.status} time log`);
    }

    // Freeze the PAY rate (client pays provider) — best-effort; null if unconfigured.
    const snapshot = await resolvePaySnapshot({
      clientCompanyId: edge.client_company_id,
      providerCompanyId: edge.provider_company_id,
      projectId: log.projectId,
      roleId: log.roleId,
      shiftType: log.shiftType,
      workDate: log.workDate,
      hoursRegular: log.hoursRegular,
      hoursOt: log.hoursOt,
    });

    const submitted = await submitTimeLog(log.id, snapshot);
    const hours = log.hoursRegular + log.hoursOt;
    await withTransaction(async (client) => {
      await recordAudit({
        companyId: ctx.companyId,
        actorUserId: ctx.userId,
        action: 'time_log.submitted',
        entityType: 'TIME_LOG',
        entityId: log.id,
        changes: { workDate: log.workDate, hoursRegular: log.hoursRegular, hoursOt: log.hoursOt },
        description: `Time log for ${log.workDate} submitted (${hours}h)`,
        visibleToClient: true,
      }, client);
      await enqueueOutboxEvent({
        topic: 'work.submitted',
        aggregateType: 'TIME_LOG',
        aggregateId: log.id,
        companyId: edge.client_company_id,
        payload: {
          hiringCompanyId: edge.client_company_id,
          providerCompanyId: edge.provider_company_id,
          subjectType: 'TIME_LOG',
          subjectId: log.id,
          actorUserId: ctx.userId,
          title: 'Time log awaiting approval',
          body: `${hours}h on ${log.workDate} was submitted for your approval`,
          actionUrl: '/review',
        },
        idempotencyKey: `work.submitted:${log.id}`,
      }, client);
    });
    res.json({ timeLog: submitted });
  })
);

timeLogsRouter.post(
  '/:id/approve',
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    const { log } = await reviewGuard(req);
    const updated = await withTransaction(async (client) => {
      const result = await reviewTimeLog(log.id, 'APPROVED', ctx.userId, null, client);
      await recordAudit({
        companyId: ctx.companyId,
        actorUserId: ctx.userId,
        action: 'time_log.approved',
        entityType: 'TIME_LOG',
        entityId: log.id,
        description: `Time log for ${log.workDate} approved (${log.hoursRegular + log.hoursOt}h)`,
        visibleToClient: true,
      }, client);
      await enqueueOutboxEvent({
        topic: 'work.approved',
        aggregateType: 'TIME_LOG',
        aggregateId: log.id,
        companyId: log.providerCompanyId,
        payload: {
          providerCompanyId: log.providerCompanyId,
          subjectType: 'TIME_LOG',
          subjectId: log.id,
          recipientUserId: log.loggedByUserId,
          actorUserId: ctx.userId,
          title: 'Time log approved',
          body: `Your time log for ${log.workDate} was approved`,
          actionUrl: '/work',
        },
        idempotencyKey: `work.approved:${log.id}`,
      }, client);
      return result;
    });
    res.json({ timeLog: updated });
  })
);

timeLogsRouter.post(
  '/:id/reject',
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    const { log } = await reviewGuard(req);
    const { reason } = rejectSchema.parse(req.body ?? {});
    const updated = await withTransaction(async (client) => {
      const result = await reviewTimeLog(log.id, 'REJECTED', ctx.userId, reason ?? null, client);
      await recordAudit({
        companyId: ctx.companyId,
        actorUserId: ctx.userId,
        action: 'time_log.rejected',
        entityType: 'TIME_LOG',
        entityId: log.id,
        changes: reason ? { reason } : null,
        description: `Time log for ${log.workDate} rejected`,
        visibleToClient: true,
      }, client);
      await enqueueOutboxEvent({
        topic: 'work.rejected',
        aggregateType: 'TIME_LOG',
        aggregateId: log.id,
        companyId: log.providerCompanyId,
        payload: {
          providerCompanyId: log.providerCompanyId,
          subjectType: 'TIME_LOG',
          subjectId: log.id,
          recipientUserId: log.loggedByUserId,
          actorUserId: ctx.userId,
          title: 'Time log rejected',
          body: reason
            ? `Your time log for ${log.workDate} was rejected: ${reason}`
            : `Your time log for ${log.workDate} was rejected`,
          actionUrl: '/work',
        },
        idempotencyKey: `work.rejected:${log.id}`,
      }, client);
      return result;
    });
    res.json({ timeLog: updated });
  })
);

timeLogsRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    const { log, edge } = await loadTimeLog(param(req, 'id'));
    if (!isEngagementProviderSide(ctx.companyId, edgeOf(edge))) {
      throw new AppError('FORBIDDEN', 'Only the provider side can delete a time log');
    }
    if (!canProviderEditWork(log.status)) {
      throw new AppError('CONFLICT', `Cannot delete a ${log.status} time log`);
    }
    await deleteTimeLog(log.id);
    res.status(204).end();
  })
);

async function loadTimeLog(id: string) {
  const log = await getTimeLog(id);
  if (!log) throw new AppError('NOT_FOUND', 'Time log not found');
  const edge = await findEngagementEdge(log.engagementId);
  if (!edge) throw new AppError('NOT_FOUND', 'Engagement not found');
  return { log, edge };
}

async function reviewGuard(req: Request) {
  const ctx = getCompanyCtx(req);
  const { log, edge } = await loadTimeLog(param(req, 'id'));
  if (!canReviewWork(ctx.companyId, ctx.role, edgeOf(edge), log.status)) {
    throw new AppError('FORBIDDEN', 'Only the client side may review a submitted time log');
  }
  return { log, edge };
}

/**
 * Freeze what this log costs (§6).
 *
 * The amount is pinned **here, at submit**, because what a provider is owed must
 * not move afterwards because somebody edited a rate card next month.
 *
 * The unit is recorded alongside it for readability and is always the paying
 * company's one currency — a company works in exactly one (owner decision,
 * 2026-08-19). This function used to also resolve and freeze an exchange rate for
 * logs whose PAY currency differed from the project's; there is no such case now,
 * so that went with the rates themselves.
 */
async function resolvePaySnapshot(args: {
  clientCompanyId: string;
  providerCompanyId: string;
  projectId: string;
  roleId: string;
  shiftType: ShiftType;
  workDate: string;
  hoursRegular: number;
  hoursOt: number;
}): Promise<ResolvedRateSnapshot | null> {
  // The paying (client) side's own label rules decide the label (§6).
  const labelRules = await getEffectiveTimeframeDefinitions(args.clientCompanyId);
  const label = resolveRateLabel(args.shiftType, args.workDate, labelRules);
  const candidates = await listResolveCandidates({
    companyId: args.clientCompanyId,
    kind: 'PAY',
    roleId: args.roleId,
    label,
    date: args.workDate,
    counterpartyId: args.providerCompanyId,
  });
  const card = pickEffectiveCard(candidates, args.workDate, args.providerCompanyId);
  if (!card) return null;
  const rate = extractRate(card);
  const costCents = calculateCost({
    card,
    quantity: args.hoursRegular,
    otHours: args.hoursOt,
  });

  // The paying company's one currency. Read from the company rather than the card
  // because cards no longer carry their own — see 0017.
  const payer = await findCompanyById(args.clientCompanyId);
  const payCurrency = payer?.currency ?? DEFAULT_CURRENCY;

  return {
    rateCardId: card.id,
    label,
    rateMode: card.rateMode,
    baseCents: rate.baseCents,
    otCents: rate.otCents,
    hoursRegular: args.hoursRegular,
    hoursOt: args.hoursOt,
    costCents,
    currency: payCurrency,
  };
}

// ── /v1/expenses ──────────────────────────────────────────────────────────────

export const expensesRouter = Router();

expensesRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const f = scopedFilter(req);
    const all = await listExpenses({
      status: f.status,
      engagementId: f.engagementId,
      projectId: f.projectId,
    });
    res.json({ data: await filterByParticipation(all, f.companyId, (r) => r.engagementId) });
  })
);

expensesRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    const input = createExpenseSchema.parse(req.body);
    const edge = await providerContextForProject(input.projectId, ctx.companyId);
    const expense = await insertExpense({
      engagementId: edge.id,
      projectId: input.projectId,
      providerCompanyId: ctx.companyId,
      loggedByUserId: ctx.userId,
      amountCents: input.amountCents,
      category: input.category,
      description: input.description,
    });
    res.status(201).json({ expense });
  })
);

expensesRouter.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    const { expense, edge } = await loadExpense(param(req, 'id'));
    if (!isEngagementProviderSide(ctx.companyId, edgeOf(edge))) {
      throw new AppError('FORBIDDEN', 'Only the provider side can edit an expense');
    }
    if (!canProviderEditWork(expense.status)) {
      throw new AppError('CONFLICT', `Cannot edit a ${expense.status} expense`);
    }
    const patch = updateExpenseSchema.parse(req.body);
    res.json({ expense: await updateExpenseFields(expense.id, patch) });
  })
);

expensesRouter.post(
  '/:id/submit',
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    const { expense, edge } = await loadExpense(param(req, 'id'));
    if (!isEngagementProviderSide(ctx.companyId, edgeOf(edge))) {
      throw new AppError('FORBIDDEN', 'Only the provider side can submit');
    }
    if (!canProviderSubmit(expense.status)) {
      throw new AppError('CONFLICT', `Cannot submit a ${expense.status} expense`);
    }
    const updated = await withTransaction(async (client) => {
      const result = await transitionExpense(expense.id, 'SUBMITTED', undefined, client);
      await recordAudit({
        companyId: ctx.companyId,
        actorUserId: ctx.userId,
        action: 'expense.submitted',
        entityType: 'EXPENSE',
        entityId: expense.id,
        changes: { amountCents: expense.amountCents, category: expense.category },
        description: `Expense submitted (${expense.amountCents} cents)`,
        visibleToClient: true,
      }, client);
      await enqueueOutboxEvent({
        topic: 'expense.submitted',
        aggregateType: 'EXPENSE',
        aggregateId: expense.id,
        companyId: edge.client_company_id,
        payload: {
          hiringCompanyId: edge.client_company_id,
          providerCompanyId: expense.providerCompanyId,
          subjectType: 'EXPENSE',
          subjectId: expense.id,
          actorUserId: ctx.userId,
          title: 'Expense awaiting approval',
          body: 'An expense was submitted for your approval',
          actionUrl: '/review',
        },
        idempotencyKey: `expense.submitted:${expense.id}`,
      }, client);
      return result;
    });
    res.json({ expense: updated });
  })
);

expensesRouter.post(
  '/:id/approve',
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    const { expense, edge } = await loadExpense(param(req, 'id'));
    if (!canReviewWork(ctx.companyId, ctx.role, edgeOf(edge), expense.status)) {
      throw new AppError('FORBIDDEN', 'Only the client side may review a submitted expense');
    }
    const updated = await withTransaction(async (client) => {
      const result = await transitionExpense(
        expense.id,
        'APPROVED',
        { reviewerUserId: ctx.userId, rejectReason: null },
        client
      );
      await recordAudit({
        companyId: ctx.companyId,
        actorUserId: ctx.userId,
        action: 'expense.approved',
        entityType: 'EXPENSE',
        entityId: expense.id,
        description: `Expense approved (${expense.amountCents} cents)`,
        visibleToClient: true,
      }, client);
      await enqueueOutboxEvent({
        topic: 'expense.approved',
        aggregateType: 'EXPENSE',
        aggregateId: expense.id,
        companyId: expense.providerCompanyId,
        payload: {
          providerCompanyId: expense.providerCompanyId,
          subjectType: 'EXPENSE',
          subjectId: expense.id,
          recipientUserId: expense.loggedByUserId,
          actorUserId: ctx.userId,
          title: 'Expense approved',
          body: 'Your expense was approved',
          actionUrl: '/work',
        },
        idempotencyKey: `expense.approved:${expense.id}`,
      }, client);
      return result;
    });
    res.json({ expense: updated });
  })
);

expensesRouter.post(
  '/:id/reject',
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    const { expense, edge } = await loadExpense(param(req, 'id'));
    if (!canReviewWork(ctx.companyId, ctx.role, edgeOf(edge), expense.status)) {
      throw new AppError('FORBIDDEN', 'Only the client side may review a submitted expense');
    }
    const { reason } = rejectSchema.parse(req.body ?? {});
    const updated = await withTransaction(async (client) => {
      const result = await transitionExpense(
        expense.id,
        'REJECTED',
        { reviewerUserId: ctx.userId, rejectReason: reason ?? null },
        client
      );
      await recordAudit({
        companyId: ctx.companyId,
        actorUserId: ctx.userId,
        action: 'expense.rejected',
        entityType: 'EXPENSE',
        entityId: expense.id,
        changes: reason ? { reason } : null,
        description: 'Expense rejected',
        visibleToClient: true,
      }, client);
      await enqueueOutboxEvent({
        topic: 'expense.rejected',
        aggregateType: 'EXPENSE',
        aggregateId: expense.id,
        companyId: expense.providerCompanyId,
        payload: {
          providerCompanyId: expense.providerCompanyId,
          subjectType: 'EXPENSE',
          subjectId: expense.id,
          recipientUserId: expense.loggedByUserId,
          actorUserId: ctx.userId,
          title: 'Expense rejected',
          body: reason ? `Your expense was rejected: ${reason}` : 'Your expense was rejected',
          actionUrl: '/work',
        },
        idempotencyKey: `expense.rejected:${expense.id}`,
      }, client);
      return result;
    });
    res.json({ expense: updated });
  })
);

expensesRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    const { expense, edge } = await loadExpense(param(req, 'id'));
    if (!isEngagementProviderSide(ctx.companyId, edgeOf(edge))) {
      throw new AppError('FORBIDDEN', 'Only the provider side can delete an expense');
    }
    if (!canProviderEditWork(expense.status)) {
      throw new AppError('CONFLICT', `Cannot delete a ${expense.status} expense`);
    }
    await deleteExpense(expense.id);
    res.status(204).end();
  })
);

async function loadExpense(id: string) {
  const expense = await getExpense(id);
  if (!expense) throw new AppError('NOT_FOUND', 'Expense not found');
  const edge = await findEngagementEdge(expense.engagementId);
  if (!edge) throw new AppError('NOT_FOUND', 'Engagement not found');
  return { expense, edge };
}

// ── /v1/project-submissions ──────────────────────────────────────────────────────

export const submissionsRouter = Router();

submissionsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const f = scopedFilter(req);
    const all = await listSubmissions({
      status: f.status,
      engagementId: f.engagementId,
      projectId: f.projectId,
    });
    res.json({ data: await filterByParticipation(all, f.companyId, (r) => r.engagementId) });
  })
);

submissionsRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    const input = createSubmissionSchema.parse(req.body);
    const edge = await providerContextForProject(input.projectId, ctx.companyId);
    const submission = await insertSubmission({
      engagementId: edge.id,
      projectId: input.projectId,
      providerCompanyId: ctx.companyId,
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      submittedByUserId: ctx.userId,
    });
    res.status(201).json({ submission });
  })
);

submissionsRouter.post(
  '/:id/submit',
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    const { submission, edge } = await loadSubmission(param(req, 'id'));
    if (!isEngagementProviderSide(ctx.companyId, edgeOf(edge))) {
      throw new AppError('FORBIDDEN', 'Only the provider side can submit');
    }
    if (!canProviderSubmit(submission.status)) {
      throw new AppError('CONFLICT', `Cannot submit a ${submission.status} submission`);
    }
    const updated = await withTransaction(async (client) => {
      const result = await transitionSubmission(submission.id, 'SUBMITTED', undefined, client);
      await recordAudit({
        companyId: ctx.companyId,
        actorUserId: ctx.userId,
        action: 'submission.submitted',
        entityType: 'PROJECT_SUBMISSION',
        entityId: submission.id,
        changes: { periodStart: submission.periodStart, periodEnd: submission.periodEnd },
        description: 'Work submission sent for approval',
        visibleToClient: true,
      }, client);
      await enqueueOutboxEvent({
        topic: 'submission.submitted',
        aggregateType: 'PROJECT_SUBMISSION',
        aggregateId: submission.id,
        companyId: edge.client_company_id,
        payload: {
          hiringCompanyId: edge.client_company_id,
          providerCompanyId: submission.providerCompanyId,
          subjectType: 'PROJECT_SUBMISSION',
          subjectId: submission.id,
          actorUserId: ctx.userId,
          title: 'Work submission awaiting approval',
          body: `Work for ${submission.periodStart} to ${submission.periodEnd} was submitted for your approval`,
          actionUrl: '/review',
        },
        idempotencyKey: `submission.submitted:${submission.id}`,
      }, client);
      return result;
    });
    res.json({ submission: updated });
  })
);

submissionsRouter.post(
  '/:id/approve',
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    const { submission, edge } = await loadSubmission(param(req, 'id'));
    if (!canReviewWork(ctx.companyId, ctx.role, edgeOf(edge), submission.status)) {
      throw new AppError('FORBIDDEN', 'Only the client side may review a submission');
    }
    const updated = await transitionSubmission(submission.id, 'APPROVED', {
      reviewerUserId: ctx.userId,
      rejectReason: null,
    });
    await recordAudit({
      companyId: ctx.companyId,
      actorUserId: ctx.userId,
      action: 'submission.approved',
      entityType: 'PROJECT_SUBMISSION',
      entityId: submission.id,
      description: 'Work submission approved',
      visibleToClient: true,
    });
    res.json({ submission: updated });
  })
);

submissionsRouter.post(
  '/:id/reject',
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    const { submission, edge } = await loadSubmission(param(req, 'id'));
    if (!canReviewWork(ctx.companyId, ctx.role, edgeOf(edge), submission.status)) {
      throw new AppError('FORBIDDEN', 'Only the client side may review a submission');
    }
    const { reason } = rejectSchema.parse(req.body ?? {});
    const updated = await transitionSubmission(submission.id, 'REJECTED', {
      reviewerUserId: ctx.userId,
      rejectReason: reason ?? null,
    });
    await recordAudit({
      companyId: ctx.companyId,
      actorUserId: ctx.userId,
      action: 'submission.rejected',
      entityType: 'PROJECT_SUBMISSION',
      entityId: submission.id,
      changes: reason ? { reason } : null,
      description: 'Work submission rejected',
      visibleToClient: true,
    });
    res.json({ submission: updated });
  })
);

async function loadSubmission(id: string) {
  const submission = await getSubmission(id);
  if (!submission) throw new AppError('NOT_FOUND', 'Submission not found');
  const edge = await findEngagementEdge(submission.engagementId);
  if (!edge) throw new AppError('NOT_FOUND', 'Engagement not found');
  return { submission, edge };
}

/**
 * One-hop enforcement for list endpoints: drop any row whose engagement the
 * active company is not an endpoint of. Edges are cached to avoid re-querying.
 */
async function filterByParticipation<T>(
  rows: T[],
  companyId: string,
  engagementIdOf: (row: T) => string
): Promise<T[]> {
  const cache = new Map<string, EngagementEdge | null>();
  const out: T[] = [];
  for (const row of rows) {
    const eid = engagementIdOf(row);
    let edge = cache.get(eid);
    if (edge === undefined) {
      const found = await findEngagementEdge(eid);
      edge = found ? edgeOf(found) : null;
      cache.set(eid, edge);
    }
    if (edge && (edge.clientCompanyId === companyId || edge.providerCompanyId === companyId)) {
      out.push(row);
    }
  }
  return out;
}
