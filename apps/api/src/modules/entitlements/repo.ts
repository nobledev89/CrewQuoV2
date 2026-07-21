import type { Entitlements, FeatureKey, LimitKey } from '@crewquo/shared';
import { query, queryOne } from '../../db';
import { mergeEntitlements, type EntitlementOverride, type EntitlementsBase } from './merge';

const DEFAULT_PLAN_ID = 'crew'; // free plan applied when a company has no subscription

interface PlanRow {
  id: string;
  operates_downstream: boolean;
}

/**
 * Load the plan-level base for a company: its subscribed plan (or the free
 * default), plus that plan's feature keys and limit values.
 */
async function loadBase(companyId: string): Promise<EntitlementsBase> {
  const sub = await queryOne<{ plan_id: string }>(
    `select plan_id from company_subscriptions where company_id = $1`,
    [companyId]
  );
  const planId = sub?.plan_id ?? DEFAULT_PLAN_ID;

  const plan = await queryOne<PlanRow>(
    `select id, operates_downstream from plans where id = $1`,
    [planId]
  );

  const features = await query<{ feature_key: FeatureKey }>(
    `select feature_key from plan_features where plan_id = $1`,
    [planId]
  );
  const limits = await query<{ limit_key: LimitKey; value: number | null }>(
    `select limit_key, value from plan_limits where plan_id = $1`,
    [planId]
  );

  const limitMap: EntitlementsBase['limits'] = {};
  for (const row of limits) limitMap[row.limit_key] = row.value;

  return {
    planId,
    operatesDownstream: plan?.operates_downstream ?? false,
    features: features.map((f) => f.feature_key),
    limits: limitMap,
  };
}

async function loadOverrides(companyId: string): Promise<EntitlementOverride[]> {
  const rows = await query<{
    feature_key: FeatureKey | null;
    feature_enabled: boolean | null;
    limit_key: LimitKey | null;
    limit_value: number | null;
  }>(
    `select feature_key, feature_enabled, limit_key, limit_value
       from company_entitlement_overrides
      where company_id = $1 and (expires_at is null or expires_at > now())
      order by created_at asc`,
    [companyId]
  );
  return rows.map((r) => ({
    featureKey: r.feature_key,
    featureEnabled: r.feature_enabled,
    limitKey: r.limit_key,
    limitValue: r.limit_value,
  }));
}

/** Resolve effective entitlements for a company (base ⊕ overrides). */
export async function resolveEntitlementsFromDb(companyId: string): Promise<Entitlements> {
  const [base, overrides] = await Promise.all([loadBase(companyId), loadOverrides(companyId)]);
  return mergeEntitlements(base, overrides);
}
