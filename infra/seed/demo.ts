import 'dotenv/config';
import pg from 'pg';
import { hashPassword } from '../../apps/api/src/modules/auth/passwords';

const { Client } = pg;

/**
 * A dense, single-login demo workspace for product demonstrations and manual QA.
 *
 * The catalog seed remains production-safe. This separate fixture is deliberately
 * local-only by default, additive, deterministic, and rerunnable. Passwords come
 * from the environment and only their bcrypt hash is stored.
 */

const DEMO_EMAIL = (process.env.DEMO_EMAIL ?? 'dpnh89@gmail.com').trim().toLowerCase();
const DEMO_PASSWORD = process.env.DEMO_PASSWORD;
const DEMO_NAME = process.env.DEMO_NAME?.trim() || 'Daniel Park';

const FIXTURE = {
  user: 'd1000000-0000-4000-8000-000000000001',
  beaconUser: 'd1000000-0000-4000-8000-000000000002',
  companies: {
    main: 'd2000000-0000-4000-8000-000000000001',
    apex: 'd2000000-0000-4000-8000-000000000002',
    beacon: 'd2000000-0000-4000-8000-000000000003',
    harbour: 'd2000000-0000-4000-8000-000000000004',
    calder: 'd2000000-0000-4000-8000-000000000005',
  },
  engagements: {
    apex: 'd5000000-0000-4000-8000-000000000001',
    beacon: 'd5000000-0000-4000-8000-000000000002',
    harbour: 'd5000000-0000-4000-8000-000000000003',
    calder: 'd5000000-0000-4000-8000-000000000004',
  },
  proposals: {
    apexApproved: 'd8000000-0000-4000-8000-000000000001',
    apexSubmitted: 'd8000000-0000-4000-8000-000000000002',
    beaconRejected: 'd8000000-0000-4000-8000-000000000003',
  },
  projects: {
    marina: 'da000000-0000-4000-8000-000000000001',
    orchard: 'da000000-0000-4000-8000-000000000002',
    jurong: 'da000000-0000-4000-8000-000000000003',
    riverside: 'da000000-0000-4000-8000-000000000004',
  },
} as const;

function fixtureId(prefix: string, number: number): string {
  return `${prefix}-0000-4000-8000-${String(number).padStart(12, '0')}`;
}

const ROLE_IDS = {
  supervisor: fixtureId('d6000000', 1),
  electrician: fixtureId('d6000000', 2),
  operative: fixtureId('d6000000', 3),
  painter: fixtureId('d6000000', 4),
} as const;

type RoleKey = keyof typeof ROLE_IDS;
type RateLabel = 'MON_FRI_DAY' | 'MON_THU_NIGHT' | 'SUNDAY';

const ROLES: Array<{ key: RoleKey; name: string; pay: number; bill: number }> = [
  { key: 'supervisor', name: 'Site Supervisor', pay: 5_800, bill: 9_200 },
  { key: 'electrician', name: 'Electrician', pay: 4_800, bill: 7_800 },
  { key: 'operative', name: 'General Operative', pay: 3_200, bill: 5_400 },
  { key: 'painter', name: 'Painter & Decorator', pay: 4_200, bill: 6_900 },
];

const LABELS: Array<{ label: RateLabel; multiplier: number }> = [
  { label: 'MON_FRI_DAY', multiplier: 1 },
  { label: 'MON_THU_NIGHT', multiplier: 1.25 },
  { label: 'SUNDAY', multiplier: 1.5 },
];

function rateAmount(base: number, multiplier: number): number {
  return Math.round(base * multiplier);
}

