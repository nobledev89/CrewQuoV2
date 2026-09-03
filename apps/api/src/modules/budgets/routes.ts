import { Router } from 'express';
import {
  BUDGET_CATEGORIES,
  BUDGET_CATEGORY_SPECS,
  BUDGET_COLUMN,
  BUDGET_FIELD,
  computeBudgetVariance,
  setProjectBudgetSchema,
  untrackedBudgetShare,
  type BudgetCategory,
  type ExpenseCategoryTotal,
  type ProjectBudgetView,
} from '@crewquo/shared';
import { asyncHandler } from '../../http/asyncHandler';
import { getCompanyCtx } from '../../http/context';
import { AppError } from '../../http/errors';
import { uuidParam } from '../../http/params';
import { query, queryOne, withTransaction } from '../../db';
import { assertCapability } from '../capabilities/guards';
import { hasFeature } from '../entitlements/guards';
import { recordAudit } from '../audit/record';
import { recordRevision } from '../revisions/record';
import { projectAccess } from '../assets/routes';
import { computeProjectSummary } from '../projects/summary';
import { getProject } from '../projects/repo';

/**
 * Planned vs actual (§30.2) — step 11.6 of the Phase 11 build order in
 * `docs/operating-model/commercial-operations.md` §14.
 *
 * ── OWNER ONLY, AND `commercial.read` ──────────────────────────────────────
 *
 * The two checks in this file that are decisions rather than transcription.
 *
 * **The project owner and nobody else.** Every other project read in this product
 * is available to an assigned subcontractor in some scoped form — its own evidence,
 * its own diary, the project's tonnage. A budget has no scoped form: it is one
 * statement of what the whole job is expected to cost and earn, and a
 * subcontractor reading it would learn its own margin from the other side.
 *
 * **And `commercial.read`, which is the key §37 was created for.** A budget is
 * margin by subtraction — revenue minus cost, by category, on one screen. The
 * schedule one file over is deliberately *not* gated this way, because Femi needs
 * to know he is on Marina Bay on Tuesday without being told what the job is worth.
 * This phase is the first where both sides of that distinction appear in the same
 * screen family.
 *
 * ── AND SIX OF THE TEN ROWS HAVE NO ACTUAL ─────────────────────────────────
 *
 * Packet finding 2. The arithmetic and the reasoning are in `budgets.ts`; what
 * happens here is that **only the four computable categories are ever passed an
 * actual**, and `computeVariance` discards one for a sourceless category even if a
 * future caller supplies it. Two independent mechanisms for one rule, because the
 * failure it prevents — `Vehicles · Budget £3,000 · Actual £0 · −100%` — is a
 * number nobody measured on a screen a contractor reads before a client meeting.
 */

async function assertBudgetAccess(
  projectId: string,
  companyId: string,
  capability: 'commercial.read' | 'commercial.manage',
  ctx: Parameters<typeof assertCapability>[0]
): Promise<{ ownerCompanyId: string; currency: string }> {
  const access = await projectAccess(projectId, companyId);
  if (!access.isOwner) {
    /*
     * 403 rather than 404, and this is the one place in the phase where that is
     * right: `projectAccess` has already established that this company is on the
     * project, so the id is not a secret from them — what they may not see is the
     * money. Answering 404 would tell an assigned subcontractor that the project
     * they are standing on does not exist.
     */
    throw new AppError('FORBIDDEN', 'Only the company that owns this project can see its budget');
  }
  if (!(await hasFeature(access.ownerCompanyId, 'variations'))) {
    throw new AppError('FORBIDDEN', 'Your plan does not include: variations', {
      feature: 'variations',
    });
  }
  await assertCapability(ctx, capability);

  const project = await getProject(companyId, projectId);
  /* c8 ignore next -- projectAccess proved it exists and is ours. */
  if (!project) throw new AppError('NOT_FOUND', 'Project not found');
  return { ownerCompanyId: access.ownerCompanyId, currency: project.reportingCurrency };
}

interface BudgetRow {
  revenue_cents: number;
  labour_cents: number;
  subcontractor_cents: number;
  vehicle_cents: number;
  mileage_cents: number;
  waste_cents: number;
  materials_cents: number;
  purchases_cents: number;
  expenses_cents: number;
  other_cents: number;
  notes: string | null;
  updated_by_user_id: string | null;
  updated_by_name: string | null;
  updated_at: Date;
}

const SELECT = `b.revenue_cents, b.labour_cents, b.subcontractor_cents, b.vehicle_cents,
  b.mileage_cents, b.waste_cents, b.materials_cents, b.purchases_cents,
  b.expenses_cents, b.other_cents, b.notes,
  coalesce(b.updated_by_user_id, b.created_by_user_id) as updated_by_user_id,
  u.name as updated_by_name, b.updated_at
  from project_budgets b
  left join users u on u.id = coalesce(b.updated_by_user_id, b.created_by_user_id)`;

