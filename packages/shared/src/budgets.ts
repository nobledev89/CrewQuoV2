import { z } from 'zod';

/**
 * Planned vs actual (CREWQUO_V2_PLAN.md §30.2) — step 11.0 of the Phase 11 build
 * order in `docs/operating-model/commercial-operations.md` §14.
 *
 * ── THE WHOLE POINT OF THIS FILE IS THAT SIX OF THE TEN ROWS HAVE NO ACTUAL ──
 *
 * Packet finding 2. §30.2 is precise about where actuals come from: *"approved
 * time logs (labour, via the frozen PAY snapshots), approved expenses, asset
 * movements and activities (vehicles, mileage, waste), and approved variations
 * (revenue)."* The first two are real. The third is not, and it is checkable in one
 * query: `asset_movements` and `project_activities` between them carry `quantity`,
 * `mass_kg`, `distance_km`, `litres`, `kwh`, `tonne_km` and `journeys` — and **not
 * one money column.** Nothing anywhere in this schema prices a skip, a tonne, a
 * kilometre or a litre. Phase 8 and Phase 9 were built to answer how much material
 * and how much carbon, and they answer it completely; neither was ever asked what
 * it cost.
 *
 * So a literal implementation renders:
 *
 *     Vehicles      Budget £3,000    Actual £0    Variance −£3,000 / −100%
 *
 * Every character of which is wrong in the favourable direction. It is not a
 * variance; it is an absence with a percentage attached, on a screen a contractor
 * reads immediately before a client meeting. §41.1 forbids exactly this for carbon
 * — *"no factor, no number — say so instead"* — and the commercial half gets the
 * same rule: **`actualCents` is null where there is no source, the variance is null
 * with it, and the row says what would have to exist for the figure to be real.**
 *
 * The rejected alternative is recorded because it is tempting: map an approved
 * variation's cost lines onto the categories, since the line kinds line up almost
 * exactly. It fails on packet finding 3 — a variation's cost total is a **forecast**
 * made when the works were quoted, not a record of money spent — and a forecast in
 * the *Actual* column is worse than an empty cell, because an empty cell is visibly
 * empty.
 */

const money = z.number().int();

// ── The ten categories (§30.2) ───────────────────────────────────────────────

export const BUDGET_CATEGORIES = [
  'revenue',
  'labour',
  'subcontractor',
  'vehicle',
  'mileage',
  'waste',
  'materials',
  'purchases',
  'expenses',
  'other',
] as const;
export const budgetCategorySchema = z.enum(BUDGET_CATEGORIES);
export type BudgetCategory = z.infer<typeof budgetCategorySchema>;

/**
 * How completely the product can compute this category's actual.
 *
 * `COMPLETE` — every source that contributes to it exists and is read.
 * `NO_SOURCE` — **nothing in the schema records money against it.** The figure is
 * `null` rather than `0`, and the row carries the reason.
 *
 * There is deliberately no `PARTIAL`. A partial actual is a number a reader will
 * treat as a total, and the only candidate for one here was the variation-cost
 * mapping the header rejects.
 */
export type BudgetCoverage = 'COMPLETE' | 'NO_SOURCE';

export interface BudgetCategorySpec {
  key: BudgetCategory;
  label: string;
  /** Revenue reads the other way round: over budget is good. */
  direction: 'INCOME' | 'COST';
  coverage: BudgetCoverage;
  /**
   * For `COMPLETE`, what is summed. For `NO_SOURCE`, **what would have to exist**
   * — which is the sentence the row prints, because "not tracked" on its own sends
   * somebody to support to ask whether it is a bug.
   */
  sources: string;
}

