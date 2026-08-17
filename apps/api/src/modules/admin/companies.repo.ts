import type {
  AdminCompanyDetail,
  AdminCompanyListQuery,
  AdminCompanySummary,
  AdminOverrideCreate,
  AdminOverrideView,
  AdminSetSubscription,
} from '@crewquo/shared';
import { query, queryOne } from '../../db';
import { AppError } from '../../http/errors';
import { resolveEntitlements } from '../entitlements/cache';
import { getAllUsage } from '../entitlements/usage';

/**
 * Super-admin companies console (CREWQUO_V2_PLAN.md §5B, §7).
 *
 * This is the support surface: who exists, what they resolve to, and the three
 * levers a platform operator has — an entitlement override, a comped trial, and
 * a forced plan change.
 *
 * **Nothing here re-derives an entitlement or a meter.** The detail view calls
 * `resolveEntitlements` and `getAllUsage`, the very functions every gate and
 * every `withinLimit` check go through, so the console cannot show a company an
 * allowance the product would refuse. Re-implementing the meters in SQL for the
 * list would be faster and would eventually disagree.
 */

interface CompanyRow {
  id: string;
  name: string;
  currency: string;
  is_placeholder: boolean;
  claimed_by_company_id: string | null;
  plan_id: string | null;
  subscription_status: AdminCompanySummary['subscriptionStatus'];
  trial_end: Date | null;
  current_period_end: Date | null;
  member_count: number;
  override_count: number;
  created_at: Date;
}

/** The plan a company with no subscription row resolves against — keep in step with `entitlements/repo.ts`. */
const DEFAULT_PLAN_ID = 'crew';

function toSummary(row: CompanyRow): AdminCompanySummary {
  return {
    id: row.id,
    name: row.name,
    currency: row.currency,
    isPlaceholder: row.is_placeholder,
    claimedByCompanyId: row.claimed_by_company_id,
    // A company with no subscription still has entitlements: the free plan.
    planId: row.plan_id ?? DEFAULT_PLAN_ID,
    subscriptionStatus: row.subscription_status,
    trialEnd: row.trial_end?.toISOString() ?? null,
    currentPeriodEnd: row.current_period_end?.toISOString() ?? null,
    memberCount: row.member_count,
    overrideCount: row.override_count,
    createdAt: row.created_at.toISOString(),
  };
}

const COMPANY_SELECT = `
  select c.id, c.name, c.currency, c.is_placeholder, c.claimed_by_company_id,
         s.plan_id, s.status as subscription_status, s.trial_end, s.current_period_end,
         (select count(*)::int from memberships m
           where m.company_id = c.id and m.status = 'ACTIVE') as member_count,
         (select count(*)::int from company_entitlement_overrides o
           where o.company_id = c.id
             and (o.expires_at is null or o.expires_at > now())) as override_count,
         c.created_at
    from companies c
    left join company_subscriptions s on s.company_id = c.id`;

/** Encode/decode the keyset cursor. Opaque to the caller (§7), exact on ties. */
function encodeCursor(row: CompanyRow): string {
  return Buffer.from(`${row.created_at.toISOString()}|${row.id}`).toString('base64url');
}