function budgetOf(row: BudgetRow | null): Partial<Record<BudgetCategory, number>> {
  if (!row) return {};
  const out: Partial<Record<BudgetCategory, number>> = {};
  for (const key of BUDGET_CATEGORIES) {
    out[key] = row[BUDGET_COLUMN[key] as keyof BudgetRow] as number;
  }
  return out;
}

/**
 * The four actuals the product can compute, and only those four.
 *
 * `labour` and `subcontractor` split on **whose company recorded the log**, which
 * is the one distinction §30.2's two separate categories can be given from data
 * this schema holds: a log recorded by the project owner is its own crew, and every
 * other approved log on the project is somebody it hired. Both read the frozen PAY
 * snapshot, as §30.2 requires, so a rate card changed next year cannot restate what
 * a job cost.
 *
 * `revenue` comes from `computeProjectSummary` rather than from a query of its own,
 * so the budget screen and the project header cannot disagree about it — and it
 * inherits the withholding rule with it: a project whose BILL cards do not fully
 * resolve has `revenueCents: null`, and the variance row says *not priced* rather
 * than reporting a revenue that is only the part we could price.
 */
async function computeActuals(args: {
  projectId: string;
  ownerCompanyId: string;
  clientCompanyId: string | null;
  currency: string;
}): Promise<{
  actuals: Partial<Record<BudgetCategory, number | null>>;
  expenseBreakdown: ExpenseCategoryTotal[];
}> {
  const summary = await computeProjectSummary({
    id: args.projectId,
    ownerCompanyId: args.ownerCompanyId,
    clientCompanyId: args.clientCompanyId,
    currency: args.currency,
  });

  const labour = await query<{ own: string; sub: string }>(
    `select
       coalesce(sum(case when t.provider_company_id = $2
                         then coalesce((t.resolved_rate->>'costCents')::int, 0) end), 0)::bigint as own,
       coalesce(sum(case when t.provider_company_id <> $2
                         then coalesce((t.resolved_rate->>'costCents')::int, 0) end), 0)::bigint as sub
       from time_logs t
      where t.project_id = $1 and t.status = 'APPROVED'`,
    [args.projectId, args.ownerCompanyId]
  );

  /*
   * The one breakdown the data genuinely supports, and finding 2's answer to the
   * question the six null rows raise: a person can see *where the money went* even
   * where the product cannot assign it to a budget line they chose. `category` is
   * null for expenses recorded without one, which is a real state and is shown as
   * "Uncategorised" rather than dropped.
   */
  const breakdown = await query<{ category: string | null; cents: string; n: string }>(
    `select e.category, coalesce(sum(e.amount_cents), 0)::bigint as cents, count(*)::int as n
       from expenses e
      where e.project_id = $1 and e.status = 'APPROVED'
      group by e.category
      order by 2 desc, 1 nulls last`,
    [args.projectId]
  );

  return {
    actuals: {
      revenue: summary.revenueCents,
      labour: Number(labour[0]?.own ?? 0),
      subcontractor: Number(labour[0]?.sub ?? 0),
      expenses: summary.expenseCostCents,
      // The other six are deliberately absent. `computeVariance` renders them as
      // NO_SOURCE with the reason, and would discard a figure supplied here.
    },
    expenseBreakdown: breakdown.map((r) => ({
      category: r.category,
      actualCents: Number(r.cents),
      count: Number(r.n),
    })),
  };
}

function toView(args: {
  projectId: string;
  currency: string;
  row: BudgetRow | null;
  actuals: Partial<Record<BudgetCategory, number | null>>;
  expenseBreakdown: ExpenseCategoryTotal[];
}): ProjectBudgetView {
  const budget = budgetOf(args.row);
  const rows = computeBudgetVariance({ budget, actuals: args.actuals });

  /*
   * Planned and actual profit, netted over the rows that have both halves.
   *
   * `actualProfitCents` is **null when revenue is**, and it deliberately does not
   * try to net "the costs we do know about" against a revenue we do not: a profit
   * figure assembled from four of ten categories is not a profit, and printing one
   * would be the composite version of the −100% this whole module exists to avoid.
   */
  const plannedProfitCents = rows.reduce(
    (sum, r) => sum + (r.direction === 'INCOME' ? r.budgetCents : -r.budgetCents),
    0
  );
  const revenueRow = rows.find((r) => r.key === 'revenue');
  const actualProfitCents =
    revenueRow?.actualCents === null || revenueRow?.actualCents === undefined
      ? null
      : rows.reduce(
          (sum, r) =>
            r.actualCents === null
              ? sum
              : sum + (r.direction === 'INCOME' ? r.actualCents : -r.actualCents),
          0
        );

  return {
    projectId: args.projectId,
    currency: args.currency,
    budgetSet: args.row !== null,
    notes: args.row?.notes ?? null,
    rows,
    plannedProfitCents,
    actualProfitCents,
    expenseBreakdown: args.expenseBreakdown,
    untrackedShare: untrackedBudgetShare(budget),
    updatedByUserId: args.row?.updated_by_user_id ?? null,
    updatedByName: args.row?.updated_by_name ?? null,
    updatedAt: args.row?.updated_at.toISOString() ?? null,
  };
}

export const projectBudgetRouter = Router();

