import { describe, expect, it } from 'vitest';
import { mergeEntitlements, type EntitlementsBase } from './merge';

const starterBase: EntitlementsBase = {
  planId: 'starter',
  operatesDownstream: true,
  features: ['rate_cards', 'holiday_rates', 'exports', 'client_portal'],
  limits: { active_subcontractors: 5, internal_seats: 2, audit_retention_days: 30 },
};

describe('mergeEntitlements', () => {
  it('returns the plan base when there are no overrides', () => {
    const ent = mergeEntitlements(starterBase, []);
    expect(ent.planId).toBe('starter');
    expect(ent.operatesDownstream).toBe(true);
    expect(ent.features).toEqual(['rate_cards', 'holiday_rates', 'exports', 'client_portal']);
    expect(ent.limits.active_subcontractors).toBe(5);
  });

  it('features are returned in catalog order regardless of base order', () => {
    const base: EntitlementsBase = { ...starterBase, features: ['exports', 'rate_cards'] };
    const ent = mergeEntitlements(base, []);
    expect(ent.features).toEqual(['rate_cards', 'exports']);
  });

  it('an override can enable a feature not in the plan', () => {
    const ent = mergeEntitlements(starterBase, [
      { featureKey: 'invoicing', featureEnabled: true },
    ]);
    expect(ent.features).toContain('invoicing');
  });

  it('an override can disable a plan feature', () => {
    const ent = mergeEntitlements(starterBase, [
      { featureKey: 'exports', featureEnabled: false },
    ]);
    expect(ent.features).not.toContain('exports');
  });

  it('an override can raise a limit', () => {
    const ent = mergeEntitlements(starterBase, [
      { limitKey: 'active_subcontractors', limitValue: 25 },
    ]);
    expect(ent.limits.active_subcontractors).toBe(25);
  });

  it('an override with null limit value means unlimited', () => {
    const ent = mergeEntitlements(starterBase, [
      { limitKey: 'active_subcontractors', limitValue: null },
    ]);
    expect(ent.limits.active_subcontractors).toBeNull();
  });

  it('later overrides win over earlier ones', () => {
    const ent = mergeEntitlements(starterBase, [
      { limitKey: 'internal_seats', limitValue: 10 },
      { limitKey: 'internal_seats', limitValue: 3 },
    ]);
    expect(ent.limits.internal_seats).toBe(3);
  });

  it('ignores unknown feature/limit keys', () => {
    const ent = mergeEntitlements(starterBase, [
      { featureKey: 'not_a_feature' as never, featureEnabled: true },
      { limitKey: 'not_a_limit' as never, limitValue: 99 },
    ]);
    expect(ent.features).toEqual(starterBase.features);
    expect(ent.limits).not.toHaveProperty('not_a_limit');
  });
});
