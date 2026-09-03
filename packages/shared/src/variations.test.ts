import { describe, expect, it } from 'vitest';
import {
  VARIATION_STATUSES,
  VARIATION_TRANSITIONS,
  computeLineTotals,
  computeVariationTotals,
  createVariationSchema,
  findVariationTransition,
  lineTotalCents,
  rejectVariationSchema,
  updateVariationSchema,
  variationEditRefusal,
  variationIsEditable,
  variationLineInputSchema,
  variationMarginPct,
  variationTimesheetOverlapNotice,
} from './variations';

/**
 * §44's state-machine discipline, applied to §30.1: *"every declared transition is
 * covered by actor, source state, target state, rejection/withdraw/reopen
 * behavior, terminal-state immutability and concurrent double-action cases."*
 *
 * The transitions are a table rather than a `switch` precisely so this file can
 * walk them, which is why several cases below assert properties of the whole table
 * rather than of a named transition — a `switch` grows a branch nobody tests.
 */

describe('the variation status machine', () => {
  it('mirrors §3.4: only the recorder submits and only the owner decides', () => {
    for (const t of VARIATION_TRANSITIONS) {
      if (t.to === 'SUBMITTED') expect(t.actor).toBe('RECORDER');
      if (t.to === 'APPROVED' && t.from === 'SUBMITTED') expect(t.actor).toBe('OWNER');
      if (t.to === 'REJECTED') expect(t.actor).toBe('OWNER');
    }
  });

  it('requires a reason for exactly one transition, and it is the rejection', () => {
    const needReason = VARIATION_TRANSITIONS.filter((t) => t.reasonRequired);
    expect(needReason.map((t) => `${t.from}->${t.to}`)).toEqual(['SUBMITTED->REJECTED']);
  });

  it('gives INVOICED no actor a caller could name', () => {
    // Packet §3: `INVOICED` is set inside the transaction that creates the invoice
    // line. A transition table that let a caller drive it would be describing an
    // endpoint that must not exist.
    for (const t of VARIATION_TRANSITIONS) {
      if (t.to === 'INVOICED' || t.from === 'INVOICED') {
        expect(t.actor).toBe('SYSTEM');
        expect(t.capability).toBeNull();
      }
    }
  });

  it('lets an approved variation be invoiced without passing through COMPLETED', () => {
    expect(findVariationTransition('APPROVED', 'INVOICED')).not.toBeNull();
    expect(findVariationTransition('COMPLETED', 'INVOICED')).not.toBeNull();
  });

  it('allows withdraw and resubmit, and refuses everything undeclared', () => {
    expect(findVariationTransition('SUBMITTED', 'DRAFT')).not.toBeNull();
    expect(findVariationTransition('REJECTED', 'SUBMITTED')).not.toBeNull();
    // The ones a hopeful caller would try.
    expect(findVariationTransition('DRAFT', 'APPROVED')).toBeNull();
    expect(findVariationTransition('APPROVED', 'DRAFT')).toBeNull();
    expect(findVariationTransition('REJECTED', 'APPROVED')).toBeNull();
    expect(findVariationTransition('INVOICED', 'COMPLETED')).toBeNull();
  });

  it('declares no transition out of a state into itself', () => {
    for (const t of VARIATION_TRANSITIONS) expect(t.from).not.toBe(t.to);
  });

  it('names only real statuses', () => {
    for (const t of VARIATION_TRANSITIONS) {
      expect(VARIATION_STATUSES).toContain(t.from);
      expect(VARIATION_STATUSES).toContain(t.to);
    }
  });
});

describe('editability — packet finding 4', () => {
  it('is DRAFT and REJECTED, and nothing else', () => {
    const editable = VARIATION_STATUSES.filter(variationIsEditable);
    expect(editable).toEqual(['DRAFT', 'REJECTED']);
  });

  it('names what to do instead in every refusal', () => {
    // A refusal that does not say "raise a new one" sends somebody to support.
    expect(variationEditRefusal('DRAFT')).toBeNull();
    expect(variationEditRefusal('SUBMITTED')).toContain('Withdraw');
    for (const status of ['APPROVED', 'COMPLETED', 'INVOICED'] as const) {
      expect(variationEditRefusal(status)).toContain('new variation');
    }
  });
});