projectBudgetRouter.get(
  '/:projectId/budget',
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    const projectId = uuidParam(req, 'projectId');
    const { ownerCompanyId, currency } = await assertBudgetAccess(
      projectId,
      ctx.companyId,
      'commercial.read',
      ctx
    );

    const project = await getProject(ctx.companyId, projectId);
    const row = await queryOne<BudgetRow>(`select ${SELECT} where b.project_id = $1`, [projectId]);
    const { actuals, expenseBreakdown } = await computeActuals({
      projectId,
      ownerCompanyId,
      clientCompanyId: project?.clientCompanyId ?? null,
      currency,
    });

    res.json({
      budget: toView({ projectId, currency, row, actuals, expenseBreakdown }),
      /*
       * The catalog travels with the answer, so a client rendering a "not tracked"
       * row has the sentence explaining it without a second request and without a
       * copy of the reasons in its own code. §30.2's ten categories are a fact
       * about the server, and a UI that hard-coded them would be a second place to
       * edit when one grows a source.
       */
      categories: BUDGET_CATEGORY_SPECS,
    });
  })
);

/**
 * `PUT` — the whole budget, upserted.
 *
 * A `PUT` rather than a `PATCH` because a budget is one document a person edits on
 * one screen and saves, and because it makes the route idempotent by construction —
 * which is why packet §8 gives it no idempotency ledger: sending it twice sets the
 * same numbers.
 *
 * **No supersession chain, no reason required, and anyone with `commercial.manage`
 * may rewrite it at any time.** That is the one commercial record in this product
 * with that property, and it is deliberate: a budget is a plan, and a plan that
 * needs ceremony to revise is a plan people keep in a spreadsheet instead — which
 * is the state this feature exists to replace. Its history is `record_revisions`,
 * which answers *what did we think in March* without making March's number binding.
 */
projectBudgetRouter.put(
  '/:projectId/budget',
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    const projectId = uuidParam(req, 'projectId');
    const { ownerCompanyId, currency } = await assertBudgetAccess(
      projectId,
      ctx.companyId,
      'commercial.manage',
      ctx
    );

    const input = setProjectBudgetSchema.parse(req.body ?? {});
    const before = await queryOne<BudgetRow>(`select ${SELECT} where b.project_id = $1`, [
      projectId,
    ]);

    const row = await withTransaction(async (client) => {
      await query(
        `insert into project_budgets
           (project_id, company_id, revenue_cents, labour_cents, subcontractor_cents,
            vehicle_cents, mileage_cents, waste_cents, materials_cents, purchases_cents,
            expenses_cents, other_cents, notes, created_by_user_id, updated_by_user_id)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$14)
         on conflict on constraint project_budgets_one_per_project do update set
           revenue_cents = excluded.revenue_cents,
           labour_cents = excluded.labour_cents,
           subcontractor_cents = excluded.subcontractor_cents,
           vehicle_cents = excluded.vehicle_cents,
           mileage_cents = excluded.mileage_cents,
           waste_cents = excluded.waste_cents,
           materials_cents = excluded.materials_cents,
           purchases_cents = excluded.purchases_cents,
           expenses_cents = excluded.expenses_cents,
           other_cents = excluded.other_cents,
           notes = excluded.notes,
           updated_by_user_id = excluded.updated_by_user_id,
           updated_at = now()`,
        [
          projectId,
          ownerCompanyId,
          ...BUDGET_CATEGORIES.map((key) => input[BUDGET_FIELD[key]] as number),
          input.notes,
          ctx.userId,
        ],
        client
      );

      const after = await queryOne<BudgetRow>(`select ${SELECT} where b.project_id = $1`, [
        projectId,
      ], client);

      await recordAudit(
        {
          companyId: ownerCompanyId,
          actorUserId: ctx.userId,
          action: before ? 'budget.updated' : 'budget.set',
          entityType: 'PROJECT_BUDGET',
          entityId: projectId,
          description: before ? 'Project budget revised' : 'Project budget set',
        },
        client
      );
      /*
       * The trail §30.2's "no supersession chain" leans on. Without it a revised
       * budget would silently replace the one a decision was taken against, and
       * *"what did we think in March"* would have no answer at all — which is the
       * only reason it is safe for this record to be freely rewritable.
       */
      await recordRevision(
        {
          companyId: ownerCompanyId,
          entityType: 'project_budget',
          entityId: projectId,
          action: before ? 'UPDATE' : 'CREATE',
          before: before ? (budgetOf(before) as Record<string, unknown>) : null,
          after: budgetOf(after) as Record<string, unknown>,
          changedByUserId: ctx.userId,
        },
        client
      );
      return after;
    });

    const project = await getProject(ctx.companyId, projectId);
    const { actuals, expenseBreakdown } = await computeActuals({
      projectId,
      ownerCompanyId,
      clientCompanyId: project?.clientCompanyId ?? null,
      currency,
    });

    res.json({
      budget: toView({ projectId, currency, row, actuals, expenseBreakdown }),
      categories: BUDGET_CATEGORY_SPECS,
    });
  })
);