export const BUDGET_CATEGORY_SPECS: readonly BudgetCategorySpec[] = [
  {
    key: 'revenue',
    label: 'Revenue',
    direction: 'INCOME',
    coverage: 'COMPLETE',
    sources:
      'Approved work priced at your BILL rates, plus the sell total of every approved variation.',
  },
  {
    key: 'labour',
    label: 'Labour (your crews)',
    direction: 'COST',
    coverage: 'COMPLETE',
    sources: 'Approved time logs recorded by your own company, from their frozen PAY snapshots.',
  },
  {
    key: 'subcontractor',
    label: 'Subcontractors',
    direction: 'COST',
    coverage: 'COMPLETE',
    sources:
      'Approved time logs recorded by other companies on this project, from their frozen PAY snapshots.',
  },
  /*
   * The six with nothing behind them. Each `sources` string names the thing that
   * would have to exist, because the useful answer to "why is this empty" is what
   * to do about it — and in five of the six cases the answer today is "record it as
   * an expense", which is a real workflow the product already supports.
   */
  {
    key: 'vehicle',
    label: 'Vehicles',
    direction: 'COST',
    coverage: 'NO_SOURCE',
    sources:
      'Nothing in CrewQuo prices a vehicle yet — activities record distance, fuel and journeys, not cost. Record vehicle spend as an expense to see it in Expenses below.',
  },
  {
    key: 'mileage',
    label: 'Mileage',
    direction: 'COST',
    coverage: 'NO_SOURCE',
    sources:
      'Mileage is recorded in kilometres, not currency, and there is no per-kilometre rate anywhere in CrewQuo. Record reimbursed mileage as an expense.',
  },
  {
    key: 'waste',
    label: 'Waste & disposal',
    direction: 'COST',
    coverage: 'NO_SOURCE',
    sources:
      'Asset movements record mass and destination, never a gate fee. Record skip and disposal charges as expenses.',
  },
  {
    key: 'materials',
    label: 'Materials',
    direction: 'COST',
    coverage: 'NO_SOURCE',
    sources:
      'Asset lines record what material was handled and what it weighed, not what it cost. Record purchases as expenses.',
  },
  {
    key: 'purchases',
    label: 'Purchases',
    direction: 'COST',
    coverage: 'NO_SOURCE',
    sources: 'CrewQuo holds no purchase ledger. Record purchases as expenses.',
  },
  {
    key: 'expenses',
    label: 'Expenses',
    direction: 'COST',
    coverage: 'COMPLETE',
    sources: 'Every approved expense on this project, at cost.',
  },
  {
    key: 'other',
    label: 'Other',
    direction: 'COST',
    coverage: 'NO_SOURCE',
    sources:
      'There is no record class this maps to — it is a budget line for something CrewQuo does not capture.',
  },
];

export const BUDGET_CATEGORY_SPEC_BY_KEY: Readonly<Record<BudgetCategory, BudgetCategorySpec>> =
  Object.fromEntries(BUDGET_CATEGORY_SPECS.map((s) => [s.key, s])) as Record<
    BudgetCategory,
    BudgetCategorySpec
  >;

/** The four the product can actually answer. Exported so tests can assert the count. */
export const COMPUTABLE_BUDGET_CATEGORIES: readonly BudgetCategory[] =
  BUDGET_CATEGORY_SPECS.filter((s) => s.coverage === 'COMPLETE').map((s) => s.key);

// ── Variance ─────────────────────────────────────────────────────────────────

export interface BudgetVarianceRow {
  key: BudgetCategory;
  label: string;
  direction: 'INCOME' | 'COST';
  coverage: BudgetCoverage;
  sources: string;
  budgetCents: number;
  /** **Null, never zero, where there is no source.** */
  actualCents: number | null;
  /** `actual − budget`. Null whenever the actual is. */
  varianceCents: number | null;
  /**
   * Variance as a percentage of budget, 2 dp. Null when the actual is null **and
   * also when the budget is zero** — dividing by a budget nobody set produces
   * either infinity or a very confident-looking `0`, and the honest answer to
   * "what percentage over a budget of nothing is £840?" is that there isn't one.
   */
  variancePct: number | null;
  /**
   * Which way this row reads. `null` when there is nothing to say — no variance,
   * or a variance of exactly zero.
   *
   * §40: *"Colour communicates direction only (over/under), on the number — not a
   * coloured card per row."* So this is a direction and not a severity: there is
   * deliberately no `WARNING`/`CRITICAL`, because a threshold would be a judgement
   * about somebody else's business made by a constant in this file.
   */
  reading: 'FAVOURABLE' | 'ADVERSE' | null;
}