describe('line totals — the identity the migration turns into a check constraint', () => {
  it('is quantity times unit, rounded half-up', () => {
    expect(lineTotalCents(1, 4000)).toBe(4000);
    expect(lineTotalCents(2.5, 4000)).toBe(10_000);
    expect(lineTotalCents(16, 3750)).toBe(60_000);
    expect(lineTotalCents(0.5, 1)).toBe(1);
    expect(lineTotalCents(0.4, 1)).toBe(0);
  });

  /**
   * The case that failed on this file's first run, and the reason the function does
   * not say `Math.round(quantity * unitCents)`.
   *
   * `0045` turns this identity into a check constraint, so a divergence from
   * Postgres does not produce a wrong total — it produces a `23514` refusing a
   * write the API believed it had made correctly, on a line somebody typed
   * perfectly. `0.29` is a legal `numeric(12,2)` quantity and 50 cents is an
   * ordinary unit price, and the exact product is `14.50`: Postgres rounds it to
   * 15, while `0.29 * 50` in IEEE 754 is `14.499999999999998` and rounds to 14.
   *
   * The cases below were found by enumeration rather than by reasoning, which is
   * the honest way to have found them — the set of two-decimal quantities whose
   * product lands a hair under an exact half is not something anybody derives
   * correctly at a keyboard.
   */
  it('agrees with Postgres at the half-cent boundary, where IEEE 754 does not', () => {
    expect(0.29 * 50).toBeLessThan(14.5); // the float, for the record
    expect(Math.round(0.29 * 50)).toBe(14); // the wrong answer, for the record
    expect(lineTotalCents(0.29, 50)).toBe(15);
    // More of the same class, each an exact half the naive form lands below.
    expect(lineTotalCents(0.35, 90)).toBe(32); // 31.50
    expect(lineTotalCents(0.41, 150)).toBe(62); // 61.50
    expect(lineTotalCents(0.58, 25)).toBe(15); // 14.50
    expect(lineTotalCents(1.13, 50)).toBe(57); // 56.50
    expect(lineTotalCents(0.47, 2150)).toBe(1011); // 1010.50
  });

  it('rounds away from zero on a half, as numeric round() does', () => {
    // Neither column may be negative today; this is defence against a later signed
    // credit line rather than a live case. `Math.round(-14.5)` is -14, and Postgres
    // gives -15.
    expect(lineTotalCents(0.29, -50)).toBe(-15);
  });

  it('is exact for a large line rather than drifting a cent', () => {
    // 100_033 hundredths × 999_999 cents = 100_032_899_967, ÷ 100 = 1_000_328_999.67.
    expect(lineTotalCents(1000.33, 999_999)).toBe(1_000_329_000);
  });

  it('computes both sides of a line from the same function', () => {
    expect(computeLineTotals({ quantity: 3, unitCostCents: 1000, unitSellCents: 1500 })).toEqual({
      costCents: 3000,
      sellCents: 4500,
    });
  });

  it('sums the header from the lines and from nowhere else', () => {
    expect(
      computeVariationTotals([
        { quantity: 16, unitCostCents: 3750, unitSellCents: 5500 },
        { quantity: 1, unitCostCents: 24_000, unitSellCents: 31_000 },
      ])
    ).toEqual({ costTotalCents: 84_000, sellTotalCents: 119_000 });
  });

  it('totals an empty variation at zero rather than refusing it', () => {
    // A draft with no lines yet is the normal first state of every variation.
    expect(computeVariationTotals([])).toEqual({ costTotalCents: 0, sellTotalCents: 0 });
  });
});

