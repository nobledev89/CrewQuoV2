import { describe, expect, it } from 'vitest';
import {
  RATE_PROPOSAL_TRANSITIONS,
  createRateProposalSchema,
  currencyBoundaryRefusal,
  dueDateFromPaymentTerms,
  duplicateScheduleLineIndex,
  isRateProposalEditable,
  isRateProposalTerminal,
  isRetroactive,
  previousIsoDate,
  purchaseOrderCeilingRefusal,
  rateProposalLineInputSchema,
  rateProposalTransitionRefusal,
  supersededEffectiveTo,
  updateEngagementTermsSchema,
} from './commercial';
import { RATE_PROPOSAL_STATUSES, type RateProposalStatus } from './enums';

/**
 * One test per rule (§13, §44). The commercial state machine and the money
 * boundary are the two places in this domain where a wrong answer costs somebody
 * real money, so both are pinned exhaustively rather than by sampling.
 */

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

describe('rate proposal state machine', () => {
  it('declares exactly the four transitions the packet specifies', () => {
    expect(
      RATE_PROPOSAL_TRANSITIONS.map((t) => `${t.from}->${t.to}:${t.side}`)
    ).toEqual([
      'DRAFT->SUBMITTED:provider',
      'SUBMITTED->APPROVED:client',
      'SUBMITTED->REJECTED:client',
      'SUBMITTED->WITHDRAWN:provider',
    ]);
  });

  it('has no transition out of a terminal state', () => {
    // `from` is widened deliberately: TypeScript narrows the literal union tightly
    // enough that it can prove this comparison impossible, which is the invariant
    // holding at compile time. The runtime assertion still earns its place — it is
    // what fails if somebody later adds a reopen transition to the table.
    const sources: string[] = RATE_PROPOSAL_TRANSITIONS.map((t) => t.from);
    for (const terminal of ['APPROVED', 'REJECTED', 'WITHDRAWN'] as const) {
      expect(sources).not.toContain(terminal);
      expect(isRateProposalTerminal(terminal)).toBe(true);
    }
    expect(isRateProposalTerminal('DRAFT')).toBe(false);
    expect(isRateProposalTerminal('SUBMITTED')).toBe(false);
  });

  it('makes only a DRAFT editable — a submitted payload is frozen', () => {
    expect(isRateProposalEditable('DRAFT')).toBe(true);
    for (const status of RATE_PROPOSAL_STATUSES.filter((s) => s !== 'DRAFT')) {
      expect(isRateProposalEditable(status)).toBe(false);
    }
  });

  const ok = (args: Parameters<typeof rateProposalTransitionRefusal>[0]) =>
    rateProposalTransitionRefusal(args);

  it('lets the provider submit its own draft', () => {
    expect(
      ok({ verb: 'submit', status: 'DRAFT', actorSide: 'provider', actorIsManager: true })
    ).toBeNull();
  });

  it('lets the hiring side approve and reject a submitted schedule', () => {
    expect(
      ok({ verb: 'approve', status: 'SUBMITTED', actorSide: 'client', actorIsManager: true })
    ).toBeNull();
    expect(
      ok({ verb: 'reject', status: 'SUBMITTED', actorSide: 'client', actorIsManager: true })
    ).toBeNull();
  });

  it('refuses a provider approving its own schedule', () => {
    expect(
      ok({ verb: 'approve', status: 'SUBMITTED', actorSide: 'provider', actorIsManager: true })
    ).toMatch(/only the hiring company/i);
  });

  it('refuses the hiring side submitting on the provider’s behalf', () => {
    expect(
      ok({ verb: 'submit', status: 'DRAFT', actorSide: 'client', actorIsManager: true })
    ).toMatch(/only the provider side/i);
  });

  it('refuses the hiring side withdrawing a schedule it did not author', () => {
    expect(
      ok({ verb: 'withdraw', status: 'SUBMITTED', actorSide: 'client', actorIsManager: true })
    ).toMatch(/only the provider side/i);
  });

  it('refuses a MEMBER on either side', () => {
    expect(
      ok({ verb: 'submit', status: 'DRAFT', actorSide: 'provider', actorIsManager: false })
    ).toMatch(/manager/i);
    expect(
      ok({ verb: 'approve', status: 'SUBMITTED', actorSide: 'client', actorIsManager: false })
    ).toMatch(/manager/i);
  });

  it('reports an already-decided schedule as decided, not as a permission problem', () => {
    for (const status of ['APPROVED', 'REJECTED', 'WITHDRAWN'] as RateProposalStatus[]) {
      expect(
        ok({ verb: 'approve', status, actorSide: 'client', actorIsManager: true })
      ).toBe(`This schedule is already ${status.toLowerCase()}`);
    }
  });

  it('refuses approving a draft the provider has not submitted yet', () => {
    expect(
      ok({ verb: 'approve', status: 'DRAFT', actorSide: 'client', actorIsManager: true })
    ).toMatch(/draft schedule cannot be approved/i);
  });

  it('refuses re-submitting an already submitted schedule', () => {
    expect(
      ok({ verb: 'submit', status: 'SUBMITTED', actorSide: 'provider', actorIsManager: true })
    ).toMatch(/submitted schedule cannot be submitted/i);
  });

  it('rejects an unknown verb rather than defaulting to allow', () => {
    expect(
      ok({
        verb: 'delete' as any,
        status: 'DRAFT',
        actorSide: 'provider',
        actorIsManager: true,
      })
    ).toMatch(/unknown action/i);
  });
});

