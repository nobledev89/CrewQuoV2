import 'dotenv/config';
import pg from 'pg';

const { Client } = pg;

/**
 * Seed the entitlements catalog and the default plans (CREWQUO_V2_PLAN.md §5B).
 * Idempotent: every row is upserted, so re-running is safe. Prices are seeded
 * for USD only (the documented anchors); other currencies are configured by the
 * super admin (open item #1). Plans are editable data — these are just defaults.
 */

const FEATURES: Array<[key: string, name: string, category: string]> = [
  ['rate_cards', 'Rate cards', 'rates'],
  ['holiday_rates', 'Holiday rates', 'rates'],
  ['exports', 'Exports (PDF/XLSX)', 'reporting'],
  ['client_portal', 'Client portal', 'portal'],
  ['client_portal_notes', 'Client portal notes', 'portal'],
  ['invoicing', 'Invoicing', 'billing'],
  ['audit_visibility', 'Audit trail visibility', 'portal'],
  ['api_access', 'API access', 'platform'],
  ['sso', 'Single sign-on', 'platform'],
  ['white_label', 'White label', 'platform'],
];

const LIMITS: Array<[key: string, name: string, unit: string]> = [
  ['active_subcontractors', 'Active subcontractors', 'count'],
  ['internal_seats', 'Internal seats', 'count'],
  ['clients', 'Clients (real portal logins)', 'count'],
  ['audit_retention_days', 'Audit retention', 'days'],
];

type PlanSeed = {
  id: string;
  name: string;
  description: string;
  operatesDownstream: boolean;
  sortOrder: number;
  trialDays: number;
  features: string[];
  limits: Record<string, number | null>; // null = unlimited
  prices: Array<{ currency: string; interval: 'MONTH' | 'YEAR'; amountCents: number }>;
};

const ALL_FEATURES = FEATURES.map(([key]) => key);

const PLANS: PlanSeed[] = [
  {
    id: 'crew',
    name: 'Crew',
    description: 'Be a subcontractor: log time and submit up. Free forever.',
    operatesDownstream: false,
    sortOrder: 0,
    trialDays: 0,
    features: [],
    limits: { active_subcontractors: 0, internal_seats: 1, clients: 0, audit_retention_days: 0 },
    prices: [],
  },
  {
    id: 'starter',
    name: 'Starter',
    description: 'Run your own subcontractors with rate cards and a client portal.',
    operatesDownstream: true,
    sortOrder: 1,
    trialDays: 14,
    features: ['rate_cards', 'holiday_rates', 'exports', 'client_portal'],
    limits: { active_subcontractors: 5, internal_seats: 2, clients: null, audit_retention_days: 30 },
    prices: [
      { currency: 'USD', interval: 'MONTH', amountCents: 4700 },
      { currency: 'USD', interval: 'YEAR', amountCents: 46800 },
    ],
  },
  {
    id: 'pro',
    name: 'Pro',
    description: 'For growing teams: notes, invoicing and audit visibility.',
    operatesDownstream: true,
    sortOrder: 2,
    trialDays: 14,
    features: [
      'rate_cards',
      'holiday_rates',
      'exports',
      'client_portal',
      'client_portal_notes',
      'invoicing',
      'audit_visibility',
    ],
    limits: { active_subcontractors: 30, internal_seats: 8, clients: null, audit_retention_days: 90 },
    prices: [
      { currency: 'USD', interval: 'MONTH', amountCents: 14300 },
      { currency: 'USD', interval: 'YEAR', amountCents: 142800 },
    ],
  },
  {
    id: 'business',
    name: 'Business',
    description: 'Scale with API access, SSO and white labelling.',
    operatesDownstream: true,
    sortOrder: 3,
    trialDays: 14,
    features: [
      'rate_cards',
      'holiday_rates',
      'exports',
      'client_portal',
      'client_portal_notes',
      'invoicing',
      'audit_visibility',
      'api_access',
      'sso',
      'white_label',
    ],
    limits: {
      active_subcontractors: 150,
      internal_seats: 25,
      clients: null,
      audit_retention_days: 365,
    },
    prices: [
      { currency: 'USD', interval: 'MONTH', amountCents: 41900 },
      { currency: 'USD', interval: 'YEAR', amountCents: 418800 },
    ],
  },
  {
    id: 'enterprise',
    name: 'Enterprise',
    description: 'Custom limits and everything unlimited. Talk to sales.',
    operatesDownstream: true,
    sortOrder: 4,
    trialDays: 14,
    features: ALL_FEATURES,
    limits: {
      active_subcontractors: null,
      internal_seats: null,
      clients: null,
      audit_retention_days: null,
    },
    prices: [], // custom / sales-led
  },
];

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('DATABASE_URL is not set. Copy .env.example to .env at the repo root.');
    process.exit(1);
  }

  const client = new Client({ connectionString });
  await client.connect();
  try {
    await client.query('begin');

    for (const [key, name, category] of FEATURES) {
      await client.query(
        `insert into features (key, name, category) values ($1, $2, $3)
         on conflict (key) do update set name = excluded.name, category = excluded.category`,
        [key, name, category]
      );
    }

    for (const [key, name, unit] of LIMITS) {
      await client.query(
        `insert into limits (key, name, unit) values ($1, $2, $3)
         on conflict (key) do update set name = excluded.name, unit = excluded.unit`,
        [key, name, unit]
      );
    }

    for (const plan of PLANS) {
      await client.query(
        `insert into plans (id, name, description, status, is_public, operates_downstream, sort_order, trial_days)
         values ($1, $2, $3, 'ACTIVE', true, $4, $5, $6)
         on conflict (id) do update set
           name = excluded.name,
           description = excluded.description,
           status = excluded.status,
           is_public = excluded.is_public,
           operates_downstream = excluded.operates_downstream,
           sort_order = excluded.sort_order,
           trial_days = excluded.trial_days,
           updated_at = now()`,
        [plan.id, plan.name, plan.description, plan.operatesDownstream, plan.sortOrder, plan.trialDays]
      );

      // Feature set: replace to match the seed exactly.
      await client.query('delete from plan_features where plan_id = $1', [plan.id]);
      for (const featureKey of plan.features) {
        await client.query(
          `insert into plan_features (plan_id, feature_key) values ($1, $2)
           on conflict do nothing`,
          [plan.id, featureKey]
        );
      }

      for (const [limitKey, value] of Object.entries(plan.limits)) {
        await client.query(
          `insert into plan_limits (plan_id, limit_key, value) values ($1, $2, $3)
           on conflict (plan_id, limit_key) do update set value = excluded.value`,
          [plan.id, limitKey, value]
        );
      }

      for (const price of plan.prices) {
        await client.query(
          `insert into plan_prices (plan_id, currency, interval, amount_cents)
           values ($1, $2, $3, $4)
           on conflict (plan_id, currency, interval)
             do update set amount_cents = excluded.amount_cents, updated_at = now()`,
          [plan.id, price.currency, price.interval, price.amountCents]
        );
      }
    }

    await client.query('commit');
    console.log(`Seed: ${FEATURES.length} features, ${LIMITS.length} limits, ${PLANS.length} plans.`);
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
