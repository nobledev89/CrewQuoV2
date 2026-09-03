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
  ['project_evidence', 'Photos & evidence', 'evidence'],
  ['project_documents', 'Project documents', 'evidence'],
  ['site_diary', 'Site diary', 'evidence'],
  ['asset_tracking', 'Asset & material tracking', 'sustainability'],
  ['sustainability', 'Sustainability', 'sustainability'],
  ['carbon_engine', 'Carbon engine', 'sustainability'],
  ['custom_factors', 'Custom emission factors', 'sustainability'],
  /*
   * Phase 10 (§43). Four keys, and one of them is a stated departure from §43's
   * own table — `client_signoff` sits on Starter rather than Pro
   * (`reporting-signoff.md` §13.6). A sign-off is how a small contractor proves a
   * job is finished, it costs nothing to serve, and putting the proof of
   * completion two tiers above the work would stop the free-to-Starter path one
   * step short of the thing the customer is actually selling.
   *
   * `client_reporting` ships now even though §38.2's UI is Phase 12, because the
   * aggregation query and the CLIENT_PERIOD report kind ship now, and an ungated
   * route is not a smaller decision for being invisible.
   */
  ['sustainability_reports', 'Sustainability reports', 'reporting'],
  ['evidence_pack', 'Evidence & completion pack', 'reporting'],
  ['client_signoff', 'Client sign-off', 'reporting'],
  ['client_reporting', 'Client-level reporting', 'reporting'],
  /*
   * Phase 11 (§43). Two keys, both placed **exactly as §43 proposes** — Starter and
   * up — and this is the first phase in four with no departure to explain. Both are
   * operating features rather than publishing ones, they cost nothing marginal to
   * serve, and Starter is described as "run your own subcontractors", which is
   * exactly who has extra works and a week to plan.
   *
   * §35's timeline gets no key at all: it is a union over ten record classes whose
   * features differ, so each source is gated by the key that governs its records.
   */
  ['variations', 'Variations & extra works', 'commercial'],
  ['scheduling', 'Crew scheduling', 'operations'],
  ['compliance_tracking', 'Compliance tracking', 'operations'],
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
  /*
   * Phase 7 (§43). The catalog rows land here; the per-plan VALUES deliberately do
   * not — see the note on the plans below.
   *
   * These two must exist as rows regardless of whether any plan sets them, because
   * `company_entitlement_overrides.limit_key` carries a foreign key to this table:
   * without them an operator cannot grant one company a ceiling even by hand.
   */
  ['storage_gb', 'File storage', 'gigabytes'],
  ['evidence_uploads_per_month', 'Evidence uploads per month', 'count/month'],
  /*
   * Phase 9 (§43), and the same shape as the two above: the catalog row lands, the
   * per-plan VALUE deliberately does not. §43 proposes figures for storage and
   * proposes none for factor sets, so picking one here would be a pricing judgement
   * made by a seed file. The enforcement is built and charged to the IMPORTING
   * company (sustainability.md §0 finding 9); turning it on is one number per plan
   * below and no code change anywhere.
   */
  ['factor_sets', 'Imported emission factor sets', 'count'],
  ['artifact_retention_days', 'Completed-project artifact retention', 'days'],
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

/**
 * **`storage_gb` and `evidence_uploads_per_month` are deliberately unset on every
 * plan below, and that is a stated gap rather than an oversight.**
 *
 * The owner answered the packaging *rule* on 2026-09-01 — capture is free and the
 * record is the project owner's entitlement — and explicitly reserved the tier
 * *numbers* as a pricing judgement (§43 proposes 1/25/200/1000/unlimited). Seeding
 * those figures here would be taking a decision that was kept.
 *
 * The consequence, said plainly because an unset limit is silently unlimited:
 * until the owner sets them, storage is uncapped on every plan including the free
 * one. The enforcement path is built and proved — `withinLimit` refuses at
 * presign, in gigabytes, before a byte moves — and turning it on is one value per
 * plan in this file, with no code change anywhere.
 */

const PLANS: PlanSeed[] = [
  {
    id: 'crew',
    name: 'Crew',
    description: 'Be a subcontractor: log time and submit up. Free forever.',
    operatesDownstream: false,
    sortOrder: 0,
    trialDays: 0,
    features: [],
    limits: { active_subcontractors: 0, internal_seats: 1, clients: 0, audit_retention_days: 0,
              artifact_retention_days: 365 },
    prices: [],
  },
  {
    id: 'starter',
    name: 'Starter',
    description: 'Run your own subcontractors with rate cards and a client portal.',
    operatesDownstream: true,
    sortOrder: 1,
    trialDays: 14,
    features: [
      'rate_cards',
      'holiday_rates',
      'exports',
      'client_portal',
      'project_evidence',
      'project_documents',
      'site_diary',
      'asset_tracking',
      // §43 puts reports at Pro; this one is deliberately a tier lower. See the
      // FEATURES note above and reporting-signoff.md §13.6.
      'client_signoff',
      // §43's placement, exactly.
      'variations',
      'scheduling',
    ],
    limits: { active_subcontractors: 5, internal_seats: 2, clients: null, audit_retention_days: 30,
              artifact_retention_days: 1095 },
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
      'project_evidence',
      'project_documents',
      'site_diary',
      'asset_tracking',
      // §43's placement: sustainability and the carbon engine from Pro upward.
      // Custom factors sit a tier higher, on the row §43 shares with client
      // reporting — a Pro company reads the shared library and does not import.
      'sustainability',
      'carbon_engine',
      // §43's placement for the Phase 10 keys: reports and the evidence pack from
      // Pro upward, client reporting a tier higher on the row it shares with
      // custom factors.
      'sustainability_reports',
      'evidence_pack',
      'client_signoff',
      'variations',
      'scheduling',
      'compliance_tracking',
    ],
    limits: { active_subcontractors: 30, internal_seats: 8, clients: null, audit_retention_days: 90,
              artifact_retention_days: 2555 },
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
      'project_evidence',
      'project_documents',
      'site_diary',
      'asset_tracking',
      'sustainability',
      'carbon_engine',
      'custom_factors',
      'sustainability_reports',
      'evidence_pack',
      'client_signoff',
      'client_reporting',
      'variations',
      'scheduling',
      'compliance_tracking',
    ],
    limits: {
      active_subcontractors: 150,
      internal_seats: 25,
      clients: null,
      audit_retention_days: 365,
      artifact_retention_days: 2555,
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
      artifact_retention_days: null,
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