describe('effective dating', () => {
  it('steps back one day in UTC', () => {
    expect(previousIsoDate('2026-04-01')).toBe('2026-03-31');
    expect(previousIsoDate('2026-01-01')).toBe('2025-12-31');
    expect(previousIsoDate('2026-03-01')).toBe('2026-02-28');
    expect(previousIsoDate('2024-03-01')).toBe('2024-02-29'); // leap year
  });

  it('closes a superseded window the day before the successor opens, never same-day', () => {
    expect(supersededEffectiveTo('2026-04-01')).toBe('2026-03-31');
    expect(supersededEffectiveTo('2026-04-01') < '2026-04-01').toBe(true);
  });

  it('treats only a past effective date as retroactive', () => {
    expect(isRetroactive('2026-08-17', '2026-08-18')).toBe(true);
    expect(isRetroactive('2026-08-18', '2026-08-18')).toBe(false); // today is not retroactive
    expect(isRetroactive('2026-09-01', '2026-08-18')).toBe(false);
  });
});

describe('currency boundary', () => {
  it('allows a schedule in the hiring company’s own currency', () => {
    expect(currencyBoundaryRefusal('USD', 'USD')).toBeNull();
  });

  it('refuses unlike currencies and says what is missing', () => {
    const refusal = currencyBoundaryRefusal('GBP', 'USD');
    expect(refusal).toContain('GBP');
    expect(refusal).toContain('USD');
    expect(refusal).toMatch(/no exchange rate/i);
    expect(refusal).toMatch(/FX snapshot/i);
  });
});

describe('purchase-order ceiling', () => {
  it('is inert when the engagement carries no ceiling', () => {
    expect(
      purchaseOrderCeilingRefusal({
        ceilingCents: null,
        committedCents: 999_999_99,
        incomingCents: 100_00,
        currency: 'USD',
      })
    ).toBeNull();
  });

  it('allows a total that exactly reaches the ceiling', () => {
    expect(
      purchaseOrderCeilingRefusal({
        ceilingCents: 100_000,
        committedCents: 60_000,
        incomingCents: 40_000,
        currency: 'USD',
      })
    ).toBeNull();
  });

  it('refuses one cent over, and names all three figures', () => {
    const refusal = purchaseOrderCeilingRefusal({
      ceilingCents: 100_000,
      committedCents: 60_000,
      incomingCents: 40_001,
      currency: 'USD',
    });
    expect(refusal).toContain('USD 1000.00'); // the ceiling
    expect(refusal).toContain('USD 600.00'); // already committed
    expect(refusal).toContain('USD 400.01'); // this invoice
    expect(refusal).toContain('USD 1000.01'); // the total
  });
});

describe('payment terms', () => {
  it('returns null when the edge carries no terms — no invented due date', () => {
    expect(dueDateFromPaymentTerms('2026-08-18T00:00:00.000Z', null)).toBeNull();
  });

  it('adds the agreed days to the issue instant', () => {
    expect(dueDateFromPaymentTerms('2026-08-18T09:30:00.000Z', 30)).toBe(
      '2026-09-17T09:30:00.000Z'
    );
  });

  it('handles zero-day (due on issue) terms', () => {
    expect(dueDateFromPaymentTerms('2026-08-18T09:30:00.000Z', 0)).toBe(
      '2026-08-18T09:30:00.000Z'
    );
  });

  it('crosses a year boundary correctly', () => {
    expect(dueDateFromPaymentTerms('2026-12-20T00:00:00.000Z', 45)).toBe(
      '2027-02-03T00:00:00.000Z'
    );
  });
});