/**
 * One row's variance.
 *
 * Pure, total, and the only place a variance is computed — so §12 step 1's
 * assertion (*"nothing anywhere is 0 where the truth is not tracked, and nothing
 * is −100"*) is a property of one function rather than of every caller.
 */
export function computeVariance(args: {
  key: BudgetCategory;
  budgetCents: number;
  /** Null means the product holds no source. Pass `null`, never `0`. */
  actualCents: number | null;
}): BudgetVarianceRow {
  const spec = BUDGET_CATEGORY_SPEC_BY_KEY[args.key];
  const actualCents = spec.coverage === 'NO_SOURCE' ? null : args.actualCents;

  if (actualCents === null) {
    return {
      key: spec.key,
      label: spec.label,
      direction: spec.direction,
      coverage: spec.coverage,
      sources: spec.sources,
      budgetCents: args.budgetCents,
      actualCents: null,
      varianceCents: null,
      variancePct: null,
      reading: null,
    };
  }

  const varianceCents = actualCents - args.budgetCents;
  const variancePct =
    args.budgetCents === 0 ? null : Math.round((varianceCents / args.budgetCents) * 10000) / 100;

  /*
   * Revenue reads the other way round, which is the one asymmetry in this file that
   * is not about missing data. £840 more labour than planned is bad; £840 more
   * revenue than planned is good, and a screen that coloured both the same way
   * would be worse than one with no colour at all.
   */
  let reading: BudgetVarianceRow['reading'] = null;
  if (varianceCents !== 0) {
    const over = varianceCents > 0;
    reading = spec.direction === 'INCOME' ? (over ? 'FAVOURABLE' : 'ADVERSE') : over ? 'ADVERSE' : 'FAVOURABLE';
  }

  return {
    key: spec.key,
    label: spec.label,
    direction: spec.direction,
    coverage: spec.coverage,
    sources: spec.sources,
    budgetCents: args.budgetCents,
    actualCents,
    varianceCents,
    variancePct,
    reading,
  };
}

/**
 * Every row, in §30.2's declared order, from a budget and whatever actuals the
 * caller could compute.
 *
 * `actuals` is a partial record on purpose: a caller that computes three of the
 * four supplies three, and the fourth comes back `null` rather than `0`. A
 * `Record<BudgetCategory, number>` would have forced every caller to name a figure
 * for all ten, which is how a zero gets invented.
 */
export function computeBudgetVariance(args: {
  budget: Partial<Record<BudgetCategory, number>>;
  actuals: Partial<Record<BudgetCategory, number | null>>;
}): BudgetVarianceRow[] {
  return BUDGET_CATEGORY_SPECS.map((spec) =>
    computeVariance({
      key: spec.key,
      budgetCents: args.budget[spec.key] ?? 0,
      actualCents: args.actuals[spec.key] ?? null,
    })
  );
}

/**
 * The share of budgeted money sitting in categories with no source.
 *
 * §11's `budget.untracked_category_share`, and it exists to hold the packet to
 * account: finding 2 argues the honest answer to six sourceless categories is to
 * say so. If real customers put most of their money there, the honest *rendering*
 * was right and the *scope* was wrong, and this is the number that would show it.
 *
 * Null rather than `0` when nothing is budgeted at all, for the reason every other
 * null in this file is null.
 */
export function untrackedBudgetShare(
  budget: Partial<Record<BudgetCategory, number>>
): number | null {
  let total = 0;
  let untracked = 0;
  for (const spec of BUDGET_CATEGORY_SPECS) {
    if (spec.key === 'revenue') continue; // A cost share; revenue is not a cost.
    const cents = budget[spec.key] ?? 0;
    total += cents;
    if (spec.coverage === 'NO_SOURCE') untracked += cents;
  }
  if (total === 0) return null;
  return Math.round((untracked / total) * 10000) / 100;
}