function decodeCursor(cursor: string): { createdAt: string; id: string } {
  const [createdAt, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  if (!createdAt || !id) throw new AppError('VALIDATION', 'Malformed cursor');
  return { createdAt, id };
}

export async function listCompanies(
  q: AdminCompanyListQuery
): Promise<{ data: AdminCompanySummary[]; nextCursor: string | null }> {
  const params: unknown[] = [];
  const where: string[] = [];

  if (!q.includePlaceholders) where.push('not c.is_placeholder');
  if (q.search) {
    params.push(`%${q.search}%`);
    // Name or an exact member email — the two things support is ever given.
    where.push(
      `(c.name ilike $${params.length}
        or exists (select 1 from memberships m join users u on u.id = m.user_id
                    where m.company_id = c.id and u.email ilike $${params.length}))`
    );
  }
  if (q.planId) {
    // `coalesce` so filtering by the free plan finds companies with no subscription
    // row at all — which is most of them, and the ones support most often wants.
    // Bound, not interpolated: no SQL in here is ever assembled from a value.
    params.push(q.planId, DEFAULT_PLAN_ID);
    where.push(`coalesce(s.plan_id, $${params.length}) = $${params.length - 1}`);
  }
  if (q.cursor) {
    const { createdAt, id } = decodeCursor(q.cursor);
    params.push(createdAt, id);
    where.push(`(c.created_at, c.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
  }

  // One extra row tells us whether another page exists without a second count query.
  params.push(q.limit + 1);
  const rows = await query<CompanyRow>(
    `${COMPANY_SELECT}
      ${where.length ? `where ${where.join(' and ')}` : ''}
      order by c.created_at desc, c.id desc
      limit $${params.length}`,
    params
  );

  const page = rows.slice(0, q.limit);
  const last = page[page.length - 1];
  return {
    data: page.map(toSummary),
    nextCursor: rows.length > q.limit && last ? encodeCursor(last) : null,
  };
}

function toOverrideView(row: {
  id: string;
  feature_key: AdminOverrideView['featureKey'];
  feature_enabled: boolean | null;
  limit_key: AdminOverrideView['limitKey'];
  limit_value: number | null;
  note: string | null;
  expires_at: Date | null;
  created_at: Date;
}): AdminOverrideView {
  return {
    id: row.id,
    featureKey: row.feature_key,
    featureEnabled: row.feature_enabled,
    limitKey: row.limit_key,
    limitValue: row.limit_value,
    note: row.note,
    expiresAt: row.expires_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
    expired: row.expires_at !== null && row.expires_at.getTime() <= Date.now(),
  };
}

/**
 * Every override row, expired ones included. The resolver ignores expired rows,
 * but hiding them from the console would make a lapsed grant look like it was
 * never made — which is the first thing anyone asks when a customer says a
 * feature stopped working.
 */
export async function listOverrides(companyId: string): Promise<AdminOverrideView[]> {
  const rows = await query<Parameters<typeof toOverrideView>[0]>(
    `select id, feature_key, feature_enabled, limit_key, limit_value, note, expires_at, created_at
       from company_entitlement_overrides
      where company_id = $1
      order by created_at desc`,
    [companyId]
  );
  return rows.map(toOverrideView);
}

/**
 * Does this company exist? Used by the three write routes before they act.
 *
 * A one-row lookup rather than `getCompanyDetail`, which resolves entitlements and
 * runs every usage meter — several queries to answer a yes/no question.
 */
export async function companyExists(companyId: string): Promise<boolean> {
  return (await queryOne(`select 1 from companies where id = $1`, [companyId])) !== null;
}

export async function getCompanyDetail(companyId: string): Promise<AdminCompanyDetail | null> {
  const row = await queryOne<CompanyRow>(`${COMPANY_SELECT} where c.id = $1`, [companyId]);
  if (!row) return null;

  const entitlements = await resolveEntitlements(companyId);
  const [usage, overrides] = await Promise.all([
    getAllUsage(companyId, entitlements.limits),
    listOverrides(companyId),
  ]);
  return { company: toSummary(row), entitlements, usage, overrides };
}

export async function insertOverride(
  companyId: string,
  input: AdminOverrideCreate
): Promise<AdminOverrideView> {
  const rows = await query<Parameters<typeof toOverrideView>[0]>(
    `insert into company_entitlement_overrides
       (company_id, feature_key, feature_enabled, limit_key, limit_value, note, expires_at)
     values ($1, $2, $3, $4, $5, $6, $7)
     returning id, feature_key, feature_enabled, limit_key, limit_value, note, expires_at, created_at`,
    [
      companyId,
      input.featureKey ?? null,
      input.featureEnabled ?? null,
      input.limitKey ?? null,
      // `?? null` is correct for both branches: an unlimited limit override *is*
      // a null value, and a feature override has no limit value at all.
      input.limitValue ?? null,
      input.note ?? null,
      input.expiresAt ?? null,
    ]
  );
  return toOverrideView(rows[0]!);
}

/** Delete one override. Returns null when it does not belong to that company. */
export async function deleteOverride(
  companyId: string,
  overrideId: string
): Promise<AdminOverrideView | null> {
  const rows = await query<Parameters<typeof toOverrideView>[0]>(
    `delete from company_entitlement_overrides
      where company_id = $1 and id = $2
      returning id, feature_key, feature_enabled, limit_key, limit_value, note, expires_at, created_at`,
    [companyId, overrideId]
  );
  return rows[0] ? toOverrideView(rows[0]) : null;
}

/** The subscription as it stands, for auditing both sides of a change. */
export async function getSubscription(companyId: string): Promise<{
  planId: string;
  status: string;
  trialEnd: string | null;
} | null> {
  const row = await queryOne<{ plan_id: string; status: string; trial_end: Date | null }>(
    `select plan_id, status, trial_end from company_subscriptions where company_id = $1`,
    [companyId]
  );
  return row
    ? { planId: row.plan_id, status: row.status, trialEnd: row.trial_end?.toISOString() ?? null }
    : null;
}

export async function assertPlanExists(planId: string): Promise<void> {
  const plan = await queryOne(`select 1 from plans where id = $1`, [planId]);
  if (!plan) throw new AppError('VALIDATION', `Plan '${planId}' does not exist`);
}

/**
 * Force a plan/status. `unique (company_id)` on `company_subscriptions` makes this
 * an upsert, so a company that never subscribed and one changing plans take the
 * same path.
 *
 * `entitlements_snapshot` is deliberately left alone: snapshot grandfathering is
 * Phase 6 (§5B), and writing a snapshot here would create rows that later billing
 * code has to interpret without knowing what wrote them.
 */
export async function setSubscription(
  companyId: string,
  input: AdminSetSubscription
): Promise<void> {
  await query(
    `insert into company_subscriptions
       (company_id, plan_id, status, currency, interval, current_period_end)
     values ($1, $2, $3, $4, $5, $6)
     on conflict (company_id) do update set
       plan_id = excluded.plan_id,
       status = excluded.status,
       currency = coalesce(excluded.currency, company_subscriptions.currency),
       interval = coalesce(excluded.interval, company_subscriptions.interval),
       current_period_end = excluded.current_period_end,
       updated_at = now()`,
    [
      companyId,
      input.planId,
      input.status,
      input.currency ?? null,
      input.interval ?? null,
      input.currentPeriodEnd ?? null,
    ]
  );
}

/**
 * Comp or extend a trial. The new end date is measured from whichever is later,
 * *now* or the existing `trial_end`: "give them another 14 days" on a live trial
 * means adding to it, while the same words on a lapsed one mean starting again.
 * Reading the current value and extending from it is the only way both are true.
 */
export async function compTrial(
  companyId: string,
  planId: string,
  days: number
): Promise<{ trialEnd: string }> {
  const rows = await query<{ trial_end: Date }>(
    `insert into company_subscriptions (company_id, plan_id, status, trial_end)
     values ($1, $2, 'TRIALING', now() + make_interval(days => $3))
     on conflict (company_id) do update set
       plan_id = excluded.plan_id,
       status = 'TRIALING',
       trial_end = greatest(coalesce(company_subscriptions.trial_end, now()), now())
                   + make_interval(days => $3),
       updated_at = now()
     returning trial_end`,
    [companyId, planId, days]
  );
  return { trialEnd: rows[0]!.trial_end.toISOString() };
}
