import type {
  AdminPlanCreate,
  AdminPlanPrice,
  AdminPlanPriceView,
  AdminPlanUpdate,
  AdminPlanView,
  FeatureKey,
  LimitKey,
} from '@crewquo/shared';
import type pg from 'pg';
import { query, queryOne, withTransaction, type Queryable } from '../../db';
import { AppError } from '../../http/errors';

interface PlanRow {
  id: string;
  name: string;
  description: string | null;
  status: AdminPlanView['status'];
  is_public: boolean;
  operates_downstream: boolean;
  sort_order: number;
  trial_days: number;
}

async function loadFeatures(planId: string, runner?: Queryable): Promise<FeatureKey[]> {
  const rows = await query<{ feature_key: FeatureKey }>(
    `select feature_key from plan_features where plan_id = $1 order by feature_key`,
    [planId],
    runner
  );
  return rows.map((r) => r.feature_key);
}

async function loadLimits(
  planId: string,
  runner?: Queryable
): Promise<Record<string, number | null>> {
  const rows = await query<{ limit_key: LimitKey; value: number | null }>(
    `select limit_key, value from plan_limits where plan_id = $1`,
    [planId],
    runner
  );
  const out: Record<string, number | null> = {};
  for (const r of rows) out[r.limit_key] = r.value;
  return out;
}

async function loadPrices(planId: string, runner?: Queryable): Promise<AdminPlanPriceView[]> {
  return query<AdminPlanPriceView>(
    `select id, currency, interval, amount_cents as "amountCents",
            provider_price_id as "providerPriceId", active
       from plan_prices where plan_id = $1
      order by currency, interval`,
    [planId],
    runner
  );
}

async function assembleView(row: PlanRow, runner?: Queryable): Promise<AdminPlanView> {
  const [features, limits, prices] = await Promise.all([
    loadFeatures(row.id, runner),
    loadLimits(row.id, runner),
    loadPrices(row.id, runner),
  ]);
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    status: row.status,
    isPublic: row.is_public,
    operatesDownstream: row.operates_downstream,
    sortOrder: row.sort_order,
    trialDays: row.trial_days,
    features,
    limits,
    prices,
  };
}

const PLAN_COLUMNS =
  'id, name, description, status, is_public, operates_downstream, sort_order, trial_days';

export async function listPlans(): Promise<AdminPlanView[]> {
  const rows = await query<PlanRow>(`select ${PLAN_COLUMNS} from plans order by sort_order, id`);
  return Promise.all(rows.map((r) => assembleView(r)));
}

export async function getPlan(id: string): Promise<AdminPlanView | null> {
  const row = await queryOne<PlanRow>(`select ${PLAN_COLUMNS} from plans where id = $1`, [id]);
  return row ? assembleView(row) : null;
}

async function replaceFeatures(
  client: pg.PoolClient,
  planId: string,
  features: FeatureKey[]
): Promise<void> {
  await client.query('delete from plan_features where plan_id = $1', [planId]);
  for (const key of features) {
    await client.query(
      'insert into plan_features (plan_id, feature_key) values ($1, $2) on conflict do nothing',
      [planId, key]
    );
  }
}

async function replaceLimits(
  client: pg.PoolClient,
  planId: string,
  limits: Record<string, number | null>
): Promise<void> {
  await client.query('delete from plan_limits where plan_id = $1', [planId]);
  for (const [key, value] of Object.entries(limits)) {
    await client.query('insert into plan_limits (plan_id, limit_key, value) values ($1, $2, $3)', [
      planId,
      key,
      value,
    ]);
  }
}

export async function createPlan(input: AdminPlanCreate): Promise<AdminPlanView> {
  const exists = await queryOne(`select 1 from plans where id = $1`, [input.id]);
  if (exists) throw new AppError('CONFLICT', `Plan '${input.id}' already exists`);

  await withTransaction(async (client) => {
    await client.query(
      `insert into plans (id, name, description, status, is_public, operates_downstream, sort_order, trial_days)
       values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        input.id,
        input.name,
        input.description ?? null,
        input.status,
        input.isPublic,
        input.operatesDownstream,
        input.sortOrder,
        input.trialDays,
      ]
    );
    await replaceFeatures(client, input.id, input.features);
    await replaceLimits(client, input.id, input.limits);
  });

  return (await getPlan(input.id))!;
}

export async function updatePlan(id: string, patch: AdminPlanUpdate): Promise<AdminPlanView> {
  const existing = await queryOne<PlanRow>(`select ${PLAN_COLUMNS} from plans where id = $1`, [id]);
  if (!existing) throw new AppError('NOT_FOUND', `Plan '${id}' not found`);

  await withTransaction(async (client) => {
    // Column updates — coalesce to keep unspecified fields.
    await client.query(
      `update plans set
         name = coalesce($2, name),
         description = coalesce($3, description),
         status = coalesce($4, status),
         is_public = coalesce($5, is_public),
         operates_downstream = coalesce($6, operates_downstream),
         sort_order = coalesce($7, sort_order),
         trial_days = coalesce($8, trial_days),
         updated_at = now()
       where id = $1`,
      [
        id,
        patch.name ?? null,
        patch.description ?? null,
        patch.status ?? null,
        patch.isPublic ?? null,
        patch.operatesDownstream ?? null,
        patch.sortOrder ?? null,
        patch.trialDays ?? null,
      ]
    );
    if (patch.features !== undefined) await replaceFeatures(client, id, patch.features);
    if (patch.limits !== undefined) await replaceLimits(client, id, patch.limits);
  });

  return (await getPlan(id))!;
}

export async function upsertPlanPrice(
  planId: string,
  price: AdminPlanPrice
): Promise<AdminPlanPriceView> {
  const plan = await queryOne(`select 1 from plans where id = $1`, [planId]);
  if (!plan) throw new AppError('NOT_FOUND', `Plan '${planId}' not found`);

  const rows = await query<AdminPlanPriceView>(
    `insert into plan_prices (plan_id, currency, interval, amount_cents, provider_price_id, active)
     values ($1, $2, $3, $4, $5, $6)
     on conflict (plan_id, currency, interval) do update set
       amount_cents = excluded.amount_cents,
       provider_price_id = excluded.provider_price_id,
       active = excluded.active,
       updated_at = now()
     returning id, currency, interval, amount_cents as "amountCents",
               provider_price_id as "providerPriceId", active`,
    [planId, price.currency, price.interval, price.amountCents, price.providerPriceId ?? null, price.active]
  );
  return rows[0]!;
}

export function listFeatureCatalog() {
  return query(`select key, name, description, category from features order by category, key`);
}

export function listLimitCatalog() {
  return query(
    `select key, name, description, unit, unlimited_allowed as "unlimitedAllowed"
       from limits order by key`
  );
}