// ── Views & schemas ──────────────────────────────────────────────────────────

/**
 * Approved expense spend grouped by its own free-text category.
 *
 * The one breakdown the data genuinely supports, and finding 2's answer to the
 * question the six null rows raise: a person can see *where the money went* even
 * where the product cannot assign it to a budget line they chose. `category` is
 * `null` for expenses recorded without one, which is a real state and is shown as
 * "Uncategorised" rather than dropped.
 */
export interface ExpenseCategoryTotal {
  category: string | null;
  actualCents: number;
  count: number;
}

export interface ProjectBudgetView {
  projectId: string;
  /**
   * Read from `projects.reporting_currency`, and **there is no `currency` column on
   * `project_budgets`** — packet finding 1. §30.2's DDL declares one; migration
   * `0017` deleted exactly that column from three other tables on the reasoning
   * that two copies make "which is authoritative?" a question with no answer, and
   * a budget's unit can only ever be its project's pin.
   */
  currency: string;
  /** Null when no budget has ever been set — the empty state says so (§12 step 1). */
  budgetSet: boolean;
  notes: string | null;
  rows: BudgetVarianceRow[];
  /** The four computable rows, netted: revenue − every cost with a real actual. */
  plannedProfitCents: number;
  actualProfitCents: number | null;
  expenseBreakdown: ExpenseCategoryTotal[];
  untrackedShare: number | null;
  updatedByUserId: string | null;
  updatedByName: string | null;
  updatedAt: string | null;
}

/**
 * `PUT /v1/projects/:id/budget` — a whole-row upsert.
 *
 * A `PUT` rather than a `PATCH` because a budget is one document a person edits on
 * one screen and saves, and because it makes the route idempotent by construction
 * — which is why packet §8 gives it no idempotency ledger: sending it twice sets
 * the same numbers.
 *
 * Every category is optional and defaults to zero, and **zero is a real budget
 * figure here** — unlike an actual, where zero would be an invented number. "We
 * planned to spend nothing on skips" is a plan somebody made.
 */
export const setProjectBudgetSchema = z.object({
  revenueCents: money.min(0).default(0),
  labourCents: money.min(0).default(0),
  subcontractorCents: money.min(0).default(0),
  vehicleCents: money.min(0).default(0),
  mileageCents: money.min(0).default(0),
  wasteCents: money.min(0).default(0),
  materialsCents: money.min(0).default(0),
  purchasesCents: money.min(0).default(0),
  expensesCents: money.min(0).default(0),
  otherCents: money.min(0).default(0),
  notes: z.string().trim().max(2000).nullable().default(null),
});
export type SetProjectBudget = z.infer<typeof setProjectBudgetSchema>;

/** The column name for a category, so the repo has no second mapping to drift. */
export const BUDGET_COLUMN: Readonly<Record<BudgetCategory, string>> = {
  revenue: 'revenue_cents',
  labour: 'labour_cents',
  subcontractor: 'subcontractor_cents',
  vehicle: 'vehicle_cents',
  mileage: 'mileage_cents',
  waste: 'waste_cents',
  materials: 'materials_cents',
  purchases: 'purchases_cents',
  expenses: 'expenses_cents',
  other: 'other_cents',
};

/** And the request field, for the same reason. */
export const BUDGET_FIELD: Readonly<Record<BudgetCategory, keyof SetProjectBudget>> = {
  revenue: 'revenueCents',
  labour: 'labourCents',
  subcontractor: 'subcontractorCents',
  vehicle: 'vehicleCents',
  mileage: 'mileageCents',
  waste: 'wasteCents',
  materials: 'materialsCents',
  purchases: 'purchasesCents',
  expenses: 'expensesCents',
  other: 'otherCents',
};