describe('schedule line validation', () => {
  const line = (over: Record<string, unknown> = {}) => ({
    operation: 'CREATE',
    roleId: uuid(1),
    rateLabel: 'MON_FRI_DAY',
    rateMode: 'HOURLY',
    hourlyRateCents: 5000,
    ...over,
  });

  it('accepts an HOURLY CREATE line', () => {
    expect(rateProposalLineInputSchema.safeParse(line()).success).toBe(true);
  });

  it('requires the amount the mode names', () => {
    expect(
      rateProposalLineInputSchema.safeParse(line({ hourlyRateCents: null })).success
    ).toBe(false);
    expect(
      rateProposalLineInputSchema.safeParse(
        line({ rateMode: 'SHIFT', hourlyRateCents: null, shiftRateCents: 30_000 })
      ).success
    ).toBe(true);
    expect(
      rateProposalLineInputSchema.safeParse(
        line({ rateMode: 'DAILY', hourlyRateCents: null })
      ).success
    ).toBe(false);
  });

  it('requires REPLACE and END to name the version they supersede', () => {
    expect(rateProposalLineInputSchema.safeParse(line({ operation: 'REPLACE' })).success).toBe(
      false
    );
    expect(
      rateProposalLineInputSchema.safeParse(
        line({ operation: 'REPLACE', replacesRateCardId: uuid(2) })
      ).success
    ).toBe(true);
  });

  it('refuses a CREATE line that names one to supersede', () => {
    expect(
      rateProposalLineInputSchema.safeParse(line({ replacesRateCardId: uuid(2) })).success
    ).toBe(false);
  });

  it('refuses an END line that carries an amount', () => {
    expect(
      rateProposalLineInputSchema.safeParse(
        line({ operation: 'END', replacesRateCardId: uuid(2), hourlyRateCents: null })
      ).success
    ).toBe(true);
    expect(
      rateProposalLineInputSchema.safeParse(
        line({ operation: 'END', replacesRateCardId: uuid(2), hourlyRateCents: 5000 })
      ).success
    ).toBe(false);
  });

  it('finds a duplicate (role, label) pair by index', () => {
    expect(
      duplicateScheduleLineIndex([
        { roleId: uuid(1), rateLabel: 'MON_FRI_DAY' },
        { roleId: uuid(1), rateLabel: 'SUNDAY' },
        { roleId: uuid(2), rateLabel: 'MON_FRI_DAY' },
      ])
    ).toBe(-1);
    expect(
      duplicateScheduleLineIndex([
        { roleId: uuid(1), rateLabel: 'MON_FRI_DAY' },
        { roleId: uuid(1), rateLabel: 'MON_FRI_DAY' },
      ])
    ).toBe(1);
  });

  it('refuses a whole schedule that prices one role and label twice', () => {
    const result = createRateProposalSchema.safeParse({
      engagementId: uuid(9),
      effectiveFrom: '2026-09-01',
      lines: [line(), line({ hourlyRateCents: 6000 })],
    });
    expect(result.success).toBe(false);
  });

  it('refuses an empty schedule', () => {
    const result = createRateProposalSchema.safeParse({
      engagementId: uuid(9),
      effectiveFrom: '2026-09-01',
      lines: [],
    });
    expect(result.success).toBe(false);
  });

  it('never lets the caller name the proposing company', () => {
    const parsed = createRateProposalSchema.parse({
      engagementId: uuid(9),
      effectiveFrom: '2026-09-01',
      lines: [line()],
      proposedByCompanyId: uuid(666),
    });
    expect(parsed).not.toHaveProperty('proposedByCompanyId');
  });
});

describe('engagement terms', () => {
  it('accepts a partial patch and rejects an empty one', () => {
    expect(updateEngagementTermsSchema.safeParse({ paymentTermsDays: 30 }).success).toBe(true);
    expect(updateEngagementTermsSchema.safeParse({}).success).toBe(false);
  });

  it('treats a reason alone as nothing to update', () => {
    // A reason explains a change; on its own it would write a revision recording
    // that nothing happened.
    expect(updateEngagementTermsSchema.safeParse({ reason: 'because' }).success).toBe(false);
  });

  it('allows clearing terms with an explicit null', () => {
    const parsed = updateEngagementTermsSchema.parse({ purchaseOrderCeilingCents: null });
    expect(parsed.purchaseOrderCeilingCents).toBeNull();
  });

  it('holds payment terms to a sane range', () => {
    expect(updateEngagementTermsSchema.safeParse({ paymentTermsDays: 0 }).success).toBe(true);
    expect(updateEngagementTermsSchema.safeParse({ paymentTermsDays: 365 }).success).toBe(true);
    expect(updateEngagementTermsSchema.safeParse({ paymentTermsDays: -1 }).success).toBe(false);
    expect(updateEngagementTermsSchema.safeParse({ paymentTermsDays: 366 }).success).toBe(false);
  });
});
