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
    }>(
      `select
         (select count(*)::int from companies where settings->>'demoFixture' = 'single-login-v1') as companies,
         (select count(*)::int from projects where owner_company_id = $1) as projects,
         (select count(*)::int from rate_cards where company_id = $1) as rate_cards,
         (select count(*)::int from rate_proposals where id::text like 'd8000000-%') as rate_proposals,
         (select count(*)::int from time_logs where id::text like 'dc000000-%') as time_logs,
         (select count(*)::int from expenses where id::text like 'dd000000-%') as expenses,
         (select count(*)::int from project_submissions where id::text like 'de000000-%') as submissions,
         (select count(*)::int from invoices where id::text like 'df000000-%') as invoices`,
      [FIXTURE.companies.main]
    );
    console.log(`Demo account ready: ${DEMO_EMAIL}`);
    console.log(summary.rows[0]);
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
