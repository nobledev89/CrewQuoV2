import { describe, expect, it } from 'vitest';
import type { RateCardView } from '@crewquo/shared';
import { pickEffectiveCard } from './resolve';

function card(overrides: Partial<RateCardView>): RateCardView {
  return {
    id: 'card-default',
    companyId: 'co-1',
    kind: 'PAY',
    counterpartyCompanyId: null,
    roleId: 'role-1',
    rateMode: 'HOURLY',
    rateLabel: 'MON_FRI_DAY',
    hourlyRateCents: 5000,
    otHourlyRateCents: null,
    shiftRateCents: null,
    dailyRateCents: null,
    minHours: null,
    weekendMultiplier: null,
    nightMultiplier: null,
    effectiveFrom: '2026-01-01',
    effectiveTo: null,
    active: true,
    // Approved-version provenance (Phase 6). A hand-entered card is version 1,
    // unlocked, sourced from no proposal, and inherits the company currency.
    currency: null,
    version: 1,
    locked: false,
    sourceProposalId: null,
    supersedesRateCardId: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('pickEffectiveCard — counterparty preference', () => {
  const def = card({ id: 'default', counterpartyCompanyId: null });
  const specific = card({ id: 'specific', counterpartyCompanyId: 'cp-1' });

  it('prefers a counterparty-specific card over the default', () => {
    expect(pickEffectiveCard([def, specific], '2026-07-01', 'cp-1')?.id).toBe('specific');
  });

  it('falls back to the default when the counterparty has no effective card', () => {
    const staleSpecific = card({
      id: 'specific',
      counterpartyCompanyId: 'cp-1',
      effectiveTo: '2026-06-30', // expired before the date
    });
    expect(pickEffectiveCard([def, staleSpecific], '2026-07-01', 'cp-1')?.id).toBe('default');
  });

  it('ignores a different counterparty than the one requested', () => {
    const otherCp = card({ id: 'other', counterpartyCompanyId: 'cp-2' });
    expect(pickEffectiveCard([def, otherCp], '2026-07-01', 'cp-1')?.id).toBe('default');
  });

  it('uses only default cards when no counterparty is given', () => {
    expect(pickEffectiveCard([def, specific], '2026-07-01', undefined)?.id).toBe('default');
  });

  it('returns null when nothing is effective', () => {
    const future = card({ effectiveFrom: '2026-09-01' });
    expect(pickEffectiveCard([future], '2026-07-01', undefined)).toBeNull();
  });
});
