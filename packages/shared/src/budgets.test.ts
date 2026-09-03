import { describe, expect, it } from 'vitest';
import {
  BUDGET_CATEGORIES,
  BUDGET_CATEGORY_SPECS,
  BUDGET_COLUMN,
  BUDGET_FIELD,
  COMPUTABLE_BUDGET_CATEGORIES,
  computeBudgetVariance,
  computeVariance,
  setProjectBudgetSchema,
  untrackedBudgetShare,
} from './budgets';

/**
 * The one property this whole module exists to guarantee, and the one §12 step 1
 * asserts against live Postgres: **no variance function can report `0` or `-100`
 * for an absent actual.**
 *
 * Packet finding 2. Six of §30.2's ten categories have no source of money anywhere
 * in the schema, and the row a literal implementation renders — *"Vehicles Budget
 * £3,000 · Actual £0 · Variance −£3,000 / −100%"* — is an absence with a
 * percentage attached, on a screen a contractor reads before a client meeting.
 */

describe('the category catalog', () => {
  it('declares all ten of §30.2, in its order', () => {
    expect(BUDGET_CATEGORY_SPECS.map((s) => s.key)).toEqual([...BUDGET_CATEGORIES]);
  });

  it('can compute exactly four of them', () => {
    // If this number changes, something either grew a money column or lost one, and
    // either way the packet's finding 2 needs rewriting rather than the test
    // relaxing.
    expect([...COMPUTABLE_BUDGET_CATEGORIES]).toEqual([
      'revenue',
      'labour',
      'subcontractor',
      'expenses',
    ]);
  });

  it('says what would have to exist for every sourceless category', () => {
    for (const spec of BUDGET_CATEGORY_SPECS) {
      expect(spec.sources.length).toBeGreaterThan(20);
      if (spec.coverage === 'NO_SOURCE') {
        // "Not tracked" on its own sends somebody to support to ask if it is a bug.
        expect(spec.sources).toMatch(/CrewQuo|expense|no record class|no purchase ledger/i);
      }
    }
  });

  it('treats revenue as the only income line', () => {
    const income = BUDGET_CATEGORY_SPECS.filter((s) => s.direction === 'INCOME');
    expect(income.map((s) => s.key)).toEqual(['revenue']);
  });

  it('maps every category to a column and a request field, with no gaps', () => {
    for (const key of BUDGET_CATEGORIES) {
      expect(BUDGET_COLUMN[key]).toMatch(/_cents$/);
      expect(BUDGET_FIELD[key]).toMatch(/Cents$/);
    }
    // Two mappings of ten keys is two places to drift; the sizes agreeing is the
    // cheapest assertion that they have not.
    expect(new Set(Object.values(BUDGET_COLUMN)).size).toBe(BUDGET_CATEGORIES.length);
    expect(new Set(Object.values(BUDGET_FIELD)).size).toBe(BUDGET_CATEGORIES.length);
  });
});

describe('computeVariance', () => {
  it('reports null, never zero, where there is no source', () => {
    const row = computeVariance({ key: 'vehicle', budgetCents: 300_000, actualCents: null });
    expect(row.actualCents).toBeNull();
    expect(row.varianceCents).toBeNull();
    expect(row.variancePct).toBeNull();
    expect(row.reading).toBeNull();
    expect(row.coverage).toBe('NO_SOURCE');
  });

  it('refuses an actual for a sourceless category even when a caller supplies one', () => {
    // The load-bearing case. A caller that computed something for `vehicle` — say by
    // mapping variation cost lines onto it — has it discarded here rather than
    // rendered, because a variation's cost is a forecast (packet finding 3) and a
    // forecast in the Actual column is worse than an empty cell.
    const row = computeVariance({ key: 'waste', budgetCents: 100_000, actualCents: 90_000 });
    expect(row.actualCents).toBeNull();
  });

  it('computes a signed variance and a percentage for a real actual', () => {
    const row = computeVariance({ key: 'labour', budgetCents: 820_000, actualCents: 904_000 });
    expect(row.actualCents).toBe(904_000);
    expect(row.varianceCents).toBe(84_000);
    expect(row.variancePct).toBeCloseTo(10.24, 2);
    expect(row.reading).toBe('ADVERSE');
  });

  it('reads revenue the other way round', () => {
    // £840 more labour than planned is bad; £840 more revenue than planned is good,
    // and a screen colouring both the same way is worse than one with no colour.
    expect(computeVariance({ key: 'revenue', budgetCents: 100_000, actualCents: 120_000 }).reading)
      .toBe('FAVOURABLE');
    expect(computeVariance({ key: 'revenue', budgetCents: 100_000, actualCents: 80_000 }).reading)
      .toBe('ADVERSE');
    expect(computeVariance({ key: 'labour', budgetCents: 100_000, actualCents: 80_000 }).reading)
      .toBe('FAVOURABLE');
  });

  it('has no reading when the variance is exactly zero', () => {
    const row = computeVariance({ key: 'expenses', budgetCents: 5000, actualCents: 5000 });
    expect(row.varianceCents).toBe(0);
    expect(row.reading).toBeNull();
  });

  it('withholds the percentage when the budget is zero, rather than dividing by it', () => {
    // "What percentage over a budget of nothing is £840?" has no answer, and both
    // available wrong answers — Infinity and a confident-looking 0 — get rendered.
    const row = computeVariance({ key: 'labour', budgetCents: 0, actualCents: 84_000 });
    expect(row.varianceCents).toBe(84_000);
    expect(row.variancePct).toBeNull();
    expect(row.reading).toBe('ADVERSE');
  });

  it('never produces -100 for an unset actual, at any budget', () => {
    for (const key of BUDGET_CATEGORIES) {
      for (const budget of [0, 1, 300_000, 99_999_999]) {
        const row = computeVariance({ key, budgetCents: budget, actualCents: null });
        expect(row.variancePct).not.toBe(-100);
        expect(row.variancePct).toBeNull();
        expect(row.actualCents).not.toBe(0);
      }
    }
  });
});