function snapshot(args: {
  rateCardId: string;
  label: RateLabel;
  baseCents: number;
  hoursRegular: number;
  hoursOt: number;
}) {
  const otCents = Math.round(args.baseCents * 1.5);
  return {
    rateCardId: args.rateCardId,
    label: args.label,
    rateMode: 'HOURLY',
    baseCents: args.baseCents,
    otCents,
    hoursRegular: args.hoursRegular,
    hoursOt: args.hoursOt,
    costCents: Math.round(args.hoursRegular * args.baseCents + args.hoursOt * otCents),
    currency: 'SGD',
  };
}

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is not set');
  if (!DEMO_PASSWORD) throw new Error('DEMO_PASSWORD is required');
  if (DEMO_PASSWORD.length < 8) throw new Error('DEMO_PASSWORD must be at least 8 characters');

  const url = new URL(connectionString);
  const localHosts = new Set(['127.0.0.1', 'localhost', '::1']);
  if (!localHosts.has(url.hostname) && process.env.ALLOW_REMOTE_DEMO_SEED !== '1') {
    throw new Error(
      `Refusing to seed non-local database ${url.hostname}. Set ALLOW_REMOTE_DEMO_SEED=1 explicitly to override.`
    );
  }

  const db = new Client({ connectionString });
  await db.connect();
  const passwordHash = await hashPassword(DEMO_PASSWORD);

  try {
    await db.query('begin');

    const planCheck = await db.query<{ id: string }>(
      `select id from plans where id in ('business', 'crew')`
    );
    if (planCheck.rowCount !== 2) {
      throw new Error('Run pnpm db:seed before the demo seed so the plan catalog exists');
    }

    const userResult = await db.query<{ id: string }>(
      `insert into users
         (id, email, password_hash, name, is_super_admin, email_verified_at, created_at, updated_at)
       values ($1, $2, $3, $4, false, now(), now(), now())
       on conflict (email) do update set
         password_hash = excluded.password_hash,
         name = excluded.name,
         email_verified_at = coalesce(users.email_verified_at, now()),
         updated_at = now()
       returning id`,
      [FIXTURE.user, DEMO_EMAIL, passwordHash, DEMO_NAME]
    );
    const userId = userResult.rows[0]!.id;

    await db.query(
      `insert into users
         (id, email, password_hash, name, is_super_admin, email_verified_at, created_at, updated_at)
       values ($1, 'beacon.fixture@crewquo.invalid', null, 'Jordan Ellis', false, now(), now(), now())
       on conflict (id) do update set name = excluded.name, updated_at = now()`,
      [FIXTURE.beaconUser]
    );

    const companies = [
      [FIXTURE.companies.main, 'Northstar Main Contracting Pte Ltd', 'SG', 'CQ-DEMO-MAIN-001'],
      [FIXTURE.companies.apex, 'Apex Site Services Pte Ltd', 'SG', 'CQ-DEMO-SUB-001'],
      [FIXTURE.companies.beacon, 'Beacon Electrical Pte Ltd', 'SG', 'CQ-DEMO-SUB-002'],
      [FIXTURE.companies.harbour, 'Harbour Property Group Pte Ltd', 'SG', 'CQ-DEMO-CLIENT-001'],
      [FIXTURE.companies.calder, 'Calder Estates Pte Ltd', 'SG', 'CQ-DEMO-CLIENT-002'],
    ] as const;
    for (const [id, name, country, registrationId] of companies) {
      await db.query(
        `insert into companies
           (id, name, currency, is_placeholder, settings, country, registration_id, time_zone,
            created_at, updated_at)
         values ($1, $2, 'SGD', false, $3::jsonb, $4, $5, 'Asia/Singapore', now(), now())
         on conflict (id) do update set
           name = excluded.name,
           currency = excluded.currency,
           is_placeholder = false,
           settings = excluded.settings,
           country = excluded.country,
           registration_id = excluded.registration_id,
           time_zone = excluded.time_zone,
           updated_at = now()`,
        [id, name, JSON.stringify({ demoFixture: 'single-login-v1' }), country, registrationId]
      );
    }

    const memberships = [
      [fixtureId('d3000000', 1), userId, FIXTURE.companies.main, 'OWNER'],
      [fixtureId('d3000000', 2), userId, FIXTURE.companies.apex, 'OWNER'],
      [fixtureId('d3000000', 3), userId, FIXTURE.companies.harbour, 'MANAGER'],
      [fixtureId('d3000000', 4), FIXTURE.beaconUser, FIXTURE.companies.beacon, 'OWNER'],
    ] as const;
    for (const [id, memberUserId, companyId, role] of memberships) {
      await db.query(
        `insert into memberships (id, user_id, company_id, role, status, created_at, updated_at)
         values ($1, $2, $3, $4, 'ACTIVE', now(), now())
         on conflict (user_id, company_id) do update set
           role = excluded.role, status = 'ACTIVE', updated_at = now()`,
        [id, memberUserId, companyId, role]
      );
    }

    await db.query(
      `insert into company_creation_allowances
         (user_id, company_id, source, idempotency_key, consumed_at)
       values ($1, $2, 'REGISTRATION', 'demo-single-login-v1', now())
       on conflict (user_id) do nothing`,
      [userId, FIXTURE.companies.main]
    );

    for (const [index, companyId] of Object.values(FIXTURE.companies).entries()) {
      const planId = companyId === FIXTURE.companies.main ? 'business' : 'crew';
      await db.query(
        `insert into company_subscriptions
           (id, company_id, plan_id, status, currency, interval, created_at, updated_at)
         values ($1, $2, $3, 'ACTIVE', 'SGD', 'MONTH', now(), now())
         on conflict (company_id) do update set
           plan_id = excluded.plan_id,
           status = 'ACTIVE',
           currency = 'SGD',
           interval = 'MONTH',
           updated_at = now()`,
        [fixtureId('d4000000', index + 1), companyId, planId]
      );
    }

    const engagements = [
      {
        id: FIXTURE.engagements.apex,
        client: FIXTURE.companies.main,
        provider: FIXTURE.companies.apex,
        createdBy: FIXTURE.companies.main,
        acceptedBy: userId,
        po: 'NS-APEX-2026',
        ceiling: 850_000_00,
      },
      {
        id: FIXTURE.engagements.beacon,
        client: FIXTURE.companies.main,
        provider: FIXTURE.companies.beacon,
        createdBy: FIXTURE.companies.main,
        acceptedBy: FIXTURE.beaconUser,
        po: 'NS-BEACON-2026',
        ceiling: 500_000_00,
      },
      {
        id: FIXTURE.engagements.harbour,
        client: FIXTURE.companies.harbour,
        provider: FIXTURE.companies.main,
        createdBy: FIXTURE.companies.main,
        acceptedBy: userId,
        po: 'HPG-MARINA-0426',
        ceiling: 2_400_000_00,
      },
      {
        id: FIXTURE.engagements.calder,
        client: FIXTURE.companies.calder,
        provider: FIXTURE.companies.main,
        createdBy: FIXTURE.companies.main,
        acceptedBy: userId,
        po: 'CAL-JURONG-118',
        ceiling: 1_250_000_00,
      },
    ];
    for (const engagement of engagements) {
      await db.query(
        `insert into engagements
           (id, client_company_id, provider_company_id, status, created_by_company_id,
            payment_terms_days, purchase_order_reference, purchase_order_ceiling_cents,
            terms_updated_at, provider_accepted_at, provider_accepted_by_user_id,
            created_at, updated_at)
         values ($1, $2, $3, 'ACTIVE', $4, 30, $5, $6, '2026-07-01T02:00:00Z',
                 '2026-07-01T03:00:00Z', $7, '2026-06-25T02:00:00Z', now())
         on conflict (id) do update set
           status = 'ACTIVE',
           payment_terms_days = excluded.payment_terms_days,
           purchase_order_reference = excluded.purchase_order_reference,
           purchase_order_ceiling_cents = excluded.purchase_order_ceiling_cents,
           terms_updated_at = excluded.terms_updated_at,
           provider_accepted_at = excluded.provider_accepted_at,
           provider_accepted_by_user_id = excluded.provider_accepted_by_user_id,
           decision_reason = null,
           updated_at = now()`,
        [
          engagement.id,
          engagement.client,
          engagement.provider,
          engagement.createdBy,
          engagement.po,
          engagement.ceiling,
          engagement.acceptedBy,
        ]
      );
    }

    for (const role of ROLES) {
      await db.query(
        `insert into role_catalog (id, company_id, name, created_at, updated_at)
         values ($1, $2, $3, now(), now())
         on conflict (company_id, name) do update set updated_at = now()`,
        [ROLE_IDS[role.key], FIXTURE.companies.main, role.name]
      );
    }

    await db.query(
      `insert into rate_card_templates
         (id, company_id, name, timeframe_definitions, is_default, created_at, updated_at)
       values ($1, $2, 'Singapore standard working rules', $3::jsonb, true, now(), now())
       on conflict (id) do update set
         name = excluded.name,
         timeframe_definitions = excluded.timeframe_definitions,
         is_default = true,
         updated_at = now()`,
      [
        fixtureId('d7000000', 1),
        FIXTURE.companies.main,
        JSON.stringify([
          {
            type: 'label_rule',
            shiftType: 'NIGHT',
            daysOfWeek: [1, 2, 3, 4],
            label: 'MON_THU_NIGHT',
          },
          {
            type: 'label_rule',
            shiftType: 'SUNDAY',
            daysOfWeek: [0],
            label: 'SUNDAY',
          },
          {
            type: 'holiday',
            holidayDates: ['2026-08-09', '2026-12-25'],
            holidayMultiplier: 1.5,
          },
        ]),
      ]
    );
    await db.query(
      `insert into rate_card_templates
         (id, company_id, name, timeframe_definitions, is_default, created_at, updated_at)
       values ($1, $2, 'Tender schedule archive 2025', '[]'::jsonb, false, now(), now())
       on conflict (id) do update set name = excluded.name, updated_at = now()`,
      [fixtureId('d7000000', 2), FIXTURE.companies.main]
    );

    await db.query(
      `insert into rate_proposals
         (id, engagement_id, proposed_by_company_id, effective_from, status, note,
          created_by_user_id, created_at, updated_at)
       values ($1, $2, $3, '2026-07-01', 'DRAFT',
               'Initial agreed labour schedule for the 2026 framework.',
               $4, '2026-06-27T02:00:00Z', '2026-06-27T02:00:00Z')
       on conflict (id) do nothing`,
      [FIXTURE.proposals.apexApproved, FIXTURE.engagements.apex, FIXTURE.companies.apex, userId]
    );
    await db.query(
      `insert into rate_proposals
         (id, engagement_id, proposed_by_company_id, effective_from, status, note,
          created_by_user_id, created_at, updated_at)
       values ($1, $2, $3, '2026-08-01', 'DRAFT', 'Weekend premium review.',
               $4, '2026-07-24T06:30:00Z', '2026-07-24T06:30:00Z')
       on conflict (id) do nothing`,
      [
        FIXTURE.proposals.beaconRejected,
        FIXTURE.engagements.beacon,
        FIXTURE.companies.beacon,
        FIXTURE.beaconUser,
      ]
    );

    const payCardIds = new Map<string, string>();
    let proposalLineNo = 1;
    let rateCardNo = 1;
    for (const [providerIndex, providerId] of [
      FIXTURE.companies.apex,
      FIXTURE.companies.beacon,
    ].entries()) {
      for (const role of ROLES) {
        for (const { label, multiplier } of LABELS) {
          const base = rateAmount(role.pay + providerIndex * 150, multiplier);
          const cardId = fixtureId('d9000000', rateCardNo++);
          payCardIds.set(`${providerId}:${role.key}:${label}`, cardId);

          if (providerId === FIXTURE.companies.apex) {
            await db.query(
              `insert into rate_proposal_lines
                 (id, proposal_id, operation, role_id, rate_label, rate_mode,
                  hourly_rate_cents, ot_hourly_rate_cents, min_hours, created_at)
               select $1, $2, 'CREATE', $3, $4, 'HOURLY', $5, $6, 4, '2026-06-27T02:00:00Z'
                where not exists (
                  select 1 from rate_proposal_lines
                   where proposal_id = $2 and role_id = $3 and rate_label = $4
                )`,
              [
                fixtureId('d8100000', proposalLineNo++),
                FIXTURE.proposals.apexApproved,
                ROLE_IDS[role.key],
                label,
                base,
                Math.round(base * 1.5),
              ]
            );
          }

          await db.query(
            `insert into rate_cards
               (id, company_id, kind, counterparty_company_id, role_id, rate_mode, rate_label,
                hourly_rate_cents, ot_hourly_rate_cents, min_hours, effective_from, active,
                source_proposal_id, version, locked, created_by_user_id, updated_by_user_id,
                created_at, updated_at)
             values ($1, $2, 'PAY', $3, $4, 'HOURLY', $5, $6, $7, 4, '2026-07-01', true,
                     $8, 1, $9, $10, $10, '2026-06-28T04:00:00Z', '2026-06-28T04:00:00Z')
             on conflict (id) do nothing`,
            [
              cardId,
              FIXTURE.companies.main,
              providerId,
              ROLE_IDS[role.key],
              label,
              base,
              Math.round(base * 1.5),
              providerId === FIXTURE.companies.apex ? FIXTURE.proposals.apexApproved : null,
              providerId === FIXTURE.companies.apex,
              providerId === FIXTURE.companies.apex ? userId : FIXTURE.beaconUser,
            ]
          );
        }
      }
    }

    await db.query(
      `update rate_proposals
          set status = 'APPROVED',
              submitted_by_user_id = $2,
              submitted_at = '2026-06-27T03:00:00Z',
              reviewed_by_user_id = $2,
              reviewed_at = '2026-06-28T04:00:00Z',
              updated_at = '2026-06-28T04:00:00Z'
        where id = $1 and status = 'DRAFT'`,
      [FIXTURE.proposals.apexApproved, userId]
    );

    await db.query(
      `insert into rate_proposals
         (id, engagement_id, proposed_by_company_id, effective_from, status, note,
          created_by_user_id, created_at, updated_at)
       values ($1, $2, $3, '2026-09-01', 'DRAFT',
               'September labour review: electrician and supervisor uplift.',
               $4, '2026-08-19T08:00:00Z', '2026-08-19T08:00:00Z')
       on conflict (id) do nothing`,
      [FIXTURE.proposals.apexSubmitted, FIXTURE.engagements.apex, FIXTURE.companies.apex, userId]
    );

    let billCardNo = 101;
    for (const [clientIndex, clientId] of [
      FIXTURE.companies.harbour,
      FIXTURE.companies.calder,
    ].entries()) {
      for (const role of ROLES) {
        for (const { label, multiplier } of LABELS) {
          const base = rateAmount(role.bill + clientIndex * 250, multiplier);
          await db.query(
            `insert into rate_cards
               (id, company_id, kind, counterparty_company_id, role_id, rate_mode, rate_label,
                hourly_rate_cents, ot_hourly_rate_cents, min_hours, effective_from, active,
                version, locked, created_by_user_id, updated_by_user_id, created_at, updated_at)
             values ($1, $2, 'BILL', $3, $4, 'HOURLY', $5, $6, $7, 4, '2026-07-01', true,
                     1, false, $8, $8, '2026-06-28T04:00:00Z', now())
             on conflict (id) do nothing`,
            [
              fixtureId('d9000000', billCardNo++),
              FIXTURE.companies.main,
              clientId,
              ROLE_IDS[role.key],
              label,
              base,
              Math.round(base * 1.5),
              userId,
            ]
          );
        }
      }
    }

    const replacementTargets = [
      { role: ROLES[0]!, label: LABELS[0]!, uplift: 300 },
      { role: ROLES[1]!, label: LABELS[0]!, uplift: 250 },
      { role: ROLES[1]!, label: LABELS[1]!, uplift: 300 },
    ];
    for (const [index, target] of replacementTargets.entries()) {
      const existingId = payCardIds.get(
        `${FIXTURE.companies.apex}:${target.role.key}:${target.label.label}`
      )!;
      const base = rateAmount(target.role.pay, target.label.multiplier) + target.uplift;
      await db.query(
        `insert into rate_proposal_lines
           (id, proposal_id, operation, role_id, rate_label, rate_mode,
            hourly_rate_cents, ot_hourly_rate_cents, min_hours, replaces_rate_card_id, created_at)
         select $1, $2, 'REPLACE', $3, $4, 'HOURLY', $5, $6, 4, $7, '2026-08-19T08:00:00Z'
          where not exists (
            select 1 from rate_proposal_lines
             where proposal_id = $2 and role_id = $3 and rate_label = $4
          )`,
        [
          fixtureId('d8200000', index + 1),
          FIXTURE.proposals.apexSubmitted,
          ROLE_IDS[target.role.key],
          target.label.label,
          base,
          Math.round(base * 1.5),
          existingId,
        ]
      );
    }
    await db.query(
      `update rate_proposals
          set status = 'SUBMITTED',
              submitted_by_user_id = $2,
              submitted_at = '2026-08-19T08:30:00Z',
              updated_at = '2026-08-19T08:30:00Z'
        where id = $1 and status = 'DRAFT'`,
      [FIXTURE.proposals.apexSubmitted, userId]
    );
    await db.query(
      `insert into rate_proposal_lines
         (id, proposal_id, operation, role_id, rate_label, rate_mode,
          hourly_rate_cents, ot_hourly_rate_cents, min_hours, created_at)
       select $1, $2, 'CREATE', $3, 'SUNDAY', 'HOURLY', 7800, 11700, 4, '2026-07-24T06:30:00Z'
        where not exists (
          select 1 from rate_proposal_lines
           where proposal_id = $2 and role_id = $3 and rate_label = 'SUNDAY'
        )`,
      [fixtureId('d8300000', 1), FIXTURE.proposals.beaconRejected, ROLE_IDS.electrician]
    );
    await db.query(
      `update rate_proposals
          set status = 'REJECTED',
              submitted_by_user_id = $2,
              submitted_at = '2026-07-24T07:00:00Z',
              reviewed_by_user_id = $3,
              reviewed_at = '2026-07-25T03:00:00Z',
              decision_reason = 'Please resubmit using the framework Sunday cap.',
              updated_at = '2026-07-25T03:00:00Z'
        where id = $1 and status = 'DRAFT'`,
      [FIXTURE.proposals.beaconRejected, FIXTURE.beaconUser, userId]
    );

    const projects = [
      {
        id: FIXTURE.projects.marina,
        client: FIXTURE.companies.harbour,
        engagement: FIXTURE.engagements.harbour,
        name: 'Marina Bay Office Fit-Out',
        status: 'ACTIVE',
        visible: true,
        start: '2026-07-06',
        end: '2026-10-30',
        notes: 'Live flagship project. Level 12 office fit-out with phased handover.',
      },
      {
        id: FIXTURE.projects.orchard,
        client: FIXTURE.companies.harbour,
        engagement: FIXTURE.engagements.harbour,
        name: 'Orchard Retail Refurbishment',
        status: 'PLANNED',
        visible: true,
        start: '2026-09-07',
        end: '2026-11-20',
        notes: 'Pre-start planning, procurement and night-shift access coordination.',
      },
      {
        id: FIXTURE.projects.jurong,
        client: FIXTURE.companies.calder,
        engagement: FIXTURE.engagements.calder,
        name: 'Jurong Logistics Hub Upgrade',
        status: 'ACTIVE',
        visible: false,
        start: '2026-07-20',
        end: '2026-12-18',
        notes: 'Electrical distribution upgrade while the warehouse remains operational.',
      },
      {
        id: FIXTURE.projects.riverside,
        client: FIXTURE.companies.harbour,
        engagement: FIXTURE.engagements.harbour,
        name: 'Riverside Defects Close-Out',
        status: 'COMPLETED',
        visible: true,
        start: '2026-05-04',
        end: '2026-06-26',
        notes: 'Completed project retained for historical reporting and invoice QA.',
      },
    ];
    for (const project of projects) {
      await db.query(
        `insert into projects
           (id, owner_company_id, client_company_id, engagement_id, name, status,
            client_visible, starts_on, ends_on, notes, reporting_currency, time_zone,
            created_at, updated_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'SGD', 'Asia/Singapore',
                 '2026-06-30T02:00:00Z', now())
         on conflict (id) do update set
           name = excluded.name,
           status = excluded.status,
           client_visible = excluded.client_visible,
           starts_on = excluded.starts_on,
           ends_on = excluded.ends_on,
           notes = excluded.notes,
           updated_at = now()`,
        [
          project.id,
          FIXTURE.companies.main,
          project.client,
          project.engagement,
          project.name,
          project.status,
          project.visible,
          project.start,
          project.end,
          project.notes,
        ]
      );
    }

    const assignments = [
      [FIXTURE.projects.marina, FIXTURE.companies.apex, FIXTURE.engagements.apex, userId],
      [FIXTURE.projects.marina, FIXTURE.companies.beacon, FIXTURE.engagements.beacon, FIXTURE.beaconUser],
      [FIXTURE.projects.orchard, FIXTURE.companies.apex, FIXTURE.engagements.apex, userId],
      [FIXTURE.projects.jurong, FIXTURE.companies.beacon, FIXTURE.engagements.beacon, FIXTURE.beaconUser],
      [FIXTURE.projects.riverside, FIXTURE.companies.apex, FIXTURE.engagements.apex, userId],
    ] as const;
    for (const [index, assignment] of assignments.entries()) {
      await db.query(
        `insert into project_assignments
           (id, project_id, provider_company_id, engagement_id, acceptance,
            accepted_at, accepted_by_user_id, created_at, updated_at)
         values ($1, $2, $3, $4, 'ACCEPTED', '2026-07-02T03:00:00Z', $5,
                 '2026-07-01T02:00:00Z', now())
         on conflict (project_id, provider_company_id) do update set
           acceptance = 'ACCEPTED',
           accepted_at = excluded.accepted_at,
           accepted_by_user_id = excluded.accepted_by_user_id,
           decision_reason = null,
           updated_at = now()`,
        [fixtureId('db000000', index + 1), ...assignment]
      );
    }

    const logs = [
      ['2026-08-03', 'supervisor', 'WEEKDAY_DAY', 8, 1, 'APPROVED', 'apex', 'marina'],
      ['2026-08-04', 'electrician', 'WEEKDAY_DAY', 8, 2, 'APPROVED', 'apex', 'marina'],
      ['2026-08-05', 'operative', 'WEEKDAY_DAY', 8, 0, 'APPROVED', 'apex', 'marina'],
      ['2026-08-06', 'painter', 'NIGHT', 8, 0, 'APPROVED', 'apex', 'marina'],
      ['2026-08-09', 'electrician', 'SUNDAY', 6, 2, 'APPROVED', 'apex', 'marina'],
      ['2026-08-17', 'supervisor', 'WEEKDAY_DAY', 8, 0, 'SUBMITTED', 'apex', 'marina'],
      ['2026-08-18', 'electrician', 'NIGHT', 8, 1, 'SUBMITTED', 'apex', 'marina'],
      ['2026-08-12', 'operative', 'WEEKDAY_DAY', 8, 0, 'REJECTED', 'apex', 'marina'],
      ['2026-08-19', 'painter', 'WEEKDAY_DAY', 7.5, 0, 'DRAFT', 'apex', 'marina'],
      ['2026-08-20', 'electrician', 'WEEKDAY_DAY', 4, 0, 'DRAFT', 'apex', 'orchard'],
      ['2026-08-10', 'electrician', 'WEEKDAY_DAY', 8, 1, 'APPROVED', 'beacon', 'marina'],
      ['2026-08-11', 'electrician', 'NIGHT', 8, 0, 'APPROVED', 'beacon', 'marina'],
      ['2026-08-12', 'operative', 'WEEKDAY_DAY', 8, 0, 'APPROVED', 'beacon', 'jurong'],
      ['2026-08-17', 'electrician', 'WEEKDAY_DAY', 8, 2, 'SUBMITTED', 'beacon', 'marina'],
      ['2026-08-18', 'operative', 'NIGHT', 8, 0, 'SUBMITTED', 'beacon', 'jurong'],
      ['2026-08-19', 'supervisor', 'WEEKDAY_DAY', 6, 0, 'DRAFT', 'beacon', 'jurong'],
    ] as const;
    const logIds: string[] = [];
    for (const [index, row] of logs.entries()) {
      const [workDate, roleKey, shiftType, hoursRegular, hoursOt, status, providerKey, projectKey] = row;
      const providerId = providerKey === 'apex' ? FIXTURE.companies.apex : FIXTURE.companies.beacon;
      const engagementId = providerKey === 'apex' ? FIXTURE.engagements.apex : FIXTURE.engagements.beacon;
      const loggedBy = providerKey === 'apex' ? userId : FIXTURE.beaconUser;
      const projectId = FIXTURE.projects[projectKey as keyof typeof FIXTURE.projects];
      const label: RateLabel =
        shiftType === 'SUNDAY'
          ? 'SUNDAY'
          : shiftType === 'NIGHT'
            ? 'MON_THU_NIGHT'
            : 'MON_FRI_DAY';
      const role = ROLES.find((entry) => entry.key === roleKey)!;
      const providerBump = providerKey === 'beacon' ? 150 : 0;
      const baseCents = rateAmount(
        role.pay + providerBump,
        LABELS.find((entry) => entry.label === label)!.multiplier
      );
      const rateCardId = payCardIds.get(`${providerId}:${roleKey}:${label}`)!;
      const resolved =
        status === 'DRAFT'
          ? null
          : snapshot({ rateCardId, label, baseCents, hoursRegular, hoursOt });
      const rejected = status === 'REJECTED';
      const reviewed = status === 'APPROVED' || rejected;
      const id = fixtureId('dc000000', index + 1);
      logIds.push(id);
      await db.query(
        `insert into time_logs
           (id, engagement_id, project_id, provider_company_id, logged_by_user_id,
            role_id, shift_type, work_date, hours_regular, hours_ot, status, resolved_rate,
            reviewed_by_user_id, reviewed_at, reject_reason, created_at, updated_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb,
                 $13, $14, $15, $16, $17)
         on conflict (id) do update set
           status = excluded.status,
           resolved_rate = excluded.resolved_rate,
           reviewed_by_user_id = excluded.reviewed_by_user_id,
           reviewed_at = excluded.reviewed_at,
           reject_reason = excluded.reject_reason,
           updated_at = excluded.updated_at`,
        [
          id,
          engagementId,
          projectId,
          providerId,
          loggedBy,
          ROLE_IDS[roleKey],
          shiftType,
          workDate,
          hoursRegular,
          hoursOt,
          status,
          resolved ? JSON.stringify(resolved) : null,
          reviewed ? userId : null,
          reviewed ? '2026-08-19T10:00:00Z' : null,
          rejected ? 'Hours overlap with the previous site entry. Please correct and resubmit.' : null,
          `${workDate}T01:00:00Z`,
          reviewed ? '2026-08-19T10:00:00Z' : `${workDate}T10:00:00Z`,
        ]
      );
    }

    const expenses = [
      ['marina', 'apex', 4_850, 'TRAVEL', 'CBD parking and ERP charges', 'APPROVED'],
      ['marina', 'apex', 32_600, 'MATERIALS', 'Cable containment consumables', 'SUBMITTED'],
      ['marina', 'apex', 12_400, 'PLANT', 'Mobile access tower hire', 'REJECTED'],
      ['orchard', 'apex', 2_150, 'TRAVEL', 'Pre-start survey transport', 'DRAFT'],
      ['marina', 'beacon', 48_000, 'MATERIALS', 'Distribution board components', 'APPROVED'],
      ['jurong', 'beacon', 67_500, 'PLANT', 'Scissor lift weekly hire', 'SUBMITTED'],
    ] as const;
    const expenseIds: string[] = [];
    for (const [index, row] of expenses.entries()) {
      const [projectKey, providerKey, amount, category, description, status] = row;
      const providerId = providerKey === 'apex' ? FIXTURE.companies.apex : FIXTURE.companies.beacon;
      const engagementId = providerKey === 'apex' ? FIXTURE.engagements.apex : FIXTURE.engagements.beacon;
      const loggedBy = providerKey === 'apex' ? userId : FIXTURE.beaconUser;
      const reviewed = status === 'APPROVED' || status === 'REJECTED';
      const id = fixtureId('dd000000', index + 1);
      expenseIds.push(id);
      await db.query(
        `insert into expenses
           (id, engagement_id, project_id, provider_company_id, logged_by_user_id,
            amount_cents, category, description, status, reviewed_by_user_id,
            reviewed_at, reject_reason, created_at, updated_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
                 '2026-08-17T03:00:00Z', now())
         on conflict (id) do update set
           status = excluded.status,
           reviewed_by_user_id = excluded.reviewed_by_user_id,
           reviewed_at = excluded.reviewed_at,
           reject_reason = excluded.reject_reason,
           updated_at = now()`,
        [
          id,
          engagementId,
          FIXTURE.projects[projectKey],
          providerId,
          loggedBy,
          amount,
          category,
          description,
          status,
          reviewed ? userId : null,
          reviewed ? '2026-08-19T09:00:00Z' : null,
          status === 'REJECTED' ? 'Please attach the supplier receipt before resubmitting.' : null,
        ]
      );
    }

    const submissions = [
      [FIXTURE.projects.marina, FIXTURE.engagements.apex, FIXTURE.companies.apex, userId, '2026-08-10', '2026-08-16', 'SUBMITTED'],
      [FIXTURE.projects.marina, FIXTURE.engagements.apex, FIXTURE.companies.apex, userId, '2026-08-03', '2026-08-09', 'APPROVED'],
      [FIXTURE.projects.marina, FIXTURE.engagements.beacon, FIXTURE.companies.beacon, FIXTURE.beaconUser, '2026-08-10', '2026-08-16', 'SUBMITTED'],
      [FIXTURE.projects.jurong, FIXTURE.engagements.beacon, FIXTURE.companies.beacon, FIXTURE.beaconUser, '2026-08-03', '2026-08-09', 'REJECTED'],
    ] as const;
    for (const [index, row] of submissions.entries()) {
      const [projectId, engagementId, providerId, submittedBy, start, end, status] = row;
      const reviewed = status === 'APPROVED' || status === 'REJECTED';
      await db.query(
        `insert into project_submissions
           (id, engagement_id, project_id, provider_company_id, period_start, period_end,
            status, submitted_by_user_id, reviewed_by_user_id, reviewed_at, reject_reason,
            created_at, updated_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
                 '2026-08-17T08:00:00Z', now())
         on conflict (id) do update set
           status = excluded.status,
           reviewed_by_user_id = excluded.reviewed_by_user_id,
           reviewed_at = excluded.reviewed_at,
           reject_reason = excluded.reject_reason,
           updated_at = now()`,
        [
          fixtureId('de000000', index + 1),
          engagementId,
          projectId,
          providerId,
          start,
          end,
          status,
          submittedBy,
          reviewed ? userId : null,
          reviewed ? '2026-08-19T09:30:00Z' : null,
          status === 'REJECTED' ? 'The period contains a rejected time log.' : null,
        ]
      );
    }

    const invoices = [
      {
        id: fixtureId('df000000', 1),
        engagement: FIXTURE.engagements.harbour,
        counterparty: FIXTURE.companies.harbour,
        project: FIXTURE.projects.riverside,
        number: 'CQ-2026-000041',
        status: 'PAID',
        subtotal: 186_800,
        tax: 16_812,
        issuedAt: '2026-07-01T02:00:00Z',
        dueAt: '2026-07-31T02:00:00Z',
      },
      {
        id: fixtureId('df000000', 2),
        engagement: FIXTURE.engagements.harbour,
        counterparty: FIXTURE.companies.harbour,
        project: FIXTURE.projects.marina,
        number: 'CQ-2026-000042',
        status: 'ISSUED',
        subtotal: 389_650,
        tax: 35_069,
        issuedAt: '2026-08-17T02:00:00Z',
        dueAt: '2026-09-16T02:00:00Z',
      },
      {
        id: fixtureId('df000000', 3),
        engagement: FIXTURE.engagements.calder,
        counterparty: FIXTURE.companies.calder,
        project: FIXTURE.projects.jurong,
        number: null,
        status: 'DRAFT',
        subtotal: 125_000,
        tax: 11_250,
        issuedAt: null,
        dueAt: null,
      },
    ] as const;
    for (const invoice of invoices) {
      await db.query(
        `insert into invoices
           (id, engagement_id, issuer_company_id, counterparty_company_id, project_id,
            number, status, subtotal_cents, tax_cents, total_cents, issued_at, due_at,
            created_at, updated_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $8::integer + $9::integer, $10, $11,
                 '2026-08-17T01:00:00Z', now())
         on conflict (id) do update set
           number = excluded.number,
           status = excluded.status,
           subtotal_cents = excluded.subtotal_cents,
           tax_cents = excluded.tax_cents,
           total_cents = excluded.total_cents,
           issued_at = excluded.issued_at,
           due_at = excluded.due_at,
           updated_at = now()`,
        [
          invoice.id,
          invoice.engagement,
          FIXTURE.companies.main,
          invoice.counterparty,
          invoice.project,
          invoice.number,
          invoice.status,
          invoice.subtotal,
          invoice.tax,
          invoice.issuedAt,
          invoice.dueAt,
        ]
      );
    }

    const invoiceItems = [
      [1, 1, 'Riverside completion labour', 1, 142_000, 'MANUAL', null],
      [1, 2, 'Close-out materials and access', 1, 44_800, 'MANUAL', null],
      [2, 3, 'Approved site supervision — week 31', 8, 9_200, 'TIME_LOG', logIds[0]],
      [2, 4, 'Approved electrical labour — week 31', 10, 7_800, 'TIME_LOG', logIds[1]],
      [2, 5, 'Approved general labour — week 31', 8, 5_400, 'TIME_LOG', logIds[2]],
      [2, 6, 'Approved night works — week 31', 8, 8_625, 'TIME_LOG', logIds[3]],
      [2, 7, 'Approved Sunday electrical works', 8, 11_700, 'TIME_LOG', logIds[4]],
      [2, 8, 'Approved reimbursable expenses', 1, 32_250, 'EXPENSE', expenseIds[0]],
      [3, 9, 'Jurong mobilisation and preliminaries', 1, 125_000, 'MANUAL', null],
    ] as const;
    for (const [invoiceNo, itemNo, description, quantity, unitAmount, sourceType, sourceId] of invoiceItems) {
      await db.query(
        `insert into invoice_items
           (id, invoice_id, description, quantity, unit_amount_cents, amount_cents,
            source_type, source_id, created_at)
         values ($1, $2, $3, $4::numeric, $5::integer,
                 round($4::numeric * $5::numeric)::integer, $6, $7, '2026-08-17T02:00:00Z')
         on conflict (id) do nothing`,
        [
          fixtureId('e0000000', itemNo),
          fixtureId('df000000', invoiceNo),
          description,
          quantity,
          unitAmount,
          sourceType,
          sourceId,
        ]
      );
    }

    for (const [index, engagementId] of [
      FIXTURE.engagements.harbour,
      FIXTURE.engagements.calder,
    ].entries()) {
      await db.query(
        `insert into audit_settings
           (id, engagement_id, client_can_comment, show_audit_trail, created_at, updated_at)
         values ($1, $2, true, true, now(), now())
         on conflict (engagement_id) do update set
           client_can_comment = true, show_audit_trail = true, updated_at = now()`,
        [fixtureId('e3000000', index + 1), engagementId]
      );
    }

    const notes = [
      [FIXTURE.engagements.harbour, 'PROJECT', FIXTURE.projects.marina, FIXTURE.companies.main, 'Latest progress photos and the updated two-week lookahead are available in the project pack.', false],
      [FIXTURE.engagements.harbour, 'PROJECT', FIXTURE.projects.marina, FIXTURE.companies.harbour, 'Client walk-through confirmed for Friday at 10:00. Please include the Level 12 meeting rooms.', false],
      [FIXTURE.engagements.harbour, 'INVOICE', fixtureId('df000000', 2), FIXTURE.companies.harbour, 'Invoice received and sent to accounts payable for the September payment run.', true],
      [FIXTURE.engagements.apex, 'TIME_LOG', logIds[7], FIXTURE.companies.main, 'Returned for correction because this overlaps another entry.', false],
    ] as const;
    for (const [index, note] of notes.entries()) {
      await db.query(
        `insert into line_item_notes
           (id, engagement_id, entity_type, entity_id, author_company_id,
            author_user_id, body, resolved, created_at, updated_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, '2026-08-19T06:00:00Z', now())
         on conflict (id) do update set body = excluded.body, resolved = excluded.resolved,
           updated_at = now()`,
        [fixtureId('e4000000', index + 1), ...note.slice(0, 4), userId, note[4], note[5]]
      );
    }

    const notifications = [
      [FIXTURE.companies.main, 'work.submitted', 'Time logs awaiting approval', 'Apex and Beacon have submitted four time logs for review.', 'TIME_LOG', logIds[5], '/review', true, null],
      [FIXTURE.companies.main, 'expense.submitted', 'Expense awaiting approval', 'Apex submitted cable containment consumables for approval.', 'EXPENSE', expenseIds[1], '/review', true, null],
      [FIXTURE.companies.main, 'rate_proposal.submitted', 'Rate proposal awaiting review', 'Apex submitted its September labour rate review.', 'RATE_PROPOSAL', FIXTURE.proposals.apexSubmitted, '/commercial', true, null],
      [FIXTURE.companies.apex, 'work.approved', 'Time log approved', 'Your 9 August Sunday shift was approved.', 'TIME_LOG', logIds[4], '/work', true, '2026-08-19T10:00:00Z'],
      [FIXTURE.companies.apex, 'work.rejected', 'Time log returned', 'One time log overlaps an earlier entry and needs correction.', 'TIME_LOG', logIds[7], '/work', true, null],
      [FIXTURE.companies.harbour, 'invoice.issued', 'New invoice from Northstar', 'Invoice CQ-2026-000042 is ready for review.', 'INVOICE', fixtureId('df000000', 2), '/invoices', false, null],
    ] as const;
    for (const [index, row] of notifications.entries()) {
      const [companyId, kind, title, body, subjectType, subjectId, actionUrl, requiresAction, resolvedAt] = row;
      await db.query(
        `insert into notifications
           (id, recipient_user_id, company_id, kind, title, body, subject_type, subject_id,
            action_url, requires_action, urgency, dedupe_key, read_at, resolved_at,
            resolved_by_user_id, created_at, updated_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'NORMAL', $11,
                 $12, $13, $14, '2026-08-19T08:00:00Z', now())
         on conflict (dedupe_key) do update set
           title = excluded.title,
           body = excluded.body,
           requires_action = excluded.requires_action,
           resolved_at = excluded.resolved_at,
           resolved_by_user_id = excluded.resolved_by_user_id,
           updated_at = now()`,
        [
          fixtureId('e1000000', index + 1),
          userId,
          companyId,
          kind,
          title,
          body,
          subjectType,
          subjectId,
          actionUrl,
          requiresAction,
          `demo-single-login-v1:${index + 1}`,
          index > 2 ? '2026-08-19T11:00:00Z' : null,
          resolvedAt,
          resolvedAt ? userId : null,
        ]
      );
    }

    const audit = [
      [FIXTURE.companies.main, 'company.created', 'COMPANY', FIXTURE.companies.main, 'Northstar demo workspace created', false],
      [FIXTURE.companies.main, 'engagement.created', 'ENGAGEMENT', FIXTURE.engagements.apex, 'Apex Site Services added as a subcontractor', false],
      [FIXTURE.companies.main, 'engagement.created', 'ENGAGEMENT', FIXTURE.engagements.beacon, 'Beacon Electrical added as a subcontractor', false],
      [FIXTURE.companies.main, 'project.created', 'PROJECT', FIXTURE.projects.marina, 'Marina Bay Office Fit-Out created', true],
      [FIXTURE.companies.main, 'assignment.accepted', 'ASSIGNMENT', fixtureId('db000000', 1), 'Apex accepted the Marina Bay assignment', true],
      [FIXTURE.companies.main, 'time_log.approved', 'TIME_LOG', logIds[0], 'Site supervision time log approved (9h)', true],
      [FIXTURE.companies.main, 'time_log.approved', 'TIME_LOG', logIds[1], 'Electrical time log approved (10h)', true],
      [FIXTURE.companies.main, 'expense.approved', 'EXPENSE', expenseIds[0], 'CBD parking and ERP expense approved', true],
      [FIXTURE.companies.main, 'invoice.issued', 'INVOICE', fixtureId('df000000', 2), 'Invoice CQ-2026-000042 issued to Harbour Property Group', true],
      [FIXTURE.companies.apex, 'rate_proposal.submitted', 'RATE_PROPOSAL', FIXTURE.proposals.apexSubmitted, 'September labour rate review submitted', false],
      [FIXTURE.companies.apex, 'time_log.submitted', 'TIME_LOG', logIds[5], 'Time log for 2026-08-17 submitted (8h)', true],
      [FIXTURE.companies.apex, 'time_log.rejected', 'TIME_LOG', logIds[7], 'Time log for 2026-08-12 returned for correction', true],
      [FIXTURE.companies.harbour, 'note.created', 'PROJECT', FIXTURE.projects.marina, 'Client added a project note', true],
    ] as const;
    for (const [index, row] of audit.entries()) {
      await db.query(
        `insert into audit_logs
           (id, company_id, actor_user_id, action, entity_type, entity_id, changes,
            description, visible_to_client, created_at, expires_at)
         values ($1, $2, $3, $4, $5, $6, '{}'::jsonb, $7, $8,
                 '2026-08-19T07:00:00Z'::timestamptz + ($9 || ' minutes')::interval,
                 '2027-08-20T00:00:00Z')
         on conflict (id) do nothing`,
        [fixtureId('e2000000', index + 1), row[0], userId, row[1], row[2], row[3], row[4], row[5], index]
      );
    }


    /*
     * ── Sustainability (§26–§28), so the phase's four screens have something on
     *    them ───────────────────────────────────────────────────────────────────
     *
     * Carbon is a product of masses, so this necessarily brings a slice of Phase 8
     * with it — a register line and where it went. That is not scope creep: a
     * Sustainability section over an empty mass balance renders correctly and shows
     * nothing, which is the state the demo exists to avoid.
     *
     * THE FACTOR SET IS OBVIOUSLY SYNTHETIC AND SAYS SO. §45's licensing gate on
     * the published UK Government conversion factors is unanswered, and §26.2's
     * "zero fabricated rows" is a rule about what the product ships. A demo fixture
     * that looked like a published dataset would be exactly the fabricated row that
     * rule forbids, wearing a demo label — so it is named "CrewQuo — demonstration
     * data" and its figures are round.
     */
    const CHAIR_TYPE = (
      await db.query<{ id: string }>(
        `select id from asset_types where company_id is null and code = 'OPERATOR_CHAIR'`
      )
    ).rows[0]?.id;
    const DESK_TYPE = (
      await db.query<{ id: string }>(
        `select id from asset_types where company_id is null and code = 'DESK'`
      )
    ).rows[0]?.id;
    const destinationIds = Object.fromEntries(
      (
        await db.query<{ code: string; id: string }>(
          `select code, id from destination_types where company_id is null`
        )
      ).rows.map((r) => [r.code, r.id])
    );

    if (CHAIR_TYPE && DESK_TYPE) {
      const assets = [
        // 42 chairs: 30 donated, 12 recycled — the split Phase 8's milestone proved.
        [fixtureId('e3000000', 1), CHAIR_TYPE, 42, 16.5],
        // 8 desks into storage, which counts toward no rate at all (decision #18)
        // and is therefore what puts a named gap on the screen.
        [fixtureId('e3000000', 2), DESK_TYPE, 8, 30],
      ] as const;
      for (const [id, typeId, quantity, unitWeight] of assets) {
        await db.query(
          `insert into project_assets
             (id, project_id, company_id, asset_type_id, quantity, weight_basis,
              unit_weight_kg, total_weight_kg, weight_source, weight_confidence,
              weight_is_estimated, created_by_user_id, created_at, updated_at)
           values ($1, $2, $3, $4, $5::numeric, 'UNIT', $6::numeric, $5::numeric * $6::numeric, 'USER_ESTIMATE', 'ESTIMATED',
                   true, $7, '2026-08-04T08:00:00Z', '2026-08-04T08:00:00Z')
           on conflict (id) do nothing`,
          [id, FIXTURE.projects.marina, FIXTURE.companies.main, typeId, quantity, unitWeight, userId]
        );
      }

      const movements = [
        [fixtureId('e4000000', 1), fixtureId('e3000000', 1), destinationIds.DONATION, 30, 1],
        [fixtureId('e4000000', 2), fixtureId('e3000000', 1), destinationIds.RECYCLING, 12, 2],
        [fixtureId('e4000000', 3), fixtureId('e3000000', 2), destinationIds.STORAGE, 8, 1],
      ] as const;
      for (const [id, assetId, destinationId, quantity, sequence] of movements) {
        if (!destinationId) continue;
        await db.query(
          `insert into asset_movements
             (id, asset_id, sequence, destination_type_id, quantity, moved_on,
              recorded_by_user_id, created_at, updated_at)
           values ($1, $2, $3, $4, $5, '2026-08-05', $6,
                   '2026-08-05T09:00:00Z', '2026-08-05T09:00:00Z')
           on conflict (id) do nothing`,
          [id, assetId, sequence, destinationId, quantity, userId]
        );
      }
      // Derived, never typed (§25.4 rule 2) — and normally written by the API inside
      // the asset's row lock. Set here because this fixture writes the movements
      // directly, and a register that reads PENDING beside a full allocation is the
      // one thing this table must never say.
      await db.query(
        `update project_assets set outcome_state = 'FINAL' where id = $1`,
        [fixtureId('e3000000', 1)]
      );
      await db.query(
        `update project_assets set outcome_state = 'IN_STORAGE' where id = $1`,
        [fixtureId('e3000000', 2)]
      );

      const FACTOR_SET = fixtureId('e5000000', 1);
      await db.query(
        `insert into emission_factor_sets
           (id, company_id, name, source_organisation, reporting_year, version,
            valid_from, region, methodology, imported_by_user_id, created_at, updated_at)
         values ($1, $2, 'CrewQuo Demonstration Factors 2026', 'CrewQuo — demonstration data',
                 2026, 'v1.0', '2026-01-01', 'SG',
                 'Synthetic figures for demonstration only. Not a published dataset.',
                 $3, '2026-08-01T09:00:00Z', '2026-08-01T09:00:00Z')
         on conflict (id) do nothing`,
        [FACTOR_SET, FIXTURE.companies.main, userId]
      );
      const factors = [
        ['Waste', 'Reuse', 'Operator chair', 'REUSE', null, null, 'tonne', 21.28, null],
        ['Waste', 'Recycling', 'Operator chair', 'RECYCLING', null, null, 'tonne', 21.28, null],
        ['Waste', 'Landfill', null, 'LANDFILL', null, null, 'tonne', 587.0, null],
        ['Fuels', 'Diesel', null, null, null, 'DIESEL', 'litre', 2.5, 0.6],
        ['Transport', 'Van', null, null, 'VAN', 'DIESEL', 'km', 0.25, 0.05],
        ['Electricity', 'Grid electricity', null, null, null, null, 'kWh', 0.2, null],
      ] as const;
      for (const [index, row] of factors.entries()) {
        await db.query(
          `insert into emission_factors
             (id, factor_set_id, category, activity, material, treatment, vehicle_type,
              fuel_type, unit, kg_co2e_per_unit, wtt_kg_co2e_per_unit)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
           on conflict (id) do nothing`,
          [fixtureId('e6000000', index + 1), FACTOR_SET, ...row]
        );
      }

      await db.query(
        `insert into product_carbon_factors
           (id, company_id, item_category, asset_type_id, kg_co2e_per_item,
            lifecycle_boundary, source, verification_status, is_estimate,
            created_by_user_id, created_at, updated_at)
         values ($1, $2, 'FURNITURE', $3, 72, 'A1_A3', 'CrewQuo — demonstration data',
                 'EPD_VERIFIED', false, $4, '2026-08-01T09:00:00Z', '2026-08-01T09:00:00Z')
         on conflict (id) do nothing`,
        [fixtureId('e7000000', 1), FIXTURE.companies.main, CHAIR_TYPE, userId]
      );

      /*
       * A STATED displacement assumption, which is the only way a claim exists at
       * all. `sustainability_settings` was backfilled with UNKNOWN by 0037 —
       * correctly, since UNKNOWN produces no claim — so the demo has to say
       * something explicit for the avoided figure to appear, and what it says is
       * recorded on every claim it produces.
       */
      await db.query(
        `update sustainability_settings
            set default_displacement_basis = 'USER_DEFINED',
                default_displacement_pct = 80,
                default_country = 'SG',
                updated_by_user_id = $2,
                updated_at = now()
          where company_id = $1`,
        [FIXTURE.companies.main, userId]
      );

      const activities = [
        ['VEHICLE_DISTANCE', 'COLLECTION', 240, null, null, 'VAN', 'DIESEL', fixtureId('e4000000', 1)],
        ['FUEL', 'PLANT', null, 180, null, null, 'DIESEL', null],
        ['ELECTRICITY', 'OTHER', null, null, 1200, null, null, null],
      ] as const;
      for (const [index, row] of activities.entries()) {
        const [kind, purpose, km, litres, kwh, vehicle, fuel, movementId] = row;
        await db.query(
          `insert into project_activities
             (id, project_id, company_id, kind, activity_date, vehicle_category, fuel_type,
              distance_km, litres, kwh, entered_value, entered_unit, purpose,
              asset_movement_id, source, created_by_user_id, created_at, updated_at)
           values ($1, $2, $3, $4, '2026-08-05', $5, $6,
                   $7::numeric, $8::numeric, $9::numeric,
                   coalesce($7::numeric, $8::numeric, $9::numeric),
                   case when $7::numeric is not null then 'km'
                        when $8::numeric is not null then 'litre'
                        else 'kWh' end,
                   $10, $11, 'DOCUMENTED', $12,
                   '2026-08-05T10:00:00Z', '2026-08-05T10:00:00Z')
           on conflict (id) do nothing`,
          [
            fixtureId('e8000000', index + 1), FIXTURE.projects.marina, FIXTURE.companies.main,
            kind, vehicle, fuel, km, litres, kwh, purpose, movementId, userId,
          ]
        );
      }
    }

    // ── Phase 11: variations, a budget, a fleet and a week (§30, §31) ────────
    //
    // What this slice is for: **six of §30.2's ten budget categories have no source
    // of money anywhere in the schema**, and the only way to see that rendering
    // honestly rather than as `-100%` is to have a budget with a figure in one of
    // them. So `vehicle_cents` is deliberately non-zero here, against an actual that
    // will always be null.
    //
    // The variations are three, in three different states, because the states are
    // what the panel is about: one approved WITH the client's own agreement on file,
    // one approved WITHOUT it (so the badge packet §3 exists for is visible on a
    // demo account), and one rejected with a reason.
    {
      const van = fixtureId('e9000000', 1);
      const truck = fixtureId('e9000000', 2);
      for (const [id, name, registration, category, fuel, activity] of [
        [van, 'Transit 350', 'LX21 ABC', 'Van (class III)', 'DIESEL', 'van_class_iii_diesel'],
        [truck, 'Tipper 18t', 'HG22 XYZ', 'HGV rigid 7.5-17t', 'DIESEL', 'hgv_rigid_diesel'],
      ] as const) {
        await db.query(
          `insert into vehicles (id, company_id, name, registration, category, fuel_type,
                                 emission_factor_activity, created_at, updated_at)
           values ($1, $2, $3, $4, $5, $6, $7, now(), now())
           on conflict (id) do nothing`,
          [id, FIXTURE.companies.main, name, registration, category, fuel, activity]
        );
      }

      /*
       * Three variations. `sell_total_cents` and `cost_total_cents` are written here
       * from the same arithmetic the API uses, and the check constraint on
       * `variation_lines` verifies the line halves for us — a fixture whose totals
       * disagreed with its lines would be refused by the database rather than
       * quietly seeding a drift, which is the whole point of finding 5.
       */
      const variations = [
        {
          id: fixtureId('ea000000', 1),
          reference: 'VO-011',
          description: 'Additional fire-rated doors to the level 12 core',
          reason: 'Client changed the fire strategy after the survey',
          requestedBy: 'Dana Whitfield',
          requestedOn: '2026-08-04',
          status: 'APPROVED',
          clientApprovedBy: 'Dana Whitfield',
          reviewedAt: '2026-08-05T09:30:00Z',
          rejectReason: null,
          lines: [
            ['MATERIAL', 'Fire door sets', 4, 24000, 31000],
            ['LABOUR', 'Rigger, 16h', 16, 3750, 5500],
          ] as const,
        },
        {
          id: fixtureId('ea000000', 2),
          reference: 'VO-012',
          description: 'Make good the ceiling grid after the riser works',
          reason: null,
          requestedBy: 'Site meeting, 11 Aug',
          requestedOn: '2026-08-11',
          // Approved on the phone; the paperwork has not arrived. The badge this
          // produces is the one thing packet §3's warning is for, and a demo account
          // with only the tidy case would never show it.
          status: 'APPROVED',
          clientApprovedBy: null,
          reviewedAt: '2026-08-11T16:00:00Z',
          rejectReason: null,
          lines: [['MATERIAL', 'Grid tiles', 40, 450, 700]] as const,
        },
        {
          id: fixtureId('ea000000', 3),
          reference: 'VO-013',
          description: 'Replace the ironmongery throughout',
          reason: 'Raised on site without a price agreed',
          requestedBy: 'Foreman',
          requestedOn: '2026-08-18',
          status: 'REJECTED',
          clientApprovedBy: null,
          reviewedAt: '2026-08-19T08:15:00Z',
          rejectReason: 'Client wants this priced separately as a package',
          lines: [['MATERIAL', 'Ironmongery sets', 30, 5000, 7000]] as const,
        },
      ];

      for (const [variationIndex, variation] of variations.entries()) {
        const totals = variation.lines.reduce(
          (acc, [, , quantity, unitCost, unitSell]) => ({
            cost: acc.cost + Math.round((quantity * 100 * unitCost) / 100),
            sell: acc.sell + Math.round((quantity * 100 * unitSell) / 100),
          }),
          { cost: 0, sell: 0 }
        );
        await db.query(
          `insert into variations
             (id, project_id, company_id, engagement_id, reference, description, reason,
              requested_by, requested_on, status, sell_total_cents, cost_total_cents,
              client_approved_by, client_approved_at, reviewed_by_user_id, reviewed_at,
              reject_reason, created_by_user_id, created_at, updated_at)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9::date, $10, $11, $12,
                   $13, case when $13::text is null then null else $14::timestamptz end,
                   $15, $14::timestamptz, $16, $15, $14::timestamptz, $14::timestamptz)
           on conflict (id) do nothing`,
          [
            variation.id, FIXTURE.projects.marina, FIXTURE.companies.main,
            FIXTURE.engagements.harbour, variation.reference, variation.description,
            variation.reason, variation.requestedBy, variation.requestedOn,
            variation.status, totals.sell, totals.cost,
            variation.clientApprovedBy, variation.reviewedAt, userId, variation.rejectReason,
          ]
        );
        for (const [index, line] of variation.lines.entries()) {
          const [kind, description, quantity, unitCost, unitSell] = line;
          await db.query(
            `insert into variation_lines
               (id, variation_id, kind, description, quantity, unit_cost_cents,
                unit_sell_cents, cost_cents, sell_cents, priced_from, created_at)
             -- Every parameter cast at BOTH use sites. Postgres infers one type per
             -- placeholder, so a parameter appearing as an int column and inside a
             -- numeric multiplication is a 42P08 ("numeric versus integer") rather
             -- than a coercion, which is what the first run of this fixture hit.
             --
             -- (And no backticks in this comment, for the third time in one phase: a
             -- backtick inside a template literal ENDS the template, so quoting a
             -- parameter name that way breaks the query it documents -- and tsc
             -- passes, because what is left is still valid TypeScript.)
             values ($1, $2, $3, $4, $5::numeric, $6::int, $7::int,
                     round($5::numeric * $6::numeric),
                     round($5::numeric * $7::numeric), 'STATED', now())
             on conflict (id) do nothing`,
            [
              /*
               * Derived from the variation's INDEX, not from a slice of its uuid.
               *
               * The first version used `variation.id.slice(0, 8)`, which is the
               * shared `ea000000` prefix — so all three variations' first lines
               * claimed the same id and `on conflict (id) do nothing` silently
               * dropped two of the three sets. The seed reported identical counts on
               * a re-run and looked perfectly deterministic; what it had produced was
               * two variation headers whose totals did not match their (missing)
               * lines.
               *
               * That is exactly the drift `commercial-operations.md` finding 5 says a
               * check constraint cannot catch — a CHECK cannot aggregate — and it is
               * why the parity assertion at the end of this file exists.
               */
              fixtureId('ea100000', variationIndex * 10 + index + 1),
              variation.id, kind, description, quantity, unitCost, unitSell,
            ]
          );
        }
      }

      /*
       * The budget. `vehicle_cents` is non-zero on purpose — see the note above.
       * Every other figure is set near the project's real approved work so the
       * variance table shows both readings §40 asks a colour to communicate rather
       * than one direction repeated ten times.
       */
      await db.query(
        `insert into project_budgets
           (id, project_id, company_id, revenue_cents, labour_cents, subcontractor_cents,
            vehicle_cents, waste_cents, materials_cents, expenses_cents, notes,
            created_by_user_id, updated_by_user_id, created_at, updated_at)
         values ($1, $2, $3, 4800000, 900000, 1600000, 240000, 180000, 320000, 60000,
                 'First cut, before the fire-strategy change. Revised figures to follow.',
                 $4, $4, now(), now())
         on conflict on constraint project_budgets_one_per_project do nothing`,
        [fixtureId('eb000000', 1), FIXTURE.projects.marina, FIXTURE.companies.main, userId]
      );

      // A week: two of the account's own people, a subcontractor crew and a van, on
      // one project, so the planner has something to drag.
      const week = [
        ['USER', userId, null, null, ROLE_IDS.supervisor, true, 1, '2026-08-17T07:00:00Z', '2026-08-17T17:00:00Z', 'WEEKDAY_DAY'],
        ['USER', userId, null, null, ROLE_IDS.supervisor, true, 1, '2026-08-18T07:00:00Z', '2026-08-18T17:00:00Z', 'WEEKDAY_DAY'],
        ['PROVIDER', null, FIXTURE.companies.apex, null, ROLE_IDS.electrician, false, 3, '2026-08-17T07:00:00Z', '2026-08-17T17:00:00Z', 'WEEKDAY_DAY'],
        ['VEHICLE', null, null, van, null, false, 1, '2026-08-17T07:00:00Z', '2026-08-17T17:00:00Z', null],
        ['USER', userId, null, null, ROLE_IDS.supervisor, false, 1, '2026-08-19T18:00:00Z', '2026-08-20T04:00:00Z', 'NIGHT'],
      ] as const;
      for (const [index, row] of week.entries()) {
        const [type, user, provider, vehicle, role, supervisor, headcount, from, to, shift] = row;
        await db.query(
          `insert into schedule_assignments
             (id, company_id, project_id, resource_type, user_id, provider_company_id,
              vehicle_id, role_id, is_supervisor, headcount, starts_at, ends_at,
              shift_type, status, batch_client_id, created_by_user_id, created_at, updated_at)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
                   $11::timestamptz, $12::timestamptz, $13,
                   case when $4 = 'PROVIDER' then 'CONFIRMED' else 'PLANNED' end,
                   $14, $15, now(), now())
           on conflict (id) do nothing`,
          [
            fixtureId('ec000000', index + 1), FIXTURE.companies.main, FIXTURE.projects.marina,
            type, user, provider, vehicle, role, supervisor, headcount, from, to, shift,
            fixtureId('ed000000', 1), userId,
          ]
        );
      }

      /*
       * "2 x Electrician, Mon-Wed" against three booked crew — met, so the demo does
       * not open on a warning. The shortfall indicator is exercised by the acceptance
       * script rather than by the fixture, because a demo that greets somebody with
       * an unfilled requirement reads as their data being wrong.
       */
      await db.query(
        `insert into project_role_requirements
           (id, project_id, company_id, role_id, quantity, starts_on, ends_on,
            created_by_user_id, created_at, updated_at)
         values ($1, $2, $3, $4, 2, '2026-08-17', '2026-08-19', $5, now(), now())
         on conflict (id) do nothing`,
        [fixtureId('ee000000', 1), FIXTURE.projects.marina, FIXTURE.companies.main,
         ROLE_IDS.electrician, userId]
      );

      // And the subcontractor's own stated crew count, which is what §31's headcount
      // warning compares against. Recorded on THEIR company, because it is a
      // statement they make about themselves.
      await db.query(
        `insert into resource_availability
           (id, company_id, resource_type, provider_company_id, kind, headcount,
            starts_at, ends_at, created_by_user_id, created_at, updated_at)
         values ($1, $2, 'PROVIDER', $2, 'AVAILABLE', 4,
                 '2026-08-01T00:00:00Z', '2026-09-01T00:00:00Z', $3, now(), now())
         on conflict (id) do nothing`,
        [fixtureId('ef000000', 1), FIXTURE.companies.apex, userId]
      );

      // The Phase 9 column that came due: the collection journey happened in the van.
      await db.query(
        `update project_activities set vehicle_id = $2
          where id = $1 and vehicle_id is null`,
        [fixtureId('e8000000', 1), van]
      );
    }

    await db.query('commit');

    const summary = await db.query<{
      companies: number;
      projects: number;
      rate_cards: number;
      rate_proposals: number;
      time_logs: number;
      expenses: number;
      submissions: number;
      invoices: number;
      asset_lines: number;
      emission_factors: number;
      activities: number;
      vehicles: number;
      variations: number;
      bookings: number;
    }>(
      `select
         (select count(*)::int from companies where settings->>'demoFixture' = 'single-login-v1') as companies,
         (select count(*)::int from projects where owner_company_id = $1) as projects,
         (select count(*)::int from rate_cards where company_id = $1) as rate_cards,
         (select count(*)::int from rate_proposals where id::text like 'd8000000-%') as rate_proposals,
         (select count(*)::int from time_logs where id::text like 'dc000000-%') as time_logs,
         (select count(*)::int from expenses where id::text like 'dd000000-%') as expenses,
         (select count(*)::int from project_submissions where id::text like 'de000000-%') as submissions,
         (select count(*)::int from invoices where id::text like 'df000000-%') as invoices,
         (select count(*)::int from project_assets where id::text like 'e3000000-%') as asset_lines,
         (select count(*)::int from emission_factors where id::text like 'e6000000-%') as emission_factors,
         (select count(*)::int from project_activities where id::text like 'e8000000-%') as activities,
         (select count(*)::int from vehicles where id::text like 'e9000000-%') as vehicles,
         (select count(*)::int from variations where id::text like 'ea000000-%') as variations,
         (select count(*)::int from schedule_assignments where id::text like 'ec000000-%') as bookings`,
      [FIXTURE.companies.main]
    );
    console.log(`Demo account ready: ${DEMO_EMAIL}`);
    console.log(summary.rows[0]);
    /*
     * The one thing this seed deliberately does NOT do.
     *
     * `carbon_calculations` rows are written by the engine under a project lock,
     * inside the transaction that triggers them (§27.2) — never by a fixture. A
     * seeded calculation would be a row claiming to be a derivation and not being
     * one, which is the exact thing "nobody corrects a calculation" forbids.
     *
     * So the demo ships the INPUTS and the section produces the figures the first
     * time somebody asks for them.
     */
    console.log(
      'Sustainability: open the Marina Bay project and press Recalculate to produce its figures.'
    );
    /*
     * The other thing worth pointing at, because it is the one screen in the demo
     * whose *empty cells* are the feature. Six of §30.2's ten categories have no
     * source of money anywhere in CrewQuo, and this fixture budgets a figure against
     * one of them on purpose so that "Not tracked" is visible rather than theoretical.
     */
    console.log(
      'Commercial: Marina Bay has three variations (one approved without the client’s ' +
        'agreement on file), a budget, a fleet and a week of crew. Its Budget section ' +
        'shows what CrewQuo can and cannot compute an actual for.'
    );

    /*
     * **The fixture proves its own totals, and it earned this on its first run.**
     *
     * Every other writer of `variations.sell_total_cents` goes through
     * `recalculateVariationTotals`, which derives the header from the lines inside
     * the same transaction. This file is the one place that writes both by hand — and
     * the first version produced two headers whose lines had been silently dropped by
     * a colliding `on conflict` id, reporting identical counts on a re-run and looking
     * entirely healthy.
     *
     * A CHECK constraint cannot catch that (`commercial-operations.md` finding 5: a
     * check cannot aggregate), so the assertion lives here, where the hand-written
     * total does. It throws rather than warning: a demo account whose variation totals
     * do not add up is worse than no demo account, because somebody will read the
     * figure off the screen.
     */
    const drift = await db.query<{ reference: string; header: number; lines: number }>(
      `select v.reference, v.sell_total_cents as header,
              coalesce(sum(l.sell_cents), 0)::int as lines
         from variations v
         left join variation_lines l on l.variation_id = v.id
        where v.id::text like 'ea000000-%'
        group by v.id, v.reference, v.sell_total_cents
       having v.sell_total_cents <> coalesce(sum(l.sell_cents), 0)`
    );
    if (drift.rowCount && drift.rowCount > 0) {
      throw new Error(
        'Demo fixture is inconsistent: a variation header does not equal the sum of its ' +
          `lines. ${JSON.stringify(drift.rows)}`
      );
    }
  } catch (error) {
    await db.query('rollback');
    throw error;
  } finally {
    await db.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
