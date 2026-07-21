import type { Entitlements, FeatureKey, LimitKey } from '@crewquo/shared';
import { FEATURE_KEYS, LIMIT_KEYS } from '@crewquo/shared';

/** The plan-level base before company overrides are applied. */
export interface EntitlementsBase {
  planId: string;
  operatesDownstream: boolean;
  features: FeatureKey[];
  limits: Partial<Record<LimitKey, number | null>>;
}

/** A single company_entitlement_overrides row (already filtered to non-expired). */
export interface EntitlementOverride {
  featureKey?: FeatureKey | null;
  featureEnabled?: boolean | null;
  limitKey?: LimitKey | null;
  limitValue?: number | null;
}

const isFeatureKey = (k: string): k is FeatureKey => (FEATURE_KEYS as readonly string[]).includes(k);
const isLimitKey = (k: string): k is LimitKey => (LIMIT_KEYS as readonly string[]).includes(k);

/**
 * Resolve effective entitlements = plan base ⊕ company overrides (CREWQUO_V2_PLAN.md §5B).
 * Pure function — no I/O — so the merge logic is unit-testable in isolation.
 * An override with a feature key toggles that feature; one with a limit key sets
 * that limit's value (null = unlimited). Later overrides win.
 */
export function mergeEntitlements(
  base: EntitlementsBase,
  overrides: EntitlementOverride[]
): Entitlements {
  const features = new Set<FeatureKey>(base.features.filter(isFeatureKey));
  const limits = new Map<LimitKey, number | null>();
  for (const key of LIMIT_KEYS) {
    if (key in base.limits) limits.set(key, base.limits[key] ?? null);
  }

  for (const ov of overrides) {
    if (ov.featureKey && isFeatureKey(ov.featureKey) && typeof ov.featureEnabled === 'boolean') {
      if (ov.featureEnabled) features.add(ov.featureKey);
      else features.delete(ov.featureKey);
    }
    if (ov.limitKey && isLimitKey(ov.limitKey)) {
      // limitValue null = unlimited; the key being present is the signal to override.
      limits.set(ov.limitKey, ov.limitValue ?? null);
    }
  }

  return {
    planId: base.planId,
    operatesDownstream: base.operatesDownstream,
    features: FEATURE_KEYS.filter((k) => features.has(k)),
    limits: Object.fromEntries(limits) as Entitlements['limits'],
  };
}