describe('variation margin', () => {
  it('is null rather than 0% when nothing was sold', () => {
    // The whole reason this is not `calculateMargin`: that function returns 0 for a
    // zero bill, which is right for a project total and says "we made nothing" here
    // where the truth is "there is nothing to divide by".
    expect(variationMarginPct(0, 0)).toBeNull();
    expect(variationMarginPct(0, 5000)).toBeNull();
  });

  it('is two decimal places of the sell', () => {
    expect(variationMarginPct(119_000, 84_000)).toBeCloseTo(29.41, 2);
    expect(variationMarginPct(10_000, 12_000)).toBeCloseTo(-20, 2);
  });
});

describe('the line input schema', () => {
  it('lets a LABOUR line with a role arrive unpriced, for the rate engine', () => {
    const parsed = variationLineInputSchema.safeParse({
      kind: 'LABOUR',
      description: 'Extra doors, two riggers',
      quantity: 16,
      roleId: '11111111-1111-4111-8111-111111111111',
    });
    expect(parsed.success).toBe(true);
  });

  it('refuses an unpriced line the engine cannot price', () => {
    for (const line of [
      { kind: 'MATERIAL', description: 'Door frames', quantity: 4 },
      // LABOUR with no role: there is nothing to resolve a card against.
      { kind: 'LABOUR', description: 'Somebody, some hours', quantity: 4 },
    ]) {
      expect(variationLineInputSchema.safeParse(line).success).toBe(false);
    }
  });

  it('accepts a stated price for any kind', () => {
    const parsed = variationLineInputSchema.safeParse({
      kind: 'WASTE',
      description: 'Extra skip',
      quantity: 1,
      unitCostCents: 18_000,
      unitSellCents: 24_000,
    });
    expect(parsed.success).toBe(true);
  });

  it('has no field for a line total at all', () => {
    const parsed = variationLineInputSchema.parse({
      kind: 'OTHER',
      description: 'x',
      quantity: 2,
      unitCostCents: 100,
      unitSellCents: 200,
      // A caller's own arithmetic is not accepted, so it cannot be wrong.
      costCents: 999_999,
      sellCents: 999_999,
    } as unknown);
    expect(parsed).not.toHaveProperty('costCents');
    expect(parsed).not.toHaveProperty('sellCents');
  });
});

describe('the variation schemas', () => {
  it('ignores a caller-supplied header total (§12 step 7)', () => {
    const parsed = updateVariationSchema.parse({
      description: 'Extra doors',
      sellTotalCents: 999_999,
    } as unknown);
    expect(parsed).not.toHaveProperty('sellTotalCents');
    expect(parsed.description).toBe('Extra doors');
  });

  it('takes a clientId, because Femi is in a stairwell', () => {
    const parsed = createVariationSchema.parse({
      clientId: '22222222-2222-4222-8222-222222222222',
      description: 'Extra doors',
      requestedOn: '2027-06-04',
    });
    expect(parsed.clientId).toBe('22222222-2222-4222-8222-222222222222');
    expect(parsed.lines).toEqual([]);
  });

  it('refuses a rejection with no reason', () => {
    expect(rejectVariationSchema.safeParse({}).success).toBe(false);
    expect(rejectVariationSchema.safeParse({ reason: 'no' }).success).toBe(false);
    expect(rejectVariationSchema.safeParse({ reason: 'Client withdrew the request' }).success).toBe(
      true
    );
  });
});

describe('the double-billing notice — §13.2', () => {
  it('says nothing when there is nothing to say', () => {
    expect(variationTimesheetOverlapNotice(0)).toBeNull();
    expect(variationTimesheetOverlapNotice(-1)).toBeNull();
  });

  it('names the count and the consequence, and agrees with itself about number', () => {
    expect(variationTimesheetOverlapNotice(1)).toContain('1 approved timesheet falls');
    expect(variationTimesheetOverlapNotice(3)).toContain('3 approved timesheets fall');
    expect(variationTimesheetOverlapNotice(3)).toContain('twice');
  });
});