describe('computeBudgetVariance', () => {
  it('returns ten rows in §30.2 order from a partial budget and partial actuals', () => {
    const rows = computeBudgetVariance({
      budget: { revenue: 1_200_000, labour: 400_000, vehicle: 300_000 },
      actuals: { revenue: 1_190_000, labour: 452_000 },
    });
    expect(rows).toHaveLength(10);
    expect(rows.map((r) => r.key)).toEqual([...BUDGET_CATEGORIES]);

    const byKey = Object.fromEntries(rows.map((r) => [r.key, r]));
    expect(byKey.revenue?.varianceCents).toBe(-10_000);
    expect(byKey.labour?.varianceCents).toBe(52_000);
    // Budgeted and unsourced: the one the finding is about.
    expect(byKey.vehicle?.budgetCents).toBe(300_000);
    expect(byKey.vehicle?.actualCents).toBeNull();
    // Computable but not supplied by the caller: null, not zero.
    expect(byKey.subcontractor?.actualCents).toBeNull();
    expect(byKey.expenses?.actualCents).toBeNull();
  });

  it('treats a wholly empty project as ten unset rows, not ten zeros', () => {
    const rows = computeBudgetVariance({ budget: {}, actuals: {} });
    for (const row of rows) {
      expect(row.budgetCents).toBe(0);
      expect(row.actualCents).toBeNull();
      expect(row.variancePct).toBeNull();
    }
  });

  it('distinguishes an actual of zero from an absent one', () => {
    // A project with no approved expenses genuinely has spent nothing on them, and
    // that is a fact rather than a gap — which is why a caller may pass 0 for a
    // COMPLETE category and have it kept.
    const rows = computeBudgetVariance({
      budget: { expenses: 50_000 },
      actuals: { expenses: 0 },
    });
    const expenses = rows.find((r) => r.key === 'expenses');
    expect(expenses?.actualCents).toBe(0);
    expect(expenses?.varianceCents).toBe(-50_000);
    expect(expenses?.reading).toBe('FAVOURABLE');
  });
});

describe('untrackedBudgetShare — the metric that holds the packet to account', () => {
  it('is null rather than 0 when nothing is budgeted', () => {
    expect(untrackedBudgetShare({})).toBeNull();
    expect(untrackedBudgetShare({ revenue: 100_000 })).toBeNull();
  });

  it('excludes revenue, because a cost share is not a revenue share', () => {
    expect(untrackedBudgetShare({ revenue: 900_000, labour: 100_000 })).toBe(0);
  });

  it('reports the share of budgeted cost with nowhere to come from', () => {
    expect(untrackedBudgetShare({ labour: 250_000, vehicle: 250_000 })).toBe(50);
    expect(untrackedBudgetShare({ vehicle: 100_000, waste: 100_000 })).toBe(100);
  });
});

describe('the budget schema', () => {
  it('defaults every category to zero, because zero is a real plan', () => {
    const parsed = setProjectBudgetSchema.parse({});
    expect(parsed.revenueCents).toBe(0);
    expect(parsed.vehicleCents).toBe(0);
    expect(parsed.notes).toBeNull();
  });

  it('refuses a negative budget', () => {
    expect(setProjectBudgetSchema.safeParse({ labourCents: -1 }).success).toBe(false);
  });

  it('has no currency field at all — packet finding 1', () => {
    // §30.2 declares `currency text not null`; migration 0017 deleted exactly that
    // column from three other tables, and a budget's unit can only ever be its
    // project's pin.
    const parsed = setProjectBudgetSchema.parse({ currency: 'GBP' } as unknown);
    expect(parsed).not.toHaveProperty('currency');
  });
});
