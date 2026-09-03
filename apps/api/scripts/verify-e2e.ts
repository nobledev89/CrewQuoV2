/**
 * End-to-end verification against live Postgres.
 *
 * The plan's discipline (§13, §42) is that every phase is proved against a real
 * database before the next one starts, and that the earlier phases' scripts are
 * re-run green at the end of each phase. Those scripts had been ad-hoc; this is
 * the checked-in version, so "re-run them" is a command rather than an
 * archaeology exercise.
 *
 *   1. bring the DB up:  docker compose --env-file .env -f infra/docker-compose.yml up -d
 *   2. migrate + seed:   pnpm db:migrate && pnpm db:seed
 *   3. boot the API:     pnpm --filter @crewquo/api start
 *   4. run this:         pnpm --filter @crewquo/api verify:e2e
 *
 * Covers: the USD currency default and the company settings endpoint; rate label
 * rules as per-company data (including that the old hardcoded Fri/Sat branch is
 * genuinely gone); the Phase 3/4 core-loop numbers as a regression; and the
 * Phase 4 export engine, asserting the XLSX's own cells against the summary
 * endpoint so a file can't disagree with the screen.
 *
 * Every run uses a fresh set of accounts, so it is safe to re-run against a
 * database that already has data.
 */
import { createHash, createHmac, randomUUID } from 'node:crypto';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import jwt from 'jsonwebtoken';
import pg from 'pg';
import { env } from '../src/env';
import { pool } from '../src/db';
import {
  CAPABILITY_KEYS,
  SYSTEM_BUNDLE_CAPABILITIES,
  SYSTEM_BUNDLE_KEYS,
  COMPANY_CLOSURE_PLAN,
  COMPANY_REQUEST_APPROVAL_DAYS,
  SCHEDULED_JOBS,
  COMPANY_EXPORT,
  DELETION_COOLING_OFF_DAYS,
  PERSONAL_CLOSURE_PLAN,
  PERSONAL_EXPORT,
  base32Decode,
  canonicalJson,
  totpCounter,
  totpCounterBytes,
  totpTruncate,
} from '@crewquo/shared';
import sharpModule from 'sharp';
import { COMPANY_QUERIES, PERSONAL_QUERIES } from '../src/modules/data-export/queries';
import { runStorageBatch } from '../src/modules/storage/worker';
import { runDocumentExpiryBatch } from '../src/modules/documents/expiry';
import { runStorageAgeingBatch } from '../src/modules/assets/storageAgeing';
import { runComplianceExpiryBatch } from '../src/modules/compliance/expiry';
import { runArtifactRetentionBatch } from '../src/modules/storage/artifactRetention';
import { resolveOwnCapabilities } from '../src/modules/capabilities/resolve';
import { storageBytesForCompany } from '../src/modules/storage/repo';

/**
 * `sharp` as a callable, resolved once.
 *
 * The storage section needs a real decodable image, and making one here beats
 * checking a fixture in: the derivative assertions are about pixels, and the
 * first attempt used a hand-written 1×1 PNG that libpng refused outright. The
 * pipeline survived it exactly as designed — original stored, preview skipped —
 * and proved nothing about resizing.
 */
function sharpFactory(): (input: unknown) => {
  png: () => { toBuffer: () => Promise<Buffer> };
} {
  const mod = sharpModule as unknown as Record<string, unknown>;
  const callable = (mod.default ?? mod) as (input: unknown) => {
    png: () => { toBuffer: () => Promise<Buffer> };
  };
  return callable;
}
import { deriveKid, parseRetiredSecrets } from '../src/modules/auth/signingKeys';
import { currentAccessKid, signPurposeToken } from '../src/modules/auth/tokens';
import { readJobHealth, recordJobRun } from '../src/jobs/jobRuns';
import { runClosurePass } from '../src/jobs/closures';
import { runInboxBatch, runOutboxBatch } from '../src/modules/delivery/worker';
import { recordVerifiedWebhook, recoverStaleOutboxClaims } from '../src/modules/delivery/repo';
import { runNotificationDeliveryBatch } from '../src/modules/notifications/deliveryWorker';
import { NOTIFICATION_HANDLERS } from '../src/modules/notifications/handlers';
import { BILLING_INBOX_HANDLERS } from '../src/modules/billing/reconcile';

const BASE = process.env.VERIFY_API_URL ?? `http://127.0.0.1:${env.PORT}`;
const RUN = randomUUID().slice(0, 8);
const db = new pg.Client({ connectionString: env.DATABASE_URL });

let passed = 0;
const failures: string[] = [];

function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failures.push(name);
    console.log(`  FAIL ${name}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`);
  }
}

/** Key-order-independent stringify — jsonb round-trips don't preserve key order. */
function stable(value: unknown): string {
  return JSON.stringify(value, (_k, v) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)))
      : v
  );
}

function eq(name: string, actual: unknown, expected: unknown): void {
  check(name, stable(actual) === stable(expected), { actual, expected });
}

function section(title: string): void {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 68 - title.length))}`);
}

interface Res<T = any> {
  status: number;
  json: T;
  headers: Headers;
  buffer?: Buffer;
}

async function call<T = any>(
  method: string,
  path: string,
  opts: { token?: string; companyId?: string; body?: unknown; raw?: boolean } = {}
): Promise<Res<T>> {
  const headers: Record<string, string> = {};
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  if (opts.companyId) headers['X-Company-Id'] = opts.companyId;
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';

  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });

  if (opts.raw) {
    const buffer = Buffer.from(await res.arrayBuffer());
    return { status: res.status, json: undefined as T, headers: res.headers, buffer };
  }
  const text = await res.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = text;
  }
  return { status: res.status, json: json as T, headers: res.headers };
}

/**
 * Register a user; `companyName` makes them OWNER of a fresh real company.
 *
 * Invites are bound to the address they were issued to, so anyone who has to
 * accept one must register under exactly the invited address — hence `email`
 * being addressable rather than derived from the handle alone.
 */
async function register(handle: string, companyName?: string, emailOverride?: string) {
  const email = emailOverride ?? `${handle}+${RUN}@verify.crewquo.test`;
  const res = await call('POST', '/v1/auth/register', {
    body: { email, password: 'Verify-passw0rd!', name: handle, companyName },
  });
  if (res.status !== 201 && res.status !== 200) {
    throw new Error(`register ${handle} failed: ${res.status} ${JSON.stringify(res.json)}`);
  }
  return {
    email,
    userId: res.json.user.id as string,
    token: res.json.tokens.accessToken as string,
    companyId: (res.json.memberships[0]?.companyId as string | undefined) ?? null,
  };
}

/**
 * Promote an account to platform staff, **and give it the factor the console now
 * requires**.
 *
 * Both halves, because from build-order step 3 onwards they are one fact: a super
 * admin without a confirmed second factor is refused by `/v1/admin/*` (§13.1), so a
 * fixture that only flips the column produces staff who cannot reach the console
 * they were created to test. That is the mandate working, and it is also exactly
 * what a real deployment sees — every existing super admin must enrol before using
 * the console again, which they can do from `/security` without it.
 */
async function promoteToStaff(user: { userId: string; token: string }): Promise<void> {
  await db.query(`update users set is_super_admin = true where id = $1`, [user.userId]);
  const enrol = await call('POST', '/v1/me/mfa', { token: user.token });
  const secret = enrol.json?.secret as string;
  if (!secret) throw new Error(`could not enrol a factor for staff: ${JSON.stringify(enrol.json)}`);
  const counter = totpCounter(Date.now());
  const digest = new Uint8Array(
    createHmac('sha1', Buffer.from(base32Decode(secret))).update(totpCounterBytes(counter)).digest()
  );
  const confirmed = await call('POST', '/v1/me/mfa/confirm', {
    token: user.token,
    body: { code: totpTruncate(digest, 6) },
  });
  if (confirmed.status !== 200) {
    throw new Error(`could not confirm the staff factor: ${JSON.stringify(confirmed.json)}`);
  }
}

/**
 * Clear the rate-limit counters before a section that deliberately spends them.
 *
 * **Without this the suite is only re-runnable once every fifteen minutes**, and it
 * fails in the most confusing way possible: the *source* budget is shared by every
 * failed sign-in from this machine, so a second run inside the window starts locked
 * out and every later assertion reports a 429 instead of the thing it was testing.
 * That is a property of the limiter working, not of the code under test.
 *
 * Safe to do, and the reason is the same one the pruning job rests on: these rows
 * are operational counters, not evidence. The durable record that somebody was
 * locked out is a `platform_audit_logs` row, which is insert-only, outside every
 * purge, and untouched here.
 */
async function clearAuthAttempts(): Promise<void> {
  await db.query('delete from auth_attempts');
}

/** Put a company on a seeded plan. Fresh companies default to `crew` (no exports). */
async function subscribe(companyId: string, planId: string): Promise<void> {
  await db.query(
    `insert into company_subscriptions (company_id, plan_id, status)
     values ($1, $2, 'ACTIVE')
     on conflict (company_id) do update set plan_id = excluded.plan_id, status = 'ACTIVE'`,
    [companyId, planId]
  );
  // Entitlements resolve directly from Postgres, so the next request observes
  // this subscription without a process-local cache or manual invalidation.
}

/**
 * Drain the durable substrate the way `pnpm --filter @crewquo/api work` does.
 *
 * Called in-process rather than by shelling out to the CLI so the assertions can
 * run immediately after a known number of passes — the point being tested is what
 * the worker *does*, not how it is launched. Two passes because the first turns
 * outbox events into notifications and the second sends their channels; a single
 * pass would leave every delivery row untouched and make step 5 a false negative.
 */
/**
 * Drain both worker loops until there is nothing left to claim.
 *
 * **Loops rather than running one batch each**, because a single batch is bounded
 * and this script shares a database with the browser suite, which emits outbox
 * events and never runs a worker. Once that backlog exceeds one batch, a fresh
 * event sits behind it and an assertion like "the worker claims and delivers it"
 * fails for a reason that has nothing to do with the code under test — which is
 * exactly what happened at a 640-event backlog on 2026-08-19.
 *
 * Bounded by `MAX_PASSES` so a permanently-failing row cannot spin forever; the
 * loop stops as soon as a pass claims nothing, which is the normal case after one
 * or two passes.
 */
async function drainWorkers() {
  const MAX_PASSES = 100;
  /*
   * A pass claims this many, rather than the production default of 25.
   *
   * Headroom, not a fix for anything observed: the number that has to stay ahead
   * of a backlog is `PASSES × LIMIT`, the loop above was sized at a 640-event
   * backlog, and passes cost a round trip each while a bigger bite costs almost
   * nothing. **This does not touch the 3,578 events sitting PENDING locally** —
   * those have no registered handler, so the claim never sees them at all (see
   * the note under Phase 7 in PROGRESS.md).
   */
  const PASS_LIMIT = 500;
  let outbox = { claimed: 0, delivered: 0, failed: 0 };
  let deliveries = { claimed: 0, sent: 0, skipped: 0, failed: 0 };
  let drained = false;
  for (let pass = 0; pass < MAX_PASSES; pass += 1) {
    await recoverStaleOutboxClaims(0);
    const o = await runOutboxBatch({
      workerId: 'verify-e2e',
      handlers: NOTIFICATION_HANDLERS,
      limit: PASS_LIMIT,
    });
    const d = await runNotificationDeliveryBatch(PASS_LIMIT);
    outbox = {
      claimed: outbox.claimed + o.claimed,
      delivered: outbox.delivered + o.delivered,
      failed: outbox.failed + o.failed,
    };
    deliveries = {
      claimed: deliveries.claimed + d.claimed,
      sent: deliveries.sent + d.sent,
      skipped: deliveries.skipped + d.skipped,
      failed: deliveries.failed + d.failed,
    };
    if (o.claimed === 0 && d.claimed === 0) {
      drained = true;
      break;
    }
  }
  /*
   * And if it ever does run out of passes, say so *here* rather than letting it
   * surface as an unrelated assertion three sections later. The silent exit is
   * the defect worth closing: a bound that can be reached without anybody being
   * told is a bound that reports its own failure as somebody else's bug, and this
   * loop already had that shape once.
   */
  if (!drained) {
    const { rows } = await db.query<{ n: string }>(
      `select count(*)::int as n from delivery_outbox
        where status = 'PENDING' and topic = any($1::text[])`,
      [[...NOTIFICATION_HANDLERS.keys()]]
    );
    check(
      `the outbox drains within ${MAX_PASSES} passes of ${PASS_LIMIT}`,
      false,
      `${rows[0]?.n ?? '?'} handled events still pending — every assertion about a ` +
        `freshly enqueued notification below this point is unreliable`
    );
  }
  return { outbox, deliveries };
}

async function main(): Promise<void> {
  await db.connect();

  const health = await call('GET', '/healthz');
  if (health.status !== 200) {
    throw new Error(`API not reachable at ${BASE} — start it with: pnpm --filter @crewquo/api start`);
  }
  console.log(`API ${BASE} · db ${health.json.db} · run ${RUN}`);

  // ── Currency: USD default, user-changeable ────────────────────────────────
  section('Currency (owner decision: USD default, changeable)');

  const owner = await register('owner', `Meridian Contracts ${RUN}`);
  const meridian = owner.companyId!;
  await subscribe(meridian, 'pro');

  eq('a company created at registration starts on USD', owner.companyId ? 'USD' : null, 'USD');
  const reg = await call('GET', '/v1/companies/' + meridian, {
    token: owner.token,
    companyId: meridian,
  });
  eq('GET /v1/companies/:id returns the company', reg.status, 200);
  eq('...on USD, not the old GBP default', reg.json.company.currency, 'USD');

  const strangerId = randomUUID();
  const foreign = await call('GET', `/v1/companies/${strangerId}`, {
    token: owner.token,
    companyId: meridian,
  });
  eq('another company id 404s rather than leaking existence', foreign.status, 404);

  const toPhp = await call('PATCH', `/v1/companies/${meridian}`, {
    token: owner.token,
    companyId: meridian,
    body: { currency: 'php' },
  });
  eq('OWNER may change the currency', toPhp.status, 200);
  eq('...and it is upper-cased on the way in', toPhp.json.company.currency, 'PHP');

  const bad = await call('PATCH', `/v1/companies/${meridian}`, {
    token: owner.token,
    companyId: meridian,
    body: { currency: 'US' },
  });
  eq('a malformed ISO code is rejected', bad.status, 422);

  const empty = await call('PATCH', `/v1/companies/${meridian}`, {
    token: owner.token,
    companyId: meridian,
    body: {},
  });
  eq('an empty patch is rejected', empty.status, 422);

  await call('PATCH', `/v1/companies/${meridian}`, {
    token: owner.token,
    companyId: meridian,
    body: { currency: 'USD' },
  });

  const trail = await call('GET', '/v1/audit-logs?entityType=COMPANY', {
    token: owner.token,
    companyId: meridian,
  });
  const currencyRow = trail.json.data.find(
    (r: any) => r.action === 'company.updated' && r.changes?.currency
  );
  check('the currency change is audited', Boolean(currencyRow), trail.json.data.length);
  eq('...with both sides of the change', currencyRow?.changes?.currency, {
    from: 'PHP',
    to: 'USD',
  });
  eq('...and is never client-visible', currencyRow?.visibleToClient, false);

  // A MEMBER may read the company but not change its money settings.
  const memberInvite = await call('POST', '/v1/members/invite', {
    token: owner.token,
    companyId: meridian,
    body: { email: `crew+${RUN}@verify.crewquo.test`, role: 'MEMBER' },
  });
  const memberUser = await register('crew', undefined, `crew+${RUN}@verify.crewquo.test`);
  await call('POST', `/v1/invites/${memberInvite.json.inviteToken}/accept`, {
    token: memberUser.token,
  });
  const memberPatch = await call('PATCH', `/v1/companies/${meridian}`, {
    token: memberUser.token,
    companyId: meridian,
    body: { currency: 'EUR' },
  });
  eq('a MEMBER cannot change the currency', memberPatch.status, 403);
  const memberRead = await call('GET', `/v1/companies/${meridian}`, {
    token: memberUser.token,
    companyId: meridian,
  });
  eq('...but can still read the company', memberRead.status, 200);

  // ── Label rules as data ───────────────────────────────────────────────────
  section('Rate label rules (owner decision: nothing hardcoded)');

  const role = await call('POST', '/v1/role-catalog', {
    token: owner.token,
    companyId: meridian,
    body: { name: 'Electrician' },
  });
  const roleId = role.json.role.id as string;

  const WEEKEND_RULE = {
    type: 'label_rule' as const,
    shiftType: 'NIGHT' as const,
    daysOfWeek: [5, 6],
    label: 'FRI_SAT_NIGHT' as const,
  };

  const tpl = await call('POST', '/v1/rate-card-templates', {
    token: owner.token,
    companyId: meridian,
    body: { name: 'House rules', timeframeDefinitions: [WEEKEND_RULE], isDefault: true },
  });
  eq('a template carrying a label rule is created', tpl.status, 201);
  eq('...and is the default', tpl.json.template.isDefault, true);
  const templateId = tpl.json.template.id as string;

  const mkCard = (body: Record<string, unknown>) =>
    call('POST', '/v1/rate-cards', { token: owner.token, companyId: meridian, body });

  await mkCard({
    kind: 'PAY',
    roleId,
    rateMode: 'HOURLY',
    rateLabel: 'MON_THU_NIGHT',
    hourlyRateCents: 6000,
    effectiveFrom: '2026-01-01',
  });
  await mkCard({
    kind: 'PAY',
    roleId,
    rateMode: 'HOURLY',
    rateLabel: 'FRI_SAT_NIGHT',
    hourlyRateCents: 8000,
    effectiveFrom: '2026-01-01',
  });

  const FRIDAY = '2026-07-24';
  const resolveNight = () =>
    call(
      'GET',
      `/v1/rates/resolve?roleId=${roleId}&shiftType=NIGHT&date=${FRIDAY}&kind=PAY`,
      { token: owner.token, companyId: meridian }
    );

  const withRule = await resolveNight();
  eq('a Friday night resolves through the company rule', withRule.json.label, 'FRI_SAT_NIGHT');
  eq('...to the weekend-night card', withRule.json.baseCents, 8000);

  await call('PATCH', `/v1/rate-card-templates/${templateId}`, {
    token: owner.token,
    companyId: meridian,
    body: { timeframeDefinitions: [] },
  });
  const withoutRule = await resolveNight();
  eq(
    'with the rule removed the same Friday falls back to the baseline',
    withoutRule.json.label,
    'MON_THU_NIGHT'
  );
  eq('...proving the Fri/Sat branch is gone from the engine', withoutRule.json.baseCents, 6000);

  // A company can invert the shipped assumption entirely.
  await call('PATCH', `/v1/rate-card-templates/${templateId}`, {
    token: owner.token,
    companyId: meridian,
    body: {
      timeframeDefinitions: [{ ...WEEKEND_RULE, daysOfWeek: [0] }],
    },
  });
  const sundayOnly = await resolveNight();
  eq('a Sunday-only rule leaves Friday on the baseline', sundayOnly.json.label, 'MON_THU_NIGHT');

  await call('PATCH', `/v1/rate-card-templates/${templateId}`, {
    token: owner.token,
    companyId: meridian,
    body: { timeframeDefinitions: [WEEKEND_RULE] },
  });

  // Several rules on one template, matched independently by shift type.
  await call('PATCH', `/v1/rate-card-templates/${templateId}`, {
    token: owner.token,
    companyId: meridian,
    body: {
      timeframeDefinitions: [
        WEEKEND_RULE,
        // Aimed at MON_THU_NIGHT because that label has a card (6000). Pointing a
        // rule at a label with no card proves nothing: /resolve 404s on the
        // missing card and the response carries no label to assert against.
        { type: 'label_rule', shiftType: 'WEEKDAY_DAY', daysOfWeek: [0], label: 'MON_THU_NIGHT' },
      ],
    },
  });
  const multiNight = await resolveNight();
  eq('with two rules, the NIGHT rule still applies', multiNight.json.label, 'FRI_SAT_NIGHT');
  const multiDay = await call(
    'GET',
    `/v1/rates/resolve?roleId=${roleId}&shiftType=WEEKDAY_DAY&date=2026-07-26&kind=PAY`,
    { token: owner.token, companyId: meridian }
  );
  eq('...and the second rule redirects a Sunday day shift', multiDay.json.label, 'MON_THU_NIGHT');
  eq('...onto that label’s card', multiDay.json.baseCents, 6000);
  await call('PATCH', `/v1/rate-card-templates/${templateId}`, {
    token: owner.token,
    companyId: meridian,
    body: { timeframeDefinitions: [WEEKEND_RULE] },
  });

  const overlapping = await call('POST', '/v1/rate-card-templates', {
    token: owner.token,
    companyId: meridian,
    body: {
      name: 'Contradictory',
      timeframeDefinitions: [WEEKEND_RULE, { ...WEEKEND_RULE, label: 'SUNDAY' }],
    },
  });
  eq('two rules claiming the same shift/day are rejected', overlapping.status, 422);

  const second = await call('POST', '/v1/rate-card-templates', {
    token: owner.token,
    companyId: meridian,
    body: { name: 'Second', timeframeDefinitions: [], isDefault: true },
  });
  const list = await call('GET', '/v1/rate-card-templates', {
    token: owner.token,
    companyId: meridian,
  });
  const defaults = list.json.data.filter((t: any) => t.isDefault);
  eq('promoting a second template leaves exactly one default', defaults.length, 1);
  eq('...and it is the new one', defaults[0]?.id, second.json.template.id);

  await call('PATCH', `/v1/rate-card-templates/${templateId}`, {
    token: owner.token,
    companyId: meridian,
    body: { isDefault: true },
  });
  const restored = await resolveNight();
  eq('restoring the default restores the rule', restored.json.label, 'FRI_SAT_NIGHT');

  // ── Core loop regression (Phase 3/4 numbers) ──────────────────────────────
  section('Core loop regression (PAY 40000 · BILL 65550 · margin 24000 / 36.61%)');

  const providerRes = await call('POST', '/v1/providers', {
    token: owner.token,
    companyId: meridian,
    body: { name: `Northgate Electrical ${RUN}`, email: `provider+${RUN}@verify.crewquo.test` },
  });
  eq('a provider placeholder + engagement + invite is created', providerRes.status, 201);
  const providerUser = await register(
    'provider',
    undefined,
    `provider+${RUN}@verify.crewquo.test`
  );
  const accepted = await call(
    'POST',
    `/v1/invites/${providerRes.json.inviteToken}/accept`,
    { token: providerUser.token }
  );
  eq('the provider accepts and owns the placeholder', accepted.status, 201);
  eq('...claiming it rather than merging (they owned nothing)', accepted.json.merge?.outcome, 'CLAIMED');
  const northgate = providerRes.json.provider.providerCompanyId as string;

  const clientRes = await call('POST', '/v1/clients', {
    token: owner.token,
    companyId: meridian,
    body: { name: `Harbour Group ${RUN}`, email: `client+${RUN}@verify.crewquo.test` },
  });
  eq('a portal client is created', clientRes.status, 201);
  const harbour = clientRes.json.client.clientCompanyId as string;

  await mkCard({
    kind: 'PAY',
    counterpartyCompanyId: northgate,
    roleId,
    rateMode: 'HOURLY',
    rateLabel: 'MON_FRI_DAY',
    hourlyRateCents: 5000,
    effectiveFrom: '2026-01-01',
  });
  await mkCard({
    kind: 'BILL',
    counterpartyCompanyId: harbour,
    roleId,
    rateMode: 'HOURLY',
    rateLabel: 'MON_FRI_DAY',
    hourlyRateCents: 8000,
    effectiveFrom: '2026-01-01',
  });

  const project = await call('POST', '/v1/projects', {
    token: owner.token,
    companyId: meridian,
    body: {
      name: `Pier 9 Fit-Out ${RUN}`,
      clientCompanyId: harbour,
      engagementId: clientRes.json.client.engagementId,
      clientVisible: true,
      startsOn: '2026-07-20',
      notes: 'Verification fixture.',
    },
  });
  const projectId = project.json.project.id as string;

  const assignment = await call('POST', `/v1/projects/${projectId}/assignments`, {
    token: owner.token,
    companyId: meridian,
    body: { providerCompanyId: northgate },
  });
  eq('the provider is assigned', assignment.status, 201);

  const log = await call('POST', '/v1/time-logs', {
    token: providerUser.token,
    companyId: northgate,
    body: {
      projectId,
      roleId,
      shiftType: 'WEEKDAY_DAY',
      workDate: '2026-07-20',
      hoursRegular: 8,
      hoursOt: 0,
    },
  });
  eq('the provider logs 8h as a DRAFT', log.json.timeLog.status, 'DRAFT');
  const logId = log.json.timeLog.id as string;

  const submitted = await call('POST', `/v1/time-logs/${logId}/submit`, {
    token: providerUser.token,
    companyId: northgate,
  });
  eq('submitting freezes the PAY snapshot at 8h × 5000', submitted.json.timeLog.resolvedRate?.costCents, 40000);
  eq('...under the label the rules resolved', submitted.json.timeLog.resolvedRate?.label, 'MON_FRI_DAY');

  const approved = await call('POST', `/v1/time-logs/${logId}/approve`, {
    token: owner.token,
    companyId: meridian,
  });
  eq('the client side approves', approved.json.timeLog.status, 'APPROVED');

  const expense = await call('POST', '/v1/expenses', {
    token: providerUser.token,
    companyId: northgate,
    body: { projectId, amountCents: 1550, category: 'TRAVEL', description: 'Site parking' },
  });
  eq('the provider raises an expense', expense.status, 201);
  const expenseId = expense.json.expense.id as string;
  const expenseSubmit = await call('POST', `/v1/expenses/${expenseId}/submit`, {
    token: providerUser.token,
    companyId: northgate,
  });
  // Regression guard: this 500'd until the `$3::uuid` cast in `transitionExpense`
  // — the whole expense workflow had never actually run.
  eq('the expense submits', expenseSubmit.status, 200);
  eq('...to SUBMITTED', expenseSubmit.json.expense.status, 'SUBMITTED');
  const expenseApprove = await call('POST', `/v1/expenses/${expenseId}/approve`, {
    token: owner.token,
    companyId: meridian,
  });
  eq('the client side approves the expense', expenseApprove.status, 200);
  eq('...to APPROVED', expenseApprove.json.expense.status, 'APPROVED');

  const summary = await call('GET', `/v1/projects/${projectId}/summary`, {
    token: owner.token,
    companyId: meridian,
  });
  const s = summary.json.summary;
  eq('summary labour cost is the frozen PAY total', s.laborCostCents, 40000);
  eq('summary expenses pass through at cost', s.expenseCostCents, 1550);
  eq('summary bill is 8h × 8000 + expenses at cost', s.billCents, 65550);
  eq('summary margin is BILL − total cost', s.marginCents, 24000);
  // 24000 / 65550 = 36.6133% → 36.61 at 2dp. Expenses pass through at cost, so
  // they dilute the percentage without changing the cash margin.
  eq('summary margin % is 36.61', s.marginPct, 36.61);
  /*
   * Phase 11's four fields on a project with no variations — the backward-
   * compatibility half of §44, asserted here rather than in the Phase 11 section
   * because *here* is where a regression would show. `computeProjectSummary` gained
   * its first second writer in nine phases, and the property that has to survive
   * is that a project with nothing agreed reads exactly as it did before.
   */
  eq('a project with no variations reports zero rather than null', [
    s.approvedVariations, s.variationSellCents, s.variationCostCents,
  ], [0, 0, 0]);
  eq('...and revenue is exactly the bill total', s.revenueCents, 65550);

  // ── Export engine ─────────────────────────────────────────────────────────
  section('Export engine (Phase 4)');

  const pdf = await call('GET', `/v1/projects/${projectId}/export.pdf`, {
    token: owner.token,
    companyId: meridian,
    raw: true,
  });
  eq('GET export.pdf returns 200', pdf.status, 200);
  eq('...as a PDF content type', pdf.headers.get('content-type'), 'application/pdf');
  eq('...with PDF magic bytes', pdf.buffer?.subarray(0, 5).toString(), '%PDF-');
  check('...as an attachment with a slugged filename',
    /^attachment; filename="pier-9-fit-out-[a-z0-9]+\.pdf"$/.test(
      pdf.headers.get('content-disposition') ?? ''
    ),
    pdf.headers.get('content-disposition')
  );
  check('...and is not cacheable', pdf.headers.get('cache-control') === 'no-store');
  check('...with real content in it', (pdf.buffer?.byteLength ?? 0) > 2000, pdf.buffer?.byteLength);

  const xlsx = await call('GET', `/v1/projects/${projectId}/export.xlsx`, {
    token: owner.token,
    companyId: meridian,
    raw: true,
  });
  eq('GET export.xlsx returns 200', xlsx.status, 200);
  eq(
    '...as a spreadsheet content type',
    xlsx.headers.get('content-type'),
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  );
  eq('...with ZIP magic bytes', xlsx.buffer?.subarray(0, 2).toString(), 'PK');

  // The point of the export engine: the file and the screen cannot disagree.
  const wb = new ExcelJS.Workbook();
  // ExcelJS ships against an older non-generic Node Buffer declaration; the
  // runtime value is the exact buffer returned by fetch.
  await wb.xlsx.load(xlsx.buffer! as unknown as Parameters<typeof wb.xlsx.load>[0]);
  eq(
    'the workbook has the four expected sheets',
    wb.worksheets.map((w) => w.name),
    ['Summary', 'By provider', 'Approved time', 'Approved expenses']
  );

  const summarySheet = wb.getWorksheet('Summary')!;
  const cellFor = (label: string): ExcelJS.Cell | null => {
    let found: ExcelJS.Cell | null = null;
    summarySheet.eachRow((row) => {
      if (row.getCell(1).value === label) found = row.getCell(2);
    });
    return found;
  };
  eq('the workbook labour cost matches the summary endpoint', cellFor('Labour cost (PAY)')?.value, 400);
  eq('the workbook total cost matches', cellFor('Total cost')?.value, (40000 + 1550) / 100);
  eq('the workbook client bill matches', cellFor('Client bill (BILL)')?.value, (64000 + 1550) / 100);
  eq('the workbook margin matches', cellFor('Margin')?.value, 240);
  eq('money carries a currency number format, not a baked-in string',
    cellFor('Total cost')?.numFmt, '"USD" #,##0.00');

  const timeSheet = wb.getWorksheet('Approved time')!;
  eq('the time sheet has a header plus one approved line', timeSheet.rowCount, 2);
  eq('...priced from the frozen snapshot', timeSheet.getRow(2).getCell(8).value, 400);
  eq('...under the label frozen at submit', timeSheet.getRow(2).getCell(5).value, 'MON_FRI_DAY');

  const expenseSheet = wb.getWorksheet('Approved expenses')!;
  eq('the expense sheet carries the approved expense', expenseSheet.getRow(2).getCell(5).value, 15.5);

  const providerSheet = wb.getWorksheet('By provider')!;
  eq('the provider rollup names the subcontractor', providerSheet.getRow(2).getCell(1).value,
    `Northgate Electrical ${RUN}`);

  // Authorization + feature gating.
  // A company that *has* the feature but doesn't own the project must 404 — the
  // feature gate runs first, so this needs a paying outsider to be meaningful.
  const rival = await register('rival', `Rival Contracts ${RUN}`);
  await subscribe(rival.companyId!, 'pro');
  const outsider = await call('GET', `/v1/projects/${projectId}/export.pdf`, {
    token: rival.token,
    companyId: rival.companyId!,
    raw: true,
  });
  eq('a paying outsider 404s on a project it does not own', outsider.status, 404);

  const providerTry = await call('GET', `/v1/projects/${projectId}/export.pdf`, {
    token: providerUser.token,
    companyId: northgate,
    raw: true,
  });
  eq('the provider side is refused too (its free plan has no exports)', providerTry.status, 403);

  const crewOwner = await register('crewco', `Crewco ${RUN}`);
  const crewco = crewOwner.companyId!;
  const crewProject = await call('POST', '/v1/projects', {
    token: crewOwner.token,
    companyId: crewco,
    body: { name: `Crewco job ${RUN}` },
  });
  const gated = await call('GET', `/v1/projects/${crewProject.json.project.id}/export.pdf`, {
    token: crewOwner.token,
    companyId: crewco,
    raw: true,
  });
  eq('a free-plan company is refused the export feature', gated.status, 403);

  const exportTrail = await call('GET', '/v1/audit-logs?entityType=PROJECT', {
    token: owner.token,
    companyId: meridian,
  });
  const exportRows = exportTrail.json.data.filter((r: any) => r.action === 'project.exported');
  eq('both exports are audited', exportRows.length, 2);
  eq('...and never client-visible', exportRows.every((r: any) => r.visibleToClient === false), true);
  eq(
    '...recording which format left the building',
    exportRows.map((r: any) => r.changes?.format).sort(),
    ['pdf', 'xlsx']
  );

  // ── Malformed identifiers are 4xx, not 500 ────────────────────────────────
  section('Malformed path identifiers');

  // Before `uuidParam` + the SQLSTATE mapping these were 500s: the id reached a
  // uuid column, Postgres raised 22P02, and an unrecognised throw fell through as
  // "Internal server error" — on every :id route in the app.
  const malformed = [
    ['/v1/projects/not-a-uuid', 'a project'],
    ['/v1/projects/not-a-uuid/summary', 'a project summary'],
    ['/v1/projects/not-a-uuid/export.pdf', 'an export'],
    ['/v1/companies/not-a-uuid', 'a company'],
    ['/v1/rate-cards/not-a-uuid', 'a rate card'],
    ['/v1/rate-card-templates/not-a-uuid', 'a template'],
    ['/v1/role-catalog/not-a-uuid', 'a role'],
    ['/v1/time-logs/not-a-uuid', 'a time log'],
    ['/v1/invoices/not-a-uuid', 'an invoice'],
  ] as const;
  for (const [path, what] of malformed) {
    const res = await call('GET', path, { token: owner.token, companyId: meridian });
    check(
      `${what} with a malformed id is a 4xx, never a 500 (got ${res.status})`,
      res.status >= 400 && res.status < 500,
      { path, status: res.status, body: res.json }
    );
  }

  // ── Portal regression: the client still sees BILL only ────────────────────
  section('Portal regression (client sees BILL, never PAY)');

  const clientUser = await register(
    'portalclient',
    undefined,
    `client+${RUN}@verify.crewquo.test`
  );
  await call('POST', `/v1/invites/${clientRes.json.inviteToken}/accept`, {
    token: clientUser.token,
  });
  const portal = await call(`GET`, `/v1/portal/projects/${projectId}`, {
    token: clientUser.token,
    companyId: harbour,
  });
  eq('the client can read the published project', portal.status, 200);
  const timeLine = portal.json.lineItems.find((l: any) => l.kind === 'TIME');
  eq('the line is priced BILL-side at 64000', timeLine?.amountCents, 64000);
  const payload = JSON.stringify(portal.json);
  check('the payload contains no PAY figure', !payload.includes('40000'));
  check('...no rate snapshot', !payload.includes('resolvedRate'));
  check('...and no subcontractor identity', !payload.includes('Northgate'));

  // ── Invoices: approved work → immutable commercial snapshot ────────────────
  section('Invoices (Phase 6 foundation)');

  const invoiceCreate = await call('POST', '/v1/invoices', {
    token: owner.token,
    companyId: meridian,
    body: { projectId, taxCents: 0, includeApprovedWork: true },
  });
  eq('an owner creates a draft invoice from approved work', invoiceCreate.status, 201);
  const invoiceId = invoiceCreate.json.invoice.id as string;
  eq('the draft snapshots the project summary BILL total', invoiceCreate.json.invoice.subtotalCents, 65550);
  eq('...as one server-priced time line and one approved expense',
    invoiceCreate.json.invoice.items.map((i: any) => i.sourceType).sort(), ['EXPENSE', 'TIME_LOG']);
  eq('...in the issuer company currency', invoiceCreate.json.invoice.currency, 'USD');

  const hiddenDraft = await call('GET', `/v1/invoices/${invoiceId}`, {
    token: clientUser.token,
    companyId: harbour,
  });
  eq('the billed client cannot see a draft', hiddenDraft.status, 404);

  const spoofed = await call('POST', `/v1/invoices/${invoiceId}/items`, {
    token: owner.token,
    companyId: meridian,
    body: { sourceType: 'TIME_LOG', sourceId: logId, unitAmountCents: 1 },
  });
  eq('a caller cannot inject an amount into a work-backed line', spoofed.status, 422);

  const manual = await call('POST', `/v1/invoices/${invoiceId}/items`, {
    token: owner.token,
    companyId: meridian,
    body: { sourceType: 'MANUAL', description: 'Mobilisation', quantity: 2.5, unitAmountCents: 1000 },
  });
  eq('a manual line is added to the draft', manual.status, 201);
  eq('fractional quantity is rounded and rolled into the subtotal', manual.json.invoice.subtotalCents, 68050);
  const manualId = manual.json.invoice.items.find((i: any) => i.sourceType === 'MANUAL').id;

  const editedManual = await call('PATCH', `/v1/invoices/${invoiceId}/items/${manualId}`, {
    token: owner.token,
    companyId: meridian,
    body: { quantity: 3 },
  });
  eq('editing a manual line recomputes the header', editedManual.json.invoice.subtotalCents, 68550);

  const taxed = await call('PATCH', `/v1/invoices/${invoiceId}`, {
    token: owner.token,
    companyId: meridian,
    body: { taxCents: 1000 },
  });
  eq('tax is added without trusting a client-supplied total', taxed.json.invoice.totalCents, 69550);

  const secondDraft = await call('POST', '/v1/invoices', {
    token: owner.token,
    companyId: meridian,
    body: { projectId, includeApprovedWork: true },
  });
  eq('already-claimed approved work is not copied to another draft', secondDraft.json.invoice.items.length, 0);
  const duplicateSource = await call('POST', `/v1/invoices/${secondDraft.json.invoice.id}/items`, {
    token: owner.token,
    companyId: meridian,
    body: { sourceType: 'EXPENSE', sourceId: expenseId },
  });
  eq('explicit double-invoicing is rejected', duplicateSource.status, 409);
  await call('DELETE', `/v1/invoices/${secondDraft.json.invoice.id}`, {
    token: owner.token,
    companyId: meridian,
  });

  const issuedInvoice = await call('POST', `/v1/invoices/${invoiceId}/issue`, {
    token: owner.token,
    companyId: meridian,
  });
  eq('issuing freezes the draft', issuedInvoice.json.invoice.status, 'ISSUED');
  check('...and assigns a stable human number', /^CQ-\d{4}-\d{6}$/.test(issuedInvoice.json.invoice.number));

  const immutable = await call('PATCH', `/v1/invoices/${invoiceId}`, {
    token: owner.token,
    companyId: meridian,
    body: { taxCents: 0 },
  });
  eq('an issued invoice is immutable', immutable.status, 403);

  const clientInvoice = await call('GET', `/v1/invoices/${invoiceId}`, {
    token: clientUser.token,
    companyId: harbour,
  });
  eq('the billed client can read the issued invoice', clientInvoice.status, 200);
  eq('...with the exact frozen total', clientInvoice.json.invoice.totalCents, 69550);

  const paidInvoice = await call('POST', `/v1/invoices/${invoiceId}/paid`, {
    token: owner.token,
    companyId: meridian,
  });
  eq('the issuer can mark an issued invoice paid', paidInvoice.json.invoice.status, 'PAID');

  const invoiceTrail = await call('GET', '/v1/audit-logs?entityType=INVOICE', {
    token: owner.token,
    companyId: meridian,
  });
  check('invoice creation, issue and payment are audited',
    ['invoice.created', 'invoice.issued', 'invoice.paid'].every((action) =>
      invoiceTrail.json.data.some((r: any) => r.action === action)));

  // ── Migration 0006 backfill (narrow on purpose) ───────────────────────────
  section('Migration 0006 currency backfill');

  // Currency is the unit on every stored minor-unit amount and CrewQuo holds no
  // exchange rate, so rewriting it restates figures rather than converting them.
  // The migration therefore only touches companies where the label demonstrably
  // never priced anything. Both halves of that are asserted here, because a later
  // "tidy-up" that widened the WHERE clause would be silent and irreversible.
  const bfPriced = (
    await db.query<{ id: string }>(
      `insert into companies (name, currency) values ($1, 'GBP') returning id`,
      [`Backfill Priced ${RUN}`]
    )
  ).rows[0]!.id;
  const bfBare = (
    await db.query<{ id: string }>(
      `insert into companies (name, currency) values ($1, 'GBP') returning id`,
      [`Backfill Bare ${RUN}`]
    )
  ).rows[0]!.id;
  const bfRole = (
    await db.query<{ id: string }>(
      `insert into role_catalog (company_id, name) values ($1, 'Priced role') returning id`,
      [bfPriced]
    )
  ).rows[0]!.id;
  await db.query(
    `insert into rate_cards (company_id, kind, role_id, rate_mode, rate_label,
                             hourly_rate_cents, effective_from)
     values ($1, 'PAY', $2, 'HOURLY', 'MON_FRI_DAY', 5000, '2026-01-01')`,
    [bfPriced, bfRole]
  );

  const currencyBackfill = `
    update companies c
       set currency = 'USD', updated_at = now()
     where c.currency = 'GBP'
       and not exists (select 1 from rate_cards  x where x.company_id = c.id)
       and not exists (select 1 from projects    x where x.owner_company_id = c.id)
       and not exists (select 1 from time_logs   x where x.provider_company_id = c.id)
       and not exists (select 1 from expenses    x where x.provider_company_id = c.id)`;
  await db.query(currencyBackfill);

  const currencies = await db.query<{ id: string; currency: string }>(
    `select id, currency from companies where id = any($1)`,
    [[bfPriced, bfBare]]
  );
  const currencyOf = (id: string) => currencies.rows.find((r) => r.id === id)?.currency;
  eq('a GBP company that never entered money is moved to USD', currencyOf(bfBare), 'USD');
  eq('a GBP company with a rate card is left alone', currencyOf(bfPriced), 'GBP');

  await db.query(`update companies set currency = 'USD' where id = $1`, [bfPriced]);
  eq(
    '...and the settings endpoint is how that one gets changed',
    (await call('GET', `/v1/companies/${meridian}`, { token: owner.token, companyId: meridian }))
      .json.company.currency,
    'USD'
  );

  // ── Migration 0007 backfill (the behaviour-preserving path) ───────────────
  section('Migration 0007 backfill on legacy data');

  const legacy = await db.query<{ id: string }>(
    `insert into companies (name, currency) values ($1, 'USD') returning id`,
    [`Legacy Co ${RUN}`]
  );
  const legacyId = legacy.rows[0]!.id;
  const legacyRole = await db.query<{ id: string }>(
    `insert into role_catalog (company_id, name) values ($1, 'Legacy role') returning id`,
    [legacyId]
  );
  await db.query(
    `insert into rate_cards (company_id, kind, role_id, rate_mode, rate_label,
                             hourly_rate_cents, effective_from)
     values ($1, 'PAY', $2, 'HOURLY', 'FRI_SAT_NIGHT', 9000, '2026-01-01')`,
    [legacyId, legacyRole.rows[0]!.id]
  );

  // Steps 2–4 of 0007, verbatim in behaviour: a company that was relying on the
  // old hardcoded branch must keep resolving identically.
  const backfill = async () => {
    await db.query(
      `insert into rate_card_templates (company_id, name, timeframe_definitions, is_default)
       select distinct rc.company_id, 'Default', '[]'::jsonb, false
         from rate_cards rc
        where rc.rate_label = 'FRI_SAT_NIGHT'
          and not exists (select 1 from rate_card_templates t where t.company_id = rc.company_id)`
    );
    await db.query(
      `update rate_card_templates t set is_default = true, updated_at = now()
        where t.id = (select x.id from rate_card_templates x
                       where x.company_id = t.company_id
                       order by x.created_at asc, x.id asc limit 1)
          and not exists (select 1 from rate_card_templates d
                           where d.company_id = t.company_id and d.is_default)`
    );
    await db.query(
      `update rate_card_templates t
          set timeframe_definitions = t.timeframe_definitions
                || '[{"type":"label_rule","shiftType":"NIGHT","daysOfWeek":[5,6],"label":"FRI_SAT_NIGHT"}]'::jsonb,
              updated_at = now()
        where t.is_default
          and exists (select 1 from rate_cards rc
                       where rc.company_id = t.company_id and rc.rate_label = 'FRI_SAT_NIGHT')
          and not exists (select 1 from jsonb_array_elements(t.timeframe_definitions) d
                           where d->>'type' = 'label_rule' and d->>'shiftType' = 'NIGHT')`
    );
  };

  await backfill();
  const backfilled = await db.query<{ is_default: boolean; timeframe_definitions: any[] }>(
    `select is_default, timeframe_definitions from rate_card_templates where company_id = $1`,
    [legacyId]
  );
  eq('a legacy company with FRI_SAT_NIGHT cards gets one template', backfilled.rows.length, 1);
  eq('...marked as default', backfilled.rows[0]?.is_default, true);
  eq('...carrying the weekend-night rule it used to get from code',
    backfilled.rows[0]?.timeframe_definitions, [
      { type: 'label_rule', shiftType: 'NIGHT', daysOfWeek: [5, 6], label: 'FRI_SAT_NIGHT' },
    ]);

  await backfill();
  const again = await db.query<{ timeframe_definitions: any[] }>(
    `select timeframe_definitions from rate_card_templates where company_id = $1`,
    [legacyId]
  );
  eq('re-running the backfill adds nothing', again.rows[0]?.timeframe_definitions.length, 1);

  const noCards = await db.query<{ id: string }>(
    `insert into companies (name, currency) values ($1, 'USD') returning id`,
    [`Fresh Co ${RUN}`]
  );
  await backfill();
  const fresh = await db.query(
    `select 1 from rate_card_templates where company_id = $1`,
    [noCards.rows[0]!.id]
  );
  eq('a company that never used the branch gets no invented rule', fresh.rowCount, 0);

  // ── Placeholder companies stop being placeholders when claimed ────────────
  section('Placeholder flag + the clients meter (§5B)');

  // Both counterparties accepted an invite without owning a company, which is the
  // CLAIMED path: the stub is now their real company, so the flag must be gone.
  // While it stayed true, the UI reported "Invitation pending" for a subcontractor
  // who had plainly joined, and §5B's placeholder-clients-are-free rule could not
  // be implemented — filtering on the flag would have excluded real customers.
  const claimedFlags = await db.query<{ id: string; is_placeholder: boolean }>(
    `select id, is_placeholder from companies where id = any($1)`,
    [[northgate, harbour]]
  );
  const flagOf = (id: string) => claimedFlags.rows.find((r) => r.id === id)?.is_placeholder;
  eq('a claimed provider placeholder is no longer a placeholder', flagOf(northgate), false);
  eq('...nor is a claimed portal client', flagOf(harbour), false);

  // A stub nobody accepted stays a stub — and stays free.
  const unclaimed = await call('POST', '/v1/clients', {
    token: owner.token,
    companyId: meridian,
    body: { name: `Never Accepts ${RUN}`, email: `never+${RUN}@verify.crewquo.test` },
  });
  eq('a second portal client is invited', unclaimed.status, 201);
  const unclaimedId = unclaimed.json.client.clientCompanyId as string;
  eq(
    '...and is still a placeholder',
    (await db.query<{ is_placeholder: boolean }>(
      `select is_placeholder from companies where id = $1`,
      [unclaimedId]
    )).rows[0]?.is_placeholder,
    true
  );

  const meterEnt = await call('GET', '/v1/entitlements', {
    token: owner.token,
    companyId: meridian,
  });
  const clientsUsage = meterEnt.json.usage.find((u: any) => u.key === 'clients');
  // Two client edges exist; only the one somebody can sign in to is billable.
  eq('the clients meter counts the accepted client only', clientsUsage?.used, 1);

  // ── Super-admin console (§5B): the three per-company levers ───────────────
  section('Super-admin companies console');

  const staff = await register('staff');
  await promoteToStaff(staff);

  const notStaff = await call('GET', '/v1/admin/companies', { token: owner.token });
  eq('an ordinary account cannot read the console', notStaff.status, 403);

  const found = await call(
    'GET',
    `/v1/admin/companies?search=${encodeURIComponent(`Meridian Contracts ${RUN}`)}`,
    { token: staff.token }
  );
  eq('staff can search companies', found.status, 200);
  eq('...finding the one company by name', found.json.data.length, 1);
  eq('...with its resolved plan', found.json.data[0]?.planId, 'pro');
  eq('...and its live member count', found.json.data[0]?.memberCount, 2);

  const byEmail = await call(
    'GET',
    `/v1/admin/companies?search=${encodeURIComponent(owner.email)}`,
    { token: staff.token }
  );
  eq('searching by a member email finds their company', byEmail.json.data[0]?.id, meridian);

  // Placeholders are hidden by default — every invite creates one, so they would
  // otherwise bury the search.
  const hidden = await call(
    'GET',
    `/v1/admin/companies?search=${encodeURIComponent(`Never Accepts ${RUN}`)}`,
    { token: staff.token }
  );
  eq('placeholders are excluded by default', hidden.json.data.length, 0);
  const shown = await call(
    'GET',
    `/v1/admin/companies?search=${encodeURIComponent(`Never Accepts ${RUN}`)}&includePlaceholders=true`,
    { token: staff.token }
  );
  eq('...and included on request', shown.json.data.length, 1);
  // `Boolean('false')` is true, which is why the flag is not a coerced boolean.
  const falseFlag = await call(
    'GET',
    `/v1/admin/companies?search=${encodeURIComponent(`Never Accepts ${RUN}`)}&includePlaceholders=false`,
    { token: staff.token }
  );
  eq('...and "false" really means false', falseFlag.json.data.length, 0);

  const page1 = await call('GET', '/v1/admin/companies?limit=1', { token: staff.token });
  eq('a page of one returns one row', page1.json.data.length, 1);
  check('...with a cursor for the next page', typeof page1.json.nextCursor === 'string');
  const page2 = await call(
    'GET',
    `/v1/admin/companies?limit=1&cursor=${encodeURIComponent(page1.json.nextCursor)}`,
    { token: staff.token }
  );
  check(
    '...and the next page is a different company',
    page2.json.data[0]?.id !== page1.json.data[0]?.id,
    { first: page1.json.data[0]?.id, second: page2.json.data[0]?.id }
  );

  const detail = await call(`GET`, `/v1/admin/companies/${meridian}`, { token: staff.token });
  eq('the detail view resolves entitlements', detail.json.entitlements.planId, 'pro');
  check(
    '...reports live usage from the same meters the product enforces',
    detail.json.usage.some((u: any) => u.key === 'clients' && u.used === 1),
    detail.json.usage
  );
  eq('...and starts with no overrides', detail.json.overrides.length, 0);

  // A limit override must be visible *immediately*. Entitlements memoize for 60s
  // and meridian has been read many times by now, so this only passes if the write
  // invalidated the cache — a support action nobody can see land gets done twice.
  const seatOverride = await call('POST', `/v1/admin/companies/${meridian}/overrides`, {
    token: staff.token,
    body: { limitKey: 'internal_seats', limitValue: 99, note: 'verify-e2e' },
  });
  eq('a limit override is applied', seatOverride.status, 201);
  const afterOverride = await call('GET', '/v1/entitlements', {
    token: owner.token,
    companyId: meridian,
  });
  eq(
    'the raised limit is live on the very next request',
    afterOverride.json.limits.internal_seats,
    99
  );

  const featureOverride = await call('POST', `/v1/admin/companies/${meridian}/overrides`, {
    token: staff.token,
    body: { featureKey: 'sso', featureEnabled: true, note: 'verify-e2e' },
  });
  eq('a feature override is applied', featureOverride.status, 201);
  const withSso = await call('GET', '/v1/entitlements', {
    token: owner.token,
    companyId: meridian,
  });
  check(
    'the granted feature appears without a plan change',
    withSso.json.features.includes('sso'),
    withSso.json.features
  );

  const bothPairs = await call('POST', `/v1/admin/companies/${meridian}/overrides`, {
    token: staff.token,
    body: { featureKey: 'sso', featureEnabled: true, limitKey: 'clients', limitValue: 5 },
  });
  eq('an override carrying both a feature and a limit is rejected', bothPairs.status, 422);
  const neitherPair = await call('POST', `/v1/admin/companies/${meridian}/overrides`, {
    token: staff.token,
    body: { note: 'nothing to apply' },
  });
  eq('...as is one carrying neither', neitherPair.status, 422);

  const revoked = await call(
    'DELETE',
    `/v1/admin/companies/${meridian}/overrides/${seatOverride.json.override.id}`,
    { token: staff.token }
  );
  eq('an override can be revoked', revoked.status, 204);
  const afterRevoke = await call('GET', '/v1/entitlements', {
    token: owner.token,
    companyId: meridian,
  });
  eq('...and the plan value returns immediately', afterRevoke.json.limits.internal_seats, 8);

  // Comp a trial on a fresh company, so the plan it lands on is unambiguous.
  const trialCo = await register('trialco', `Trial Co ${RUN}`);
  const trial = await call('POST', `/v1/admin/companies/${trialCo.companyId}/comp-trial`, {
    token: staff.token,
    body: { planId: 'starter', days: 14 },
  });
  eq('a trial is comped', trial.status, 200);
  eq('...as TRIALING', trial.json.company.subscriptionStatus, 'TRIALING');
  eq('...on the granted plan', trial.json.company.planId, 'starter');
  const firstEnd = new Date(trial.json.company.trialEnd as string).getTime();
  check('...ending in the future', firstEnd > Date.now());

  const extended = await call('POST', `/v1/admin/companies/${trialCo.companyId}/comp-trial`, {
    token: staff.token,
    body: { planId: 'starter', days: 7 },
  });
  const secondEnd = new Date(extended.json.company.trialEnd as string).getTime();
  check(
    'extending a live trial adds to it rather than restarting it',
    secondEnd > firstEnd,
    { firstEnd, secondEnd }
  );

  const forced = await call('POST', `/v1/admin/companies/${trialCo.companyId}/subscription`, {
    token: staff.token,
    body: { planId: 'business', status: 'ACTIVE' },
  });
  eq('a plan can be forced', forced.status, 200);
  eq('...to the new plan', forced.json.company.planId, 'business');
  const forcedEnt = await call('GET', '/v1/entitlements', {
    token: trialCo.token,
    companyId: trialCo.companyId!,
  });
  eq('...and the company resolves against it at once', forcedEnt.json.planId, 'business');

  const badPlan = await call('POST', `/v1/admin/companies/${trialCo.companyId}/subscription`, {
    token: staff.token,
    body: { planId: 'no-such-plan', status: 'ACTIVE' },
  });
  eq('an unknown plan is refused rather than written', badPlan.status, 422);

  // The trail belongs to the company it was done to, not to the operator.
  const staffTrail = await call('GET', '/v1/audit-logs?entityType=SUBSCRIPTION', {
    token: trialCo.token,
    companyId: trialCo.companyId!,
  });
  const planRow = staffTrail.json.data.find((r: any) => r.action === 'company.plan_changed');
  check('a forced plan change is audited on the subject company', Boolean(planRow), staffTrail.json.data.length);
  eq('...with both sides of the change', planRow?.changes?.plan?.to, 'business');
  eq('...and is never client-visible', planRow?.visibleToClient, false);

  const malformedAdmin = [
    ['GET', '/v1/admin/companies/not-a-uuid', undefined],
    ['POST', '/v1/admin/companies/not-a-uuid/overrides', { featureKey: 'sso', featureEnabled: true }],
    ['POST', '/v1/admin/companies/not-a-uuid/comp-trial', { planId: 'starter', days: 7 }],
  ] as const;
  for (const [method, path, body] of malformedAdmin) {
    const res = await call(method, path, { token: staff.token, body });
    check(
      `${method} ${path} is a 4xx, never a 500 (got ${res.status})`,
      res.status >= 400 && res.status < 500,
      { status: res.status, body: res.json }
    );
  }

  // ── Member management (§3.1, §7) ──────────────────────────────────────────
  section('Member role changes and removal');

  const memberList = await call('GET', '/v1/members', {
    token: owner.token,
    companyId: meridian,
  });
  eq('the member list carries a membership id to address', memberList.status, 200);
  const ownerMembership = memberList.json.data.find((m: any) => m.userId === owner.userId);
  const crewMembership = memberList.json.data.find((m: any) => m.userId === memberUser.userId);
  check('both memberships are listed', Boolean(ownerMembership && crewMembership));

  const memberAttempt = await call('PATCH', `/v1/members/${ownerMembership.membershipId}`, {
    token: memberUser.token,
    companyId: meridian,
    body: { role: 'MEMBER' },
  });
  eq('a MEMBER cannot manage memberships', memberAttempt.status, 403);

  const promote = await call('PATCH', `/v1/members/${crewMembership.membershipId}`, {
    token: owner.token,
    companyId: meridian,
    body: { role: 'MANAGER' },
  });
  eq('an owner promotes a member', promote.status, 200);
  eq('...to the new role', promote.json.member.role, 'MANAGER');

  const selfDemote = await call('PATCH', `/v1/members/${ownerMembership.membershipId}`, {
    token: owner.token,
    companyId: meridian,
    body: { role: 'ADMIN' },
  });
  eq('the only active owner cannot demote themselves', selfDemote.status, 403);
  const selfSuspend = await call('PATCH', `/v1/members/${ownerMembership.membershipId}`, {
    token: owner.token,
    companyId: meridian,
    body: { status: 'SUSPENDED' },
  });
  eq('...nor suspend themselves', selfSuspend.status, 403);
  const selfRemove = await call('DELETE', `/v1/members/${ownerMembership.membershipId}`, {
    token: owner.token,
    companyId: meridian,
  });
  eq('...nor remove themselves', selfRemove.status, 403);

  await call('PATCH', `/v1/members/${crewMembership.membershipId}`, {
    token: owner.token,
    companyId: meridian,
    body: { role: 'ADMIN' },
  });
  const adminVsOwner = await call('PATCH', `/v1/members/${ownerMembership.membershipId}`, {
    token: memberUser.token,
    companyId: meridian,
    body: { role: 'MEMBER' },
  });
  eq('an admin cannot change an owner', adminVsOwner.status, 403);
  const adminSelfPromote = await call('PATCH', `/v1/members/${crewMembership.membershipId}`, {
    token: memberUser.token,
    companyId: meridian,
    body: { role: 'OWNER' },
  });
  eq('...nor grant themselves ownership', adminSelfPromote.status, 403);

  const suspend = await call('PATCH', `/v1/members/${crewMembership.membershipId}`, {
    token: owner.token,
    companyId: meridian,
    body: { status: 'SUSPENDED' },
  });
  eq('an owner suspends a member', suspend.json.member.status, 'SUSPENDED');
  const suspendedRead = await call('GET', '/v1/projects', {
    token: memberUser.token,
    companyId: meridian,
  });
  eq('...and a suspended membership can no longer act as the company', suspendedRead.status, 403);
  await call('PATCH', `/v1/members/${crewMembership.membershipId}`, {
    token: owner.token,
    companyId: meridian,
    body: { status: 'ACTIVE' },
  });

  const seatsBefore = await call('GET', '/v1/entitlements', {
    token: owner.token,
    companyId: meridian,
  });
  eq(
    'the seat meter counts both members',
    seatsBefore.json.usage.find((u: any) => u.key === 'internal_seats')?.used,
    2
  );
  const removed = await call('DELETE', `/v1/members/${crewMembership.membershipId}`, {
    token: owner.token,
    companyId: meridian,
  });
  eq('an owner removes a member', removed.status, 204);
  const seatsAfter = await call('GET', '/v1/entitlements', {
    token: owner.token,
    companyId: meridian,
  });
  eq(
    '...which frees the seat',
    seatsAfter.json.usage.find((u: any) => u.key === 'internal_seats')?.used,
    1
  );
  // The work they logged is attributed to the user, not the membership, so it survives.
  const survivingLogs = await call('GET', `/v1/projects/${projectId}/summary`, {
    token: owner.token,
    companyId: meridian,
  });
  eq('...and the project numbers are unchanged', survivingLogs.json.summary.laborCostCents, 40000);

  const removedTrail = await call('GET', '/v1/audit-logs?entityType=MEMBERSHIP', {
    token: owner.token,
    companyId: meridian,
  });
  check(
    'the removal is audited',
    removedTrail.json.data.some((r: any) => r.action === 'membership.removed'),
    removedTrail.json.data.length
  );

  // ── PATCH /v1/me ──────────────────────────────────────────────────────────
  section('Own profile (PATCH /v1/me)');

  const renamed = await call('PATCH', '/v1/me', {
    token: owner.token,
    body: { name: 'Renamed Owner' },
  });
  eq('a user renames themselves', renamed.status, 200);
  eq('...and the new name is returned', renamed.json.user.name, 'Renamed Owner');
  eq('...while the email is untouched', renamed.json.user.email, owner.email);

  const emailAttempt = await call('PATCH', '/v1/me', {
    token: owner.token,
    body: { email: 'someone-else@verify.crewquo.test' },
  });
  // Unknown keys are stripped, so this is an empty patch — and an empty patch is
  // a 422 rather than a silent no-op that reads as success.
  eq('email is not editable through the profile', emailAttempt.status, 422);
  const stillMine = await call('GET', '/v1/me', { token: owner.token });
  eq('...and the address really did not change', stillMine.json.user.email, owner.email);

  const emptyPatch = await call('PATCH', '/v1/me', { token: owner.token, body: {} });
  eq('an empty profile patch is rejected', emptyPatch.status, 422);

  const avatar = await call('PATCH', '/v1/me', {
    token: owner.token,
    body: { avatarUrl: 'https://example.test/a.png' },
  });
  eq('an avatar can be set', avatar.json.user.avatarUrl, 'https://example.test/a.png');
  const cleared = await call('PATCH', '/v1/me', {
    token: owner.token,
    body: { avatarUrl: null },
  });
  // null clears; undefined would have meant "leave it alone".
  eq('...and cleared with an explicit null', cleared.json.user.avatarUrl, null);

  const nameTrail = await call('GET', '/v1/audit-logs?entityType=USER', {
    token: owner.token,
    companyId: meridian,
  });
  const nameRow = nameTrail.json.data.find((r: any) => r.action === 'user.updated');
  check('a rename is audited in each of the user’s companies', Boolean(nameRow));
  eq('...with both sides of the change', nameRow?.changes?.name?.to, 'Renamed Owner');

  // ── Commercial agreements (Phase 6, §3.3.1) ───────────────────────────────
  // This section is the acceptance script from
  // docs/operating-model/commercial-agreements.md §12, implemented.
  section('Commercial agreements (§3.3.1 PAY proposals, terms, acceptance)');

  const cEngagement = providerRes.json.provider.engagementId as string;

  // Dates are computed, never hardcoded: this script is re-run at the end of every
  // later phase, and a literal "2026-12-01" would silently stop being in the future.
  const dayOffset = (days: number): string => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  };
  const futureFrom = dayOffset(30);
  const pastFrom = dayOffset(-30);

  // 1 ── Empty. A provider with no proposals gets an empty list, not an error.
  const noProposals = await call('GET', '/v1/rate-proposals', {
    token: providerUser.token,
    companyId: northgate,
  });
  eq('a provider with no rate schedules reads an empty list', noProposals.status, 200);
  eq('...and it really is empty', noProposals.json.data.length, 0);

  // 2 ── Terms belong to the hiring company.
  const providerSetsTerms = await call('PATCH', `/v1/engagements/${cEngagement}/terms`, {
    token: providerUser.token,
    companyId: northgate,
    body: { paymentTermsDays: 7 },
  });
  eq('the provider cannot set the terms it is paid under', providerSetsTerms.status, 403);

  const setTerms = await call('PATCH', `/v1/engagements/${cEngagement}/terms`, {
    token: owner.token,
    companyId: meridian,
    body: { paymentTermsDays: 30, purchaseOrderReference: 'PO-4417', reason: 'Signed MSA' },
  });
  eq('the hiring company sets payment terms and a PO reference', setTerms.status, 200);
  eq('...payment days land', setTerms.json.terms.paymentTermsDays, 30);
  eq('...and the PO reference lands', setTerms.json.terms.purchaseOrderReference, 'PO-4417');

  const providerReadsTerms = await call('GET', `/v1/engagements/${cEngagement}/terms`, {
    token: providerUser.token,
    companyId: northgate,
  });
  eq('the provider may read the terms it works under', providerReadsTerms.status, 200);
  eq('...including the payment days', providerReadsTerms.json.terms.paymentTermsDays, 30);

  const outsiderTerms = await call('GET', `/v1/engagements/${cEngagement}/terms`, {
    token: clientUser.token,
    companyId: harbour,
  });
  eq('a company that is not an endpoint 404s on the terms', outsiderTerms.status, 404);

  // 3 ── The existing PAY card is what a REPLACE line supersedes.
  const payCards = await call('GET', '/v1/rate-cards?kind=PAY', {
    token: owner.token,
    companyId: meridian,
  });
  const livePayCard = payCards.json.data.find(
    (c: any) => c.counterpartyCompanyId === northgate && c.rateLabel === 'MON_FRI_DAY'
  );
  check('the edge has a PAY rate in force to supersede', Boolean(livePayCard));
  eq('...at the Phase 3 figure', livePayCard?.hourlyRateCents, 5000);
  eq('...and it is not locked, because it predates the agreement workflow',
    livePayCard?.locked, false);
  eq('...at version 1', livePayCard?.version, 1);
  // A card carried its own `currency` between 0009 and 0017. Asserted as an
  // absence now, because the way multi-currency comes back is one plausible
  // column at a time.
  check('...and carries no currency of its own; the label is the company one',
    livePayCard !== undefined && !('currency' in livePayCard),
    livePayCard && Object.keys(livePayCard));

  // 4 ── Denied: the hiring side cannot author the provider's proposal.
  const hiringDrafts = await call('POST', '/v1/rate-proposals', {
    token: owner.token,
    companyId: meridian,
    body: {
      engagementId: cEngagement,
      effectiveFrom: futureFrom,
      lines: [{ operation: 'CREATE', roleId, rateLabel: 'SUNDAY', rateMode: 'HOURLY', hourlyRateCents: 9000 }],
    },
  });
  eq('the hiring company cannot propose on the provider’s behalf', hiringDrafts.status, 403);

  // 5 ── The provider drafts an atomic schedule: one raise, one new label.
  const draft = await call('POST', '/v1/rate-proposals', {
    token: providerUser.token,
    companyId: northgate,
    body: {
      engagementId: cEngagement,
      effectiveFrom: futureFrom,
      note: 'April uplift as agreed on site',
      lines: [
        {
          operation: 'REPLACE',
          roleId,
          rateLabel: 'MON_FRI_DAY',
          rateMode: 'HOURLY',
          hourlyRateCents: 5500,
          otHourlyRateCents: 8250,
          replacesRateCardId: livePayCard.id,
        },
        {
          operation: 'CREATE',
          roleId,
          rateLabel: 'SUNDAY',
          rateMode: 'HOURLY',
          hourlyRateCents: 9000,
        },
      ],
    },
  });
  eq('the provider drafts a rate schedule', draft.status, 201);
  const draftId = draft.json.proposal.id as string;
  eq('...as a DRAFT', draft.json.proposal.status, 'DRAFT');
  eq('...in the hiring company currency', draft.json.proposal.currency, 'USD');
  eq('...with both lines', draft.json.proposal.lines.length, 2);
  const replaceLine = draft.json.proposal.lines.find((l: any) => l.operation === 'REPLACE');
  eq('...and the reviewer is shown the rate in force beside the proposed one',
    replaceLine.currentAmountCents, 5000);
  const createLine = draft.json.proposal.lines.find((l: any) => l.operation === 'CREATE');
  eq('...with no comparison where nothing is in force', createLine.currentAmountCents, null);

  // 6 ── A draft is the provider's alone.
  const hiringSeesDraft = await call('GET', `/v1/rate-proposals/${draftId}`, {
    token: owner.token,
    companyId: meridian,
  });
  eq('the hiring company cannot see a draft schedule', hiringSeesDraft.status, 404);
  const hiringList = await call('GET', `/v1/rate-proposals?engagementId=${cEngagement}`, {
    token: owner.token,
    companyId: meridian,
  });
  eq('...nor does one appear in its list', hiringList.json.data.length, 0);

  const outsiderSees = await call('GET', `/v1/rate-proposals/${draftId}`, {
    token: clientUser.token,
    companyId: harbour,
  });
  eq('an outsider 404s on a schedule', outsiderSees.status, 404);

  // 7 ── One open negotiation per edge.
  const secondOpen = await call('POST', '/v1/rate-proposals', {
    token: providerUser.token,
    companyId: northgate,
    body: {
      engagementId: cEngagement,
      effectiveFrom: futureFrom,
      lines: [{ operation: 'CREATE', roleId, rateLabel: 'DAILY', rateMode: 'DAILY', dailyRateCents: 40000 }],
    },
  });
  eq('a second open schedule on the same edge is refused', secondOpen.status, 409);

  // 8 ── Validation the DB alone could not express.
  const foreignRole = await call('POST', '/v1/rate-proposals', {
    token: providerUser.token,
    companyId: northgate,
    body: {
      engagementId: cEngagement,
      effectiveFrom: futureFrom,
      lines: [{ operation: 'CREATE', roleId: randomUUID(), rateLabel: 'DAILY', rateMode: 'DAILY', dailyRateCents: 1 },],
    },
  });
  eq('a line naming a role outside the hiring catalog is refused', foreignRole.status, 422);

  // The proposer does not choose the unit: a PAY schedule is always in the hiring
  // company's one currency, because `rate_cards` resolve on the hiring side. The
  // draft above was created without anybody sending a currency at all — there is no
  // longer a field to send one with — and reports the hiring company's.
  const draftCurrency = await call('GET', `/v1/rate-proposals/${draftId}`, {
    token: providerUser.token, companyId: northgate,
  });
  eq('a draft reports the hiring company currency, which nobody chose',
    draftCurrency.json.proposal.currency, 'USD');

  // 9 ── Submission freezes the payload.
  const cSubmitted = await call('POST', `/v1/rate-proposals/${draftId}/submit`, {
    token: providerUser.token,
    companyId: northgate,
  });
  eq('the provider submits the schedule', cSubmitted.status, 200);
  eq('...and it is SUBMITTED', cSubmitted.json.proposal.status, 'SUBMITTED');
  check('...stamped with who submitted it', Boolean(cSubmitted.json.proposal.submittedAt));

  const editFrozen = await call('PATCH', `/v1/rate-proposals/${draftId}`, {
    token: providerUser.token,
    companyId: northgate,
    body: { lines: [{ operation: 'CREATE', roleId, rateLabel: 'DAILY', rateMode: 'DAILY', dailyRateCents: 1 }] },
  });
  eq('a submitted schedule cannot be edited by its author', editFrozen.status, 409);

  const deleteSubmitted = await call('DELETE', `/v1/rate-proposals/${draftId}`, {
    token: providerUser.token,
    companyId: northgate,
  });
  eq('...nor deleted — a submitted schedule is withdrawn, not deleted', deleteSubmitted.status, 409);

  const hiringEdits = await call('PATCH', `/v1/rate-proposals/${draftId}`, {
    token: owner.token,
    companyId: meridian,
    body: { lines: [{ operation: 'CREATE', roleId, rateLabel: 'DAILY', rateMode: 'DAILY', dailyRateCents: 1 }] },
  });
  eq('the reviewer cannot edit the numbers it is approving', hiringEdits.status, 403);

  const nowVisible = await call('GET', `/v1/rate-proposals/${draftId}`, {
    token: owner.token,
    companyId: meridian,
  });
  eq('a submitted schedule is visible to the hiring company', nowVisible.status, 200);
  eq('...from its side of the edge', nowVisible.json.proposal.side, 'client');

  // 10 ── Denied: the provider cannot approve its own rates, at any role.
  const selfApprove = await call('POST', `/v1/rate-proposals/${draftId}/approve`, {
    token: providerUser.token,
    companyId: northgate,
    body: {},
  });
  eq('the provider cannot approve its own schedule', selfApprove.status, 403);

  const memberApprove = await call('POST', `/v1/rate-proposals/${draftId}/approve`, {
    token: memberUser.token,
    companyId: meridian,
    body: {},
  });
  eq('a MEMBER in the hiring company cannot approve', memberApprove.status, 403);

  // 11 ── Rejected → corrected. Rejection needs a reason.
  const rejectNoReason = await call('POST', `/v1/rate-proposals/${draftId}/reject`, {
    token: owner.token,
    companyId: meridian,
    body: {},
  });
  eq('a rejection without a reason is refused', rejectNoReason.status, 422);

  const rejected = await call('POST', `/v1/rate-proposals/${draftId}/reject`, {
    token: owner.token,
    companyId: meridian,
    body: { reason: 'Sunday rate is above the framework cap' },
  });
  eq('the hiring company rejects with a reason', rejected.status, 200);
  eq('...and the reason is on the record', rejected.json.proposal.decisionReason,
    'Sunday rate is above the framework cap');

  const editRejected = await call('PATCH', `/v1/rate-proposals/${draftId}`, {
    token: providerUser.token,
    companyId: northgate,
    body: { note: 'trying to fix it in place' },
  });
  eq('a rejected schedule cannot be edited — correction is a successor', editRejected.status, 409);

  const successor = await call('POST', '/v1/rate-proposals', {
    token: providerUser.token,
    companyId: northgate,
    body: {
      engagementId: cEngagement,
      effectiveFrom: futureFrom,
      predecessorProposalId: draftId,
      note: 'Sunday reduced to the cap',
      lines: [
        {
          operation: 'REPLACE',
          roleId,
          rateLabel: 'MON_FRI_DAY',
          rateMode: 'HOURLY',
          hourlyRateCents: 5500,
          otHourlyRateCents: 8250,
          replacesRateCardId: livePayCard.id,
        },
        { operation: 'CREATE', roleId, rateLabel: 'SUNDAY', rateMode: 'HOURLY', hourlyRateCents: 7500 },
      ],
    },
  });
  eq('the provider clones the rejection into a successor', successor.status, 201);
  const successorId = successor.json.proposal.id as string;
  eq('...and the chain is walkable', successor.json.proposal.predecessorProposalId, draftId);

  await call('POST', `/v1/rate-proposals/${successorId}/submit`, {
    token: providerUser.token,
    companyId: northgate,
  });

  // 12 ── Approval is one transaction that writes immutable versions.
  const cApproved = await call('POST', `/v1/rate-proposals/${successorId}/approve`, {
    token: owner.token,
    companyId: meridian,
    body: {},
  });
  eq('the hiring company approves the successor', cApproved.status, 200);
  eq('...it is APPROVED', cApproved.json.proposal.status, 'APPROVED');
  eq('...two new immutable versions were written', cApproved.json.rateCardIds.length, 2);
  eq('...and the replaced version was superseded', cApproved.json.supersededRateCardIds, [livePayCard.id]);

  // The chain stays linear. Checked *here* rather than right after the clone: while
  // the successor was still open, the one-open-per-edge index fired first, so this
  // branch is only reachable once the successor itself is terminal.
  const secondSuccessor = await call('POST', '/v1/rate-proposals', {
    token: providerUser.token,
    companyId: northgate,
    body: {
      engagementId: cEngagement,
      effectiveFrom: futureFrom,
      predecessorProposalId: draftId,
      lines: [{ operation: 'CREATE', roleId, rateLabel: 'DAILY', rateMode: 'DAILY', dailyRateCents: 1 }],
    },
  });
  eq('a second correction of the same rejection is refused', secondSuccessor.status, 409);
  check('...and names the successor rule, not the open-schedule rule',
    /already been continued/i.test(secondSuccessor.json?.error?.message ?? ''),
    secondSuccessor.json?.error?.message);

  const cardsAfter = await db.query(
    `select rate_label, hourly_rate_cents, version, locked,
            to_char(effective_from, 'YYYY-MM-DD') as effective_from,
            to_char(effective_to, 'YYYY-MM-DD') as effective_to,
            source_proposal_id, supersedes_rate_card_id
       from rate_cards
      where company_id = $1 and kind = 'PAY' and counterparty_company_id = $2
      order by rate_label, version`,
    [meridian, northgate]
  );
  const newMonFri = cardsAfter.rows.find(
    (r: any) => r.rate_label === 'MON_FRI_DAY' && r.version === 2
  );
  eq('the successor version carries the approved amount', newMonFri?.hourly_rate_cents, 5500);
  eq('...is locked', newMonFri?.locked, true);
  // The card no longer stores a currency at all — the label is the company's, read
  // through the edge. Asserted as an absence, because re-adding this one column is
  // how multi-currency would creep back in.
  check('...and stores no currency of its own', newMonFri !== undefined
    && !('currency' in newMonFri), newMonFri && Object.keys(newMonFri));
  eq('...opens on the effective date', newMonFri?.effective_from, futureFrom);
  eq('...is open-ended', newMonFri?.effective_to, null);
  eq('...and points at the schedule that created it', newMonFri?.source_proposal_id, successorId);
  eq('...and at the version it supersedes', newMonFri?.supersedes_rate_card_id, livePayCard.id);

  const oldMonFri = cardsAfter.rows.find(
    (r: any) => r.rate_label === 'MON_FRI_DAY' && r.version === 1
  );
  eq('the superseded version closes the day BEFORE the successor opens',
    oldMonFri?.effective_to, dayOffset(29));

  // 13 ── The one resolver agrees, on both sides of the effective date.
  const resolveAfter = await call(
    `GET`,
    `/v1/rates/resolve?roleId=${roleId}&shiftType=WEEKDAY_DAY&date=${futureFrom}` +
      `&kind=PAY&counterpartyId=${northgate}`,
    { token: owner.token, companyId: meridian }
  );
  eq('on the effective date the resolver returns the new rate', resolveAfter.json.baseCents, 5500);
  const resolveBefore = await call(
    `GET`,
    `/v1/rates/resolve?roleId=${roleId}&shiftType=WEEKDAY_DAY&date=${dayOffset(29)}` +
      `&kind=PAY&counterpartyId=${northgate}`,
    { token: owner.token, companyId: meridian }
  );
  eq('the day before, it still returns the old one', resolveBefore.json.baseCents, 5000);

  // 14 ── Approved time keeps its frozen snapshot (§6). Repricing is not retroactive.
  const snapshotAfter = await db.query(
    `select resolved_rate from time_logs where id = $1`,
    [logId]
  );
  eq('an already-approved time log keeps its frozen PAY snapshot',
    snapshotAfter.rows[0]?.resolved_rate?.baseCents ?? null, 5000);

  // 15 ── Immutability is the database's rule, not the route's.
  const lockedCardId = cApproved.json.rateCardIds[0] as string;
  let lockedAmountRefused = false;
  try {
    await db.query(`update rate_cards set hourly_rate_cents = 9999 where id = $1`, [lockedCardId]);
  } catch {
    lockedAmountRefused = true;
  }
  check('the database refuses to rewrite an approved rate', lockedAmountRefused);

  let lockedDeleteRefused = false;
  try {
    await db.query(`delete from rate_cards where id = $1`, [lockedCardId]);
  } catch {
    lockedDeleteRefused = true;
  }
  check('...and refuses to delete one', lockedDeleteRefused);

  let windowCloseAllowed = true;
  try {
    await db.query(
      `update rate_cards set effective_to = effective_to where id = $1`,
      [lockedCardId]
    );
  } catch {
    windowCloseAllowed = false;
  }
  check('...while still allowing the window to be closed', windowCloseAllowed);

  // The route refuses first, so an operator gets an explanation rather than a 500
  // from the trigger, and is told what to do instead.
  const patchLocked = await call('PATCH', `/v1/rate-cards/${lockedCardId}`, {
    token: owner.token,
    companyId: meridian,
    body: { hourlyRateCents: 9999 },
  });
  eq('editing an approved rate through the API is refused', patchLocked.status, 409);
  check('...and the refusal points at agreeing a new version',
    /new effective version/i.test(patchLocked.json?.error?.message ?? ''),
    patchLocked.json?.error?.message);
  const deleteLocked = await call('DELETE', `/v1/rate-cards/${lockedCardId}`, {
    token: owner.token,
    companyId: meridian,
  });
  eq('deleting an approved rate through the API is refused', deleteLocked.status, 409);

  const stillEditable = await call('PATCH', `/v1/rate-cards/${livePayCard.id}`, {
    token: owner.token,
    companyId: meridian,
    body: { active: true },
  });
  eq('a hand-entered card that predates the workflow is still editable', stillEditable.status, 200);

  const reApprove = await call('POST', `/v1/rate-proposals/${successorId}/approve`, {
    token: owner.token,
    companyId: meridian,
    body: {},
  });
  eq('approving twice is a conflict, not a second set of rates', reApprove.status, 409);

  // 16 ── Retroactive activation is refused by default, and needs an owner + reason.
  const backdated = await call('POST', '/v1/rate-proposals', {
    token: providerUser.token,
    companyId: northgate,
    body: {
      engagementId: cEngagement,
      effectiveFrom: pastFrom,
      lines: [{ operation: 'CREATE', roleId, rateLabel: 'SHIFT', rateMode: 'SHIFT', shiftRateCents: 36000 }],
    },
  });
  eq('a back-dated schedule can be drafted', backdated.status, 201);
  const backdatedId = backdated.json.proposal.id as string;
  await call('POST', `/v1/rate-proposals/${backdatedId}/submit`, {
    token: providerUser.token,
    companyId: northgate,
  });

  // A MANAGER in the hiring company may approve, but not back-date.
  const managerInvite = await call('POST', '/v1/members/invite', {
    token: owner.token,
    companyId: meridian,
    body: { email: `mgr+${RUN}@verify.crewquo.test`, role: 'MANAGER' },
  });
  const managerUser = await register('mgr', undefined, `mgr+${RUN}@verify.crewquo.test`);
  await call('POST', `/v1/invites/${managerInvite.json.inviteToken}/accept`, {
    token: managerUser.token,
  });

  const managerBackdates = await call('POST', `/v1/rate-proposals/${backdatedId}/approve`, {
    token: managerUser.token,
    companyId: meridian,
    body: {},
  });
  eq('a manager cannot back-date a schedule', managerBackdates.status, 403);

  const ownerBackdatesNoReason = await call('POST', `/v1/rate-proposals/${backdatedId}/approve`, {
    token: owner.token,
    companyId: meridian,
    body: {},
  });
  eq('an owner back-dating without a reason is refused', ownerBackdatesNoReason.status, 422);

  const ownerBackdates = await call('POST', `/v1/rate-proposals/${backdatedId}/approve`, {
    token: owner.token,
    companyId: meridian,
    body: { retroactiveReason: 'Uplift agreed verbally on 1 July, papered late' },
  });
  eq('an owner may back-date with a reason', ownerBackdates.status, 200);
  eq('...and the override is evidence on the record',
    ownerBackdates.json.proposal.retroactiveReason,
    'Uplift agreed verbally on 1 July, papered late');

  // 17 ── Direct entry: the hiring company records a schedule agreed elsewhere.
  const directEntry = await call('POST', `/v1/commercial-agreements/${cEngagement}/schedule`, {
    token: owner.token,
    companyId: meridian,
    body: {
      effectiveFrom: dayOffset(60),
      note: 'Negotiated over email, recorded for the record',
      lines: [
        { operation: 'CREATE', roleId, rateLabel: 'MON_THU_NIGHT', rateMode: 'HOURLY', hourlyRateCents: 6500 },
      ],
    },
  });
  eq('the hiring company records an externally agreed schedule', directEntry.status, 201);
  const directCard = await db.query(
    `select locked, source_proposal_id from rate_cards where id = $1`,
    [directEntry.json.rateCardIds[0]]
  );
  eq('...as a real immutable version, not a mutable shortcut', directCard.rows[0]?.locked, true);
  eq('...with no source proposal, because there was no negotiation here',
    directCard.rows[0]?.source_proposal_id, null);

  const providerDirectEntry = await call('POST', `/v1/commercial-agreements/${cEngagement}/schedule`, {
    token: providerUser.token,
    companyId: northgate,
    body: {
      effectiveFrom: dayOffset(90),
      lines: [{ operation: 'CREATE', roleId, rateLabel: 'DAILY', rateMode: 'DAILY', dailyRateCents: 99000 }],
    },
  });
  eq('the provider cannot write its own rate through direct entry', providerDirectEntry.status, 403);

  // 18 ── The agreement view is one request, from either side.
  const agreementProvider = await call('GET', `/v1/commercial-agreements/${cEngagement}`, {
    token: providerUser.token,
    companyId: northgate,
  });
  eq('the provider reads the whole agreement', agreementProvider.status, 200);
  eq('...from its own side', agreementProvider.json.agreement.side, 'provider');
  eq('...seeing the terms it works under', agreementProvider.json.agreement.terms.paymentTermsDays, 30);
  check('...and the PAY schedule in force is its own agreed rate',
    agreementProvider.json.agreement.liveRates.length > 0);
  const providerPayload = JSON.stringify(agreementProvider.json);
  check('the provider payload carries no BILL amount and no margin',
    !/"kind":"BILL"|margin/i.test(providerPayload));
  eq('...and the rejected schedule is still in its history',
    agreementProvider.json.agreement.proposals.some((p: any) => p.status === 'REJECTED'), true);

  const agreementOutsider = await call('GET', `/v1/commercial-agreements/${cEngagement}`, {
    token: clientUser.token,
    companyId: harbour,
  });
  eq('an outsider 404s on the agreement', agreementOutsider.status, 404);

  // 18b ── A company *default* PAY rate is agreed on this engagement too.
  //
  // The resolver falls back to a null-counterparty card (§6), so a company that
  // priced a role once for everybody has a rate in force on every engagement. The
  // agreement view has to say so: showing "no agreed rate" while the engine prices
  // the work at the default is the screen and the engine disagreeing about money.
  const sharedRole = await db.query(
    `insert into role_catalog (company_id, name) values ($1, $2) returning id`,
    [meridian, `Banksman ${RUN}`]
  );
  const sharedRoleId = sharedRole.rows[0].id as string;
  const defaultCard = await call('POST', '/v1/rate-cards', {
    token: owner.token,
    companyId: meridian,
    body: {
      kind: 'PAY',
      counterpartyCompanyId: null,
      roleId: sharedRoleId,
      rateMode: 'HOURLY',
      rateLabel: 'MON_FRI_DAY',
      hourlyRateCents: 4100,
      effectiveFrom: dayOffset(-1),
    },
  });
  eq('a company-default PAY rate is created', defaultCard.status, 201);

  const withDefault = await call('GET', `/v1/commercial-agreements/${cEngagement}`, {
    token: providerUser.token,
    companyId: northgate,
  });
  const inherited = withDefault.json.agreement.liveRates.find(
    (r: any) => r.roleId === sharedRoleId
  );
  check('the agreement shows a rate the engagement inherits from the company default',
    Boolean(inherited), withDefault.json.agreement.liveRates.map((r: any) => r.roleName));
  eq('...at the default amount', inherited?.amountCents, 4100);
  eq('...marked as inherited rather than engagement-specific', inherited?.scope, 'COMPANY_DEFAULT');

  const specific = withDefault.json.agreement.liveRates.find(
    (r: any) => r.roleId === roleId && r.rateLabel === 'MON_FRI_DAY' && r.scope === 'ENGAGEMENT'
  );
  check('...while a counterparty-specific rate is marked as this engagement\u2019s own',
    Boolean(specific));

  // And a proposal against the inherited rate sees it as the current amount, so the
  // reviewer's "now" column matches what the resolver would actually charge.
  const overrideDraft = await call('POST', '/v1/rate-proposals', {
    token: providerUser.token,
    companyId: northgate,
    body: {
      engagementId: cEngagement,
      effectiveFrom: dayOffset(120),
      lines: [
        {
          operation: 'CREATE',
          roleId: sharedRoleId,
          rateLabel: 'MON_FRI_DAY',
          rateMode: 'HOURLY',
          hourlyRateCents: 4500,
        },
      ],
    },
  });
  eq('a provider proposes its own rate over the company default', overrideDraft.status, 201);
  eq('...and the reviewer is shown the inherited default as the current amount',
    overrideDraft.json.proposal.lines[0].currentAmountCents, 4100);
  await call('DELETE', `/v1/rate-proposals/${overrideDraft.json.proposal.id}`, {
    token: providerUser.token,
    companyId: northgate,
  });

  // 19 ── Entitlement: approving writes the HIRING company's cards, so its plan
  // gates it — and the provider's plan never does. Proven on a purpose-built edge
  // whose hiring company has `rate_cards` removed by override, set before anything
  // reads its entitlements (the resolver memoizes for 60s).
  const gatedOwner = await register('gatedhirer', `Tinbridge Works ${RUN}`);
  const tinbridge = gatedOwner.companyId!;
  await subscribe(tinbridge, 'pro'); // operates_downstream, so it can hire at all
  await db.query(
    `insert into company_entitlement_overrides (company_id, feature_key, feature_enabled, note)
     values ($1, 'rate_cards', false, 'verify-e2e: prove the hiring-side gate')`,
    [tinbridge]
  );

  const gatedProviderRes = await call('POST', '/v1/providers', {
    token: gatedOwner.token,
    companyId: tinbridge,
    body: { name: `Ledbury Hire ${RUN}`, email: `ledbury+${RUN}@verify.crewquo.test` },
  });
  eq('the gated hiring company can still add a subcontractor', gatedProviderRes.status, 201);
  const ledburyUser = await register('ledbury', undefined, `ledbury+${RUN}@verify.crewquo.test`);
  await call('POST', `/v1/invites/${gatedProviderRes.json.inviteToken}/accept`, {
    token: ledburyUser.token,
  });
  const ledbury = gatedProviderRes.json.provider.providerCompanyId as string;
  const gatedEdge = gatedProviderRes.json.provider.engagementId as string;

  // A role in the HIRING company's catalog — the catalog a PAY card resolves in.
  const gatedRole = await db.query(
    `insert into role_catalog (company_id, name) values ($1, $2) returning id`,
    [tinbridge, `Banksman ${RUN}`]
  );
  const gatedRoleId = gatedRole.rows[0].id as string;

  const gatedDraft = await call('POST', '/v1/rate-proposals', {
    token: ledburyUser.token,
    companyId: ledbury,
    body: {
      engagementId: gatedEdge,
      effectiveFrom: futureFrom,
      lines: [
        { operation: 'CREATE', roleId: gatedRoleId, rateLabel: 'MON_FRI_DAY', rateMode: 'HOURLY', hourlyRateCents: 4200 },
      ],
    },
  });
  // The whole point of the free tier is that a subcontractor can ask for a rate.
  eq('a provider proposes without any feature of its own', gatedDraft.status, 201);
  await call('POST', `/v1/rate-proposals/${gatedDraft.json.proposal.id}/submit`, {
    token: ledburyUser.token,
    companyId: ledbury,
  });

  const gatedApprove = await call('POST', `/v1/rate-proposals/${gatedDraft.json.proposal.id}/approve`, {
    token: gatedOwner.token,
    companyId: tinbridge,
    body: {},
  });
  eq('a hiring company without rate_cards cannot hold an agreed schedule', gatedApprove.status, 403);
  eq('...and the refusal names the feature that would unlock it',
    gatedApprove.json?.error?.details?.feature, 'rate_cards');

  // 20 ── Payment terms reach the invoice, and the PO ceiling is enforced at issue.
  // This edge is meridian(provider) ⇄ harbour(client): harbour is the hiring side,
  // so harbour sets the ceiling and meridian is the one refused. Which is the real
  // shape — a client hands you a PO with a cap on it.
  const invoiceEdge = clientRes.json.client.engagementId as string;
  const harbourTerms = await call('PATCH', `/v1/engagements/${invoiceEdge}/terms`, {
    token: clientUser.token,
    companyId: harbour,
    body: { paymentTermsDays: 45, purchaseOrderReference: 'HG-PO-88', purchaseOrderCeilingCents: 70000 },
  });
  eq('the hiring client sets a PO reference and ceiling', harbourTerms.status, 200);

  const termsInvoice = await call('POST', '/v1/invoices', {
    token: owner.token,
    companyId: meridian,
    body: { projectId, includeApprovedWork: false },
  });
  eq('a new draft invoice is created', termsInvoice.status, 201);
  const termsInvoiceId = termsInvoice.json.invoice.id as string;
  check('...and its due date defaults from the engagement’s payment terms',
    Boolean(termsInvoice.json.invoice.dueAt), termsInvoice.json.invoice.dueAt);
  const dueDays = termsInvoice.json.invoice.dueAt
    ? Math.round(
        (new Date(termsInvoice.json.invoice.dueAt).getTime() - Date.now()) / 86_400_000
      )
    : null;
  eq('...45 days out, as agreed', dueDays, 45);

  await call('POST', `/v1/invoices/${termsInvoiceId}/items`, {
    token: owner.token,
    companyId: meridian,
    body: { sourceType: 'MANUAL', description: 'Standby crew', quantity: 1, unitAmountCents: 1000 },
  });
  const breached = await call('POST', `/v1/invoices/${termsInvoiceId}/issue`, {
    token: owner.token,
    companyId: meridian,
  });
  // 69550 already issued and paid on this edge + 1000 = 70550, over the 70000 cap.
  eq('issuing over the PO ceiling is refused', breached.status, 422);
  check('...and the refusal names the ceiling and what is already committed',
    /700\.00/.test(breached.json?.error?.message ?? '') &&
      /695\.50/.test(breached.json?.error?.message ?? ''),
    breached.json?.error?.message);

  const raised = await call('PATCH', `/v1/engagements/${invoiceEdge}/terms`, {
    token: clientUser.token,
    companyId: harbour,
    body: { purchaseOrderCeilingCents: 100000, reason: 'PO varied to $1,000' },
  });
  eq('the hiring client raises the ceiling', raised.status, 200);
  const nowIssues = await call('POST', `/v1/invoices/${termsInvoiceId}/issue`, {
    token: owner.token,
    companyId: meridian,
  });
  eq('...and the same invoice now issues', nowIssues.status, 200);

  // 21 ── §36 record_revisions: before/after on the terms, with the reason.
  const revisions = await db.query(
    `select revision, changed_fields, reason, before, after
       from record_revisions
      where entity_type = 'engagement_terms' and entity_id = $1
      order by revision`,
    [invoiceEdge]
  );
  eq('both terms changes wrote a revision', revisions.rows.length, 2);
  eq('...the second records only the field that moved',
    revisions.rows[1]?.changed_fields, ['purchaseOrderCeilingCents']);
  eq('...with both sides of the change',
    [revisions.rows[1]?.before?.purchaseOrderCeilingCents, revisions.rows[1]?.after?.purchaseOrderCeilingCents],
    [70000, 100000]);
  eq('...and the reason the operator gave', revisions.rows[1]?.reason, 'PO varied to $1,000');

  const rateRevisions = await db.query(
    `select count(*)::int as n from record_revisions
      where entity_type = 'rate_card' and reason is not null`
  );
  check('every approved rate revision carries a reason (§36 starred)', rateRevisions.rows[0].n > 0);

  // 22 ── Acceptance: a direct-created engagement is PENDING until the provider agrees.
  const standalone = await register('standalone', `Fenwick Plant ${RUN}`);
  const fenwick = standalone.companyId!;
  const directEdge = await call('POST', '/v1/engagements', {
    token: owner.token,
    companyId: meridian,
    body: { providerCompanyId: fenwick },
  });
  eq('a hiring company creates an engagement to a real company', directEdge.status, 201);
  eq('...and it is PENDING, not ACTIVE — you cannot bind another company',
    directEdge.json.engagement.status, 'PENDING');
  const directEdgeId = directEdge.json.engagement.id as string;

  const hirerAccepts = await call('POST', `/v1/engagements/${directEdgeId}/accept`, {
    token: owner.token,
    companyId: meridian,
    body: {},
  });
  eq('the hiring company cannot accept on the provider’s behalf', hirerAccepts.status, 403);

  const providerAccepts = await call('POST', `/v1/engagements/${directEdgeId}/accept`, {
    token: standalone.token,
    companyId: fenwick,
    body: {},
  });
  eq('the provider accepts', providerAccepts.status, 200);
  eq('...and the edge goes ACTIVE', providerAccepts.json.engagement.status, 'ACTIVE');
  check('...stamped with when', Boolean(providerAccepts.json.terms.providerAcceptedAt));

  const acceptTwice = await call('POST', `/v1/engagements/${directEdgeId}/accept`, {
    token: standalone.token,
    companyId: fenwick,
    body: {},
  });
  eq('accepting an already-active engagement is a conflict', acceptTwice.status, 409);

  // 23 ── Assignment acceptance, recorded and NOT gating work capture.
  const assign = await call('POST', `/v1/projects/${projectId}/assignments`, {
    token: owner.token,
    companyId: meridian,
    body: { providerCompanyId: fenwick },
  });
  eq('the provider is assigned to a project', assign.status, 201);
  const fenwickAssignment = assign.json.data.find((a: any) => a.providerCompanyId === fenwick);
  eq('...and the assignment awaits their acceptance', fenwickAssignment?.acceptance, 'PENDING');

  const pending = await call('GET', '/v1/projects/assignments/pending', {
    token: standalone.token,
    companyId: fenwick,
  });
  eq('the provider sees it in its pending list', pending.status, 200);
  eq('...exactly once', pending.json.data.length, 1);

  const declined = await call(
    'POST',
    `/v1/projects/assignments/${fenwickAssignment.id}/decline`,
    { token: standalone.token, companyId: fenwick, body: { reason: 'No plant free that week' } }
  );
  eq('the provider declines with a reason', declined.status, 200);
  eq('...which is on the record', declined.json.assignment.decisionReason, 'No plant free that week');
  eq('...and a decline leaves no acceptedAt, because it was not accepted',
    declined.json.assignment.acceptedAt, null);

  const reAccepted = await call(
    'POST',
    `/v1/projects/assignments/${fenwickAssignment.id}/accept`,
    { token: standalone.token, companyId: fenwick, body: {} }
  );
  eq('a declined assignment can still be accepted later', reAccepted.status, 200);
  eq('...and reads as accepted', reAccepted.json.assignment.acceptance, 'ACCEPTED');

  const hirerDecides = await call(
    'POST',
    `/v1/projects/assignments/${fenwickAssignment.id}/decline`,
    { token: owner.token, companyId: meridian, body: {} }
  );
  eq('the hiring company cannot decide an assignment for the provider', hirerDecides.status, 403);

  // Work capture must still function while an assignment is unaccepted — the whole
  // reason acceptance is not a gate (§9 of the packet).
  const northgateAssignment = await db.query(
    `select id from project_assignments where project_id = $1 and provider_company_id = $2`,
    [projectId, northgate]
  );
  await db.query(
    `update project_assignments set acceptance = 'PENDING', accepted_at = null,
            accepted_by_user_id = null where id = $1`,
    [northgateAssignment.rows[0].id]
  );
  const logWhileUnaccepted = await call('POST', '/v1/time-logs', {
    token: providerUser.token,
    companyId: northgate,
    body: {
      projectId,
      roleId,
      shiftType: 'WEEKDAY_DAY',
      workDate: dayOffset(-2),
      hoursRegular: 4,
      hoursOt: 0,
    },
  });
  eq('a crew can still log time on an unaccepted assignment', logWhileUnaccepted.status, 201);
  await db.query(
    `update project_assignments set acceptance = 'ACCEPTED', accepted_at = now() where id = $1`,
    [northgateAssignment.rows[0].id]
  );

  // 24 ── The trail, and a real consequence of where these actions are recorded.
  //
  // `rate_proposal.*` rows are written against the company whose record moved: the
  // provider for submit/withdraw, the hiring company for approve/reject. But a
  // provider is usually on the free Crew plan, which has no `audit_visibility`.
  // The event must still be written: visibility and the nightly retention purge
  // are separate from recording whether the negotiation happened.
  const providerTrail = await call('GET', '/v1/audit-logs?entityType=RATE_PROPOSAL', {
    token: providerUser.token,
    companyId: northgate,
  });
  eq('a free-plan provider cannot read a trail at all', providerTrail.status, 403);
  eq('...and the refusal names the feature', providerTrail.json?.error?.details?.feature,
    'audit_visibility');
  const providerRows = await db.query(
    `select count(*)::int as n from audit_logs where company_id = $1`,
    [northgate]
  );
  check('...but its authoritative events were still recorded before retention cleanup',
    providerRows.rows[0].n > 0, providerRows.rows[0]);

  const hiringTrail = await call('GET', '/v1/audit-logs?entityType=RATE_PROPOSAL', {
    token: owner.token,
    companyId: meridian,
  });
  eq('the hiring company reads its own trail', hiringTrail.status, 200);
  check('...holding both of its decisions',
    ['rate_proposal.approved', 'rate_proposal.rejected'].every((action) =>
      hiringTrail.json.data.some((r: any) => r.action === action)),
    hiringTrail.json.data.map((r: any) => r.action));
  // Keyed on the proposal id, not just the action: the trail is newest-first and
  // this section approves twice, so `find` by action alone returns the back-dated
  // single-line schedule rather than the two-line successor.
  const successorApproval = hiringTrail.json.data.find(
    (r: any) => r.action === 'rate_proposal.approved' && r.entityId === successorId
  );
  check('...and the approval names the versions it wrote',
    (successorApproval?.changes?.rateCardIds ?? []).length === 2,
    successorApproval?.changes);
  eq('...and the version it superseded', successorApproval?.changes?.supersededRateCardIds,
    [livePayCard.id]);

  const termsTrail = await call('GET', '/v1/audit-logs?entityType=ENGAGEMENT', {
    token: owner.token,
    companyId: meridian,
  });
  check('a terms change is audited with both sides of the change',
    termsTrail.json.data.some(
      (r: any) => r.action === 'engagement.terms_updated' && r.changes?.after?.paymentTermsDays === 30
    ));

  // ── Company ownership & creation safeguard (§3.1.1) ───────────────────────
  // The acceptance script in §12 of docs/operating-model/company-creation.md.
  section('Company creation safeguard (§3.1.1)');

  const PW = 'Verify-passw0rd!';

  // 1. Empty. A user who registers with no company creates their included one.
  const dana = await register('dana');
  eq('a registration with no company name leaves the account companyless',
    dana.companyId, null);

  const danaFirst = await call('POST', '/v1/me/companies', {
    token: dana.token,
    body: { name: `Northlight Rigging ${RUN}`, currency: 'GBP' },
  });
  eq('the included company is created without any approval', danaFirst.status, 201);
  eq('...on the allowance path', danaFirst.json.path, 'ALLOWANCE');
  const northlight = danaFirst.json.company.id as string;

  const danaLedger = await db.query(
    `select company_id, source from company_creation_allowances where user_id = $1`,
    [dana.userId]
  );
  eq('...and it is ledgered permanently against the identity',
    danaLedger.rows[0]?.company_id, northlight);
  eq('...recording how it was claimed', danaLedger.rows[0]?.source, 'SELF_SERVE');
  const creationEvidence = await db.query(
    `select
       (select count(*)::int from audit_logs where company_id = $1 and action = 'company.created') as customer_rows,
       (select count(*)::int from platform_audit_logs where entity_id = $1::text and action = 'company.created') as platform_rows,
       (select count(*)::int from delivery_outbox where aggregate_id = $1::text and topic = 'company.created') as outbox_rows`,
    [northlight]
  );
  eq('company creation records the customer event even before a paid plan exists',
    creationEvidence.rows[0].customer_rows, 1);
  eq('...keeps separate platform decision evidence', creationEvidence.rows[0].platform_rows, 1);
  eq('...and commits one idempotent outbox event with the company',
    creationEvidence.rows[0].outbox_rows, 1);

  // 2. Exactly once.
  const danaSecond = await call('POST', '/v1/me/companies', {
    token: dana.token,
    body: { name: `Northlight Two ${RUN}` },
  });
  eq('a second company through the same door is refused', danaSecond.status, 409);
  eq('...naming the flow that replaces it',
    danaSecond.json?.error?.details?.requires, 'company_creation_request');
  const afterRefusal = await db.query(
    `select count(*)::int as n from memberships m join companies c on c.id = m.company_id
      where m.user_id = $1 and m.role = 'OWNER' and not c.is_placeholder`,
    [dana.userId]
  );
  eq('...and nothing was created', afterRefusal.rows[0].n, 1);

  // Registration's own company consumes the allowance too — a signup path that
  // skipped the ledger would hand every account a free extra tenant.
  const regUser = await register('ledger', `Ledgered At Signup ${RUN}`);
  const regLedger = await db.query(
    `select company_id, source from company_creation_allowances where user_id = $1`,
    [regUser.userId]
  );
  eq('registering with a company name consumes the allowance',
    regLedger.rows[0]?.company_id, regUser.companyId);
  eq('...recorded as the registration path', regLedger.rows[0]?.source, 'REGISTRATION');
  const regSecond = await call('POST', '/v1/me/companies', {
    token: regUser.token,
    body: { name: `Second At Signup ${RUN}` },
  });
  eq('...so that account cannot create another either', regSecond.status, 409);

  // 3. Invitations are free: a membership received never consumes the allowance.
  const invited = await register('invitee');
  const inviteRes = await call('POST', '/v1/members/invite', {
    token: owner.token,
    companyId: meridian,
    body: { email: invited.email, role: 'MANAGER' },
  });
  check('a member invite is issued', inviteRes.status < 300, inviteRes.json);
  const acceptInvited = await call('POST', `/v1/invites/${inviteRes.json.inviteToken}/accept`, {
    token: invited.token,
  });
  check('...and accepted', acceptInvited.status < 300, acceptInvited.json);
  const invitedLedger = await db.query(
    `select count(*)::int as n from company_creation_allowances where user_id = $1`,
    [invited.userId]
  );
  eq('an invited membership consumes no allowance', invitedLedger.rows[0].n, 0);
  const invitedOwn = await call('POST', '/v1/me/companies', {
    token: invited.token,
    body: { name: `Invitee Own Co ${RUN}` },
  });
  eq('...so that user can still create their own included company', invitedOwn.status, 201);

  // Claiming a placeholder is an invitation too, and must not consume it either.
  const claimLedger = await db.query(
    `select count(*)::int as n from company_creation_allowances a
      where a.user_id = (select user_id from memberships where company_id = $1 and role = 'OWNER' limit 1)
        and a.company_id = $1`,
    [northgate]
  );
  eq('claiming a placeholder company is not an allowance consumption',
    claimLedger.rows[0].n, 0);

  // 4. Denied. The refusals are ordered cheapest-and-most-fundamental first, and
  //    this asserts that order as well as each refusal: an unverified address is
  //    turned away before the password is ever checked.
  const noAttestation = await call('POST', '/v1/company-creation-requests', {
    token: dana.token,
    body: { legalName: `Northlight Plant ${RUN}`, country: 'GB', password: PW },
  });
  eq('a request without the attestation is a validation error', noAttestation.status, 422);

  // Verification is unconditional on this path, unlike the first company.
  const unverified = await call('POST', '/v1/company-creation-requests', {
    token: dana.token,
    body: { legalName: `Northlight Plant ${RUN}`, country: 'GB', attestation: true, password: PW },
  });
  eq('an unverified address cannot request another company', unverified.status, 422);
  eq('...naming what is missing', unverified.json?.error?.details?.requires, 'email_verification');
  await db.query(`update users set email_verified_at = now() where id = $1`, [dana.userId]);

  const wrongPassword = await call('POST', '/v1/company-creation-requests', {
    token: dana.token,
    body: {
      legalName: `Northlight Plant ${RUN}`,
      country: 'GB',
      attestation: true,
      password: 'not-the-password',
    },
  });
  eq('a verified account with the wrong password is still refused', wrongPassword.status, 401);

  const noRequests = await db.query(
    `select count(*)::int as n from company_creation_requests where user_id = $1`,
    [dana.userId]
  );
  eq('...and none of those refusals wrote a row', noRequests.rows[0].n, 0);

  // 5. Duplicate identifiers route to recovery; a name-only match only warns.
  await db.query(
    `update companies set country = 'GB', registration_id = $2 where id = $1`,
    [northlight, `SC ${RUN} A`]
  );
  const collide = await call('POST', '/v1/company-creation-requests', {
    token: dana.token,
    body: {
      legalName: `Completely Different Name ${RUN}`,
      country: 'GB',
      registrationId: `sc-${RUN}-a`,
      attestation: true,
      password: PW,
    },
  });
  eq('a registration identifier already on CrewQuo is refused', collide.status, 409);
  eq('...routing to recovery', collide.json?.error?.details?.requires, 'recovery');
  check('...with the three ways out',
    (collide.json?.error?.details?.routes ?? []).length === 3, collide.json?.error?.details);
  check('...and disclosing no company',
    !JSON.stringify(collide.json).includes('Northlight Rigging'), collide.json);

  const otherCountry = await call('POST', '/v1/company-creation-requests', {
    token: dana.token,
    body: {
      legalName: `Northlight Rigging ${RUN} Limited`,
      country: 'IE',
      registrationId: `SC${RUN}A`,
      attestation: true,
      password: PW,
    },
  });
  // Same number, different jurisdiction: not a duplicate. The name matches, so
  // this is the warning path — it proceeds, and says why it is unsure.
  eq('the same number in another country is not a duplicate', otherCountry.status, 201);
  check('...but the matching name is warned about', Boolean(otherCountry.json.warning),
    { warning: otherCountry.json.warning, status: otherCountry.status, body: otherCountry.json });
  const warnedRequestId = otherCountry.json.request.id as string;

  // 6. One open request per identity.
  const ccSecondOpen = await call('POST', '/v1/company-creation-requests', {
    token: dana.token,
    body: { legalName: `Another One ${RUN}`, country: 'GB', attestation: true, password: PW },
  });
  eq('a second open request is refused', ccSecondOpen.status, 409);

  // The requester withdraws by deleting the row; the platform log keeps both halves.
  const withdrawn = await call('DELETE', `/v1/company-creation-requests/${warnedRequestId}`, {
    token: dana.token,
  });
  eq('the requester can withdraw a pending request', withdrawn.status, 204);
  const withdrawnRows = await db.query(
    `select count(*)::int as n from company_creation_requests where id = $1`,
    [warnedRequestId]
  );
  eq('...and the row is gone', withdrawnRows.rows[0].n, 0);
  const withdrawTrail = await db.query(
    `select action from platform_audit_logs where entity_id = $1 order by created_at`,
    [warnedRequestId]
  );
  eq('...but the immutable log holds its whole life',
    withdrawTrail.rows.map((r: any) => r.action),
    ['company_creation_request.created', 'company_creation_request.deleted']);

  // 7. Filed, reviewed and decided.
  const filed = await call('POST', '/v1/company-creation-requests', {
    token: dana.token,
    body: {
      legalName: `Northlight Plant Hire ${RUN}`,
      displayName: `Northlight Plant ${RUN}`,
      country: 'GB',
      registrationId: `SC ${RUN} B`,
      currency: 'GBP',
      attestation: true,
      password: PW,
    },
  });
  eq('a clean request is filed', filed.status, 201);
  // Additional-company checkout stays off, so everything lands in the audited-admin arm.
  eq('...in the review queue, not checkout', filed.json.request.status, 'PENDING_REVIEW');
  eq('...on the admin route', filed.json.request.approvalRoute, 'ADMIN');
  const requestId = filed.json.request.id as string;

  const frozen = await db.query(
    `select attestation_text, attested_at from company_creation_requests where id = $1`,
    [requestId]
  );
  check('...freezing the attestation text onto the row',
    (frozen.rows[0]?.attestation_text ?? '').includes('separate legal business'),
    frozen.rows[0]?.attestation_text);

  // Creating is still refused while the request is only pending.
  const beforeApproval = await call('POST', '/v1/me/companies', {
    token: dana.token,
    body: { name: `Northlight Plant ${RUN}`, requestId },
  });
  eq('a pending request does not let a company be created', beforeApproval.status, 409);

  const queue = await call('GET', '/v1/admin/company-creation-requests?status=PENDING_REVIEW', {
    token: staff.token,
  });
  eq('staff can read the review queue', queue.status, 200);
  const queued = queue.json.data.find((r: any) => r.id === requestId);
  check('...containing the request', Boolean(queued), queue.json.data.length);
  eq('...with what the reviewer actually needs: how many they already own',
    queued?.ownedCompanies, 1);

  const customerQueue = await call('GET', '/v1/admin/company-creation-requests', {
    token: dana.token,
  });
  eq('a customer cannot read the queue', customerQueue.status, 403);

  const noReason = await call(`POST`, `/v1/admin/company-creation-requests/${requestId}/reject`, {
    token: staff.token,
    body: {},
  });
  eq('a decision with no reason is refused', noReason.status, 422);

  const ccApproved = await call('POST', `/v1/admin/company-creation-requests/${requestId}/approve`, {
    token: staff.token,
    body: { reason: 'Verified separate legal entity, Companies House checked' },
  });
  eq('an approval with a reason is accepted', ccApproved.status, 200);
  eq('...moving the request to APPROVED', ccApproved.json.request.status, 'APPROVED');

  const ccReApprove = await call('POST', `/v1/admin/company-creation-requests/${requestId}/approve`, {
    token: staff.token,
    body: { reason: 'again' },
  });
  eq('a second approval is refused', ccReApprove.status, 409);

  // 8. Consumption is single use, and idempotent under a key.
  const IDEM = `verify-${RUN}-plant`;
  const consumed = await call('POST', '/v1/me/companies', {
    token: dana.token,
    body: { name: `Northlight Plant ${RUN}`, currency: 'GBP', requestId, idempotencyKey: IDEM },
  });
  eq('the approval creates the company', consumed.status, 201);
  eq('...on the approval path', consumed.json.path, 'APPROVAL');
  const plant = consumed.json.company.id as string;

  const requestAfter = await db.query(
    `select status, company_id from company_creation_requests where id = $1`,
    [requestId]
  );
  eq('...consuming the request', requestAfter.rows[0]?.status, 'CONSUMED');
  eq('...and recording which company it became', requestAfter.rows[0]?.company_id, plant);

  const identity = await db.query(
    `select country, registration_id, registration_id_normalized from companies where id = $1`,
    [plant]
  );
  eq('the reviewed legal identity lands on the company', identity.rows[0]?.country, 'GB');
  eq('...normalised for the next duplicate check',
    identity.rows[0]?.registration_id_normalized, `SC${RUN}B`.toUpperCase());

  const replay = await call('POST', '/v1/me/companies', {
    token: dana.token,
    body: { name: `Northlight Plant ${RUN}`, currency: 'GBP', idempotencyKey: IDEM },
  });
  eq('an idempotent retry returns the same company, not a second one', replay.status, 200);
  eq('...the very same one', replay.json.company.id, plant);

  const replayNoKey = await call('POST', '/v1/me/companies', {
    token: dana.token,
    body: { name: `Northlight Plant ${RUN}`, currency: 'GBP' },
  });
  eq('a retry with no key is refused rather than silently duplicating', replayNoKey.status, 409);

  const totalOwned = await db.query(
    `select count(*)::int as n from memberships m join companies c on c.id = m.company_id
      where m.user_id = $1 and m.role = 'OWNER' and not c.is_placeholder`,
    [dana.userId]
  );
  eq('...so exactly two companies exist for this identity', totalOwned.rows[0].n, 2);

  // Independent subscription and data boundary (§3.1.1(4)).
  const plantBoundary = await db.query(
    `select
       (select count(*)::int from company_subscriptions where company_id = $1) as subs,
       (select count(*)::int from role_catalog where company_id = $1) as roles,
       (select count(*)::int from rate_cards where company_id = $1) as cards,
       (select count(*)::int from engagements
         where client_company_id = $1 or provider_company_id = $1) as edges`,
    [plant]
  );
  eq('a created company inherits no subscription', plantBoundary.rows[0].subs, 0);
  eq('...no role catalog', plantBoundary.rows[0].roles, 0);
  eq('...no rate cards', plantBoundary.rows[0].cards, 0);
  eq('...and no relationships', plantBoundary.rows[0].edges, 0);
  const plantCurrency = await db.query(`select currency from companies where id = $1`, [plant]);
  eq('...and carries its own currency', plantCurrency.rows[0]?.currency, 'GBP');

  // 9. An expired approval is refused, and says when it lapsed.
  const expiring = await call('POST', '/v1/company-creation-requests', {
    token: dana.token,
    body: { legalName: `Northlight Lapsed ${RUN}`, country: 'GB', attestation: true, password: PW },
  });
  eq('a further request may be filed once the last is consumed', expiring.status, 201);
  const expiringId = expiring.json.request.id as string;
  await call('POST', `/v1/admin/company-creation-requests/${expiringId}/approve`, {
    token: staff.token,
    body: { reason: 'ccApproved, then left to lapse for the test' },
  });
  await db.query(
    `update company_creation_requests set expires_at = now() - interval '1 day' where id = $1`,
    [expiringId]
  );
  const lapsed = await call('POST', '/v1/me/companies', {
    token: dana.token,
    body: { name: `Northlight Lapsed ${RUN}`, requestId: expiringId },
  });
  eq('an expired approval cannot be consumed', lapsed.status, 409);
  const lapsedState = await call('GET', '/v1/company-creation-requests', { token: dana.token });
  eq('...and it reads as EXPIRED without a writer touching it',
    lapsedState.json.history.find((r: any) => r.id === expiringId)?.status, 'EXPIRED');
  eq('...so it no longer occupies the single open slot', lapsedState.json.openRequest, null);
  eq('...and the row itself is untouched in the database',
    (await db.query(`select status from company_creation_requests where id = $1`, [expiringId]))
      .rows[0]?.status,
    'APPROVED');

  const rejectExpired = await call(
    'POST',
    `/v1/admin/company-creation-requests/${expiringId}/reject`,
    { token: staff.token, body: { reason: 'too late' } }
  );
  eq('a lapsed request cannot be decided either', rejectExpired.status, 409);

  // 10. Rejection is terminal and carries its reason to the requester.
  await db.query(`delete from company_creation_requests where id = $1`, [expiringId]);
  const toReject = await call('POST', '/v1/company-creation-requests', {
    token: dana.token,
    body: { legalName: `Northlight Refused ${RUN}`, country: 'GB', attestation: true, password: PW },
  });
  const rejectId = toReject.json.request.id as string;
  const ccRejected = await call('POST', `/v1/admin/company-creation-requests/${rejectId}/reject`, {
    token: staff.token,
    body: { reason: 'This is a department of an existing company, not a separate business' },
  });
  eq('a rejection with a reason is recorded', ccRejected.status, 200);
  eq('...as a terminal state', ccRejected.json.request.status, 'REJECTED');

  const danaState = await call('GET', '/v1/company-creation-requests', { token: dana.token });
  eq('the requester reads the decision without any email existing',
    danaState.json.history.find((r: any) => r.id === rejectId)?.decisionReason,
    'This is a department of an existing company, not a separate business');
  eq('...and the allowance is still shown as spent', danaState.json.allowanceAvailable, false);
  eq('...with a fresh request possible again', danaState.json.canRequest, true);

  const deleteDecided = await call('DELETE', `/v1/company-creation-requests/${rejectId}`, {
    token: dana.token,
  });
  eq('a decided request cannot be withdrawn', deleteDecided.status, 409);

  // Somebody else's request is invisible, not merely forbidden.
  const foreignRequest = await call('DELETE', `/v1/company-creation-requests/${requestId}`, {
    token: regUser.token,
  });
  eq("another user's request id is a 404, not a 403", foreignRequest.status, 404);

  // 11. Platform staff stay out of the customer path.
  const staffCreate = await call('POST', '/v1/me/companies', {
    token: staff.token,
    body: { name: `Staff Made ${RUN}` },
  });
  eq('platform staff cannot create a company through the customer endpoint', staffCreate.status, 403);
  const staffRequest = await call('POST', '/v1/company-creation-requests', {
    token: staff.token,
    body: { legalName: `Staff Co ${RUN}`, country: 'GB', attestation: true, password: PW },
  });
  eq('...nor request one', staffRequest.status, 403);

  // 12. Trials do not reset across a new tenant.
  const trialOne = await call('POST', `/v1/admin/companies/${northlight}/comp-trial`, {
    token: staff.token,
    body: { planId: 'pro', days: 14 },
  });
  eq('a first trial is comped normally', trialOne.status, 200);
  const grantOne = await db.query(
    `select is_repeat, source from trial_grants where company_id = $1 and user_id = $2`,
    [northlight, dana.userId]
  );
  eq('...and ledgered against the owning identity', grantOne.rows.length, 1);
  eq('...as a first grant', grantOne.rows[0]?.is_repeat, false);

  const extend = await call('POST', `/v1/admin/companies/${northlight}/comp-trial`, {
    token: staff.token,
    body: { planId: 'pro', days: 7 },
  });
  eq('extending the same company\'s trial is allowed', extend.status, 200);
  const afterExtend = await db.query(
    `select count(*)::int as n from trial_grants where company_id = $1`,
    [northlight]
  );
  eq('...and is not recorded as a second trial', afterExtend.rows[0].n, 1);

  const secondTrial = await call('POST', `/v1/admin/companies/${plant}/comp-trial`, {
    token: staff.token,
    body: { planId: 'pro', days: 14 },
  });
  eq('the same owner cannot trial again through a new company', secondTrial.status, 409);
  eq('...naming what would allow it',
    secondTrial.json?.error?.details?.requires, 'acknowledgeRepeatTrial');

  const repeatNoReason = await call('POST', `/v1/admin/companies/${plant}/comp-trial`, {
    token: staff.token,
    body: { planId: 'pro', days: 14, acknowledgeRepeatTrial: true },
  });
  eq('an acknowledged repeat still needs a reason', repeatNoReason.status, 422);

  const repeat = await call('POST', `/v1/admin/companies/${plant}/comp-trial`, {
    token: staff.token,
    body: {
      planId: 'pro',
      days: 14,
      acknowledgeRepeatTrial: true,
      reason: 'Genuinely separate plant-hire business, verified at approval',
    },
  });
  eq('...and is then allowed', repeat.status, 200);
  const repeatGrant = await db.query(
    `select is_repeat, reason from trial_grants where company_id = $1`,
    [plant]
  );
  eq('...recorded as a repeat', repeatGrant.rows[0]?.is_repeat, true);
  check('...with the operator\'s reason kept',
    (repeatGrant.rows[0]?.reason ?? '').includes('plant-hire'), repeatGrant.rows[0]?.reason);
  const repeatAudit = await db.query(
    `select count(*)::int as n from platform_audit_logs
      where action = 'trial.repeat_granted' and entity_id = $1`,
    [plant]
  );
  eq('...and audited as one on the platform trail', repeatAudit.rows[0].n, 1);

  // 13. Rate limiting is counted from the immutable log, so deleting buys nothing.
  const limiter = await register('limiter');
  await db.query(`update users set email_verified_at = now() where id = $1`, [limiter.userId]);
  await call('POST', '/v1/me/companies', {
    token: limiter.token,
    body: { name: `Limiter Co ${RUN}` },
  });
  let limited: any = null;
  for (let i = 0; i < 6; i += 1) {
    const res = await call('POST', '/v1/company-creation-requests', {
      token: limiter.token,
      body: { legalName: `Limiter Try ${i} ${RUN}`, country: 'GB', attestation: true, password: PW },
    });
    if (res.status === 201) {
      // Delete it so the one-open-request rule is not what refuses the next one —
      // the point is that the *log* is what counts, and a delete does not undo it.
      await call('DELETE', `/v1/company-creation-requests/${res.json.request.id}`, {
        token: limiter.token,
      });
    }
    if (res.status === 429) { limited = res; break; }
  }
  check('a sixth request in 24 hours is rate limited', limited?.status === 429, limited?.status);
  eq('...even though every earlier one was deleted',
    limited?.json?.error?.details?.retryAfterHours, 24);

  // 14. The migration's ccBackfill left existing owners safe.
  const ccBackfill = await db.query(
    `select count(*)::int as n
       from memberships m
       join companies c on c.id = m.company_id
      where m.role = 'OWNER' and m.status <> 'INVITED'
        and not c.is_placeholder and c.claimed_by_company_id is null
        and c.created_at < (select applied_at from schema_migrations
                             where filename = '0011_company_creation_safeguard.sql')
        and not exists (select 1 from company_creation_allowances a where a.user_id = m.user_id)`
  );
  eq('every pre-existing real-company owner is ledgered', ccBackfill.rows[0].n, 0);

  // The ledger survives its company, which is the loophole §3.1.1(1) closes.
  const doomed = await register('doomed');
  const doomedCreate = await call('POST', '/v1/me/companies', {
    token: doomed.token,
    body: { name: `Doomed Co ${RUN}` },
  });
  await db.query(`delete from companies where id = $1`, [doomedCreate.json.company.id]);
  const doomedLedger = await db.query(
    `select company_id from company_creation_allowances where user_id = $1`,
    [doomed.userId]
  );
  eq('deleting the company does not delete the ledger row', doomedLedger.rows.length, 1);
  eq('...it only forgets which company it was', doomedLedger.rows[0]?.company_id, null);
  const doomedAgain = await call('POST', '/v1/me/companies', {
    token: doomed.token,
    body: { name: `Doomed Again ${RUN}` },
  });
  eq('...so deleting a company does not restore the allowance', doomedAgain.status, 409);

  // ── Durable delivery foundation ───────────────────────────────────────────
  section('Durable delivery foundation');
  const deadDeliveryId = randomUUID();
  await db.query(
    `insert into delivery_outbox
       (id, topic, aggregate_type, aggregate_id, payload, idempotency_key,
        status, attempts, last_error)
     values ($1, 'verify.failure', 'VERIFY', $2, '{}', $3, 'DEAD_LETTER', 8, 'fixture failure')`,
    [deadDeliveryId, RUN, `verify.failure:${RUN}`]
  );
  const deliveryOps = await call('GET', '/v1/admin/operations', { token: staff.token });
  eq('operations exposes durable-delivery health', deliveryOps.status, 200);
  check('...and the dead letter is visible to platform staff',
    deliveryOps.json.deadLetters.some((row: any) => row.id === deadDeliveryId));

  // The notification channel queue is a *second* loop, drained separately from
  // the outbox. Its counts were computable from the day it was written and shown
  // nowhere, so an operator could watch a healthy outbox while every email in the
  // system failed.
  check('...alongside the notification channel queue, which drains separately',
    deliveryOps.json.notifications !== undefined &&
      ['pending', 'failed', 'sentLastDay', 'skippedLastDay']
        .every((k) => typeof deliveryOps.json.notifications[k] === 'number'),
    deliveryOps.json.notifications);
  const opsServices = (deliveryOps.json.services as { name: string; status: string }[]);
  check('...and notification delivery has a named service row',
    opsServices.some((svc) => svc.name === 'Notification delivery'),
    opsServices.map((s) => s.name));
  // Configuration and queue health are separate rows on purpose: "no API key" and
  // "the provider is rejecting us" are different problems with different repairs.
  check('...separate from whether an email provider is configured at all',
    opsServices.some((svc) => svc.name === 'Email provider'),
    opsServices.map((s) => s.name));
  const replayDelivery = await call(
    'POST',
    `/v1/admin/delivery/OUTBOX/${deadDeliveryId}/replay`,
    { token: staff.token, body: { reason: 'Retry after correcting the fixture dependency' } }
  );
  eq('a Super Admin can replay it with a reason', replayDelivery.status, 200);
  const replayedDelivery = await db.query(
    `select status, attempts, last_error from delivery_outbox where id = $1`,
    [deadDeliveryId]
  );
  eq('...which safely resets it to pending', replayedDelivery.rows[0], {
    status: 'PENDING', attempts: 0, last_error: null,
  });
  const replayAudit = await db.query(
    `select count(*)::int as n from platform_audit_logs
      where action = 'delivery.dead_letter_replayed' and entity_id = $1`,
    [deadDeliveryId]
  );
  eq('...and records the operator decision atomically', replayAudit.rows[0].n, 1);

  // ── Money identity (§3.3 decision #5) ─────────────────────────────────────
  // docs/operating-model/money-boundary.md §12, implemented. Self-contained
  // fixtures: this section deliberately does not reuse the core-loop companies,
  // because it moves a company currency and a project's label, and an earlier
  // assertion must not start depending on either.
  section('Money identity — one currency per company, and the label pin');

  // docs/operating-model/money-boundary.md §12. This section used to be 45 checks
  // of exchange-rate machinery: recording a rate with its provenance, refusing an
  // unlike schedule until one existed, freezing the rate onto a PAY snapshot at
  // submit, withholding an unconvertible figure and naming the gap, refusing to
  // delete a cited rate. All of it went on 2026-08-19 with the owner decision that
  // **a company works in exactly one currency and the currency is a label**.
  //
  // What survives is everything that is still true with one unit: a project
  // inherits its company's label, snapshots it so history cannot be relabelled,
  // pins it once money commits, and the client portal shows the label without ever
  // seeing the owner's side of the money.

  const fxOwner = await register('fx-owner', `Meridian Single ${RUN}`);
  const fxCompany = fxOwner.companyId!;
  await subscribe(fxCompany, 'pro');

  const fxRole = await call('POST', '/v1/role-catalog', {
    token: fxOwner.token,
    companyId: fxCompany,
    body: { name: `Rigger ${RUN}` },
  });
  const fxRoleId = fxRole.json.role.id as string;

  const fxProviderRes = await call('POST', '/v1/providers', {
    token: fxOwner.token,
    companyId: fxCompany,
    body: { name: `London Rigging ${RUN}`, email: `fxprov+${RUN}@verify.crewquo.test` },
  });
  const fxProviderUser = await register('fx-provider', undefined, `fxprov+${RUN}@verify.crewquo.test`);
  await call('POST', `/v1/invites/${fxProviderRes.json.inviteToken}/accept`, {
    token: fxProviderUser.token,
  });
  const fxProvider = fxProviderRes.json.provider.providerCompanyId as string;
  const fxEngagement = fxProviderRes.json.provider.engagementId as string;
  await call('POST', `/v1/engagements/${fxEngagement}/accept`, {
    token: fxProviderUser.token,
    companyId: fxProvider,
  });

  const fxClientRes = await call('POST', '/v1/clients', {
    token: fxOwner.token,
    companyId: fxCompany,
    body: { name: `Harbour Estates ${RUN}`, email: `fxclient+${RUN}@verify.crewquo.test` },
  });
  const fxClient = fxClientRes.json.client.clientCompanyId as string;
  const fxClientEngagement = fxClientRes.json.client.engagementId as string;

  // 1 ── Inherited, not chosen. The majority never touches this.
  const fxProject = await call('POST', '/v1/projects', {
    token: fxOwner.token,
    companyId: fxCompany,
    body: { name: `Fit-out ${RUN}`, clientCompanyId: fxClient, engagementId: fxClientEngagement },
  });
  eq('a new project reports in the owner company currency without anyone choosing',
    fxProject.json.project.reportingCurrency, 'USD');
  const fxProjectId = fxProject.json.project.id as string;

  // 2 ── Unpinned: an empty project's label can still be changed, and the change
  // is evidence rather than telemetry.
  const toEur = await call('PATCH', `/v1/projects/${fxProjectId}`, {
    token: fxOwner.token,
    companyId: fxCompany,
    body: { reportingCurrency: 'EUR' },
  });
  eq('an empty project may change its reporting currency', toEur.json.project.reportingCurrency, 'EUR');
  const currencyAudit = await db.query(
    `select changes from audit_logs
      where action = 'project.reporting_currency_set' and entity_id = $1`,
    [fxProjectId]
  );
  eq('...and the change is audited with both sides', currencyAudit.rows[0]?.changes?.reportingCurrency,
    { from: 'USD', to: 'EUR' });
  const currencyEvent = await db.query(
    `select count(*)::int as n from delivery_outbox
      where topic = 'project.reporting_currency_set' and aggregate_id = $1`,
    [fxProjectId]
  );
  eq('...and emits one durable event in the same transaction', currencyEvent.rows[0].n, 1);
  await call('PATCH', `/v1/projects/${fxProjectId}`, {
    token: fxOwner.token,
    companyId: fxCompany,
    body: { reportingCurrency: 'USD' },
  });

  // 3 ── Snapshotted, not referenced. This is the whole reason the project keeps
  // its own column: moving the company label must not relabel a project's history.
  await call('PATCH', `/v1/companies/${fxCompany}`, {
    token: fxOwner.token, companyId: fxCompany, body: { currency: 'AUD' },
  });
  const afterCompanyMove = await call('GET', `/v1/projects/${fxProjectId}`, {
    token: fxOwner.token, companyId: fxCompany,
  });
  eq('changing the company currency does not relabel an existing project',
    afterCompanyMove.json.project.reportingCurrency, 'USD');
  const newerProject = await call('POST', '/v1/projects', {
    token: fxOwner.token, companyId: fxCompany, body: { name: `After the move ${RUN}` },
  });
  eq('...while a project created afterwards inherits the new label',
    newerProject.json.project.reportingCurrency, 'AUD');
  await call('PATCH', `/v1/companies/${fxCompany}`, {
    token: fxOwner.token, companyId: fxCompany, body: { currency: 'USD' },
  });

  // 4 ── Denied. OWNER/ADMIN only, and asserted after a real membership exists —
  // an invite that quietly 404s makes this pass for the wrong reason, testing the
  // company edge instead of the role rule it names.
  const fxMemberInvite = await call('POST', '/v1/members/invite', {
    token: fxOwner.token,
    companyId: fxCompany,
    body: { email: `fxmember+${RUN}@verify.crewquo.test`, role: 'MEMBER' },
  });
  eq('a MEMBER is invited to the company', fxMemberInvite.status, 201);
  const fxMember = await register('fx-member', undefined, `fxmember+${RUN}@verify.crewquo.test`);
  const fxMemberAccept = await call(
    'POST', `/v1/invites/${fxMemberInvite.json.inviteToken}/accept`, { token: fxMember.token }
  );
  eq('...and accepts, so the next check really is about their role', fxMemberAccept.status, 201);
  const memberRepoints = await call('PATCH', `/v1/projects/${fxProjectId}`, {
    token: fxMember.token,
    companyId: fxCompany,
    body: { reportingCurrency: 'GBP' },
  });
  eq('a MEMBER cannot change a project reporting currency', memberRepoints.status, 403);

  // 5 ── Gone: there is no exchange-rate surface left to reach.
  const fxGone = await call('GET', '/v1/fx-rates', {
    token: fxOwner.token, companyId: fxCompany,
  });
  eq('the exchange-rate API no longer exists', fxGone.status, 404);
  const fxTableGone = await db.query(
    `select count(*)::int as n from information_schema.tables where table_name = 'fx_rates'`
  );
  eq('...and neither does its table', fxTableGone.rows[0].n, 0);
  const currencyColumns = await db.query(
    `select count(*)::int as n from information_schema.columns
      where column_name = 'currency'
        and table_name in ('invoices', 'rate_cards', 'rate_proposals')`
  );
  eq('...nor any per-row currency column that could disagree with its company',
    currencyColumns.rows[0].n, 0);

  // 6 ── A PAY schedule takes the hiring company's currency, and the proposer
  // cannot ask for another — there is no field to ask with.
  const fxSchedule = await call('POST', `/v1/commercial-agreements/${fxEngagement}/schedule`, {
    token: fxOwner.token,
    companyId: fxCompany,
    body: {
      effectiveFrom: '2026-01-01',
      retroactiveReason: 'Rates agreed before CrewQuo',
      lines: [{
        operation: 'CREATE', roleId: fxRoleId, rateLabel: 'MON_FRI_DAY',
        rateMode: 'HOURLY', hourlyRateCents: 5000,
      }],
    },
  });
  eq('an agreed PAY schedule is recorded', fxSchedule.status, 201);
  eq('...in the hiring company currency, which the caller never sent',
    fxSchedule.json.currency, 'USD');

  // 7 ── Work prices, freezes and reports in that one unit.
  await call('POST', '/v1/rate-cards', {
    token: fxOwner.token,
    companyId: fxCompany,
    body: {
      kind: 'BILL', roleId: fxRoleId, counterpartyCompanyId: fxClient,
      rateLabel: 'MON_FRI_DAY', rateMode: 'HOURLY', hourlyRateCents: 9000,
      effectiveFrom: '2026-01-01',
    },
  });
  await call('POST', `/v1/projects/${fxProjectId}/assignments`, {
    token: fxOwner.token, companyId: fxCompany, body: { providerCompanyId: fxProvider },
  });
  const fxLog = await call('POST', '/v1/time-logs', {
    token: fxProviderUser.token,
    companyId: fxProvider,
    body: {
      projectId: fxProjectId, roleId: fxRoleId, shiftType: 'WEEKDAY_DAY',
      workDate: '2026-07-06', hoursRegular: 8, hoursOt: 0,
    },
  });
  const fxLogId = fxLog.json.timeLog.id as string;
  const fxSubmitted = await call('POST', `/v1/time-logs/${fxLogId}/submit`, {
    token: fxProviderUser.token, companyId: fxProvider,
  });
  eq('the PAY snapshot freezes 8h x 5000', fxSubmitted.json.timeLog.resolvedRate?.costCents, 40000);
  eq('...labelled with the paying company currency',
    fxSubmitted.json.timeLog.resolvedRate?.currency, 'USD');
  check('...and carries no exchange rate, because there is no such thing now',
    fxSubmitted.json.timeLog.resolvedRate?.fx === undefined,
    fxSubmitted.json.timeLog.resolvedRate);
  await call('POST', `/v1/time-logs/${fxLogId}/approve`, {
    token: fxOwner.token, companyId: fxCompany,
  });

  const fxSummary = await call('GET', `/v1/projects/${fxProjectId}/summary`, {
    token: fxOwner.token, companyId: fxCompany,
  });
  eq('the summary reports in the project label', fxSummary.json.summary.currency, 'USD');
  eq('...at the frozen cost, unconverted', fxSummary.json.summary.laborCostCents, 40000);
  eq('...with the BILL side priced from the owner cards', fxSummary.json.summary.billCents, 72000);
  eq('...and a margin, because nothing is withheld', fxSummary.json.summary.marginCents, 32000);
  check('...and the summary no longer reports conversion gaps at all',
    fxSummary.json.summary.conversionGaps === undefined, Object.keys(fxSummary.json.summary));

  // 8 ── Pinned. The one way a pure label can still do damage is retroactively:
  // the numbers do not move, so relabelling changes what all of them mean.
  const pinned = await call('PATCH', `/v1/projects/${fxProjectId}`, {
    token: fxOwner.token,
    companyId: fxCompany,
    body: { reportingCurrency: 'EUR' },
  });
  eq('a project holding approved work refuses a currency change', pinned.status, 409);
  check('...naming what pins it rather than just refusing',
    /approved time log/.test(pinned.json?.error?.message ?? ''), pinned.json?.error?.message);
  check('...and saying the harm is relabelling, not arithmetic',
    /relabel/i.test(pinned.json?.error?.message ?? ''), pinned.json?.error?.message);

  // 9 ── Tax honesty: nothing anywhere calls this a tax invoice.
  const taxInvoice = await call('POST', '/v1/invoices', {
    token: fxOwner.token,
    companyId: fxCompany,
    body: { projectId: fxProjectId, includeApprovedWork: true },
  });
  eq('an invoice is created from the approved work', taxInvoice.status, 201);
  eq('...denominated in the project label, not the live company column',
    taxInvoice.json.invoice.currency, 'USD');
  check('no API response describes the document as a tax invoice',
    !/tax invoice/i.test(JSON.stringify(taxInvoice.json)),
    taxInvoice.json?.invoice?.id);

  // 10 ── The portal boundary stays structural.
  await call('PATCH', `/v1/projects/${fxProjectId}`, {
    token: fxOwner.token,
    companyId: fxCompany,
    body: { clientVisible: true },
  });
  const fxClientUser = await register('fx-client', undefined, `fxclient+${RUN}@verify.crewquo.test`);
  await call('POST', `/v1/invites/${fxClientRes.json.inviteToken}/accept`, {
    token: fxClientUser.token,
  });
  const portalView = await call('GET', `/v1/portal/projects/${fxProjectId}`, {
    token: fxClientUser.token,
    companyId: fxClient,
  });
  eq('the client can read the published project', portalView.status, 200);
  eq('...in the project reporting currency', portalView.json.currency, 'USD');
  const portalJson = JSON.stringify(portalView.json);
  const leaked = ['fxRate', 'reportingCurrency', 'marginCents', 'laborCostCents', 'resolvedRate']
    .filter((needle) => portalJson.includes(needle));
  check('...and the payload carries no PAY cost or margin', leaked.length === 0,
    { leaked, sample: portalJson.slice(0, 400) });
  eq('...the client-facing shape is exactly the nine documented fields',
    Object.keys(portalView.json).sort(),
    ['canComment', 'currency', 'expenseTotalCents', 'lineItems', 'pricingComplete', 'project',
      'showAuditTrail', 'timeTotalCents', 'totalCents']);

  // ── Notifications & the Action Centre ─────────────────────────────────────
  // docs/operating-model/notifications.md §12, implemented. This is also the
  // first end-to-end proof that the 0012 outbox is actually *drained*: until the
  // worker CLI existed, `runOutboxBatch` had no caller and every event sat
  // PENDING forever.
  section('Notifications & the Universal Action Centre');

  const nOwner = await register('n-owner', `Meridian Notify ${RUN}`);
  const nCompany = nOwner.companyId!;
  await subscribe(nCompany, 'pro');

  // A second approver, so "one manager acts, the other's task closes" is provable.
  const nSecondInvite = await call('POST', '/v1/members/invite', {
    token: nOwner.token,
    companyId: nCompany,
    body: { email: `n-second+${RUN}@verify.crewquo.test`, role: 'MANAGER' },
  });
  eq('a second approver is invited', nSecondInvite.status, 201);
  const nSecond = await register('n-second', undefined, `n-second+${RUN}@verify.crewquo.test`);
  const nSecondAccept = await call(
    'POST', `/v1/invites/${nSecondInvite.json.inviteToken}/accept`, { token: nSecond.token }
  );
  eq('...and accepts', nSecondAccept.status, 201);

  const nRole = await call('POST', '/v1/role-catalog', {
    token: nOwner.token, companyId: nCompany, body: { name: `Fitter ${RUN}` },
  });
  const nRoleId = nRole.json.role.id as string;
  const nProviderRes = await call('POST', '/v1/providers', {
    token: nOwner.token,
    companyId: nCompany,
    body: { name: `Notify Crew ${RUN}`, email: `n-prov+${RUN}@verify.crewquo.test` },
  });
  const nProviderUser = await register('n-prov', undefined, `n-prov+${RUN}@verify.crewquo.test`);
  await call('POST', `/v1/invites/${nProviderRes.json.inviteToken}/accept`, { token: nProviderUser.token });
  const nProvider = nProviderRes.json.provider.providerCompanyId as string;
  await db.query(
    `insert into rate_cards
       (company_id, kind, counterparty_company_id, role_id, rate_mode, rate_label,
        hourly_rate_cents, effective_from, active)
     values ($1,'PAY',$2,$3,'HOURLY','MON_FRI_DAY',5000,'2026-01-01',true)`,
    [nCompany, nProvider, nRoleId]
  );
  const nProject = await call('POST', '/v1/projects', {
    token: nOwner.token, companyId: nCompany, body: { name: `Notify fit-out ${RUN}` },
  });
  const nProjectId = nProject.json.project.id as string;
  await call('POST', `/v1/projects/${nProjectId}/assignments`, {
    token: nOwner.token, companyId: nCompany, body: { providerCompanyId: nProvider },
  });

  // 1 ── Empty.
  const emptyInbox = await call('GET', '/v1/notifications', {
    token: nOwner.token, companyId: nCompany,
  });
  eq('a new inbox is empty rather than erroring', emptyInbox.status, 200);
  eq('...with nothing in it', emptyInbox.json.data.length, 0);
  const emptyCount = await call('GET', '/v1/notifications/open-count', {
    token: nOwner.token, companyId: nCompany,
  });
  eq('...and no outstanding actions', emptyCount.json.openCount, 0);

  // 2 ── Raised. Submitting emits transactionally; the worker turns it into rows.
  const nLog = await call('POST', '/v1/time-logs', {
    token: nProviderUser.token,
    companyId: nProvider,
    body: {
      projectId: nProjectId, roleId: nRoleId, shiftType: 'WEEKDAY_DAY',
      workDate: '2026-07-20', hoursRegular: 8, hoursOt: 0,
    },
  });
  const nLogId = nLog.json.timeLog.id as string;
  await call('POST', `/v1/time-logs/${nLogId}/submit`, {
    token: nProviderUser.token, companyId: nProvider,
  });
  const queuedEvent = await db.query(
    `select status from delivery_outbox where idempotency_key = $1`,
    [`work.submitted:${nLogId}`]
  );
  eq('submitting commits its domain event with the mutation', queuedEvent.rows[0]?.status, 'PENDING');

  const firstDrain = await drainWorkers();
  check('the worker claims and delivers it', firstDrain.outbox.delivered >= 1, firstDrain);

  const ownerInbox = await call('GET', '/v1/notifications?filter=open', {
    token: nOwner.token, companyId: nCompany,
  });
  eq('the approver has one thing to do', ownerInbox.json.data.length, 1);
  eq('...named as a task, not just news', ownerInbox.json.data[0]?.requiresAction, true);
  eq('...in the UNREAD state', ownerInbox.json.data[0]?.state, 'UNREAD');
  const secondInbox = await call('GET', '/v1/notifications?filter=open', {
    token: nSecond.token, companyId: nCompany,
  });
  eq('the second approver can read their own inbox', secondInbox.status, 200);
  eq('the second approver has it too', secondInbox.json?.data?.length, 1);
  const submitterInbox = await call('GET', '/v1/notifications', {
    token: nProviderUser.token, companyId: nProvider,
  });
  eq('the submitter is not told about their own action', submitterInbox.json.data.length, 0);

  // 3 ── Idempotent. Replay the event and drain again.
  await db.query(
    `update delivery_outbox set status = 'PENDING', attempts = 0, delivered_at = null,
       locked_at = null, locked_by = null, available_at = now()
      where idempotency_key = $1`,
    [`work.submitted:${nLogId}`]
  );
  await drainWorkers();
  const afterReplay = await call('GET', '/v1/notifications?filter=open', {
    token: nOwner.token, companyId: nCompany,
  });
  eq('a replayed event produces no second copy', afterReplay.json.data.length, 1);

  const notificationId = ownerInbox.json.data[0].id as string;

  // 4 ── Denied. Another user cannot reach this row by id, at any role.
  const foreignRead = await call('POST', `/v1/notifications/${notificationId}/actions`, {
    token: nSecond.token, companyId: nCompany, body: { verb: 'read' },
  });
  eq("another user's notification is a 404, not a 403", foreignRead.status, 404);

  // 5 ── Delivery evidence: recorded, and honest about not sending.
  const deliveries = await db.query(
    `select channel, status, skip_reason from notification_deliveries
      where notification_id = $1 order by channel`,
    [notificationId]
  );
  check('the intrusive channel attempt is recorded', deliveries.rows.length >= 1, deliveries.rows);
  eq('...as SKIPPED rather than SENT, because nothing is configured',
    deliveries.rows[0]?.status, 'SKIPPED');
  check('...naming why, so a dev environment never looks like a working one',
    /no registered device|no email provider/i.test(deliveries.rows[0]?.skip_reason ?? ''),
    deliveries.rows[0]?.skip_reason);

  // 6 ── Read is not done. Seeing a task does not close it.
  await call('POST', `/v1/notifications/${notificationId}/actions`, {
    token: nOwner.token, companyId: nCompany, body: { verb: 'read' },
  });
  const stillOpen = await call('GET', '/v1/notifications?filter=open', {
    token: nOwner.token, companyId: nCompany,
  });
  eq('a read task is still an open task', stillOpen.json.data.length, 1);
  eq('...in the READ state', stillOpen.json.data[0]?.state, 'READ');

  // 7 ── Resolved by someone else doing the work.
  await call('POST', `/v1/time-logs/${nLogId}/approve`, {
    token: nOwner.token, companyId: nCompany,
  });
  await drainWorkers();
  const secondAfterApproval = await call('GET', '/v1/notifications?filter=open', {
    token: nSecond.token, companyId: nCompany,
  });
  eq("the other approver's task closes itself rather than lying",
    secondAfterApproval.json.data.length, 0);
  const secondAll = await call('GET', '/v1/notifications', {
    token: nSecond.token, companyId: nCompany,
  });
  eq('...as RESOLVED, kept rather than deleted', secondAll.json.data[0]?.state, 'RESOLVED');
  check('...with no resolver named, because they never opened it',
    secondAll.json.data[0]?.resolvedByName === null, secondAll.json.data[0]?.resolvedByName);

  // 8 ── Told. The submitter learns the outcome, with nothing to resolve.
  const submitterAfter = await call('GET', '/v1/notifications', {
    token: nProviderUser.token, companyId: nProvider,
  });
  eq('the submitter is told the outcome', submitterAfter.json.data.length, 1);
  eq('...as news rather than a task', submitterAfter.json.data[0]?.requiresAction, false);
  check('...naming the work it refers to',
    /2026-07-20/.test(submitterAfter.json.data[0]?.body ?? ''),
    submitterAfter.json.data[0]?.body);
  const noticeResolve = await call(
    'POST', `/v1/notifications/${submitterAfter.json.data[0].id}/actions`,
    { token: nProviderUser.token, companyId: nProvider, body: { verb: 'resolve' } }
  );
  eq('a notice cannot be resolved — there is nothing to do', noticeResolve.status, 409);
  check('...and says so', /not a task/i.test(noticeResolve.json?.error?.message ?? ''),
    noticeResolve.json?.error?.message);

  // 9 ── Preferences, and the rule that quiet hours never hide the inbox row.
  const prefs = await call('PUT', '/v1/notification-preferences', {
    token: nOwner.token,
    body: { quietHoursStart: '00:00', quietHoursEnd: '23:59', channels: { 'work.submitted': { push: true } } },
  });
  eq('preferences are saved', prefs.status, 200);
  eq('...with the quiet window recorded', prefs.json.preferences.quietHoursStart, '00:00');
  const halfWindow = await call('PUT', '/v1/notification-preferences', {
    token: nOwner.token, body: { quietHoursStart: '22:00', quietHoursEnd: null },
  });
  eq('half a quiet-hours window is refused', halfWindow.status, 422);

  const quietLog = await call('POST', '/v1/time-logs', {
    token: nProviderUser.token,
    companyId: nProvider,
    body: {
      projectId: nProjectId, roleId: nRoleId, shiftType: 'WEEKDAY_DAY',
      workDate: '2026-07-21', hoursRegular: 4, hoursOt: 0,
    },
  });
  const quietLogId = quietLog.json.timeLog.id as string;
  await call('POST', `/v1/time-logs/${quietLogId}/submit`, {
    token: nProviderUser.token, companyId: nProvider,
  });
  await drainWorkers();
  const quietInbox = await call('GET', '/v1/notifications?filter=open', {
    token: nOwner.token, companyId: nCompany,
  });
  eq('quiet hours do NOT hide the in-product task', quietInbox.json.data.length, 1);
  const deferred = await db.query(
    `select d.deliver_after > now() + interval '1 minute' as deferred
       from notification_deliveries d where d.notification_id = $1`,
    [quietInbox.json.data[0].id]
  );
  check('...they only hold the intrusive channel', deferred.rows[0]?.deferred === true,
    deferred.rows);

  // 10 ── Terminal. Dismiss closes it, and nothing reopens.
  const dismissId = quietInbox.json.data[0].id as string;
  const dismissed = await call('POST', `/v1/notifications/${dismissId}/actions`, {
    token: nOwner.token, companyId: nCompany, body: { verb: 'dismiss' },
  });
  eq('a task can be dismissed', dismissed.json.notification.state, 'DISMISSED');
  const reopen = await call('POST', `/v1/notifications/${dismissId}/actions`, {
    token: nOwner.token, companyId: nCompany, body: { verb: 'resolve' },
  });
  eq('a dismissed task does not reopen', reopen.status, 409);
  const afterDismiss = await call('GET', '/v1/notifications?filter=open', {
    token: nOwner.token, companyId: nCompany,
  });
  eq('...and it is gone from the open list', afterDismiss.json.data.length, 0);

  // 11 ── A malformed payload is permanent, not eight retries and a shrug.
  await db.query(
    `insert into delivery_outbox (topic, aggregate_type, aggregate_id, payload, idempotency_key)
     values ('work.submitted','TIME_LOG',$1,'{}'::jsonb,$2)`,
    [nLogId, `verify-malformed:${RUN}`]
  );
  await drainWorkers();
  const poisoned = await db.query(
    `select status, attempts, last_error from delivery_outbox where idempotency_key = $1`,
    [`verify-malformed:${RUN}`]
  );
  eq('an event that cannot name its recipients dead-letters at once',
    poisoned.rows[0]?.status, 'DEAD_LETTER');
  eq('...on the first attempt, not the eighth', poisoned.rows[0]?.attempts, 1);
  check('...saying what was missing',
    /missing from payload/i.test(poisoned.rows[0]?.last_error ?? ''),
    poisoned.rows[0]?.last_error);

  // 12 ── Digests. `digest` was accepted, stored and ignored: a user could choose
  // "daily" and get an email per event. Packet §6 — batch non-urgent email into
  // one send per window.
  //
  // Deliberately last in this section: it raises two further tasks in the same
  // company, which would otherwise turn an earlier step's "the open list is now
  // empty" into a false failure.
  const digestPrefs = await call('PUT', '/v1/notification-preferences', {
    token: nSecond.token,
    body: {
      digest: 'DAILY',
      quietHoursStart: null,
      quietHoursEnd: null,
      // Email on, so there is something to digest; push on, so the two channels
      // of the same notification can be compared against each other.
      channels: { 'work.submitted': { email: true, push: true } },
    },
  });
  eq('a digest preference is saved', digestPrefs.json.preferences.digest, 'DAILY');

  const digestLog = await call('POST', '/v1/time-logs', {
    token: nProviderUser.token,
    companyId: nProvider,
    body: {
      projectId: nProjectId, roleId: nRoleId, shiftType: 'WEEKDAY_DAY',
      workDate: '2026-07-22', hoursRegular: 6, hoursOt: 0,
    },
  });
  const digestLogId = digestLog.json.timeLog.id as string;
  await call('POST', `/v1/time-logs/${digestLogId}/submit`, {
    token: nProviderUser.token, companyId: nProvider,
  });
  await drainWorkers();

  const digestInbox = await call('GET', '/v1/notifications?filter=open', {
    token: nSecond.token, companyId: nCompany,
  });
  check('a digest does NOT hide the in-product task', digestInbox.json.data.length >= 1,
    digestInbox.json.data.length);
  const digestNotificationId = digestInbox.json.data[0].id as string;
  const channels = await db.query<{ channel: string; held: boolean; status: string }>(
    `select channel, deliver_after > now() + interval '1 minute' as held, status
       from notification_deliveries where notification_id = $1 order by channel`,
    [digestNotificationId]
  );
  const emailRow = channels.rows.find((r) => r.channel === 'EMAIL');
  const pushRow = channels.rows.find((r) => r.channel === 'PUSH');
  check('a daily digest holds the email to its window', emailRow?.held === true, channels.rows);
  eq('...so nothing was sent yet', emailRow?.status, 'PENDING');
  // The two channels of one notification legitimately have different due times.
  check('...and does not batch the push, which goes out now', pushRow?.held === false,
    channels.rows);

  // Wind the window back rather than waiting for it: what is under test is that
  // the batch is drained as one message, not how long the clock takes.
  const digestSecond = await call('POST', '/v1/time-logs', {
    token: nProviderUser.token,
    companyId: nProvider,
    body: {
      projectId: nProjectId, roleId: nRoleId, shiftType: 'WEEKDAY_DAY',
      workDate: '2026-07-23', hoursRegular: 2, hoursOt: 0,
    },
  });
  await call('POST', `/v1/time-logs/${digestSecond.json.timeLog.id}/submit`, {
    token: nProviderUser.token, companyId: nProvider,
  });
  await drainWorkers();
  const heldEmails = await db.query<{ n: string }>(
    `update notification_deliveries d set deliver_after = now() - interval '1 second'
      from notifications n
     where d.notification_id = n.id and n.recipient_user_id = $1
       and d.channel = 'EMAIL' and d.status = 'PENDING'
     returning d.id as n`,
    [nSecond.userId]
  );
  check('two events are queued for one digest window', heldEmails.rowCount! >= 2,
    heldEmails.rowCount);
  await drainWorkers();
  const drained = await db.query<{ status: string; skip_reason: string | null }>(
    `select d.status, d.skip_reason from notification_deliveries d
       join notifications n on n.id = d.notification_id
      where n.recipient_user_id = $1 and d.channel = 'EMAIL'`,
    [nSecond.userId]
  );
  check('the window drains every held email in one pass',
    drained.rows.length >= 2 && drained.rows.every((r) => r.status !== 'PENDING'),
    drained.rows);
  // One provider call covered them all, so every row it covered records the same
  // outcome. With no Resend key configured that outcome is a recorded SKIP, which
  // is the honest state — absence of evidence must never look like success.
  check('...recording one shared outcome rather than one send each',
    new Set(drained.rows.map((r) => `${r.status}:${r.skip_reason ?? ''}`)).size === 1,
    drained.rows);


  // ── Time zones (§42) ──────────────────────────────────────────────────────
  // docs/operating-model/time.md §12, implemented. The bug this section exists
  // for: `todayIso()` returned the SERVER's UTC date and the §3.3.1 back-dating
  // safeguard keyed off it, so the rule was wrong in both directions at
  // different hours depending on the customer's zone.
  section('Time zones — whose day is it');

  const tzOwner = await register('tz-owner', `Meridian Manila ${RUN}`);
  const tzCompany = tzOwner.companyId!;
  await subscribe(tzCompany, 'pro');

  // 1 ── Empty: an existing company reads as UTC and behaves exactly as before.
  const tzDefault = await call('GET', `/v1/companies/${tzCompany}`, {
    token: tzOwner.token, companyId: tzCompany,
  });
  eq('a company defaults to UTC', tzDefault.json.company.timeZone, 'UTC');

  // 2 ── Denied before allowed, so the role rule is genuinely what is tested.
  const tzMemberInvite = await call('POST', '/v1/members/invite', {
    token: tzOwner.token,
    companyId: tzCompany,
    body: { email: `tzmember+${RUN}@verify.crewquo.test`, role: 'MEMBER' },
  });
  eq('a MEMBER is invited', tzMemberInvite.status, 201);
  const tzMember = await register('tz-member', undefined, `tzmember+${RUN}@verify.crewquo.test`);
  const tzMemberAccept = await call(
    'POST', `/v1/invites/${tzMemberInvite.json.inviteToken}/accept`, { token: tzMember.token }
  );
  eq('...and accepts', tzMemberAccept.status, 201);
  const memberSetsZone = await call('PATCH', `/v1/companies/${tzCompany}`, {
    token: tzMember.token, companyId: tzCompany, body: { timeZone: 'Asia/Manila' },
  });
  eq('a MEMBER cannot change the company time zone', memberSetsZone.status, 403);

  const badZone = await call('PATCH', `/v1/companies/${tzCompany}`, {
    token: tzOwner.token, companyId: tzCompany, body: { timeZone: 'Not/AZone' },
  });
  eq('an invalid IANA zone is refused', badZone.status, 422);

  // 3 ── Set, and audited.
  const setZone = await call('PATCH', `/v1/companies/${tzCompany}`, {
    token: tzOwner.token, companyId: tzCompany, body: { timeZone: 'Asia/Manila' },
  });
  eq('an owner sets the company zone', setZone.json.company.timeZone, 'Asia/Manila');
  const zoneAudit = await db.query(
    `select changes from audit_logs
      where company_id = $1 and action = 'company.updated'
        and changes -> 'timeZone' ->> 'to' = 'Asia/Manila'    `,
    [tzCompany]
  );
  check('...and the change is audited', zoneAudit.rows.length >= 1, zoneAudit.rows.length);

  // 4 ── The bug, asserted in both directions.
  //
  // Rather than wait for an hour when UTC and the company disagree, the company
  // is moved to whichever probe zone is genuinely on a different date from the
  // server right now — reproducing the breaking condition deterministically.
  const dayIn = async (zone: string): Promise<string> => {
    const r = await db.query<{ d: string }>(
      `select to_char(now() at time zone $1, 'YYYY-MM-DD') as d`, [zone]
    );
    return r.rows[0]!.d;
  };
  const serverDay = await dayIn('UTC');
  const manilaDay = await dayIn('Asia/Manila');
  const laDay = await dayIn('America/Los_Angeles');
  const divergent =
    manilaDay !== serverDay ? { zone: 'Asia/Manila', day: manilaDay }
      : laDay !== serverDay ? { zone: 'America/Los_Angeles', day: laDay }
        : null;

  const tzProviderRes = await call('POST', '/v1/providers', {
    token: tzOwner.token,
    companyId: tzCompany,
    body: { name: `Manila Crew ${RUN}`, email: `tzprov+${RUN}@verify.crewquo.test` },
  });
  const tzProviderUser = await register('tz-prov', undefined, `tzprov+${RUN}@verify.crewquo.test`);
  await call('POST', `/v1/invites/${tzProviderRes.json.inviteToken}/accept`, {
    token: tzProviderUser.token,
  });
  const tzEngagement = tzProviderRes.json.provider.engagementId as string;
  const tzRole = await call('POST', '/v1/role-catalog', {
    token: tzOwner.token, companyId: tzCompany, body: { name: `Scaffolder ${RUN}` },
  });
  const tzRoleId = tzRole.json.role.id as string;

  const scheduleOn = (effectiveFrom: string, label: string) =>
    call('POST', `/v1/commercial-agreements/${tzEngagement}/schedule`, {
      token: tzOwner.token,
      companyId: tzCompany,
      body: {
        effectiveFrom,
        note: label,
        lines: [{
          operation: 'CREATE', roleId: tzRoleId, rateLabel: 'MON_FRI_DAY',
          rateMode: 'HOURLY', hourlyRateCents: 5000,
        }],
      },
    });

  if (divergent) {
    await call('PATCH', `/v1/companies/${tzCompany}`, {
      token: tzOwner.token, companyId: tzCompany, body: { timeZone: divergent.zone },
    });
    // Today for the *company* is not today for the server. The old code judged
    // this by the server's date and got it wrong.
    const startsToday = await scheduleOn(divergent.day, 'starts today, locally');
    eq(`a schedule starting today in ${divergent.zone} is not retroactive`,
      startsToday.status, 201);
  } else {
    check('server and both probe zones share a date right now, so the divergent ' +
      'case is not reproducible on this run', true, { serverDay, manilaDay, laDay });
  }

  // The other direction holds at every hour: genuinely yesterday is back-dated.
  const companyDay = await dayIn('Asia/Manila');
  await call('PATCH', `/v1/companies/${tzCompany}`, {
    token: tzOwner.token, companyId: tzCompany, body: { timeZone: 'Asia/Manila' },
  });
  const yesterday = new Date(new Date(`${companyDay}T00:00:00Z`).getTime() - 86_400_000)
    .toISOString().slice(0, 10);
  const backDated = await scheduleOn(yesterday, 'starts yesterday, locally');
  eq('a schedule starting yesterday in the company zone still needs a reason',
    backDated.status, 422);

  // 5 ── Nothing moved. A zone change is presentation, never a migration.
  const storedBefore = await db.query(
    `select id, name, created_at from companies where id = $1`, [tzCompany]
  );
  await call('PATCH', `/v1/companies/${tzCompany}`, {
    token: tzOwner.token, companyId: tzCompany, body: { timeZone: 'Pacific/Kiritimati' },
  });
  const storedAfter = await db.query(
    `select id, name, created_at from companies where id = $1`, [tzCompany]
  );
  eq('changing the zone moves no stored instant',
    JSON.stringify(storedAfter.rows), JSON.stringify(storedBefore.rows));

  // 6 ── Project override: null inherits, a value wins, and it round-trips.
  const tzProject = await call('POST', '/v1/projects', {
    token: tzOwner.token, companyId: tzCompany, body: { name: `Dubai tower ${RUN}` },
  });
  eq('a project inherits the company zone rather than copying it',
    tzProject.json.project.timeZone, null);
  const tzProjectId = tzProject.json.project.id as string;
  const overridden = await call('PATCH', `/v1/projects/${tzProjectId}`, {
    token: tzOwner.token, companyId: tzCompany, body: { timeZone: 'Asia/Dubai' },
  });
  eq('a project may report in its own zone', overridden.json.project.timeZone, 'Asia/Dubai');
  const badProjectZone = await call('PATCH', `/v1/projects/${tzProjectId}`, {
    token: tzOwner.token, companyId: tzCompany, body: { timeZone: 'Not/AZone' },
  });
  eq('...but not an invented one', badProjectZone.status, 422);
  const backToInherit = await call('PATCH', `/v1/projects/${tzProjectId}`, {
    token: tzOwner.token, companyId: tzCompany, body: { timeZone: null },
  });
  eq('...and can go back to inheriting', backToInherit.json.project.timeZone, null);

  // 6a ── The override has a reader. A stored setting nothing consults is an
  // invented shape (§0 rule 3): `effectiveTimeZone` is what every consumer reads,
  // and it resolves the inheritance rather than making each caller do it.
  eq('an inheriting project reports the company zone as its effective one',
    backToInherit.json.project.effectiveTimeZone, 'Pacific/Kiritimati');
  const overriddenAgain = await call('PATCH', `/v1/projects/${tzProjectId}`, {
    token: tzOwner.token, companyId: tzCompany, body: { timeZone: 'Asia/Dubai' },
  });
  eq('...and an overriding project reports its own',
    overriddenAgain.json.project.effectiveTimeZone, 'Asia/Dubai');
  // Inheritance is live, not copied: moving the company moves every project that
  // never overrode it. A project that snapshotted the zone at creation would
  // silently stop tracking the business it belongs to.
  await call('PATCH', `/v1/companies/${tzCompany}`, {
    token: tzOwner.token, companyId: tzCompany, body: { timeZone: 'Asia/Manila' },
  });
  const inheritor = await call('POST', '/v1/projects', {
    token: tzOwner.token, companyId: tzCompany, body: { name: `Inheritor ${RUN}` },
  });
  eq('a project with no override follows the company when the company moves',
    inheritor.json.project.effectiveTimeZone, 'Asia/Manila');

  // 6b ── Only an owner or admin, per the packet's §4 matrix. Denied before
  // allowed, so the role rule is genuinely what is under test.
  const tzManagerInvite = await call('POST', '/v1/members/invite', {
    token: tzOwner.token,
    companyId: tzCompany,
    body: { email: `tzmanager+${RUN}@verify.crewquo.test`, role: 'MANAGER' },
  });
  const tzManager = await register('tz-manager', undefined, `tzmanager+${RUN}@verify.crewquo.test`);
  await call('POST', `/v1/invites/${tzManagerInvite.json.inviteToken}/accept`, {
    token: tzManager.token,
  });
  const managerSetsZone = await call('PATCH', `/v1/projects/${tzProjectId}`, {
    token: tzManager.token, companyId: tzCompany, body: { timeZone: 'Europe/London' },
  });
  eq("a MANAGER cannot change a project's time zone", managerSetsZone.status, 403);
  const managerRenames = await call('PATCH', `/v1/projects/${tzProjectId}`, {
    token: tzManager.token, companyId: tzCompany, body: { name: `Dubai tower B ${RUN}` },
  });
  eq('...but can still edit the rest of the project', managerRenames.status, 200);

  // 6c ── The provider's log screen is told the *project's* zone, not its own and
  // not the device's. This is the whole reason a project zone exists: a Manila
  // crew on a Dubai project asserts a Dubai day.
  const tzProviderCompany = tzProviderRes.json.provider.providerCompanyId as string;
  await call('POST', `/v1/projects/${tzProjectId}/assignments`, {
    token: tzOwner.token, companyId: tzCompany,
    body: { providerCompanyId: tzProviderCompany },
  });
  const workCtx = await call('GET', '/v1/work-context', {
    token: tzProviderUser.token, companyId: tzProviderCompany,
  });
  const dubaiAssignment = (workCtx.json.assignments as { projectId: string; timeZone: string }[])
    .find((a) => a.projectId === tzProjectId);
  eq("the work context carries the project's zone, not the provider's",
    dubaiAssignment?.timeZone, 'Asia/Dubai');

  // 6d ── The pin. An empty project may change zone; one holding approved work
  // may not, because re-bucketing a committed day restates history.
  const tzYesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  await call('POST', `/v1/commercial-agreements/${tzEngagement}/schedule`, {
    token: tzOwner.token,
    companyId: tzCompany,
    body: {
      effectiveFrom: tzYesterday,
      retroactiveReason: 'Rates agreed before the project was set up in CrewQuo',
      lines: [{
        operation: 'CREATE', roleId: tzRoleId, rateLabel: 'MON_FRI_DAY',
        rateMode: 'HOURLY', hourlyRateCents: 5000,
      }],
    },
  });
  const pinLog = await call('POST', '/v1/time-logs', {
    token: tzProviderUser.token,
    companyId: tzProviderCompany,
    body: {
      projectId: tzProjectId, roleId: tzRoleId, shiftType: 'WEEKDAY_DAY',
      workDate: tzYesterday, hoursRegular: 8, hoursOt: 0,
    },
  });
  const pinLogId = pinLog.json.timeLog.id as string;
  await call('POST', `/v1/time-logs/${pinLogId}/submit`, {
    token: tzProviderUser.token, companyId: tzProviderCompany,
  });
  await call('POST', `/v1/time-logs/${pinLogId}/approve`, {
    token: tzOwner.token, companyId: tzCompany,
  });
  const pinnedZone = await call('PATCH', `/v1/projects/${tzProjectId}`, {
    token: tzOwner.token, companyId: tzCompany, body: { timeZone: 'Europe/London' },
  });
  eq('a project holding approved work refuses a zone change', pinnedZone.status, 409);
  check('...naming what pins it',
    /1 approved time log/.test(pinnedZone.json?.error?.message ?? ''),
    pinnedZone.json);
  const stillDubai = await call('GET', `/v1/projects/${tzProjectId}`, {
    token: tzOwner.token, companyId: tzCompany,
  });
  eq('...and the zone is unchanged', stillDubai.json.project.timeZone, 'Asia/Dubai');
  // A no-op is still allowed through, or a client PATCHing the whole form back
  // would be unable to edit anything else on a pinned project.
  const noOpZone = await call('PATCH', `/v1/projects/${tzProjectId}`, {
    token: tzOwner.token, companyId: tzCompany,
    body: { timeZone: 'Asia/Dubai', notes: 'Pinned, but still editable' },
  });
  eq('re-sending the same zone on a pinned project is not a refusal', noOpZone.status, 200);
  eq('...and the rest of the form still saves', noOpZone.json.project.notes,
    'Pinned, but still editable');
  // Nothing moved: the refused change left the committed work exactly where it was.
  const pinnedLog = await db.query(
    `select to_char(work_date, 'YYYY-MM-DD') as d from time_logs where id = $1`, [pinLogId]
  );
  eq('a refused zone change moves no stored work date', pinnedLog.rows[0]?.d, tzYesterday);

  // 7 ── The database validates against its own IANA list, not a pattern, so a
  // route that ever forgets to validate still cannot store a broken zone.
  let dbRejectedZone = false;
  try {
    await db.query(`update companies set time_zone = 'Not/AZone' where id = $1`, [tzCompany]);
  } catch {
    dbRejectedZone = true;
  }
  check('the database refuses an unknown zone independently of the route', dbRejectedZone);

  // ── Access hardening (§42) ────────────────────────────────────────────────
  // docs/operating-model/access.md §12. The hole this section exists for:
  // POST /v1/auth/login had no rate limit of any kind, against a population of
  // accounts that all have exactly one factor — and login answered an unknown
  // address in milliseconds while taking most of a second for a known one, which
  // is an account-existence oracle with a hundredfold signal.
  // ── The client's copy of "whose day is it" (2026-08-20) ────────────────────
  //
  // The zone was authoritative on the server and absent from every payload a screen
  // reads, so the commercial screen computed the back-dating predicate from the
  // *browser's* date while the API computed it from the hiring company's. Same
  // function, different "today", and for a reviewer one continent away they disagree
  // for as many hours as the offset. These assertions are the wire half of that fix;
  // the browser suite asserts the screen half with a deliberately mismatched viewer.
  section('Time zones — the client is told whose day it is');

  const zoneClientOwner = await register('zone-client', `Zone Client Ltd ${RUN}`);
  const zoneClientCo = zoneClientOwner.companyId as string;
  await call('PATCH', `/v1/companies/${zoneClientCo}`, {
    token: zoneClientOwner.token,
    companyId: zoneClientCo,
    body: { timeZone: 'Asia/Manila' },
  });

  const memberships = await call('GET', '/v1/me/memberships', { token: zoneClientOwner.token });
  const zoneMembership = (memberships.json?.memberships ?? []).find(
    (m: any) => m.companyId === zoneClientCo
  );
  eq('the switcher payload carries the company zone', zoneMembership?.timeZone, 'Asia/Manila');

  const workspaces = await call('GET', '/v1/me/workspaces', { token: zoneClientOwner.token });
  const zoneWorkspace = (workspaces.json?.workspaces ?? []).find(
    (w: any) => w.companyId === zoneClientCo
  );
  // Two producers of the same shape, so both are asserted. The type-checker caught
  // this one when the field was added; nothing would have caught it drifting later.
  eq('...and so does the workspace payload', zoneWorkspace?.timeZone, 'Asia/Manila');

  // A company that has never set a zone reads as UTC rather than as null, because a
  // screen cannot format a date in `null` and would quietly fall back to the browser
  // — which is the whole failure being closed here.
  const noZoneOwner = await register('zone-default', `Zone Default Ltd ${RUN}`);
  const noZoneMemberships = await call('GET', '/v1/me/memberships', { token: noZoneOwner.token });
  eq('an unset zone reads as UTC, not null',
    (noZoneMemberships.json?.memberships ?? [])[0]?.timeZone, 'UTC');

  /*
   * And the agreement payload states the date the rule will actually be judged
   * against. The provider side is the reason this is a field rather than something
   * the screen derives: a provider proposing a PAY schedule is judged by the hiring
   * company's calendar, does not know the hiring company's zone, and should not be
   * told it. A date is the narrower disclosure and the only part the rule needs.
   */
  const zoneProvider = await register('zone-provider', `Zone Provider Ltd ${RUN}`);
  await subscribe(zoneClientCo, 'pro');
  const zoneEngagement = await call('POST', '/v1/providers', {
    token: zoneClientOwner.token,
    companyId: zoneClientCo,
    body: { name: `Zone Provider Ltd ${RUN}`, email: zoneProvider.email },
  });
  eq('a zone-test engagement is created', zoneEngagement.status, 201);
  const zoneEdge = zoneEngagement.json?.provider?.engagementId as string;
  const agreement = await call('GET', `/v1/commercial-agreements/${zoneEdge}`, {
    token: zoneClientOwner.token,
    companyId: zoneClientCo,
  });
  const manilaToday = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Manila',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
  eq('the agreement states the hiring company own today, not the server UTC date',
    agreement.json?.agreement?.hiringToday, manilaToday);

  section('Access hardening — the front door');

  await clearAuthAttempts();

  const rlUser = await register('rl-user', `Lockout Ltd ${RUN}`);
  const rlEmail = rlUser.email;

  // 1 ── Not an oracle. The bodies already matched; the *timings* did not.
  const timedLogin = async (email: string): Promise<{ status: number; ms: number }> => {
    const started = Date.now();
    const res = await call('POST', '/v1/auth/login', {
      body: { email, password: 'definitely-not-the-password' },
    });
    return { status: res.status, ms: Date.now() - started };
  };
  const knownAddress = await timedLogin(rlEmail);
  const unknownAddress = await timedLogin(`nobody-${RUN}@verify.crewquo.test`);
  eq('a wrong password for a real account is refused', knownAddress.status, 401);
  eq('...and an unknown address is refused identically', unknownAddress.status, 401);
  // bcrypt at cost 12 runs ~0.5-1s here, so the old code differed by two orders of
  // magnitude. A generous ratio still catches that; a tight one would flake on a
  // loaded machine, which is worse than not asserting at all.
  const slowest = Math.max(knownAddress.ms, unknownAddress.ms);
  const fastest = Math.max(1, Math.min(knownAddress.ms, unknownAddress.ms));
  check('...and takes comparable time, so the clock is not an oracle either',
    slowest / fastest < 4,
    { knownMs: knownAddress.ms, unknownMs: unknownAddress.ms });

  // 2 ── Limited. The identity budget is 10 failures in 15 minutes; one is
  // already spent above, so the run below reaches it.
  let rlRefusal: { status: number; json: any } | null = null;
  for (let attempt = 0; attempt < 14; attempt += 1) {
    const res = await call('POST', '/v1/auth/login', {
      body: { email: rlEmail, password: `wrong-${attempt}` },
    });
    if (res.status === 429) { rlRefusal = res; break; }
  }
  check('repeated wrong passwords are eventually rate-limited', rlRefusal !== null);
  eq('...with 429, not a generic failure', rlRefusal?.status, 429);
  check('...naming how long to wait',
    typeof rlRefusal?.json?.error?.details?.retryAfterSeconds === 'number',
    rlRefusal?.json?.error);

  // 3 ── The refusal is not an oracle either. A limiter that says "too many
  // attempts for this account" is a better account-existence oracle than the
  // endpoint it was added to protect.
  const refusalText = String(rlRefusal?.json?.error?.message ?? '').toLowerCase();
  check('...and says nothing about whether the account exists',
    !['account', 'user', 'email', 'address', 'exists', 'password'].some((word) =>
      refusalText.includes(word)),
    refusalText);

  // 4 ── A correct password is refused too while the budget is spent. Anything
  // else makes the limiter a formality an attacker simply outlasts.
  const correctWhileLocked = await call('POST', '/v1/auth/login', {
    body: { email: rlEmail, password: 'Verify-passw0rd!' },
  });
  eq('even the right password is refused while locked out', correctWhileLocked.status, 429);

  // 5 ── Recorded, and nothing about the secret is stored with it.
  const rlAttempts = await db.query<{ succeeded: boolean; n: string }>(
    `select succeeded, count(*)::text as n from auth_attempts
      where scope = 'LOGIN' and identity_key = $1 group by succeeded`,
    [rlEmail.toLowerCase()]
  );
  const rlFailures = Number(rlAttempts.rows.find((r) => r.succeeded === false)?.n ?? 0);
  check('every failed attempt is recorded', rlFailures >= 10, rlAttempts.rows);
  const attemptColumns = await db.query<{ column_name: string }>(
    `select column_name from information_schema.columns where table_name = 'auth_attempts'`
  );
  check('...and the table holds nothing derived from the password',
    attemptColumns.rows.every((r) => !/pass|secret|credential/i.test(r.column_name)),
    attemptColumns.rows.map((r) => r.column_name));

  // 6 ── The lockout told the holder once, not once per attempt — an alert per
  // attempt would turn the sign-in form into a mail bomb aimed at any address.
  const lockoutAudit = await db.query<{ n: string }>(
    `select count(*)::text as n from platform_audit_logs
      where action = 'auth.lockout' and entity_id = $1`,
    [rlUser.userId]
  );
  eq('a lockout is recorded once, not once per attempt', lockoutAudit.rows[0]?.n, '1');

  // 7 ── Not a weapon. Locking one address must not lock another, or the limiter
  // is a denial-of-service anybody can aim at anybody.
  const bystander = await register('rl-bystander', `Bystander ${RUN}`);
  const bystanderLogin = await call('POST', '/v1/auth/login', {
    body: { email: bystander.email, password: 'Verify-passw0rd!' },
  });
  eq('another account signs in normally while the first is locked out',
    bystanderLogin.status, 200);

  // 8 ── Reset is limited per address, because the abuse there is mail-bombing an
  // inbox rather than guessing a secret.
  let resetRefused = 0;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const res = await call('POST', '/v1/auth/request-password-reset', {
      body: { email: bystander.email },
    });
    if (res.status === 429) resetRefused += 1;
  }
  check('password-reset requests are rate-limited per address', resetRefused > 0, resetRefused);

  // 9 ── Security headers on every response.
  const headerProbe = await call('GET', '/healthz');
  for (const [header, expected] of [
    ['x-content-type-options', 'nosniff'],
    ['x-frame-options', 'DENY'],
    ['referrer-policy', 'no-referrer'],
    ['cache-control', 'no-store'],
  ] as const) {
    eq(`every response carries ${header}`, headerProbe.headers.get(header), expected);
  }
  check('...and does not advertise the framework',
    headerProbe.headers.get('x-powered-by') === null);

  // 10 ── CORS is an allowlist, not a mirror. The bare `cors()` this replaced
  // reflected whatever Origin it was sent, so any page a signed-in user visited
  // could call this API with their bearer token.
  const evilOrigin = await fetch(`${BASE}/healthz`, {
    headers: { origin: 'https://evil.example' },
  });
  eq('an unknown origin is not reflected back',
    evilOrigin.headers.get('access-control-allow-origin'), null);
  const appOrigin = await fetch(`${BASE}/healthz`, {
    headers: { origin: env.APP_BASE_URL },
  });
  eq('...while the app origin is allowed',
    appOrigin.headers.get('access-control-allow-origin'), env.APP_BASE_URL);

  // `localhost` and `127.0.0.1` are the same server. The browser suite binds the
  // second and `APP_BASE_URL` names the first, so without this the allowlist would
  // reject the whole web app on a spelling — which it did, once, before this line.
  const sibling = env.APP_BASE_URL.includes('//localhost')
    ? env.APP_BASE_URL.replace('//localhost', '//127.0.0.1')
    : env.APP_BASE_URL.replace('//127.0.0.1', '//localhost');
  if (sibling !== env.APP_BASE_URL) {
    const loopback = await fetch(`${BASE}/healthz`, { headers: { origin: sibling } });
    eq('...and so is the other spelling of the same loopback host',
      loopback.headers.get('access-control-allow-origin'), sibling);
  }

  // ── Sessions, rotation & reuse detection (§42) ────────────────────────────
  // docs/operating-model/access.md §12, items 4 and 8–9. Rotation already worked
  // before this slice; what did not exist was *detection*. Replaying a retired
  // token returned the same 401 an expired one does, and the legitimate session
  // carried on — so the strongest theft signal the product could have was thrown
  // away as a routine failure.
  section('Access hardening — the session, and the token that came back twice');

  // The front-door section above just spent most of the source budget on purpose.
  await clearAuthAttempts();

  const sessUser = await register('sess-user', `Sessions Ltd ${RUN}`);

  const signIn = async (userAgent?: string) => {
    const res = await fetch(`${BASE}/v1/auth/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(userAgent ? { 'user-agent': userAgent } : {}),
      },
      body: JSON.stringify({ email: sessUser.email, password: 'Verify-passw0rd!' }),
    });
    const json = (await res.json()) as any;
    return {
      status: res.status,
      access: json?.tokens?.accessToken as string,
      refresh: json?.tokens?.refreshToken as string,
    };
  };

  // 1 ── A sign-in opens one session, and the device label is coarse.
  const laptop = await signIn(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/141.0.7390.55 Safari/537.36'
  );
  eq('signing in succeeds', laptop.status, 200);
  const sessList1 = await call('GET', '/v1/me/sessions', { token: laptop.access });
  // Two, not one: registering signed this account in as well, and that sign-in is
  // a device like any other. A registration that opened no session would mean the
  // tokens it hands back belong to nothing anybody can see or end.
  eq('the sign-in is its own session, beside the one registration opened',
    sessList1.json?.sessions?.length, 2);
  const laptopSession = sessList1.json?.sessions?.find((s: any) => s.current);
  eq('...labelled from the User-Agent family and nothing finer',
    laptopSession?.deviceLabel, 'Chrome on Windows');
  check('...and the label carries no version or build number',
    !/[0-9]/.test(String(laptopSession?.deviceLabel ?? '')),
    laptopSession?.deviceLabel);
  eq('...marked as the caller own device', laptopSession?.current, true);
  eq('...and ACTIVE', laptopSession?.state, 'ACTIVE');
  const laptopSessionId = laptopSession?.id as string;

  // A caller whose User-Agent names nothing recognisable gets no label rather than
  // a guessed one — inventing "Unknown browser on Unknown OS" would read as a
  // device the holder does not own, which is the false alarm this list must not
  // raise. (`fetch` sends `node`, which matches none of the families.)
  const anonymousClient = await signIn();
  const sessList2 = await call('GET', '/v1/me/sessions', { token: anonymousClient.access });
  const unlabelled = sessList2.json?.sessions?.find((s: any) => s.current);
  eq('an unrecognised client gets a null label, not a guess', unlabelled?.deviceLabel, null);
  eq('...and each sign-in is a session of its own', sessList2.json?.sessions?.length, 3);

  // 2 ── Rotation: the successor works and the predecessor is retired, with the
  // lineage that made "revoke the family" expressible in the first place.
  const rotated = await call('POST', '/v1/auth/refresh', {
    body: { refreshToken: laptop.refresh },
  });
  eq('a refresh token exchanges for a successor', rotated.status, 200);
  check('...which is a different string',
    rotated.json?.tokens?.refreshToken !== laptop.refresh);
  const lineage = await db.query<{ n: string; parents: string }>(
    `select count(*)::text as n, count(parent_id)::text as parents
       from refresh_tokens where session_id = $1`,
    [laptopSessionId]
  );
  eq('...recorded as a lineage rather than an unrelated row', lineage.rows[0]?.n, '2');
  eq('...with the successor naming its predecessor', lineage.rows[0]?.parents, '1');

  // 3 ── The grace window. Two devices refreshing at once is a phone waking while
  // a laptop polls — and this product's own web app does it on every sign-in that
  // crosses a route group. Without the window, that ordinary race would revoke the
  // family and sign people out at random, which is how an alarm gets ignored.
  const graceUse = await call('POST', '/v1/auth/refresh', {
    body: { refreshToken: laptop.refresh },
  });
  eq('the same token inside the grace window rotates again rather than raising the alarm',
    graceUse.status, 200);
  const stillLive = await db.query<{ n: string }>(
    `select count(*)::text as n from auth_sessions where id = $1 and revoked_at is null`,
    [laptopSessionId]
  );
  eq('...and the session is untouched', stillLive.rows[0]?.n, '1');

  // 4 ── Reuse. Ageing the rotation past the window is deterministic; waiting
  // thirty seconds in a test suite is not, and a test that sleeps is a test that
  // eventually gets deleted.
  await db.query(
    `update refresh_tokens set rotated_at = now() - interval '10 minutes' where token_hash = $1`,
    [createHash('sha256').update(laptop.refresh).digest('hex')]
  );

  const reuse = await call('POST', '/v1/auth/refresh', {
    body: { refreshToken: laptop.refresh },
  });
  eq('a retired token replayed after the window is refused', reuse.status, 401);
  const reuseText = String(reuse.json?.error?.message ?? '').toLowerCase();
  check('...without telling whoever holds it which failure it was',
    !['reuse', 'reused', 'twice', 'revoked', 'already'].some((w) => reuseText.includes(w)),
    reuseText);

  const familyGone = await db.query<{ revoked_cause: string; live_tokens: string }>(
    `select s.revoked_cause,
            (select count(*)::text from refresh_tokens t
              where t.session_id = s.id and t.revoked_at is null) as live_tokens
       from auth_sessions s where s.id = $1`,
    [laptopSessionId]
  );
  eq('the whole family is revoked, not just the token presented',
    familyGone.rows[0]?.revoked_cause, 'TOKEN_REUSE');
  eq('...leaving no live token in it', familyGone.rows[0]?.live_tokens, '0');

  // The successor the legitimate device holds dies with the family. That is the
  // intended cost: the product cannot tell which presentation was the real one —
  // the thief may well have refreshed first — so it stops trusting both.
  const victimAfter = await call('POST', '/v1/auth/refresh', {
    body: { refreshToken: rotated.json?.tokens?.refreshToken },
  });
  eq('the legitimate successor is dead too', victimAfter.status, 401);

  // A later replay of the same stolen token must not raise a second alarm. One
  // theft, one alert: the branch that makes that true is "a revoked session is
  // DEAD before rotation is even considered".
  const replayAgain = await call('POST', '/v1/auth/refresh', {
    body: { refreshToken: laptop.refresh },
  });
  eq('a further replay is simply dead', replayAgain.status, 401);

  // 5 ── Recorded as evidence, and told to the holder durably.
  const reuseAudit = await db.query<{ n: string }>(
    `select count(*)::text as n from platform_audit_logs
      where action = 'auth.token_reuse' and entity_id = $1`,
    [sessUser.userId]
  );
  eq('the reuse is platform-audited once, not once per replay', reuseAudit.rows[0]?.n, '1');

  await drainWorkers();
  const reuseNotice = await db.query<{ n: string; company_id: string | null; urgency: string }>(
    `select count(*)::text as n, min(company_id::text) as company_id, min(urgency) as urgency
       from notifications
      where recipient_user_id = $1 and kind = 'auth.token_reuse'`,
    [sessUser.userId]
  );
  eq('the holder gets one durable notification', reuseNotice.rows[0]?.n, '1');
  eq('...account-scoped rather than pinned to one of their companies',
    reuseNotice.rows[0]?.company_id, null);
  eq('...and urgent, which is the exception this domain earns',
    reuseNotice.rows[0]?.urgency, 'URGENT');
  const reuseEmail = await db.query<{ n: string }>(
    `select count(*)::text as n from notification_deliveries d
       join notifications n on n.id = d.notification_id
      where n.recipient_user_id = $1 and n.kind = 'auth.token_reuse' and d.channel = 'EMAIL'`,
    [sessUser.userId]
  );
  eq('...with an email queued through the durable path', reuseEmail.rows[0]?.n, '1');

  // 6 ── Ending a session is immediate, not eventual. The packet's honest bound was
  // the device's next refresh — up to a whole access-token lifetime of a lost phone
  // still working — and one indexed read in the middleware closes it.
  const phone = await signIn('Mozilla/5.0 (iPhone; CPU iPhone OS 18_2 like Mac OS X) Safari/604.1');
  const desktop = await signIn(
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1 Version/17 Safari/605.1'
  );
  const beforeEnd = await call('GET', '/v1/me/sessions', { token: desktop.access });
  const phoneSession = beforeEnd.json?.sessions?.find(
    (s: any) => s.deviceLabel === 'Safari on iOS' && s.state === 'ACTIVE'
  );
  check('the phone is listed from the desktop', Boolean(phoneSession), beforeEnd.json);
  eq('...and the desktop knows which row is itself',
    beforeEnd.json?.sessions?.filter((s: any) => s.current).length, 1);

  const phoneStillWorks = await call('GET', '/v1/me', { token: phone.access });
  eq('the phone works before it is ended', phoneStillWorks.status, 200);
  const ending = await call('DELETE', `/v1/me/sessions/${phoneSession?.id}`, {
    token: desktop.access,
  });
  eq('ending the phone succeeds', ending.status, 200);
  const phoneAccessAfter = await call('GET', '/v1/me', { token: phone.access });
  eq('...and its unexpired access token stops working at once', phoneAccessAfter.status, 401);
  const phoneRefreshAfter = await call('POST', '/v1/auth/refresh', {
    body: { refreshToken: phone.refresh },
  });
  eq('...as does its next refresh', phoneRefreshAfter.status, 401);

  const endedRow = await db.query<{ revoked_cause: string }>(
    `select revoked_cause from auth_sessions where id = $1`,
    [phoneSession?.id]
  );
  eq('...recorded as the holder ending it, not as something unexplained',
    endedRow.rows[0]?.revoked_cause, 'ENDED_BY_USER');

  // 7 ── Somebody else's session is a 404, never a 403. A 403 would confirm the id
  // names something real, which is a fact about another account.
  const stranger = await register('sess-stranger');
  const strangerList = await call('GET', '/v1/me/sessions', { token: stranger.token });
  const strangerSession = strangerList.json?.sessions?.[0]?.id;
  const crossTenant = await call('DELETE', `/v1/me/sessions/${strangerSession}`, {
    token: desktop.access,
  });
  eq('another user session id is a 404', crossTenant.status, 404);
  const malformedSession = await call('DELETE', '/v1/me/sessions/not-a-uuid', {
    token: desktop.access,
  });
  eq('...and so is a malformed one, rather than a 500', malformedSession.status, 404);
  const strangerIntact = await call('GET', '/v1/me', { token: stranger.token });
  eq('...and the stranger session is untouched', strangerIntact.status, 200);

  // 8 ── The panic button keeps the device in your hand.
  const keepMe = await signIn('Mozilla/5.0 (X11; Linux x86_64) Firefox/141.0');
  const endOthers = await call('POST', '/v1/me/sessions/end-others', { token: keepMe.access });
  eq('ending other devices succeeds', endOthers.status, 200);
  check('...and reports how many went', (endOthers.json?.ended ?? 0) >= 1, endOthers.json);
  const mineAfter = await call('GET', '/v1/me', { token: keepMe.access });
  eq('...while the caller own session survives', mineAfter.status, 200);
  const othersAfter = await call('GET', '/v1/me', { token: desktop.access });
  eq('...and the others do not', othersAfter.status, 401);
  const remaining = await call('GET', '/v1/me/sessions', { token: keepMe.access });
  eq('one session is left signed in',
    remaining.json?.sessions?.filter((s: any) => s.state === 'ACTIVE').length, 1);
  check('...and the ended ones are still listed as the forensic tail',
    remaining.json?.sessions?.some((s: any) => s.state === 'REVOKED'), remaining.json);

  // 9 ── Signing out ends the session, not merely the token presented. A revoked
  // token with a live session would leave the device list showing a device that
  // has signed out.
  const goodbye = await signIn('Mozilla/5.0 (Windows NT 10.0) Firefox/141.0');
  await call('POST', '/v1/auth/logout', { body: { refreshToken: goodbye.refresh } });
  const afterLogout = await call('GET', '/v1/me', { token: goodbye.access });
  eq('signing out invalidates the access token too', afterLogout.status, 401);
  const logoutCause = await db.query<{ n: string }>(
    `select count(*)::text as n from auth_sessions
      where user_id = $1 and revoked_cause = 'SIGNED_OUT'`,
    [sessUser.userId]
  );
  check('...and the session is recorded as signed out',
    Number(logoutCause.rows[0]?.n) >= 1, logoutCause.rows[0]);

  // 10 ── A password reset ends every session, and says why. Somebody who resets
  // *because* they suspect a compromise opens the device list next, and needs to
  // see that the thing they hoped for actually happened.
  const resetUser = await register('sess-reset', `Reset Ltd ${RUN}`);
  const resetSignIn = await call('POST', '/v1/auth/login', {
    body: { email: resetUser.email, password: 'Verify-passw0rd!' },
  });
  const resetPurposeToken = signPurposeToken(resetUser.userId, 'password_reset', 600);
  const resetDone = await call('POST', '/v1/auth/reset-password', {
    body: { token: resetPurposeToken, password: 'Verify-passw0rd!2' },
  });
  eq('the password reset succeeds', resetDone.status, 200);
  const afterReset = await call('GET', '/v1/me', {
    token: resetSignIn.json?.tokens?.accessToken,
  });
  eq('...and every session it covered is gone', afterReset.status, 401);
  const resetCause = await db.query<{ n: string }>(
    `select count(*)::text as n from auth_sessions
      where user_id = $1 and revoked_cause = 'PASSWORD_RESET'`,
    [resetUser.userId]
  );
  check('...recorded as the reset rather than as something unexplained',
    Number(resetCause.rows[0]?.n) >= 1, resetCause.rows[0]);

  // 11 ── The operator path (§13.2): reason required, audited, and — new in this
  // slice — the holder is actually told. It revoked and audited before, and the
  // person it happened to was never notified, which made a legitimate support
  // action indistinguishable from a compromise.
  const opsUser = await register('sess-ops', `Operator Target ${RUN}`);
  const opsAdmin = await register('sess-admin', `Platform Staff ${RUN}`);
  await promoteToStaff(opsAdmin);
  const opsSignIn = await call('POST', '/v1/auth/login', {
    body: { email: opsUser.email, password: 'Verify-passw0rd!' },
  });

  const revokeWithoutReason = await call(
    'POST',
    `/v1/admin/users/${opsUser.userId}/revoke-sessions`,
    { token: opsAdmin.token, body: {} }
  );
  eq('an operator cannot revoke without a reason', revokeWithoutReason.status, 422);
  const opsRevoke = await call('POST', `/v1/admin/users/${opsUser.userId}/revoke-sessions`, {
    token: opsAdmin.token,
    body: { reason: 'Customer reported a stolen laptop (verify-e2e)' },
  });
  eq('...and can with one', opsRevoke.status, 200);
  const opsAfter = await call('GET', '/v1/me', { token: opsSignIn.json?.tokens?.accessToken });
  eq('...which ends the sessions immediately', opsAfter.status, 401);

  await drainWorkers();
  const opsNotice = await db.query<{ n: string; body: string | null }>(
    `select count(*)::text as n, min(body) as body from notifications
      where recipient_user_id = $1 and kind = 'auth.session_revoked'`,
    [opsUser.userId]
  );
  eq('the holder is told an operator did it', opsNotice.rows[0]?.n, '1');
  check('...without the operator internal reason being shown to them',
    !String(opsNotice.rows[0]?.body ?? '').includes('stolen laptop'),
    opsNotice.rows[0]?.body);
  const opsAudit = await db.query<{ changes: any }>(
    `select changes from platform_audit_logs
      where action = 'user.sessions_revoked' and entity_id = $1
      order by created_at desc limit 1`,
    [opsUser.userId]
  );
  check('...while the reason is kept as platform evidence',
    String(opsAudit.rows[0]?.changes?.reason ?? '').includes('stolen laptop'),
    opsAudit.rows[0]?.changes);

  // 12 ── No back door (§12.11), asserted as an absence: the operator surface holds
  // aggregates and metadata, and there is no route by which staff read one tenant's
  // records or act as one of its users.
  const opsMetadata = await call('GET', `/v1/admin/users/${opsUser.userId}`, {
    token: opsAdmin.token,
  });
  eq('an operator sees session metadata', opsMetadata.status, 200);
  eq('...as a count, now of sessions rather than tokens',
    opsMetadata.json?.user?.activeSessionCount, 0);
  const impersonation = await call('POST', `/v1/admin/users/${opsUser.userId}/impersonate`, {
    token: opsAdmin.token,
    body: {},
  });
  eq('...and there is no impersonation route to call', impersonation.status, 404);

  // 13 ── Not a weapon (§12.4). An attacker hammering an address must not be able
  // to end a live session on the victim's own device.
  const hammered = await signIn('Mozilla/5.0 (Windows NT 10.0) Firefox/141.0');
  for (let attempt = 0; attempt < 12; attempt += 1) {
    await call('POST', '/v1/auth/login', {
      body: { email: sessUser.email, password: `wrong-${attempt}` },
    });
  }
  const survivor = await call('GET', '/v1/me', { token: hammered.access });
  eq('a locked-out account keeps working on the device already signed in', survivor.status, 200);
  const stillRefreshes = await call('POST', '/v1/auth/refresh', {
    body: { refreshToken: hammered.refresh },
  });
  eq('...and can still rotate its token', stillRefreshes.status, 200);

  // 14 ── The lockout notification finally lands in-product too. 0016 sent the email
  // inline and left a comment saying the inbox row waited on a nullable company
  // column; 0018 widened it, so this is that comment being closed.
  await drainWorkers();
  const lockoutNotice = await db.query<{ n: string; company_id: string | null }>(
    `select count(*)::text as n, min(company_id::text) as company_id from notifications
      where recipient_user_id = $1 and kind = 'auth.lockout'`,
    [sessUser.userId]
  );
  eq('a lockout is now a durable inbox row as well as an email', lockoutNotice.rows[0]?.n, '1');
  eq('...account-scoped, because it happened to a person',
    lockoutNotice.rows[0]?.company_id, null);

  // And it is actually readable. An account-scoped row shows in the holder's inbox
  // whichever company they are viewing — the alternative would hide "somebody signed
  // you out of everything" behind a company switcher, at the exact moment nobody is
  // thinking about which tenant they are looking at.
  const inbox = await call('GET', '/v1/notifications', {
    token: hammered.access,
    companyId: sessUser.companyId ?? undefined,
  });
  const inboxKinds = (inbox.json?.data ?? []).map((n: any) => n.kind);
  check('a security alert is in the inbox while a company is selected',
    inboxKinds.includes('auth.token_reuse') && inboxKinds.includes('auth.lockout'),
    inboxKinds);
  check('...and carries no company, rather than claiming it happened in one',
    (inbox.json?.data ?? [])
      .filter((n: any) => String(n.kind).startsWith('auth.'))
      .every((n: any) => n.companyId === null),
    inbox.json?.data);

  // 15 ── The index that was missing. Every refresh looks a token up by hash, and
  // until 0018 there was no index on `token_hash` at all — a sequential scan of a
  // table that grows with every sign-in of every user on the platform.
  const hashIndex = await db.query<{ indexdef: string }>(
    `select indexdef from pg_indexes
      where tablename = 'refresh_tokens' and indexdef ilike '%token_hash%'`
  );
  check('refresh tokens are looked up through an index', hashIndex.rows.length > 0);
  check('...and it is unique, so a duplicate hash is a bug rather than a coincidence',
    hashIndex.rows.some((r) => r.indexdef.toLowerCase().includes('unique')),
    hashIndex.rows.map((r) => r.indexdef));

  // ── The 401 a client can act on (§9, §12.13) ──────────────────────────────
  // A tab left open past the fifteen-minute access token used to start failing and
  // keep failing until somebody thought to reload — the session was alive the whole
  // time and the client had no path from a 401 back to a working token. It has one
  // now, and this is the signal it steers by.
  section('Access hardening — telling a stale token from a wrong password');

  await clearAuthAttempts();
  const staleUser = await register('stale-token', `Stale Token Ltd ${RUN}`);

  /*
   * 1 ── Every way the *bearer* can be refused says so in the field reserved for it.
   *
   * `WWW-Authenticate` on a 401 is RFC 9110 §11.6.1 and this API had been omitting it
   * on every one, so this is conformance as much as it is a feature. The header is
   * bare on purpose: a `realm` would name a protection space this API does not
   * partition, and RFC 6750's `error="invalid_token"` would put *why* a token failed
   * on the wire — which §9 keeps off it, since "expired" versus "revoked" tells
   * whoever holds a stolen one whether the theft has been noticed.
   */
  const expiredBearer = jwt.sign({ sub: staleUser.userId }, env.JWT_ACCESS_SECRET, {
    algorithm: 'HS256',
    expiresIn: -60,
    keyid: currentAccessKid(),
  });
  for (const [label, token] of [
    ['an expired access token', expiredBearer],
    ['a token signed by nobody we know', jwt.sign({ sub: staleUser.userId }, 'not-our-secret')],
    ['a string that is not a token at all', 'not-a-jwt'],
    ['no bearer at all', undefined],
  ] as [string, string | undefined][]) {
    const res = await call('GET', '/v1/me', token === undefined ? {} : { token });
    eq(`${label} is refused`, res.status, 401);
    eq(`...and says the bearer is what was refused (${label})`,
      res.headers.get('www-authenticate'), 'Bearer');
    check(`...without naming which failure it was (${label})`,
      !/expired|invalid_token|revoked|realm/i.test(res.headers.get('www-authenticate') ?? ''),
      res.headers.get('www-authenticate'));
  }

  // An ended session is the same answer, which is the point: the client retries once,
  // the refresh fails too, and the person is sent to sign in rather than watching a
  // screen fail silently.
  const endedSignIn = await call('POST', '/v1/auth/login', {
    body: { email: staleUser.email, password: 'Verify-passw0rd!' },
  });
  const endedAccess = endedSignIn.json?.tokens?.accessToken as string;
  const ownSessions = await call('GET', '/v1/me/sessions', { token: endedAccess });
  const ownSession = (ownSessions.json?.sessions ?? []).find((x: any) => x.current);
  await call('DELETE', `/v1/me/sessions/${ownSession?.id}`, { token: endedAccess });
  const afterEnded = await call('GET', '/v1/me', { token: endedAccess });
  eq('an access token from an ended session is refused', afterEnded.status, 401);
  eq('...and also names the bearer', afterEnded.headers.get('www-authenticate'), 'Bearer');

  /*
   * 2 ── A 401 that is *not* about the token does not carry it.
   *
   * This is the whole reason the signal exists rather than the client keying on the
   * status alone. Step-up re-authentication (§4) answers a mistyped password with 401
   * too, and a client that treated the two alike would rotate its refresh token over
   * a typo, re-submit the same wrong password to get the same answer, and — if that
   * rotation lost a race — sign the person out of a session that was never in
   * question. It also inverts what step-up is for: proof of a live human, not proof
   * that the client can mint another token.
   */
  const stepUpUser = await register('stale-stepup', `Stale Step Up ${RUN}`);
  // The route refuses in order — staff, allowance, verification, *then* step-up — so
  // an unverified address would be answered by the check above the one under test.
  await db.query(`update users set email_verified_at = now() where id = $1`, [stepUpUser.userId]);
  const wrongStepUp = await call('POST', '/v1/company-creation-requests', {
    token: stepUpUser.token,
    body: {
      legalName: `Second Company ${RUN}`,
      country: 'PH',
      attestation: true,
      password: 'not-the-password',
    },
  });
  eq('a wrong step-up password is refused', wrongStepUp.status, 401);
  eq('...as a 401 about what was typed, not about the token',
    wrongStepUp.headers.get('www-authenticate'), null);
  check('...while the token it arrived with still works',
    (await call('GET', '/v1/me', { token: stepUpUser.token })).status === 200);

  /*
   * 3 ── And the browser can actually read it.
   *
   * `WWW-Authenticate` is not one of the seven response headers script may read by
   * default, so setting it without naming it in `Access-Control-Expose-Headers` would
   * produce exactly the bug this section exists to prevent — correct on the wire,
   * invisible to the only client that needs it, and undetectable from curl.
   */
  const browserOrigin = process.env.APP_BASE_URL ?? 'http://localhost:3000';
  const fromBrowser = await fetch(`${BASE}/v1/me`, {
    headers: { Origin: browserOrigin, Authorization: `Bearer ${expiredBearer}` },
  });
  eq('a browser-origin call is answered', fromBrowser.status, 401);
  check('...and script is allowed to read the header it has to key on',
    (fromBrowser.headers.get('access-control-expose-headers') ?? '')
      .toLowerCase()
      .split(',')
      .map((h) => h.trim())
      .includes('www-authenticate'),
    fromBrowser.headers.get('access-control-expose-headers'));

  // ── Second factors (§42) ──────────────────────────────────────────────────
  // docs/operating-model/access.md §12 items 5–7 and 11. Every account on this
  // platform was a password and nothing else — including the super admins who can
  // read every company on it.
  section('Access hardening — the second factor');

  await clearAuthAttempts();

  const totpCodeFor = (secret: string, offsetSteps = 0): string => {
    const counter = totpCounter(Date.now()) + offsetSteps;
    const digest = new Uint8Array(
      createHmac('sha1', Buffer.from(base32Decode(secret)))
        .update(totpCounterBytes(counter))
        .digest()
    );
    return totpTruncate(digest, 6);
  };

  const mfaUser = await register('mfa-user', `Second Factor Ltd ${RUN}`);

  // 1 ── Empty. The majority of accounts never meet this domain, and on the day it
  // ships nothing changes for them (§12.1).
  const statusBefore = await call('GET', '/v1/me/mfa', { token: mfaUser.token });
  eq('an account with no factor says so', statusBefore.json?.state, 'NONE');
  eq('...and a customer is not required to hold one', statusBefore.json?.required, false);
  const plainLogin = await call('POST', '/v1/auth/login', {
    body: { email: mfaUser.email, password: 'Verify-passw0rd!' },
  });
  check('...and signs in exactly as before', Boolean(plainLogin.json?.tokens), plainLogin.json);

  // 2 ── Enrolled, and incomplete until a code is produced (§12.5). Without the
  // PENDING state a proportion of enrolments strand somebody outside their own
  // account holding a QR code that never scanned properly.
  const enrol = await call('POST', '/v1/me/mfa', { token: mfaUser.token });
  eq('enrolment issues a secret', enrol.status, 201);
  const secret = enrol.json?.secret as string;
  check('...as base32 an authenticator app can take', /^[A-Z2-7]{32}$/.test(secret ?? ''), secret);
  check('...with an otpauth URI naming the issuer twice',
    String(enrol.json?.uri ?? '').includes('otpauth://totp/CrewQuo') &&
      String(enrol.json?.uri ?? '').includes('issuer=CrewQuo'),
    enrol.json?.uri);

  const factorPending = await call('GET', '/v1/me/mfa', { token: mfaUser.token });
  eq('the factor is PENDING until proven', factorPending.json?.state, 'PENDING');
  const stillNoChallenge = await call('POST', '/v1/auth/login', {
    body: { email: mfaUser.email, password: 'Verify-passw0rd!' },
  });
  check('an unfinished enrolment does not stand between somebody and their account',
    Boolean(stillNoChallenge.json?.tokens), stillNoChallenge.json);

  const wrongConfirm = await call('POST', '/v1/me/mfa/confirm', {
    token: mfaUser.token,
    body: { code: '000000' },
  });
  eq('a wrong code does not confirm it', wrongConfirm.status, 422);

  const confirmed = await call('POST', '/v1/me/mfa/confirm', {
    token: mfaUser.token,
    body: { code: totpCodeFor(secret) },
  });
  eq('a correct code confirms it', confirmed.status, 200);
  eq('...and hands over ten recovery codes', confirmed.json?.codes?.length, 10);
  const recoveryCodes = confirmed.json?.codes as string[];
  check('...formatted to be read off paper',
    /^[A-Z2-7]{5}-[A-Z2-7]{5}$/.test(recoveryCodes?.[0] ?? ''), recoveryCodes?.[0]);

  const active = await call('GET', '/v1/me/mfa', { token: mfaUser.token });
  eq('the factor is now ACTIVE', active.json?.state, 'ACTIVE');
  eq('...and the codes are counted', active.json?.recoveryCodesRemaining, 10);

  // 3 ── The secret is never readable again (§2). "Nobody" is load-bearing: this
  // has to be something the product is *unable* to show, not merely careful about.
  const statusFields = JSON.stringify(active.json ?? {});
  check('no endpoint returns the secret back', !statusFields.includes(secret), statusFields);

  // 4 ── Sign-in is now two steps, and the first step mints nothing.
  // Counted either side of the challenge rather than over a time window: earlier
  // steps in this section signed in legitimately, so "sessions in the last five
  // seconds" would be measuring those too.
  const sessionCount = async (): Promise<number> => {
    const { rows } = await db.query<{ n: string }>(
      `select count(*)::text as n from auth_sessions where user_id = $1`,
      [mfaUser.userId]
    );
    return Number(rows[0]?.n ?? 0);
  };
  const sessionsBeforeChallenge = await sessionCount();

  const challenge = await call('POST', '/v1/auth/login', {
    body: { email: mfaUser.email, password: 'Verify-passw0rd!' },
  });
  eq('the password alone no longer signs anybody in', challenge.json?.status, 'mfa_required');
  check('...and issues no tokens at all', challenge.json?.tokens === undefined, challenge.json);
  eq('...while offering recovery honestly', challenge.json?.recoveryAvailable, true);
  const challengeToken = challenge.json?.challengeToken as string;
  eq('...and opens no session while unanswered', await sessionCount(), sessionsBeforeChallenge);

  const wrongCode = await call('POST', '/v1/auth/mfa', {
    body: { challengeToken, code: '000000' },
  });
  eq('a wrong code is refused', wrongCode.status, 401);

  // The confirmation above consumed this counter, so a real sign-in seconds later
  // uses the next code — which the drift window accepts.
  const answered = await call('POST', '/v1/auth/mfa', {
    body: { challengeToken, code: totpCodeFor(secret, 1) },
  });
  eq('a correct code completes the sign-in', answered.status, 200);
  check('...with a real session', Boolean(answered.json?.tokens?.refreshToken), answered.json);

  // 5 ── One code, one login. Without the consumed-counter rule a code stays
  // replayable for its whole 90-second window, and a code read over somebody's
  // shoulder is worth a sign-in rather than nothing.
  const replayed = await call('POST', '/v1/auth/mfa', {
    body: { challengeToken, code: totpCodeFor(secret, 1) },
  });
  eq('the same code cannot be used twice', replayed.status, 401);
  check('...and says so, so nobody retypes it until they are locked out',
    String(replayed.json?.error?.message ?? '').toLowerCase().includes('already been used'),
    replayed.json?.error?.message);

  // 6 ── Recovered (§12.7). A recovery code signs in once, is consumed, and cannot
  // be reused.
  const recoveryChallenge = await call('POST', '/v1/auth/login', {
    body: { email: mfaUser.email, password: 'Verify-passw0rd!' },
  });
  const spent = await call('POST', '/v1/auth/mfa', {
    body: {
      challengeToken: recoveryChallenge.json?.challengeToken,
      recoveryCode: recoveryCodes?.[0],
    },
  });
  eq('a recovery code signs somebody in', spent.status, 200);
  const afterSpend = await call('GET', '/v1/me/mfa', { token: mfaUser.token });
  eq('...and is spent', afterSpend.json?.recoveryCodesRemaining, 9);

  const reuseRecovery = await call('POST', '/v1/auth/login', {
    body: { email: mfaUser.email, password: 'Verify-passw0rd!' },
  });
  const spentTwice = await call('POST', '/v1/auth/mfa', {
    body: {
      challengeToken: reuseRecovery.json?.challengeToken,
      recoveryCode: recoveryCodes?.[0],
    },
  });
  eq('the same recovery code cannot be spent twice', spentTwice.status, 401);
  check('...and tells the holder to try another line rather than that the sheet is wrong',
    String(spentTwice.json?.error?.message ?? '').toLowerCase().includes('already been used'),
    spentTwice.json?.error?.message);

  // Regenerating invalidates the whole previous set (§12.7).
  const regenerated = await call('POST', '/v1/me/mfa/recovery-codes', { token: mfaUser.token });
  eq('regenerating issues a fresh set', regenerated.json?.codes?.length, 10);
  const oldCodeChallenge = await call('POST', '/v1/auth/login', {
    body: { email: mfaUser.email, password: 'Verify-passw0rd!' },
  });
  const oldCode = await call('POST', '/v1/auth/mfa', {
    body: {
      challengeToken: oldCodeChallenge.json?.challengeToken,
      recoveryCode: recoveryCodes?.[1],
    },
  });
  eq('...and every code from the old set stops working', oldCode.status, 401);

  // 7 ── Guessing is budgeted. A six-digit code is a million possibilities and
  // about three are valid at any moment, so an unlimited guesser reaches even odds
  // in minutes of scripted traffic.
  const guessChallenge = await call('POST', '/v1/auth/login', {
    body: { email: mfaUser.email, password: 'Verify-passw0rd!' },
  });
  let codeLimited = 0;
  for (let attempt = 0; attempt < 14; attempt += 1) {
    const res = await call('POST', '/v1/auth/mfa', {
      body: { challengeToken: guessChallenge.json?.challengeToken, code: '111111' },
    });
    if (res.status === 429) codeLimited += 1;
  }
  check('code guessing is rate-limited on its own budget', codeLimited > 0, codeLimited);
  const mfaAttempts = await db.query<{ n: string }>(
    `select count(*)::text as n from auth_attempts where scope = 'MFA'`
  );
  check('...and recorded under its own scope', Number(mfaAttempts.rows[0]?.n) > 0,
    mfaAttempts.rows[0]);

  // 8 ── Denied (§12.6). Removing protection is step-up-gated; adding it never is,
  // because friction on the safe direction is how you get people who never turn it on.
  await clearAuthAttempts();
  const removeBare = await call('DELETE', '/v1/me/mfa', { token: mfaUser.token, body: {} });
  eq('removing without re-authenticating is refused', removeBare.status, 422);
  const removeWrong = await call('DELETE', '/v1/me/mfa', {
    token: mfaUser.token,
    body: { password: 'not-the-password' },
  });
  eq('...and a wrong password does not do it either', removeWrong.status, 401);
  // Not a stale bearer, so no `WWW-Authenticate` — otherwise the web client would
  // refresh its session every time somebody mistyped this field. Asserted here as
  // well as in the section above because this is a second, independent step-up route,
  // and the two must not drift into disagreeing about what a 401 means.
  eq('...and says nothing about the bearer, which was fine',
    removeWrong.headers.get('www-authenticate'), null);
  const stillActive = await call('GET', '/v1/me/mfa', { token: mfaUser.token });
  eq('...so the factor is still there', stillActive.json?.state, 'ACTIVE');

  // 9 ── Told, unconditionally and durably. If it was not you who changed the
  // factor on your account, that email is the only warning you get.
  await drainWorkers();
  const enrolNotice = await db.query<{ n: string; company_id: string | null; urgency: string }>(
    `select count(*)::text as n, min(company_id::text) as company_id, min(urgency) as urgency
       from notifications where recipient_user_id = $1 and kind = 'auth.mfa_enrolled'`,
    [mfaUser.userId]
  );
  eq('enrolling notifies the holder', enrolNotice.rows[0]?.n, '1');
  eq('...account-scoped, not pinned to a tenant', enrolNotice.rows[0]?.company_id, null);
  eq('...and urgently', enrolNotice.rows[0]?.urgency, 'URGENT');

  // 10 ── Mandatory for platform staff, and enforced where the blast radius is
  // (§13.1). A staff password compromise reads every tenant on the platform.
  const mfaStaff = await register('mfa-staff', `Platform Staff MFA ${RUN}`);
  // Deliberately *not* `promoteToStaff` here: this section proves the refusal and
  // then the enrolment that lifts it, so it needs the un-enrolled state first.
  await db.query(`update users set is_super_admin = true where id = $1`, [mfaStaff.userId]);
  const staffStatus = await call('GET', '/v1/me/mfa', { token: mfaStaff.token });
  eq('platform staff are told a factor is required', staffStatus.json?.required, true);

  const consoleBlocked = await call('GET', '/v1/admin/dashboard', { token: mfaStaff.token });
  eq('...and the console refuses them until they hold one', consoleBlocked.status, 403);
  check('...naming what to do rather than saying "forbidden"',
    String(consoleBlocked.json?.error?.message ?? '').toLowerCase().includes('authenticator app'),
    consoleBlocked.json?.error?.message);

  const staffEnrol = await call('POST', '/v1/me/mfa', { token: mfaStaff.token });
  const staffPending = await call('GET', '/v1/admin/dashboard', { token: mfaStaff.token });
  eq('an unfinished enrolment is refused as firmly as none', staffPending.status, 403);
  await call('POST', '/v1/me/mfa/confirm', {
    token: mfaStaff.token,
    body: { code: totpCodeFor(staffEnrol.json?.secret as string) },
  });
  const consoleOpen = await call('GET', '/v1/admin/dashboard', { token: mfaStaff.token });
  eq('...and opens once the factor is confirmed', consoleOpen.status, 200);

  // A customer is never blocked by this: the mandate is about the console.
  const customerWorkspace = await call('GET', '/v1/me', { token: mfaUser.token });
  eq('a customer with no factor is unaffected everywhere else', customerWorkspace.status, 200);

  // 11 ── The operator reset (§13.2), which is the one path that removes somebody's
  // protection without them. Reason required, holder told unconditionally, and it
  // grants the operator nothing.
  const lost = await register('mfa-lost', `Lost Phone Ltd ${RUN}`);
  const lostEnrol = await call('POST', '/v1/me/mfa', { token: lost.token });
  await call('POST', '/v1/me/mfa/confirm', {
    token: lost.token,
    body: { code: totpCodeFor(lostEnrol.json?.secret as string) },
  });

  const resetNoReason = await call('POST', `/v1/admin/users/${lost.userId}/reset-mfa`, {
    token: mfaStaff.token,
    body: {},
  });
  eq('an operator cannot reset a factor without a reason', resetNoReason.status, 422);

  const reset = await call('POST', `/v1/admin/users/${lost.userId}/reset-mfa`, {
    token: mfaStaff.token,
    body: { reason: 'Customer lost phone and recovery codes (verify-e2e)' },
  });
  eq('...and can with one', reset.status, 200);
  eq('...which removes the factor', reset.json?.removed, 1);
  check('...and ends every session it could not vouch for',
    (reset.json?.sessionsEnded ?? 0) >= 1, reset.json);

  const lostAfter = await call('POST', '/v1/auth/login', {
    body: { email: lost.email, password: 'Verify-passw0rd!' },
  });
  check('the holder can sign in with their password again',
    Boolean(lostAfter.json?.tokens), lostAfter.json);
  // A fresh token, because the reset ended every session — including the one this
  // fixture had been using. That is the reset working, and a test that reused the
  // old token would be asserting the opposite.
  const lostToken = lostAfter.json?.tokens?.accessToken as string;

  const resetAudit = await db.query<{ changes: any }>(
    `select changes from platform_audit_logs
      where action = 'auth.mfa_reset_by_operator' and entity_id = $1
      order by created_at desc limit 1`,
    [lost.userId]
  );
  check('the reset is platform-audited with its reason',
    String(resetAudit.rows[0]?.changes?.reason ?? '').includes('lost phone'),
    resetAudit.rows[0]?.changes);

  await drainWorkers();
  const resetNotice = await db.query<{ n: string; body: string }>(
    `select count(*)::text as n, min(body) as body from notifications
      where recipient_user_id = $1 and kind = 'auth.mfa_reset_by_operator'`,
    [lost.userId]
  );
  eq('the holder is told unconditionally', resetNotice.rows[0]?.n, '1');
  check('...without the operator internal note reaching them',
    !String(resetNotice.rows[0]?.body ?? '').includes('verify-e2e'),
    resetNotice.rows[0]?.body);

  // 12 ── No back door (§12.11), asserted as an absence: resetting a factor takes
  // access away and hands the operator none of it.
  const impersonateViaReset = await call('GET', `/v1/admin/users/${lost.userId}/sessions`, {
    token: mfaStaff.token,
  });
  eq('an operator cannot read another user session list', impersonateViaReset.status, 404);

  // 13 ── Correction (§12.12): everything above is reversible by the holder without
  // an operator. Re-enrol, then remove with a password.
  const reEnrol = await call('POST', '/v1/me/mfa', { token: lostToken });
  eq('the holder can enrol again themselves', reEnrol.status, 201);
  await call('POST', '/v1/me/mfa/confirm', {
    token: lostToken,
    body: { code: totpCodeFor(reEnrol.json?.secret as string) },
  });
  const holderRemove = await call('DELETE', '/v1/me/mfa', {
    token: lostToken,
    body: { password: 'Verify-passw0rd!' },
  });
  eq('...and remove it themselves, with their password', holderRemove.status, 204);
  const finalState = await call('GET', '/v1/me/mfa', { token: lostToken });
  eq('...leaving the account as it started', finalState.json?.state, 'NONE');
  const codesGone = await db.query<{ n: string }>(
    `select count(*)::text as n from auth_recovery_codes where user_id = $1`,
    [lost.userId]
  );
  eq('...with no recovery codes left behind for a factor that is gone',
    codesGone.rows[0]?.n, '0');

  await drainWorkers();
  const removeNotice = await db.query<{ n: string }>(
    `select count(*)::text as n from notifications
      where recipient_user_id = $1 and kind = 'auth.mfa_removed'`,
    [lost.userId]
  );
  eq('removal is notified too, because it lowers protection', removeNotice.rows[0]?.n, '1');

  // 14 ── Every enrolment on one account is its own email. The dedupe key is per
  // occurrence rather than per user; keyed on the user, only the first would ever
  // arrive — and enrol → reset → re-enrol → enrol again is exactly the sequence an
  // account recovering from a lost phone goes through, so the later ones are the
  // ones that matter most.
  const secondEnrol = await call('POST', '/v1/me/mfa', { token: lostToken });
  await call('POST', '/v1/me/mfa/confirm', {
    token: lostToken,
    body: { code: totpCodeFor(secondEnrol.json?.secret as string) },
  });
  await drainWorkers();
  const twoEnrolments = await db.query<{ n: string }>(
    `select count(*)::text as n from notifications
      where recipient_user_id = $1 and kind = 'auth.mfa_enrolled'`,
    [lost.userId]
  );
  // Three, and each is real: the enrolment before the operator reset, the
  // re-enrolment after it, and this one.
  eq('every enrolment is its own notification, not a deduplication',
    twoEnrolments.rows[0]?.n, '3');

  // ══ Signing-secret rotation (access.md §12.10, §14 step 4) ════════════════
  //
  // Asserted against the *running* API rather than in a unit test, because the
  // claim is about a live session surviving — and the thing that decides that is
  // the ring the server booted with, not the one this script can construct.
  section('signing-secret rotation');

  const rotUser = await register('rotation');
  const rotHeader = jwt.decode(rotUser.token, { complete: true });
  const rotPayload = (rotHeader?.payload ?? {}) as { sub?: string; sid?: string };
  const liveKid = typeof rotHeader?.header.kid === 'string' ? rotHeader.header.kid : null;

  check('a token from a real sign-in names the key that signed it',
    liveKid !== null, rotHeader?.header);
  eq('...which is the key this deployment is currently signing with',
    liveKid, currentAccessKid());
  eq('...derived from the secret, so a label can never name the wrong key',
    liveKid, deriveKid(env.JWT_ACCESS_SECRET));

  // Mint variants for the same live session. The session must be real: since
  // 0018 `requireAuth` checks `sid` is still live, so a forged claim set alone
  // does not open a door even when the signature is genuine.
  const mint = (secret: string, options: jwt.SignOptions) =>
    jwt.sign({ sub: rotPayload.sub, sid: rotPayload.sid }, secret, {
      algorithm: 'HS256',
      expiresIn: 900,
      ...options,
    });

  // 1 ── The deploy that introduces the ring must sign nobody out. Every token in
  // flight at that moment carries no kid header at all.
  const kidless = await call('GET', '/v1/me', {
    token: mint(env.JWT_ACCESS_SECRET, {}),
  });
  eq('a token minted before kids existed still works, so the deploy logs nobody out',
    kidless.status, 200);

  // 2 ── A kid is a claim about which key signed the token, not a substitute for
  // the signature. Naming one of ours must be worth nothing on its own.
  const foreignSecret = `never-a-key-of-this-deployment-${RUN}`;
  const forgedUnderRealKid = await call('GET', '/v1/me', {
    token: mint(foreignSecret, { keyid: currentAccessKid() }),
  });
  eq('naming a real key over a signature that is not ours is refused',
    forgedUnderRealKid.status, 401);

  // 3 ── ...and a kid we do not hold is refused rather than falling back to
  // trying every key anyway, which is what retiring a key has to mean.
  const unknownKid = await call('GET', '/v1/me', {
    token: mint(foreignSecret, { keyid: deriveKid(foreignSecret) }),
  });
  eq('a kid this deployment does not hold is refused', unknownKid.status, 401);

  // 4 ── Neither refusal may say which one it was. "Unknown key id" would tell an
  // attacker when a guess had named a real key — the same oracle rule §12.3
  // applies to the sign-in surface, applied here to the ring.
  //
  // Compared without the correlation id, which is per-request and differs on every
  // call by design. This assertion originally compared whole bodies and caught the
  // change the moment request correlation shipped, which is the check working: the
  // question it has to answer is whether the *reason* leaked, and a reference that
  // is a fresh uuid every time carries no reason. Narrowed to the two fields that
  // could — the code and the sentence — rather than relaxed.
  const refusalShape = (body: any) => stable({
    code: body?.error?.code,
    message: body?.error?.message,
  });
  eq('...and the two refusals are indistinguishable, so the ring is not an oracle',
    refusalShape(unknownKid.json), refusalShape(forgedUnderRealKid.json));
  check('...with a reference each, which differs by request and says nothing',
    typeof unknownKid.json?.error?.requestId === 'string' &&
      unknownKid.json?.error?.requestId !== forgedUnderRealKid.json?.error?.requestId,
    { a: unknownKid.json?.error?.requestId, b: forgedUnderRealKid.json?.error?.requestId });

  // 5 ── The rotation itself: a token signed by a *retired* key, presented to a
  // server now signing with a different one. This is the assertion the packet
  // asks for, and it only means anything when the deployment actually has an
  // overlap configured — so it is reported as absent rather than passed quietly.
  const retiredSecrets = parseRetiredSecrets(env.JWT_ACCESS_SECRET_RETIRED);
  if (retiredSecrets.length > 0) {
    const retired = retiredSecrets[0] as string;
    const heldAcrossRotation = await call('GET', '/v1/me', {
      token: mint(retired, { keyid: deriveKid(retired) }),
    });
    eq('a session signed by a retired key survives the rotation',
      heldAcrossRotation.status, 200);
    check('...while new tokens are signed by the current key, not the retired one',
      currentAccessKid() !== deriveKid(retired), { current: currentAccessKid() });
  } else {
    console.log('  --   no JWT_ACCESS_SECRET_RETIRED configured — overlap not exercised');
    console.log('       set it in .env to prove the rotation against a live server');
  }

  // 6 ── Single-purpose tokens ride the same mechanism, because this secret signs
  // password-reset links that routinely outlive a deploy.
  const resetLink = signPurposeToken(rotUser.userId, 'password_reset', 3600);
  const resetHeader = jwt.decode(resetLink, { complete: true });
  eq('a password-reset link names its key too',
    typeof resetHeader?.header.kid === 'string'
      ? resetHeader.header.kid
      : null,
    deriveKid(env.JWT_REFRESH_SECRET));

  // ══ Request correlation (observability-data-lifecycle.md §12.1-2, §14 step 2) ══
  //
  // The support model access.md §13.3 left available: an operator gets from "it
  // says something went wrong" to one request, without reading any of that
  // customer's records.
  section('request correlation');

  const missing = await call('GET', '/v1/does-not-exist');
  const missingHeader = missing.headers.get('x-request-id');
  eq('an unmatched route is still a 404', missing.status, 404);
  check('...and carries a reference in the header', Boolean(missingHeader), missingHeader);
  eq('...and the same one in the envelope, so either source works',
    missing.json?.error?.requestId, missingHeader);

  const secondMiss = await call('GET', '/v1/does-not-exist');
  check('every request gets its own reference',
    secondMiss.headers.get('x-request-id') !== missingHeader,
    { first: missingHeader, second: secondMiss.headers.get('x-request-id') });

  // A reference that exists only for crashes is missing exactly when somebody is
  // on the phone: the errors people ask about are the refusal they did not expect
  // and the validation they cannot read.
  const unauthorised = await call('GET', '/v1/me');
  eq('an unauthenticated read is refused', unauthorised.status, 401);
  check('...and a refusal carries a reference too, not just a crash',
    typeof unauthorised.json?.error?.requestId === 'string',
    unauthorised.json);

  const corrUser = await register('correlate');
  const invalid = await call('POST', '/v1/projects', {
    token: corrUser.token,
    companyId: corrUser.companyId ?? undefined,
    body: { name: '' },
  });
  check('a validation failure carries a reference',
    typeof invalid.json?.error?.requestId === 'string',
    invalid.json);

  const ok = await call('GET', '/v1/me', { token: corrUser.token });
  eq('a successful request is correlated as well', ok.status, 200);
  check('...so a slow success can be traced without an error to hang it on',
    Boolean(ok.headers.get('x-request-id')));

  // The caller does not get to choose what their traffic is filed under: reusing
  // one id would make a support search useless, and reusing somebody else's would
  // attach this activity to another tenant's investigation.
  const forged = await fetch(`${BASE}/v1/does-not-exist`, {
    headers: { 'X-Request-Id': 'forged-by-the-caller' },
  });
  check('an inbound reference is ignored rather than trusted',
    forged.headers.get('x-request-id') !== 'forged-by-the-caller',
    forged.headers.get('x-request-id'));

  // ══ The scheduler, and the alarm for its own absence (§12.5, §14 step 1) ═══
  //
  // The most serious finding in the packet: three one-shot jobs, correct
  // reasoning for being one-shot, and nothing scheduling them — so deployed, the
  // outbox never drained and no notification was ever delivered.
  section('scheduled jobs');

  // The workers pass ran during `drainWorkers()` above, many times. Each one-shot
  // invocation writes a row; the in-process drain this script uses does not,
  // which is the same asymmetry as `--loop` and is why this asserts against a
  // real CLI invocation rather than against the drains.
  await recordJobRun('workers', async () => ({ claimed: 0, succeeded: 0, failed: 0 }));

  const lastRun = await db.query<{ job: string; outcome: string; run_id: string }>(
    `select job, outcome, run_id from job_runs
      where job = 'workers' order by started_at desc limit 1`
  );
  eq('a pass records that it ran', lastRun.rows[0]?.job, 'workers');
  eq('...and how it ended', lastRun.rows[0]?.outcome, 'SUCCEEDED');
  check('...under an id that correlates it with its own log lines',
    typeof lastRun.rows[0]?.run_id === 'string', lastRun.rows[0]);

  // A pass that throws is recorded as FAILED rather than leaving nothing behind,
  // because "no row" and "a row that failed" are what the alarm has to tell apart.
  let threw = false;
  try {
    await recordJobRun('workers', async () => {
      throw new Error('verify-e2e deliberate failure');
    });
  } catch {
    threw = true;
  }
  check('a failing pass rethrows, so the runner exits non-zero', threw);
  const failed = await db.query<{ outcome: string; error: string | null }>(
    `select outcome, error from job_runs where job = 'workers' order by started_at desc limit 1`
  );
  eq('...and is recorded as failed rather than as silence', failed.rows[0]?.outcome, 'FAILED');
  check('...with the reason an operator reads',
    (failed.rows[0]?.error ?? '').includes('deliberate failure'), failed.rows[0]?.error);

  // The alarm itself. Health is computed from the last SUCCEEDED row, so the
  // FAILED row just written must not clear it.
  const jobsHealth = await readJobHealth();
  const workersHealth = jobsHealth.find((h) => h.job === 'workers');
  // Counted against the catalog rather than a literal: the point of the check is
  // that health covers every registered job, and hard-coding the number turns
  // adding one into a failing test that says nothing about what is wrong.
  eq('every scheduled job is reported, so a missing one cannot read as healthy',
    jobsHealth.length, SCHEDULED_JOBS.length);
  eq('...including the closure pass, whose silence is the hardest to notice',
    jobsHealth.some((h) => h.job === 'closures'), true);
  check('a job that has just succeeded is not overdue', workersHealth?.overdue === false,
    workersHealth);
  // The FAILED row was written after the SUCCEEDED one, so this proves health is
  // read from the last *success* rather than the last *run*. The original version
  // of this check asserted `>= 0`, which was true of almost anything — and then
  // failed anyway on clock skew, which is how the clamp in `jobs.ts` got written.
  check('...and health is read from the last success, not the last run',
    workersHealth?.lastSuccessAt !== null &&
      (workersHealth?.secondsSinceSuccess ?? 99999) < 300,
    workersHealth);

  // A job that has never run at all is overdue rather than unknown — the state a
  // deployment is in on the day the schedule was never wired up, which is exactly
  // when a silent alarm is worthless.
  const neverRan = jobsHealth.find((h) => h.lastSuccessAt === null);
  if (neverRan) {
    check('a job that has never succeeded reads as overdue, not as unknown',
      neverRan.overdue === true, neverRan);
  }

  // And the operator sees it on the screen they already watch, beside the queue
  // depths it explains: a pending outbox reads as a quiet week whether the drain
  // ran a minute ago or has not run since the schedule was disabled.
  const opsView = await call('GET', '/v1/admin/operations', { token: mfaStaff.token });
  const jobService = (opsView.json?.services ?? []).find(
    (svc: { name: string }) => svc.name === 'Scheduled jobs'
  );
  check('the operator console carries the scheduler beside the queues it explains',
    Boolean(jobService), opsView.json?.services?.map((s: { name: string }) => s.name));
  check('...naming what is lost rather than naming a table',
    !String(jobService?.detail ?? '').includes('job_runs'), jobService);

  // -- Data export (packet 14 step 5, owner decision 13.2) -------------------
  section('Data export (free for everyone; JSON+CSV; the money boundary holds)');
  {
    /*
     * THE SUBJECT IS THE PROVIDER WHO LOGGED THE PRICED HOURS ABOVE, not a fresh account,
     * and that is the whole design of this section.
     *
     * The first version registered a new user and asserted their bundle carried no
     * `resolved_rate`. It passed - and it passed with `selectFor` deliberately broken to
     * `select *`, because a brand-new account has no time logs, so there was no frozen
     * rate in the database to leak. A test that cannot fail is worse than no test, and
     * this is the fifth time in this repository that breaking the code on purpose is the
     * only thing that found it.
     *
     * So the subject is `providerUser`, who logged 8h that was approved at a resolved PAY
     * rate, and the anti-vacuity guards below assert the row and the rate really exist
     * before anything claims they did not leak.
     */
    const subjectUserId = providerUser.userId;

    const { rows: rateRows } = await db.query<{ n: number }>(
      `select count(*)::int as n from time_logs
        where logged_by_user_id = $1 and resolved_rate is not null`,
      [subjectUserId]
    );
    check('the export subject really has a priced time log, so the next checks can fail',
      (rateRows[0]?.n ?? 0) > 0, rateRows[0]);

    /*
     * EVERY SPEC COLUMN MUST EXIST IN THE SCHEMA.
     *
     * The manifest is hand-written against the schema, so it drifts the moment a
     * migration renames anything - and it already did while this was being built:
     * `notification_preferences` was specced with a `company_id` and a
     * `channel_overrides` the table does not have, which reached a live request and came
     * back as a 500 to somebody asking for their own data. A unit test cannot catch this,
     * because the schema is not in the unit-test environment. This can.
     */
    for (const scopeName of ['PERSONAL', 'COMPANY'] as const) {
      const spec = scopeName === 'PERSONAL' ? PERSONAL_EXPORT : COMPANY_EXPORT;
      const queries = scopeName === 'PERSONAL' ? PERSONAL_QUERIES : COMPANY_QUERIES;
      const missing: string[] = [];
      for (const table of spec) {
        const query = queries[table.table]!;
        // The first identifier in `from` is the real table; the spec's name is for the
        // reader, so `sessions` is `auth_sessions`.
        const realTable = query.from.split(/\s+/)[0]!;
        const { rows } = await db.query<{ column_name: string }>(
          `select column_name from information_schema.columns where table_name = $1`,
          [realTable]
        );
        const actual = new Set(rows.map((r) => r.column_name));
        for (const column of table.columns) {
          // A column supplied by an expression comes from a joined table, so the query
          // succeeding is what proves it rather than this lookup.
          if (query.expr?.[column]) continue;
          if (!actual.has(column)) missing.push(`${scopeName}.${table.table}.${column}`);
        }
      }
      check(`every ${scopeName} export column exists in the database`, missing.length === 0, missing);
    }

    const personal = await call('GET', '/v1/me/export', { token: providerUser.token, raw: true });
    check('a person can export their own data', personal.status === 200, personal.status);
    check('...as a zip', personal.headers.get('content-type') === 'application/zip');
    check('...offered as a download rather than rendered',
      (personal.headers.get('content-disposition') ?? '').includes('attachment'));
    // A whole person's or tenant's history must never sit in a shared cache.
    check('...and never cached anywhere',
      (personal.headers.get('cache-control') ?? '').includes('no-store'),
      personal.headers.get('cache-control'));

    const personalZip = await JSZip.loadAsync(personal.buffer!);
    const personalNames = Object.keys(personalZip.files);
    check('...carrying a manifest', personalNames.includes('manifest.json'));
    check('...with JSON and CSV for every table (owner: never a PDF)',
      PERSONAL_EXPORT.every(
        (t) => personalNames.includes(`${t.table}.json`) && personalNames.includes(`${t.table}.csv`)
      ),
      personalNames);

    const personalManifest = JSON.parse(await personalZip.file('manifest.json')!.async('string'));
    check('...naming every table it contains', personalManifest.tables.length === PERSONAL_EXPORT.length);
    check('...and saying what deletion does, before the button rather than after it',
      String(personalManifest.notes.join(' ')).includes('without your name on them'));

    // Anti-vacuity, at the bundle rather than at the database: the hours have to actually
    // be in this file for their absence of a rate to mean anything.
    const personalLogs = personalManifest.tables.find(
      (t: { table: string }) => t.table === 'time_logs'
    );
    check('the bundle really contains the hours', (personalLogs?.rowCount ?? 0) > 0, personalLogs);

    /*
     * THE ASSERTION THIS WHOLE SLICE EXISTS FOR.
     *
     * A personal export built from "the tables where this person appears" is the obvious
     * implementation, and it hands every crew member the frozen PAY snapshot - an
     * inter-company commercial term, not their wage. The row is theirs; the money stapled
     * to it is not.
     *
     * Data files only. Checking the whole zip matches the manifest's own `withheld` list,
     * which documents these very column names - the same read-prose-as-code trap the
     * colour literal scan hit on its own first run.
     */
    let personalData = '';
    for (const name of personalNames.filter((n) => n !== 'manifest.json')) {
      personalData += await personalZip.file(name)!.async('string');
    }
    check('a personal export never carries the frozen PAY rate',
      !personalData.includes('resolved_rate') && !personalData.includes('baseCents'));
    check('...nor a credential', !personalData.includes('password_hash'));
    check('...nor the id of the colleague who approved the work',
      !personalData.includes('reviewed_by_user_id'));
    check('...and the manifest explains each absence rather than leaving a hole',
      personalManifest.tables.some((t: { withheld?: unknown[] }) => (t.withheld?.length ?? 0) > 0));

    // The provider company's own export: the same rate, on the side of the boundary
    // where it is that company's own commercial term.
    const company = await call('GET', `/v1/companies/${northgate}/export`, {
      token: providerUser.token,
      companyId: northgate,
      raw: true,
    });
    check('an owner can export the company', company.status === 200, company.status);
    const companyZip = await JSZip.loadAsync(company.buffer!);
    const companyManifest = JSON.parse(await companyZip.file('manifest.json')!.async('string'));
    check('...with every company table named', companyManifest.tables.length === COMPANY_EXPORT.length);
    const companyLogs = await companyZip.file('time_logs.json')!.async('string');
    check('...and the frozen rate IS here, because on this side it is the company own term',
      companyLogs.includes('resolved_rate'), companyLogs.slice(0, 200));
    check('...while the counterparty client rate cards stay out of reach',
      (await companyZip.file('rate_cards.json')!.async('string')).includes(northgate) ||
        companyManifest.tables.find((t: { table: string }) => t.table === 'rate_cards')?.rowCount === 0);

    // "Free for everyone, including the free crew plan" was the decision, so an
    // unsubscribed account must not be refused.
    const crewOnly = await register('exporter-crew', `Export Crew ${RUN}`);
    const crewExport = await call('GET', '/v1/me/export', { token: crewOnly.token, raw: true });
    check('export is free: a crew-plan account is not refused its own data',
      crewExport.status === 200, crewExport.status);
    const crewCompany = await call('GET', `/v1/companies/${crewOnly.companyId}/export`, {
      token: crewOnly.token,
      companyId: crewOnly.companyId!,
      raw: true,
    });
    check('...and neither is its company', crewCompany.status === 200, crewCompany.status);

    const stolen = await call('GET', `/v1/companies/${northgate}/export`, {
      token: crewOnly.token,
      companyId: northgate,
      raw: true,
    });
    check('a non-member cannot export another company',
      stolen.status === 403 || stolen.status === 404, stolen.status);

    const { rows: exportRows } = await db.query<{ scope: string; byte_size: number }>(
      `select scope, byte_size from data_exports
        where subject_company_id = $1 or subject_user_id = $2 order by created_at`,
      [northgate, subjectUserId]
    );
    check('each export is recorded as the disclosure it is', exportRows.length >= 2, exportRows.length);
    check('...with a size, so a later question needs no re-run',
      exportRows.every((r) => r.byte_size > 0));

    const { rows: auditRows } = await db.query<{ n: number }>(
      `select count(*)::int as n from audit_logs
        where company_id = $1 and action = 'company.exported'`,
      [northgate]
    );
    check('a company export is audited', (auditRows[0]?.n ?? 0) === 1, auditRows[0]);
    const { rows: personalAudit } = await db.query<{ n: number }>(
      `select count(*)::int as n from audit_logs
        where actor_user_id = $1 and action = 'company.exported'
          and company_id <> $2`,
      [subjectUserId, northgate]
    );
    check('...and a personal one is not filed in an employer log',
      (personalAudit[0]?.n ?? 0) === 0, personalAudit[0]);
  }

  section('Closure (§13.1: anonymise the person, preserve the record)');
  {
    /*
     * THE SUBJECT IS A CREW MEMBER OF THE CORE-LOOP PROVIDER, and every part of that
     * sentence is load-bearing.
     *
     * `providerUser` cannot be the subject: they own Northgate, so the sole-owner
     * precondition refuses them — which is itself asserted further down. And a fresh
     * account with no history is exactly the vacuous subject the export section was
     * caught on: "his hours still price correctly" passes trivially when he has none.
     * So Sam is invited into Northgate as a MEMBER, logs 4h that is approved at the
     * frozen PAY rate, and the assertions below have something real to preserve.
     */
    /*
     * Northgate is a claimed placeholder and so sits on the free `crew` plan, whose
     * `internal_seats` limit is one — its owner. Inviting a second person is a 402
     * until it has a plan with room, which is the entitlement system working rather
     * than anything to do with closure. Raised here rather than earlier because every
     * assertion that depended on Northgate being a crew-plan company has already run.
     */
    await subscribe(northgate, 'pro');

    const samEmail = `sam+${RUN}@verify.crewquo.test`;
    const samInvite = await call('POST', '/v1/members/invite', {
      token: providerUser.token,
      companyId: northgate,
      body: { email: samEmail, role: 'MEMBER' },
    });
    eq('a crew member is invited to the provider company', samInvite.status, 201);
    const sam = await register('sam', undefined, samEmail);
    await call('POST', `/v1/invites/${samInvite.json.inviteToken}/accept`, { token: sam.token });

    const samLog = await call('POST', '/v1/time-logs', {
      token: sam.token,
      companyId: northgate,
      body: {
        projectId,
        roleId,
        shiftType: 'WEEKDAY_DAY',
        workDate: '2026-07-21',
        hoursRegular: 4,
        hoursOt: 0,
      },
    });
    eq('the crew member logs 4h', samLog.status, 201);
    const samLogId = samLog.json.timeLog.id as string;
    const samSubmit = await call('POST', `/v1/time-logs/${samLogId}/submit`, {
      token: sam.token, companyId: northgate,
    });
    eq('...frozen at 4h × 5000', samSubmit.json.timeLog.resolvedRate?.costCents, 20000);
    await call('POST', `/v1/time-logs/${samLogId}/approve`, {
      token: owner.token, companyId: meridian,
    });

    // A pending invite addressed to Sam, from a company he never joined. The closure
    // has to revoke it: the address is released, and whoever registers it next must
    // not inherit a seat somebody else was offered.
    const strayInvite = await call('POST', '/v1/members/invite', {
      token: owner.token,
      companyId: meridian,
      body: { email: samEmail, role: 'MEMBER' },
    });
    eq('a second company also has a pending invite out to that address', strayInvite.status, 201);

    // Something to prune that is keyed on the address rather than the account.
    await db.query(
      `insert into auth_attempts (scope, identity_key, source_key, succeeded)
       values ('LOGIN', $1, 'verify-e2e-source', false)`,
      [samEmail.toLowerCase()]
    );

    const summaryBefore = await call('GET', `/v1/projects/${projectId}/summary`, {
      token: owner.token, companyId: meridian,
    });

    // ── 1. The frictions, before anything is scheduled ─────────────────────
    const wrongName = await call('POST', '/v1/me/closure', {
      token: sam.token,
      body: { confirm: 'not-my-address@example.com', password: 'Verify-passw0rd!' },
    });
    eq('a mistyped confirmation is refused', wrongName.status, 422);

    const wrongPassword = await call('POST', '/v1/me/closure', {
      token: sam.token,
      body: { confirm: samEmail, password: 'not-the-password' },
    });
    // Being signed in is not proof that the person signed in is the one asking.
    eq('being signed in is not enough — the password is re-entered', wrongPassword.status, 401);

    const requested = await call('POST', '/v1/me/closure', {
      token: sam.token,
      body: { confirm: samEmail, password: 'Verify-passw0rd!' },
    });
    eq('a person may close their own account', requested.status, 201);
    const samRequestId = requested.json.request.id as string;

    const duplicate = await call('POST', '/v1/me/closure', {
      token: sam.token,
      body: { confirm: samEmail, password: 'Verify-passw0rd!' },
    });
    // The partial unique index is the concurrency control, not a preceding read.
    eq('two clicks are one request', duplicate.status, 409);

    const status = await call('GET', '/v1/me/closure', { token: sam.token });
    eq('the pending closure is readable', status.json.request?.id, samRequestId);
    check('...and cancellable', status.json.request?.cancellable === true);
    check(
      `...with the deadline ${DELETION_COOLING_OFF_DAYS} days out`,
      new Date(status.json.request.scheduledFor).getTime() - Date.now() >
        (DELETION_COOLING_OFF_DAYS - 1) * 86_400_000
    );
    check('...and the promise that cannot be kept in full is on the screen',
      (status.json.promises ?? []).some((line: string) =>
        line.includes('The hours you logged remain, without your name on them')),
      status.json.promises);

    // ── 2. The safety property: nobody told, nothing deleted ───────────────
    /*
     * The single most important check in this section.
     *
     * `REQUESTED` means the notice has not been dispatched — the outbox handler that
     * sends it is what advances the state. So a request that reaches its deadline
     * without the notice going out must NOT run: a dead-lettered email would
     * otherwise erase an account in silence on the seventh day, with the cooling-off
     * period having protected nobody.
     *
     * Asserted by backdating the deadline *without* draining the outbox, which is
     * exactly the shape of a mail provider that was down for a week.
     */
    await db.query(
      `update deletion_requests set scheduled_for = now() - interval '1 minute' where id = $1`,
      [samRequestId]
    );
    const silentPass = await runClosurePass();
    eq('a request nobody was warned about is not executed', silentPass.claimed, 0);
    const { rows: untouched } = await db.query<{ status: string; anonymized_at: Date | null }>(
      `select d.status, u.anonymized_at from deletion_requests d
         join users u on u.id = d.subject_user_id where d.id = $1`,
      [samRequestId]
    );
    eq('...and stays REQUESTED', untouched[0]?.status, 'REQUESTED');
    check('...with the account untouched', untouched[0]?.anonymized_at === null);

    // ── 3. Told, then stopped. Nothing was deleted ─────────────────────────
    await drainWorkers();
    const { rows: scheduled } = await db.query<{ status: string }>(
      `select status from deletion_requests where id = $1`, [samRequestId]
    );
    eq('dispatching the notice is what schedules the closure', scheduled[0]?.status, 'SCHEDULED');

    const { rows: notice } = await db.query<{ kind: string; urgency: string; requires_action: boolean }>(
      `select kind, urgency, requires_action from notifications
        where recipient_user_id = $1 and kind = 'account.closure_scheduled'`,
      [sam.userId]
    );
    eq('the holder is told immediately', notice.length, 1);
    // §6: a deletion notice is the one message whose entire value is arriving before
    // a deadline, so it overrides quiet hours and carries the cancel action.
    eq('...urgently, so quiet hours cannot hide it', notice[0]?.urgency, 'URGENT');
    check('...as something they can still act on', notice[0]?.requires_action === true);

    const cancelled = await call('DELETE', '/v1/me/closure', { token: sam.token });
    eq('the holder can stop it', cancelled.status, 200);
    const { rows: afterCancel } = await db.query<{ status: string; contact_email: string | null }>(
      `select status, contact_email from deletion_requests where id = $1`, [samRequestId]
    );
    eq('...and it is cancelled', afterCancel[0]?.status, 'CANCELLED');
    // The address was captured for a notice that will now never be sent, and a
    // permanent record of a deletion has no business keeping one.
    check('...releasing the address it was holding', afterCancel[0]?.contact_email === null);

    const { rows: stillThere } = await db.query<{ n: number }>(
      `select count(*)::int as n from memberships where user_id = $1`, [sam.userId]
    );
    check('nothing was deleted by a cancelled closure', (stillThere[0]?.n ?? 0) > 0);

    // ── 4. The one-day-out warning goes exactly once ───────────────────────
    const again = await call('POST', '/v1/me/closure', {
      token: sam.token,
      body: { confirm: samEmail, password: 'Verify-passw0rd!', reason: 'Leaving the trade' },
    });
    eq('a cancelled closure does not block a new one', again.status, 201);
    const liveRequestId = again.json.request.id as string;
    await drainWorkers();

    await db.query(
      `update deletion_requests set scheduled_for = now() + interval '2 hours' where id = $1`,
      [liveRequestId]
    );
    await runClosurePass();
    await drainWorkers();
    const { rows: imminent } = await db.query<{ n: number }>(
      `select count(*)::int as n from notifications
        where recipient_user_id = $1 and kind = 'account.closure_imminent'`,
      [sam.userId]
    );
    eq('the last reminder is sent a day out', imminent[0]?.n, 1);

    // Run the pass twice more: an hourly job inside a 24-hour lead would otherwise
    // send twenty-four identical warnings. The guard is the recorded send.
    await runClosurePass();
    await runClosurePass();
    await drainWorkers();
    const { rows: imminentAgain } = await db.query<{ n: number }>(
      `select count(*)::int as n from notifications
        where recipient_user_id = $1 and kind = 'account.closure_imminent'`,
      [sam.userId]
    );
    eq('...and only once, however often the job runs', imminentAgain[0]?.n, 1);

    // ── 5. Erased, and not (§12.11) ────────────────────────────────────────
    await db.query(
      `update deletion_requests set scheduled_for = now() - interval '1 minute' where id = $1`,
      [liveRequestId]
    );
    const run = await runClosurePass();
    eq('the due closure runs', run.completed, 1);
    eq('...and nothing failed', run.failed, 0);

    const { rows: closed } = await db.query<{
      email: string; name: string; password_hash: string | null; google_sub: string | null;
      is_super_admin: boolean; anonymized_at: Date | null;
    }>(
      `select email, name, password_hash, google_sub, is_super_admin, anonymized_at
         from users where id = $1`,
      [sam.userId]
    );
    check('the account is anonymised', closed[0]?.anonymized_at !== null);
    check('...to a tombstone that cannot be delivered to',
      // `.invalid` is reserved by RFC 2606, so a stray send cannot reach a real inbox.
      (closed[0]?.email ?? '').endsWith('@closed.crewquo.invalid'), closed[0]?.email);
    check('...carrying nothing of the old address',
      !closed[0]!.email.includes('sam+') && !closed[0]!.email.includes('verify.crewquo.test'),
      closed[0]?.email);
    eq('...attributed to a withdrawn person rather than to nobody',
      closed[0]?.name, 'Withdrawn person');
    check('...with no credential left', closed[0]?.password_hash === null && closed[0]?.google_sub === null);
    check('...and no platform-staff bit', closed[0]?.is_super_admin === false);

    /*
     * Before the sign-in probe below, and that ordering is the assertion rather than
     * tidiness. A failed sign-in records an `auth_attempts` row keyed on the address
     * it was tried against, so asking this question after probing the old address
     * counts the probe's own row and reports the closure as leaky whatever it did.
     *
     * What it guards: `auth_attempts.identity_key` holds the address rather than the
     * account (0016 — it is deliberately not a foreign key), so the step that clears
     * it has to run before `users` is anonymised. Get that order wrong and the delete
     * matches nothing, reports zero rows, and the run reports success while a real
     * address stays behind.
     */
    const { rows: attempts } = await db.query<{ n: number }>(
      `select count(*)::int as n from auth_attempts where identity_key = $1`,
      [samEmail.toLowerCase()]
    );
    eq('sign-in attempts against the old address are gone', attempts[0]?.n, 0);

    const signIn = await call('POST', '/v1/auth/login', {
      body: { email: samEmail, password: 'Verify-passw0rd!' },
    });
    eq('the account cannot sign in', signIn.status, 401);
    // Never "that account was closed": the address has been released and may belong
    // to somebody else by now, so confirming a closure on it would turn the erasure
    // into a disclosure.
    check('...without confirming that a closure happened on that address',
      !/clos|delet|anonym/i.test(String(signIn.json?.error?.message ?? '')),
      signIn.json?.error?.message);

    const staleToken = await call('GET', '/v1/me', { token: sam.token });
    eq('an access token minted before the run stops working at once', staleToken.status, 401);

    for (const [table, column] of [
      ['memberships', 'user_id'],
      ['auth_sessions', 'user_id'],
      ['refresh_tokens', 'user_id'],
      ['notification_preferences', 'user_id'],
      ['push_tokens', 'user_id'],
    ] as const) {
      const { rows } = await db.query<{ n: number }>(
        `select count(*)::int as n from ${table} where ${column} = $1`, [sam.userId]
      );
      eq(`${table} is emptied`, rows[0]?.n, 0);
    }

    const { rows: invites } = await db.query<{ n: number }>(
      `select count(*)::int as n from invites where lower(email) = $1 and status = 'PENDING'`,
      [samEmail.toLowerCase()]
    );
    eq('a pending invite to the released address is revoked', invites[0]?.n, 0);

    /*
     * THE ASSERTION THAT EITHER PROVES §13.1'S ANSWER OR EXPOSES IT (§12.11).
     *
     * The hours still price and total exactly as before on the hiring company's
     * approved project, and the invoice does not move by a cent.
     */
    const { rows: preservedLog } = await db.query<{ resolved_rate: any; logged_by_user_id: string }>(
      `select resolved_rate, logged_by_user_id from time_logs where id = $1`, [samLogId]
    );
    eq('the hours survive', preservedLog.length, 1);
    eq('...still attributed to the withdrawn person', preservedLog[0]?.logged_by_user_id, sam.userId);
    eq('...at the rate they were frozen at', preservedLog[0]?.resolved_rate?.costCents, 20000);

    const summaryAfter = await call('GET', `/v1/projects/${projectId}/summary`, {
      token: owner.token, companyId: meridian,
    });
    eq('the hiring company\u2019s labour cost does not move by a cent',
      summaryAfter.json.summary.laborCostCents, summaryBefore.json.summary.laborCostCents);
    eq('...nor the bill', summaryAfter.json.summary.billCents, summaryBefore.json.summary.billCents);
    eq('...nor the margin', summaryAfter.json.summary.marginCents, summaryBefore.json.summary.marginCents);

    // ── 6. Recorded, with counts (§12.12) ──────────────────────────────────
    const { rows: platformAudit } = await db.query<{ changes: any; description: string }>(
      `select changes, description from platform_audit_logs
        where action = 'account.closed' and entity_id = $1`,
      [sam.userId]
    );
    eq('the closure is in the platform trail', platformAudit.length, 1);
    check('...with what was preserved as a count',
      (platformAudit[0]?.changes?.counts?.preserved?.time_logs ?? 0) >= 1,
      platformAudit[0]?.changes?.counts?.preserved);
    check('...and what was removed',
      (platformAudit[0]?.changes?.counts?.removed?.memberships ?? 0) >= 1,
      platformAudit[0]?.changes?.counts?.removed);
    // Counts, never contents: a payload describing what was deleted, sitting in a
    // permanent record, would be a copy of the thing somebody asked to have removed.
    check('...and never a row of the data itself',
      !JSON.stringify(platformAudit[0]?.changes ?? {}).includes(samEmail));

    const { rows: record } = await db.query<{ status: string; contact_email: string | null; counts: any }>(
      `select status, contact_email, counts from deletion_requests where id = $1`, [liveRequestId]
    );
    eq('the request is COMPLETED', record[0]?.status, 'COMPLETED');
    check('...and has released the address it was holding', record[0]?.contact_email === null);

    // ── 7. The farewell reaches an address that no longer exists ───────────
    const { rows: farewell } = await db.query<{ recipient_email_snapshot: string | null; status: string }>(
      `select d.recipient_email_snapshot, d.status
         from notification_deliveries d join notifications n on n.id = d.notification_id
        where n.kind = 'account.closure_completed' and n.recipient_user_id = $1`,
      [sam.userId]
    );
    eq('the closure is confirmed by email', farewell.length, 1);
    /*
     * §6's finding, and the reason this column exists: `notification_deliveries`
     * resolves an address by joining `users` at send time, and by now that join
     * returns the tombstone. Without the snapshot the last message the product owes
     * anybody would be addressed to nowhere.
     */
    eq('...to the address captured before the run', farewell[0]?.recipient_email_snapshot, samEmail);

    await drainWorkers();
    const { rows: afterSend } = await db.query<{ recipient_email_snapshot: string | null; status: string }>(
      `select d.recipient_email_snapshot, d.status
         from notification_deliveries d join notifications n on n.id = d.notification_id
        where n.kind = 'account.closure_completed' and n.recipient_user_id = $1`,
      [sam.userId]
    );
    check('...and the address is released once the delivery is terminal',
      afterSend[0]?.recipient_email_snapshot === null,
      { snapshot: afterSend[0]?.recipient_email_snapshot, status: afterSend[0]?.status });

    // The consequence of not retaining a hash of the old address, stated in the
    // policy and asserted here rather than left as a claim.
    const reregister = await call('POST', '/v1/auth/register', {
      body: { email: samEmail, password: 'Different-passw0rd!', name: 'Somebody else' },
    });
    check('the released address can be registered again', reregister.status === 201, reregister.status);

    // ── 8. An office has to be handed over first ───────────────────────────
    const soleOwner = await call('POST', '/v1/me/closure', {
      token: providerUser.token,
      body: { confirm: `provider+${RUN}@verify.crewquo.test`, password: 'Verify-passw0rd!' },
    });
    eq('the only owner of a company cannot simply leave', soleOwner.status, 409);
    check('...and is told which company to hand over',
      String(soleOwner.json?.error?.message ?? '').includes('Northgate'),
      soleOwner.json?.error?.message);
  }

  section('Closure of a company (settle or hand over; the counterparty is told)');
  {
    // ── 1. A company with a live engagement may ask, and is told to settle ─
    const asked = await call('POST', `/v1/companies/${northgate}/closure`, {
      token: providerUser.token,
      companyId: northgate,
      body: { confirm: `Northgate Electrical ${RUN}`, password: 'Verify-passw0rd!' },
    });
    /*
     * ACCEPTED DESPITE A LIVE ENGAGEMENT, and that ordering is the finding rather
     * than laxity. §6 requires every counterparty with a live engagement to be told
     * when a company starts closing itself, precisely so they can settle or hand
     * over — so refusing the request while an engagement is live would mean that
     * notice could never be sent, and the customer would be told "end your
     * engagements" with no way to tell the other side why.
     */
    eq('a company with live engagements may still schedule a closure', asked.status, 201);
    const northgateRequest = asked.json.request.id as string;

    const wrongCompanyName = await call('POST', `/v1/companies/${meridian}/closure`, {
      token: owner.token,
      companyId: meridian,
      body: { confirm: 'Not The Company', password: 'Verify-passw0rd!' },
    });
    eq('a mistyped company name is refused', wrongCompanyName.status, 422);

    await drainWorkers();

    const { rows: insiderNotice } = await db.query<{ n: number }>(
      `select count(*)::int as n from notifications
        where kind = 'company.closure_scheduled' and recipient_user_id = $1
          and company_id = $2`,
      [providerUser.userId, northgate]
    );
    eq('every owner and admin of the closing company is told', insiderNotice[0]?.n, 1);

    const { rows: counterparty } = await db.query<{ body: string; company_id: string | null }>(
      `select body, company_id from notifications
        where kind = 'company.closure_scheduled' and recipient_user_id = $1`,
      [owner.userId]
    );
    eq('the counterparty with a live engagement is told too', counterparty.length, 1);
    // §6: what they are told is that the relationship is ending — never the reason,
    // which is the closing company's business. The reason was supplied on the
    // request and must not appear.
    check('...that the relationship is ending, and their records stay theirs',
      /remain yours|stay exactly as they are/i.test(counterparty[0]?.body ?? ''),
      counterparty[0]?.body);
    check('...in their own inbox rather than a tenant they do not belong to',
      counterparty[0]?.company_id === null);

    const trail = await call('GET', '/v1/audit-logs', {
      token: providerUser.token, companyId: northgate,
    });
    const closureRow = trail.json.data.find((r: any) => r.action === 'company.closure_requested');
    check('the request is on the company\u2019s own trail', Boolean(closureRow));
    check('...and is never client-visible', closureRow?.visibleToClient === false);

    // ── 2. The run waits, visibly, rather than never happening ─────────────
    await db.query(
      `update deletion_requests set scheduled_for = now() - interval '1 minute' where id = $1`,
      [northgateRequest]
    );
    const blockedPass = await runClosurePass();
    eq('a due closure with a live engagement is blocked, not run', blockedPass.blocked, 1);
    eq('...and is not counted as a failure', blockedPass.failed, 0);

    const { rows: blocked } = await db.query<{ status: string; blocked_reason: string | null }>(
      `select status, blocked_reason from deletion_requests where id = $1`, [northgateRequest]
    );
    eq('...returning to SCHEDULED so it can run once settled', blocked[0]?.status, 'SCHEDULED');
    check('...with a reason the owner can act on',
      /engagement/i.test(blocked[0]?.blocked_reason ?? ''), blocked[0]?.blocked_reason);

    const { rows: notClosed } = await db.query<{ closed_at: Date | null; name: string }>(
      `select closed_at, name from companies where id = $1`, [northgate]
    );
    check('nothing was closed', notClosed[0]?.closed_at === null);

    const visible = await call('GET', `/v1/companies/${northgate}/closure`, {
      token: providerUser.token, companyId: northgate,
    });
    check('the block is on the owner\u2019s own screen, not only in a log',
      /engagement/i.test(visible.json.request?.blockedReason ?? ''),
      visible.json.request?.blockedReason);

    const stopped = await call('DELETE', `/v1/companies/${northgate}/closure`, {
      token: providerUser.token, companyId: northgate,
    });
    eq('the closure is stopped', stopped.status, 200);
    await drainWorkers();
    const { rows: told } = await db.query<{ n: number }>(
      `select count(*)::int as n from notifications
        where kind = 'company.closure_cancelled' and recipient_user_id = $1`,
      [owner.userId]
    );
    eq('the counterparty is told it is continuing', told[0]?.n, 1);

    // ── 3. Denied (§12.10) ─────────────────────────────────────────────────
    const closer = await register('closer', `Wind Down Ltd ${RUN}`);
    const closerCompany = closer.companyId!;
    await subscribe(closerCompany, 'pro');

    const adminEmail = `winddown-admin+${RUN}@verify.crewquo.test`;
    const adminInvite = await call('POST', '/v1/members/invite', {
      token: closer.token, companyId: closerCompany, body: { email: adminEmail, role: 'ADMIN' },
    });
    const adminUser = await register('winddown-admin', undefined, adminEmail);
    await call('POST', `/v1/invites/${adminInvite.json.inviteToken}/accept`, {
      token: adminUser.token,
    });

    const adminAttempt = await call('POST', `/v1/companies/${closerCompany}/closure`, {
      token: adminUser.token,
      companyId: closerCompany,
      body: { confirm: `Wind Down Ltd ${RUN}`, password: 'Verify-passw0rd!' },
    });
    // An admin can be appointed in a minute and does not own the subscription, the
    // liability or the relationships this ends.
    eq('an ADMIN cannot close a company', adminAttempt.status, 403);

    const adminSees = await call('GET', `/v1/companies/${closerCompany}/closure`, {
      token: adminUser.token, companyId: closerCompany,
    });
    // Deliberately not the same check twice: an admin who can see a scheduled closure
    // and stop it is the protection against an owner acting alone or under duress.
    eq('...but can see one, and stop it', adminSees.status, 200);

    // ── 4. A settled company closes, and keeps its name ────────────────────
    const closeIt = await call('POST', `/v1/companies/${closerCompany}/closure`, {
      token: closer.token,
      companyId: closerCompany,
      body: { confirm: `Wind Down Ltd ${RUN}`, password: 'Verify-passw0rd!' },
    });
    eq('an owner closes a settled company', closeIt.status, 201);
    const closerRequest = closeIt.json.request.id as string;
    await drainWorkers();
    await db.query(
      `update deletion_requests set scheduled_for = now() - interval '1 minute' where id = $1`,
      [closerRequest]
    );
    const companyRun = await runClosurePass();
    eq('the closure runs', companyRun.completed, 1);

    const { rows: closedCompany } = await db.query<{ closed_at: Date | null; name: string }>(
      `select closed_at, name from companies where id = $1`, [closerCompany]
    );
    check('the company is closed', closedCompany[0]?.closed_at !== null);
    /*
     * §10, and the reason a company is *closed* rather than anonymised: its name is
     * the counterparty's record of who they traded with. Renaming it would buy a
     * legal person's privacy with the falsification of somebody else's books.
     */
    eq('...keeping the name its counterparties traded with', closedCompany[0]?.name,
      `Wind Down Ltd ${RUN}`);

    const { rows: seats } = await db.query<{ n: number }>(
      `select count(*)::int as n from memberships where company_id = $1`, [closerCompany]
    );
    eq('nobody can act as it any more', seats[0]?.n, 0);

    const { rows: sub } = await db.query<{ status: string }>(
      `select status from company_subscriptions where company_id = $1`, [closerCompany]
    );
    eq('the subscription is cancelled rather than deleted', sub[0]?.status, 'CANCELED');

    const afterClose = await call('GET', `/v1/companies/${closerCompany}`, {
      token: closer.token, companyId: closerCompany,
    });
    eq('and the former owner has no way back in', afterClose.status, 403);

    // ── 5. The plan is exhaustive against the real schema ──────────────────
    /*
     * The same class of check the export section learned to make. The plans are
     * hand-written table lists, so they drift the moment a migration renames
     * anything — and a step naming a table that no longer exists fails at run time,
     * inside the one transaction nobody wants to see roll back.
     */
    for (const [scopeName, plan] of [
      ['PERSONAL', PERSONAL_CLOSURE_PLAN],
      ['COMPANY', COMPANY_CLOSURE_PLAN],
    ] as const) {
      const missing: string[] = [];
      for (const step of plan) {
        const { rows } = await db.query<{ n: number }>(
          `select count(*)::int as n from information_schema.tables where table_name = $1`,
          [step.table]
        );
        if ((rows[0]?.n ?? 0) === 0) missing.push(`${scopeName}.${step.table}`);
      }
      check(`every ${scopeName} closure step names a table that exists`,
        missing.length === 0, missing);
    }
  }

  // ── Paddle webhook reconciliation ────────────────────────────────────────
  section('Paddle webhook reconciliation');
  const billingOwner = await register('billing-owner', `Billing Co ${RUN}`);
  const paddlePriceId = `pri_verify_${RUN}`;
  const paddleSubscriptionId = `sub_verify_${RUN}`;
  const paddleEventId = `evt_verify_${RUN}_new`;
  const { rows: billingPrices } = await db.query<{ id: string }>(
    `update plan_prices set provider_price_id = $1, active = true, updated_at = now()
      where plan_id = 'pro' and currency = 'USD' and interval = 'MONTH'
      returning id`,
    [paddlePriceId]
  );
  const planPriceId = billingPrices[0]!.id;
  const occurredAt = new Date().toISOString();
  const paddlePayload = {
    event_id: paddleEventId,
    event_type: 'subscription.created',
    occurred_at: occurredAt,
    data: {
      id: paddleSubscriptionId,
      status: 'active',
      customer_id: `ctm_verify_${RUN}`,
      items: [{ price: { id: paddlePriceId } }],
      current_billing_period: { ends_at: new Date(Date.now() + 30 * 86_400_000).toISOString() },
      trial_dates: null,
      scheduled_change: null,
      custom_data: {
        crewquo_company_id: billingOwner.companyId,
        crewquo_plan_price_id: planPriceId,
      },
    },
  };
  const bodySha256 = createHash('sha256').update(JSON.stringify(paddlePayload)).digest('hex');
  const firstReceipt = await recordVerifiedWebhook({
    provider: 'PADDLE', externalEventId: paddleEventId,
    eventType: paddlePayload.event_type, bodySha256, payload: paddlePayload,
  });
  const duplicateReceipt = await recordVerifiedWebhook({
    provider: 'PADDLE', externalEventId: paddleEventId,
    eventType: paddlePayload.event_type, bodySha256, payload: paddlePayload,
  });
  check('the first verified Paddle event is persisted once', !firstReceipt.duplicate);
  check('a redelivery with the same event id and body is deduplicated', duplicateReceipt.duplicate);

  const billingPass = await runInboxBatch({
    workerId: `verify-billing-${RUN}`,
    handlers: BILLING_INBOX_HANDLERS,
  });
  eq('the inbox worker processes the subscription event', billingPass.processed, 1);
  const { rows: reconciled } = await db.query<{
    plan_id: string; status: string; provider: string; provider_subscription_id: string;
    entitlements_snapshot: { planId?: string } | null;
  }>(
    `select plan_id, status, provider, provider_subscription_id, entitlements_snapshot
       from company_subscriptions where company_id = $1`,
    [billingOwner.companyId]
  );
  eq('the Paddle subscription becomes the company subscription', {
    plan: reconciled[0]?.plan_id,
    status: reconciled[0]?.status,
    provider: reconciled[0]?.provider,
    providerId: reconciled[0]?.provider_subscription_id,
  }, { plan: 'pro', status: 'ACTIVE', provider: 'PADDLE', providerId: paddleSubscriptionId });
  eq('the paid entitlement definition is frozen on the subscription',
    reconciled[0]?.entitlements_snapshot?.planId, 'pro');

  const olderPayload = {
    ...paddlePayload,
    event_id: `evt_verify_${RUN}_old`,
    event_type: 'subscription.canceled',
    occurred_at: new Date(Date.parse(occurredAt) - 60_000).toISOString(),
    data: { ...paddlePayload.data, status: 'canceled' },
  };
  await recordVerifiedWebhook({
    provider: 'PADDLE', externalEventId: olderPayload.event_id,
    eventType: olderPayload.event_type,
    bodySha256: createHash('sha256').update(JSON.stringify(olderPayload)).digest('hex'),
    payload: olderPayload,
  });
  await runInboxBatch({ workerId: `verify-billing-old-${RUN}`, handlers: BILLING_INBOX_HANDLERS });
  const { rows: afterOlder } = await db.query<{ status: string }>(
    `select status from company_subscriptions where company_id = $1`, [billingOwner.companyId]
  );
  eq('an older cancellation delivered later cannot roll subscription state backward',
    afterOlder[0]?.status, 'ACTIVE');

  const billingOverview = await call('GET', '/v1/billing', {
    token: billingOwner.token,
    companyId: billingOwner.companyId!,
  });
  eq('the customer billing surface returns the reconciled state', billingOverview.status, 200);
  eq('checkout stays off without operator enablement and Paddle configuration',
    billingOverview.json.checkoutEnabled, false);

  // ── Public pricing ────────────────────────────────────────────────────────
  section('Public pricing');
  const pricing = await call('GET', '/v1/public/pricing');
  eq('the pricing catalog is readable with no session at all', pricing.status, 200);
  check('...and lists more than one plan', (pricing.json.plans?.length ?? 0) > 1,
    pricing.json.plans?.length);
  const freePlan = pricing.json.plans?.find((plan: any) => plan.id === 'crew');
  eq('...including the free plan, whose absence of a price is the product decision',
    { found: Boolean(freePlan), prices: freePlan?.prices?.length }, { found: true, prices: 0 });
  const pricedPlan = pricing.json.plans?.find((plan: any) => plan.prices?.length > 0);
  eq('...and at least one plan with a real USD amount',
    { currency: pricedPlan?.prices?.[0]?.currency, positive: pricedPlan?.prices?.[0]?.amountCents > 0 },
    { currency: 'USD', positive: true });
  /*
   * Two leaks this endpoint is the likeliest place for, both asserted on the whole
   * serialised body rather than on a field, because a field assertion only covers
   * the field somebody remembered.
   *
   * A `pri_…` is Paddle's own identifier and belongs to the merchant account, not
   * the customer; `checkoutEnabled` is a platform setting, and a public read that
   * reports it publishes operator configuration to anybody who asks.
   */
  const pricingBody = JSON.stringify(pricing.json);
  check('no provider price id reaches the public catalog', !pricingBody.includes('pri_'));
  check('no platform setting reaches the public catalog', !pricingBody.includes('checkoutEnabled'));
  check('...and it is the one response this API lets a cache keep',
    (pricing.headers.get('cache-control') ?? '').includes('public'),
    pricing.headers.get('cache-control'));

  // ── The additional-company checkout (§3.1.1(3)) ───────────────────────────
  section('Additional-company checkout');

  /*
   * The operator flag, saved and restored.
   *
   * Every run of this script must start from the same state — an earlier section
   * asserts checkout is *off* — so leaving it on would make the second run
   * disagree with the first for a reason that has nothing to do with the code.
   */
  const { rows: settingsBefore } = await db.query<{ value: Record<string, unknown> }>(
    `select value from system_settings where key = 'platform.company_creation'`
  );
  const priorCreationSettings = settingsBefore[0]?.value ?? null;
  await db.query(
    `insert into system_settings (key, value) values ('platform.company_creation', $1::jsonb)
     on conflict (key) do update set value = excluded.value, updated_at = now()`,
    [JSON.stringify({ ...(priorCreationSettings ?? {}), checkoutEnabled: true })]
  );

  const buyer = await register('addco-buyer', `Add Co ${RUN}`);
  await db.query(`update users set email_verified_at = now() where id = $1`, [buyer.userId]);
  const paidFiled = await call('POST', '/v1/company-creation-requests', {
    token: buyer.token,
    body: {
      legalName: `Second Add Co ${RUN}`,
      country: 'PH',
      intendedPlanId: 'pro',
      attestation: true,
      password: 'Verify-passw0rd!',
    },
  });
  eq('a paid additional-company request routes to checkout rather than to review',
    { status: paidFiled.json.request?.status, route: paidFiled.json.request?.approvalRoute },
    { status: 'PENDING_CHECKOUT', route: 'CHECKOUT' });
  const paidRequestId = paidFiled.json.request.id as string;

  // A stranger's request id is a 404, and it is a 404 *before* anything about our
  // merchant configuration is disclosed — the refusal order is the policy.
  const paidStranger = await register('addco-stranger');
  const strangerTry = await call('POST', `/v1/company-creation-requests/${paidRequestId}/checkout`, {
    token: paidStranger.token,
    body: { priceId: planPriceId },
  });
  eq('somebody else\'s request is a 404, not a 403 that confirms it exists',
    strangerTry.status, 404);

  const unconfigured = await call('POST', `/v1/company-creation-requests/${paidRequestId}/checkout`, {
    token: buyer.token,
    body: { priceId: planPriceId },
  });
  eq('the requester is told checkout is not configured, as a conflict', unconfigured.status, 409);
  const { rows: noAttempt } = await db.query<{ n: number }>(
    `select count(*)::int as n from billing_checkouts where company_creation_request_id = $1`,
    [paidRequestId]
  );
  eq('...and no half-created attempt is left behind by the refusal', noAttempt[0]?.n, 0);

  /*
   * The transaction Paddle would have created, inserted directly.
   *
   * The provider call needs live credentials and is not what this script can
   * prove; everything downstream of it is ours, and that is what is under test —
   * a completed payment is what moves the request to APPROVED.
   */
  const requestTxnId = `txn_verify_${RUN}`;
  const { rows: attemptRows } = await db.query<{ id: string }>(
    `insert into billing_checkouts
       (company_creation_request_id, requested_by_user_id, plan_price_id, provider,
        provider_transaction_id, checkout_url, status)
     values ($1, $2, $3, 'PADDLE', $4, 'https://pay.paddle.test/verify', 'PENDING')
     returning id`,
    [paidRequestId, buyer.userId, planPriceId, requestTxnId]
  );
  const attemptId = attemptRows[0]!.id;

  async function deliverPaddle(payload: Record<string, unknown>): Promise<void> {
    await recordVerifiedWebhook({
      provider: 'PADDLE',
      externalEventId: payload.event_id as string,
      eventType: payload.event_type as string,
      bodySha256: createHash('sha256').update(JSON.stringify(payload)).digest('hex'),
      payload,
    });
  }

  const requestCustomData = {
    crewquo_checkout_id: attemptId,
    crewquo_company_request_id: paidRequestId,
    crewquo_plan_price_id: planPriceId,
    crewquo_user_id: buyer.userId,
  };
  await deliverPaddle({
    event_id: `evt_verify_${RUN}_txn`,
    event_type: 'transaction.completed',
    occurred_at: new Date().toISOString(),
    data: { id: requestTxnId, custom_data: requestCustomData },
  });
  const txnPass = await runInboxBatch({
    workerId: `verify-req-txn-${RUN}`,
    handlers: BILLING_INBOX_HANDLERS,
  });
  eq('the completed transaction is reconciled',
    { processed: txnPass.processed, failed: txnPass.failed }, { processed: 1, failed: 0 });

  const { rows: approvedRows } = await db.query<{
    status: string; checkout_reference: string | null; decided_by_user_id: string | null;
    days_left: number;
  }>(
    `select status, checkout_reference, decided_by_user_id,
            round(extract(epoch from (expires_at - now())) / 86400)::int as days_left
       from company_creation_requests where id = $1`,
    [paidRequestId]
  );
  eq('a paid transaction is what moves the request to APPROVED',
    { status: approvedRows[0]?.status, reference: approvedRows[0]?.checkout_reference },
    { status: 'APPROVED', reference: requestTxnId });
  /*
   * `decided_by_user_id` stays null because nobody decided: a payment cleared.
   * Attributing it to the payer would read in the platform trail as the requester
   * having approved their own request, which is precisely the thing §3.1.1 exists
   * to make impossible.
   */
  eq('...with no human recorded as having approved it',
    approvedRows[0]?.decided_by_user_id, null);
  eq('...and the approval clock restarted at the full window',
    approvedRows[0]?.days_left, COMPANY_REQUEST_APPROVAL_DAYS);
  const { rows: attemptAfter } = await db.query<{ status: string }>(
    `select status from billing_checkouts where id = $1`, [attemptId]
  );
  eq('the checkout attempt is completed', attemptAfter[0]?.status, 'COMPLETED');

  const { rows: paidAudit } = await db.query<{ n: number; actor: string | null; source: string }>(
    `select count(*)::int as n, min(actor_user_id::text) as actor,
            min(changes ->> 'source') as source
       from platform_audit_logs
      where entity_id = $1 and action = 'company_creation_request.checkout_recorded'`,
    [paidRequestId]
  );
  eq('the platform trail records the payment as the decider',
    { rows: paidAudit[0]?.n, actor: paidAudit[0]?.actor, source: paidAudit[0]?.source },
    { rows: 1, actor: null, source: 'PADDLE_TRANSACTION' });

  // A redelivery under a new event id must not approve twice or fail. Paddle
  // retries, and an audit trail that gains a row per retry is a trail that
  // cannot answer "how many times was this approved".
  await deliverPaddle({
    event_id: `evt_verify_${RUN}_txn_again`,
    event_type: 'transaction.completed',
    occurred_at: new Date().toISOString(),
    data: { id: requestTxnId, custom_data: requestCustomData },
  });
  const replayPass = await runInboxBatch({
    workerId: `verify-req-txn2-${RUN}`,
    handlers: BILLING_INBOX_HANDLERS,
  });
  const { rows: auditAfterReplay } = await db.query<{ n: number }>(
    `select count(*)::int as n from platform_audit_logs
      where entity_id = $1 and action = 'company_creation_request.checkout_recorded'`,
    [paidRequestId]
  );
  eq('a redelivered completion is a no-op rather than a second approval',
    { processed: replayPass.processed, failed: replayPass.failed, auditRows: auditAfterReplay[0]?.n },
    { processed: 1, failed: 0, auditRows: 1 });

  /*
   * The subscription the payment created, arriving before the company exists.
   *
   * This is the ordering the whole deferral mechanism is for: the money is taken
   * at checkout and the tenant is created by a separate, deliberate act that the
   * approval gives the customer thirty days to perform. The retry budget is eight
   * attempts over about seventy minutes, so retrying would dead-letter a paid
   * subscription within the hour.
   */
  const requestSubId = `sub_verify_req_${RUN}`;
  const requestSubEventId = `evt_verify_${RUN}_sub`;
  const requestSubEvent = {
    event_id: requestSubEventId,
    event_type: 'subscription.created',
    occurred_at: new Date().toISOString(),
    data: {
      id: requestSubId,
      status: 'active',
      customer_id: `ctm_verify_req_${RUN}`,
      items: [{ price: { id: paddlePriceId } }],
      current_billing_period: { ends_at: new Date(Date.now() + 30 * 86_400_000).toISOString() },
      trial_dates: null,
      scheduled_change: null,
      custom_data: requestCustomData,
    },
  };
  await deliverPaddle(requestSubEvent);
  const deferPass = await runInboxBatch({
    workerId: `verify-req-defer-${RUN}`,
    handlers: BILLING_INBOX_HANDLERS,
  });
  eq('a paid subscription whose company does not exist yet is deferred, not failed',
    { processed: deferPass.processed, deferred: deferPass.deferred, failed: deferPass.failed },
    { processed: 0, deferred: 1, failed: 0 });
  const { rows: parked } = await db.query<{ status: string; attempts: number; later: boolean }>(
    `select status, attempts, available_at > now() as later from webhook_inbox
      where external_event_id = $1`,
    [requestSubEventId]
  );
  eq('...with its retry budget untouched and a future availability',
    { status: parked[0]?.status, attempts: parked[0]?.attempts, later: parked[0]?.later },
    { status: 'RECEIVED', attempts: 0, later: true });

  const createdCompany = await call('POST', '/v1/me/companies', {
    token: buyer.token,
    body: { name: `Second Add Co ${RUN}`, currency: 'USD', requestId: paidRequestId },
  });
  eq('the approval creates the additional company', createdCompany.status, 201);
  const secondCompanyId = createdCompany.json.company?.id as string;
  const { rows: woken } = await db.query<{ ready: boolean }>(
    `select available_at <= now() as ready from webhook_inbox where external_event_id = $1`,
    [requestSubEventId]
  );
  // Without this the customer would spend the deferral interval on the free plan
  // having already been charged, which is the worst quarter of an hour in the flow.
  check('creating the company wakes the parked subscription immediately', woken[0]?.ready === true);

  const attachPass = await runInboxBatch({
    workerId: `verify-req-attach-${RUN}`,
    handlers: BILLING_INBOX_HANDLERS,
  });
  eq('the parked subscription then applies',
    { processed: attachPass.processed, deferred: attachPass.deferred, failed: attachPass.failed },
    { processed: 1, deferred: 0, failed: 0 });
  const { rows: secondSub } = await db.query<{
    plan_id: string; status: string; provider_subscription_id: string;
    entitlements_snapshot: { planId?: string } | null;
  }>(
    `select plan_id, status, provider_subscription_id, entitlements_snapshot
       from company_subscriptions where company_id = $1`,
    [secondCompanyId]
  );
  eq('...attaching the paid plan to the company it was bought for',
    { plan: secondSub[0]?.plan_id, status: secondSub[0]?.status,
      providerId: secondSub[0]?.provider_subscription_id,
      snapshot: secondSub[0]?.entitlements_snapshot?.planId },
    { plan: 'pro', status: 'ACTIVE', providerId: requestSubId, snapshot: 'pro' });

  /*
   * And the bound on waiting. A deferral that could not end would hide a paid
   * subscription attached to nothing for ever, so an approval that can no longer
   * become a company dead-letters instead — which is the signal an operator needs
   * in order to refund it.
   */
  const lapser = await register('addco-lapser', `Lapse Co ${RUN}`);
  await db.query(`update users set email_verified_at = now() where id = $1`, [lapser.userId]);
  const lapsedFiled = await call('POST', '/v1/company-creation-requests', {
    token: lapser.token,
    body: {
      legalName: `Lapsed Add Co ${RUN}`,
      country: 'PH',
      intendedPlanId: 'pro',
      attestation: true,
      password: 'Verify-passw0rd!',
    },
  });
  const lapsedRequestId = lapsedFiled.json.request.id as string;
  const { rows: lapsedAttempt } = await db.query<{ id: string }>(
    `insert into billing_checkouts
       (company_creation_request_id, requested_by_user_id, plan_price_id, provider,
        provider_transaction_id, status)
     values ($1, $2, $3, 'PADDLE', $4, 'PENDING') returning id`,
    [lapsedRequestId, lapser.userId, planPriceId, `txn_verify_lapsed_${RUN}`]
  );
  await db.query(
    `update company_creation_requests set expires_at = now() - interval '1 day' where id = $1`,
    [lapsedRequestId]
  );
  await deliverPaddle({
    event_id: `evt_verify_${RUN}_sub_lapsed`,
    event_type: 'subscription.created',
    occurred_at: new Date().toISOString(),
    data: {
      ...requestSubEvent.data,
      id: `sub_verify_lapsed_${RUN}`,
      custom_data: {
        crewquo_checkout_id: lapsedAttempt[0]!.id,
        crewquo_company_request_id: lapsedRequestId,
        crewquo_plan_price_id: planPriceId,
      },
    },
  });
  const lapsedPass = await runInboxBatch({
    workerId: `verify-req-lapsed-${RUN}`,
    handlers: BILLING_INBOX_HANDLERS,
  });
  const { rows: lapsedInbox } = await db.query<{ status: string; last_error: string | null }>(
    `select status, last_error from webhook_inbox where external_event_id = $1`,
    [`evt_verify_${RUN}_sub_lapsed`]
  );
  eq('a paid subscription for an expired approval dead-letters instead of waiting for ever',
    { failed: lapsedPass.failed, deferred: lapsedPass.deferred, status: lapsedInbox[0]?.status },
    { failed: 1, deferred: 0, status: 'DEAD_LETTER' });
  check('...naming the operator decision it needs',
    (lapsedInbox[0]?.last_error ?? '').includes('operator decision'), lapsedInbox[0]?.last_error);

  // One subject per attempt, and one live attempt per request — both refused by
  // the database rather than by a comment.
  let bothSubjects = false;
  try {
    await db.query(
      `insert into billing_checkouts (company_id, company_creation_request_id, plan_price_id, provider)
       values ($1, $2, $3, 'PADDLE')`,
      [buyer.companyId, lapsedRequestId, planPriceId]
    );
  } catch { bothSubjects = true; }
  check('a checkout attempt cannot name both a company and a request', bothSubjects);

  let noSubject = false;
  try {
    await db.query(
      `insert into billing_checkouts (plan_price_id, provider) values ($1, 'PADDLE')`,
      [planPriceId]
    );
  } catch { noSubject = true; }
  check('...nor neither, which would be a payment attributable to nobody', noSubject);

  let secondLiveAttempt = false;
  try {
    await db.query(
      `insert into billing_checkouts
         (company_creation_request_id, plan_price_id, provider, status)
       values ($1, $2, 'PADDLE', 'PENDING')`,
      [lapsedRequestId, planPriceId]
    );
  } catch { secondLiveAttempt = true; }
  check('a request cannot have two live checkout attempts at once', secondLiveAttempt);

  await db.query(
    priorCreationSettings === null
      ? `delete from system_settings where key = 'platform.company_creation'`
      : `update system_settings set value = $1::jsonb, updated_at = now()
           where key = 'platform.company_creation'`,
    priorCreationSettings === null ? [] : [JSON.stringify(priorCreationSettings)]
  );
  const { rows: settingsAfter } = await db.query<{ enabled: boolean | null }>(
    `select (value ->> 'checkoutEnabled')::boolean as enabled from system_settings
      where key = 'platform.company_creation'`
  );
  check('the operator flag is left exactly as this script found it',
    (settingsAfter[0]?.enabled ?? false) === false, settingsAfter[0]?.enabled);

  // ── Subscription self-management ──────────────────────────────────────────
  section('Subscription self-management');

  const freePlanCancel = await call('POST', '/v1/billing/subscription/cancel', {
    token: buyer.token,
    companyId: buyer.companyId!,
  });
  eq('cancelling a company with no subscription is a conflict, not a 404',
    freePlanCancel.status, 409);

  /*
   * A plan a super admin set by hand, or comped as a trial, has no provider
   * subscription to cancel. Offering the button anyway would be offering a button
   * whose only possible outcome is an error — so the refusal names support, and
   * the read that drives the screen says the same thing.
   */
  await db.query(
    `insert into company_subscriptions (company_id, plan_id, status)
     values ($1, 'pro', 'ACTIVE')
     on conflict (company_id) do update set plan_id = 'pro', status = 'ACTIVE',
       provider = null, provider_subscription_id = null, updated_at = now()`,
    [buyer.companyId]
  );
  const supportSetCancel = await call('POST', '/v1/billing/subscription/cancel', {
    token: buyer.token,
    companyId: buyer.companyId!,
  });
  eq('a support-set plan cannot be cancelled through the provider', supportSetCancel.status, 409);
  check('...and the refusal points at support rather than at the customer',
    /support/i.test(supportSetCancel.json?.error?.message ?? ''),
    supportSetCancel.json?.error?.message);
  const supportSetOverview = await call('GET', '/v1/billing', {
    token: buyer.token,
    companyId: buyer.companyId!,
  });
  eq('...and the screen is told not to offer the controls at all',
    { provider: supportSetOverview.json.subscription?.provider,
      selfManageable: supportSetOverview.json.subscription?.selfManageable },
    { provider: null, selfManageable: false });

  const paddleOverview = await call('GET', '/v1/billing', {
    token: billingOwner.token,
    companyId: billingOwner.companyId!,
  });
  eq('a Paddle subscription is reported as the customer\'s own to manage',
    { provider: paddleOverview.json.subscription?.provider,
      selfManageable: paddleOverview.json.subscription?.selfManageable },
    { provider: 'PADDLE', selfManageable: true });

  // With no API key there is nothing to call Paddle with, and saying "Paddle
  // refused this change" would send somebody looking at their card for a problem
  // that is entirely ours.
  const noCredentials = await call('POST', '/v1/billing/subscription/cancel', {
    token: billingOwner.token,
    companyId: billingOwner.companyId!,
  });
  eq('a provider-managed cancellation is refused while credentials are missing',
    noCredentials.status, 409);
  check('...saying so, and saying nothing was charged',
    /not available yet/i.test(noCredentials.json?.error?.message ?? ''),
    noCredentials.json?.error?.message);
  const { rows: untouched } = await db.query<{ cancel_at_period_end: boolean; status: string }>(
    `select cancel_at_period_end, status from company_subscriptions where company_id = $1`,
    [billingOwner.companyId]
  );
  eq('...and the subscription is genuinely untouched by the refusal',
    { scheduled: untouched[0]?.cancel_at_period_end, status: untouched[0]?.status },
    { scheduled: false, status: 'ACTIVE' });

  // ── Capabilities (§37) — Phase 7 build order step 0 ───────────────────────
  section('Capabilities — bundles, the role-derived default, and the owner rule');

  const capOwner = await register('capowner', `CapCo ${RUN}`);
  const capCompany = capOwner.companyId!;
  // A fresh company is on `crew`, whose `internal_seats` is 1 — the section needs
  // three people in one company to have anything to say about job functions.
  await subscribe(capCompany, 'pro');

  const capWorkerInvite = await call('POST', '/v1/members/invite', {
    token: capOwner.token,
    companyId: capCompany,
    body: { email: `capworker+${RUN}@verify.crewquo.test`, role: 'MEMBER' },
  });
  const capWorker = await register('capworker', undefined, `capworker+${RUN}@verify.crewquo.test`);
  await call('POST', `/v1/invites/${capWorkerInvite.json.inviteToken}/accept`, {
    token: capWorker.token,
  });

  const capManagerInvite = await call('POST', '/v1/members/invite', {
    token: capOwner.token,
    companyId: capCompany,
    body: { email: `capmgr+${RUN}@verify.crewquo.test`, role: 'MANAGER' },
  });
  const capManager = await register('capmgr', undefined, `capmgr+${RUN}@verify.crewquo.test`);
  await call('POST', `/v1/invites/${capManagerInvite.json.inviteToken}/accept`, {
    token: capManager.token,
  });

  const capMembers = await call('GET', '/v1/members', {
    token: capOwner.token,
    companyId: capCompany,
  });
  const idOf = (email: string): string =>
    capMembers.json.data.find((m: any) => m.email === email)?.membershipId as string;
  const ownerMembershipId = idOf(capOwner.email);
  const workerMembershipId = idOf(capWorker.email);
  const managerMembershipId = idOf(capManager.email);

  // The catalog, and the assertion that matters most about it: the seed and the
  // code agree at runtime, not only in the unit test that reads the SQL file.
  const catalog = await call('GET', '/v1/capabilities', {
    token: capOwner.token,
    companyId: capCompany,
  });
  eq('the capability catalog is readable', catalog.status, 200);
  eq('...and holds §37\'s 29 keys', catalog.json.capabilities.length, CAPABILITY_KEYS.length);
  eq(
    '...matching the code exactly',
    catalog.json.capabilities.map((c: any) => c.key).sort(),
    [...CAPABILITY_KEYS].sort()
  );
  eq(
    '...with the six system bundles',
    catalog.json.bundles.filter((b: any) => b.isSystem).map((b: any) => b.key).sort(),
    [...SYSTEM_BUNDLE_KEYS].sort()
  );
  const seededSupervisor = catalog.json.bundles.find((b: any) => b.key === 'supervisor');
  eq(
    '...and the Supervisor bundle the database holds is the one the code declares',
    [...seededSupervisor.capabilities].sort(),
    [...SYSTEM_BUNDLE_CAPABILITIES.supervisor].sort()
  );

  // Behaviour preservation, which is the whole promise of this migration.
  const { rows: assignedBundles } = await db.query<{ n: string }>(
    `select count(*)::int as n from memberships where company_id = $1 and bundle_key is not null`,
    [capCompany]
  );
  eq('a new company has no bundle assigned to anybody', Number(assignedBundles[0]?.n), 0);

  const workerCaps = await call('GET', `/v1/members/${workerMembershipId}/capabilities`, {
    token: capOwner.token,
    companyId: capCompany,
  });
  eq('a MEMBER derives the Worker bundle', workerCaps.json.capabilities.effectiveBundleKey, 'worker');
  check('...and is marked as derived rather than assigned',
    workerCaps.json.capabilities.bundleIsDerived === true &&
      workerCaps.json.capabilities.bundleKey === null);
  eq(
    '...holding exactly the worker floor',
    [...workerCaps.json.capabilities.capabilities].sort(),
    [...SYSTEM_BUNDLE_CAPABILITIES.worker].sort()
  );

  const managerCaps = await call('GET', `/v1/members/${managerMembershipId}/capabilities`, {
    token: capOwner.token,
    companyId: capCompany,
  });
  eq('a MANAGER derives Project Manager', managerCaps.json.capabilities.effectiveBundleKey, 'project_manager');
  check('...which can read commercial figures',
    managerCaps.json.capabilities.capabilities.includes('commercial.read'));

  // The owner rule. `access.md` §13.3 refused platform support access, so a
  // company that locks its owner out has nobody to unlock it.
  const ownerCaps = await call('GET', `/v1/members/${ownerMembershipId}/capabilities`, {
    token: capOwner.token,
    companyId: capCompany,
  });
  eq('an OWNER holds every capability', ownerCaps.json.capabilities.capabilities.length, CAPABILITY_KEYS.length);
  check('...and is reported as locked', ownerCaps.json.capabilities.locked === true);
  const restrainOwner = await call('PATCH', `/v1/members/${ownerMembershipId}/capabilities`, {
    token: capOwner.token,
    companyId: capCompany,
    body: { bundleKey: 'worker' },
  });
  eq('...so restricting an owner is refused rather than silently ignored', restrainOwner.status, 403);

  // Assignment.
  const toSupervisor = await call('PATCH', `/v1/members/${workerMembershipId}/capabilities`, {
    token: capOwner.token,
    companyId: capCompany,
    body: { bundleKey: 'supervisor' },
  });
  eq('a member can be given the Supervisor bundle', toSupervisor.status, 200);
  check('...which lets them close a day',
    toSupervisor.json.capabilities.capabilities.includes('diary.close'));
  check('...and deliberately does NOT let them read margin',
    !toSupervisor.json.capabilities.capabilities.includes('commercial.read'));
  check('...and is now an assignment rather than a derivation',
    toSupervisor.json.capabilities.bundleIsDerived === false &&
      toSupervisor.json.capabilities.bundleKey === 'supervisor');

  // The caller's own resolved set follows, which is what a route will read.
  const workerSelf = await call('GET', '/v1/capabilities', {
    token: capWorker.token,
    companyId: capCompany,
  });
  check('the member\'s own resolved set agrees', workerSelf.json.mine.includes('diary.close'));
  check('...including the absence', !workerSelf.json.mine.includes('commercial.read'));

  const withOverrides = await call('PATCH', `/v1/members/${workerMembershipId}/capabilities`, {
    token: capOwner.token,
    companyId: capCompany,
    body: {
      overrides: [
        { capabilityKey: 'commercial.read', granted: true, note: 'covers for finance on Fridays' },
        { capabilityKey: 'diary.close', granted: false },
      ],
    },
  });
  eq('an override grants outside the bundle', withOverrides.status, 200);
  check('...adding the granted key',
    withOverrides.json.capabilities.capabilities.includes('commercial.read'));
  check('...and removing the revoked one',
    !withOverrides.json.capabilities.capabilities.includes('diary.close'));
  check('...while the bundle assignment is untouched',
    withOverrides.json.capabilities.effectiveBundleKey === 'supervisor');

  // Whole-set replacement: an empty array clears, rather than meaning "no change".
  const clearedOverrides = await call('PATCH', `/v1/members/${workerMembershipId}/capabilities`, {
    token: capOwner.token,
    companyId: capCompany,
    body: { overrides: [] },
  });
  eq('an empty override list clears the exceptions', clearedOverrides.json.capabilities.overrides.length, 0);
  check('...restoring the bundle answer',
    clearedOverrides.json.capabilities.capabilities.includes('diary.close') &&
      !clearedOverrides.json.capabilities.capabilities.includes('commercial.read'));

  const backToDerived = await call('PATCH', `/v1/members/${workerMembershipId}/capabilities`, {
    token: capOwner.token,
    companyId: capCompany,
    body: { bundleKey: null },
  });
  eq('clearing the bundle returns the membership to role-derived',
    backToDerived.json.capabilities.effectiveBundleKey, 'worker');
  check('...and says so', backToDerived.json.capabilities.bundleIsDerived === true);

  // Refusals.
  const unknownBundle = await call('PATCH', `/v1/members/${workerMembershipId}/capabilities`, {
    token: capOwner.token,
    companyId: capCompany,
    body: { bundleKey: 'wizard' },
  });
  eq('an unknown bundle is refused', unknownBundle.status, 422);

  const duplicateOverride = await call('PATCH', `/v1/members/${workerMembershipId}/capabilities`, {
    token: capOwner.token,
    companyId: capCompany,
    body: {
      overrides: [
        { capabilityKey: 'diary.close', granted: true },
        { capabilityKey: 'diary.close', granted: false },
      ],
    },
  });
  eq('two overrides for one key are refused, so array order never decides a permission',
    duplicateOverride.status, 422);

  const capEmptyPatch = await call('PATCH', `/v1/members/${workerMembershipId}/capabilities`, {
    token: capOwner.token,
    companyId: capCompany,
    body: {},
  });
  eq('an empty patch is refused rather than audited as a no-op', capEmptyPatch.status, 422);

  const memberEdits = await call('PATCH', `/v1/members/${managerMembershipId}/capabilities`, {
    token: capWorker.token,
    companyId: capCompany,
    body: { bundleKey: 'admin' },
  });
  eq('a MEMBER cannot grant themselves or anybody else a bundle', memberEdits.status, 403);

  const memberReads = await call('GET', `/v1/members/${managerMembershipId}/capabilities`, {
    token: capWorker.token,
    companyId: capCompany,
  });
  eq('...but may read who can do what, which is not a secret from colleagues',
    memberReads.status, 200);

  // Tenant boundary: a membership in another company answers exactly as one that
  // never existed, so the response reveals no cross-tenant existence.
  const capSameTenant = await call('GET', `/v1/members/${ownerMembershipId}/capabilities`, {
    token: capManager.token,
    companyId: capCompany,
  });
  eq('a membership in this company is found', capSameTenant.status, 200);
  const capOutsider = await register('capoutsider', `Outsider ${RUN}`);
  const capCrossTenant = await call('GET', `/v1/members/${workerMembershipId}/capabilities`, {
    token: capOutsider.token,
    companyId: capOutsider.companyId!,
  });
  eq('another company\'s membership is not found rather than forbidden', capCrossTenant.status, 404);
  const capMissing = await call('GET', `/v1/members/${randomUUID()}/capabilities`, {
    token: capOwner.token,
    companyId: capCompany,
  });
  eq('...answering identically to a membership that never existed', capMissing.status, 404);

  // The trail records what the person could do, not what the request said.
  const capTrail = await call('GET', '/v1/audit-logs', {
    token: capOwner.token,
    companyId: capCompany,
  });
  const capAudit = capTrail.json.data.find(
    (r: any) => r.action === 'membership.capabilities_updated'
  );
  check('a capability change is audited', Boolean(capAudit));
  check('...recording the resolved sets rather than the patch body',
    Array.isArray(capAudit?.changes?.capabilities?.from) &&
      Array.isArray(capAudit?.changes?.capabilities?.to),
    capAudit?.changes);
  check('...and is a distinct action from a role change',
    capTrail.json.data.some((r: any) => r.action === 'membership.capabilities_updated') &&
      capAudit.action !== 'membership.updated');

  // ── Storage service (§22.1) — Phase 7 build order step 3 ──────────────────
  section('Storage — presign, PUT, scan, derivatives and the meter');

  const stOwner = await register('stowner', `StorageCo ${RUN}`);
  const stCompany = stOwner.companyId!;
  await subscribe(stCompany, 'pro');

  // A real image, made here rather than checked in: the derivative assertions are
  // about pixels, and a fixture whose bytes nobody can decode proves nothing. The
  // first attempt used a hand-written 1×1 PNG and libpng refused it — which the
  // pipeline survived exactly as designed, storing the original and skipping the
  // preview, and told us nothing about resizing.
  const stPhoto = await sharpFactory()({
    create: { width: 2400, height: 1600, channels: 3, background: { r: 40, g: 90, b: 140 } },
  })
    .png()
    .toBuffer();
  const stChecksum = createHash('sha256').update(stPhoto).digest('hex');

  const stPresign = await call('POST', '/v1/files/presign', {
    token: stOwner.token,
    companyId: stCompany,
    body: {
      kind: 'IMAGE',
      filename: 'floor-3-before.png',
      contentType: 'image/png',
      byteSize: stPhoto.byteLength,
      clientId: randomUUID(),
    },
  });
  eq('a presign reserves an upload', stPresign.status, 201);
  check('...against a key derived from the company, never from the caller',
    typeof stPresign.json.uploadUrl === 'string' &&
      stPresign.json.uploadUrl.includes(`/co/${stCompany}/`),
    stPresign.json.uploadUrl?.slice(0, 120));
  check('...signed for the host the browser can actually reach',
    stPresign.json.uploadUrl.startsWith('http://127.0.0.1:9000/'),
    stPresign.json.uploadUrl?.slice(0, 60));

  const stPut = await fetch(stPresign.json.uploadUrl as string, {
    method: 'PUT',
    headers: stPresign.json.requiredHeaders as Record<string, string>,
    body: stPhoto,
  });
  eq('the bytes go straight to the store, never through the API', stPut.status, 200);

  // A replay must find its own row. Without this a retry from a bad connection
  // mints a second key and leaves an orphaned byte-charge for an object nothing
  // references — the one failure here that costs a customer money quietly.
  const stReplayId = randomUUID();
  const stFirst = await call('POST', '/v1/files/presign', {
    token: stOwner.token,
    companyId: stCompany,
    body: { kind: 'IMAGE', filename: 'r.png', contentType: 'image/png', byteSize: 100, clientId: stReplayId },
  });
  const stReplay = await call('POST', '/v1/files/presign', {
    token: stOwner.token,
    companyId: stCompany,
    body: { kind: 'IMAGE', filename: 'r.png', contentType: 'image/png', byteSize: 100, clientId: stReplayId },
  });
  eq('a replayed presign returns the same file', stReplay.json.fileId, stFirst.json.fileId);
  check('...and says it replayed rather than pretending to be new',
    stReplay.json.replayed === true && stFirst.json.replayed === false);
  const { rows: stOneRow } = await db.query<{ n: string }>(
    `select count(*)::int as n from stored_files where client_id = $1`,
    [stReplayId]
  );
  eq('...leaving exactly one row and one bucket key', Number(stOneRow[0]?.n), 1);

  const stComplete = await call('POST', `/v1/files/${stPresign.json.fileId}/complete`, {
    token: stOwner.token,
    companyId: stCompany,
    body: { checksumSha256: stChecksum },
  });
  eq('completing moves the file to SCANNING, not to READY', stComplete.json.file.status, 'SCANNING');

  // The whole reason SCANNING exists (§13.5): the API never receives the bytes,
  // so it cannot sniff a content type, and the worker that downloads the original
  // for derivatives is the only place the check can actually run.
  const stBatch = await runStorageBatch();
  check('the worker scans what completion handed it', stBatch.scanned >= 1, stBatch);

  const stAfter = await call('GET', `/v1/files/${stPresign.json.fileId}`, {
    token: stOwner.token,
    companyId: stCompany,
  });
  eq('...and it is the worker that sets READY', stAfter.json.file.status, 'READY');
  eq('...with two derivatives beside a retained original',
    (stAfter.json.derivatives as { variant: string }[]).map((d) => d.variant).sort(),
    ['THUMB', 'WEB']);
  const stWeb = (stAfter.json.derivatives as { variant: string; byteSize: number }[]).find(
    (d) => d.variant === 'WEB'
  );
  const stThumb = (stAfter.json.derivatives as { variant: string; byteSize: number }[]).find(
    (d) => d.variant === 'THUMB'
  );
  check('...both smaller than the original, which is retained at full size',
    stWeb!.byteSize < stAfter.json.file.byteSize && stThumb!.byteSize < stWeb!.byteSize,
    { original: stAfter.json.file.byteSize, web: stWeb?.byteSize, thumb: stThumb?.byteSize });

  // Running the pass twice must not make a third derivative. The partial unique
  // index is what makes that true rather than hoped for.
  await runStorageBatch();
  const { rows: stDerivCount } = await db.query<{ n: string }>(
    `select count(*)::int as n from stored_files where derivative_of = $1`,
    [stPresign.json.fileId]
  );
  eq('a second pass produces no second derivative', Number(stDerivCount[0]?.n), 2);

  const stDownload = await call('GET', `/v1/files/${stPresign.json.fileId}/download`, {
    token: stOwner.token,
    companyId: stCompany,
  });
  eq('a download link is minted per request', stDownload.status, 200);
  const stFetched = await fetch(stDownload.json.url as string);
  eq('...and it actually resolves to the bytes', stFetched.status, 200);
  eq('...serving them as the type they really are',
    stFetched.headers.get('content-type'), 'image/png');

  // ── The case the scanner exists for ──────────────────────────────────────
  //
  // A Windows executable declared as a photograph. The declared type is a claim
  // by the client and was never evidence; this is the only check that looks at
  // what the bytes actually say.
  const stExe = Buffer.from('4d5a90000300000004000000ffff0000b8000000', 'hex');
  const stEvilPresign = await call('POST', '/v1/files/presign', {
    token: stOwner.token,
    companyId: stCompany,
    body: { kind: 'IMAGE', filename: 'innocent.jpg', contentType: 'image/jpeg', byteSize: stExe.byteLength },
  });
  eq('an executable renamed .jpg gets past the declared-type check', stEvilPresign.status, 201);
  await fetch(stEvilPresign.json.uploadUrl as string, {
    method: 'PUT',
    headers: stEvilPresign.json.requiredHeaders as Record<string, string>,
    body: stExe,
  });
  await call('POST', `/v1/files/${stEvilPresign.json.fileId}/complete`, {
    token: stOwner.token,
    companyId: stCompany,
  });
  await runStorageBatch();
  const stEvil = await call('GET', `/v1/files/${stEvilPresign.json.fileId}`, {
    token: stOwner.token,
    companyId: stCompany,
  });
  eq('...and is refused by the scanner that reads its bytes', stEvil.json.file.status, 'FAILED');
  check('...with a reason a person can act on',
    /not the type it claims/i.test(stEvil.json.file.failureReason ?? ''),
    stEvil.json.file.failureReason);
  const stEvilDownload = await call('GET', `/v1/files/${stEvilPresign.json.fileId}/download`, {
    token: stOwner.token,
    companyId: stCompany,
  });
  eq('...and can never be downloaded', stEvilDownload.status, 409);

  // ── Refusals at the edge, before any bytes move ──────────────────────────
  const stSvg = await call('POST', '/v1/files/presign', {
    token: stOwner.token,
    companyId: stCompany,
    body: { kind: 'IMAGE', filename: 'x.svg', contentType: 'image/svg+xml', byteSize: 500 },
  });
  eq('an SVG is not an image here, because an SVG can execute script', stSvg.status, 422);

  const stHuge = await call('POST', '/v1/files/presign', {
    token: stOwner.token,
    companyId: stCompany,
    body: { kind: 'IMAGE', filename: 'x.jpg', contentType: 'image/jpeg', byteSize: 60 * 1024 * 1024 },
  });
  eq('an oversized image is refused before a single byte moves', stHuge.status, 422);

  // ── The meter, and whose gigabyte it is ──────────────────────────────────
  const stEnt = await call('GET', '/v1/entitlements', { token: stOwner.token, companyId: stCompany });
  const stUsage = (stEnt.json.usage as { key: string; used: number; value: number | null }[]).find(
    (u) => u.key === 'storage_gb'
  );
  check('storage usage is reported as a fraction of a gigabyte, not rounded to zero',
    stUsage !== undefined && stUsage.used > 0 && stUsage.used < 1, stUsage);
  const { rows: stBytes } = await db.query<{ total: string }>(
    `select coalesce(sum(byte_size), 0)::bigint as total from stored_files
      where company_id = $1 and status in ('PENDING','SCANNING','READY')`,
    [stCompany]
  );
  check('...and matches the bytes the database actually holds',
    Math.abs(stUsage!.used - Number(stBytes[0]?.total) / 1024 ** 3) < 1e-9,
    { reported: stUsage?.used, bytes: stBytes[0]?.total });

  /*
   * The owner decision of 2026-09-01 made executable: a subcontractor uploading to
   * a hiring company's project consumes the HIRING company's allowance. As §22.1
   * specified it — scoped to the uploader — a free subcontractor's one gigabyte
   * would have paid for a paying customer's evidence pack.
   */
  const stSubInvite = await call('POST', '/v1/providers', {
    token: stOwner.token,
    companyId: stCompany,
    body: { name: `StorageSub ${RUN}`, email: `stsub+${RUN}@verify.crewquo.test` },
  });
  const stSub = await register('stsub', undefined, `stsub+${RUN}@verify.crewquo.test`);
  await call('POST', `/v1/invites/${stSubInvite.json.inviteToken}/accept`, { token: stSub.token });
  const stSubMemberships = await call('GET', '/v1/me/memberships', { token: stSub.token });
  const stSubCompany = ((stSubMemberships.json.memberships ?? []) as { companyId: string }[]).find(
    (m) => m.companyId !== stSub.companyId
  )?.companyId as string;

  const stProject = await call('POST', '/v1/projects', {
    token: stOwner.token,
    companyId: stCompany,
    body: { name: `Riverside ${RUN}` },
  });
  const stEngagements = await call('GET', '/v1/engagements', {
    token: stOwner.token,
    companyId: stCompany,
  });
  const stEdge = (stEngagements.json.data as { id: string; providerCompanyId: string }[]).find(
    (e) => e.providerCompanyId === stSubCompany
  );
  await call('POST', `/v1/projects/${stProject.json.project.id}/assignments`, {
    token: stOwner.token,
    companyId: stCompany,
    body: { providerCompanyId: stSubCompany, engagementId: stEdge?.id },
  });

  const stBeforeOwner = await storageBytesForCompany(stCompany);
  const stBeforeSub = await storageBytesForCompany(stSubCompany);
  const stSubUpload = await call('POST', '/v1/files/presign', {
    token: stSub.token,
    companyId: stSubCompany,
    body: {
      kind: 'IMAGE',
      filename: 'sub-photo.png',
      contentType: 'image/png',
      byteSize: 4096,
      projectId: stProject.json.project.id,
    },
  });
  eq('a subcontractor may upload to the project it is assigned to', stSubUpload.status, 201);
  eq('...and the bytes are charged to the company that owns the project',
    (await storageBytesForCompany(stCompany)) - stBeforeOwner, 4096);
  eq('...not to the free plan of the company that took the photograph',
    (await storageBytesForCompany(stSubCompany)) - stBeforeSub, 0);
  check('...with the key under the project owner, so a prefix delete is one operation',
    stSubUpload.json.uploadUrl.includes(`/co/${stCompany}/proj/${stProject.json.project.id}/`),
    stSubUpload.json.uploadUrl?.slice(0, 140));

  // ── Tenant boundary ──────────────────────────────────────────────────────
  const stOutsider = await register('stoutsider', `Outsider ${RUN}`);
  const stForeignRead = await call('GET', `/v1/files/${stPresign.json.fileId}`, {
    token: stOutsider.token,
    companyId: stOutsider.companyId!,
  });
  eq('another company\'s file is not found, never forbidden', stForeignRead.status, 404);
  const stForeignProject = await call('POST', '/v1/files/presign', {
    token: stOutsider.token,
    companyId: stOutsider.companyId!,
    body: {
      kind: 'IMAGE',
      filename: 'x.png',
      contentType: 'image/png',
      byteSize: 100,
      projectId: stProject.json.project.id,
    },
  });
  eq('...and a forged project id answers the same as one that never existed',
    stForeignProject.status, 404);

  // ── The Phase 3 receipt, finally uploadable ──────────────────────────────
  const stReceipt = await call('POST', '/v1/files/presign', {
    token: stSub.token,
    companyId: stSubCompany,
    body: {
      kind: 'DOCUMENT',
      filename: 'taxi.pdf',
      contentType: 'application/pdf',
      byteSize: 8,
      projectId: stProject.json.project.id,
    },
  });
  await fetch(stReceipt.json.uploadUrl as string, {
    method: 'PUT',
    headers: stReceipt.json.requiredHeaders as Record<string, string>,
    body: Buffer.from('%PDF-1.4', 'ascii'),
  });
  await call('POST', `/v1/files/${stReceipt.json.fileId}/complete`, {
    token: stSub.token,
    companyId: stSubCompany,
  });

  const stEarly = await call('POST', '/v1/expenses', {
    token: stSub.token,
    companyId: stSubCompany,
    body: { projectId: stProject.json.project.id, amountCents: 4200, receiptFileId: stReceipt.json.fileId },
  });
  eq('a receipt still being scanned cannot be attached yet', stEarly.status, 409);

  await runStorageBatch();
  const stExpense = await call('POST', '/v1/expenses', {
    token: stSub.token,
    companyId: stSubCompany,
    body: { projectId: stProject.json.project.id, amountCents: 4200, receiptFileId: stReceipt.json.fileId },
  });
  eq('the Phase 3 deferred receipt upload finally works', stExpense.status, 201);
  eq('...and the expense points at the stored file, not at a URL it invented',
    stExpense.json.expense.receiptFileId, stReceipt.json.fileId);
  eq('...leaving the superseded receipt_url column exactly as null as it has always been',
    stExpense.json.expense.receiptUrl, null);

  const stStolenReceipt = await call('POST', '/v1/expenses', {
    token: stSub.token,
    companyId: stSubCompany,
    body: {
      projectId: stProject.json.project.id,
      amountCents: 100,
      receiptFileId: stPresign.json.fileId,
    },
  });
  eq('a receipt belonging to another company cannot be attached', stStolenReceipt.status, 404);

  // ── Project locations (§21) — Phase 7 build order step 1 ──────────────────
  section('Project locations — the tree, and the four rules that keep it one');

  const locOwner = await register('locowner', `LocationCo ${RUN}`);
  const locCompany = locOwner.companyId!;
  await subscribe(locCompany, 'pro');

  const locProject = await call('POST', '/v1/projects', {
    token: locOwner.token,
    companyId: locCompany,
    body: { name: `PwC London ${RUN}` },
  });
  const locProjectId = locProject.json.project.id as string;

  const locEmpty = await call('GET', `/v1/projects/${locProjectId}/locations`, {
    token: locOwner.token,
    companyId: locCompany,
  });
  eq('a new project has no locations, which is the normal case', locEmpty.json.tree, []);

  const mkLocation = async (body: Record<string, unknown>) =>
    call('POST', `/v1/projects/${locProjectId}/locations`, {
      token: locOwner.token,
      companyId: locCompany,
      body,
    });

  const locBuilding = await mkLocation({ kind: 'BUILDING', name: 'Building A' });
  eq('a top-level location is created', locBuilding.status, 201);
  eq('...at depth 1', locBuilding.json.location.depth, 1);

  const locFloor1 = await mkLocation({ kind: 'FLOOR', name: 'Floor 1', parentId: locBuilding.json.location.id, sortOrder: 1 });
  const locFloor3 = await mkLocation({ kind: 'FLOOR', name: 'Floor 3', parentId: locBuilding.json.location.id, sortOrder: 3 });
  const locRoom = await mkLocation({ kind: 'ROOM', name: 'Room 3.12', parentId: locFloor3.json.location.id, reference: 'PWC-312' });
  eq('a room three levels down is created', locRoom.status, 201);
  eq('...and reports its depth without storing it', locRoom.json.location.depth, 3);

  const locDesk = await mkLocation({ kind: 'OTHER', name: 'Desk 12a', parentId: locRoom.json.location.id });
  eq('the fourth level is the last one allowed', locDesk.json.location.depth, 4);

  const locFifth = await mkLocation({ kind: 'OTHER', name: 'Drawer', parentId: locDesk.json.location.id });
  eq('a fifth level is refused', locFifth.status, 422);
  check('...naming the cap rather than saying "invalid"',
    /4 levels|4 deep|nested 4/i.test(locFifth.json?.error?.message ?? ''),
    locFifth.json?.error?.message);

  await mkLocation({ kind: 'LOADING_BAY', name: 'Loading Bay', sortOrder: 5 });

  const locTree = await call('GET', `/v1/projects/${locProjectId}/locations`, {
    token: locOwner.token,
    companyId: locCompany,
  });
  eq('the tree comes back nested and ordered',
    (locTree.json.tree as { name: string; children: { name: string }[] }[]).map((n) => n.name),
    ['Building A', 'Loading Bay']);
  eq('...with children in sortOrder',
    (locTree.json.tree as { children: { name: string }[] }[])[0]?.children.map((c) => c.name),
    ['Floor 1', 'Floor 3']);
  eq('...and the flat list beside it for filters and exports',
    (locTree.json.locations as unknown[]).length, 6);

  // ── The four rules ────────────────────────────────────────────────────────
  const locSelfParent = await call('PATCH', `/v1/locations/${locFloor3.json.location.id}`, {
    token: locOwner.token,
    companyId: locCompany,
    body: { parentId: locFloor3.json.location.id },
  });
  eq('a location cannot be its own parent', locSelfParent.status, 422);

  const locCycle = await call('PATCH', `/v1/locations/${locBuilding.json.location.id}`, {
    token: locOwner.token,
    companyId: locCompany,
    body: { parentId: locRoom.json.location.id },
  });
  eq('a location cannot be moved inside its own sub-location', locCycle.status, 422);

  /*
   * The rule §21 implies and does not state: moving Floor 3 — which contains a
   * room, which contains a desk — under Floor 1 puts the floor at a legal depth 3
   * and the desk at 5. A check that only looked at the node being moved would
   * allow it.
   */
  const locDeepMove = await call('PATCH', `/v1/locations/${locFloor3.json.location.id}`, {
    token: locOwner.token,
    companyId: locCompany,
    body: { parentId: locFloor1.json.location.id },
  });
  eq('a move that fits the node but not its children is refused', locDeepMove.status, 422);
  check('...for being too deep rather than for being a cycle',
    locDeepMove.json?.error?.details?.reason === 'TOO_DEEP',
    locDeepMove.json?.error?.details);

  // The same move is fine once the subtree is short enough, which proves the
  // refusal above is about height and not about Floor 1.
  await call('DELETE', `/v1/locations/${locDesk.json.location.id}`, {
    token: locOwner.token,
    companyId: locCompany,
  });
  const locShallowMove = await call('PATCH', `/v1/locations/${locFloor3.json.location.id}`, {
    token: locOwner.token,
    companyId: locCompany,
    body: { parentId: locFloor1.json.location.id },
  });
  eq('...and allowed once the subtree fits', locShallowMove.status, 200);
  eq('...with the room following its floor down a level', locShallowMove.json.location.depth, 3);
  const locAfterMove = await call('GET', `/v1/projects/${locProjectId}/locations`, {
    token: locOwner.token,
    companyId: locCompany,
  });
  eq('...and the room now at the cap',
    (locAfterMove.json.locations as { id: string; depth: number }[]).find(
      (l) => l.id === locRoom.json.location.id
    )?.depth,
    4);
  // Put it back so the delete assertions below read against the shape above.
  await call('PATCH', `/v1/locations/${locFloor3.json.location.id}`, {
    token: locOwner.token,
    companyId: locCompany,
    body: { parentId: locBuilding.json.location.id },
  });

  // ── Delete, which §21 mostly refuses ──────────────────────────────────────
  const locDeleteParent = await call('DELETE', `/v1/locations/${locFloor3.json.location.id}`, {
    token: locOwner.token,
    companyId: locCompany,
  });
  eq('deleting a location with sub-locations is refused', locDeleteParent.status, 409);
  check('...naming what is using it and offering retirement instead',
    /sub-locations/.test(locDeleteParent.json?.error?.message ?? '') &&
      /retire/i.test(locDeleteParent.json?.error?.message ?? ''),
    locDeleteParent.json?.error?.message);

  const locRetire = await call('PATCH', `/v1/locations/${locFloor3.json.location.id}`, {
    token: locOwner.token,
    companyId: locCompany,
    body: { active: false },
  });
  eq('retiring it works where deleting it does not', locRetire.json.location.active, false);
  const locStillThere = await call('GET', `/v1/projects/${locProjectId}/locations`, {
    token: locOwner.token,
    companyId: locCompany,
  });
  check('...and everything recorded under it stays',
    (locStillThere.json.locations as { id: string }[]).some(
      (l) => l.id === locRoom.json.location.id
    ));

  const locDeleteLeaf = await call('DELETE', `/v1/locations/${locRoom.json.location.id}`, {
    token: locOwner.token,
    companyId: locCompany,
  });
  eq('an unused leaf can still be deleted outright', locDeleteLeaf.status, 204);

  // ── Who may read and who may shape ───────────────────────────────────────
  const locSubInvite = await call('POST', '/v1/providers', {
    token: locOwner.token,
    companyId: locCompany,
    body: { name: `LocSub ${RUN}`, email: `locsub+${RUN}@verify.crewquo.test` },
  });
  const locSub = await register('locsub', undefined, `locsub+${RUN}@verify.crewquo.test`);
  await call('POST', `/v1/invites/${locSubInvite.json.inviteToken}/accept`, { token: locSub.token });
  const locSubCompany = ((await call('GET', '/v1/me/memberships', { token: locSub.token })).json
    .memberships as { companyId: string }[]).find((m) => m.companyId !== locSub.companyId)
    ?.companyId as string;
  await call('POST', `/v1/projects/${locProjectId}/assignments`, {
    token: locOwner.token,
    companyId: locCompany,
    body: { providerCompanyId: locSubCompany },
  });

  const locSubReads = await call('GET', `/v1/projects/${locProjectId}/locations`, {
    token: locSub.token,
    companyId: locSubCompany,
  });
  eq('an assigned subcontractor can see the tree it has to tag photos against',
    locSubReads.status, 200);
  const locSubWrites = await call('POST', `/v1/projects/${locProjectId}/locations`, {
    token: locSub.token,
    companyId: locSubCompany,
    body: { kind: 'ROOM', name: 'Sub-invented room' },
  });
  eq('...and cannot reshape the client\'s site', locSubWrites.status, 403);

  const locOutsider = await register('locoutsider', `LocOutsider ${RUN}`);
  const locOutsiderReads = await call('GET', `/v1/projects/${locProjectId}/locations`, {
    token: locOutsider.token,
    companyId: locOutsider.companyId!,
  });
  eq('another company\'s project is not found, never forbidden', locOutsiderReads.status, 404);

  /*
   * A parent from another project is refused by the *database*, through the
   * composite foreign key, not only by the route. Asserted directly because the
   * route's own check would hide it: this is the guarantee that survives a
   * handler somebody writes later without reading §21.
   */
  const locOtherProject = await call('POST', '/v1/projects', {
    token: locOwner.token,
    companyId: locCompany,
    body: { name: `Second site ${RUN}` },
  });
  const locForeignParent = await mkLocation({
    kind: 'FLOOR',
    name: 'Impossible',
    parentId: locBuilding.json.location.id,
  });
  eq('a location is created for the cross-project test', locForeignParent.status, 201);
  let locDbRefused = false;
  try {
    await db.query(
      `insert into project_locations (project_id, parent_id, kind, name)
       values ($1, $2, 'ROOM', 'Cross-project child')`,
      [locOtherProject.json.project.id, locBuilding.json.location.id]
    );
  } catch {
    locDbRefused = true;
  }
  check('the database itself refuses a parent from another project', locDbRefused);

  // ── The trail ─────────────────────────────────────────────────────────────
  const locTrail = await call('GET', '/v1/audit-logs', {
    token: locOwner.token,
    companyId: locCompany,
  });
  const locActions = (locTrail.json.data as { action: string }[]).map((r) => r.action);
  check('creating, changing and deleting a location are each audited',
    locActions.includes('location.created') &&
      locActions.includes('location.updated') &&
      locActions.includes('location.deleted'),
    [...new Set(locActions)].filter((a) => a.startsWith('location.')));
  const locRetireRow = (locTrail.json.data as { action: string; description: string }[]).find(
    (r) => r.action === 'location.updated' && /retired/i.test(r.description)
  );
  check('...and retiring reads as retiring rather than as an edit', Boolean(locRetireRow),
    locRetireRow?.description);

  // ── The offline/sync contract (7.7) — Phase 7 build order step 2 ──────────
  section('Sync contract — idempotency, expected versions and tombstones');

  const syncOwner = await register('syncowner', `SyncCo ${RUN}`);
  const syncCompany = syncOwner.companyId!;
  await subscribe(syncCompany, 'pro');
  const syncProject = await call('POST', '/v1/projects', {
    token: syncOwner.token,
    companyId: syncCompany,
    body: { name: `Sync site ${RUN}` },
  });
  const syncProjectId = syncProject.json.project.id as string;

  const syncCreate = (body: Record<string, unknown>) =>
    call('POST', `/v1/projects/${syncProjectId}/locations`, {
      token: syncOwner.token,
      companyId: syncCompany,
      body,
    });

  // ── 1. Idempotency: "have I already done this?" ───────────────────────────
  const syncClientId = randomUUID();
  const syncBody = { kind: 'FLOOR', name: 'Floor 7', clientId: syncClientId };
  const syncFirst = await syncCreate(syncBody);
  eq('a create with a client id succeeds', syncFirst.status, 201);
  eq('...at revision 1', syncFirst.json.location.revision, 1);

  const syncReplay = await syncCreate(syncBody);
  eq('a replayed create returns the answer it missed rather than a refusal', syncReplay.status, 201);
  eq('...byte for byte the same, so the client cannot tell which attempt it was',
    syncReplay.json, syncFirst.json);
  const { rows: syncOnce } = await db.query<{ n: string }>(
    `select count(*)::int as n from project_locations where project_id = $1 and name = 'Floor 7'`,
    [syncProjectId]
  );
  eq('...and exactly one Floor 7 exists', Number(syncOnce[0]?.n), 1);

  const syncReused = await syncCreate({ kind: 'ROOM', name: 'Something else', clientId: syncClientId });
  eq('the same client id for a different change is refused, not answered', syncReused.status, 409);
  check('...because handing back the first answer would silently discard the second',
    syncReused.json?.error?.details?.reason === 'CLIENT_ID_REUSED',
    syncReused.json?.error?.details);

  /*
   * Two genuinely concurrent retries of one request. The primary key on
   * `mutation_receipts` is the arbiter; whichever lands first is the answer both
   * receive, which is correct — they asked for the same thing.
   */
  const syncRaceId = randomUUID();
  const syncRaceBody = { kind: 'ROOM', name: 'Raced room', clientId: syncRaceId };
  const [syncRaceA, syncRaceB] = await Promise.all([syncCreate(syncRaceBody), syncCreate(syncRaceBody)]);
  check('two simultaneous retries both succeed',
    syncRaceA.status === 201 && syncRaceB.status === 201,
    { a: syncRaceA.status, b: syncRaceB.status });
  const { rows: syncRacedRows } = await db.query<{ n: string }>(
    `select count(*)::int as n from project_locations where project_id = $1 and name = 'Raced room'`,
    [syncProjectId]
  );
  eq('...and create exactly one room between them', Number(syncRacedRows[0]?.n), 1);

  // A create without a client id is not idempotent, and that is the honest
  // default rather than a hole: two deliberate creates of "Floor 8" are two floors.
  await syncCreate({ kind: 'FLOOR', name: 'Floor 8' });
  await syncCreate({ kind: 'FLOOR', name: 'Floor 8' });
  const { rows: syncTwice } = await db.query<{ n: string }>(
    `select count(*)::int as n from project_locations where project_id = $1 and name = 'Floor 8'`,
    [syncProjectId]
  );
  eq('without a client id nothing is deduplicated, which is the honest default',
    Number(syncTwice[0]?.n), 2);

  // ── 2. Expected revisions: "is this still what I read?" ───────────────────
  const syncTarget = syncFirst.json.location.id as string;
  const syncRename = await call('PATCH', `/v1/locations/${syncTarget}`, {
    token: syncOwner.token,
    companyId: syncCompany,
    body: { name: 'Floor 7 (north)', expectedRevision: 1 },
  });
  eq('an edit matching what the caller read is applied', syncRename.status, 200);
  eq('...and the revision moves', syncRename.json.location.revision, 2);

  const syncStale = await call('PATCH', `/v1/locations/${syncTarget}`, {
    token: syncOwner.token,
    companyId: syncCompany,
    body: { name: 'Floor 7 (south)', expectedRevision: 1 },
  });
  eq('a second edit against the old revision is refused', syncStale.status, 409);
  check('...naming it as a stale version rather than as a generic conflict',
    syncStale.json?.error?.details?.reason === 'STALE_REVISION',
    syncStale.json?.error?.details?.reason);
  check('...and carrying the current record, so the client can show a real difference',
    syncStale.json?.error?.details?.current?.name === 'Floor 7 (north)' &&
      syncStale.json?.error?.details?.currentRevision === 2,
    { name: syncStale.json?.error?.details?.current?.name });

  const syncBlind = await call('PATCH', `/v1/locations/${syncTarget}`, {
    token: syncOwner.token,
    companyId: syncCompany,
    body: { name: 'Floor 7 (east)' },
  });
  eq('an edit that makes no claim still applies, which is the browser-form case',
    syncBlind.status, 200);

  // A no-op write must not move the revision: bumping it would invalidate every
  // client's expected version over a change nobody made.
  const syncNoop = await call('PATCH', `/v1/locations/${syncTarget}`, {
    token: syncOwner.token,
    companyId: syncCompany,
    body: { name: 'Floor 7 (east)' },
  });
  eq('a write that changes nothing does not move the revision',
    syncNoop.json.location.revision, syncBlind.json.location.revision);

  /*
   * Two tabs racing one record, which is what the browser case would exercise if
   * there were a locations screen yet. Both compose against revision N; exactly
   * one may win, and the loser must be told rather than silently overwritten.
   */
  const syncBefore = await call('GET', `/v1/locations/${syncTarget}`, {
    token: syncOwner.token,
    companyId: syncCompany,
  });
  const syncRev = syncBefore.json.location.revision as number;
  const [syncTabA, syncTabB] = await Promise.all([
    call('PATCH', `/v1/locations/${syncTarget}`, {
      token: syncOwner.token,
      companyId: syncCompany,
      body: { reference: 'TAB-A', expectedRevision: syncRev },
    }),
    call('PATCH', `/v1/locations/${syncTarget}`, {
      token: syncOwner.token,
      companyId: syncCompany,
      body: { reference: 'TAB-B', expectedRevision: syncRev },
    }),
  ]);
  const syncWinners = [syncTabA, syncTabB].filter((r) => r.status === 200);
  const syncLosers = [syncTabA, syncTabB].filter((r) => r.status === 409);
  check('two tabs racing one record: exactly one wins',
    syncWinners.length === 1 && syncLosers.length === 1,
    { a: syncTabA.status, b: syncTabB.status });
  check('...and the loser is told, not silently overwritten',
    syncLosers[0]?.json?.error?.details?.reason === 'STALE_REVISION');

  // ── 3. Tombstones: "is it gone, or am I not allowed?" ─────────────────────
  const syncDoomed = await syncCreate({ kind: 'ROOM', name: 'Doomed room' });
  const syncDoomedId = syncDoomed.json.location.id as string;

  const syncAlive = await call('GET', `/v1/locations/${syncDoomedId}`, {
    token: syncOwner.token,
    companyId: syncCompany,
  });
  eq('a live location reads normally', syncAlive.status, 200);

  eq('deleting it succeeds',
    (await call('DELETE', `/v1/locations/${syncDoomedId}`, {
      token: syncOwner.token,
      companyId: syncCompany,
    })).status,
    204);

  const { rows: syncRowStays } = await db.query<{ deleted_at: Date | null }>(
    `select deleted_at from project_locations where id = $1`,
    [syncDoomedId]
  );
  check('...as a tombstone, so the row stays', syncRowStays[0]?.deleted_at !== null);

  const syncGone = await call('GET', `/v1/locations/${syncDoomedId}`, {
    token: syncOwner.token,
    companyId: syncCompany,
  });
  eq('a client returning from offline is told it is gone, not that it never existed',
    syncGone.status, 410);
  check('...with the tombstone it needs to stop queueing edits',
    typeof syncGone.json?.error?.details?.tombstone?.deletedAt === 'string',
    syncGone.json?.error?.details);

  const syncEditGone = await call('PATCH', `/v1/locations/${syncDoomedId}`, {
    token: syncOwner.token,
    companyId: syncCompany,
    body: { name: 'Too late', expectedRevision: 1 },
  });
  eq('a queued edit for a deleted record is refused as gone', syncEditGone.status, 410);
  check('...rather than as a stale version, because the client should abandon it',
    syncEditGone.json?.error?.details?.reason === 'GONE');

  const syncTree = await call('GET', `/v1/projects/${syncProjectId}/locations`, {
    token: syncOwner.token,
    companyId: syncCompany,
  });
  check('a tombstone is never part of the tree',
    !(syncTree.json.locations as { id: string }[]).some((l) => l.id === syncDoomedId));

  /*
   * The rule that keeps a tombstone from being a disclosure: it is told only to
   * somebody who could have read the live row. Everybody else still gets the 404
   * they would have got before tombstones existed, so this is never an oracle for
   * ids in another tenant.
   */
  const syncOutsider = await register('syncoutsider', `SyncOutsider ${RUN}`);
  const syncOutsiderGone = await call('GET', `/v1/locations/${syncDoomedId}`, {
    token: syncOutsider.token,
    companyId: syncOutsider.companyId!,
  });
  eq('an outsider is not told a deleted record ever existed', syncOutsiderGone.status, 404);
  const syncOutsiderMissing = await call('GET', `/v1/locations/${randomUUID()}`, {
    token: syncOutsider.token,
    companyId: syncOutsider.companyId!,
  });
  eq('...answering identically to an id that never existed', syncOutsiderMissing.status, 404);

  // A tombstoned child must not lock its parent for ever.
  const syncParent = await syncCreate({ kind: 'BUILDING', name: 'Block C' });
  const syncChild = await syncCreate({
    kind: 'FLOOR',
    name: 'Block C Floor 1',
    parentId: syncParent.json.location.id,
  });
  const syncBlocked = await call('DELETE', `/v1/locations/${syncParent.json.location.id}`, {
    token: syncOwner.token,
    companyId: syncCompany,
  });
  eq('a parent with a live child cannot be deleted', syncBlocked.status, 409);
  await call('DELETE', `/v1/locations/${syncChild.json.location.id}`, {
    token: syncOwner.token,
    companyId: syncCompany,
  });
  const syncUnblocked = await call('DELETE', `/v1/locations/${syncParent.json.location.id}`, {
    token: syncOwner.token,
    companyId: syncCompany,
  });
  eq('...and a tombstoned child does not lock it for ever', syncUnblocked.status, 204);

  // ── 4. The receipt ledger holds no customer prose ─────────────────────────
  const { rows: syncReceipt } = await db.query<{ route: string; fingerprint: string; response: unknown }>(
    `select route, request_fingerprint as fingerprint, response
       from mutation_receipts where company_id = $1 and client_id = $2`,
    [syncCompany, syncClientId]
  );
  eq('the ledger records the route template, never the populated path',
    syncReceipt[0]?.route, 'POST /v1/projects/:projectId/locations');
  check('...and hashes what was asked rather than storing it',
    /^[a-f0-9]{64}$/.test(syncReceipt[0]?.fingerprint ?? ''),
    syncReceipt[0]?.fingerprint);
  check('...so the name typed by a customer is not in the ledger row',
    !JSON.stringify({ route: syncReceipt[0]?.route, fp: syncReceipt[0]?.fingerprint }).includes('Floor 7'));

  // ── Project evidence (§22) — Phase 7 build order step 4 ───────────────────
  section('Project evidence — the batch, the disclosure and the three timestamps');

  const evOwner = await register('evowner', `EvidenceCo ${RUN}`);
  const evCompany = evOwner.companyId!;
  await subscribe(evCompany, 'pro');

  const evClientRes = await call('POST', '/v1/clients', {
    token: evOwner.token,
    companyId: evCompany,
    body: { name: `Tunde Estates ${RUN}`, email: `evclient+${RUN}@verify.crewquo.test` },
  });
  const evClientCompany = evClientRes.json.client.clientCompanyId as string;
  const evProjectRes = await call('POST', '/v1/projects', {
    token: evOwner.token,
    companyId: evCompany,
    body: {
      name: `Riverside Fit-Out ${RUN}`,
      clientCompanyId: evClientCompany,
      engagementId: evClientRes.json.client.engagementId,
      clientVisible: true,
    },
  });
  const evProject = evProjectRes.json.project.id as string;

  // Ade's company: a subcontractor on the free Crew plan, which is the whole
  // point of the packaging decision below.
  const evSubInvite = await call('POST', '/v1/providers', {
    token: evOwner.token,
    companyId: evCompany,
    body: { name: `Ade Fitouts ${RUN}`, email: `evsub+${RUN}@verify.crewquo.test` },
  });
  const evSub = await register('evsub', undefined, `evsub+${RUN}@verify.crewquo.test`);
  await call('POST', `/v1/invites/${evSubInvite.json.inviteToken}/accept`, { token: evSub.token });
  const evSubMemberships = await call('GET', '/v1/me/memberships', { token: evSub.token });
  const evSubCompany = ((evSubMemberships.json.memberships ?? []) as { companyId: string }[]).find(
    (m) => m.companyId !== evSub.companyId
  )?.companyId as string;
  const evEngagements = await call('GET', '/v1/engagements', {
    token: evOwner.token,
    companyId: evCompany,
  });
  const evEdge = (evEngagements.json.data as { id: string; providerCompanyId: string }[]).find(
    (e) => e.providerCompanyId === evSubCompany
  );
  await call('POST', `/v1/projects/${evProject}/assignments`, {
    token: evOwner.token,
    companyId: evCompany,
    body: { providerCompanyId: evSubCompany, engagementId: evEdge?.id },
  });

  // ── 1. Empty ──────────────────────────────────────────────────────────────
  const evEmpty = await call('GET', `/v1/projects/${evProject}/evidence`, {
    token: evOwner.token,
    companyId: evCompany,
  });
  eq('a new project has no evidence', evEmpty.status, 200);
  eq('...and says so with an empty list rather than an invented count', evEmpty.json.evidence, []);
  eq('...and no category counts to render a filter bar from', evEmpty.json.categoryCounts, {});

  // ── 2. Structure ──────────────────────────────────────────────────────────
  const evFloor = await call('POST', `/v1/projects/${evProject}/locations`, {
    token: evOwner.token,
    companyId: evCompany,
    body: { kind: 'FLOOR', name: 'Floor 3' },
  });
  const evFloorId = evFloor.json.location.id as string;
  const evRoom = await call('POST', `/v1/projects/${evProject}/locations`, {
    token: evOwner.token,
    companyId: evCompany,
    body: { kind: 'ROOM', name: 'Room 3.12', parentId: evFloorId },
  });
  const evRoomId = evRoom.json.location.id as string;

  /**
   * Uploading four photographs the way a client does: presign, PUT, complete.
   * Returns the file ids, so the evidence assertions below stay about evidence.
   */
  async function uploadPhoto(
    who: { token: string; companyId: string },
    filename: string,
    bytes: Buffer,
    contentType = 'image/png',
    // Defaults to the evidence fixture's project, which every earlier caller
    // wants. The mass-balance section builds a project of its own so its totals
    // are exact rather than "whatever the suite has recorded by the time it runs".
    projectId: string = evProject
  ): Promise<string> {
    const presigned = await call('POST', '/v1/files/presign', {
      token: who.token,
      companyId: who.companyId,
      body: {
        kind: 'IMAGE',
        filename,
        contentType,
        byteSize: bytes.byteLength,
        projectId,
        clientId: randomUUID(),
      },
    });
    if (presigned.status !== 201) {
      throw new Error(`presign ${filename} failed: ${presigned.status} ${JSON.stringify(presigned.json)}`);
    }
    await fetch(presigned.json.uploadUrl as string, {
      method: 'PUT',
      headers: presigned.json.requiredHeaders as Record<string, string>,
      body: bytes,
    });
    await call('POST', `/v1/files/${presigned.json.fileId}/complete`, {
      token: who.token,
      companyId: who.companyId,
      body: { checksumSha256: createHash('sha256').update(bytes).digest('hex') },
    });
    return presigned.json.fileId as string;
  }

  const evPhoto = await sharpFactory()({
    create: { width: 1200, height: 800, channels: 3, background: { r: 90, g: 120, b: 60 } },
  })
    .png()
    .toBuffer();

  const evSubCtx = { token: evSub.token, companyId: evSubCompany };
  const evFileIds: string[] = [];
  for (let i = 0; i < 4; i += 1) {
    evFileIds.push(await uploadPhoto(evSubCtx, `floor-3-${i}.png`, evPhoto));
  }

  // ── 3. Capture: batch defaults, per-item override, and an explicit clear ──
  const evBatchId = randomUUID();
  const evBatchBody = {
    batchClientId: evBatchId,
    // Applied to the whole selection at once — §22.3's answer to "tagging 40
    // photos individually is the failure mode that kills evidence capture".
    defaults: {
      category: 'BEFORE',
      evidenceDate: '2026-08-28',
      locationId: evFloorId,
      capturedAt: '2026-08-28T14:12:00.000Z',
    },
    items: [
      { fileId: evFileIds[0] },
      // Overridden to the room inside the floor.
      { fileId: evFileIds[1], locationId: evRoomId, caption: 'North wall' },
      // Explicitly cleared. `item.locationId ?? defaults.locationId` would put
      // Floor 3 back on the one photograph that is not on Floor 3.
      { fileId: evFileIds[2], locationId: null },
      { fileId: evFileIds[3], category: 'DAMAGE' },
    ],
  };
  const evBatch = await call('POST', `/v1/projects/${evProject}/evidence`, {
    ...evSubCtx,
    body: evBatchBody,
  });
  eq('a subcontractor on a free plan may photograph the hiring company\'s floor', evBatch.status, 201);
  eq('...and all four files became evidence', evBatch.json.created.length, 4);
  eq('...with nothing rejected', evBatch.json.rejected, []);

  const evByFile = new Map<string, any>(
    (evBatch.json.created as any[]).map((e) => [e.fileId, e])
  );
  eq('the batch default reaches an item that said nothing',
    evByFile.get(evFileIds[0]!)?.locationId, evFloorId);
  eq('an item overrides the batch', evByFile.get(evFileIds[1]!)?.locationId, evRoomId);
  eq('...and an explicit null clears it rather than reading as silence',
    evByFile.get(evFileIds[2]!)?.locationId, null);
  eq('...while a per-item category overrides the batch category',
    evByFile.get(evFileIds[3]!)?.category, 'DAMAGE');

  // ── 4. Three timestamps, and they are three ──────────────────────────────
  const evOne = evByFile.get(evFileIds[0]!);
  eq('the project day is the day the photograph depicts', evOne?.evidenceDate, '2026-08-28');
  eq('...the device clock is recorded as its own claim', evOne?.capturedAt, '2026-08-28T14:12:00.000Z');
  check('...and the server\'s own timestamp is neither of them',
    typeof evOne?.createdAt === 'string' &&
      evOne.createdAt.slice(0, 10) !== '2026-08-28' &&
      evOne.createdAt !== evOne.capturedAt,
    { createdAt: evOne?.createdAt, capturedAt: evOne?.capturedAt, evidenceDate: evOne?.evidenceDate });

  // ── 5. Rejected: the file that is not what it says it is ─────────────────
  const evExe = Buffer.from('4d5a90000300000004000000ffff0000b8000000', 'hex');
  const evBadFile = await uploadPhoto(evSubCtx, 'innocent.jpg', evExe, 'image/jpeg');
  const evBadBatchId = randomUUID();
  const evBadBatch = await call('POST', `/v1/projects/${evProject}/evidence`, {
    ...evSubCtx,
    body: {
      batchClientId: evBadBatchId,
      defaults: { category: 'DURING', evidenceDate: '2026-08-28' },
      items: [{ fileId: evBadFile }],
    },
  });
  eq('a record may be created while its bytes are still being scanned', evBadBatch.status, 201);
  eq('...because losing the tagging every time a PUT is slow is the real failure', evBadBatch.json.created.length, 1);

  await runStorageBatch();
  const evBadRow = await call('GET', `/v1/evidence/${evBadBatch.json.created[0].id}`, { ...evSubCtx });
  eq('...and the scanner\'s verdict shows through on the record', evBadRow.json.evidence.fileStatus, 'FAILED');
  check('...with a reason the gallery can render beside it',
    /not the type it claims/i.test(evBadRow.json.evidence.fileFailureReason ?? ''),
    evBadRow.json.evidence.fileFailureReason);
  const evGoodRow = await call('GET', `/v1/evidence/${evOne.id}`, { ...evSubCtx });
  eq('...while the rest of the batch is READY and untouched by it',
    evGoodRow.json.evidence.fileStatus, 'READY');
  check('...with derivatives resolved through the file, not copied onto the record',
    evGoodRow.json.evidence.webFileId !== null && evGoodRow.json.evidence.thumbFileId !== null,
    { web: evGoodRow.json.evidence.webFileId, thumb: evGoodRow.json.evidence.thumbFileId });

  // The uploader is told. A scan runs minutes later in a worker, long after the
  // screen that started it has moved on.
  await drainWorkers();
  const { rows: evScanNotice } = await db.query<{ n: string }>(
    `select count(*)::int as n from notifications
      where kind = 'file.scan_failed' and recipient_user_id = $1`,
    [evSub.userId]
  );
  check('the person who uploaded a refused file is told, not left to notice',
    Number(evScanNotice[0]?.n) >= 1, evScanNotice[0]);
  const { rows: evScanPayload } = await db.query<{ payload: any }>(
    `select payload from delivery_outbox where topic = 'file.scan_failed' and aggregate_id = $1`,
    [evBadFile]
  );
  check('...and the event carries a reason class, never the filename a customer typed',
    JSON.stringify(evScanPayload[0]?.payload ?? {}).includes('TYPE_MISMATCH') &&
      !JSON.stringify(evScanPayload[0]?.payload ?? {}).includes('innocent.jpg'),
    evScanPayload[0]?.payload);

  // ── 6. Replay: the batch is idempotent and leaves one row per file ────────
  const evReplay = await call('POST', `/v1/projects/${evProject}/evidence`, {
    ...evSubCtx,
    body: evBatchBody,
  });
  eq('a replayed batch returns the answer it missed rather than a refusal', evReplay.status, 201);
  eq('...byte for byte, so the client cannot tell which attempt it was',
    evReplay.json, evBatch.json);
  const { rows: evRowCount } = await db.query<{ n: string }>(
    `select count(*)::int as n from project_evidence
      where project_id = $1 and deleted_at is null`,
    [evProject]
  );
  eq('...leaving five records for five files, not ten', Number(evRowCount[0]?.n), 5);

  // And without the ledger: the unique index on a live file is the second line,
  // which is what makes a retry safe even when the client id is lost.
  const evNoLedger = await call('POST', `/v1/projects/${evProject}/evidence`, {
    ...evSubCtx,
    body: { items: [{ fileId: evFileIds[0] }] },
  });
  eq('re-posting one file with no batch id is refused per file, not per request',
    evNoLedger.json.rejected[0]?.code, 'FILE_ALREADY_ATTACHED');
  eq('...and the request still succeeds, because a partial batch keeps what worked',
    evNoLedger.status, 201);

  // ── 7. The event is one per batch, and holds no prose ────────────────────
  const { rows: evBatchEvent } = await db.query<{ payload: any; n: string }>(
    `select payload, count(*) over ()::int as n from delivery_outbox
      where topic = 'evidence.batch_uploaded' and aggregate_id = $1`,
    [evBatchId]
  );
  eq('forty photographs is one act, so the batch emits one event', Number(evBatchEvent[0]?.n), 1);
  eq('...counting what it carried', evBatchEvent[0]?.payload?.count, 4);
  eq('...and naming the categories rather than the captions',
    evBatchEvent[0]?.payload?.categories, ['BEFORE', 'DAMAGE']);
  check('...with no caption, filename or location name anywhere in it',
    !JSON.stringify(evBatchEvent[0]?.payload ?? {}).match(/North wall|floor-3-|Floor 3/),
    evBatchEvent[0]?.payload);
  const { rows: evOwnerNotice } = await db.query<{ n: string }>(
    `select count(*)::int as n from notifications
      where kind = 'evidence.batch_uploaded' and company_id = $1`,
    [evCompany]
  );
  check('the hiring company is told a subcontractor added evidence',
    Number(evOwnerNotice[0]?.n) >= 1, evOwnerNotice[0]);

  // ── 8. Scope: a second subcontractor sees none of the first's ────────────
  const evSub2Invite = await call('POST', '/v1/providers', {
    token: evOwner.token,
    companyId: evCompany,
    body: { name: `Rival Trades ${RUN}`, email: `evsub2+${RUN}@verify.crewquo.test` },
  });
  const evSub2 = await register('evsub2', undefined, `evsub2+${RUN}@verify.crewquo.test`);
  await call('POST', `/v1/invites/${evSub2Invite.json.inviteToken}/accept`, { token: evSub2.token });
  const evSub2Memberships = await call('GET', '/v1/me/memberships', { token: evSub2.token });
  const evSub2Company = ((evSub2Memberships.json.memberships ?? []) as { companyId: string }[]).find(
    (m) => m.companyId !== evSub2.companyId
  )?.companyId as string;
  const evEngagements2 = await call('GET', '/v1/engagements', {
    token: evOwner.token,
    companyId: evCompany,
  });
  const evEdge2 = (evEngagements2.json.data as { id: string; providerCompanyId: string }[]).find(
    (e) => e.providerCompanyId === evSub2Company
  );
  await call('POST', `/v1/projects/${evProject}/assignments`, {
    token: evOwner.token,
    companyId: evCompany,
    body: { providerCompanyId: evSub2Company, engagementId: evEdge2?.id },
  });

  const evRivalList = await call('GET', `/v1/projects/${evProject}/evidence`, {
    token: evSub2.token,
    companyId: evSub2Company,
  });
  eq('a second subcontractor is on the project', evRivalList.status, 200);
  eq('...and sees none of the first one\'s photographs', evRivalList.json.evidence, []);
  const evRivalRead = await call('GET', `/v1/evidence/${evOne.id}`, {
    token: evSub2.token,
    companyId: evSub2Company,
  });
  eq('...nor can it read one by id, which answers as not found rather than forbidden',
    evRivalRead.status, 404);

  const evOwnerList = await call('GET', `/v1/projects/${evProject}/evidence`, {
    token: evOwner.token,
    companyId: evCompany,
  });
  eq('the project owner sees everything on their own project', evOwnerList.json.evidence.length, 5);
  eq('...with counts for the filter bar over the whole set',
    evOwnerList.json.categoryCounts, { BEFORE: 3, DAMAGE: 1, DURING: 1 });

  // ── 9. Filters ───────────────────────────────────────────────────────────
  const evFiltered = await call(
    'GET',
    `/v1/projects/${evProject}/evidence?category=BEFORE&locationId=${evFloorId}`,
    { token: evOwner.token, companyId: evCompany }
  );
  eq('a filter narrows to one category on one location', evFiltered.json.evidence.length, 1);
  const evBadRange = await call(
    'GET',
    `/v1/projects/${evProject}/evidence?from=2026-09-09&to=2026-08-01`,
    { token: evOwner.token, companyId: evCompany }
  );
  eq('a range that starts after it ends is refused, not answered with nothing',
    evBadRange.status, 422);

  // ── 10. Capability: a Worker may photograph and may not publish ──────────
  const evWorker = await register('evworker', undefined, `evworker+${RUN}@verify.crewquo.test`);
  const evWorkerInvite = await call('POST', '/v1/members/invite', {
    token: evOwner.token,
    companyId: evCompany,
    body: { email: evWorker.email, role: 'MEMBER' },
  });
  eq('a member is invited into the owning company', evWorkerInvite.status, 201);
  const evWorkerJoin = await call('POST', `/v1/invites/${evWorkerInvite.json.inviteToken}/accept`, {
    token: evWorker.token,
  });
  eq('...and joins it', evWorkerJoin.status, 201);
  await db.query(
    `update memberships set bundle_key = 'worker' where company_id = $1 and user_id = $2`,
    [evCompany, evWorker.userId]
  );
  const evWorkerPublish = await call('POST', `/v1/projects/${evProject}/evidence/publish`, {
    token: evWorker.token,
    companyId: evCompany,
    body: { ids: [evOne.id], clientVisible: true },
  });
  eq('a Worker is refused the disclosure lever, with the capability named',
    evWorkerPublish.status, 403);
  check('...and the refusal says which one, so nobody has to ring support',
    JSON.stringify(evWorkerPublish.json).includes('evidence.publish'),
    evWorkerPublish.json);

  // ── 11. Publishing is the owner's alone ─────────────────────────────────
  const evSubPublish = await call('POST', `/v1/projects/${evProject}/evidence/publish`, {
    ...evSubCtx,
    body: { ids: [evOne.id], clientVisible: true },
  });
  eq('a subcontractor cannot disclose to the hiring company\'s client', evSubPublish.status, 403);

  const evPublishIds = [evByFile.get(evFileIds[0]!)!.id, evByFile.get(evFileIds[1]!)!.id];
  const evPublish = await call('POST', `/v1/projects/${evProject}/evidence/publish`, {
    token: evOwner.token,
    companyId: evCompany,
    body: { ids: evPublishIds, clientVisible: true },
  });
  eq('the project owner publishes two of the five', evPublish.status, 200);
  eq('...and is told what that means', evPublish.json.updated, 2);
  check('...in a sentence that does not promise a retraction',
    /cannot un-send/i.test(evPublish.json.notice ?? ''), evPublish.json.notice);

  // ── 12. The client sees exactly what was published ──────────────────────
  const evClientUser = await register('evclientuser', undefined, `evclient+${RUN}@verify.crewquo.test`);
  const evClientJoin = await call('POST', `/v1/invites/${evClientRes.json.inviteToken}/accept`, {
    token: evClientUser.token,
  });
  eq('the client accepts its portal invite', evClientJoin.status, 201);
  const evPortal = await call('GET', `/v1/portal/projects/${evProject}/evidence`, {
    token: evClientUser.token,
    companyId: evClientCompany,
  });
  eq('the client can read the project\'s shared evidence', evPortal.status, 200);
  eq('...and sees the two that were published', evPortal.json.evidence.length, 2);
  const evPortalPayload = JSON.stringify(evPortal.json);
  check('the three that were not are ABSENT from the payload, not hidden in it',
    !evPortalPayload.includes(evByFile.get(evFileIds[2]!)!.id) &&
      !evPortalPayload.includes(evByFile.get(evFileIds[3]!)!.id),
    evPortal.json.evidence.map((e: any) => e.id));
  check('...and the supply chain behind the photograph is not disclosed either',
    !evPortalPayload.includes(evSubCompany) && !evPortalPayload.includes(evSub.userId),
    { company: evSubCompany, user: evSub.userId });

  // The money boundary, the same assertion class the export earned on 2026-08-21.
  check('nothing in the client\'s evidence carries a rate, a margin or a snapshot',
    !/resolvedRate|payRate|marginCents|amountCents/i.test(evPortalPayload));
  const evProviderPayload = JSON.stringify(
    (await call('GET', `/v1/projects/${evProject}/evidence`, { ...evSubCtx })).json
  );
  check('...and neither does the provider\'s',
    !/resolvedRate|payRate|marginCents|amountCents/i.test(evProviderPayload));

  // ── 13. Publishing widens the file download, and only through the record ─
  const evPublished = (evPortal.json.evidence as any[])[0];
  const evClientDownload = await call('GET', `/v1/files/${evPublished.fileId}/download`, {
    token: evClientUser.token,
    companyId: evClientCompany,
  });
  eq('a published file is downloadable by the client it was shared with', evClientDownload.status, 200);
  const evClientThumb = await call('GET', `/v1/files/${evPublished.thumbFileId}/download`, {
    token: evClientUser.token,
    companyId: evClientCompany,
  });
  eq('...and so is its thumbnail, through the same record', evClientThumb.status, 200);
  const evClientHidden = await call(
    'GET',
    `/v1/files/${evByFile.get(evFileIds[2]!)!.fileId}/download`,
    { token: evClientUser.token, companyId: evClientCompany }
  );
  eq('...while an unpublished file is not found for the same client', evClientHidden.status, 404);
  const evRivalDownload = await call('GET', `/v1/files/${evPublished.fileId}/download`, {
    token: evSub2.token,
    companyId: evSub2Company,
  });
  eq('...and a rival subcontractor on the same project cannot reach it at all',
    evRivalDownload.status, 404);

  const { rows: evClientNotice } = await db.query<{ n: string }>(
    `select count(*)::int as n from notifications
      where kind = 'evidence.published' and company_id = $1`,
    [evClientCompany]
  );
  await drainWorkers();
  const { rows: evClientNoticeAfter } = await db.query<{ n: string }>(
    `select count(*)::int as n from notifications
      where kind = 'evidence.published' and company_id = $1`,
    [evClientCompany]
  );
  const { rows: evPublishOutbox } = await db.query<{ status: string; attempts: number; last_error: string | null }>(
    `select status, attempts, last_error from delivery_outbox
      where topic = 'evidence.published' and company_id = $1
      order by created_at desc limit 1`,
    [evClientCompany]
  );
  check('the client is told that evidence was shared with them',
    Number(evClientNoticeAfter[0]?.n) >= 1,
    { before: evClientNotice[0], after: evClientNoticeAfter[0], outbox: evPublishOutbox[0] });

  // ── 14. Un-publishing hides, and does not claim to withdraw ─────────────
  const evHide = await call('POST', `/v1/projects/${evProject}/evidence/publish`, {
    token: evOwner.token,
    companyId: evCompany,
    body: { ids: [evPublishIds[1]], clientVisible: false },
  });
  eq('the owner hides one again', evHide.status, 200);
  check('...and the sentence refuses to imply a retraction',
    /does not withdraw/i.test(evHide.json.notice ?? ''), evHide.json.notice);
  const { rows: evFirstPublished } = await db.query<{ first_published_at: Date | null }>(
    `select first_published_at from project_evidence where id = $1`,
    [evPublishIds[1]]
  );
  check('...and the record still remembers that it WAS published',
    evFirstPublished[0]?.first_published_at !== null, evFirstPublished[0]);
  const evPortalAfterHide = await call('GET', `/v1/portal/projects/${evProject}/evidence`, {
    token: evClientUser.token,
    companyId: evClientCompany,
  });
  eq('...while the client now sees one', evPortalAfterHide.json.evidence.length, 1);

  // Both edges are in the trail, as distinct actions.
  const { rows: evAudit } = await db.query<{ action: string }>(
    `select action from audit_logs where company_id = $1
       and action in ('evidence.created','evidence.published','evidence.unpublished')
     order by created_at asc`,
    [evCompany]
  );
  check('the trail records publishing and hiding as two different acts',
    evAudit.some((r) => r.action === 'evidence.published') &&
      evAudit.some((r) => r.action === 'evidence.unpublished'),
    evAudit.map((r) => r.action));

  // ── 15. Re-tagging: whose rows, and which capability ────────────────────
  const evBulk = await call('PATCH', `/v1/projects/${evProject}/evidence`, {
    token: evOwner.token,
    companyId: evCompany,
    body: { ids: evPublishIds, patch: { category: 'AFTER' } },
  });
  eq('the project owner may re-tag a subcontractor\'s photographs', evBulk.status, 200);
  eq('...both of them', evBulk.json.updated, 2);

  const evSubBulk = await call('PATCH', `/v1/projects/${evProject}/evidence`, {
    ...evSubCtx,
    body: { ids: evPublishIds, patch: { caption: 'mine now' } },
  });
  eq('a subcontractor editing its own rows succeeds', evSubBulk.status, 200);
  const evRivalBulk = await call('PATCH', `/v1/projects/${evProject}/evidence`, {
    token: evSub2.token,
    companyId: evSub2Company,
    body: { ids: evPublishIds, patch: { caption: 'not mine' } },
  });
  eq('...and a rival naming the same ids changes nothing rather than something',
    evRivalBulk.json.updated, 0);
  eq('...while still being told how many it asked for', evRivalBulk.json.requested, 2);

  // ── 16. Optimistic concurrency and the tombstone ────────────────────────
  const evTarget = evByFile.get(evFileIds[3]!)!;
  const evCurrent = await call('GET', `/v1/evidence/${evTarget.id}`, { ...evSubCtx });
  const evRev = evCurrent.json.evidence.revision as number;
  const evEdit = await call('PATCH', `/v1/evidence/${evTarget.id}`, {
    ...evSubCtx,
    body: { caption: 'Cracked panel', expectedRevision: evRev },
  });
  eq('an edit against the version it read is applied', evEdit.status, 200);
  eq('...and the database bumps the revision, not the route', evEdit.json.evidence.revision, evRev + 1);
  const evStale = await call('PATCH', `/v1/evidence/${evTarget.id}`, {
    ...evSubCtx,
    body: { caption: 'Composed offline', expectedRevision: evRev },
  });
  eq('a stale edit is refused', evStale.status, 409);
  eq('...carrying the current version back so a client can show a real difference',
    evStale.json?.error?.details?.currentRevision, evRev + 1);

  const evDelete = await call('DELETE', `/v1/evidence/${evTarget.id}`, { ...evSubCtx });
  eq('the uploader removes their own record', evDelete.status, 204);
  const evGone = await call('GET', `/v1/evidence/${evTarget.id}`, { ...evSubCtx });
  eq('...and a stale client is told it is gone rather than left to infer it', evGone.status, 410);
  const evGoneOutsider = await call('GET', `/v1/evidence/${evTarget.id}`, {
    token: evSub2.token,
    companyId: evSub2Company,
  });
  eq('...while somebody who could never have read it gets the same 404 as always',
    evGoneOutsider.status, 404);
  const { rows: evStillThere } = await db.query<{ n: string }>(
    `select count(*)::int as n from stored_files where id = $1 and status = 'READY'`,
    [evTarget.fileId]
  );
  eq('...and detaching a photograph does not destroy its bytes', Number(evStillThere[0]?.n), 1);

  // ── 17. The location cannot be deleted out from under the evidence ──────
  const evLocDelete = await call('DELETE', `/v1/locations/${evFloorId}`, {
    token: evOwner.token,
    companyId: evCompany,
  });
  eq('a location with evidence on it cannot be deleted', evLocDelete.status, 409);
  check('...and the refusal names what is using it and offers retirement',
    /photos and files/.test(evLocDelete.json?.error?.message ?? '') &&
      /retire/i.test(evLocDelete.json?.error?.message ?? ''),
    evLocDelete.json?.error?.message);

  // ── 18. Packaging: the feature is the owner's, never the uploader's ─────
  const evSubOwnProject = await call('POST', '/v1/projects', {
    ...evSubCtx,
    body: { name: `Ade's own job ${RUN}` },
  });
  const evSubOwnEvidence = await call('GET', `/v1/projects/${evSubOwnProject.json.project.id}/evidence`, {
    ...evSubCtx,
  });
  eq('a Crew-plan company gets no evidence section on its OWN project', evSubOwnEvidence.status, 403);
  check('...naming the key it would need', JSON.stringify(evSubOwnEvidence.json).includes('project_evidence'),
    evSubOwnEvidence.json);
  eq('...while the same company keeps working on the hiring company\'s project',
    (await call('GET', `/v1/projects/${evProject}/evidence`, { ...evSubCtx })).status, 200);

  // ── 19. The storage ceiling, refused before a byte moves ────────────────
  //
  // Set by an override rather than by a plan value, because the §43 tier figures
  // are a pricing judgement the owner deliberately kept (see `infra/seed`). The
  // enforcement path is identical either way — this is what a plan limit does.
  await db.query(
    `insert into company_entitlement_overrides (company_id, limit_key, limit_value, note)
     values ($1, 'storage_gb', 0, 'verify-e2e: prove the ceiling refuses at presign')`,
    [evCompany]
  );
  const evOverLimit = await call('POST', '/v1/files/presign', {
    ...evSubCtx,
    body: {
      kind: 'IMAGE',
      filename: 'one-more.png',
      contentType: 'image/png',
      byteSize: evPhoto.byteLength,
      projectId: evProject,
    },
  });
  eq('a company at its storage ceiling is refused at presign', evOverLimit.status, 402);
  check('...with the figure and its unit, before anything is uploaded',
    /KB|MB|GB/.test(evOverLimit.json?.error?.message ?? ''), evOverLimit.json?.error?.message);
  check('...and it is the PROJECT OWNER\'s ceiling that stopped the subcontractor',
    evOverLimit.json?.error?.details?.limit === 'storage_gb',
    evOverLimit.json?.error?.details);
  await db.query(
    `delete from company_entitlement_overrides where company_id = $1 and limit_key = 'storage_gb'`,
    [evCompany]
  );

  // The windowed meter, across a month boundary in a zone that is not UTC.
  await db.query(`update companies set time_zone = 'Asia/Manila' where id = $1`, [evCompany]);
  await db.query(
    `insert into company_entitlement_overrides (company_id, limit_key, limit_value, note)
     values ($1, 'evidence_uploads_per_month', 1, 'verify-e2e: the first windowed meter')`,
    [evCompany]
  );
  const evMonthly = await call('POST', '/v1/files/presign', {
    ...evSubCtx,
    body: {
      kind: 'IMAGE',
      filename: 'this-month.png',
      contentType: 'image/png',
      byteSize: 512,
      projectId: evProject,
    },
  });
  eq('the monthly upload allowance is enforced too', evMonthly.status, 402);
  eq('...by its own key', evMonthly.json?.error?.details?.limit, 'evidence_uploads_per_month');

  /*
   * The window's start is the company's own month, not the server's. Backdating
   * every existing upload past the Manila month boundary must empty the meter —
   * if the boundary were computed in UTC, a company eight hours ahead would be
   * told it was still in the old month for eight hours of every rollover.
   */
  await db.query(
    `update stored_files set created_at = (
        date_trunc('month', (now() at time zone 'Asia/Manila')) at time zone 'Asia/Manila'
      ) - interval '1 second'
      where project_id = $1`,
    [evProject]
  );
  const evNewMonth = await call('POST', '/v1/files/presign', {
    ...evSubCtx,
    body: {
      kind: 'IMAGE',
      filename: 'new-month.png',
      contentType: 'image/png',
      byteSize: 512,
      projectId: evProject,
    },
  });
  eq('...and the window starts at the company\'s own month boundary, not the server\'s',
    evNewMonth.status, 201);
  await db.query(
    `delete from company_entitlement_overrides where company_id = $1
      and limit_key = 'evidence_uploads_per_month'`,
    [evCompany]
  );

  // ── 20. Closure keeps the record and drops the name ─────────────────────
  const { rows: evFk } = await db.query<{ delete_rule: string }>(
    `select rc.delete_rule
       from information_schema.referential_constraints rc
       join information_schema.key_column_usage k on k.constraint_name = rc.constraint_name
      where k.table_name = 'project_evidence' and k.column_name = 'uploaded_by_user_id'`
  );
  eq('a photograph outlives the person who took it, attributed to a tombstoned identity',
    evFk[0]?.delete_rule, 'SET NULL');

  // ── Project documents (§24) — Phase 7 build order step 5 ──────────────────
  section('Project documents — the chain, the scope and the expiry ladder');

  // Reuses the evidence fixture: the same owner, subcontractor, rival and client
  // on the same project, so the scope rules are proved against a project that
  // genuinely has two competing trades and a client on it.
  const dcOwnerCtx = { token: evOwner.token, companyId: evCompany };
  const dcSubCtx = evSubCtx;
  const dcOutsider = await register('dcoutsider', `Unrelated Ltd ${RUN}`);

  /** The bytes behind a document, for the file-download assertions. */
  async function ramsFileOf(documentId: string): Promise<string> {
    const { rows } = await db.query<{ file_id: string }>(
      `select file_id from project_documents where id = $1`,
      [documentId]
    );
    return rows[0]?.file_id as string;
  }

  async function uploadDoc(
    who: { token: string; companyId: string },
    filename: string,
    body: Buffer = Buffer.from('%PDF-1.4 test document', 'ascii')
  ): Promise<string> {
    const presigned = await call('POST', '/v1/files/presign', {
      token: who.token,
      companyId: who.companyId,
      body: {
        kind: 'DOCUMENT',
        filename,
        contentType: 'application/pdf',
        byteSize: body.byteLength,
        projectId: evProject,
        clientId: randomUUID(),
      },
    });
    if (presigned.status !== 201) {
      throw new Error(`presign ${filename}: ${presigned.status} ${JSON.stringify(presigned.json)}`);
    }
    await fetch(presigned.json.uploadUrl as string, {
      method: 'PUT',
      headers: presigned.json.requiredHeaders as Record<string, string>,
      body,
    });
    await call('POST', `/v1/files/${presigned.json.fileId}/complete`, {
      token: who.token,
      companyId: who.companyId,
      body: { checksumSha256: createHash('sha256').update(body).digest('hex') },
    });

    /*
     * Documents require READY, unlike evidence, so the helper drains the scanner
     * rather than leaving the caller to. A batch is bounded and this script shares
     * a database with the browser suite, so it loops until *this* file is through
     * rather than assuming one pass is enough — the same reasoning `drainWorkers`
     * records about the outbox.
     */
    for (let pass = 0; pass < 6; pass += 1) {
      const { rows } = await db.query<{ status: string }>(
        `select status from stored_files where id = $1`,
        [presigned.json.fileId]
      );
      if (rows[0]?.status === 'READY') break;
      await runStorageBatch();
    }
    return presigned.json.fileId as string;
  }

  // ── 1. Empty, then a document that is still being scanned ────────────────
  const dcEmpty = await call('GET', `/v1/projects/${evProject}/documents`, { ...dcOwnerCtx });
  eq('a project with no documents says so', dcEmpty.status, 200);
  eq('...with an empty list', dcEmpty.json.documents, []);

  const dcPendingPresign = await call('POST', '/v1/files/presign', {
    ...dcOwnerCtx,
    body: {
      kind: 'DOCUMENT',
      filename: 'not-yet.pdf',
      contentType: 'application/pdf',
      byteSize: 22,
      projectId: evProject,
    },
  });
  const dcEarly = await call('POST', `/v1/projects/${evProject}/documents`, {
    ...dcOwnerCtx,
    body: { fileId: dcPendingPresign.json.fileId, category: 'RAMS', title: 'Site RAMS' },
  });
  eq('a document cannot be filed against bytes nobody has checked yet', dcEarly.status, 409);

  // ── 2. Filing, and the dates that must not invert ────────────────────────
  const dcRamsV1File = await uploadDoc(dcOwnerCtx, 'site-rams-v1.pdf');
  const dcBadDates = await call('POST', `/v1/projects/${evProject}/documents`, {
    ...dcOwnerCtx,
    body: {
      fileId: dcRamsV1File,
      category: 'RAMS',
      title: 'Site RAMS',
      issuedOn: '2026-09-01',
      expiresOn: '2026-08-01',
    },
  });
  eq('a document that expires before it was issued is a typo, not a record', dcBadDates.status, 422);

  const dcRamsV1 = await call('POST', `/v1/projects/${evProject}/documents`, {
    ...dcOwnerCtx,
    body: {
      fileId: dcRamsV1File,
      category: 'RAMS',
      title: 'Site RAMS',
      reference: 'RAMS-2026-014',
      issuedOn: '2026-08-01',
      expiresOn: '2027-08-01',
      locationId: evFloorId,
      clientId: randomUUID(),
    },
  });
  eq('the project owner files a site RAMS', dcRamsV1.status, 201);
  eq('...as version 1', dcRamsV1.json.document.version, 1);
  eq('...superseded by nothing', dcRamsV1.json.document.supersededById, null);
  eq('...and project-wide, because the owner did not file it against anybody',
    dcRamsV1.json.document.providerCompanyId, null);
  const dcRamsV1Id = dcRamsV1.json.document.id as string;

  // ── 3. The chain: re-issue, and the fork that must not happen ───────────
  const dcRamsV2File = await uploadDoc(dcOwnerCtx, 'site-rams-v2.pdf', Buffer.from('%PDF-1.4 rev B', 'ascii'));
  const dcSameFile = await call('POST', `/v1/documents/${dcRamsV1Id}/versions`, {
    ...dcOwnerCtx,
    body: { fileId: dcRamsV1File },
  });
  eq('a new version pointing at the same bytes changes nothing and is refused',
    dcSameFile.status, 409);
  eq('...by name', dcSameFile.json?.error?.details?.reason, 'FILE_REUSED');

  const dcRamsV2 = await call('POST', `/v1/documents/${dcRamsV1Id}/versions`, {
    ...dcOwnerCtx,
    body: { fileId: dcRamsV2File, issuedOn: '2026-09-01', expiresOn: '2027-09-01' },
  });
  eq('the RAMS is re-issued', dcRamsV2.status, 201);
  eq('...as version 2', dcRamsV2.json.document.version, 2);
  eq('...pointing back at the version it replaced', dcRamsV2.json.document.supersedesId, dcRamsV1Id);
  eq('...inheriting the category nobody retyped', dcRamsV2.json.document.category, 'RAMS');
  eq('...and the reference printed on it', dcRamsV2.json.document.reference, 'RAMS-2026-014');
  const dcRamsV2Id = dcRamsV2.json.document.id as string;

  const dcFork = await call('POST', `/v1/documents/${dcRamsV1Id}/versions`, {
    ...dcOwnerCtx,
    body: { fileId: await uploadDoc(dcOwnerCtx, 'rival-rams.pdf', Buffer.from('%PDF-1.4 fork', 'ascii')) },
  });
  eq('a second re-issue of the SAME version is refused rather than forking the chain',
    dcFork.status, 409);
  eq('...naming the reason a person can act on', dcFork.json?.error?.details?.reason,
    'ALREADY_SUPERSEDED');

  /*
   * The database is the arbiter, not the route. Two genuinely concurrent
   * re-issues of one version both pass the API check; only one row may exist.
   */
  const dcRaceA = uploadDoc(dcOwnerCtx, 'race-a.pdf', Buffer.from('%PDF-1.4 race a', 'ascii'));
  const dcRaceB = uploadDoc(dcOwnerCtx, 'race-b.pdf', Buffer.from('%PDF-1.4 race bb', 'ascii'));
  const [dcRaceFileA, dcRaceFileB] = await Promise.all([dcRaceA, dcRaceB]);
  const [dcRacedA, dcRacedB] = await Promise.all([
    call('POST', `/v1/documents/${dcRamsV2Id}/versions`, { ...dcOwnerCtx, body: { fileId: dcRaceFileA } }),
    call('POST', `/v1/documents/${dcRamsV2Id}/versions`, { ...dcOwnerCtx, body: { fileId: dcRaceFileB } }),
  ]);
  const dcRaceWins = [dcRacedA.status, dcRacedB.status].filter((s) => s === 201).length;
  eq('two simultaneous re-issues of one version: exactly one wins', dcRaceWins, 1);
  const { rows: dcSuccessors } = await db.query<{ n: string }>(
    `select count(*)::int as n from project_documents
      where supersedes_id = $1 and deleted_at is null`,
    [dcRamsV2Id]
  );
  eq('...leaving exactly one successor, so "which is current" still has an answer',
    Number(dcSuccessors[0]?.n), 1);
  const dcRamsV3Id = (dcRacedA.status === 201 ? dcRacedA : dcRacedB).json.document.id as string;

  // ── 4. Superseded versions are hidden, and the history is not ───────────
  const dcCurrent = await call('GET', `/v1/projects/${evProject}/documents`, { ...dcOwnerCtx });
  const dcCurrentIds = (dcCurrent.json.documents as { id: string }[]).map((d) => d.id);
  check('only the current version is listed by default',
    dcCurrentIds.includes(dcRamsV3Id) && !dcCurrentIds.includes(dcRamsV1Id) &&
      !dcCurrentIds.includes(dcRamsV2Id),
    dcCurrentIds);
  const dcWithHistory = await call(
    'GET',
    `/v1/projects/${evProject}/documents?includeSuperseded=true`,
    { ...dcOwnerCtx }
  );
  const dcHistoryIds = (dcWithHistory.json.documents as { id: string }[]).map((d) => d.id);
  check('...and asking for the history returns every version, none deleted',
    dcHistoryIds.includes(dcRamsV1Id) && dcHistoryIds.includes(dcRamsV2Id),
    dcHistoryIds);

  const dcChain = await call('GET', `/v1/documents/${dcRamsV1Id}/versions`, { ...dcOwnerCtx });
  eq('the chain is readable from the OLDEST version somebody is holding',
    (dcChain.json.versions as { id: string }[]).map((v) => v.id),
    [dcRamsV1Id, dcRamsV2Id, dcRamsV3Id]);
  const dcChainFromTip = await call('GET', `/v1/documents/${dcRamsV3Id}/versions`, { ...dcOwnerCtx });
  eq('...and from the newest, which is the one a screen is usually showing',
    (dcChainFromTip.json.versions as { id: string }[]).map((v) => v.id),
    [dcRamsV1Id, dcRamsV2Id, dcRamsV3Id]);

  eq('v1 knows what replaced it, derived rather than stored',
    (dcChain.json.versions as { id: string; supersededById: string }[])[0]?.supersededById,
    dcRamsV2Id);

  // Retracting a bad version restores its predecessor, with nothing to back-fill.
  await call('DELETE', `/v1/documents/${dcRamsV3Id}`, { ...dcOwnerCtx });
  const dcAfterRetract = await call('GET', `/v1/documents/${dcRamsV2Id}`, { ...dcOwnerCtx });
  eq('retracting a wrongly-issued version makes its predecessor current again',
    dcAfterRetract.json.document.supersededById, null);
  const dcReissueAfter = await call('POST', `/v1/documents/${dcRamsV2Id}/versions`, {
    ...dcOwnerCtx,
    body: { fileId: await uploadDoc(dcOwnerCtx, 'rams-v3-correct.pdf', Buffer.from('%PDF-1.4 correct', 'ascii')) },
  });
  eq('...and the slot it freed accepts a correct one', dcReissueAfter.status, 201);
  const dcRamsCurrentId = dcReissueAfter.json.document.id as string;

  // ── 5. There is no route that replaces the bytes in place ──────────────
  const dcSwapBytes = await call('PATCH', `/v1/documents/${dcRamsCurrentId}`, {
    ...dcOwnerCtx,
    body: { fileId: dcRamsV1File },
  });
  eq('the metadata route refuses a fileId, so bytes can never be swapped in place',
    dcSwapBytes.status, 422);

  // ── 6. Scope: whose document is it, and who may read it ────────────────
  const dcSubInsuranceFile = await uploadDoc(dcSubCtx, 'ade-insurance.pdf', Buffer.from('%PDF-1.4 insurance', 'ascii'));
  const dcSubInsurance = await call('POST', `/v1/projects/${evProject}/documents`, {
    ...dcSubCtx,
    body: {
      fileId: dcSubInsuranceFile,
      category: 'INSURANCE',
      title: 'Public liability',
      expiresOn: '2027-01-31',
    },
  });
  eq('a subcontractor files its own insurance on the hiring company\'s project',
    dcSubInsurance.status, 201);
  eq('...and it is filed AGAINST that subcontractor by default, not project-wide',
    dcSubInsurance.json.document.providerCompanyId, evSubCompany);
  const dcSubInsuranceId = dcSubInsurance.json.document.id as string;

  const dcRivalList = await call('GET', `/v1/projects/${evProject}/documents`, {
    token: evSub2.token,
    companyId: evSub2Company,
  });
  const dcRivalIds = (dcRivalList.json.documents as { id: string }[]).map((d) => d.id);
  check('a rival on the same project sees the site RAMS, which it has to follow',
    dcRivalIds.includes(dcRamsCurrentId), dcRivalIds);
  check('...and does NOT see a competitor\'s insurance certificate',
    !dcRivalIds.includes(dcSubInsuranceId), dcRivalIds);
  const dcRivalRead = await call('GET', `/v1/documents/${dcSubInsuranceId}`, {
    token: evSub2.token,
    companyId: evSub2Company,
  });
  eq('...nor can it read one by id', dcRivalRead.status, 404);
  const dcRivalFile = await call('GET', `/v1/files/${dcSubInsuranceFile}/download`, {
    token: evSub2.token,
    companyId: evSub2Company,
  });
  eq('...nor reach its bytes through the file route', dcRivalFile.status, 404);
  const dcRivalRams = await call('GET', `/v1/files/${await ramsFileOf(dcRamsCurrentId)}/download`, {
    token: evSub2.token,
    companyId: evSub2Company,
  });
  eq('...while a project-wide document IS downloadable by everyone on the project',
    dcRivalRams.status, 200);

  const dcOutsiderRams = await call('GET', `/v1/files/${await ramsFileOf(dcRamsCurrentId)}/download`, {
    token: dcOutsider.token,
    companyId: dcOutsider.companyId!,
  });
  eq('...and not by a company that is not on the project at all', dcOutsiderRams.status, 404);

  const dcSubFilesAgainstRival = await call('POST', `/v1/projects/${evProject}/documents`, {
    ...dcSubCtx,
    body: {
      fileId: await uploadDoc(dcSubCtx, 'mischief.pdf', Buffer.from('%PDF-1.4 mischief', 'ascii')),
      category: 'INSURANCE',
      title: 'Not mine to file',
      providerCompanyId: evSub2Company,
    },
  });
  eq('a subcontractor cannot file a document against a competitor', dcSubFilesAgainstRival.status, 403);

  // ── 7. Disclosure to the client is the owner's lever ──────────────────
  const dcSubPublishes = await call('PATCH', `/v1/documents/${dcSubInsuranceId}`, {
    ...dcSubCtx,
    body: { clientVisible: true },
  });
  eq('a subcontractor cannot share a document with the hiring company\'s client',
    dcSubPublishes.status, 403);

  const dcPublish = await call('PATCH', `/v1/documents/${dcRamsCurrentId}`, {
    ...dcOwnerCtx,
    body: { clientVisible: true },
  });
  eq('the project owner shares the RAMS with its client', dcPublish.status, 200);

  const dcPortal = await call('GET', `/v1/portal/projects/${evProject}/documents`, {
    token: evClientUser.token,
    companyId: evClientCompany,
  });
  eq('the client reads what was shared', dcPortal.status, 200);
  eq('...exactly one document', dcPortal.json.documents.length, 1);
  const dcPortalPayload = JSON.stringify(dcPortal.json);
  eq('...and it is the current one',
    (dcPortal.json.documents as { id: string }[]).map((d) => d.id), [dcRamsCurrentId]);
  check('...with no superseded version listed beside it to read by mistake',
    !dcPortalPayload.includes(dcRamsV1Id) && !dcPortalPayload.includes(dcRamsV2Id),
    dcPortalPayload.slice(0, 400));
  check('...and no chain id the client has no route to resolve',
    !dcPortalPayload.includes('supersedesId') && !dcPortalPayload.includes('supersededById'),
    dcPortalPayload.slice(0, 400));
  check('...and nothing about which subcontractor filed what',
    !dcPortalPayload.includes(evSubCompany) && !dcPortalPayload.includes(evSub.userId));
  check('...and no rate, margin or snapshot anywhere in it',
    !/resolvedRate|payRate|marginCents|amountCents/i.test(dcPortalPayload));

  const dcClientDownload = await call('GET', `/v1/files/${await ramsFileOf(dcRamsCurrentId)}/download`, {
    token: evClientUser.token,
    companyId: evClientCompany,
  });
  eq('a shared document is downloadable by the client', dcClientDownload.status, 200);
  const dcClientHidden = await call('GET', `/v1/files/${dcSubInsuranceFile}/download`, {
    token: evClientUser.token,
    companyId: evClientCompany,
  });
  eq('...and an unshared one is not', dcClientHidden.status, 404);

  /*
   * A new version does NOT inherit `client_visible`. Re-publishing new bytes
   * automatically, because the previous version happened to be shared, discloses a
   * document nobody looked at.
   */
  const dcRamsV4 = await call('POST', `/v1/documents/${dcRamsCurrentId}/versions`, {
    ...dcOwnerCtx,
    body: { fileId: await uploadDoc(dcOwnerCtx, 'rams-v4.pdf', Buffer.from('%PDF-1.4 four', 'ascii')) },
  });
  eq('a new version of a shared document is created', dcRamsV4.status, 201);
  eq('...and is NOT shared with the client just because its predecessor was',
    dcRamsV4.json.document.clientVisible, false);
  const dcPortalAfter = await call('GET', `/v1/portal/projects/${evProject}/documents`, {
    token: evClientUser.token,
    companyId: evClientCompany,
  });
  eq('...so the client now sees nothing rather than the wrong copy',
    dcPortalAfter.json.documents.length, 0);

  // ── 8. Supersession is audited and notified as its own act ────────────
  await drainWorkers();
  const { rows: dcSupersedeAudit } = await db.query<{ n: string }>(
    `select count(*)::int as n from audit_logs
      where company_id = $1 and action = 'document.superseded'`,
    [evCompany]
  );
  check('re-issuing is a distinct action in the trail, not an update',
    Number(dcSupersedeAudit[0]?.n) >= 1, dcSupersedeAudit[0]);
  /*
   * The notification is asserted on the SUBCONTRACTOR's renewal further down
   * rather than here, and the reason is worth the line: the owner re-issuing their
   * own RAMS is the only manager of their own company, and nobody is notified
   * about their own action — so zero notifications is the correct answer, not a
   * bug. A test that expected one here would have been green only by accident, on
   * a fixture with a second admin in it.
   */
  const { rows: dcSupersedePayload } = await db.query<{ payload: any }>(
    `select payload from delivery_outbox where topic = 'document.superseded'
     order by created_at desc limit 1`
  );
  check('...while the event itself carries no title and no reference',
    !JSON.stringify(dcSupersedePayload[0]?.payload ?? {}).match(/Site RAMS|RAMS-2026-014/),
    dcSupersedePayload[0]?.payload);

  // ── 9. The expiry ladder, and whose calendar decides ──────────────────
  //
  // Backdated so the certificate is exactly 30 days from lapsing in the project
  // owner's own zone, which is the only clock any of this is allowed to use.
  await db.query(
    `update project_documents
        set expires_on = ((now() at time zone (
              select coalesce(time_zone, 'UTC') from companies where id = $2
            ))::date + interval '30 days')::date
      where id = $1`,
    [dcSubInsuranceId, evCompany]
  );
  const dcExpiryPass = await runDocumentExpiryBatch();
  check('the expiry scan finds a document a month from lapsing', dcExpiryPass.onLadder >= 1,
    dcExpiryPass);
  const { rows: dcRung } = await db.query<{ payload: any; idempotency_key: string }>(
    `select payload, idempotency_key from delivery_outbox
      where topic = 'document.expiring' and aggregate_id = $1`,
    [dcSubInsuranceId]
  );
  eq('...and puts it on the 30-day rung, not the 90-day one it passed months ago',
    dcRung[0]?.payload?.threshold, 30);
  eq('...counting the days from the project owner\'s calendar', dcRung[0]?.payload?.daysRemaining, 30);
  check('...keyed on the document and the rung, so the rung fires once',
    dcRung[0]?.idempotency_key === `document.expiring:${dcSubInsuranceId}:30`,
    dcRung[0]?.idempotency_key);

  // Running it again must not produce a second event for the same rung.
  await runDocumentExpiryBatch();
  const { rows: dcRungCount } = await db.query<{ n: string }>(
    `select count(*)::int as n from delivery_outbox
      where topic = 'document.expiring' and aggregate_id = $1`,
    [dcSubInsuranceId]
  );
  eq('a second scan on the same day enqueues nothing new', Number(dcRungCount[0]?.n), 1);

  await drainWorkers();
  const { rows: dcExpiryNotices } = await db.query<{ company_id: string; title: string }>(
    `select company_id, title from notifications
      where kind = 'document.expiring' and subject_id = $1`,
    [dcSubInsuranceId]
  );
  check('both the hiring company and the subcontractor are told it is lapsing',
    new Set(dcExpiryNotices.map((r) => r.company_id)).size === 2,
    dcExpiryNotices.map((r) => r.company_id));
  check('...in words built from the category and the number, never the title',
    dcExpiryNotices.every((r) => /Insurance expires in 30 days/.test(r.title)),
    dcExpiryNotices.map((r) => r.title));
  const { rows: dcExpiryAction } = await db.query<{ requires_action: boolean }>(
    `select requires_action from notifications
      where kind = 'document.expiring' and subject_id = $1 limit 1`,
    [dcSubInsuranceId]
  );
  eq('...and it is a task, because somebody has to re-issue it',
    dcExpiryAction[0]?.requires_action, true);

  // A lapsed document reaches rung 0 rather than going quiet after 7 days.
  await db.query(
    `update project_documents
        set expires_on = ((now() at time zone (
              select coalesce(time_zone, 'UTC') from companies where id = $2
            ))::date - interval '2 days')::date
      where id = $1`,
    [dcSubInsuranceId, evCompany]
  );
  await runDocumentExpiryBatch();
  const { rows: dcLapsed } = await db.query<{ payload: any }>(
    `select payload from delivery_outbox
      where topic = 'document.expiring' and aggregate_id = $1 and idempotency_key like '%:0'`,
    [dcSubInsuranceId]
  );
  eq('a lapsed document reaches rung 0 rather than going silent after the 7-day step',
    dcLapsed[0]?.payload?.threshold, 0);
  eq('...reporting the days as negative, which a screen renders differently',
    dcLapsed[0]?.payload?.daysRemaining, -2);

  // Re-issuing closes the task the old version raised.
  const dcInsuranceV2 = await call('POST', `/v1/documents/${dcSubInsuranceId}/versions`, {
    ...dcSubCtx,
    body: {
      fileId: await uploadDoc(dcSubCtx, 'ade-insurance-2027.pdf', Buffer.from('%PDF-1.4 renewed', 'ascii')),
      expiresOn: '2028-01-31',
    },
  });
  eq('the subcontractor renews its own insurance', dcInsuranceV2.status, 201);
  await drainWorkers();

  const { rows: dcRenewalNotice } = await db.query<{ title: string }>(
    `select title from notifications
      where kind = 'document.superseded' and company_id = $1
      order by created_at desc limit 1`,
    [evCompany]
  );
  check('...and the hiring company is told which version replaced which',
    /Insurance v2 replaced v1/.test(dcRenewalNotice[0]?.title ?? ''),
    dcRenewalNotice[0]?.title);
  const dcSupersededScan = await runDocumentExpiryBatch();
  const { rows: dcOldStillScanned } = await db.query<{ n: string }>(
    `select count(*)::int as n from delivery_outbox
      where topic = 'document.expiring' and aggregate_id = $1`,
    [dcSubInsuranceId]
  );
  eq('...and the superseded version stops being warned about, because it is handled',
    Number(dcOldStillScanned[0]?.n), 2);
  void dcSupersededScan;

  // ── 10. Packaging and capability ─────────────────────────────────────
  const dcSubOwnProject = await call('GET', `/v1/projects/${evSubOwnProject.json.project.id}/documents`, {
    ...dcSubCtx,
  });
  eq('a Crew-plan company gets no document section on its OWN project', dcSubOwnProject.status, 403);
  check('...naming the key it would need',
    JSON.stringify(dcSubOwnProject.json).includes('project_documents'), dcSubOwnProject.json);

  const dcWorkerFile = await uploadDoc(dcOwnerCtx, 'worker-attempt.pdf', Buffer.from('%PDF-1.4 worker', 'ascii'));
  const dcWorkerUpload = await call('POST', `/v1/projects/${evProject}/documents`, {
    token: evWorker.token,
    companyId: evCompany,
    body: { fileId: dcWorkerFile, category: 'RAMS', title: 'Not my job' },
  });
  eq('a Worker bundle cannot file documents', dcWorkerUpload.status, 403);
  check('...and the refusal names the capability',
    JSON.stringify(dcWorkerUpload.json).includes('document.upload'), dcWorkerUpload.json);

  // ── 11. The location cannot be deleted out from under a document ────
  //
  // A FRESH location with nothing else on it. Reusing Room 3.12 would have passed
  // for the wrong reason — evidence already points at that one, so its refusal
  // names photographs and would be green whether or not documents were ever added
  // to the registry.
  const dcPlant = await call('POST', `/v1/projects/${evProject}/locations`, {
    ...dcOwnerCtx,
    body: { kind: 'SITE_AREA', name: 'Plant room' },
  });
  const dcPlantId = dcPlant.json.location.id as string;
  const dcEmptyDelete = await call('DELETE', `/v1/locations/${dcPlantId}`, { ...dcOwnerCtx });
  eq('an unused location can be deleted outright', dcEmptyDelete.status, 204);

  const dcPlant2 = await call('POST', `/v1/projects/${evProject}/locations`, {
    ...dcOwnerCtx,
    body: { kind: 'SITE_AREA', name: 'Plant room B' },
  });
  const dcPlant2Id = dcPlant2.json.location.id as string;
  const dcDocOnPlant = await call('POST', `/v1/projects/${evProject}/documents`, {
    ...dcOwnerCtx,
    body: {
      fileId: await uploadDoc(dcOwnerCtx, 'plant-drawing.pdf', Buffer.from('%PDF-1.4 drawing', 'ascii')),
      category: 'DRAWING',
      title: 'Plant room layout',
      locationId: dcPlant2Id,
    },
  });
  eq('a drawing is filed against that location', dcDocOnPlant.status, 201);
  const dcPlantDelete = await call('DELETE', `/v1/locations/${dcPlant2Id}`, { ...dcOwnerCtx });
  eq('...and the location can no longer be deleted', dcPlantDelete.status, 409);
  check('...with the refusal naming documents specifically',
    /\bdocuments\b/.test(dcPlantDelete.json?.error?.message ?? ''),
    dcPlantDelete.json?.error?.message);

  // ── 12. Concurrency and the tombstone ──────────────────────────────
  const dcRev = (await call('GET', `/v1/documents/${dcRamsCurrentId}`, { ...dcOwnerCtx })).json
    .document.revision as number;
  const dcEdit = await call('PATCH', `/v1/documents/${dcRamsCurrentId}`, {
    ...dcOwnerCtx,
    body: { notes: 'Reviewed on site', expectedRevision: dcRev },
  });
  eq('an edit against the version it read is applied', dcEdit.status, 200);
  const dcStale = await call('PATCH', `/v1/documents/${dcRamsCurrentId}`, {
    ...dcOwnerCtx,
    body: { notes: 'Composed offline', expectedRevision: dcRev },
  });
  eq('a stale edit is refused', dcStale.status, 409);
  eq('...carrying the current version back', dcStale.json?.error?.details?.currentRevision, dcRev + 1);

  await call('DELETE', `/v1/documents/${dcRamsCurrentId}`, { ...dcOwnerCtx });
  const dcGone = await call('GET', `/v1/documents/${dcRamsCurrentId}`, { ...dcOwnerCtx });
  eq('a deleted document answers as gone, not as never having existed', dcGone.status, 410);
  const dcGoneOutsider = await call('GET', `/v1/documents/${dcRamsCurrentId}`, {
    token: dcOutsider.token,
    companyId: dcOutsider.companyId!,
  });
  eq('...while an outsider gets the same 404 as always', dcGoneOutsider.status, 404);

  // ── The site diary ────────────────────────────────────────────────────────
  section('Site diary — attendance, Close Day and the amendment nobody can hide');

  /*
   * Reuses the evidence fixture, so the diary is proved on a project that
   * genuinely has a hiring company, a subcontractor on the free Crew plan, a rival
   * trade, a Worker-bundle member and a client on it — which is what makes the
   * scope assertions below mean anything.
   */
  const dyOwnerCtx = { token: evOwner.token, companyId: evCompany };
  const dySubCtx = evSubCtx;
  const dyRivalCtx = { token: evSub2.token, companyId: evSub2Company };
  const DAY = '2026-03-03'; // a Tuesday, which the notification titles assert

  /*
   * A second decision-maker inside Ade's company, and the amendment assertions
   * below are the reason it exists.
   *
   * §6 says an amendment reaches Priya **and the authoring company's owners**, and
   * on a one-person company those two claims collapse: the only owner is the
   * person who amended it, and "nobody is told about their own action" quite
   * correctly silences the second notice. The first version of this section
   * asserted the second dispatch against exactly that fixture and read a
   * deliberate rule as a bug. A Crew plan sells one seat, so the seat is granted
   * the way an operator would grant it.
   */
  await db.query(
    `insert into company_entitlement_overrides (company_id, limit_key, limit_value, note)
     values ($1, 'internal_seats', 3, 'verify-e2e: a second decision-maker for the diary')`,
    [evSubCompany]
  );
  const dySubPartner = await register(
    'dysubpartner', undefined, `dysubpartner+${RUN}@verify.crewquo.test`);
  const dySubPartnerInvite = await call('POST', '/v1/members/invite', {
    ...evSubCtx,
    body: { email: dySubPartner.email, role: 'ADMIN' },
  });
  eq('a second decision-maker is invited into the subcontractor',
    dySubPartnerInvite.status, 201);
  const dySubPartnerJoin = await call(
    'POST', `/v1/invites/${dySubPartnerInvite.json.inviteToken}/accept`,
    { token: dySubPartner.token });
  eq('...and joins it', dySubPartnerJoin.status, 201);

  // ── 1. Opening a day ─────────────────────────────────────────────────────
  const dyEmpty = await call('GET', `/v1/projects/${evProject}/diary`, { ...dyOwnerCtx });
  eq('a project with no diary says so', dyEmpty.status, 200);
  eq('...with an empty list rather than an invented today', dyEmpty.json.entries, []);

  const dyFuture = await call('POST', `/v1/projects/${evProject}/diary`, {
    ...dySubCtx,
    body: { entryDate: '2099-01-01' },
  });
  eq('a diary entry cannot be written for a day that has not happened', dyFuture.status, 422);

  const dyBadTimes = await call('POST', `/v1/projects/${evProject}/diary`, {
    ...dySubCtx,
    body: { entryDate: DAY, startTime: '17:00', finishTime: '07:30' },
  });
  eq('a day that finishes before it starts is a typo, not a shift', dyBadTimes.status, 422);

  const dySubDay = await call('POST', `/v1/projects/${evProject}/diary`, {
    ...dySubCtx,
    body: {
      entryDate: DAY,
      startTime: '07:30',
      finishTime: '17:00',
      workCompleted: 'Second fix to Floor 3',
      weather: 'Dry, cold',
      locationIds: [evFloorId],
      clientId: randomUUID(),
    },
  });
  eq('a subcontractor on a free plan writes up the day on the hiring company’s job',
    dySubDay.status, 201);
  eq('...as an OPEN entry', dySubDay.json.entry.status, 'OPEN');
  eq('...attributed to its own company', dySubDay.json.entry.companyId, evSubCompany);
  eq('...with the times trimmed to what a time input speaks', dySubDay.json.entry.startTime, '07:30');
  eq('...and nobody has amended anything yet', dySubDay.json.entry.amendedTimes, 0);
  const dySubEntry = dySubDay.json.entry.id as string;

  // §23: one entry per project per day per company. Asking twice is one day.
  const dyAgain = await call('POST', `/v1/projects/${evProject}/diary`, {
    ...dySubCtx,
    body: { entryDate: DAY },
  });
  eq('opening the same day twice returns the same day rather than refusing', dyAgain.status, 200);
  eq('...the very same entry', dyAgain.json.entry.id, dySubEntry);

  /*
   * The hiring company keeps its own diary for the same day. Two companies on one
   * site, two records, both attributed and both true — §2's rule, and the reason
   * the unique key has three columns rather than two.
   */
  const dyOwnerDay = await call('POST', `/v1/projects/${evProject}/diary`, {
    ...dyOwnerCtx,
    body: { entryDate: DAY, workCompleted: 'Client walkthrough at 14:00' },
  });
  eq('the hiring company keeps its own diary for the same day', dyOwnerDay.status, 201);
  const dyOwnerEntry = dyOwnerDay.json.entry.id as string;
  check('...and it is a different record', dyOwnerEntry !== dySubEntry,
    { dyOwnerEntry, dySubEntry });

  // ── 2. Who reads whose, and who may correct it ───────────────────────────
  const dyOwnerList = await call('GET', `/v1/projects/${evProject}/diary`, { ...dyOwnerCtx });
  eq('the project owner sees both companies’ diaries', dyOwnerList.json.entries.length, 2);
  eq('...each naming who wrote it',
    (dyOwnerList.json.entries as any[]).map((e) => e.companyId).sort(),
    [evCompany, evSubCompany].sort());

  const dySubList = await call('GET', `/v1/projects/${evProject}/diary`, { ...dySubCtx });
  eq('the subcontractor sees only its own', dySubList.json.entries.length, 1);
  eq('...its own', dySubList.json.entries[0].id, dySubEntry);

  const dySubPeek = await call('GET', `/v1/diary/${dyOwnerEntry}`, { ...dySubCtx });
  eq('a subcontractor asking for the hiring company’s day is told it does not exist',
    dySubPeek.status, 404);

  const dyOutsiderRead = await call('GET', `/v1/diary/${dySubEntry}`, {
    token: dcOutsider.token,
    companyId: dcOutsider.companyId!,
  });
  eq('an unrelated company gets the same 404', dyOutsiderRead.status, 404);

  /*
   * The one asymmetry in the phase, and it is deliberate: Priya may re-tag Ade's
   * photograph and share his document with her client, and may not edit his
   * statement about what he saw.
   */
  const dyOwnerEdits = await call('PATCH', `/v1/diary/${dySubEntry}`, {
    ...dyOwnerCtx,
    body: { delays: 'Actually the crane was fine' },
  });
  eq('the project owner cannot edit a subcontractor’s diary entry', dyOwnerEdits.status, 403);
  check('...and the refusal says whose record it is',
    /written by another company/.test(dyOwnerEdits.json?.error?.message ?? ''),
    dyOwnerEdits.json?.error?.message);

  // ── 3. Prefill, and the confirm that must not double the crew ────────────
  /*
   * The role lives in the HIRING company's catalog, not the subcontractor's:
   * `assertRoleInCompany` checks it against the engagement's client side, because
   * a role is what the hiring company is buying rather than what the crew calls
   * itself. Written the other way round first, and the 422 said so.
   */
  const dyRole = await call('POST', '/v1/role-catalog', {
    ...dyOwnerCtx,
    body: { name: `Fit-out labourer ${RUN}` },
  });
  const dyRoleId = dyRole.json.role.id as string;

  const dySubmittedLog = await call('POST', '/v1/time-logs', {
    ...dySubCtx,
    body: {
      projectId: evProject,
      roleId: dyRoleId,
      shiftType: 'WEEKDAY_DAY',
      workDate: DAY,
      hoursRegular: 8,
      hoursOt: 0,
    },
  });
  eq('the subcontractor logs 8h against the same day', dySubmittedLog.status, 201);
  const dyDraftLog = await call('POST', '/v1/time-logs', {
    ...dySubCtx,
    body: {
      projectId: evProject, roleId: dyRoleId, shiftType: 'WEEKDAY_DAY',
      workDate: DAY, hoursRegular: 6, hoursOt: 0,
    },
  });
  eq('...and a second, which stays a draft', dyDraftLog.status, 201);

  const dySubmit = await call('POST', `/v1/time-logs/${dySubmittedLog.json.timeLog.id}/submit`, {
    ...dySubCtx,
  });
  eq('...and submits the first one, leaving one of each status on the day',
    dySubmit.status, 200);

  const dyPrefill = await call(
    'GET', `/v1/projects/${evProject}/diary/prefill?date=${DAY}`, { ...dySubCtx });
  eq('the prefill answers for the day', dyPrefill.status, 200);
  eq('...offering the submitted timesheet and not the draft', dyPrefill.json.attendance.length, 1);
  eq('...linked to the timesheet it came from',
    dyPrefill.json.attendance[0].timeLogId, dySubmittedLog.json.timeLog.id);
  eq('...as the diary company’s own person rather than a subcontracted crew',
    dyPrefill.json.attendance[0].providerCompanyId, null);
  eq('...saying where it came from', dyPrefill.json.attendance[0].source, 'TIME_LOG');
  eq('...counting the draft nobody has submitted', dyPrefill.json.unsubmittedTimeLogs, 1);
  /*
   * **The hook coming due, and this assertion is how it came due.**
   *
   * It read `schedule: false` from 7.5 until Phase 11, and it failed on the run that
   * shipped §31 — which is exactly what it was written for. The reason it is now
   * `true` here is worth being precise about: this fixture's project belongs to a
   * company on the Pro plan, so `scheduling` is in its entitlements and the source
   * is consulted. It answers `false` only for an owner whose plan lacks the key,
   * which is a fact about a subscription rather than about the build — and that is
   * the whole difference between the flag meaning something and meaning nothing.
   */
  eq('...and naming the schedule as the second source it now has',
    dyPrefill.json.sources, { timeLogs: true, schedule: true });

  const dyConfirmBody = {
    userId: dyPrefill.json.attendance[0].userId,
    roleId: dyRoleId,
    hours: 8,
    timeLogId: dySubmittedLog.json.timeLog.id,
  };
  const dyConfirm = await call('POST', `/v1/diary/${dySubEntry}/attendance`, {
    ...dySubCtx,
    body: dyConfirmBody,
  });
  eq('the supervisor confirms the prefilled line rather than retyping it', dyConfirm.status, 201);
  eq('...and one person is on site', dyConfirm.json.entry.workersPresentCount, 1);

  /*
   * The confirm button is the one a person on a tablet presses twice. Without the
   * one-per-time-log index the second press produces a day with an imaginary
   * person on it and nothing in the record saying which one.
   */
  const dyConfirmAgain = await call('POST', `/v1/diary/${dySubEntry}/attendance`, {
    ...dySubCtx,
    body: dyConfirmBody,
  });
  eq('confirming the prefill twice is a no-op, not a second person', dyConfirmAgain.status, 201);
  eq('...and it says so rather than pretending', dyConfirmAgain.json.added, false);
  eq('...with the headcount unmoved', dyConfirmAgain.json.entry.workersPresentCount, 1);

  const dyPrefillAgain = await call(
    'GET', `/v1/projects/${evProject}/diary/prefill?date=${DAY}`, { ...dySubCtx });
  eq('a confirmed suggestion is marked rather than hidden, so nothing vanishes silently',
    dyPrefillAgain.json.attendance[0].alreadyPresent, true);

  const dyCrew = await call('POST', `/v1/diary/${dySubEntry}/attendance`, {
    ...dySubCtx,
    body: { providerCompanyId: evSub2Company, name: 'Scaffold crew', headcount: 4 },
  });
  eq('a subcontracted crew is recorded as a crew', dyCrew.status, 201);
  eq('...counted separately from the company’s own people',
    dyCrew.json.entry.subcontractorsPresentCount, 4);
  eq('...which does not change the worker count', dyCrew.json.entry.workersPresentCount, 1);
  const dyCrewLineId = (dyCrew.json.entry.attendance as any[])
    .find((a) => a.providerCompanyId === evSub2Company)?.id as string;

  const dyNobody = await call('POST', `/v1/diary/${dySubEntry}/attendance`, {
    ...dySubCtx,
    body: { headcount: 3 },
  });
  eq('an attendance line that names nobody is a headcount, not attendance', dyNobody.status, 422);

  /*
   * Naming a real company that is not on this job is an assertion about a business
   * that cannot see the record it appears in. An off-platform crew has no company
   * row at all and is recorded by name, which is the column that exists for it.
   */
  const dyStrangerCrew = await call('POST', `/v1/diary/${dySubEntry}/attendance`, {
    ...dySubCtx,
    body: { providerCompanyId: dcOutsider.companyId, headcount: 2 },
  });
  eq('a company that is not on this project cannot be recorded as present on it',
    dyStrangerCrew.status, 422);

  const dyForeignLog = await call('POST', `/v1/diary/${dyOwnerEntry}/attendance`, {
    ...dyOwnerCtx,
    body: { name: 'Borrowed', timeLogId: dySubmittedLog.json.timeLog.id },
  });
  eq('one company cannot cite another company’s timesheet in its diary',
    dyForeignLog.status, 422);

  // ── 4. Photographs belong to a day ───────────────────────────────────────
  const dyPhotoFile = await uploadPhoto(dySubCtx, `diary-floor-3-${RUN}.png`, evPhoto);
  const dyPhoto = await call('POST', `/v1/projects/${evProject}/evidence`, {
    ...dySubCtx,
    body: {
      batchClientId: randomUUID(),
      defaults: { category: 'DURING', evidenceDate: DAY, diaryEntryId: dySubEntry },
      items: [{ fileId: dyPhotoFile }],
    },
  });
  eq('a photograph is filed against the written-up day', dyPhoto.status, 201);
  eq('...carrying the day it belongs to', dyPhoto.json.created[0].diaryEntryId, dySubEntry);

  const dyWrongDiary = await call('POST', `/v1/projects/${evProject}/evidence`, {
    ...dySubCtx,
    body: {
      batchClientId: randomUUID(),
      defaults: { diaryEntryId: dyOwnerEntry },
      items: [{ fileId: await uploadPhoto(dySubCtx, `stray-${RUN}.png`, evPhoto) }],
    },
  });
  eq('a photograph cannot be filed under another company’s written-up day',
    dyWrongDiary.json.created.length, 0);
  eq('...and the batch says which file and why',
    dyWrongDiary.json.rejected[0]?.code, 'FILE_NOT_USABLE');

  const dyFiltered = await call(
    'GET', `/v1/projects/${evProject}/evidence?diaryEntryId=${dySubEntry}`, { ...dySubCtx });
  eq('the day reads its own photographs back', dyFiltered.json.evidence.length, 1);

  // ── 5. The per-field merge (§8) ──────────────────────────────────────────
  const dyRev = (await call('GET', `/v1/diary/${dySubEntry}`, { ...dySubCtx })).json.entry
    .revision as number;
  const dyFirstEdit = await call('PATCH', `/v1/diary/${dySubEntry}`, {
    ...dySubCtx,
    body: { delays: 'Crane late', expectedRevision: dyRev },
  });
  eq('an edit against the version it read applies', dyFirstEdit.status, 200);

  /*
   * The case the merge exists for. This edit was composed against the version
   * before "Crane late" landed and touches a different field — so whole-row
   * optimistic concurrency would raise a conflict prompt about a change nobody
   * made, and whole-row last-write-wins would delete a colleague's paragraph.
   */
  const dyMerged = await call('PATCH', `/v1/diary/${dySubEntry}`, {
    ...dySubCtx,
    body: { issues: 'Water ingress in 3.12', expectedRevision: dyRev, base: { issues: null } },
  });
  eq('a stale edit to a field nobody else touched merges rather than refusing',
    dyMerged.status, 200);
  eq('...keeping the colleague’s paragraph', dyMerged.json.entry.delays, 'Crane late');
  eq('...and landing its own', dyMerged.json.entry.issues, 'Water ingress in 3.12');

  const dyCollision = await call('PATCH', `/v1/diary/${dySubEntry}`, {
    ...dySubCtx,
    body: { delays: 'Crane cancelled entirely', expectedRevision: dyRev, base: { delays: null } },
  });
  eq('two people writing the same field is a question, not a merge', dyCollision.status, 409);
  eq('...named as a field conflict', dyCollision.json?.error?.details?.reason, 'FIELD_CONFLICT');
  eq('...naming the field a person has to decide about',
    (dyCollision.json?.error?.details?.conflicts ?? []).map((c: any) => c.field), ['delays']);
  eq('...and showing both sides of it',
    dyCollision.json?.error?.details?.conflicts?.[0]?.theirs, 'Crane late');

  const dyStillMine = await call('GET', `/v1/diary/${dySubEntry}`, { ...dySubCtx });
  eq('...having written nothing, because a 409 that already wrote would be a lie',
    dyStillMine.json.entry.delays, 'Crane late');

  const dyStale = await call('PATCH', `/v1/diary/${dySubEntry}`, {
    ...dySubCtx,
    body: { notes: 'Composed offline', expectedRevision: dyRev },
  });
  eq('a stale edit with no base takes the ordinary contract and refuses', dyStale.status, 409);
  eq('...as a plain stale revision', dyStale.json?.error?.details?.reason, 'STALE_REVISION');

  const dyStatusPatch = await call('PATCH', `/v1/diary/${dySubEntry}`, {
    ...dySubCtx,
    body: { status: 'CLOSED' },
  });
  eq('a day cannot be closed by PATCHing its status', dyStatusPatch.status, 422);

  // ── 6. Close Day, and its prompts ────────────────────────────────────────
  const dyBeforeClose = await call('GET', `/v1/diary/${dyOwnerEntry}`, { ...dyOwnerCtx });
  const dyPromptCodes = (dyBeforeClose.json.closePrompts as any[]).map((p) => p.code);
  check('a day with nothing on it is told what is missing, one prompt at a time',
    dyPromptCodes.includes('NO_ATTENDANCE') && dyPromptCodes.includes('NO_EVIDENCE'),
    dyPromptCodes);
  check('...and never prompted about assets, which this product cannot record yet',
    !JSON.stringify(dyPromptCodes).toLowerCase().includes('asset'), dyPromptCodes);

  const dyWorkerClose = await call('POST', `/v1/diary/${dyOwnerEntry}/close`, {
    token: evWorker.token,
    companyId: evCompany,
    body: {},
  });
  eq('a Worker bundle cannot close a day', dyWorkerClose.status, 403);
  check('...and the refusal names the capability',
    JSON.stringify(dyWorkerClose.json).includes('diary.close'), dyWorkerClose.json);

  /*
   * The owner's digest is set to DAILY first, so the two notifications below are
   * distinguishable by *when* they are due rather than only by what they say —
   * which is the only way to prove `diary.amended` escapes batching.
   */
  await db.query(
    `insert into notification_preferences (user_id, digest) values ($1, 'DAILY')
     on conflict (user_id) do update set digest = 'DAILY'`,
    [evOwner.userId]
  );

  const dyClose = await call('POST', `/v1/diary/${dySubEntry}/close`, {
    ...dySubCtx,
    body: { clientId: randomUUID() },
  });
  eq('the supervisor closes the day', dyClose.status, 200);
  eq('...and it is closed', dyClose.json.entry.status, 'CLOSED');
  eq('...stamped with who closed it', dyClose.json.entry.closedByUserId, evSub.userId);
  check('...and when', typeof dyClose.json.entry.closedAt === 'string',
    dyClose.json.entry.closedAt);
  check('...returning the prompts again rather than having blocked on them',
    Array.isArray(dyClose.json.closePrompts), dyClose.json.closePrompts);

  // The packet's §9 row: a second device tries, and is told who won and when.
  const dyRaceLoser = await call('POST', `/v1/diary/${dySubEntry}/close`, {
    ...dySubCtx,
    body: {},
  });
  eq('a second device closing the same day is refused', dyRaceLoser.status, 409);
  eq('...by name', dyRaceLoser.json?.error?.details?.reason, 'ALREADY_CLOSED');
  check('...telling it who closed the day, and offering the amendment rather than a retry',
    /closed this day at \d\d:\d\d\. Amend it with a reason\?$/.test(
      dyRaceLoser.json?.error?.message ?? ''),
    dyRaceLoser.json?.error?.message);

  await drainWorkers();
  const { rows: dyClosedNotice } = await db.query<{ title: string; body: string }>(
    `select title, body from notifications
      where kind = 'diary.closed' and company_id = $1
      order by created_at desc limit 1`,
    [evCompany]
  );
  eq('the hiring company is told, and the day is named the way a person would find it',
    dyClosedNotice[0]?.title, 'Tuesday 3 March closed');
  check('...with the attendance the day closed with', /5 on site/.test(dyClosedNotice[0]?.body ?? ''),
    dyClosedNotice[0]?.body);

  const { rows: dySelfNotice } = await db.query<{ n: string }>(
    `select count(*)::int as n from notifications
      where kind = 'diary.closed' and company_id = $1`,
    [evSubCompany]
  );
  eq('nobody is told about their own action', Number(dySelfNotice[0]?.n), 0);

  // ── 7. The amendment ─────────────────────────────────────────────────────
  const dyNoReason = await call('PATCH', `/v1/diary/${dySubEntry}`, {
    ...dySubCtx,
    body: { deliveries: 'Two pallets of board, 15:40' },
  });
  eq('changing a closed day without saying why is refused', dyNoReason.status, 422);
  eq('...by name', dyNoReason.json?.error?.details?.reason, 'REASON_REQUIRED');

  const dyAmend = await call('PATCH', `/v1/diary/${dySubEntry}`, {
    ...dySubCtx,
    body: {
      deliveries: 'Two pallets of board, 15:40',
      reason: 'Delivery note arrived the next morning',
    },
  });
  eq('an amendment with a reason is accepted', dyAmend.status, 200);
  eq('...and the day is still closed, because there is no reopen',
    dyAmend.json.entry.status, 'CLOSED');
  eq('...counted once', dyAmend.json.entry.amendedTimes, 1);
  eq('...and said in the singular', dyAmend.json.amendedLabel, 'amended 1 time');

  const { rows: dyRevision } = await db.query<{
    revision: number; before: any; after: any; changed_fields: string[]; reason: string;
  }>(
    `select revision, before, after, changed_fields, reason from record_revisions
      where entity_type = 'site_diary_entry' and entity_id = $1 order by revision desc limit 1`,
    [dySubEntry]
  );
  eq('§36’s row names the field that changed', dyRevision[0]?.changed_fields, ['deliveries']);
  eq('...carrying what it was', dyRevision[0]?.before?.deliveries, null);
  eq('...what it became', dyRevision[0]?.after?.deliveries, 'Two pallets of board, 15:40');
  eq('...and the reason, which is what makes the trail readable',
    dyRevision[0]?.reason, 'Delivery note arrived the next morning');

  const dyHistory = await call('GET', `/v1/diary/${dySubEntry}/history`, { ...dyOwnerCtx });
  eq('the hiring company can read the history it was notified about', dyHistory.status, 200);
  eq('...one amendment', dyHistory.json.revisions.length, 1);
  eq('...labelled the way every screen renders it', dyHistory.json.amendedLabel, 'amended 1 time');

  const dyAttendanceAmend = await call(
    'PATCH', `/v1/diary/${dySubEntry}/attendance/${dyCrewLineId}`, {
      ...dySubCtx,
      body: { headcount: 3, reason: 'One of the scaffolders left at midday' },
    });
  eq('attendance on a closed day is an amendment too, not a free edit',
    dyAttendanceAmend.status, 200);
  eq('...and the derived count follows it',
    dyAttendanceAmend.json.entry.subcontractorsPresentCount, 3);
  eq('...counted as a second amendment', dyAttendanceAmend.json.entry.amendedTimes, 2);

  const dyAttendanceNoReason = await call('POST', `/v1/diary/${dySubEntry}/attendance`, {
    ...dySubCtx,
    body: { name: 'Late arrival' },
  });
  eq('adding somebody to a closed day without a reason is refused',
    dyAttendanceNoReason.status, 422);

  await drainWorkers();
  const { rows: dyAmendNotice } = await db.query<{ title: string; deliver_after: Date | null }>(
    `select n.title,
            (select min(d.deliver_after) from notification_deliveries d
              where d.notification_id = n.id and d.channel = 'EMAIL') as deliver_after
       from notifications n
      where n.kind = 'diary.amended' and n.company_id = $1
      order by n.created_at asc limit 1`,
    [evCompany]
  );
  eq('the amendment notice names the day and says why',
    dyAmendNotice[0]?.title,
    'Tuesday 3 March amended — reason: Delivery note arrived the next morning');

  const { rows: dyClosedDue } = await db.query<{ deliver_after: Date }>(
    `select min(d.deliver_after) as deliver_after
       from notifications n join notification_deliveries d on d.notification_id = n.id
      where n.kind = 'diary.closed' and n.company_id = $1 and d.channel = 'EMAIL'`,
    [evCompany]
  );
  /*
   * The whole point of `neverDigest`, proved rather than asserted: with the reader
   * on a DAILY digest, the close is held to the digest boundary and the amendment
   * is not. A digest is a promise that nothing in it was urgent, and an amendment
   * to a closed day is precisely the thing that is.
   */
  check('a closed day is batched into the reader’s digest',
    (dyClosedDue[0]?.deliver_after?.getTime() ?? 0) > Date.now() + 60_000,
    dyClosedDue[0]?.deliver_after);
  check('...and an amendment never is',
    (dyAmendNotice[0]?.deliver_after?.getTime() ?? Number.POSITIVE_INFINITY) <=
      Date.now() + 60_000,
    dyAmendNotice[0]?.deliver_after);

  const { rows: dyAuthorNotice } = await db.query<{ recipient_user_id: string }>(
    `select recipient_user_id from notifications
      where kind = 'diary.amended' and company_id = $1`,
    [evSubCompany]
  );
  const dyAuthorRecipients = dyAuthorNotice.map((r) => r.recipient_user_id);
  check('the authoring company’s own decision-makers are told too, because they may have quoted it',
    dyAuthorRecipients.includes(dySubPartner.userId!), dyAuthorRecipients);
  check('...and the person who made the amendment is not told about their own act',
    !dyAuthorRecipients.includes(evSub.userId!), dyAuthorRecipients);

  await db.query(`update notification_preferences set digest = 'IMMEDIATE' where user_id = $1`,
    [evOwner.userId]);

  // ── 8. Locations, documents, and the packaging ───────────────────────────
  const dyBay = await call('POST', `/v1/projects/${evProject}/locations`, {
    ...dyOwnerCtx,
    body: { kind: 'SITE_AREA', name: `Loading bay ${RUN}` },
  });
  const dyBayId = dyBay.json.location.id as string;
  const dyOwnerLocs = await call('PATCH', `/v1/diary/${dyOwnerEntry}`, {
    ...dyOwnerCtx,
    body: { locationIds: [dyBayId] },
  });
  eq('a day names the areas its work happened in', dyOwnerLocs.status, 200);
  eq('...and reads them back', dyOwnerLocs.json.entry.locationIds, [dyBayId]);

  const dyLocDelete = await call('DELETE', `/v1/locations/${dyBayId}`, { ...dyOwnerCtx });
  eq('...so that location can no longer be deleted', dyLocDelete.status, 409);
  check('...with the refusal naming diary entries specifically',
    /\bdiary entries\b/.test(dyLocDelete.json?.error?.message ?? ''),
    dyLocDelete.json?.error?.message);

  const dyCiteRams = await call('PATCH', `/v1/diary/${dySubEntry}`, {
    ...dySubCtx,
    body: { documentIds: [dcRamsV1Id], reason: 'The RAMS that was current on the day' },
  });
  eq('a day may cite a project-wide document', dyCiteRams.status, 200);
  eq('...and reads it back', dyCiteRams.json.entry.documentIds, [dcRamsV1Id]);

  const dyRivalInsurance = await call('POST', `/v1/projects/${evProject}/documents`, {
    ...dyRivalCtx,
    body: {
      fileId: await uploadDoc(dyRivalCtx, `rival-insurance-${RUN}.pdf`,
        Buffer.from('%PDF-1.4 rival insurance', 'ascii')),
      category: 'INSURANCE',
      title: 'Rival public liability',
    },
  });
  eq('the rival trade files its own insurance', dyRivalInsurance.status, 201);
  const dyCiteRival = await call('PATCH', `/v1/diary/${dySubEntry}`, {
    ...dySubCtx,
    body: {
      documentIds: [dyRivalInsurance.json.document.id],
      reason: 'Trying it on',
    },
  });
  /*
   * Citing is a way of showing. A scope check that stopped at the project would
   * make the diary a route around the document scope: file a competitor's
   * insurance certificate into your Tuesday and it becomes readable from there.
   */
  eq('a day cannot cite a competitor’s paperwork into view', dyCiteRival.status, 422);

  const dySubOwn = await call('GET', `/v1/projects/${evSubOwnProject.json.project.id}/diary`, {
    ...dySubCtx,
  });
  eq('a Crew-plan company gets no diary on its OWN project', dySubOwn.status, 403);
  check('...naming the key it would need',
    JSON.stringify(dySubOwn.json).includes('site_diary'), dySubOwn.json);

  const dyWorkerWrite = await call('POST', `/v1/projects/${evProject}/diary`, {
    token: evWorker.token,
    companyId: evCompany,
    body: { entryDate: DAY, notes: 'Not my job' },
  });
  eq('a Worker bundle cannot write the diary', dyWorkerWrite.status, 403);
  check('...and the refusal names the capability',
    JSON.stringify(dyWorkerWrite.json).includes('diary.write'), dyWorkerWrite.json);

  // ── 9. There is no delete, and the absence is the design ─────────────────
  const dyDelete = await call('DELETE', `/v1/diary/${dySubEntry}`, { ...dySubCtx });
  check('no route deletes a day: a day that can be removed is a day somebody can ' +
    'make not have happened',
    dyDelete.status === 404 || dyDelete.status === 405, dyDelete.status);

  const { rows: dyStillThere } = await db.query<{ status: string }>(
    `select status from site_diary_entries where id = $1`, [dySubEntry]);
  eq('...and it is still closed, still there', dyStillThere[0]?.status, 'CLOSED');

  // ── Project assets (§25.2, §25.3) — Phase 8 build order step 2 ───────────
  section('Project assets — the weight, the degrade, and the serial that is already somewhere');

  const asType = async (code: string): Promise<string> => {
    const { rows } = await db.query<{ id: string }>(
      `select id from asset_types where company_id is null and code = $1`, [code]);
    return rows[0]!.id;
  };
  const CHAIR = await asType('OPERATOR_CHAIR');
  const DESK = await asType('DESK');
  const SERVER = await asType('SERVER');

  const asOwnerCtx = { token: evOwner.token, companyId: evCompany };

  // ── 1. Empty ──────────────────────────────────────────────────────────────
  const asEmpty = await call('GET', `/v1/projects/${evProject}/assets`, { ...asOwnerCtx });
  eq('a project with no assets answers with an empty register', asEmpty.status, 200);
  eq('...and not with a zero tonnage, which would be a claim',
    (asEmpty.json.assets as unknown[]).length, 0);

  // ── 2. Ade records 42 chairs, on somebody else's project, on the free plan ─
  //
  // The packaging rule of 2026-09-01 with a different noun: the entitlement is
  // checked against the project OWNER, so a Crew-plan subcontractor can record
  // what it removed. A clearance contractor who cannot do that cannot work.
  const asChairs = await call('POST', `/v1/projects/${evProject}/assets`, {
    ...evSubCtx,
    body: {
      assetTypeId: CHAIR,
      quantity: 42,
      weightBasis: 'UNIT',
      unitWeightKg: 16.5,
      weightSource: 'USER_ESTIMATE',
      originLocationId: evFloor.json.location.id,
      clientId: randomUUID(),
    },
  });
  eq('a Crew-plan subcontractor records assets on the owner’s project', asChairs.status, 201);
  const asChairId = asChairs.json.asset.id as string;
  eq('...and the total is derived from the unit weight it typed',
    asChairs.json.asset.totalWeightKg, 693);
  eq('...with the basis recording which side was entered',
    asChairs.json.asset.weightBasis, 'UNIT');
  eq('...an estimate, because that is what USER_ESTIMATE supports',
    asChairs.json.asset.weightConfidence, 'ESTIMATED');
  eq('...and outcome state starts derived at PENDING, never typed',
    asChairs.json.asset.outcomeState, 'PENDING');

  // ── 3. Its own project, its own plan, and the opposite answer ─────────────
  const asOwnProject = await call('POST', '/v1/projects', {
    ...evSubCtx,
    body: { name: `Ade’s own job ${RUN}` },
  });
  const asSubOwnProject = asOwnProject.json.project?.id as string | undefined;
  if (asSubOwnProject) {
    const asOwnAsset = await call('POST', `/v1/projects/${asSubOwnProject}/assets`, {
      ...evSubCtx,
      body: { assetTypeId: CHAIR, quantity: 5 },
    });
    eq('the same company is refused on its OWN project — the key is the owner’s',
      asOwnAsset.status, 403);
    check('...and the refusal names asset_tracking rather than saying Forbidden',
      JSON.stringify(asOwnAsset.json).includes('asset_tracking'), asOwnAsset.json);
  }

  // ── 4. The degrade: a failed verification saves the work ──────────────────
  //
  // A Supervisor holds asset.write and deliberately not asset.weight.verify
  // (§37, and capabilities.ts says why). The measurement is the data the product
  // exists to collect, so it is SAVED as an estimate rather than thrown away to
  // protect a label.
  const asSup = await register('assup', undefined, `assup+${RUN}@verify.crewquo.test`);
  const asSupInvite = await call('POST', '/v1/members/invite', {
    ...evSubCtx,
    body: { email: asSup.email, role: 'MEMBER' },
  });
  await call('POST', `/v1/invites/${asSupInvite.json.inviteToken}/accept`, { token: asSup.token });
  await db.query(
    `update memberships set bundle_key = 'supervisor' where company_id = $1 and user_id = $2`,
    [evSubCompany, asSup.userId]
  );
  const asSupCtx = { token: asSup.token, companyId: evSubCompany };

  const asSupWeighed = await call('POST', `/v1/projects/${evProject}/assets`, {
    ...asSupCtx,
    body: {
      assetTypeId: DESK,
      quantity: 8,
      weightBasis: 'UNIT',
      unitWeightKg: 30,
      weightSource: 'WEIGHED',
      weightConfidence: 'VERIFIED',
      weighedByUserId: asSup.userId,
    },
  });
  eq('a supervisor without asset.weight.verify still gets the line written',
    asSupWeighed.status, 201);
  eq('...the weight is kept, to the gram', asSupWeighed.json.asset.totalWeightKg, 240);
  eq('...but the claim is downgraded to an estimate',
    asSupWeighed.json.asset.weightConfidence, 'ESTIMATED');
  check('...and the response says why, naming the permission',
    String(asSupWeighed.json.notice ?? '').includes('weight-verification permission'),
    asSupWeighed.json.notice);

  const asSupDeskId = asSupWeighed.json.asset.id as string;

  // The same claim from someone who does hold it, with a named weigher.
  const asVerified = await call('PATCH', `/v1/assets/${asSupDeskId}`, {
    ...evSubCtx,
    body: { weightSource: 'WEIGHED', weightConfidence: 'VERIFIED', weighedByUserId: asSup.userId },
  });
  eq('...and an admin who holds the capability may make the same claim stick',
    asVerified.json.asset?.weightConfidence, 'VERIFIED');
  eq('...which flips the denormalized estimate flag with it',
    asVerified.json.asset?.weightIsEstimated, false);

  // A VERIFIED weighbridge figure with no ticket attached is refused the label —
  // WEIGHED is the only source whose provenance is a person rather than paper.
  const asNoTicket = await call('PATCH', `/v1/assets/${asSupDeskId}`, {
    ...evSubCtx,
    body: { weightSource: 'WEIGHBRIDGE', weightConfidence: 'VERIFIED', weighedByUserId: null },
  });
  eq('a weighbridge claim with no ticket attached degrades to an estimate',
    asNoTicket.json.asset?.weightConfidence, 'ESTIMATED');
  check('...and says the document is what is missing',
    String(asNoTicket.json.notice ?? '').includes('document'), asNoTicket.json.notice);

  // ── 5. Editing quantity recomputes the derived side, never the entered one ─
  const asQtyUp = await call('PATCH', `/v1/assets/${asChairId}`, {
    ...evSubCtx,
    body: { quantity: 50 },
  });
  eq('a UNIT line keeps its unit weight when the quantity grows',
    asQtyUp.json.asset?.unitWeightKg, 16.5);
  eq('...and the total moves with it', asQtyUp.json.asset?.totalWeightKg, 825);

  const asTotalLine = await call('POST', `/v1/projects/${evProject}/assets`, {
    ...evSubCtx,
    body: {
      assetTypeId: DESK, quantity: 10, weightBasis: 'TOTAL',
      totalWeightKg: 300, weightSource: 'WEIGHBRIDGE',
    },
  });
  const asTotalId = asTotalLine.json.asset.id as string;
  eq('a TOTAL line derives its unit weight', asTotalLine.json.asset.unitWeightKg, 30);
  const asTotalQty = await call('PATCH', `/v1/assets/${asTotalId}`, {
    ...evSubCtx, body: { quantity: 12 },
  });
  eq('...and finding two more desks does not make the lorry heavier',
    asTotalQty.json.asset?.totalWeightKg, 300);
  eq('...the unit weight falls instead', asTotalQty.json.asset?.unitWeightKg, 25);

  // Restore, so later mass assertions read the number this section describes.
  await call('PATCH', `/v1/assets/${asChairId}`, { ...evSubCtx, body: { quantity: 42 } });

  // ── 6. A line with no weight is valid, and drags completeness down ────────
  const asNoWeight = await call('POST', `/v1/projects/${evProject}/assets`, {
    ...evSubCtx,
    body: { assetTypeId: CHAIR, quantity: 3 },
  });
  eq('a line with no weight at all is accepted', asNoWeight.status, 201);
  eq('...and holds null rather than zero, because zero is a claim',
    asNoWeight.json.asset.totalWeightKg, null);

  // ── 7. The serial number, and the refusal that is a route ─────────────────
  const asServer = await call('POST', `/v1/projects/${evProject}/assets`, {
    ...evSubCtx,
    body: {
      assetTypeId: SERVER, trackingMode: 'ITEM', quantity: 1,
      serialNumber: `SN-${RUN}-4471`, manufacturer: 'Dell', model: 'R740',
    },
  });
  eq('an ITEM line records a serial number', asServer.status, 201);

  const asServerDupe = await call('POST', `/v1/projects/${evProject}/assets`, {
    ...evSubCtx,
    body: {
      assetTypeId: SERVER, trackingMode: 'ITEM', quantity: 1,
      serialNumber: `SN-${RUN}-4471`,
    },
  });
  eq('the same serial is refused inside the company (§13.2)', asServerDupe.status, 409);
  check('...and the refusal names the project it is already on, so it is a route',
    JSON.stringify(asServerDupe.json).includes('Riverside Fit-Out'), asServerDupe.json);

  const asItemQty = await call('POST', `/v1/projects/${evProject}/assets`, {
    ...evSubCtx,
    body: { assetTypeId: SERVER, trackingMode: 'ITEM', quantity: 4 },
  });
  check('ITEM mode refuses a quantity above one — per-unit rows are the point',
    asItemQty.status >= 400, asItemQty.status);

  // A tombstoned line must not block its own re-creation (finding 9).
  await call('DELETE', `/v1/assets/${asServer.json.asset.id}`, { ...evSubCtx });
  const asServerAgain = await call('POST', `/v1/projects/${evProject}/assets`, {
    ...evSubCtx,
    body: {
      assetTypeId: SERVER, trackingMode: 'ITEM', quantity: 1,
      serialNumber: `SN-${RUN}-4471`,
    },
  });
  eq('a removed line does not block its own serial for ever', asServerAgain.status, 201);

  // ── 8. The paste-import, and partial success by row number ───────────────
  const asImportClientId = randomUUID();
  const asImport = await call('POST', `/v1/projects/${evProject}/assets/import`, {
    ...evSubCtx,
    body: {
      clientId: asImportClientId,
      rows: [
        { assetTypeCode: 'OPERATOR_CHAIR', quantity: 12, weightBasis: 'UNIT', unitWeightKg: 16.5, weightSource: 'USER_ESTIMATE' },
        { assetTypeCode: 'desk', quantity: 4 },
        { assetTypeCode: 'Chiar', quantity: 9 },
        { assetTypeCode: 'PEDESTAL', quantity: 6 },
        { assetTypeCode: 'LOKKER', quantity: 2 },
      ],
    },
  });
  eq('a pasted schedule imports the rows it understands', asImport.status, 201);
  eq('...three of five', asImport.json.imported, 3);
  eq('...and returns the other two rather than rolling back the paste',
    (asImport.json.errors as unknown[]).length, 2);
  eq('...by row number', (asImport.json.errors as { row: number }[]).map((e) => e.row), [3, 5]);
  check('...naming the text that failed, so it can be found on the spreadsheet',
    (asImport.json.errors as { value?: string }[]).map((e) => e.value).join(',') === 'Chiar,LOKKER',
    asImport.json.errors);
  check('...matching a type code case-insensitively, since a paste is not typed carefully',
    (asImport.json.assets as { assetTypeCode: string }[]).some((a) => a.assetTypeCode === 'DESK'),
    asImport.json.assets);

  const asRepaste = await call('POST', `/v1/projects/${evProject}/assets/import`, {
    ...evSubCtx,
    body: {
      clientId: asImportClientId,
      rows: [
        { assetTypeCode: 'OPERATOR_CHAIR', quantity: 12, weightBasis: 'UNIT', unitWeightKg: 16.5, weightSource: 'USER_ESTIMATE' },
        { assetTypeCode: 'desk', quantity: 4 },
        { assetTypeCode: 'Chiar', quantity: 9 },
        { assetTypeCode: 'PEDESTAL', quantity: 6 },
        { assetTypeCode: 'LOKKER', quantity: 2 },
      ],
    },
  });
  eq('re-pasting under the same client id replays the first answer', asRepaste.status, 201);
  const { rows: asImportedCount } = await db.query<{ n: string }>(
    `select count(*)::text as n from project_assets
      where batch_client_id = $1 and deleted_at is null`, [asImportClientId]);
  eq('...and creates nothing the second time', asImportedCount[0]?.n, '3');

  const asBothWays = await call('POST', `/v1/projects/${evProject}/assets/import`, {
    ...evSubCtx,
    body: { rows: [{ assetTypeId: CHAIR, assetTypeCode: 'DESK', quantity: 1 }] },
  });
  eq('a row naming its type twice is refused — the two can disagree', asBothWays.status, 422);

  // ── 9. The revision trail (§36, §25.3) ───────────────────────────────────
  const { rows: asRevCreate } = await db.query<{ action: string; changed_fields: string[] }>(
    `select action, changed_fields from record_revisions
      where entity_type = 'PROJECT_ASSET' and entity_id = $1 order by revision`,
    [asChairId]
  );
  eq('the weight trail starts at the create, not at the first correction',
    asRevCreate[0]?.action, 'CREATE');
  check('...so "it was always 16.5" and "somebody typed 16.5" are distinguishable',
    (asRevCreate[0]?.changed_fields ?? []).includes('unitWeightKg'), asRevCreate[0]);

  const asRevBefore = asRevCreate.length;
  await call('PATCH', `/v1/assets/${asChairId}`, {
    ...evSubCtx, body: { notes: 'Stacked by the lift' },
  });
  const { rows: asRevAfterNotes } = await db.query<{ n: string }>(
    `select count(*)::text as n from record_revisions
      where entity_type = 'PROJECT_ASSET' and entity_id = $1`, [asChairId]);
  eq('editing a note writes no revision — §36 is about the numbers',
    Number(asRevAfterNotes[0]?.n), asRevBefore);

  await call('PATCH', `/v1/assets/${asChairId}`, {
    ...evSubCtx, body: { weightBasis: 'TOTAL', totalWeightKg: 701.4, weightSource: 'WEIGHBRIDGE' },
  });
  const { rows: asRevWeight } = await db.query<{ n: string; company_id: string }>(
    `select count(*)::text as n, max(company_id::text) as company_id from record_revisions
      where entity_type = 'PROJECT_ASSET' and entity_id = $1`, [asChairId]);
  eq('...and correcting the weight does', Number(asRevWeight[0]?.n), asRevBefore + 1);
  eq('...against the company whose record changed, not the one that changed it',
    asRevWeight[0]?.company_id, evSubCompany);

  // ── 10. The offline contract on this record set ──────────────────────────
  const asCurrent = await call('GET', `/v1/assets/${asChairId}`, { ...evSubCtx });
  const asStale = await call('PATCH', `/v1/assets/${asChairId}`, {
    ...evSubCtx,
    body: { quantity: 99, expectedRevision: 1 },
  });
  eq('a stale expected revision is refused', asStale.status, 409);
  check('...and the refusal carries the current row, so both sides can be shown',
    asStale.json?.error?.details?.current?.revision === asCurrent.json.asset.revision,
    asStale.json?.error?.details);

  const asFresh = await call('PATCH', `/v1/assets/${asChairId}`, {
    ...evSubCtx,
    body: { quantity: 42, expectedRevision: asCurrent.json.asset.revision },
  });
  eq('...and the same edit against the current revision lands', asFresh.status, 200);

  await call('DELETE', `/v1/assets/${asNoWeight.json.asset.id}`, { ...evSubCtx });
  const asGone = await call('GET', `/v1/assets/${asNoWeight.json.asset.id}`, { ...evSubCtx });
  eq('a removed line answers GONE, not 404 — a 404 also means "not allowed"',
    asGone.status, 410);
  const { rows: asStillThere } = await db.query<{ n: string }>(
    `select count(*)::text as n from project_assets where id = $1`,
    [asNoWeight.json.asset.id]
  );
  eq('...and the row is still there: an asset line is a hiring company’s proof of a tonne',
    asStillThere[0]?.n, '1');

  // ── 11. Who may write, and who may not ───────────────────────────────────
  const asWorkerWrite = await call('POST', `/v1/projects/${evProject}/assets`, {
    token: evWorker.token, companyId: evCompany,
    body: { assetTypeId: CHAIR, quantity: 1 },
  });
  eq('a Worker bundle cannot record assets', asWorkerWrite.status, 403);
  check('...and the refusal names the capability',
    JSON.stringify(asWorkerWrite.json).includes('asset.write'), asWorkerWrite.json);

  // The asymmetry with the diary, made explicit: the project owner MAY correct a
  // subcontractor's measurement, because the chairs are a shared physical fact
  // and the hiring company reports the tonne.
  const asOwnerEdit = await call('PATCH', `/v1/assets/${asChairId}`, {
    ...asOwnerCtx,
    // A different figure from the subcontractor's, deliberately: an edit that
    // changes no weight fact correctly writes no revision, and asserting
    // attribution against a no-op proves nothing. The first run of this section
    // used 701.4 twice and caught exactly that.
    body: { weightBasis: 'TOTAL', totalWeightKg: 705, weightSource: 'WEIGHBRIDGE' },
  });
  eq('the project owner may correct a subcontractor’s asset line', asOwnerEdit.status, 200);
  const { rows: asOwnerRev } = await db.query<{ changed_by_user_id: string }>(
    `select changed_by_user_id from record_revisions
      where entity_type = 'PROJECT_ASSET' and entity_id = $1 order by revision desc limit 1`,
    [asChairId]
  );
  eq('...and the trail names who did it, which is the protection rather than a refusal',
    asOwnerRev[0]?.changed_by_user_id, evOwner.userId);

  const asRivalRead = await call('GET', `/v1/assets/${asChairId}`, {
    token: evSub2.token, companyId: evSub2Company,
  });
  eq('a rival subcontractor on the same project cannot read the line', asRivalRead.status, 404);

  // ── 12. Cross-project ids are refused in the direction they would be used ─
  const asForeignDoc = await call('PATCH', `/v1/assets/${asChairId}`, {
    ...asOwnerCtx,
    body: { weightSource: 'TRANSFER_NOTE', weightDocumentId: randomUUID() },
  });
  eq('a document id that is not on this project is refused', asForeignDoc.status, 422);

  const asForeignType = await call('POST', `/v1/projects/${evProject}/assets`, {
    ...asOwnerCtx,
    body: { assetTypeId: randomUUID(), quantity: 1 },
  });
  eq('an asset type id the caller may not use answers not found, not forbidden',
    asForeignType.status, 404);

  // ── 13. outcome_state is derived and there is no way to type it ──────────
  const asTypedState = await call('PATCH', `/v1/assets/${asChairId}`, {
    ...asOwnerCtx, body: { outcomeState: 'FINAL' },
  });
  eq('there is no field for typing an outcome state', asTypedState.status, 422);
  const asStateNow = await call('GET', `/v1/assets/${asChairId}`, { ...asOwnerCtx });
  eq('...and it is still what the movements say it is', asStateNow.json.asset.outcomeState, 'PENDING');

  // ── 14. One notification for a batch, naming no serial ───────────────────
  for (let pass = 0; pass < 4; pass += 1) {
    await recoverStaleOutboxClaims(0);
    const o = await runOutboxBatch({
      workerId: 'verify-e2e-assets', handlers: NOTIFICATION_HANDLERS, limit: 200,
    });
    await runNotificationDeliveryBatch(200);
    if (o.claimed === 0) break;
  }
  const { rows: asNotices } = await db.query<{ title: string; body: string }>(
    `select title, body from notifications
      where company_id = $1 and kind = 'asset.lines_recorded' order by created_at`,
    [evCompany]
  );
  check('the owner is told its subcontractor recorded assets', asNotices.length > 0, asNotices);
  check('...once for the whole paste, not once per line',
    asNotices.some((n) => n.title.includes('3 asset lines')), asNotices.map((n) => n.title));
  check('...and no notification names a serial number, a model or a description',
    !JSON.stringify(asNotices).includes('4471') &&
    !JSON.stringify(asNotices).includes('R740') &&
    !JSON.stringify(asNotices).includes('Stacked by the lift'),
    asNotices);

  const { rows: asOwnPayload } = await db.query<{ n: string }>(
    `select count(*)::text as n from delivery_outbox
      where topic = 'asset.lines_recorded' and payload::text like '%4471%'`
  );
  eq('...nor does any event payload, which is where a serial would leak first',
    asOwnPayload[0]?.n, '0');

  /**
   * Handled mass, computed the way §28.2 defines it, from the API's own answers.
   *
   * The roll-up endpoint is 8.5; this is the same arithmetic done in the test so
   * step 3 can assert its own invariant without waiting for a screen. Unallocated
   * mass comes from QUANTITY, never from subtracting masses — an overriding
   * movement weight makes the subtraction negative, which is the packet's §0
   * finding 2 and is asserted directly below.
   */
  const handledKg = async (assetId: string): Promise<number> => {
    const a = await call('GET', `/v1/assets/${assetId}`, { ...evSubCtx });
    const m = await call('GET', `/v1/assets/${assetId}/movements`, { ...evSubCtx });
    const open = (m.json.movements as any[]).filter((x) => x.isOpen);
    const movedQty = open.reduce((sum, x) => sum + x.quantity, 0);
    const movedKg = open.reduce((sum, x) => sum + (x.effectiveWeightKg ?? 0), 0);
    const unit = a.json.asset.unitWeightKg ?? 0;
    const unallocated = Math.max(0, a.json.asset.quantity - movedQty) * unit;
    return Number((movedKg + unallocated).toFixed(6));
  };

  // ── The movement ledger (§25.4) — Phase 8 build order step 3 ─────────────
  section('Asset movements — the split, the chain, and the mass that does not move');

  // ── 1. The hierarchy, as data the company can see ────────────────────────
  const mvTypes = await call('GET', '/v1/destination-types', { ...asOwnerCtx });
  eq('the destination catalog is readable', mvTypes.status, 200);
  eq('...and ships the eleven', (mvTypes.json.destinationTypes as unknown[]).length, 11);
  const byCode = Object.fromEntries(
    (mvTypes.json.destinationTypes as { code: string }[]).map((d) => [d.code, d])
  ) as Record<string, any>;
  eq('storage has no tier and is not a final outcome — decision #18, as one row',
    [byCode.STORAGE.hierarchyTier, byCode.STORAGE.isFinalOutcome], [null, false]);
  eq('...and counts as nothing at all',
    [byCode.STORAGE.countsAsReuse, byCode.STORAGE.countsAsDiverted], [false, false]);
  eq('reuse outranks recycling, and both are separate flags (§41.8)',
    [byCode.DONATION.hierarchyTier, byCode.RECYCLING.hierarchyTier], [2, 3]);
  eq('...recycling is diverted but is not reuse',
    [byCode.RECYCLING.countsAsDiverted, byCode.RECYCLING.countsAsReuse], [true, false]);
  eq('...and landfill is neither', byCode.LANDFILL.countsAsDiverted, false);
  check('the seeded semantics are marked as the system’s, so a customisation reads as a diff',
    (mvTypes.json.destinationTypes as { isSystem: boolean }[]).every((d) => d.isSystem),
    mvTypes.json.destinationTypes);

  // ── 2. A destination organisation ────────────────────────────────────────
  const mvCharity = await call('POST', '/v1/destination-organisations', {
    ...evSubCtx,
    body: {
      name: `Bright Futures ${RUN}`, kind: 'CHARITY',
      contactName: 'Ngozi', contactEmail: `ngozi+${RUN}@example.test`,
      licenceNumber: 'WC/1234', licenceExpiresOn: '2027-06-30',
    },
  });
  eq('a charity is recorded as a destination organisation', mvCharity.status, 201);
  const mvCharityId = mvCharity.json.destinationOrganisation.id as string;

  const mvDupe = await call('POST', '/v1/destination-organisations', {
    ...evSubCtx,
    body: { name: `bright futures ${RUN}`, kind: 'CHARITY' },
  });
  eq('a second organisation with the same name is refused, case-insensitively',
    mvDupe.status, 409);

  const mvBadLink = await call('POST', '/v1/destination-organisations', {
    ...evSubCtx,
    body: { name: `Rival Reuse ${RUN}`, kind: 'REUSE_ORG', linkedCompanyId: evSub2Company },
  });
  eq('a company you do not work with cannot be named as a linked organisation',
    mvBadLink.status, 422);

  const mvRecycler = await call('POST', '/v1/destination-organisations', {
    ...evSubCtx,
    body: { name: `Meridian Recycling ${RUN}`, kind: 'RECYCLER' },
  });
  const mvRecyclerId = mvRecycler.json.destinationOrganisation.id as string;

  // ── 3. The milestone: 42 chairs in, 30 donated / 12 recycled out ─────────
  const mvLine = await call('POST', `/v1/projects/${evProject}/assets`, {
    ...evSubCtx,
    body: {
      assetTypeId: CHAIR, quantity: 42, weightBasis: 'UNIT', unitWeightKg: 16.5,
      weightSource: 'USER_ESTIMATE',
    },
  });
  const mvAsset = mvLine.json.asset.id as string;
  eq('the milestone line starts at 693 kg', mvLine.json.asset.totalWeightKg, 693);

  const mvDonated = await call('POST', `/v1/assets/${mvAsset}/movements`, {
    ...evSubCtx,
    body: {
      destinationTypeId: byCode.DONATION.id, destinationOrgId: mvCharityId,
      quantity: 30, movedOn: '2026-03-04', clientId: randomUUID(),
    },
  });
  eq('30 are donated', mvDonated.status, 201);
  eq('...and the line is partly done', mvDonated.json.outcomeState, 'PARTIAL');
  eq('...with the mass derived from the line, not copied',
    mvDonated.json.movement.effectiveWeightKg, 495);
  eq('...and nothing overriding it', mvDonated.json.movement.weightIsOverridden, false);

  const mvRecycled = await call('POST', `/v1/assets/${mvAsset}/movements`, {
    ...evSubCtx,
    body: {
      destinationTypeId: byCode.RECYCLING.id, destinationOrgId: mvRecyclerId,
      quantity: 12, movedOn: '2026-03-05',
    },
  });
  eq('12 are recycled', mvRecycled.status, 201);
  eq('...and the line is now final — derived, never typed',
    mvRecycled.json.outcomeState, 'FINAL');
  eq('...which is what the asset row says too',
    (await call('GET', `/v1/assets/${mvAsset}`, { ...evSubCtx })).json.asset.outcomeState,
    'FINAL');

  // ── 4. The ceiling (§25.4 rule 1, restated over open movements) ──────────
  const mvOver = await call('POST', `/v1/assets/${mvAsset}/movements`, {
    ...evSubCtx,
    body: { destinationTypeId: byCode.LANDFILL.id, quantity: 1, movedOn: '2026-03-06' },
  });
  eq('a 43rd chair is refused', mvOver.status, 409);
  check('...saying all 42 are already recorded, rather than "conflict"',
    JSON.stringify(mvOver.json).includes('All 42 are already recorded'), mvOver.json);

  // ── 5. Storage, and the finding this whole packet was written for ────────
  //
  // §25.4 rule 1 caps the movement total at the line's quantity; rule 3 says
  // leaving storage is a SECOND movement. Twelve in and twelve out is 24 against
  // a line of 42 that also donated 30. The chain is what makes both true.
  const mvDeskLine = await call('POST', `/v1/projects/${evProject}/assets`, {
    ...evSubCtx,
    body: {
      assetTypeId: DESK, quantity: 8, weightBasis: 'UNIT', unitWeightKg: 30,
      weightSource: 'USER_ESTIMATE',
    },
  });
  const mvDeskAsset = mvDeskLine.json.asset.id as string;

  const mvStored = await call('POST', `/v1/assets/${mvDeskAsset}/movements`, {
    ...evSubCtx,
    body: { destinationTypeId: byCode.STORAGE.id, quantity: 8, movedOn: '2026-03-04' },
  });
  eq('8 desks go into storage', mvStored.status, 201);
  eq('...and the line reads IN_STORAGE, not FINAL', mvStored.json.outcomeState, 'IN_STORAGE');
  const mvStoredId = mvStored.json.movement.id as string;

  // The ceiling now refuses a fresh movement, which is rule 1 doing its job —
  // and would make storage a one-way door without the chain.
  const mvFreshAfterStorage = await call('POST', `/v1/assets/${mvDeskAsset}/movements`, {
    ...evSubCtx,
    body: { destinationTypeId: byCode.RESALE.id, quantity: 8, movedOn: '2026-04-02' },
  });
  eq('a fresh movement out of storage is refused by the ceiling', mvFreshAfterStorage.status, 409);

  const mvHandledBefore = await handledKg(mvDeskAsset);
  const mvContinued = await call('POST', `/v1/movements/${mvStoredId}/continue`, {
    ...evSubCtx,
    body: { destinationTypeId: byCode.RESALE.id, quantity: 8, movedOn: '2026-04-02' },
  });
  eq('...and continuing the storage leg is accepted', mvContinued.status, 201);
  eq('...which makes the line final', mvContinued.json.outcomeState, 'FINAL');
  eq('...the storage leg is no longer open',
    (await call('GET', `/v1/assets/${mvDeskAsset}/movements`, { ...evSubCtx })).json.movements
      .find((m: any) => m.id === mvStoredId)?.isOpen, false);
  check('...but it is still on the ledger, because a ledger records where material has been',
    (await call('GET', `/v1/assets/${mvDeskAsset}/movements`, { ...evSubCtx })).json.movements
      .some((m: any) => m.id === mvStoredId), true);

  // THE PROPERTY THE WHOLE DESIGN IS FOR.
  eq('handled mass does not move by a gram when material leaves storage',
    await handledKg(mvDeskAsset), mvHandledBefore);
  eq('...and it is still the 240 kg that came off the floor', mvHandledBefore, 240);

  // ── 6. The chain's three refusals ────────────────────────────────────────
  const mvContinueFinal = await call('POST', `/v1/movements/${mvRecycled.json.movement.id}/continue`, {
    ...evSubCtx,
    body: { destinationTypeId: byCode.LANDFILL.id, quantity: 12, movedOn: '2026-05-01' },
  });
  eq('a final-outcome movement cannot be continued — that is a second claim', mvContinueFinal.status, 409);
  check('...and says to correct it instead',
    JSON.stringify(mvContinueFinal.json).includes('Correct that movement'), mvContinueFinal.json);

  const mvForkChain = await call('POST', `/v1/movements/${mvStoredId}/continue`, {
    ...evSubCtx,
    body: { destinationTypeId: byCode.LANDFILL.id, quantity: 8, movedOn: '2026-05-01' },
  });
  eq('a movement cannot be continued twice — a fork double-counts', mvForkChain.status, 409);

  const mvStore2 = await call('POST', `/v1/projects/${evProject}/assets`, {
    ...evSubCtx,
    body: { assetTypeId: DESK, quantity: 12, weightBasis: 'UNIT', unitWeightKg: 30, weightSource: 'USER_ESTIMATE' },
  });
  const mvStore2Asset = mvStore2.json.asset.id as string;
  const mvStore2Leg = await call('POST', `/v1/assets/${mvStore2Asset}/movements`, {
    ...evSubCtx,
    body: { destinationTypeId: byCode.STORAGE.id, quantity: 12, movedOn: '2026-03-04' },
  });
  const mvStore2LegId = mvStore2Leg.json.movement.id as string;
  const mvTooMany = await call('POST', `/v1/movements/${mvStore2LegId}/continue`, {
    ...evSubCtx,
    body: { destinationTypeId: byCode.RESALE.id, quantity: 15, movedOn: '2026-04-02' },
  });
  eq('15 cannot come out of a warehouse that 12 went into', mvTooMany.status, 409);

  // A partial release leaves a remainder, and the API says so rather than
  // inventing a movement nobody recorded.
  const mvPartial = await call('POST', `/v1/movements/${mvStore2LegId}/continue`, {
    ...evSubCtx,
    body: { destinationTypeId: byCode.RESALE.id, quantity: 5, movedOn: '2026-04-02' },
  });
  eq('a partial release from storage is allowed', mvPartial.status, 201);
  check('...and names the remainder rather than inventing a movement for it',
    String(mvPartial.json.notice ?? '').includes('7 of these are still'), mvPartial.json.notice);
  eq('...leaving the line partly done', mvPartial.json.outcomeState, 'PARTIAL');

  // ── 7. Deleting a continued movement orphans the chain, so it is refused ──
  const mvDeleteSource = await call('DELETE', `/v1/movements/${mvStoredId}`, { ...evSubCtx });
  eq('a movement something was carried onward from cannot be removed', mvDeleteSource.status, 409);
  check('...and names the movement that depends on it',
    JSON.stringify(mvDeleteSource.json).includes('Remove that one first'), mvDeleteSource.json);

  const mvDeleteLeaf = await call('DELETE', `/v1/movements/${mvContinued.json.movement.id}`, {
    ...evSubCtx,
  });
  eq('the leaf can be removed', mvDeleteLeaf.status, 204);
  eq('...which puts the desks back in storage, derived from what is left',
    (await call('GET', `/v1/assets/${mvDeskAsset}`, { ...evSubCtx })).json.asset.outcomeState,
    'IN_STORAGE');
  eq('...and handled mass still has not moved', await handledKg(mvDeskAsset), 240);

  // ── 8. Correcting a movement, and the trail it writes ────────────────────
  const mvCorrect = await call('PATCH', `/v1/movements/${mvDonated.json.movement.id}`, {
    ...evSubCtx,
    body: { destinationOrgId: mvRecyclerId },
  });
  eq('a movement’s organisation can be corrected', mvCorrect.status, 200);
  const { rows: mvRevs } = await db.query<{ action: string; changed_fields: string[] }>(
    `select action, changed_fields from record_revisions
      where entity_type = 'ASSET_MOVEMENT' and entity_id = $1`,
    [mvDonated.json.movement.id]
  );
  eq('...and the correction is a revision, never a silent overwrite (§25.4 rule 4)',
    mvRevs[0]?.action, 'UPDATE');
  eq('...naming only what moved', mvRevs[0]?.changed_fields, ['destinationOrgId']);
  eq('...and the mass balance did not change, because a charity is not a mass',
    await handledKg(mvAsset), 693);

  const mvShrink = await call('PATCH', `/v1/movements/${mvStore2LegId}`, {
    ...evSubCtx, body: { quantity: 3 },
  });
  eq('a storage leg cannot shrink below what has already left it', mvShrink.status, 409);

  const mvGrow = await call('PATCH', `/v1/movements/${mvDonated.json.movement.id}`, {
    ...evSubCtx, body: { quantity: 40 },
  });
  eq('correcting a quantity is measured against the ceiling without itself',
    mvGrow.status, 409);
  const mvGrowOk = await call('PATCH', `/v1/movements/${mvDonated.json.movement.id}`, {
    ...evSubCtx, body: { quantity: 29 },
  });
  eq('...and a correction that fits is accepted', mvGrowOk.status, 200);
  eq('...leaving one chair unallocated, so the line is no longer final',
    mvGrowOk.json.outcomeState, 'PARTIAL');
  await call('PATCH', `/v1/movements/${mvDonated.json.movement.id}`, {
    ...evSubCtx, body: { quantity: 30 },
  });

  // ── 9. An overriding weight, and what it does and does not move ──────────
  const mvOverride = await call('PATCH', `/v1/movements/${mvRecycled.json.movement.id}`, {
    ...evSubCtx, body: { weightKg: 205 },
  });
  eq('a movement may override its own weight — the weighbridge weighed this load',
    mvOverride.json.movement?.weightKg, 205);
  eq('...and handled mass rises, because the parts were weighed better than the whole',
    await handledKg(mvAsset), 700);

  await call('PATCH', `/v1/assets/${mvAsset}`, {
    ...evSubCtx,
    body: { weightBasis: 'UNIT', unitWeightKg: 16.7, weightSource: 'WEIGHBRIDGE' },
  });
  const mvAfterLineEdit = await call('GET', `/v1/assets/${mvAsset}/movements`, { ...evSubCtx });
  const mvDonatedNow = (mvAfterLineEdit.json.movements as any[]).find(
    (m) => m.id === mvDonated.json.movement.id
  );
  const mvRecycledNow = (mvAfterLineEdit.json.movements as any[]).find(
    (m) => m.id === mvRecycled.json.movement.id
  );
  eq('correcting the line moves every DERIVED movement with it, with nothing back-filled',
    mvDonatedNow?.effectiveWeightKg, 501);
  eq('...and leaves the overridden one exactly where the weighbridge put it',
    mvRecycledNow?.effectiveWeightKg, 205);

  // ── 10. Two clerks racing the ceiling ────────────────────────────────────
  const mvRace = await call('POST', `/v1/projects/${evProject}/assets`, {
    ...evSubCtx,
    body: { assetTypeId: CHAIR, quantity: 10, weightBasis: 'UNIT', unitWeightKg: 10, weightSource: 'USER_ESTIMATE' },
  });
  const mvRaceAsset = mvRace.json.asset.id as string;
  const [mvRaceA, mvRaceB] = await Promise.all([
    call('POST', `/v1/assets/${mvRaceAsset}/movements`, {
      ...evSubCtx,
      body: { destinationTypeId: byCode.DONATION.id, quantity: 7, movedOn: '2026-03-04' },
    }),
    call('POST', `/v1/assets/${mvRaceAsset}/movements`, {
      ...evSubCtx,
      body: { destinationTypeId: byCode.RECYCLING.id, quantity: 7, movedOn: '2026-03-04' },
    }),
  ]);
  const mvRaceCodes = [mvRaceA.status, mvRaceB.status].sort();
  eq('two movements racing one ceiling: exactly one lands', mvRaceCodes, [201, 409]);
  const { rows: mvRaceTotal } = await db.query<{ total: string }>(
    `select coalesce(sum(quantity), 0)::text as total from asset_movements
      where asset_id = $1 and deleted_at is null`, [mvRaceAsset]);
  check('...and the ledger never exceeds the line it belongs to',
    Number(mvRaceTotal[0]?.total) <= 10, mvRaceTotal[0]);

  // ── 11. Foreign ids, refused in the direction they would be used ─────────
  const mvForeignOrg = await call('POST', `/v1/assets/${mvRaceAsset}/movements`, {
    ...evSubCtx,
    body: {
      destinationTypeId: byCode.LANDFILL.id, destinationOrgId: randomUUID(),
      quantity: 1, movedOn: '2026-03-04',
    },
  });
  eq('a destination organisation that is not yours answers not found', mvForeignOrg.status, 404);

  const mvForeignDoc = await call('POST', `/v1/assets/${mvRaceAsset}/movements`, {
    ...evSubCtx,
    body: {
      destinationTypeId: byCode.LANDFILL.id, documentId: randomUUID(),
      quantity: 1, movedOn: '2026-03-04',
    },
  });
  eq('a document that is not on this project is refused', mvForeignDoc.status, 422);

  const mvRivalMove = await call('POST', `/v1/assets/${mvAsset}/movements`, {
    token: evSub2.token, companyId: evSub2Company,
    body: { destinationTypeId: byCode.LANDFILL.id, quantity: 1, movedOn: '2026-03-04' },
  });
  eq('a rival on the same project cannot move somebody else’s material', mvRivalMove.status, 404);

  const mvWorkerMove = await call('POST', `/v1/assets/${mvAsset}/movements`, {
    token: evWorker.token, companyId: evCompany,
    body: { destinationTypeId: byCode.LANDFILL.id, quantity: 1, movedOn: '2026-03-04' },
  });
  eq('a Worker bundle cannot set a destination', mvWorkerMove.status, 403);
  check('...and the refusal names the capability',
    JSON.stringify(mvWorkerMove.json).includes('asset.destination.set'), mvWorkerMove.json);

  // ── 12. Retiring an organisation keeps it and drops the person ───────────
  const mvRetire = await call('PATCH', `/v1/destination-organisations/${mvCharityId}`, {
    ...evSubCtx, body: { active: false },
  });
  eq('an organisation can be retired', mvRetire.status, 200);
  eq('...and its third-party contact details are cleared',
    [mvRetire.json.destinationOrganisation.contactName,
     mvRetire.json.destinationOrganisation.contactEmail], [null, null]);
  eq('...while the organisation itself stays, because a movement names it',
    mvRetire.json.destinationOrganisation.name, `Bright Futures ${RUN}`);

  // ── 13. The back-references 0030 deferred ────────────────────────────────
  const { rows: mvEvidenceCols } = await db.query<{ column_name: string }>(
    `select column_name from information_schema.columns
      where table_name = 'project_evidence' and column_name in ('asset_id','asset_movement_id')
      order by column_name`
  );
  eq('project_evidence now carries the two foreign keys 0030 deferred',
    mvEvidenceCols.map((c) => c.column_name), ['asset_id', 'asset_movement_id']);
  const { rows: mvNoVehicle } = await db.query<{ n: string }>(
    `select count(*)::text as n from information_schema.columns
      where table_name = 'asset_movements' and column_name = 'vehicle_id'`
  );
  eq('...and asset_movements has no vehicle_id, whose table is Phase 11',
    mvNoVehicle[0]?.n, '0');


  // ── Asset links (§22.2, 0035) — Phase 8 build order step 4 ────────────────
  section('Asset links — evidence both ways, and the badge that cannot outlive its document');

  /*
   * `0030` withheld these two foreign keys on a rule: a column nothing writes and
   * nothing reads is indistinguishable, on inspection, from one whose writer is
   * broken. `0035` added them; this is the writer and the reader that were the
   * condition of their landing.
   */

  // ── 1. A photograph of the chairs, and the asset reading it back ─────────
  const alChairPhoto = await uploadPhoto(evSubCtx, `chairs-${RUN}.png`, evPhoto);
  const alTagged = await call('POST', `/v1/projects/${evProject}/evidence`, {
    ...evSubCtx,
    body: {
      batchClientId: randomUUID(),
      items: [{ fileId: alChairPhoto, category: 'ASSET', assetId: mvAsset }],
    },
  });
  eq('a photograph is tagged to the asset line it is of', alTagged.status, 201);
  eq('...and carries the line', alTagged.json.created[0]?.assetId, mvAsset);
  eq('...claiming no particular movement', alTagged.json.created[0]?.assetMovementId, null);
  const alTaggedId = alTagged.json.created[0]?.id as string;

  // The reverse direction, and the reason the asset side needs no route of its
  // own: the evidence filter already carries §7's rules about who may see a
  // photograph, and a join from the asset would have had to re-derive them.
  const alByAsset = await call(
    'GET', `/v1/projects/${evProject}/evidence?assetId=${mvAsset}`, { ...evSubCtx });
  eq('the line reads its own photographs back through the evidence filter',
    (alByAsset.json.evidence as unknown[]).length, 1);
  eq('...and it is the one just tagged', alByAsset.json.evidence[0]?.id, alTaggedId);

  // ── 2. A movement named alone fills its line in ──────────────────────────
  //
  // A movement belongs to exactly one line, so the pair is over-determined and
  // the database holds the answer. Leaving it null would put a photograph of the
  // weighbridge outside the chairs' own gallery — a gap with no symptom, found by
  // somebody who concludes the upload failed.
  const alMoveId = mvRecycled.json.movement.id as string;
  const alMovePhoto = await uploadPhoto(evSubCtx, `recycling-${RUN}.png`, evPhoto);
  const alMoveTagged = await call('POST', `/v1/projects/${evProject}/evidence`, {
    ...evSubCtx,
    body: {
      batchClientId: randomUUID(),
      items: [{ fileId: alMovePhoto, category: 'RECYCLING', assetMovementId: alMoveId }],
    },
  });
  eq('a photograph is tagged to one leg of the journey', alMoveTagged.status, 201);
  eq('...and the line is derived from the movement, not left null',
    alMoveTagged.json.created[0]?.assetId, mvAsset);
  eq('...with the movement kept as the more specific claim',
    alMoveTagged.json.created[0]?.assetMovementId, alMoveId);
  eq('...so the line now shows both photographs',
    ((await call('GET', `/v1/projects/${evProject}/evidence?assetId=${mvAsset}`,
      { ...evSubCtx })).json.evidence as unknown[]).length, 2);
  eq('...while the movement filter shows only its own',
    ((await call('GET', `/v1/projects/${evProject}/evidence?assetMovementId=${alMoveId}`,
      { ...evSubCtx })).json.evidence as unknown[]).length, 1);

  // ── 3. A pair that disagrees is refused, and the batch keeps the rest ────
  const alGoodFile = await uploadPhoto(evSubCtx, `good-${RUN}.png`, evPhoto);
  const alClashFile = await uploadPhoto(evSubCtx, `clash-${RUN}.png`, evPhoto);
  const alClash = await call('POST', `/v1/projects/${evProject}/evidence`, {
    ...evSubCtx,
    body: {
      batchClientId: randomUUID(),
      items: [
        { fileId: alGoodFile, category: 'ASSET', assetId: mvAsset },
        {
          fileId: alClashFile, category: 'ASSET',
          assetId: mvDeskAsset, assetMovementId: alMoveId,
        },
      ],
    },
  });
  eq('a batch with one contradictory row still keeps the good one',
    [alClash.json.created.length, alClash.json.rejected.length], [1, 1]);
  check('...and the refusal says which half contradicted the other',
    String(alClash.json.rejected[0]?.message).includes('not on the asset line you named'),
    alClash.json.rejected[0]);

  // ── 4. Scope, in both directions, on one asset line ──────────────────────
  //
  // The owner's own line. A provider may not tag anything to it; the owner may
  // tag a provider's photograph to it — which is the OPPOSITE of the diary rule
  // one join away, and deliberately so. A diary entry is a statement by a person
  // about what they saw; an asset line is a measurement of a shared physical
  // fact, which is why 8.2 already lets the owner correct a subcontractor's line
  // and not its diary entry.
  const alOwnerLine = await call('POST', `/v1/projects/${evProject}/assets`, {
    ...asOwnerCtx,
    body: { assetTypeId: DESK, quantity: 4, weightBasis: 'UNIT', unitWeightKg: 30 },
  });
  eq('the owner records a line of its own', alOwnerLine.status, 201);
  const alOwnerLineId = alOwnerLine.json.asset.id as string;

  const alRivalFile = await uploadPhoto(evSubCtx, `not-mine-${RUN}.png`, evPhoto);
  const alRivalTag = await call('POST', `/v1/projects/${evProject}/evidence`, {
    ...evSubCtx,
    body: {
      batchClientId: randomUUID(),
      items: [{ fileId: alRivalFile, category: 'ASSET', assetId: alOwnerLineId }],
    },
  });
  eq('a subcontractor cannot tag its photograph to a line that is not its own',
    alRivalTag.json.rejected.length, 1);
  check('...and is told the id is unusable rather than forbidden, which would confirm it',
    String(alRivalTag.json.rejected[0]?.message).includes('not one you can record evidence against'),
    alRivalTag.json.rejected[0]);

  const alOwnerTag = await call('PATCH', `/v1/evidence/${alTaggedId}`, {
    ...asOwnerCtx,
    body: { assetId: alOwnerLineId },
  });
  eq('the project owner may tag a subcontractor’s photograph to the owner’s own line',
    alOwnerTag.status, 200);
  eq('...because an asset line is a shared physical fact, not somebody’s account of it',
    alOwnerTag.json.evidence.assetId, alOwnerLineId);
  // Put it back, so the filters and citations below read the register they are about.
  await call('PATCH', `/v1/evidence/${alTaggedId}`, {
    ...asOwnerCtx, body: { assetId: mvAsset },
  });

  // ── 5. The photograph outlives the line it is of ─────────────────────────
  const alTempLine = await call('POST', `/v1/projects/${evProject}/assets`, {
    ...evSubCtx,
    body: { assetTypeId: DESK, quantity: 2, weightBasis: 'UNIT', unitWeightKg: 30 },
  });
  const alTempLineId = alTempLine.json.asset.id as string;
  const alTempFile = await uploadPhoto(evSubCtx, `temp-line-${RUN}.png`, evPhoto);
  const alTempEv = await call('POST', `/v1/projects/${evProject}/evidence`, {
    ...evSubCtx,
    body: {
      batchClientId: randomUUID(),
      items: [{ fileId: alTempFile, category: 'ASSET', assetId: alTempLineId }],
    },
  });
  const alTempEvId = alTempEv.json.created[0]?.id as string;
  eq('the line is removed',
    (await call('DELETE', `/v1/assets/${alTempLineId}`, { ...evSubCtx })).status, 204);
  const alAfterTombstone = await call('GET', `/v1/evidence/${alTempEvId}`, { ...evSubCtx });
  eq('...and the photograph of it is still a photograph of the day’s work',
    alAfterTombstone.status, 200);
  eq('...still naming the line, because a tombstone is a record rather than an absence',
    alAfterTombstone.json.evidence.assetId, alTempLineId);
  const { rows: alFk } = await db.query<{ column_name: string; delete_rule: string }>(
    `select k.column_name, rc.delete_rule
       from information_schema.referential_constraints rc
       join information_schema.key_column_usage k on k.constraint_name = rc.constraint_name
      where k.table_name = 'project_evidence'
        and k.column_name in ('asset_id','asset_movement_id')
      order by k.column_name`
  );
  eq('and a hard delete would blank the link rather than take the photograph with it',
    alFk.map((r) => `${r.column_name}:${r.delete_rule}`),
    ['asset_id:SET NULL', 'asset_movement_id:SET NULL']);

  // ── 6. The document, cited from a weight and from a movement ─────────────
  const alTicketId = (await call('POST', `/v1/projects/${evProject}/documents`, {
    ...evSubCtx,
    body: {
      fileId: await uploadDoc(evSubCtx, 'weighbridge-ticket.pdf',
        Buffer.from('%PDF-1.4 weighbridge', 'ascii')),
      category: 'WEIGHBRIDGE_TICKET',
      title: 'Weighbridge ticket 88213',
      reference: 'WB-88213',
      issuedOn: '2026-03-05',
      clientId: randomUUID(),
    },
  })).json.document.id as string;

  const alCiteWeight = await call('PATCH', `/v1/assets/${alOwnerLineId}`, {
    ...asOwnerCtx,
    body: {
      weightBasis: 'TOTAL', totalWeightKg: 118.4,
      weightSource: 'WEIGHBRIDGE', weightDocumentId: alTicketId,
    },
  });
  eq('the owner rests its own weight on the subcontractor’s ticket', alCiteWeight.status, 200);
  eq('...and a weighbridge figure with the ticket attached is VERIFIED',
    alCiteWeight.json.asset.weightConfidence, 'VERIFIED');
  eq('...naming the document version that was on the table',
    alCiteWeight.json.asset.weightDocumentId, alTicketId);
  eq('...which has not been re-issued', alCiteWeight.json.asset.weightDocumentSuperseded, false);

  const alCiteMovement = await call('PATCH', `/v1/movements/${alMoveId}`, {
    ...evSubCtx, body: { documentId: alTicketId },
  });
  eq('the same ticket documents the movement it weighed', alCiteMovement.status, 200);

  // ── 7. Citations, read from the document's end and scoped to the reader ──
  const alCitesOwner = await call('GET', `/v1/documents/${alTicketId}/citations`, { ...asOwnerCtx });
  eq('the owner sees what rests on the ticket', alCitesOwner.status, 200);
  eq('...one weight and one movement',
    [alCitesOwner.json.citations.weights.length, alCitesOwner.json.citations.movements.length],
    [1, 1]);
  eq('...and the weight is named by line, not merely counted',
    alCitesOwner.json.citations.weights[0]?.assetId, alOwnerLineId);
  eq('...with the confidence that rests on it, which is the thing at risk',
    alCitesOwner.json.citations.weights[0]?.weightConfidence, 'VERIFIED');

  const alCitesSub = await call('GET', `/v1/documents/${alTicketId}/citations`, { ...evSubCtx });
  eq('the subcontractor may read the citations of its own document', alCitesSub.status, 200);
  eq('...but sees only its own rows: the owner’s line is not its business',
    [alCitesSub.json.citations.weights.length, alCitesSub.json.citations.movements.length],
    [0, 1]);

  // ── 8. The refusal, counted over rows the deleter cannot see ─────────────
  //
  // Packet §0 finding 5. Every other broken link here is disclosed rather than
  // refused; this one cannot be, because a VERIFIED weight is a stored LABEL
  // rather than a reference — delete the document and the line goes on claiming a
  // provenance that no longer exists. The count is deliberately NOT scoped to the
  // deleter: scoping it is exactly how this delete would succeed.
  const alRefused = await call('DELETE', `/v1/documents/${alTicketId}`, { ...evSubCtx });
  eq('deleting a document a documented weight rests on is refused', alRefused.status, 409);
  check('...in §9’s own words, with the count',
    String(alRefused.json?.error?.message).includes('documented weight on 1 asset line'),
    alRefused.json?.error?.message);
  eq('...and the count includes a line this deleter cannot even read',
    alRefused.json?.error?.details?.citedByWeights, 1);

  // ── 9. The way out is an edit to the claim, not a permission ─────────────
  const alLower = await call('PATCH', `/v1/assets/${alOwnerLineId}`, {
    ...asOwnerCtx,
    body: { weightSource: 'USER_ESTIMATE', weightDocumentId: null },
  });
  eq('the owner lowers the claim to what it can still support', alLower.status, 200);
  eq('...which is an estimate', alLower.json.asset.weightConfidence, 'ESTIMATED');

  const alDeleted = await call('DELETE', `/v1/documents/${alTicketId}`, { ...evSubCtx });
  eq('...and the document can then be withdrawn', alDeleted.status, 204);

  /*
   * The movement's link is the case that is DISCLOSED rather than refused, and
   * this is the assertion of that boundary. A movement's document is a reference:
   * its absence is visible on the movement. A weight's confidence is a label: its
   * absence is not visible anywhere, which is why only that one blocks a delete.
   */
  const alMovementAfter = await call('GET', `/v1/assets/${mvAsset}/movements`, { ...evSubCtx });
  eq('a movement still names the document it was recorded against',
    (alMovementAfter.json.movements as { id: string; documentId: string }[])
      .find((m) => m.id === alMoveId)?.documentId,
    alTicketId);


  // ── 10. A movement link cannot outlive the line it is a leg of (0036) ────
  //
  // The pair is over-determined and the routes can clear either half, so
  // "untag the line, keep the movement" is one request away from a photograph
  // that is absent from the asset's gallery and present in the movement's — a
  // disagreement between two screens rather than an error anybody sees.
  const alUntag = await call('PATCH', `/v1/evidence/${alMoveTagged.json.created[0].id}`, {
    ...evSubCtx, body: { assetId: null },
  });
  eq('untagging the line succeeds', alUntag.status, 200);
  eq('...and takes the movement with it rather than orphaning the specific claim',
    [alUntag.json.evidence.assetId, alUntag.json.evidence.assetMovementId], [null, null]);

  const { rows: alOrphan } = await db.query<{ n: string }>(
    `select count(*)::text as n from project_evidence
      where asset_movement_id is not null and asset_id is null`
  );
  eq('...and no row anywhere holds a movement without its line', alOrphan[0]?.n, '0');

  /*
   * And the route is not the only thing saying so. `0036` is a check constraint
   * because a rule enforced only by the handler that happens to be written today
   * is one the next handler re-decides — the same argument `0031` made for the
   * chain's unique index and `0035` made for the ledger's.
   */
  await db.query(
    `update project_evidence set asset_id = $2, asset_movement_id = $3 where id = $1`,
    [alTaggedId, mvAsset, alMoveId]
  );
  let alConstraintError = '';
  try {
    await db.query(`update project_evidence set asset_id = null where id = $1`, [alTaggedId]);
  } catch (err) {
    // Named, not merely caught. A guard asserted as "something threw" is an
    // assertion that the statement is malformed, not that the rule is watching.
    alConstraintError = String((err as { constraint?: string }).constraint ?? err);
  }
  eq('the database refuses the orphan directly, not only the route',
    alConstraintError, 'project_evidence_movement_implies_asset');
  await db.query(
    `update project_evidence set asset_movement_id = null where id = $1`, [alTaggedId]);


  // ── The mass roll-up (§28.1–§28.2) — Phase 8 build order step 5 ───────────
  section('Mass balance — the split, the two gates, and the gaps without a score');

  /*
   * A project of its own, so the totals are exact figures rather than "whatever
   * the suite has recorded by the time it runs". It carries the §12 milestone —
   * 42 chairs, 30 donated and 12 recycled — plus the two shapes that make the
   * gaps interesting: 8 desks in storage, and a line with no weight at all.
   */
  const mbProject = (await call('POST', '/v1/projects', {
    ...asOwnerCtx,
    body: {
      name: `Kings Court — Floor 2 ${RUN}`,
      clientCompanyId: evClientCompany,
      engagementId: evClientRes.json.client.engagementId,
    },
  })).json.project.id as string;
  await call('POST', `/v1/projects/${mbProject}/assignments`, {
    ...asOwnerCtx,
    body: { providerCompanyId: evSubCompany, engagementId: evEdge?.id },
  });

  // ── 1. Empty is not zero ─────────────────────────────────────────────────
  const mbEmpty = await call('GET', `/v1/projects/${mbProject}/mass-balance`, { ...asOwnerCtx });
  eq('an empty project answers with a balance', mbEmpty.status, 200);
  eq('...of no lines', mbEmpty.json.massBalance.lineCount, 0);
  eq('...and every rate is null rather than 0%, which would be a claim',
    [mbEmpty.json.massBalance.rates.diverted, mbEmpty.json.massBalance.rates.reuse], [null, null]);
  eq('...with nothing in the breakdown to render', mbEmpty.json.massBalance.byDestination, []);

  // ── 2. The milestone, and 240 kg that is not in any rate ─────────────────
  const mbChairs = (await call('POST', `/v1/projects/${mbProject}/assets`, {
    ...asOwnerCtx,
    body: {
      assetTypeId: CHAIR, quantity: 42, weightBasis: 'UNIT', unitWeightKg: 16.5,
      weightSource: 'USER_ESTIMATE',
    },
  })).json.asset.id as string;
  await call('POST', `/v1/assets/${mbChairs}/movements`, {
    ...asOwnerCtx,
    body: { destinationTypeId: byCode.DONATION.id, quantity: 30, movedOn: '2026-03-04' },
  });
  await call('POST', `/v1/assets/${mbChairs}/movements`, {
    ...asOwnerCtx,
    body: { destinationTypeId: byCode.RECYCLING.id, quantity: 12, movedOn: '2026-03-05' },
  });

  const mbDesks = (await call('POST', `/v1/projects/${mbProject}/assets`, {
    ...asOwnerCtx,
    body: {
      assetTypeId: DESK, quantity: 8, weightBasis: 'UNIT', unitWeightKg: 30,
      weightSource: 'USER_ESTIMATE',
    },
  })).json.asset.id as string;
  await call('POST', `/v1/assets/${mbDesks}/movements`, {
    ...asOwnerCtx,
    body: { destinationTypeId: byCode.STORAGE.id, quantity: 8, movedOn: '2026-03-06' },
  });

  const mbUnweighed = (await call('POST', `/v1/projects/${mbProject}/assets`, {
    ...asOwnerCtx, body: { assetTypeId: CHAIR, quantity: 5 },
  })).json.asset.id as string;

  const mbFull = await call('GET', `/v1/projects/${mbProject}/mass-balance`, { ...asOwnerCtx });
  eq('the owner gets the full view', mbFull.json.massBalance.view, 'FULL');
  eq('total material handled is allocated plus pending (§28.2)',
    mbFull.json.massBalance.handledKg, 933);
  eq('...of which 693 kg reached a final outcome',
    mbFull.json.massBalance.allocatedKg, 693);
  eq('...240 kg is in storage and 0 kg is unallocated',
    [mbFull.json.massBalance.inStorageKg, mbFull.json.massBalance.unallocatedKg], [240, 0]);
  eq('...which is the pending figure, returned BESIDE the rates rather than in them',
    mbFull.json.massBalance.pendingKg, 240);

  // ── 3. Reuse above recycling, and no combined figure standing in (§41.8) ──
  const mbDest = mbFull.json.massBalance.byDestination as {
    code: string; massKg: number; countsAs: string[]; name: string; hierarchyTier: number | null;
  }[];
  eq('the breakdown is ordered by hierarchy, reuse above recycling — not by mass',
    mbDest.map((d) => d.code), ['DONATION', 'RECYCLING']);
  eq('...with the milestone split', mbDest.map((d) => d.massKg), [495, 198]);
  eq('...and storage in neither, because it is not an outcome (decision #18)',
    mbDest.some((d) => d.code === 'STORAGE'), false);
  eq('the breakdown names its own display label, so §28.1 renders without a second call',
    mbDest[0]?.name, 'Donation');
  eq('...and discloses which flags produced each figure (§10, decision #20)',
    mbDest.map((d) => d.countsAs),
    [['RETAINED_IN_USE', 'REUSE', 'DIVERTED'], ['RECYCLING', 'DIVERTED']]);

  const mbRates = mbFull.json.massBalance.rates as Record<string, number | null>;
  const round3 = (n: number | null | undefined): number | null =>
    n === null || n === undefined ? null : Math.round(n * 1000) / 1000;
  eq('the six rates divide by ALLOCATED mass, not by handled',
    [round3(mbRates.reuse), round3(mbRates.recycling), round3(mbRates.diverted)],
    [0.714, 0.286, 1]);
  eq('...landfill and recovery are 0 because something was allocated, not null',
    [mbRates.landfill, mbRates.recovery], [0, 0]);
  eq('...and reuse is reported separately from diversion rather than folded into it',
    round3(mbRates.reuse) !== round3(mbRates.diverted), true);

  /*
   * The rate would be 74% if pending were in the denominator — 693 of 933 — and
   * that is the number §28.2 calls a lie. Asserted directly so a later
   * "improvement" to the denominator has to delete a test that says why.
   */
  eq('pending mass is never hidden in a denominator (§28.2)',
    round3(693 / 933) !== round3(mbRates.diverted!), true);

  // ── 4. The gaps, and no composite score anywhere ─────────────────────────
  const mbGaps = mbFull.json.massBalance.gaps as string[];
  check('a line with no weight is named', mbGaps.includes(
    '1 of 3 asset lines has no weight recorded.'), mbGaps);
  check('...and so is the fact that every figure is therefore a floor',
    mbGaps.some((g) => g.includes('minimum rather than a total')), mbGaps);
  check('storage is named as an unknown destination, in mass',
    mbGaps.some((g) => g.includes('stored material')), mbGaps);
  check('...and the estimate share is named',
    mbGaps.some((g) => g.includes('of project weight is estimated')), mbGaps);
  check('§28.3’s fourth component ships as a gap: nothing supports these lines',
    mbGaps.includes('3 of 3 asset lines have no photograph or document supporting them.'), mbGaps);
  check('and there is no composite completeness score anywhere in the payload',
    !/completeness|score/i.test(JSON.stringify(mbFull.json)), mbFull.json.massBalance);

  // 8.4's links are what make that fourth component computable at all.
  const mbPhotoId = await uploadPhoto(
    asOwnerCtx, `mb-chairs-${RUN}.png`, evPhoto, 'image/png', mbProject);
  await call('POST', `/v1/projects/${mbProject}/evidence`, {
    ...asOwnerCtx,
    body: {
      batchClientId: randomUUID(),
      items: [{ fileId: mbPhotoId, category: 'ASSET', assetId: mbChairs }],
    },
  });
  const mbAfterPhoto = await call('GET', `/v1/projects/${mbProject}/mass-balance`, { ...asOwnerCtx });
  eq('one photograph moves the fourth component, which is 8.4 feeding 8.5',
    mbAfterPhoto.json.massBalance.linesWithSupport, 1);
  check('...and the sentence counts down with it',
    (mbAfterPhoto.json.massBalance.gaps as string[]).includes(
      '2 of 3 asset lines have no photograph or document supporting them.'),
    mbAfterPhoto.json.massBalance.gaps);

  // ── 5. Two read gates, and the softer one is deliberate (§4) ─────────────
  //
  // A Supervisor has project.read and not sustainability.read, and is the person
  // who most needs to know that eight desks are still unallocated. Gating the
  // masses would hide an aggregate of rows they can already read one at a time.
  const mbSup = await call('GET', `/v1/projects/${mbProject}/mass-balance`, { ...asSupCtx });
  eq('a Supervisor without sustainability.read still gets the masses', mbSup.status, 200);
  eq('...as the mass-only view', mbSup.json.massBalance.view, 'MASS_ONLY');
  eq('...with handled, allocated and pending all present',
    [mbSup.json.massBalance.handledKg, mbSup.json.massBalance.allocatedKg,
     mbSup.json.massBalance.pendingKg], [933, 693, 240]);
  eq('...and the caveat that makes those figures a floor travels with them',
    mbSup.json.massBalance.hasUnknownMass, true);
  eq('...while the rates, the breakdown and the gaps are absent rather than null',
    ['rates' in mbSup.json.massBalance, 'byDestination' in mbSup.json.massBalance,
     'gaps' in mbSup.json.massBalance], [false, false, false]);

  /*
   * And the scope departs from the asset list one file over: a provider sees the
   * PROJECT's total, not its own rows. Every line here was recorded by the owner,
   * so a per-company scope would have shown this subcontractor 0 kg.
   */
  eq('a provider sees the project’s mass, not only its own — a total is not a row',
    mbSup.json.massBalance.handledKg, mbAfterPhoto.json.massBalance.handledKg);

  // ── 6. The plan gate is the owner's, as everywhere else in this phase ────
  if (asSubOwnProject) {
    const mbOwnProject = await call('GET', `/v1/projects/${asSubOwnProject}/mass-balance`, {
      ...evSubCtx,
    });
    eq('a company with no asset_tracking is refused on its OWN project',
      mbOwnProject.status, 403);
    check('...naming the key rather than saying Forbidden',
      JSON.stringify(mbOwnProject.json).includes('asset_tracking'), mbOwnProject.json);
  }
  const mbOutsider = await call('GET', `/v1/projects/${mbProject}/mass-balance`, {
    token: evClientUser.token, companyId: evClientCompany,
  });
  eq('the client sees no roll-up at all in Phase 8 — §4 says nobody', mbOutsider.status, 404);

  // ── 7. Nothing is stored, so a tombstone simply stops counting (§7) ──────
  eq('the unweighed line is removed',
    (await call('DELETE', `/v1/assets/${mbUnweighed}`, { ...asOwnerCtx })).status, 204);
  const mbAfterDelete = await call('GET', `/v1/projects/${mbProject}/mass-balance`, { ...asOwnerCtx });
  eq('...and the roll-up stops counting it, because it has no stored form',
    mbAfterDelete.json.massBalance.lineCount, 2);
  eq('...the unknown-mass caveat goes with it',
    mbAfterDelete.json.massBalance.hasUnknownMass, false);
  eq('...and the handled mass is unchanged, because that line weighed nothing',
    mbAfterDelete.json.massBalance.handledKg, 933);
  const { rows: mbNoTable } = await db.query<{ n: string }>(
    `select count(*)::text as n from information_schema.tables
      where table_schema = 'public' and table_name in ('mass_balances','project_mass_balance')`
  );
  eq('no table holds a roll-up: §7 classifies it derived, and §3 says you correct its inputs',
    mbNoTable[0]?.n, '0');

  section('The asset catalog, and the storage that ages');

  // ── 1. GET /v1/asset-types — the picker the register could not render ────
  //
  // Added in 8.6 because the web needed it: every write until then resolved one
  // type by id or by code, so nothing on the API side had ever asked for the
  // list, and a screen cannot render "42 × Operator chair" out of a uuid.
  const atList = await call('GET', '/v1/asset-types', { ...asOwnerCtx });
  eq('the asset catalog is readable', atList.status, 200);
  eq('...and ships the twenty-two', (atList.json.assetTypes as unknown[]).length, 22);
  const atRows = atList.json.assetTypes as {
    code: string; isSystem: boolean; defaultUnitWeightKg: number | null; category: string;
  }[];
  check('every seeded row is marked as the system’s, so a customisation reads as a diff',
    atRows.every((t) => t.isSystem), atRows.slice(0, 3));
  /*
   * §41.1 asserted on the wire rather than only in the seed: null, on all
   * twenty-two, and never 0. A zero here is an invented figure that a hurried
   * supervisor accepts and a client's report then carries as a tonne.
   */
  check('not one of them ships a default weight — null, never 0 (§25.1, §41.1)',
    atRows.every((t) => t.defaultUnitWeightKg === null),
    atRows.filter((t) => t.defaultUnitWeightKg !== null));
  eq('...and the catalog is ordered for a picker rather than by id',
    atRows[0]?.code, 'OPERATOR_CHAIR');

  /*
   * `project.read`, not `asset.write`, and no entitlement check. The catalog is
   * reference data a reader needs to render a register at all, and the feature
   * key is asked of a *project's* owner — a route with no project has no company
   * to ask it of. The subcontractor is on the free Crew plan, which is the case
   * that would break if this route ever grew one.
   */
  const atAsSub = await call('GET', '/v1/asset-types', { ...evSubCtx });
  eq('a Crew-plan subcontractor can read the catalog: it is not what the feature protects',
    atAsSub.status, 200);

  // ── 2. The storage-ageing scan (§25.4, packet §5) ────────────────────────
  //
  // The only enforcement decision #18 has. Storage counting toward no rate is
  // correct and completely silent, so this is the pass that looks.
  //
  // The eight desks went into storage on a fixed date months before this suite
  // runs, which makes them the OUT-OF-WINDOW case first: past 90 days the item
  // already raised stays in the list and the reminder stops being re-sent.
  await runStorageAgeingBatch();
  const { rows: agTooOld } = await db.query<{ n: string }>(
    `select count(*)::text as n from delivery_outbox
      where topic = 'asset.storage_ageing' and aggregate_id = $1`,
    [mbDesks]
  );
  eq('material past 90 days stops being asked about rather than being asked louder',
    agTooOld[0]?.n, '0');

  // Backdated to exactly 42 days in the PROJECT OWNER's own zone, which is the
  // only clock any of this is allowed to use — the rule the expiry ladder settled.
  await db.query(
    `update asset_movements
        set moved_on = ((now() at time zone (
              select coalesce(time_zone, 'UTC') from companies where id = $2
            ))::date - interval '42 days')::date
      where asset_id = $1`,
    [mbDesks, evCompany]
  );
  const agPass = await runStorageAgeingBatch();
  check('the scan finds a line six weeks into storage', agPass.ageing >= 1, agPass);
  const { rows: agEvent } = await db.query<{ payload: Record<string, unknown>; idempotency_key: string }>(
    `select payload, idempotency_key from delivery_outbox
      where topic = 'asset.storage_ageing' and aggregate_id = $1`,
    [mbDesks]
  );
  eq('...counting the days from the project owner’s calendar',
    agEvent[0]?.payload?.daysInStorage, 42);
  /*
   * 240 kg, and the field is `inStorageKg` rather than the packet's `pendingKg`.
   * Pending is storage PLUS everything with no destination at all; the sentence
   * this feeds is true only of the first, and a line with desks stored and chairs
   * never allocated would otherwise report the chairs as having been in a
   * warehouse they were never in.
   */
  eq('...with the stored mass named, and it is the STORED mass, not the pending one',
    agEvent[0]?.payload?.inStorageKg, 240);
  check('...keyed on the asset and the date, so a nightly scan is safe to run nightly',
    typeof agEvent[0]?.idempotency_key === 'string' &&
      agEvent[0].idempotency_key.startsWith('asset.storage_ageing:' + mbDesks + ':'),
    agEvent[0]?.idempotency_key);
  check('...and nothing in the payload names what the material is (§11)',
    !/desk|serial|manufacturer|description/i.test(JSON.stringify(agEvent[0]?.payload)),
    agEvent[0]?.payload);

  await runStorageAgeingBatch();
  const { rows: agAgain } = await db.query<{ n: string }>(
    `select count(*)::text as n from delivery_outbox
      where topic = 'asset.storage_ageing' and aggregate_id = $1`,
    [mbDesks]
  );
  eq('a second scan on the same day enqueues nothing new', agAgain[0]?.n, '1');

  // ── 3. The Action Centre item, and the cohort it goes to ─────────────────
  await drainWorkers();
  const { rows: agNotice } = await db.query<{
    company_id: string; title: string; requires_action: boolean; action_url: string;
  }>(
    `select company_id, title, requires_action, action_url from notifications
      where kind = 'asset.storage_ageing' and subject_id = $1`,
    [mbDesks]
  );
  check('the item names the mass and asks the question (§5)',
    agNotice[0]?.title === '240.0 kg has been in storage 42 days. Where did it go?',
    agNotice[0]?.title);
  check('...and it is the one asset kind that requires action, because it has one',
    agNotice.length > 0 && agNotice.every((n) => n.requires_action === true), agNotice);
  check('...linking straight to the section that answers it',
    agNotice[0]?.action_url?.includes('section=assets') === true, agNotice[0]?.action_url);
  /*
   * Recorded by the owner on the owner's own project, so there is exactly one
   * copy. The second cohort — the recording company — is proved by its absence
   * here rather than by a second fixture: a company recording on its own project
   * is not told twice.
   */
  eq('a company recording on its own project gets one copy, not two',
    new Set(agNotice.map((n) => n.company_id)).size, 1);

  /*
   * The recipient cohort is a CAPABILITY, not a role. §6 names the owner's
   * `sustainability.read` holders, because this is a question about a diversion
   * figure — and a Supervisor's bundle does not carry that while an analyst's
   * does. Asserted against the resolved permission rather than against the role.
   */
  const { rows: agRecipients } = await db.query<{ recipient_user_id: string | null }>(
    `select recipient_user_id from notifications
      where kind = 'asset.storage_ageing' and subject_id = $1`,
    [mbDesks]
  );
  const agFirstRecipient = agRecipients[0]?.recipient_user_id ?? undefined;
  check('and it went to somebody who can actually read a diversion rate',
    agFirstRecipient !== undefined &&
      (await resolveOwnCapabilities(agFirstRecipient, evCompany)).includes('sustainability.read'),
    agRecipients);

  /*
   * And the point of the whole pass: recording where it went closes the question.
   * The storage leg is continued to RESALE, the line reaches a final outcome, and
   * the next scan has nothing to ask about — while the handled mass has not moved
   * by a gram, which is the invariant this phase is built to assert.
   */
  const { rows: agStorageLeg } = await db.query<{ id: string }>(
    `select id from asset_movements where asset_id = $1 and deleted_at is null`,
    [mbDesks]
  );
  await call('POST', `/v1/movements/${agStorageLeg[0]?.id}/continue`, {
    ...asOwnerCtx,
    body: { destinationTypeId: byCode.RESALE.id, quantity: 8, movedOn: '2026-03-20' },
  });
  const agAfter = await runStorageAgeingBatch();
  const { rows: agAfterRows } = await db.query<{ n: string }>(
    `select count(*)::text as n from delivery_outbox
      where topic = 'asset.storage_ageing' and aggregate_id = $1`,
    [mbDesks]
  );
  eq('recording where it went is what closes the question — nothing new is raised',
    agAfterRows[0]?.n, '1');
  /*
   * Scoped as a DIFFERENCE rather than as a zero, and the first version of this
   * assertion was wrong in a way worth keeping: the scan is global, so
   * `ageing === 0` claims nothing else in the whole database is in storage, which
   * a suite that has been recording movements for nine sections has no business
   * asserting. One line left the candidate set; that is the claim.
   */
  eq('...and the line itself leaves the candidate set entirely',
    agAfter.scanned, agPass.scanned - 1);
  const agBalance = await call('GET', `/v1/projects/${mbProject}/mass-balance`, { ...asOwnerCtx });
  eq('...with the handled mass unmoved by the continuation (the phase’s invariant)',
    agBalance.json.massBalance.handledKg, 933);
  eq('...240 kg out of storage and into reuse, and nothing left pending',
    [agBalance.json.massBalance.inStorageKg, agBalance.json.massBalance.pendingKg], [0, 0]);


  // ── The carbon engine (§26–§28) — the Phase 9 §12 acceptance script ───────
  //
  // Fifteen steps, in the order `docs/operating-model/sustainability.md` §12
  // writes them, on the Phase 8 fixture it names: 42 operator chairs removed, 30
  // donated, 12 recycled, plus 8 desks in storage — 933.0 kg handled, 693.0 kg
  // allocated, 240.0 kg pending.
  //
  // A project of its own for the reason the mass-balance section made one: the
  // figures below are exact, and "whatever the suite has recorded by now" is not a
  // number anything can be asserted against.
  //
  // ── THE MILESTONE'S TWO FIGURES, AND WHY THIS FIXTURE DOES NOT PRODUCE THEM ─
  //
  // §28.4 illustrates the two-headline layout with "3.84 tCO₂e / 27.42 tCO₂e", and
  // the phase milestone quotes it. Those figures belong to §28.1's illustration,
  // which is a 21.72-TONNE project; the fixture §12 requires this script to
  // continue is 0.933 t — a factor of twenty-three smaller. Producing 27.42 t of
  // avoided emissions from 30 chairs would need an embodied-carbon factor around
  // 1,142 kgCO₂e per chair, against a realistic 70–80, which is precisely the
  // fabricated number §41.1 and locked decision #16 forbid.
  //
  // So what is proved here is the milestone's SHAPE on real figures: two headlines
  // side by side, never netted, with every number traceable to a factor and a
  // version. The figures are asserted exactly, and they are the fixture's own.
  section('Sustainability — the two headlines, the gaps, and the claim nobody made');

  const suOwner = await register('suowner', `SustainCo ${RUN}`);
  const suCompany = suOwner.companyId!;
  // Business rather than Pro: `custom_factors` is what lets Ama import, and §43
  // puts it a tier above `sustainability` and `carbon_engine`.
  await subscribe(suCompany, 'business');
  const suCtx = { token: suOwner.token, companyId: suCompany };

  const suClientRes = await call('POST', '/v1/clients', {
    ...suCtx,
    body: { name: `Kingsway Estates ${RUN}`, email: `kingsway+${RUN}@verify.crewquo.test` },
  });
  const suProject = (await call('POST', '/v1/projects', {
    ...suCtx,
    body: {
      name: `Kingsway House — Floor 6 ${RUN}`,
      clientCompanyId: suClientRes.json.client.clientCompanyId,
      engagementId: suClientRes.json.client.engagementId,
    },
  })).json.project.id as string;

  const suDest = await call('GET', '/v1/destination-types', { ...suCtx });
  const suByCode = Object.fromEntries(
    (suDest.json.destinationTypes as { code: string }[]).map((d) => [d.code, d])
  ) as Record<string, any>;

  const suChairs = (await call('POST', `/v1/projects/${suProject}/assets`, {
    ...suCtx,
    body: {
      assetTypeId: CHAIR, quantity: 42, weightBasis: 'UNIT', unitWeightKg: 16.5,
      weightSource: 'USER_ESTIMATE',
    },
  })).json.asset.id as string;
  const suDonation = (await call('POST', `/v1/assets/${suChairs}/movements`, {
    ...suCtx,
    body: { destinationTypeId: suByCode.DONATION.id, quantity: 30, movedOn: '2027-03-04' },
  })).json.movement.id as string;
  await call('POST', `/v1/assets/${suChairs}/movements`, {
    ...suCtx,
    body: { destinationTypeId: suByCode.RECYCLING.id, quantity: 12, movedOn: '2027-03-05' },
  });
  const suDesks = (await call('POST', `/v1/projects/${suProject}/assets`, {
    ...suCtx,
    body: {
      assetTypeId: DESK, quantity: 8, weightBasis: 'UNIT', unitWeightKg: 30,
      weightSource: 'USER_ESTIMATE',
    },
  })).json.asset.id as string;
  await call('POST', `/v1/assets/${suDesks}/movements`, {
    ...suCtx,
    body: { destinationTypeId: suByCode.STORAGE.id, quantity: 8, movedOn: '2027-03-06' },
  });

  const suMass = await call('GET', `/v1/projects/${suProject}/mass-balance`, { ...suCtx });
  eq('the Phase 8 fixture is intact — 933 kg handled, 693 allocated, 240 pending',
    [suMass.json.massBalance.handledKg, suMass.json.massBalance.allocatedKg,
     suMass.json.massBalance.pendingKg],
    [933, 693, 240]);

  // ── 1. Empty. Absent, not zero ───────────────────────────────────────────
  //
  // §41.1 asserted at the top of the phase, where it is easiest to break: a project
  // with no factor set has not emitted nothing, it has been measured by nobody.
  const suEmpty = await call('GET', `/v1/projects/${suProject}/carbon`, { ...suCtx });
  eq('before any factor set exists the section still answers', suEmpty.status, 200);
  eq('...with the full view, because the reader holds sustainability.read',
    suEmpty.json.carbon.view, 'FULL');
  eq('...and BOTH headlines are null rather than 0.00 tCO₂e',
    [suEmpty.json.carbon.projectEmissionsKgCo2e, suEmpty.json.carbon.avoidedKgCo2e],
    [null, null]);
  eq('...with no factor set to name', suEmpty.json.carbon.factorSet, null);
  check('...and the mass balance beside it is unaffected',
    suMass.json.massBalance.handledKg === 933, suMass.json.massBalance);

  // ── 2. Import ────────────────────────────────────────────────────────────
  //
  // A small, obviously synthetic set, named as such (packet §13.6). §45's licensing
  // gate on the published UK Government factors is unanswered and this suite does
  // not wait for it: a fixture that LOOKED real would be the fabricated row §26.2
  // forbids, wearing a test label.
  const suCsv = [
    'Category,Activity,Material,Treatment,Vehicle,Fuel,Unit,kg CO2e,WTT',
    'Waste,Recycling,Operator chair,RECYCLING,,,tonne,21.28,',
    'Waste,Reuse,Operator chair,REUSE,,,tonne,21.28,',
    'Waste,Landfill,,LANDFILL,,,tonne,587.0,',
    'Fuels,Diesel,,,,DIESEL,litre,2.5,0.6',
    'Transport,Van,,,VAN,DIESEL,km,0.25,0.05',
    'Electricity,Grid electricity,,,,,kWh,0.2,',
  ].join('\n');
  const suMapping = {
    category: 'Category', activity: 'Activity', material: 'Material', treatment: 'Treatment',
    vehicleType: 'Vehicle', fuelType: 'Fuel', unit: 'Unit',
    kgCo2ePerUnit: 'kg CO2e', wttKgCo2ePerUnit: 'WTT',
  };
  const suSetBody = {
    name: `CrewQuo Test Factors 2027 ${RUN}`,
    sourceOrganisation: 'CrewQuo — synthetic test data',
    reportingYear: 2027,
    version: 'v1.0',
    validFrom: '2027-01-01',
    region: 'GB',
  };

  const suPreview = await call('POST', '/v1/factor-sets/preview', {
    ...suCtx, body: { format: 'CSV', content: suCsv },
  });
  eq('the mapping preview reads the file without importing it', suPreview.status, 200);
  eq('...and guesses the columns it recognises',
    [suPreview.json.suggestedMapping.unit, suPreview.json.suggestedMapping.kgCo2ePerUnit],
    ['Unit', 'kg CO2e']);
  eq('...counting the rows', suPreview.json.rowCount, 6);

  const suDry = await call('POST', '/v1/factor-sets/import', {
    ...suCtx,
    body: { format: 'CSV', content: suCsv, mapping: suMapping, set: suSetBody, dryRun: true },
  });
  eq('the dry run reports what would be added', suDry.json.diff.toAdd, 6);
  eq('...by category', suDry.json.diff.countsByCategory,
    { Waste: 3, Fuels: 1, Transport: 1, Electricity: 1 });
  eq('...and refuses nothing', suDry.json.diff.failures, []);
  const { rows: suNoSetYet } = await db.query<{ n: string }>(
    `select count(*)::text as n from emission_factor_sets where company_id = $1`, [suCompany]);
  eq('...having changed nothing at all', suNoSetYet[0]?.n, '0');

  const suImport = await call('POST', '/v1/factor-sets/import', {
    ...suCtx,
    body: { format: 'CSV', content: suCsv, mapping: suMapping, set: suSetBody, dryRun: false },
  });
  eq('the confirmed import lands atomically', suImport.status, 201);
  eq('...with every row', suImport.json.imported, 6);
  const suSetId = suImport.json.factorSet.id as string;
  eq('...and the set names itself as synthetic, so it cannot be mistaken for published data',
    suImport.json.factorSet.sourceOrganisation, 'CrewQuo — synthetic test data');

  await drainWorkers();
  const { rows: suImportNote } = await db.query<{ title: string; recipient_user_id: string }>(
    `select title, recipient_user_id from notifications
      where kind = 'sustainability.factor_set_imported' and subject_id = $1`, [suSetId]);
  eq('...and the importing user, and only they, get the receipt', suImportNote.length, 1);
  eq('...addressed to the person who imported it', suImportNote[0]?.recipient_user_id, suOwner.userId);
  check('...carrying the counts by category rather than a bare row count',
    String(suImportNote[0]?.title ?? '').includes('6 factors'), suImportNote[0]);

  // ── 3. Duplicate refused (finding 2) ─────────────────────────────────────
  const suDupe = await call('POST', '/v1/factor-sets/import', {
    ...suCtx,
    body: { format: 'CSV', content: suCsv, mapping: suMapping, set: suSetBody, dryRun: false },
  });
  eq('the identical file is refused by name and version', suDupe.status, 409);
  eq('...naming the reason', suDupe.json.error?.details?.reason, 'SET_ALREADY_EXISTS');
  const { rows: suOneSet } = await db.query<{ n: string }>(
    `select count(*)::text as n from emission_factor_sets where company_id = $1`, [suCompany]);
  eq('...with no second copy', suOneSet[0]?.n, '1');
  const { rows: suSixFactors } = await db.query<{ n: string }>(
    `select count(*)::text as n from emission_factors where factor_set_id = $1`, [suSetId]);
  eq('...and no partial rows', suSixFactors[0]?.n, '6');

  // ── 4. Waste treatment, and finding 8's first silence ────────────────────
  const suRecalc1 = await call('POST', `/v1/projects/${suProject}/carbon/recalculate`, { ...suCtx });
  eq('an explicit recalculation applies the newly imported set', suRecalc1.status, 200);

  const suCarbon1 = await call('GET', `/v1/projects/${suProject}/carbon`, { ...suCtx });
  const suCalcs1 = await call('GET', `/v1/projects/${suProject}/carbon/calculations`, { ...suCtx });
  const treatment1 = (suCalcs1.json.calculations as any[]).filter((c) => c.bucket === 'WASTE_TREATMENT');
  eq('12 chairs recycled and 30 donated each produce a treatment row', treatment1.length, 2);
  const recycled = treatment1.find((c) => c.inputs.destinationCode === 'RECYCLING');
  eq('...recycling is 0.198 t × 21.28 kgCO₂e/t', Number(recycled.kgCo2e.toFixed(5)), 4.21344);
  eq('...citing the set, its version, its reporting year and the factor value it used',
    [recycled.citation.factorSetVersion, recycled.citation.factorReportingYear,
     recycled.citation.factorKgCo2ePerUnit],
    ['v1.0', 2027, 21.28]);
  eq('...and it is Scope 3 category 5, waste generated in operations',
    [recycled.scope, recycled.scope3Category], ['SCOPE_3', 5]);
  const donated = treatment1.find((c) => c.inputs.destinationCode === 'DONATION');
  eq('30 donated chairs produce a REUSE treatment emission, not a gap',
    Number(donated.kgCo2e.toFixed(5)), 10.5336);
  check('...and no treatment gap is reported about them — a reuse factor was found',
    !(suCarbon1.json.carbon.gaps as string[]).some(
      (g) => g.includes('waste-treatment factor') && g.includes('Operator chair')),
    suCarbon1.json.carbon.gaps);
  check('...nor about the 8 desks in storage, which were never a waste treatment',
    !(suCarbon1.json.carbon.gaps as string[]).some((g) => g.includes('Desk')),
    suCarbon1.json.carbon.gaps);

  // ── 5. A disclosed gap — finding 8's second silence ──────────────────────
  const PLASTIC = await asType('PLASTIC');
  const suPlastic = (await call('POST', `/v1/projects/${suProject}/assets`, {
    ...suCtx,
    body: {
      assetTypeId: PLASTIC, quantity: 1, weightBasis: 'TOTAL', totalWeightKg: 1200,
      weightSource: 'WEIGHBRIDGE',
    },
  })).json.asset.id as string;
  await call('POST', `/v1/assets/${suPlastic}/movements`, {
    ...suCtx,
    body: { destinationTypeId: suByCode.ENERGY_RECOVERY.id, quantity: 1, movedOn: '2027-03-07' },
  });

  const suCarbon2 = await call('GET', `/v1/projects/${suProject}/carbon`, { ...suCtx });
  const suGaps2 = suCarbon2.json.carbon.gaps as string[];
  check('a treatment key with no factor in the set is disclosed by material and mass',
    suGaps2.some((g) => g.includes('No waste-treatment factor exists for Plastic')
      && g.includes('1.20 t')),
    suGaps2);
  check('...naming the set it looked in',
    suGaps2.some((g) => g.includes(suSetBody.name)), suGaps2);
  check('...and no number is invented for it',
    !(suCalcs1.json.calculations as any[]).some((c) => c.inputs.destinationCode === 'ENERGY_RECOVERY'),
    suCalcs1.json.calculations);

  // ── 6. Displacement unknown by default — finding 1's regression test ─────
  //
  // THE STEP THIS PACKET WAS WRITTEN FOR. §39's DDL said `not null default 100`;
  // the owner decided on 2026-08-18 that displacement defaults to UNKNOWN, never
  // 100%. Built literally, every one of the 30 donated chairs below would carry a
  // maximal avoided-emissions claim with ASSUMED_FULL recorded as the basis of an
  // assumption nobody made.
  const suSettings0 = await call('GET', '/v1/sustainability-settings', { ...suCtx });
  eq('a company begins with an UNKNOWN displacement basis',
    suSettings0.json.settings.defaultDisplacementBasis, 'UNKNOWN');
  eq('...and no percentage at all, because UNKNOWN cannot carry one',
    suSettings0.json.settings.defaultDisplacementPct, null);

  eq('the avoided headline is absent, not zero, with no assumption stated',
    suCarbon2.json.carbon.avoidedKgCo2e, 0);
  const { rows: suNoClaims } = await db.query<{ n: string }>(
    `select count(*)::text as n from avoided_emissions_claims a
       join carbon_calculations c on c.id = a.calculation_id
      where c.project_id = $1`, [suProject]);
  eq('...and NO claim row exists for the 30 donated chairs', suNoClaims[0]?.n, '0');
  check('...with the reason said in words rather than left as a silence',
    suGaps2.some((g) => g.includes('No displacement assumption has been stated')), suGaps2);

  await drainWorkers();
  const { rows: suBlocked } = await db.query<{ title: string }>(
    `select title from notifications where kind = 'sustainability.claim_blocked'
       and company_id = $1 order by created_at desc limit 1`, [suCompany]);
  check('...and an Action Centre item says which claim could not be made',
    String(suBlocked[0]?.title ?? '').includes('no displacement assumption'), suBlocked[0]);

  // A percentage cannot be stored without a basis that means one.
  const suBadPair = await call('PATCH', '/v1/sustainability-settings', {
    ...suCtx, body: { defaultDisplacementBasis: 'ASSUMED_FULL', defaultDisplacementPct: 80 },
  });
  eq('ASSUMED_FULL carrying a stray percentage is refused', suBadPair.status, 422);
  const suBadPair2 = await call('PATCH', '/v1/sustainability-settings', {
    ...suCtx, body: { defaultDisplacementBasis: 'USER_DEFINED' },
  });
  eq('...and USER_DEFINED with no percentage is refused just as firmly', suBadPair2.status, 422);

  // ── 7. A claim, stated ───────────────────────────────────────────────────
  const suFactor = await call('POST', '/v1/product-factors', {
    ...suCtx,
    body: {
      itemCategory: 'FURNITURE', assetTypeId: CHAIR,
      kgCo2ePerItem: 72, lifecycleBoundary: 'A1_A3',
      source: 'CrewQuo — synthetic test data', verificationStatus: 'EPD_VERIFIED',
    },
  });
  eq('an EPD-verified product factor is recorded', suFactor.status, 201);
  eq('...and is not an estimate, which is derived rather than accepted',
    suFactor.json.productFactor.isEstimate, false);

  // The collection that made the reuse possible, linked to the movement it enabled.
  const suVan = await call('POST', `/v1/projects/${suProject}/activities`, {
    ...suCtx,
    body: {
      kind: 'VEHICLE_DISTANCE', activityDate: '2027-03-04', distanceKm: 240,
      vehicleCategory: 'VAN', fuelType: 'DIESEL', purpose: 'COLLECTION',
      assetMovementId: suDonation, source: 'DOCUMENTED',
    },
  });
  eq('a van collection is recorded against the project', suVan.status, 201);
  await call('POST', `/v1/projects/${suProject}/activities`, {
    ...suCtx,
    body: { kind: 'FUEL', activityDate: '2027-03-05', litres: 180, fuelType: 'DIESEL' },
  });
  await call('POST', `/v1/projects/${suProject}/activities`, {
    ...suCtx,
    body: { kind: 'ELECTRICITY', activityDate: '2027-03-05', kwh: 1200 },
  });

  const suStated = await call('PATCH', '/v1/sustainability-settings', {
    ...suCtx, body: { defaultDisplacementBasis: 'USER_DEFINED', defaultDisplacementPct: 80 },
  });
  eq('an explicit, attributable assumption is accepted', suStated.status, 200);
  check('...and says it does not restate figures already published',
    String(suStated.json.notice ?? '').includes('already issued'), suStated.json.notice);

  await call('POST', `/v1/projects/${suProject}/carbon/recalculate`, { ...suCtx });
  const suCarbon3 = await call('GET', `/v1/projects/${suProject}/carbon`, { ...suCtx });

  eq('the 30 donated chairs now carry an avoided-emissions claim',
    (suCarbon3.json.carbon.claims as unknown[]).length, 1);
  const suClaim = (suCarbon3.json.carbon.claims as any[])[0];
  eq('...30 × 80% × 72 kgCO₂e is the baseline', suClaim.baselineKgCo2e, 1728);
  eq('...the 240 km collection linked to the movement is deducted as enabling emissions',
    suClaim.enablingKgCo2e, 72);
  eq('...leaving 1,656 kgCO₂e avoided', suClaim.netAvoidedKgCo2e, 1656);
  eq('...recording the basis and the percentage together',
    [suClaim.displacementBasis, suClaim.displacementPct], ['USER_DEFINED', 80]);
  eq('...and the system boundary taken from the factor', suClaim.systemBoundary, 'A1_A3');
  check('...with the baseline and alternative scenarios stated in words',
    suClaim.baselineScenario.length > 0 && suClaim.alternativeScenario.length > 0, suClaim);
  check('...and the methodology warning travelling ON the claim, not in an appendix',
    suClaim.methodology.includes('not a reduction'), suClaim.methodology);

  // ── THE MILESTONE: two figures, side by side, never netted ──────────────
  //
  // 450 kg diesel + 108 kg its well-to-tank + 60 km-based + 12 kg its WTT +
  // 240 kg electricity = 870 kg of operational emissions, plus 14.74704 kg of
  // waste treatment.
  eq('PROJECT GHG EMISSIONS — every activity and every treatment, current rows only',
    Number(suCarbon3.json.carbon.projectEmissionsKgCo2e.toFixed(5)), 884.74704);
  eq('ESTIMATED AVOIDED EMISSIONS — reported separately and never deducted',
    suCarbon3.json.carbon.avoidedKgCo2e, 1656);
  check('...and the response carries no combined or net figure anywhere (§27.5)',
    !('net' in suCarbon3.json.carbon) && !('totalKgCo2e' in suCarbon3.json.carbon),
    Object.keys(suCarbon3.json.carbon));

  const suScopes = Object.fromEntries(
    (suCarbon3.json.carbon.byScope as { scope: string; kgCo2e: number }[])
      .map((s) => [s.scope, Number(s.kgCo2e.toFixed(5))])
  );
  eq('Scope 1 is the company’s own diesel and its own van', suScopes.SCOPE_1, 510);
  eq('Scope 2 is the electricity, on a location basis', suScopes.SCOPE_2, 240);
  eq('Scope 3 is well-to-tank plus the two waste treatments', suScopes.SCOPE_3, 134.74704);
  const suElec = (await call('GET', `/v1/projects/${suProject}/carbon/calculations`, { ...suCtx }))
    .json.calculations.find((c: any) => c.inputs.activityKind === 'ELECTRICITY');
  eq('...and the electricity row LABELS its basis rather than leaving it assumed',
    suElec.inputs.scope2Basis, 'LOCATION_BASED');

  // ── 8. Retained in use with no claim — finding 7 ─────────────────────────
  const suExtra = (await call('POST', `/v1/projects/${suProject}/assets`, {
    ...suCtx,
    body: {
      assetTypeId: CHAIR, quantity: 10, weightBasis: 'UNIT', unitWeightKg: 16.5,
      weightSource: 'USER_ESTIMATE',
    },
  })).json.asset.id as string;
  await call('POST', `/v1/assets/${suExtra}/movements`, {
    ...suCtx,
    body: { destinationTypeId: suByCode.RELOCATED.id, quantity: 4, movedOn: '2027-03-08' },
  });
  await call('POST', `/v1/assets/${suExtra}/movements`, {
    ...suCtx,
    body: { destinationTypeId: suByCode.RETAINED.id, quantity: 6, movedOn: '2027-03-08' },
  });

  const suCarbon4 = await call('GET', `/v1/projects/${suProject}/carbon`, { ...suCtx });
  eq('relocated material claims — it was used instead of something being bought',
    (suCarbon4.json.carbon.claims as unknown[]).length, 2);
  eq('...4 × 80% × 72 with nothing enabling it', Number(
    (suCarbon4.json.carbon.claims as any[]).find((c: any) => c.enablingKgCo2e === 0).netAvoidedKgCo2e
  ), 230.4);
  const suGaps4 = suCarbon4.json.carbon.gaps as string[];
  check('retained material claims nothing, and the section says so in words',
    suGaps4.some((g) => g.includes('was retained in use by the client')
      && g.includes('no replacement was displaced')), suGaps4);
  check('...over the 99 kg that displaced nothing, not the 495 kg that did',
    suGaps4.some((g) => g.includes('99.0 kg was retained in use')), suGaps4);

  // ── 9. The firewall (locked decision #17, §44) ───────────────────────────
  //
  // Asserted over the STRUCTURE of every carbon response rather than over one
  // chosen figure: a total mixing AVOIDED with anything else would have to appear
  // as a key, and there is no key it could appear under.
  const suFirewallBodies = [suCarbon1, suCarbon2, suCarbon3, suCarbon4, suCalcs1];
  check('no carbon response anywhere in this run carries a netted total',
    suFirewallBodies.every((r) => {
      const text = JSON.stringify(r.json);
      return !/"net"|"netKgCo2e"|"totalCarbon"|"combinedKgCo2e"/.test(text);
    }),
    suFirewallBodies.map((r) => Object.keys(r.json)));
  const suBuckets = Object.fromEntries(
    (suCarbon4.json.carbon.byBucket as { bucket: string; kgCo2e: number }[])
      .map((b) => [b.bucket, b.kgCo2e])
  );
  eq('the AVOIDED bucket is reported on its own',
    Number((suBuckets.AVOIDED ?? 0).toFixed(1)), 1886.4);
  check('...and the two inventory buckets sum to the headline without it',
    Math.abs(
      ((suBuckets.PROJECT_EMISSIONS ?? 0) + (suBuckets.WASTE_TREATMENT ?? 0))
      - suCarbon4.json.carbon.projectEmissionsKgCo2e
    ) < 1e-9,
    suBuckets);
  const { rows: suNoCrossBucket } = await db.query<{ n: string }>(
    `select count(*)::text as n from carbon_calculations
      where project_id = $1 and bucket = 'AVOIDED' and scope is not null`, [suProject]);
  eq('...and no persisted AVOIDED row carries a scope it could be summed into',
    suNoCrossBucket[0]?.n, '0');

  // ── 10. Denied ───────────────────────────────────────────────────────────
  const suSup = await register('susup', undefined, `susup+${RUN}@verify.crewquo.test`);
  const suSupInvite = await call('POST', '/v1/members/invite', {
    ...suCtx, body: { email: suSup.email, role: 'MEMBER' },
  });
  await call('POST', `/v1/invites/${suSupInvite.json.inviteToken}/accept`, { token: suSup.token });
  await db.query(
    `update memberships set bundle_key = 'supervisor' where company_id = $1 and user_id = $2`,
    [suCompany, suSup.userId]
  );
  const suSupCtx = { token: suSup.token, companyId: suCompany };

  const suSupCarbon = await call('GET', `/v1/projects/${suProject}/carbon`, { ...suSupCtx });
  eq('a supervisor reads the section', suSupCarbon.status, 200);
  eq('...as the mass-only view', suSupCarbon.json.carbon.view, 'MASS_ONLY');
  check('...with the carbon keys ABSENT rather than nulled, so nothing can render 0.00 tCO₂e',
    !('projectEmissionsKgCo2e' in suSupCarbon.json.carbon)
      && !('avoidedKgCo2e' in suSupCarbon.json.carbon)
      && !('completeness' in suSupCarbon.json.carbon),
    Object.keys(suSupCarbon.json.carbon));
  const suSupMass = await call('GET', `/v1/projects/${suProject}/mass-balance`, { ...suSupCtx });
  eq('...while the masses still render for them', suSupMass.json.massBalance.handledKg, 2298);

  const suSupImport = await call('POST', '/v1/factor-sets/import', {
    ...suSupCtx,
    body: { format: 'CSV', content: suCsv, mapping: suMapping, set: suSetBody, dryRun: true },
  });
  eq('...and a factor import is refused on capability', suSupImport.status, 403);

  const suOutsider = await register('suout', `Outsider Ltd ${RUN}`);
  await subscribe(suOutsider.companyId!, 'business');
  const suForged = await call('GET', `/v1/projects/${suProject}/carbon`, {
    token: suOutsider.token, companyId: suOutsider.companyId!,
  });
  eq('a second company forging this project’s id gets the same answer an unknown id gets',
    suForged.status, 404);

  // ── 11. Correction, and the supersession trail ───────────────────────────
  const suBeforeCorrection = suCarbon4.json.carbon.projectEmissionsKgCo2e as number;
  await call('PATCH', `/v1/assets/${suChairs}`, {
    ...suCtx, body: { unitWeightKg: 18 },
  });
  const suCarbon5 = await call('GET', `/v1/projects/${suProject}/carbon`, { ...suCtx });
  check('correcting a weight moves the emissions figure',
    suCarbon5.json.carbon.projectEmissionsKgCo2e !== suBeforeCorrection,
    [suBeforeCorrection, suCarbon5.json.carbon.projectEmissionsKgCo2e]);

  const { rows: suSuperseded } = await db.query<{ n: string }>(
    `select count(*)::text as n from carbon_calculations
      where project_id = $1 and superseded_by is not null`, [suProject]);
  check('...superseding the rows it replaced rather than editing them',
    Number(suSuperseded[0]?.n ?? 0) > 0, suSuperseded[0]);
  const { rows: suOneCurrent } = await db.query<{ n: string }>(
    `select count(*)::text as n from carbon_calculations c
      where c.project_id = $1 and c.superseded_by is null
        and c.source_type = 'ASSET_MOVEMENT' and c.bucket = 'WASTE_TREATMENT'`, [suProject]);
  eq('...leaving exactly one current row per treated movement', suOneCurrent[0]?.n, '2');

  const suTrace = await call('GET',
    `/v1/projects/${suProject}/carbon/calculations?includeSuperseded=true`, { ...suCtx });
  check('...and the superseded rows stay readable, and stay out of every sum',
    (suTrace.json.calculations as any[]).some((c) => c.supersededBy !== null),
    (suTrace.json.calculations as any[]).length);

  const { rows: suDelta } = await db.query<{ payload: any }>(
    `select payload from delivery_outbox
      where topic = 'sustainability.calculations_superseded' and aggregate_id = $1
      order by created_at desc limit 1`, [suProject]);
  eq('...with the trigger recorded', suDelta[0]?.payload?.trigger, 'WEIGHT_CORRECTED');
  check('...and the per-bucket delta, which is the only place "why did the number move" is answered',
    typeof suDelta[0]?.payload?.deltaByBucket?.WASTE_TREATMENT === 'number',
    suDelta[0]?.payload);

  await drainWorkers();
  const { rows: suNoSupersessionNotice } = await db.query<{ n: string }>(
    `select count(*)::text as n from notifications
      where kind like 'sustainability.calculations%'`);
  eq('...and supersession notifies NOBODY, which is the deliberate half of §6',
    suNoSupersessionNotice[0]?.n, '0');

  // ── 12. Tombstone — finding 6, which no other step would catch ───────────
  const { rows: suRecycleMovement } = await db.query<{ id: string }>(
    `select m.id from asset_movements m
       join destination_types d on d.id = m.destination_type_id
      where m.asset_id = $1 and d.code = 'RECYCLING' and m.deleted_at is null`, [suChairs]);
  const suBeforeTombstone = suCarbon5.json.carbon.projectEmissionsKgCo2e as number;

  const suDelete = await call('DELETE', `/v1/movements/${suRecycleMovement[0]!.id}`, { ...suCtx });
  eq('a movement is tombstoned', suDelete.status, 204);

  const suCarbon6 = await call('GET', `/v1/projects/${suProject}/carbon`, { ...suCtx });
  const suMass6 = await call('GET', `/v1/projects/${suProject}/mass-balance`, { ...suCtx });
  check('the project’s emissions figure FALLS — the calculation did not stand',
    (suCarbon6.json.carbon.projectEmissionsKgCo2e as number) < suBeforeTombstone,
    [suBeforeTombstone, suCarbon6.json.carbon.projectEmissionsKgCo2e]);
  const { rows: suNoOrphan } = await db.query<{ n: string }>(
    `select count(*)::text as n from carbon_calculations
      where project_id = $1 and superseded_by is null and source_id = $2`,
    [suProject, suRecycleMovement[0]!.id]);
  eq('...and no current calculation is left pointing at the deleted movement',
    suNoOrphan[0]?.n, '0');

  const { rows: suAgree } = await db.query<{ kg: string | null }>(
    `select sum(coalesce(m.weight_kg, m.quantity * a.unit_weight_kg))::text as kg
       from asset_movements m
       join project_assets a on a.id = m.asset_id
       join destination_types d on d.id = m.destination_type_id
      where a.project_id = $1 and m.deleted_at is null and a.deleted_at is null
        and d.ghg_treatment_key is not null`, [suProject]);
  const treatedRows = (await call('GET', `/v1/projects/${suProject}/carbon/calculations`, { ...suCtx }))
    .json.calculations.filter((c: any) => c.bucket === 'WASTE_TREATMENT');
  check('...so the carbon roll-up and the mass balance agree about what exists',
    treatedRows.every((c: any) => c.sourceId !== suRecycleMovement[0]!.id),
    { treatedRows: treatedRows.length, treatedMassKg: suAgree[0]?.kg, mass: suMass6.json.massBalance.allocatedKg });

  // ── 13. Reproducibility (§41.3) — the one assertion Priya depends on ─────
  const suFigureBefore2028 = suCarbon6.json.carbon.projectEmissionsKgCo2e as number;
  const suCalcsBefore2028 = (await call('GET',
    `/v1/projects/${suProject}/carbon/calculations`, { ...suCtx })).json.calculations as any[];

  const su2028 = await call('POST', '/v1/factor-sets/import', {
    ...suCtx,
    body: {
      format: 'CSV',
      content: suCsv.replace(/21\.28/g, '15.00').replace(/2\.5,0\.6/, '1.9,0.4'),
      mapping: suMapping,
      set: {
        ...suSetBody,
        name: `CrewQuo Test Factors 2028 ${RUN}`,
        reportingYear: 2028,
        validFrom: '2028-01-01',
      },
      dryRun: false,
    },
  });
  eq('a 2028 set is imported and is active', su2028.status, 201);
  check('...and says so rather than leaving the reader to assume it restates last year',
    String(su2028.json.notice ?? '').includes('unchanged'), su2028.json.notice);

  const suCarbon7 = await call('GET', `/v1/projects/${suProject}/carbon`, { ...suCtx });
  eq('the 2027 project’s figures are UNCHANGED by a newer set',
    suCarbon7.json.carbon.projectEmissionsKgCo2e, suFigureBefore2028);
  const suCalcsAfter2028 = (await call('GET',
    `/v1/projects/${suProject}/carbon/calculations`, { ...suCtx })).json.calculations as any[];
  eq('...still citing 2027, row for row',
    suCalcsAfter2028.map((c) => c.citation.factorReportingYear).filter((y) => y !== null),
    suCalcsBefore2028.map((c) => c.citation.factorReportingYear).filter((y) => y !== null));
  eq('...and reproducing the same numbers',
    suCalcsAfter2028.map((c) => c.kgCo2e), suCalcsBefore2028.map((c) => c.kgCo2e));

  // Even a deliberate recalculation keeps 2027 work on 2027 factors: selection is
  // by the date the work happened, not by the newest set on the shelf.
  await call('POST', `/v1/projects/${suProject}/carbon/recalculate`, { ...suCtx });
  const suCarbon8 = await call('GET', `/v1/projects/${suProject}/carbon`, { ...suCtx });
  eq('...and an explicit recalculation still selects the 2027 set for 2027 work',
    suCarbon8.json.carbon.projectEmissionsKgCo2e, suFigureBefore2028);

  // ── 14. Offline (§8) ─────────────────────────────────────────────────────
  const suClientId = randomUUID();
  const suOffline1 = await call('POST', `/v1/projects/${suProject}/activities`, {
    ...suCtx,
    body: {
      kind: 'FUEL', activityDate: '2027-03-09', litres: 40, fuelType: 'DIESEL',
      clientId: suClientId, capturedAt: '2027-03-09T07:14:00.000Z',
    },
  });
  eq('an activity captured on a dropped connection lands once', suOffline1.status, 201);
  const suOffline2 = await call('POST', `/v1/projects/${suProject}/activities`, {
    ...suCtx,
    body: {
      kind: 'FUEL', activityDate: '2027-03-09', litres: 40, fuelType: 'DIESEL',
      clientId: suClientId, capturedAt: '2027-03-09T07:14:00.000Z',
    },
  });
  eq('...and a retry with the same client id returns the first answer', suOffline2.status, 201);
  eq('...byte for byte', suOffline2.json.activity.id, suOffline1.json.activity.id);
  const { rows: suOneActivity } = await db.query<{ n: string }>(
    `select count(*)::text as n from project_activities
      where project_id = $1 and client_id = $2 and deleted_at is null`, [suProject, suClientId]);
  eq('...with exactly one row in the table', suOneActivity[0]?.n, '1');
  eq('...keeping the device’s clock distinct from the server’s',
    suOffline1.json.activity.capturedAt, '2027-03-09T07:14:00.000Z');

  const suActivityId = suOffline1.json.activity.id as string;
  const suStale = await call('PATCH', `/v1/activities/${suActivityId}`, {
    ...suCtx, body: { litres: 45, expectedRevision: 99 },
  });
  eq('an expected-version mismatch is a conflict, not a merge', suStale.status, 409);
  eq('...showing what is on the server beside what was captured',
    suStale.json.error?.details?.current?.litres, 40);
  eq('...and naming the reason a device can switch on',
    suStale.json.error?.details?.reason, 'STALE_REVISION');

  // ── 15. Completeness, with five components ───────────────────────────────
  //
  // The debt Phase 8 named and deferred: four of §28.3's five components were
  // computable then and the fifth needed an avoided-emissions claim to exist.
  const suFinal = await call('GET', `/v1/projects/${suProject}/carbon`, { ...suCtx });
  const suComponents = suFinal.json.carbon.completeness.components as any[];
  eq('the score renders with all five components broken out', suComponents.length, 5);
  eq('...named for a person rather than as enum keys',
    suComponents.map((c) => c.component).sort(),
    ['AVOIDED_MASS_ON_SPECIFIC_FACTOR', 'LINES_WITH_SUPPORT', 'LINES_WITH_WEIGHT',
     'MASS_DOCUMENTED_OR_VERIFIED', 'MASS_WITH_FINAL_DESTINATION'].sort());
  check('...each with its weight and its measured value, not a bare percentage',
    suComponents.every((c) => typeof c.weight === 'number' && typeof c.measured === 'number'
      && typeof c.total === 'number' && typeof c.label === 'string'),
    suComponents);
  check('...the five weights summing to 1, read from the settings row',
    Math.abs(suComponents.reduce((s, c) => s + c.weight, 0) - 1) < 1e-9, suComponents);
  eq('...and the fifth is the one Phase 8 could not compute',
    suComponents.find((c) => c.component === 'AVOIDED_MASS_ON_SPECIFIC_FACTOR').value, 1);
  check('...with a score at last', typeof suFinal.json.carbon.completeness.pct === 'number',
    suFinal.json.carbon.completeness);
  eq('...and the threshold §38.1 attaches it to any figure below',
    suFinal.json.carbon.completeness.warnBelow, 80);

  // The weights are the settings row's, and editing them moves the score.
  const suScoreBefore = suFinal.json.carbon.completeness.pct as number;
  await call('PATCH', '/v1/sustainability-settings', {
    ...suCtx,
    body: {
      dataQualityWeights: {
        LINES_WITH_WEIGHT: 0.6, MASS_WITH_FINAL_DESTINATION: 0.1,
        MASS_DOCUMENTED_OR_VERIFIED: 0.1, LINES_WITH_SUPPORT: 0.1,
        AVOIDED_MASS_ON_SPECIFIC_FACTOR: 0.1,
      },
    },
  });
  const suReweighted = await call('GET', `/v1/projects/${suProject}/carbon`, { ...suCtx });
  check('the weights come from §39 rather than from constants — editing them moves the score',
    suReweighted.json.carbon.completeness.pct !== suScoreBefore,
    [suScoreBefore, suReweighted.json.carbon.completeness.pct]);

  const suPhase8Gaps = suFinal.json.carbon.gaps as string[];
  check('every Phase 8 gap sentence still renders, unchanged',
    suPhase8Gaps.some((g) => g.includes('of project weight is estimated')), suPhase8Gaps);
  const suGenericSentences = suPhase8Gaps.filter((g) => g.includes('generic product factor'));
  check('...and the fifth component’s sentence appears at most once, never twice over',
    suGenericSentences.length <= 1, suGenericSentences);

  // ── The organisation dashboard (§38.1) ───────────────────────────────────
  section('Organisation sustainability dashboard — click-through, and no vanity metrics');

  const suDash = await call('GET', '/v1/sustainability/dashboard', { ...suCtx });
  eq('the dashboard answers', suDash.status, 200);
  check('...with rows before totals, so every figure can be clicked through to its records',
    (suDash.json.dashboard.projects as any[]).some((p) => p.projectId === suProject),
    (suDash.json.dashboard.projects as any[]).map((p) => p.projectName));
  const suDashRow = (suDash.json.dashboard.projects as any[]).find((p) => p.projectId === suProject);
  eq('...carrying this project’s two figures, separately',
    [Number(suDashRow.projectEmissionsKgCo2e.toFixed(5)),
     Number(suDashRow.avoidedKgCo2e.toFixed(1))],
    [Number((suFinal.json.carbon.projectEmissionsKgCo2e as number).toFixed(5)),
     Number((suFinal.json.carbon.avoidedKgCo2e as number).toFixed(1))]);
  check('...and its completeness, attached to the figure rather than presented as fact',
    typeof suDashRow.completenessPct === 'number', suDashRow);
  check('...with the totals never netting the two',
    !('net' in suDash.json.dashboard.totals), Object.keys(suDash.json.dashboard.totals));
  check('...naming which factor sets the period spans (§38.2, one phase early)',
    (suDash.json.dashboard.factorSetNames as string[]).some((n) => n.includes('2027')),
    suDash.json.dashboard.factorSetNames);
  check('...and the methodology warning travelling with the avoided figure here too',
    String(suDash.json.dashboard.methodologyWarning).includes('not a reduction'),
    suDash.json.dashboard.methodologyWarning);

  const suDashDenied = await call('GET', '/v1/sustainability/dashboard', { ...suSupCtx });
  eq('a supervisor is refused the dashboard, which aggregates across projects',
    suDashDenied.status, 403);

  const suOutsiderDash = await call('GET', '/v1/sustainability/dashboard', {
    token: suOutsider.token, companyId: suOutsider.companyId!,
  });
  eq('an unrelated company sees a dashboard of its own projects',
    (suOutsiderDash.json.dashboard.projects as unknown[]).length, 0);
  eq('...and no rate at all, because there is nothing to divide by',
    suOutsiderDash.json.dashboard.rates.diverted, null);

  // ── Settings, factors, and the refusals that are answers ─────────────────
  section('Sustainability settings and factor curation');

  const suPlatformFactor = await call('PATCH', `/v1/product-factors/${suFactor.json.productFactor.id}`, {
    ...suCtx, body: { kgCo2ePerItem: 68 },
  });
  eq('a company may refine its own product factor as better data arrives',
    suPlatformFactor.status, 200);
  check('...and is told that claims already made still cite what they used',
    String(suPlatformFactor.json.notice ?? '').includes('still cite the value they used'),
    suPlatformFactor.json.notice);

  const suDupFactor = await call('POST', '/v1/product-factors', {
    ...suCtx,
    body: {
      itemCategory: 'FURNITURE', assetTypeId: CHAIR, kgCo2ePerItem: 90,
      lifecycleBoundary: 'A1_A3', source: 'Another source', verificationStatus: 'EPD_VERIFIED',
    },
  });
  eq('a second EPD factor for the same item is refused — a duplicate can outrank itself',
    suDupFactor.status, 409);
  const suGenericFactor = await call('POST', '/v1/product-factors', {
    ...suCtx,
    body: {
      itemCategory: 'FURNITURE', assetTypeId: CHAIR, kgCo2ePerItem: 90,
      lifecycleBoundary: 'A1_A3', source: 'Sector average',
      verificationStatus: 'GENERIC_ESTIMATE',
    },
  });
  eq('...but a generic estimate for the same item is not, because the tier walk chooses',
    suGenericFactor.status, 201);
  eq('...and it is an estimate whatever the caller thinks',
    suGenericFactor.json.productFactor.isEstimate, true);

  const suResolve = await call('GET',
    `/v1/product-factors/resolve?assetTypeId=${CHAIR}&itemCategory=FURNITURE`, { ...suCtx });
  eq('the resolver walks §26.3’s tiers and prefers the verified EPD',
    [suResolve.json.resolution.kind, suResolve.json.resolution.tier], ['RESOLVED', 1]);

  const suDeleteCited = await call('DELETE', `/v1/factor-sets/${suSetId}`, { ...suCtx });
  eq('a cited factor set cannot be deleted', suDeleteCited.status, 409);
  check('...and the refusal points at deactivation, which is the operation that exists',
    String(suDeleteCited.json.error?.message ?? '').includes('Deactivate'),
    suDeleteCited.json.error);

  const suDeactivate = await call('PATCH', `/v1/factor-sets/${suSetId}`, {
    ...suCtx, body: { active: false },
  });
  eq('deactivating it is allowed', suDeactivate.status, 200);
  const suAfterDeactivate = await call('GET', `/v1/projects/${suProject}/carbon`, { ...suCtx });
  eq('...and changes no existing calculation',
    suAfterDeactivate.json.carbon.projectEmissionsKgCo2e,
    suFinal.json.carbon.projectEmissionsKgCo2e);

  await drainWorkers();
  const { rows: suDeactivateNote } = await db.query<{ title: string }>(
    `select title from notifications where kind = 'sustainability.factor_set_deactivated'
       and company_id = $1`, [suCompany]);
  check('...while warning the people who could have done it, naming the count',
    String(suDeactivateNote[0]?.title ?? '').includes('live calculation'), suDeactivateNote[0]);
  await call('PATCH', `/v1/factor-sets/${suSetId}`, { ...suCtx, body: { active: true } });

  const suEditYear = await call('PATCH', `/v1/factor-sets/${suSetId}`, {
    ...suCtx, body: { reportingYear: 2029 },
  });
  eq('a set’s selection keys cannot be edited — a correction is a new version',
    suEditYear.status, 422);

  const suBadUnit = await call('POST', '/v1/factor-sets/import', {
    ...suCtx,
    body: {
      format: 'CSV',
      content: 'Category,Activity,Unit,kg CO2e\nFuels,Petrol,gallons,2.3',
      mapping: { category: 'Category', activity: 'Activity', unit: 'Unit', kgCo2ePerUnit: 'kg CO2e' },
      set: { ...suSetBody, name: `Bad units ${RUN}`, version: 'v9' },
      dryRun: false,
    },
  });
  eq('an unrecognised unit is a terminal refusal, not a coercion', suBadUnit.status, 422);
  check('...naming the value and the units that are accepted',
    String(suBadUnit.json.error?.message ?? '').includes('gallons')
      && String(suBadUnit.json.error?.message ?? '').includes('tonne.km'),
    suBadUnit.json.error);

  const suNegative = await call('POST', '/v1/factor-sets/import', {
    ...suCtx,
    body: {
      format: 'CSV',
      content: 'Category,Activity,Unit,kg CO2e\nWaste,Reuse,tonne,-3\nWaste,Recycling,tonne,0',
      mapping: { category: 'Category', activity: 'Activity', unit: 'Unit', kgCo2ePerUnit: 'kg CO2e' },
      set: { ...suSetBody, name: `Negative ${RUN}`, version: 'v9' },
      dryRun: true,
    },
  });
  eq('a negative factor is refused', suNegative.json.diff.failures.length, 1);
  check('...and a zero is accepted, because a published set legitimately carries one',
    String(suNegative.json.diff.failures[0]?.message ?? '').includes('negative'),
    suNegative.json.diff.failures);

  // GPS: the Phase 7 question, closed by its own recommendation.
  const suGps = await call('GET', '/v1/sustainability-settings', { ...suCtx });
  eq('capture_gps_on_evidence ships false, and Phase 9 builds nothing that reads it',
    suGps.json.settings.captureGpsOnEvidence, false);
  eq('...and §29.3’s disclaimer is here for Phase 10 to render',
    String(suGps.json.settings.reportDisclaimer).includes('location-based'), true);
  check('...claiming no verification or certification anywhere in it',
    !/verified|certified|ISO/i.test(String(suGps.json.settings.reportDisclaimer)),
    suGps.json.settings.reportDisclaimer);


  // ── Reporting & sign-off (§29, §34, §38.2) ────────────────────────────────
  //
  // docs/operating-model/reporting-signoff.md §12, step for step. It runs on the
  // Phase 9 fixture — the Kingsway House project with its 933 kg of material, its
  // synthetic factor set and its avoided-emissions claim — because a report is a
  // rendering of records that already exist, and building a second fixture would
  // have proved the renderer against data the rest of the suite never checked.
  section('Reporting — the seal, the two audiences, and a document that stops moving');

  // The client is still a PLACEHOLDER at this point, which is deliberate: the
  // report generated below is addressed to it, and step 12 proves the claimant
  // still sees the document after signing up.
  const rpClientPlaceholder = suClientRes.json.client.clientCompanyId as string;
  await call('PATCH', `/v1/projects/${suProject}`, {
    ...suCtx,
    body: { clientVisible: true, startsOn: '2027-03-01', endsOn: '2027-03-31' },
  });

  // ── 1. Empty. Absent, not zero, on a page that leaves the building ───────
  const rpEmptyProject = (await call('POST', '/v1/projects', {
    ...suCtx,
    body: { name: `Nothing Recorded ${RUN}` },
  })).json.project.id as string;
  const rpEmptyReport = await call('POST', `/v1/projects/${rpEmptyProject}/reports`, {
    ...suCtx,
    body: { kind: 'SUSTAINABILITY', audience: 'INTERNAL' },
  });
  eq('a project with nothing recorded still produces a report', rpEmptyReport.status, 201);
  const rpEmptyDetail = await call('GET', `/v1/reports/${rpEmptyReport.json.report.id}`, { ...suCtx });
  eq('...whose headline figures are null rather than 0.00 tCO₂e',
    [rpEmptyDetail.json.snapshot.body.carbon.projectEmissionsKgCo2e,
     rpEmptyDetail.json.snapshot.body.carbon.avoidedKgCo2e],
    [null, null]);
  eq('...with no highlight tiles at all, because a tile is a claim',
    rpEmptyDetail.json.snapshot.body.highlights, []);

  // ── 2. Denied — plan ─────────────────────────────────────────────────────
  const rpStarter = await register('rpstarter', `StarterCo ${RUN}`);
  const rpStarterCo = rpStarter.companyId!;
  await subscribe(rpStarterCo, 'starter');
  const rpStarterCtx = { token: rpStarter.token, companyId: rpStarterCo };
  const rpStarterProject = (await call('POST', '/v1/projects', {
    ...rpStarterCtx, body: { name: `Starter Job ${RUN}` },
  })).json.project.id as string;
  const rpPlanRefusal = await call('POST', `/v1/projects/${rpStarterProject}/reports`, {
    ...rpStarterCtx, body: { kind: 'SUSTAINABILITY', audience: 'CLIENT' },
  });
  eq('a Starter plan cannot generate a sustainability report', rpPlanRefusal.status, 403);
  eq('...naming the key it needs', rpPlanRefusal.json.error?.details?.feature,
    'sustainability_reports');

  // §43's table puts reports at Pro; client_signoff is deliberately a tier lower,
  // because a sign-off is how a small contractor proves a job is finished.
  const rpStarterSignoff = await call('POST', `/v1/projects/${rpStarterProject}/signoffs`, {
    ...rpStarterCtx,
    body: {
      signerName: 'Ola Bright',
      completionStatement: 'The works are complete.',
      evidenceSnapshot: { capturedAt: '2027-04-01T10:00:00.000Z', items: [] },
    },
  });
  eq('...but the same plan CAN capture a client sign-off (stated departure from §43)',
    rpStarterSignoff.status, 201);

  // ── 3. Denied — capability ───────────────────────────────────────────────
  const rpSupInvite = await call('POST', '/v1/members/invite', {
    ...suCtx,
    body: { email: `rpsup+${RUN}@verify.crewquo.test`, role: 'MANAGER' },
  });
  const rpSup = await register('rpsup', undefined, `rpsup+${RUN}@verify.crewquo.test`);
  await call('POST', `/v1/invites/${rpSupInvite.json.inviteToken}/accept`, { token: rpSup.token });
  const { rows: rpSupMembership } = await db.query<{ id: string }>(
    `select id from memberships where user_id = $1 and company_id = $2`,
    [rpSup.userId, suCompany]);
  await call('PATCH', `/v1/members/${rpSupMembership[0]?.id}/capabilities`, {
    ...suCtx, body: { bundleKey: 'supervisor', overrides: [
      // The Supervisor bundle carries neither, and the report needs one of them.
      { capabilityKey: 'report.generate', granted: true },
      { capabilityKey: 'sustainability.read', granted: true },
    ] },
  });
  const rpSupCtx = { token: rpSup.token, companyId: suCompany };
  const rpSupReport = await call('POST', `/v1/projects/${suProject}/reports`, {
    ...rpSupCtx, body: { kind: 'SUSTAINABILITY', audience: 'INTERNAL' },
  });
  eq('a supervisor can produce a sustainability report — it holds no money',
    rpSupReport.status === 201 || rpSupReport.status === 200, true);
  const rpSupExport = await call('POST', `/v1/projects/${suProject}/reports`, {
    ...rpSupCtx, body: { kind: 'CLIENT_EXPORT', audience: 'CLIENT' },
  });
  eq('...and cannot produce the BILL-side statement', rpSupExport.status, 403);
  eq('...because commercial.read is what was carved out of their bundle',
    rpSupExport.json.error?.details?.capability, 'commercial.read');

  // ── 4. Generate ──────────────────────────────────────────────────────────
  const rpGen = await call('POST', `/v1/projects/${suProject}/reports`, {
    ...suCtx, body: { kind: 'SUSTAINABILITY', audience: 'CLIENT' },
  });
  eq('the client-facing sustainability report is generated', rpGen.status, 201);
  const rpReportId = rpGen.json.report.id as string;
  const rpDetail = await call('GET', `/v1/reports/${rpReportId}`, { ...suCtx });
  eq('...with §29.1’s twelve sections', rpDetail.json.report.sections.length, 12);
  eq('...the two headlines side by side and never netted',
    [typeof rpDetail.json.snapshot.body.carbon.projectEmissionsKgCo2e,
     typeof rpDetail.json.snapshot.body.carbon.avoidedKgCo2e],
    ['number', 'number']);
  check('...with no net figure anywhere in the sealed document (decision #17)',
    !JSON.stringify(rpDetail.json.snapshot).includes('"net'),
    Object.keys(rpDetail.json.snapshot.body.carbon));
  eq('...stating the Scope 2 basis in words rather than leaving it assumed',
    rpDetail.json.snapshot.body.carbon.scope2Basis, 'LOCATION_BASED');
  check('...and freezing §29.3’s disclaimer verbatim',
    String(rpDetail.json.report.disclaimer).includes('location-based'),
    rpDetail.json.report.disclaimer);

  // ── 5. The seal (packet finding 4) ───────────────────────────────────────
  const { rows: rpStored } = await db.query<{ snapshot: unknown; content_hash: string }>(
    `select snapshot, content_hash from generated_reports where id = $1`, [rpReportId]);
  eq('the content hash is the sha256 of the canonical form of what Postgres holds',
    createHash('sha256').update(canonicalJson(rpStored[0]?.snapshot)).digest('hex'),
    rpStored[0]?.content_hash);
  check('...which is NOT the hash of the stored jsonb text — that is finding 4',
    createHash('sha256').update(JSON.stringify(rpStored[0]?.snapshot)).digest('hex')
      !== rpStored[0]?.content_hash
    || canonicalJson(rpStored[0]?.snapshot) === JSON.stringify(rpStored[0]?.snapshot),
    'the two serialisations agree only by coincidence on this row');

  // ── 6. Byte-identity, immediately ────────────────────────────────────────
  const rpPdf1 = await call('GET', `/v1/reports/${rpReportId}/download.pdf`, { ...suCtx, raw: true });
  const rpPdf2 = await call('GET', `/v1/reports/${rpReportId}/download.pdf`, { ...suCtx, raw: true });
  eq('the report downloads as a PDF', rpPdf1.status, 200);
  check('...and two renders of one snapshot are byte-identical (the milestone)',
    rpPdf1.buffer!.equals(rpPdf2.buffer!),
    [rpPdf1.buffer!.byteLength, rpPdf2.buffer!.byteLength]);
  check('...with the seal in the PDF’s own /ID, so two printed copies can be compared',
    rpPdf1.buffer!.toString('latin1').includes(
      `/ID [ <${(rpStored[0]?.content_hash ?? '').slice(0, 32).toUpperCase()}>`),
    rpPdf1.buffer!.toString('latin1').match(/\/ID \[[^\]]*\]/)?.[0]);

  // ── 7. Byte-identity, after the world moves ──────────────────────────────
  const rpLiveBefore = await call('GET', `/v1/projects/${suProject}/carbon`, { ...suCtx });
  await call('PATCH', `/v1/assets/${suChairs}`, {
    ...suCtx,
    body: { weightBasis: 'UNIT', unitWeightKg: 18.5, weightSource: 'WEIGHBRIDGE' },
  });
  await call('POST', `/v1/projects/${suProject}/carbon/recalculate`, { ...suCtx });
  const rpLiveAfter = await call('GET', `/v1/projects/${suProject}/carbon`, { ...suCtx });
  check('correcting a weight moves the live figures',
    rpLiveAfter.json.carbon.projectEmissionsKgCo2e !==
      rpLiveBefore.json.carbon.projectEmissionsKgCo2e,
    [rpLiveBefore.json.carbon.projectEmissionsKgCo2e,
     rpLiveAfter.json.carbon.projectEmissionsKgCo2e]);

  const rpPdf3 = await call('GET', `/v1/reports/${rpReportId}/download.pdf`, { ...suCtx, raw: true });
  check('...and the generated report does not move with them — same bytes (§29.4)',
    rpPdf1.buffer!.equals(rpPdf3.buffer!), rpPdf3.buffer!.byteLength);
  const rpDetail2 = await call('GET', `/v1/reports/${rpReportId}/${''}`.replace(/\/$/, ''), { ...suCtx });
  eq('...and the same seal', rpDetail2.json.report.contentHash, rpStored[0]?.content_hash);

  // ── 8. The banner (project-evidence.md §13.6) ────────────────────────────
  // A past date: §23 refuses a diary day in the future, and the Phase 9 fixture's
  // 2027 movement dates are not the project's clock.
  const rpDiaryDate = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  const rpDiary = await call('POST', `/v1/projects/${suProject}/diary`, {
    ...suCtx, body: { entryDate: rpDiaryDate, workCompleted: 'Level 6 strip-out continued.' },
  });
  check('a diary day is recorded so the pack has something to cite',
    rpDiary.status === 201, rpDiary.json);
  const rpDiaryId = rpDiary.json.entry.id as string;
  const rpWithDiary = await call('POST', `/v1/projects/${suProject}/reports`, {
    ...suCtx, body: { kind: 'EVIDENCE_PACK', audience: 'INTERNAL' },
  });
  const rpPackId = rpWithDiary.json.report.id as string;
  const rpPackPdf1 = await call('GET', `/v1/reports/${rpPackId}/download.pdf`, { ...suCtx, raw: true });

  await call('POST', `/v1/diary/${rpDiaryId}/close`, { ...suCtx });
  await call('PATCH', `/v1/diary/${rpDiaryId}`, {
    ...suCtx,
    body: { delays: 'Lift out of service 11:00–13:00', reason: 'Reported the next morning' },
  });
  const rpPackAfter = await call('GET', `/v1/reports/${rpPackId}`, { ...suCtx });
  check('an amended diary day is reported against the document that cited it',
    (rpPackAfter.json.staleSources as any[]).some(
      (s) => s.kind === 'DIARY' && s.label === rpDiaryDate && s.currentRevision > s.revision),
    rpPackAfter.json.staleSources);
  check('...as a sentence saying a newer truth exists, not that the document is wrong',
    (rpPackAfter.json.staleNotes as string[]).some(
      (n) => n.includes('has been amended since this report was generated')),
    rpPackAfter.json.staleNotes);
  const rpPackPdf2 = await call('GET', `/v1/reports/${rpPackId}/download.pdf`, { ...suCtx, raw: true });
  check('...and the document itself still renders the numbers it froze',
    rpPackAfter.json.report.contentHash === rpWithDiary.json.report.contentHash,
    [rpWithDiary.json.report.contentHash, rpPackAfter.json.report.contentHash]);
  /*
   * THE FINDING THIS BUILD ADDED, and this assertion is the whole of it.
   *
   * The first implementation printed the staleness sentences on the cover, where a
   * reader would want them, and step 7 above failed: correcting a weight bumped an
   * asset revision and the banner appeared, so "the same report" rendered as two
   * different files. A live comparison inside a frozen document makes the document
   * a function of the present, which is what §29.4 forbids — and the seal in the
   * footer would have stopped describing what was on the page.
   *
   * The divergence belongs beside the document, where the person who can act on it
   * is looking. The file does not move.
   */
  check('...byte for byte, because the banner is reported beside the document and never in it',
    rpPackPdf1.buffer!.equals(rpPackPdf2.buffer!),
    [rpPackPdf1.buffer!.byteLength, rpPackPdf2.buffer!.byteLength]);

  // -- 9. Regenerate after a real change, then again with none -------------
  //
  // Step 7 corrected a weight, so the FIRST regeneration here legitimately produces
  // a new document. The second is the one finding 9 is about.
  const rpRegenNew = await call('POST', `/v1/projects/${suProject}/reports`, {
    ...suCtx, body: { kind: 'SUSTAINABILITY', audience: 'CLIENT' },
  });
  eq('a real change produces a new document', rpRegenNew.status, 201);
  eq('...superseding the one it replaces', rpRegenNew.json.supersededId, rpReportId);
  const rpCurrentId = rpRegenNew.json.report.id as string;
  const rpOld = await call('GET', `/v1/reports/${rpReportId}`, { ...suCtx });
  eq('...which is retained and still retrievable (§29.4)', rpOld.json.report.status, 'SUPERSEDED');
  eq('...pointing forward at its successor', rpOld.json.report.supersededById, rpCurrentId);
  const rpOldPdf = await call('GET', `/v1/reports/${rpReportId}/download.pdf`, { ...suCtx, raw: true });
  check('...and rendering exactly as it did before it was superseded',
    rpPdf1.buffer!.equals(rpOldPdf.buffer!), rpOldPdf.buffer!.byteLength);

  const { rows: rpCountBefore } = await db.query<{ n: string }>(
    `select count(*)::text as n from generated_reports where project_id = $1`, [suProject]);
  const rpRegenSame = await call('POST', `/v1/projects/${suProject}/reports`, {
    ...suCtx, body: { kind: 'SUSTAINABILITY', audience: 'CLIENT' },
  });
  eq('regenerating with nothing changed returns the document that exists', rpRegenSame.status, 200);
  eq('...saying so rather than pretending it made one', rpRegenSame.json.reused, true);
  eq('...the same row', rpRegenSame.json.report.id, rpCurrentId);
  const { rows: rpCountAfter } = await db.query<{ n: string }>(
    `select count(*)::text as n from generated_reports where project_id = $1`, [suProject]);
  eq('...and no second row', rpCountAfter[0]?.n, rpCountBefore[0]?.n);
  const { rows: rpNoSupersede } = await db.query<{ status: string }>(
    `select status from generated_reports where id = $1`, [rpCurrentId]);
  eq('...and nothing superseded, so SUPERSEDED still means a figure moved',
    rpNoSupersede[0]?.status, 'GENERATED');

  // ── 11. The boundary, asserted on the SNAPSHOT (packet finding 3) ────────
  const rpExport = await call('POST', `/v1/projects/${suProject}/reports`, {
    ...suCtx, body: { kind: 'CLIENT_EXPORT', audience: 'CLIENT' },
  });
  eq('the BILL-side client statement is generated', rpExport.status, 201);
  const { rows: rpExportRow } = await db.query<{ snapshot: Record<string, unknown> }>(
    `select snapshot from generated_reports where id = $1`, [rpExport.json.report.id]);
  const rpExportJson = JSON.stringify(rpExportRow[0]?.snapshot ?? {});
  check('no PAY figure anywhere in the stored document',
    !/payCents|laborCostCents|resolvedRate/i.test(rpExportJson), rpExportJson.slice(0, 200));
  check('...no margin', !/margin/i.test(rpExportJson), 'margin');
  check('...and no provider identity', !/provider/i.test(rpExportJson), 'provider');

  const rpClientSust = await call('GET', `/v1/reports/${rpCurrentId}`, { ...suCtx });
  eq('the client sustainability report counts the subcontracted organisations',
    typeof rpClientSust.json.snapshot.body.overview.workforce.subcontractedOrganisations,
    'number');
  check('...and has no field a provider name could occupy',
    !('subcontractors' in rpClientSust.json.snapshot.body.overview.workforce),
    Object.keys(rpClientSust.json.snapshot.body.overview.workforce));

  const rpInternal = await call('POST', `/v1/projects/${suProject}/reports`, {
    ...suCtx, body: { kind: 'SUSTAINABILITY', audience: 'INTERNAL' },
  });
  const rpInternalDetail = await call('GET', `/v1/reports/${rpInternal.json.report.id}`, { ...suCtx });
  check('...while the internal copy of the same project does name them',
    Array.isArray(rpInternalDetail.json.snapshot.body.overview.workforce.subcontractors),
    rpInternalDetail.json.snapshot.body.overview.workforce);

  const rpDiscloseInternal = await call('PATCH',
    `/v1/reports/${rpInternal.json.report.id}/visibility`,
    { ...suCtx, body: { clientVisible: true } });
  eq('an internal document cannot be shared with the client at all',
    rpDiscloseInternal.status, 422);
  const { rows: rpDbRefusal } = await db.query<{ ok: boolean }>(
    `select true as ok from generated_reports where id = $1 and not client_visible`,
    [rpInternal.json.report.id]);
  eq('...and the database refuses the combination even if a route forgets',
    rpDbRefusal.length, 1);

  // ── 12. Disclosure, and the claimant who signed up afterwards ────────────
  //
  // The invitee already owns a real company, which is what makes this the
  // AUTO-MERGE path: the placeholder is claimed and left behind as a tombstone
  // pointing at the real company, so the report generated above now names a
  // company id that is nobody's tenant.
  const rpClientUser = await register('rpclient', `Kingsway Group ${RUN}`,
    `kingsway+${RUN}@verify.crewquo.test`);
  await call('POST', `/v1/invites/${suClientRes.json.inviteToken}/accept`, {
    token: rpClientUser.token,
  });
  const rpClientCompany = rpClientUser.companyId!;
  const rpClientCtx = { token: rpClientUser.token, companyId: rpClientCompany };
  const { rows: rpTombstone } = await db.query<{ claimed_by_company_id: string | null }>(
    `select claimed_by_company_id from companies where id = $1`, [rpClientPlaceholder]);
  eq('the placeholder the report was addressed to is now a tombstone',
    rpTombstone[0]?.claimed_by_company_id, rpClientCompany);

  const rpDisclose = await call('PATCH', `/v1/reports/${rpCurrentId}/visibility`, {
    ...suCtx, body: { clientVisible: true },
  });
  eq('the client copy can be shared', rpDisclose.status, 200);

  const rpPortalList = await call('GET', `/v1/portal/projects/${suProject}/reports`, rpClientCtx);
  eq('the client sees it in their portal', rpPortalList.status, 200);
  check('...even though it was addressed to the placeholder they later claimed',
    (rpPortalList.json.reports as any[]).some((r) => r.id === rpCurrentId),
    (rpPortalList.json.reports as any[]).map((r) => r.id));
  const { rows: rpAddressedTo } = await db.query<{ client_company_id: string }>(
    `select client_company_id from generated_reports where id = $1`, [rpCurrentId]);
  eq('...and the row genuinely names the placeholder rather than their new company',
    rpAddressedTo[0]?.client_company_id, rpClientPlaceholder);

  const rpClientPdf = await call('GET', `/v1/portal/reports/${rpCurrentId}/download.pdf`,
    { ...rpClientCtx, raw: true });
  eq('...and downloads their own copy', rpClientPdf.status, 200);
  check('...byte-identical to the owner’s rendering of the same document',
    rpClientPdf.buffer!.equals(
      (await call('GET', `/v1/reports/${rpCurrentId}/download.pdf`, { ...suCtx, raw: true })).buffer!),
    rpClientPdf.buffer!.byteLength);

  const rpUndisclosed = await call('GET', `/v1/portal/reports/${rpExport.json.report.id}/download.pdf`,
    { ...rpClientCtx, raw: true });
  eq('a document that was never shared is not readable, even by its own client',
    rpUndisclosed.status, 404);

  // ── 13. Denied — the other client ────────────────────────────────────────
  const rpOtherClient = await register('rpother', `Rival Estates ${RUN}`);
  const rpOtherRes = await call('GET', `/v1/portal/reports/${rpCurrentId}/download.pdf`, {
    token: rpOtherClient.token, companyId: rpOtherClient.companyId!, raw: true,
  });
  eq('another company gets the same 404 a nonexistent id gets', rpOtherRes.status, 404);

  // ── 14. The forbidden claim (§29.3, packet finding 7) ────────────────────
  const rpClaim = await call('PATCH', '/v1/sustainability-settings', {
    ...suCtx,
    body: {
      reportDisclaimer:
        'These results have been independently verified and certified to ISO 14064-1.',
    },
  });
  eq('a disclaimer claiming independent verification is refused on save', rpClaim.status, 422);
  check('...naming the phrase so the customer can find it',
    String(rpClaim.json.error?.message ?? '').toLowerCase().includes('independently verified'),
    rpClaim.json.error?.message);

  const rpHonest = await call('PATCH', '/v1/sustainability-settings', {
    ...suCtx,
    body: {
      reportDisclaimer:
        'Figures are drawn from site records. This report has not been independently verified.',
    },
  });
  eq('...while an explicit denial of assurance is accepted, which is the sentence §29.3 wants',
    rpHonest.status, 200);

  // Forced past the API, the way a restored backup or an operator would.
  await db.query(
    `update sustainability_settings set report_disclaimer = $2 where company_id = $1`,
    [suCompany, 'Third-party assured under a limited assurance engagement.']);
  const rpClaimAtGen = await call('POST', `/v1/projects/${suProject}/reports`, {
    ...suCtx, body: { kind: 'EVIDENCE_PACK', audience: 'CLIENT' },
  });
  eq('...and the same claim is refused again at generation, where it would be published',
    rpClaimAtGen.status, 422);
  await db.query(
    `update sustainability_settings set report_disclaimer = $2 where company_id = $1`,
    [suCompany, 'Figures are drawn from site records recorded on this project.']);

  // ── 15. Sign-off, captured offline ───────────────────────────────────────
  section('Client sign-off — the device’s snapshot, the replay, and the row nobody may edit');

  const rpSignClientId = randomUUID();
  const rpSignBody = {
    clientId: rpSignClientId,
    signerName: 'Dana Whitfield',
    signerCompany: `Kingsway Estates ${RUN}`,
    signerRole: 'Facilities Manager',
    signerEmail: `dana+${RUN}@verify.crewquo.test`,
    completionStatement: 'The works described are complete to our satisfaction.',
    evidenceSnapshot: {
      capturedAt: '2027-03-31T16:40:00.000Z',
      massHandledKg: 933,
      photographs: 4,
      statement: 'Level 6 cleared and handed back.',
    },
  };
  const rpSign = await call('POST', `/v1/projects/${suProject}/signoffs`, {
    ...suCtx, body: rpSignBody,
  });
  eq('a signature is captured', rpSign.status, 201);
  const rpSignId = rpSign.json.signoff.id as string;
  check('...sealed over what the DEVICE said was being signed for',
    rpSign.json.signoff.contentHash ===
      createHash('sha256').update(canonicalJson(rpSignBody.evidenceSnapshot)).digest('hex'),
    rpSign.json.signoff.contentHash);
  const { rows: rpSignRow } = await db.query<{ signed_at: Date; signed_ip: string | null }>(
    `select signed_at, signed_ip::text from client_signoffs where id = $1`, [rpSignId]);
  check('...timed by the server rather than by the tablet',
    Math.abs(Date.now() - new Date(rpSignRow[0]!.signed_at).getTime()) < 120_000,
    rpSignRow[0]?.signed_at);

  const rpReplay = await call('POST', `/v1/projects/${suProject}/signoffs`, {
    ...suCtx, body: rpSignBody,
  });
  eq('a replayed capture returns the signature that exists', rpReplay.status, 200);
  eq('...the same row', rpReplay.json.signoff.id, rpSignId);
  const { rows: rpSignCount } = await db.query<{ n: string }>(
    `select count(*)::text as n from client_signoffs where project_id = $1 and phase is null`,
    [suProject]);
  eq('...and there is exactly one signature for one act', rpSignCount[0]?.n, '1');

  // ── 16. The correction path ──────────────────────────────────────────────
  const rpSignAgain = await call('POST', `/v1/projects/${suProject}/signoffs`, {
    ...suCtx,
    body: {
      ...rpSignBody,
      clientId: randomUUID(),
      signerName: 'Dana Whitfield-Rowe',
      supersedesId: rpSignId,
      supersedeReason: 'Signer name corrected at the client’s request',
    },
  });
  eq('a correction is a new signature, not an edit', rpSignAgain.status, 201);
  const rpSignList = await call('GET', `/v1/projects/${suProject}/signoffs`, { ...suCtx });
  eq('...and both rows stand', (rpSignList.json.signoffs as any[]).length, 2);
  eq('...with the current one derived from the chain rather than flagged',
    (rpSignList.json.current as any[]).map((s) => s.id), [rpSignAgain.json.signoff.id]);
  eq('...the superseded one pointing forward',
    (rpSignList.json.signoffs as any[]).find((s) => s.id === rpSignId)?.supersededById,
    rpSignAgain.json.signoff.id);
  eq('...and the reason recorded', rpSignAgain.json.signoff.supersedeReason,
    'Signer name corrected at the client’s request');

  const rpNoReason = await call('POST', `/v1/projects/${suProject}/signoffs`, {
    ...suCtx, body: { ...rpSignBody, clientId: randomUUID(), supersedesId: rpSignId },
  });
  eq('superseding without saying why is refused', rpNoReason.status, 422);

  // ── 17. Append-only, at the database ─────────────────────────────────────
  const rpUpdateAttempt = await db
    .query(`update client_signoffs set signer_name = 'Someone Else' where id = $1`, [rpSignId])
    .then(() => 'allowed')
    .catch((e: Error) => e.message);
  check('the database refuses an UPDATE on a sign-off, whatever the API does',
    String(rpUpdateAttempt).includes('cannot be edited'), rpUpdateAttempt);
  const rpDeleteAttempt = await db
    .query(`delete from client_signoffs where id = $1`, [rpSignId])
    .then(() => 'allowed')
    .catch((e: Error) => e.message);
  check('...and a DELETE', String(rpDeleteAttempt).includes('cannot be deleted'), rpDeleteAttempt);

  // ── 18. The delete that must not succeed (packet finding 5) ──────────────
  const rpDelete = await call('DELETE', `/v1/projects/${suProject}`, { ...suCtx });
  eq('a project carrying frozen documents cannot be deleted', rpDelete.status, 409);
  check('...naming what stands in the way rather than failing on a foreign key',
    String(rpDelete.json.error?.message ?? '').includes('client sign-off'),
    rpDelete.json.error?.message);
  const { rows: rpStillThere } = await db.query<{ n: string }>(
    `select count(*)::text as n from client_signoffs where project_id = $1`, [suProject]);
  eq('...and the signature is still there', rpStillThere[0]?.n, '2');

  // The empty project has one report and nothing else, and it is refused too: a
  // report is a permanent record whether or not anybody has read it.
  const rpDeleteEmpty = await call('DELETE', `/v1/projects/${rpEmptyProject}`, { ...suCtx });
  eq('...and a project whose only frozen document is one unread report is refused as firmly',
    rpDeleteEmpty.status, 409);

  // ── 19. The period roll-up (§38.2, packet finding 8) ─────────────────────
  section('Client-level aggregation — the identities a total covers, and mixed factor years');

  const rpPeriod = await call('POST', '/v1/reports/client-period', {
    ...suCtx,
    body: {
      audience: 'CLIENT',
      clientCompanyId: rpClientCompany,
      periodStart: '2027-01-01',
      periodEnd: '2027-12-31',
    },
  });
  eq('a client period report is generated', rpPeriod.status, 201);
  const rpPeriodDetail = await call('GET', `/v1/reports/${rpPeriod.json.report.id}`, { ...suCtx });
  const rpPeriodBody = rpPeriodDetail.json.snapshot.body;
  check('...counting the projects run for that client',
    rpPeriodBody.projectCount >= 1, rpPeriodBody.projectCount);
  check('...and naming every legal identity the total covers, placeholder included',
    (rpPeriodBody.client.identities as any[]).length >= 2,
    (rpPeriodBody.client.identities as any[]).map((i) => `${i.name}${i.placeholder ? ' (ph)' : ''}`));
  check('...summing §28.2’s definitions rather than re-deriving them',
    typeof rpPeriodBody.totalMassKg === 'number' && rpPeriodBody.totalMassKg > 0,
    rpPeriodBody.totalMassKg);
  eq('...and disclosing whether the period spans more than one factor year',
    typeof rpPeriodBody.mixedFactorYears, 'boolean');

  const rpPeriodStarter = await call('POST', '/v1/reports/client-period', {
    ...rpStarterCtx,
    body: {
      audience: 'CLIENT', clientCompanyId: rpClientCompany,
      periodStart: '2027-01-01', periodEnd: '2027-12-31',
    },
  });
  eq('client reporting is checked against the GENERATING company, not a project owner',
    rpPeriodStarter.status, 403);
  eq('...naming the key', rpPeriodStarter.json.error?.details?.feature, 'client_reporting');

  // ── 20. Mixed factor years ───────────────────────────────────────────────
  const rpSecondSet = await call('POST', '/v1/factor-sets/import', {
    ...suCtx,
    body: {
      format: 'CSV', content: suCsv, mapping: suMapping,
      set: { ...suSetBody, name: `CrewQuo Test Factors 2028 ${RUN}`, reportingYear: 2028,
             version: 'v2.0', validFrom: '2028-01-01' },
      dryRun: false,
    },
  });
  eq('a second factor set for a later year imports', rpSecondSet.status, 201);

  // ── The trail, the hold, and the notices ─────────────────────────────────
  await drainWorkers();

  const { rows: rpAudit } = await db.query<{ action: string; visible_to_client: boolean }>(
    `select action, visible_to_client from audit_logs
      where company_id = $1 and action like 'report.%' or action = 'signoff.captured'
      order by created_at`, [suCompany]);
  const rpActions = rpAudit.map((r) => r.action);
  check('generating, sharing and signing are each their own audited act',
    ['report.generated', 'report.disclosed', 'signoff.captured'].every((a) => rpActions.includes(a)),
    [...new Set(rpActions)]);
  check('...and the sign-off is the one the client can see, because they signed it',
    rpAudit.some((r) => r.action === 'signoff.captured' && r.visible_to_client),
    rpAudit.filter((r) => r.action === 'signoff.captured'));

  const { rows: rpDisclosedNote } = await db.query<{ title: string }>(
    `select n.title from notifications n
      where n.kind = 'report.disclosed' and n.subject_id = $1`, [rpCurrentId]);
  check('the client is told a document is waiting for them', rpDisclosedNote.length > 0,
    rpDisclosedNote);
  const { rows: rpGenNote } = await db.query<{ n: string }>(
    `select count(*)::text as n from notifications where kind = 'report.disclosed'
      and recipient_user_id = $1`, [suOwner.userId]);
  eq('...and the person who generated it is not told about their own click',
    rpGenNote[0]?.n, '0');

  const { rows: rpHeld } = await db.query<{ role: string }>(
    `select x.role from report_file_references x where x.signoff_id in
       (select id from client_signoffs where project_id = $1)
      union all
     select x.role from report_file_references x where x.report_id = $2`,
    [suProject, rpCurrentId]);
  check('every file a frozen document points at is held by a real row, not by a jsonb string',
    rpHeld.length > 0, rpHeld.map((r) => r.role));

  // ══ PHASE 11 — COMMERCIAL & OPERATIONS ════════════════════════════════════
  //
  // `docs/operating-model/commercial-operations.md` §12, implemented step for
  // step. Ade's contractor company is `meridian` (Pro), on the Pier 9 project the
  // core-loop section built: a client, a subcontractor, PAY and BILL cards, one
  // approved 8h log and one approved expense. That fixture is exactly what §30.2
  // needs, and reusing it is also the point — the figures below have to agree with
  // the ones asserted 11,000 lines earlier.

  section('Variations — priced off the engine, agreed once, and billed once');

  const coCtx = { token: owner.token, companyId: meridian };
  const coProviderCtx = { token: providerUser.token, companyId: northgate };

  // ── 1. The empty project ─────────────────────────────────────────────────
  const coEmptyProject = (await call('POST', '/v1/projects', {
    ...coCtx, body: { name: `Nothing Agreed ${RUN}` },
  })).json.project.id as string;

  const coEmptyVariations = await call('GET', `/v1/projects/${coEmptyProject}/variations`, { ...coCtx });
  eq('a project with no variations answers with an empty list', coEmptyVariations.status, 200);
  eq('...rather than a 404', coEmptyVariations.json.variations, []);

  const coEmptyBudget = await call('GET', `/v1/projects/${coEmptyProject}/budget`, { ...coCtx });
  eq('a project with no budget still answers', coEmptyBudget.status, 200);
  eq('...saying so rather than pretending to one', coEmptyBudget.json.budget.budgetSet, false);
  eq('...with all ten of §30.2 present', coEmptyBudget.json.budget.rows.length, 10);

  /*
   * THE ASSERTION THE WHOLE BUDGET MODULE EXISTS FOR (packet finding 2).
   *
   * Six of §30.2's ten categories have no source of money anywhere in the schema —
   * asset movements and activities carry mass, distance, fuel and energy and not one
   * money column between them. A literal implementation renders "Vehicles · Budget
   * £3,000 · Actual £0 · Variance −£3,000 / −100%", which is an absence with a
   * percentage attached on a screen a contractor reads before a client meeting.
   */
  const coEmptyRows = coEmptyBudget.json.budget.rows as any[];
  const coNoSource = coEmptyRows.filter((r) => r.coverage === 'NO_SOURCE');
  eq('exactly six categories declare that CrewQuo holds no source for them',
    coNoSource.map((r) => r.key).sort(),
    ['materials', 'mileage', 'other', 'purchases', 'vehicle', 'waste']);
  check('...every one of them reports null rather than zero',
    coNoSource.every((r) => r.actualCents === null && r.varianceCents === null),
    coNoSource.map((r) => [r.key, r.actualCents, r.varianceCents]));
  check('...and NOTHING anywhere in the response is -100',
    !JSON.stringify(coEmptyBudget.json).includes('-100'));
  check('...each saying what would have to exist for the figure to be real',
    coNoSource.every((r) => typeof r.sources === 'string' && r.sources.length > 30));
  const coEmptyRevenue = coEmptyRows.find((r) => r.key === 'revenue');
  eq('a project with no work has no revenue figure, rather than a revenue of nothing',
    coEmptyRevenue?.actualCents, null);

  const coEmptySchedule = await call('GET', `/v1/projects/${coEmptyProject}/schedule`, { ...coCtx });
  eq('an unscheduled project answers with no assignments and no shortfalls',
    [coEmptySchedule.json.assignments, coEmptySchedule.json.shortfalls], [[], []]);

  /*
   * A BASELINE, read before anything Phase 11 writes.
   *
   * The obvious thing is to assert the core-loop constants — 41550 of cost, 65550
   * of bill — and it is wrong, which cost one run to discover: eight sections
   * between there and here add work to this same project, so those figures are true
   * at line 700 and not at line 12,300. A shared fixture read 11,000 lines later has
   * to be asserted as a **delta**, and the delta is the thing under test anyway:
   * what Phase 11 changed, not what Phase 3 left behind.
   */
  const coBase = (await call('GET', `/v1/projects/${projectId}/summary`, { ...coCtx }))
    .json.summary as {
      totalCostCents: number; billCents: number; laborCostCents: number;
      expenseCostCents: number; variationSellCents: number; approvedVariations: number;
    };

  // ── 2. Denied four ways ──────────────────────────────────────────────────
  //
  // Each refusal names a different thing, which is the point of the four checks
  // being independent.

  // (a) The plan. Crew has neither key — §43's table, and the shape of the free tier.
  const coCrew = await register('cocrew', `CrewOnly ${RUN}`);
  const coCrewCtx = { token: coCrew.token, companyId: coCrew.companyId! };
  const coCrewProject = (await call('POST', '/v1/projects', {
    ...coCrewCtx, body: { name: `Crew Own Job ${RUN}` },
  })).json.project.id as string;
  const coPlanRefusal = await call('POST', `/v1/projects/${coCrewProject}/variations`, {
    ...coCrewCtx, body: { description: 'Extra doors', requestedOn: '2026-07-22' },
  });
  eq('a Crew-plan company cannot raise a variation on its OWN project', coPlanRefusal.status, 403);
  eq('...naming the key', coPlanRefusal.json.error?.details?.feature, 'variations');

  /*
   * And the other half of the 2026-09-01 rule, for the fifth time: the SAME free
   * company MAY raise one on a paying customer's project, because the feature is the
   * project owner's. Femi with a phone and a free account, capturing the extra doors
   * on the day the client asked for them, is the whole point of the free tier.
   */
  const coSubVariation = await call('POST', `/v1/projects/${projectId}/variations`, {
    ...coProviderCtx,
    body: {
      description: 'Two extra risers on level 3, asked for on site',
      requestedOn: '2026-07-22',
      requestedBy: 'Dana Whitfield',
      lines: [{
        kind: 'LABOUR', description: 'Rigger, 16h', quantity: 16,
        roleId, shiftType: 'WEEKDAY_DAY',
      }],
    },
  });
  eq('...but the same free company CAN raise one on a Pro customer’s project',
    coSubVariation.status, 201);
  const coSubVarId = coSubVariation.json.variation.id as string;
  eq('...priced off the hiring company’s PAY card for THAT subcontractor',
    coSubVariation.json.variation.lines[0]?.unitCostCents, 5000);
  eq('...and its BILL card for the client', coSubVariation.json.variation.lines[0]?.unitSellCents, 8000);
  eq('...with the source of the price on the row',
    coSubVariation.json.variation.lines[0]?.pricedFrom, 'RATE_ENGINE');
  eq('...and the line total is quantity × unit, computed once',
    [coSubVariation.json.variation.lines[0]?.costCents,
     coSubVariation.json.variation.lines[0]?.sellCents],
    [80000, 128000]);
  eq('...the header totals equal the sum of the lines',
    [coSubVariation.json.variation.sellTotalCents, coSubVariation.json.variation.costTotalCents],
    [128000, 80000]);

  // (b) The capability — create without approve.
  const coSupInvite = await call('POST', '/v1/members/invite', {
    ...coCtx, body: { email: `cosup+${RUN}@verify.crewquo.test`, role: 'MANAGER' },
  });
  const coSup = await register('cosup', undefined, `cosup+${RUN}@verify.crewquo.test`);
  await call('POST', `/v1/invites/${coSupInvite.json.inviteToken}/accept`, { token: coSup.token });
  const { rows: coSupMembership } = await db.query<{ id: string }>(
    `select id from memberships where user_id = $1 and company_id = $2`, [coSup.userId, meridian]);
  await call('PATCH', `/v1/members/${coSupMembership[0]?.id}/capabilities`, {
    ...coCtx, body: { bundleKey: 'supervisor' },
  });
  const coSupCtx = { token: coSup.token, companyId: meridian };

  const coSupRaises = await call('POST', `/v1/projects/${projectId}/variations`, {
    ...coSupCtx,
    body: {
      description: 'Make good the ceiling grid', requestedOn: '2026-07-23',
      lines: [{ kind: 'MATERIAL', description: 'Grid tiles', quantity: 40,
                unitCostCents: 450, unitSellCents: 700 }],
    },
  });
  eq('a supervisor holds variation.create and may raise one', coSupRaises.status, 201);
  const coSupVarId = coSupRaises.json.variation.id as string;
  await call('POST', `/v1/variations/${coSupVarId}/submit`, { ...coSupCtx });
  const coSupApproves = await call('POST', `/v1/variations/${coSupVarId}/approve`, { ...coSupCtx });
  eq('...and may NOT approve it — the person who captures the price is not the person who agrees to charge it',
    coSupApproves.status, 403);
  eq('...naming the capability', coSupApproves.json.error?.details?.capability, 'variation.approve');

  // (c) The capability that proves the whole §37 layer earns its existence.
  const coSupBudget = await call('GET', `/v1/projects/${projectId}/budget`, { ...coSupCtx });
  eq('a supervisor cannot read the budget, because a budget is margin by subtraction',
    coSupBudget.status, 403);
  eq('...naming commercial.read', coSupBudget.json.error?.details?.capability, 'commercial.read');
  const coSupSchedule = await call('GET', `/v1/projects/${projectId}/schedule`, { ...coSupCtx });
  eq('...and CAN read the schedule, which is the distinction the layer exists for',
    coSupSchedule.status, 200);

  // (d) The company edge — a subcontractor cannot decide the owner's variation.
  const coSubDecides = await call('POST', `/v1/variations/${coSupVarId}/approve`, { ...coProviderCtx });
  eq('a subcontractor cannot even see the owner’s variation, let alone decide it',
    coSubDecides.status, 404);

  // ── 3. Raise, price, submit ──────────────────────────────────────────────
  const coVar = await call('POST', `/v1/projects/${projectId}/variations`, {
    ...coCtx,
    body: {
      reference: 'VO-014',
      description: 'Additional fire-rated doors to core, agreed on site',
      reason: 'Client changed the fire strategy after the survey',
      requestedBy: 'Dana Whitfield',
      requestedOn: '2026-07-24',
      lines: [
        { kind: 'LABOUR', description: 'Rigger, 16h', quantity: 16, roleId, shiftType: 'WEEKDAY_DAY' },
        { kind: 'MATERIAL', description: 'Fire door sets', quantity: 4,
          unitCostCents: 24000, unitSellCents: 31000 },
      ],
    },
  });
  eq('the owner raises a two-line variation', coVar.status, 201);
  const coVarId = coVar.json.variation.id as string;
  const coVarLines = coVar.json.variation.lines as any[];

  /*
   * The LABOUR line has no default (uncounterpartied) PAY card in this fixture — the
   * MON_FRI_DAY PAY card is scoped to Northgate — so the owner's own variation is
   * PARTIAL on the cost side, with the sentence saying why. That is the withholding
   * rule, and it is the honest answer: at quote time nobody knows which crew will do
   * the extra works, and borrowing one subcontractor's rate would produce a cost that
   * changes when the crew does.
   */
  const coLabourLine = coVarLines.find((l) => l.kind === 'LABOUR');
  eq('the owner’s own LABOUR line resolves BILL from the client card', coLabourLine?.unitSellCents, 8000);
  eq('...and is PARTIAL rather than zero-costed, because only a per-subcontractor PAY card exists',
    coLabourLine?.pricedFrom, 'PARTIAL');
  check('...with a notice naming what to do about it',
    (coVar.json.notices as string[]).some((n) => n.includes('PAY')),
    coVar.json.notices);
  const coMaterialLine = coVarLines.find((l) => l.kind === 'MATERIAL');
  eq('the stated MATERIAL line is taken as stated', coMaterialLine?.pricedFrom, 'STATED');
  eq('...at 4 × 31000', coMaterialLine?.sellCents, 124000);
  eq('the header is the sum of the lines and nothing else',
    coVar.json.variation.sellTotalCents, 128000 + 124000);

  const { rows: coHeaderParity } = await db.query<{ ok: boolean }>(
    `select (v.sell_total_cents = coalesce(sum(l.sell_cents), 0)
             and v.cost_total_cents = coalesce(sum(l.cost_cents), 0)) as ok
       from variations v left join variation_lines l on l.variation_id = v.id
      where v.id = $1 group by v.id, v.sell_total_cents, v.cost_total_cents`, [coVarId]);
  check('header = Σ lines, asserted against the database (packet finding 5)',
    coHeaderParity[0]?.ok === true, coHeaderParity);

  const coSubmit = await call('POST', `/v1/variations/${coVarId}/submit`, { ...coCtx });
  eq('it submits', coSubmit.json.variation.status, 'SUBMITTED');

  // ── 4. The rejection, and the resubmit ───────────────────────────────────
  const coRejectNoReason = await call('POST', `/v1/variations/${coVarId}/reject`, { ...coCtx, body: {} });
  eq('a rejection with no reason is refused', coRejectNoReason.status, 422);
  const coReject = await call('POST', `/v1/variations/${coVarId}/reject`, {
    ...coCtx, body: { reason: 'Client wants the ironmongery priced separately' },
  });
  eq('a rejection with a reason lands', coReject.json.variation.status, 'REJECTED');
  eq('...carrying the reason', coReject.json.variation.rejectReason,
    'Client wants the ironmongery priced separately');

  const coRepriced = await call('PATCH', `/v1/variations/${coVarId}`, {
    ...coCtx,
    body: {
      lines: [
        { kind: 'LABOUR', description: 'Rigger, 16h', quantity: 16, roleId, shiftType: 'WEEKDAY_DAY' },
        { kind: 'MATERIAL', description: 'Fire door sets, leaves only', quantity: 4,
          unitCostCents: 19000, unitSellCents: 26000 },
      ],
    },
  });
  eq('a rejected variation is editable again', coRepriced.status, 200);
  eq('...and the header follows the lines down', coRepriced.json.variation.sellTotalCents,
    128000 + 104000);

  const { rows: coRevisions } = await db.query<{ changed_fields: string[]; action: string }>(
    `select changed_fields, action from record_revisions
      where entity_type = 'variation' and entity_id = $1 order by revision`, [coVarId]);
  check('§36’s trail starts at creation rather than at the first edit',
    coRevisions[0]?.action === 'CREATE', coRevisions.map((r) => r.action));
  check('...and names the price that moved, computed from before/after rather than declared',
    coRevisions.some((r) => r.changed_fields?.includes('sellTotalCents')
                         && r.changed_fields?.includes('lines')),
    coRevisions.map((r) => r.changed_fields));

  const coResubmit = await call('POST', `/v1/variations/${coVarId}/submit`, { ...coCtx });
  eq('it resubmits', coResubmit.json.variation.status, 'SUBMITTED');
  eq('...and the rejection reason is cleared rather than left standing',
    coResubmit.json.variation.rejectReason, null);

  // ── 5. Approve without the client's evidence, then with it ───────────────
  const coApprove = await call('POST', `/v1/variations/${coVarId}/approve`, { ...coCtx, body: {} });
  eq('approval with no client evidence is PERMITTED — the crew works on Wednesday',
    coApprove.json.variation.status, 'APPROVED');
  eq('...and is never silent about it', coApprove.json.variation.clientApprovalRecorded, false);

  const coClientApproval = await call('POST', `/v1/variations/${coVarId}/client-approval`, {
    ...coCtx, body: { clientApprovedBy: 'Dana Whitfield' },
  });
  eq('recording the client’s agreement later flips the flag',
    coClientApproval.json.variation.clientApprovalRecorded, true);
  check('...and dates it, because a name with no date cannot be placed in the sequence',
    coClientApproval.json.variation.clientApprovedAt !== null);

  // ── 6. The summary, and the asymmetry ────────────────────────────────────
  const coSummary = await call('GET', `/v1/projects/${projectId}/summary`, { ...coCtx });
  const cs = coSummary.json.summary;
  eq('the approved variation reaches the summary', cs.approvedVariations, 1);
  eq('...at its sell total', cs.variationSellCents, 128000 + 104000);
  eq('...with its cost reported beside, not inside', cs.variationCostCents, 76000);
  /*
   * THE ASYMMETRY (packet finding 3). The hours worked on extra works are approved
   * time logs like any other and are already in laborCostCents; a variation's cost
   * total is what the contractor EXPECTED the works to cost when it quoted them.
   * Adding it would count the same labour twice and deflate margin, which is the one
   * direction of error nobody catches because it is pessimistic.
   */
  eq('the cost total is UNCHANGED by the variation', cs.totalCostCents, coBase.totalCostCents);
  eq('...and revenue is the bill total plus the variation sell',
    cs.revenueCents, coBase.billCents + 232000);
  eq('...with margin recomputed over revenue',
    cs.marginCents, coBase.billCents + 232000 - coBase.totalCostCents);

  const coExport = await call('GET', `/v1/projects/${projectId}/export.xlsx`, { ...coCtx, raw: true });
  eq('the export still renders with variations on the project', coExport.status, 200);

  const coPortal = await call('GET', `/v1/portal/projects/${projectId}`, {
    token: clientUser.token, companyId: harbour,
  });
  const coPortalPayload = JSON.stringify(coPortal.json);
  check('the client portal still carries no PAY figure', !coPortalPayload.includes('40000'));
  check('...and no variation COST figure', !coPortalPayload.includes('76000'));

  // ── 7. The edit that must be refused ─────────────────────────────────────
  const coEditApproved = await call('PATCH', `/v1/variations/${coVarId}`, {
    ...coCtx, body: { description: 'Quietly bigger' },
  });
  eq('an approved variation cannot be edited', coEditApproved.status, 409);
  check('...and the refusal says to raise a new one',
    String(coEditApproved.json.error?.message).includes('new variation'),
    coEditApproved.json.error?.message);

  const coForceTotal = await call('PATCH', `/v1/variations/${coSubVarId}`, {
    ...coProviderCtx, body: { sellTotalCents: 999999, description: 'Still sixteen hours' },
  });
  eq('a caller-supplied header total is ignored rather than honoured', coForceTotal.status, 200);
  eq('...the total still follows the lines', coForceTotal.json.variation.sellTotalCents, 128000);

  // ── 8. Budget versus actual, including the approved variation ────────────
  const coBudgetSet = await call('PUT', `/v1/projects/${projectId}/budget`, {
    ...coCtx,
    body: {
      /*
       * Deliberately chosen so revenue is over and the two cost lines are under —
       * the two readings §40 asks a colour to communicate, in one response.
       */
      revenueCents: 300000, labourCents: 35000,
      subcontractorCents: coBase.laborCostCents + 20000,
      expensesCents: coBase.expenseCostCents + 500, vehicleCents: 300000,
      notes: 'First cut, before the fire-strategy change.',
    },
  });
  eq('the budget is set', coBudgetSet.status, 200);
  const coRows = Object.fromEntries(
    (coBudgetSet.json.budget.rows as any[]).map((r) => [r.key, r])
  );
  eq('revenue’s actual INCLUDES the approved variation', coRows.revenue?.actualCents,
    coBase.billCents + 232000);
  eq('...and reads as favourable, because revenue is the one line that does',
    coRows.revenue?.reading, 'FAVOURABLE');
  /*
   * The split §30.2's two separate labour categories can be given from data this
   * schema holds: a log recorded by the project owner is its own crew, and every
   * other approved log on the project is somebody it hired. Both read the frozen PAY
   * snapshot, so a rate card changed next year cannot restate what a job cost.
   *
   * On this fixture every log belongs to Northgate, which is what makes the
   * assertion worth making: `labour` is genuinely zero and `subcontractor` carries
   * the whole PAY total, and the two summing to it is the property.
   */
  eq('labour is the owner’s own approved logs, which is none of them here',
    coRows.labour?.actualCents, 0);
  eq('subcontractor labour is every other company’s, from the frozen PAY snapshots',
    coRows.subcontractor?.actualCents, coBase.laborCostCents);
  eq('...and the two categories sum to the project’s labour cost',
    (coRows.labour?.actualCents ?? 0) + (coRows.subcontractor?.actualCents ?? 0),
    coBase.laborCostCents);
  eq('expenses pass through at cost', coRows.expenses?.actualCents, coBase.expenseCostCents);
  eq('...and an under-spend on a cost line reads as favourable', coRows.expenses?.reading,
    'FAVOURABLE');
  eq('a budgeted category with no source stays null, at any budget',
    [coRows.vehicle?.budgetCents, coRows.vehicle?.actualCents, coRows.vehicle?.variancePct],
    [300000, null, null]);
  check('...naming what would have to exist', String(coRows.vehicle?.sources).includes('expense'));
  check('the untracked share is reported, so the gap is measurable rather than assumed',
    (coBudgetSet.json.budget.untrackedShare as number) > 0,
    coBudgetSet.json.budget.untrackedShare);

  const coBreakdown = coBudgetSet.json.budget.expenseBreakdown as any[];
  eq('the expense breakdown sums to the expenses actual',
    coBreakdown.reduce((sum, r) => sum + r.actualCents, 0), 1550);
  check('...grouped by the category somebody actually typed',
    coBreakdown.some((r) => r.category === 'TRAVEL'), coBreakdown);

  // ── 9. Invoice it once ───────────────────────────────────────────────────
  const coInvoice = await call('POST', '/v1/invoices', {
    ...coCtx, body: { projectId, includeApprovedWork: true },
  });
  eq('an invoice is created from approved work', coInvoice.status, 201);
  const coInvoiceId = coInvoice.json.invoice.id as string;
  const coVarItems = (coInvoice.json.invoice.items as any[]).filter(
    (i) => i.sourceType === 'VARIATION'
  );
  eq('it carries exactly one variation line', coVarItems.length, 1);
  eq('...at the sell total the client agreed', coVarItems[0]?.amountCents, 232000);
  check('...naming the reference, which is how a client looks it up',
    String(coVarItems[0]?.description).includes('VO-014'), coVarItems[0]?.description);

  const coVarAfterInvoice = await call('GET', `/v1/variations/${coVarId}`, { ...coCtx });
  eq('the variation is now INVOICED', coVarAfterInvoice.json.variation.status, 'INVOICED');
  eq('...pointing at the invoice that claimed it', coVarAfterInvoice.json.variation.invoiceId,
    coInvoiceId);

  const coSecondInvoice = await call('POST', '/v1/invoices', {
    ...coCtx, body: { projectId, includeApprovedWork: true },
  });
  const coSecondVarItems = ((coSecondInvoice.json.invoice?.items as any[]) ?? []).filter(
    (i) => i.sourceType === 'VARIATION'
  );
  eq('a SECOND invoice on the same project gets no variation line at all',
    coSecondVarItems.length, 0);
  await call('DELETE', `/v1/invoices/${coSecondInvoice.json.invoice.id}`, { ...coCtx });

  /*
   * THE PURCHASE-ORDER CEILING APPLIES TO A VARIATION EXACTLY AS IT DOES TO WORK,
   * and this fixture proves it by accident, which is the best kind of proof.
   *
   * The commercial-agreements section left Harbour Group's engagement with a $1,000
   * ceiling, and this invoice is $2,640 — mostly the variation. The refusal is
   * correct product behaviour and worth pinning rather than stepping around: §30.1
   * feeds approved variations into the same invoice as approved work, so a client's
   * PO governs both or the ceiling is decoration.
   */
  const coCeiling = await call('POST', `/v1/invoices/${coInvoiceId}/issue`, { ...coCtx });
  eq('a variation cannot be issued past the client’s purchase-order ceiling',
    coCeiling.status, 422);
  check('...naming the ceiling and what is already committed against it',
    String(coCeiling.json.error?.message).includes('purchase-order ceiling'),
    coCeiling.json.error?.message);

  const coRaised = await call('PATCH', `/v1/engagements/${clientRes.json.client.engagementId}/terms`, {
    token: clientUser.token, companyId: harbour,
    body: { purchaseOrderCeilingCents: 5000000, reason: 'PO varied for the fire-strategy change' },
  });
  eq('the hiring client raises the ceiling', coRaised.status, 200);

  const coIssue = await call('POST', `/v1/invoices/${coInvoiceId}/issue`, { ...coCtx });
  eq('...and the invoice issues', coIssue.status, 200);
  const coVoid = await call('POST', `/v1/invoices/${coInvoiceId}/void`, { ...coCtx });
  eq('the invoice is voided', coVoid.json.invoice?.status, 'VOID');
  const coVarAfterVoid = await call('GET', `/v1/variations/${coVarId}`, { ...coCtx });
  eq('...and the variation becomes eligible again — §3.5’s rule with a new noun',
    coVarAfterVoid.json.variation.status, 'APPROVED');
  eq('...with the invoice reference cleared', coVarAfterVoid.json.variation.invoiceId, null);

  section('Scheduling — the week, the clash that warns, and the requirement nobody filled');

  // ── 10. A week's crew, with the clash surfaced ───────────────────────────
  const coVan = await call('POST', '/v1/vehicles', {
    ...coCtx,
    body: { name: 'Transit 350', registration: 'LX21 ABC', category: 'Van (class III)',
            fuelType: 'DIESEL', emissionFactorActivity: 'van_class_iii_diesel' },
  });
  eq('a vehicle is added to the fleet', coVan.status, 201);
  const coVanId = coVan.json.vehicle.id as string;

  const coDupReg = await call('POST', '/v1/vehicles', {
    ...coCtx, body: { name: 'Second Transit', registration: 'lx21 abc' },
  });
  check('the same registration in different case is refused as the same van',
    coDupReg.status >= 400, coDupReg.status);

  const coBatchId = randomUUID();
  const coBatchBody = {
    batchClientId: coBatchId,
    assignments: [
      { resourceType: 'USER', userId: coSup.userId, roleId, shiftType: 'WEEKDAY_DAY',
        isSupervisor: true, startsAt: '2026-07-21T07:00:00.000Z',
        endsAt: '2026-07-21T17:00:00.000Z' },
      { resourceType: 'VEHICLE', vehicleId: coVanId,
        startsAt: '2026-07-21T07:00:00.000Z', endsAt: '2026-07-21T17:00:00.000Z' },
      { resourceType: 'PROVIDER', providerCompanyId: northgate, roleId, headcount: 3,
        startsAt: '2026-07-21T07:00:00.000Z', endsAt: '2026-07-21T17:00:00.000Z' },
    ],
  };
  const coBatch = await call('POST', `/v1/projects/${projectId}/schedule`, {
    ...coCtx, body: coBatchBody,
  });
  eq('a whole planning act is one request', coBatch.status, 201);
  eq('...writing three rows', (coBatch.json.assignments as any[]).length, 3);
  eq('...with no clashes yet', coBatch.json.warnings, []);
  const coUserAssignment = (coBatch.json.assignments as any[]).find((a) => a.resourceType === 'USER');
  eq('the planned cost resolves through the rate engine when a shift type is set',
    coUserAssignment?.plannedSellCents, 80000);

  const coReplay = await call('POST', `/v1/projects/${projectId}/schedule`, {
    ...coCtx, body: coBatchBody,
  });
  eq('replaying the batch returns the first answer rather than a second copy',
    coReplay.status, 201);
  const { rows: coBatchRows } = await db.query<{ n: string }>(
    `select count(*)::int as n from schedule_assignments where batch_client_id = $1`, [coBatchId]);
  eq('...and there are still three rows', coBatchRows[0]?.n, 3);

  /*
   * The clash. §31: "surfaced at save time with the clash named" — so the save
   * SUCCEEDS and the warning comes back beside the row. Refusing would be wrong on
   * the facts: sometimes the double-booking is the plan, because the other job
   * finishes at noon and the schedule does not know that.
   */
  const coSecondProject = (await call('POST', '/v1/projects', {
    ...coCtx, body: { name: `Marina Bay ${RUN}`, clientCompanyId: harbour,
                      engagementId: clientRes.json.client.engagementId },
  })).json.project.id as string;
  /*
   * The subcontractor is assigned to this one as well, because a PROVIDER schedule
   * row is refused unless the company is on the project — the one-hop rule checked
   * rather than assumed (packet §4). The first draft omitted it and the headcount
   * case failed with an undefined `warnings`, which is a 422 wearing a disguise.
   */
  await call('POST', `/v1/projects/${coSecondProject}/assignments`, {
    ...coCtx, body: { providerCompanyId: northgate },
  });
  const coClash = await call('POST', `/v1/projects/${coSecondProject}/schedule`, {
    ...coCtx,
    body: {
      assignments: [
        { resourceType: 'USER', userId: coSup.userId, roleId, shiftType: 'WEEKDAY_DAY',
          startsAt: '2026-07-21T09:00:00.000Z', endsAt: '2026-07-21T14:00:00.000Z' },
        { resourceType: 'VEHICLE', vehicleId: coVanId,
          startsAt: '2026-07-21T09:00:00.000Z', endsAt: '2026-07-21T14:00:00.000Z' },
      ],
    },
  });
  eq('a double-booking SAVES rather than being refused', coClash.status, 201);
  const coClashCodes = (coClash.json.warnings as any[])
    .flatMap((w) => (w.conflicts as any[]).map((c) => c.code)).sort();
  eq('...and both clashes are named', coClashCodes, ['USER_OVERLAP', 'VEHICLE_OVERLAP']);
  check('...naming the other project, so somebody can go and look',
    String((coClash.json.warnings as any[])[0].conflicts[0].message).includes('Pier 9'),
    (coClash.json.warnings as any[])[0].conflicts[0].message);

  // A back-to-back handover is not a clash: the intervals are half-open, and warning
  // on every ordinary day-then-night shift is how a warning channel gets ignored.
  const coHandover = await call('POST', `/v1/projects/${projectId}/schedule`, {
    ...coCtx,
    body: {
      assignments: [{ resourceType: 'USER', userId: coSup.userId, roleId, shiftType: 'NIGHT',
        startsAt: '2026-07-21T17:00:00.000Z', endsAt: '2026-07-22T03:00:00.000Z' }],
    },
  });
  eq('a shift starting when another ends warns about nothing', coHandover.json.warnings, []);

  /*
   * And a CANCELLED row conflicts with nothing.
   *
   * On a day of its own, which the first draft of this case got wrong: cancelling
   * one of two overlapping rows and re-booking still clashes with the *other* one,
   * so the assertion failed on a warning that was entirely correct. The window has
   * to be one where the cancelled row is the only thing there.
   */
  const coDoomed = await call('POST', `/v1/projects/${coSecondProject}/schedule`, {
    ...coCtx,
    body: {
      assignments: [{ resourceType: 'USER', userId: coSup.userId, roleId, shiftType: 'WEEKDAY_DAY',
        startsAt: '2026-08-10T07:00:00.000Z', endsAt: '2026-08-10T17:00:00.000Z' }],
    },
  });
  const coCancelId = (coDoomed.json.assignments as any[])[0].id as string;
  const coCancelled = await call('PATCH', `/v1/schedule/${coCancelId}`, {
    ...coCtx, body: { status: 'CANCELLED' },
  });
  eq('an assignment is cancelled rather than deleted',
    (coCancelled.json.assignments as any[])[0].status, 'CANCELLED');
  const coAfterCancel = await call('POST', `/v1/projects/${projectId}/schedule`, {
    ...coCtx,
    body: {
      assignments: [{ resourceType: 'USER', userId: coSup.userId, roleId, shiftType: 'WEEKDAY_DAY',
        startsAt: '2026-08-10T09:00:00.000Z', endsAt: '2026-08-10T12:00:00.000Z' }],
    },
  });
  const coAfterCancelCodes = (coAfterCancel.json.warnings as any[])
    .flatMap((w) => (w.conflicts as any[]).map((c) => c.code));
  check('a cancelled booking clashes with nothing', !coAfterCancelCodes.includes('USER_OVERLAP'),
    coAfterCancelCodes);
  const { rows: coCancelledStill } = await db.query<{ status: string }>(
    `select status from schedule_assignments where id = $1`, [coCancelId]);
  eq('...and is still on the record, which is why cancel is a status and not a delete',
    coCancelledStill[0]?.status, 'CANCELLED');

  // ── 11. Availability, headcount and the unfilled requirement ─────────────
  const coUnavailable = await call('POST', '/v1/availability', {
    ...coCtx,
    body: { resourceType: 'USER', userId: coSup.userId, kind: 'UNAVAILABLE',
            startsAt: '2026-07-22T00:00:00.000Z', endsAt: '2026-07-23T00:00:00.000Z',
            note: 'Leave' },
  });
  eq('an unavailability window is recorded', coUnavailable.status, 201);
  const coOnLeave = await call('POST', `/v1/projects/${projectId}/schedule`, {
    ...coCtx,
    body: {
      assignments: [{ resourceType: 'USER', userId: coSup.userId, roleId, shiftType: 'WEEKDAY_DAY',
        startsAt: '2026-07-22T07:00:00.000Z', endsAt: '2026-07-22T17:00:00.000Z' }],
    },
  });
  const coLeaveCodes = (coOnLeave.json.warnings as any[])
    .flatMap((w) => (w.conflicts as any[]).map((c) => c.code));
  check('booking somebody on leave warns rather than refuses',
    coLeaveCodes.includes('UNAVAILABLE_WINDOW'), coLeaveCodes);

  // The subcontractor states its own crew count — the one narrow cross-company read.
  const coStated = await call('POST', '/v1/availability', {
    ...coProviderCtx,
    body: { resourceType: 'PROVIDER', providerCompanyId: northgate, kind: 'AVAILABLE',
            headcount: 4, startsAt: '2026-07-01T00:00:00.000Z',
            endsAt: '2026-08-01T00:00:00.000Z' },
  });
  eq('a subcontractor states its own crew count', coStated.status, 201);
  const coStatesForOther = await call('POST', '/v1/availability', {
    ...coCtx,
    body: { resourceType: 'PROVIDER', providerCompanyId: northgate, kind: 'AVAILABLE',
            headcount: 40, startsAt: '2026-07-01T00:00:00.000Z',
            endsAt: '2026-08-01T00:00:00.000Z' },
  });
  eq('...and the hiring company cannot state one on their behalf', coStatesForOther.status, 403);

  const coUnderCount = await call('POST', `/v1/projects/${coSecondProject}/schedule`, {
    ...coCtx,
    body: {
      assignments: [{ resourceType: 'PROVIDER', providerCompanyId: northgate, roleId, headcount: 1,
        startsAt: '2026-07-28T07:00:00.000Z', endsAt: '2026-07-28T17:00:00.000Z' }],
    },
  });
  eq('booking within the stated crew warns about nothing', coUnderCount.json.warnings, []);
  const coOverCount = await call('POST', `/v1/projects/${projectId}/schedule`, {
    ...coCtx,
    body: {
      assignments: [{ resourceType: 'PROVIDER', providerCompanyId: northgate, roleId, headcount: 6,
        startsAt: '2026-07-28T07:00:00.000Z', endsAt: '2026-07-28T17:00:00.000Z' }],
    },
  });
  const coCountWarning = (coOverCount.json.warnings as any[])
    .flatMap((w) => w.conflicts as any[]).find((c) => c.code === 'PROVIDER_HEADCOUNT');
  check('overlapping PROVIDER rows warn only when the headcount exceeds the stated crew',
    coCountWarning !== undefined, coOverCount.json.warnings);
  check('...naming both numbers', String(coCountWarning?.message).includes('4 crew'),
    coCountWarning?.message);

  const coRequirements = await call('PUT', `/v1/projects/${projectId}/role-requirements`, {
    ...coCtx,
    body: { requirements: [{ roleId, quantity: 6, startsOn: '2026-07-21', endsOn: '2026-07-21' }] },
  });
  eq('a project role requirement is set', coRequirements.status, 200);
  const coShortfall = (coRequirements.json.shortfalls as any[])[0];
  check('...and the shortfall counts a PROVIDER row by its headcount',
    coShortfall !== undefined && coShortfall.filled >= 4 && coShortfall.short >= 1,
    coRequirements.json.shortfalls);

  const coRequirementsMet = await call('PUT', `/v1/projects/${projectId}/role-requirements`, {
    ...coCtx,
    body: { requirements: [{ roleId, quantity: 2, startsOn: '2026-07-21', endsOn: '2026-07-21' }] },
  });
  eq('a requirement that is met produces no row at all', coRequirementsMet.json.shortfalls, []);

  const coWeek = await call('GET', '/v1/schedule?view=WEEK&date=2026-07-21', { ...coCtx });
  eq('the company-wide week answers', coWeek.status, 200);
  eq('...snapped to a Monday start', coWeek.json.window.fromDate, '2026-07-20');
  check('...carrying rows from more than one project',
    new Set((coWeek.json.assignments as any[]).map((a) => a.projectId)).size >= 2);

  // A subcontractor sees only rows naming it — a schedule row names a person, a van
  // and a registration, which is the shape of another business's operations.
  const coSubReadsSchedule = await call('GET', `/v1/projects/${projectId}/schedule`, {
    ...coProviderCtx,
  });
  eq('a subcontractor can read the schedule', coSubReadsSchedule.status, 200);
  const coSubSeen = coSubReadsSchedule.json.assignments as any[];
  check('...and sees only rows naming it or its people',
    coSubSeen.every((a) => a.providerCompanyId === northgate),
    coSubSeen.map((a) => a.resourceType));
  check('...with no planned money on any of them, because that is the owner’s margin',
    coSubSeen.every((a) => a.plannedSellCents === null && a.plannedCostCents === null));

  // ── 12. The two places §31 says the schedule must reach ──────────────────
  const coPrefill = await call(
    'GET', `/v1/projects/${projectId}/diary/prefill?date=2026-07-21`, { ...coCtx });
  eq('the diary prefill now reads the schedule as well as the timesheets',
    coPrefill.json.sources, { timeLogs: true, schedule: true });
  const coScheduleSuggestions = (coPrefill.json.attendance as any[])
    .filter((a) => a.source === 'SCHEDULE');
  check('...offering a scheduled person who has recorded nothing',
    coScheduleSuggestions.length > 0, coPrefill.json.attendance);
  check('...with no hours, because a booking is a plan and hours are what a timesheet says',
    coScheduleSuggestions.every((a) => a.hours === null));

  const coNoShift = await call('POST', `/v1/projects/${projectId}/schedule`, {
    ...coCtx,
    body: {
      assignments: [{ resourceType: 'USER', userId: coSup.userId, roleId,
        startsAt: '2026-07-30T07:00:00.000Z', endsAt: '2026-07-30T17:00:00.000Z' }],
    },
  });
  const coNoShiftRow = (coNoShift.json.assignments as any[])[0];
  eq('an assignment with no shift type has NO planned figure rather than a zero',
    [coNoShiftRow.plannedCostCents, coNoShiftRow.plannedSellCents], [null, null]);
  check('...and says why, rather than leaving a blank cell',
    String(coNoShiftRow.plannedReason).includes('shift type'), coNoShiftRow.plannedReason);

  section('Project timeline — the chronology, the two audiences, and the kind nobody has');

  // ── 13. The timeline reads like a story ──────────────────────────────────
  const coTimeline = await call('GET', `/v1/projects/${projectId}/timeline?limit=100`, { ...coCtx });
  eq('the timeline answers', coTimeline.status, 200);
  const coTypes = new Set((coTimeline.json.items as any[]).map((i) => i.type));
  for (const type of ['PROJECT_CREATED', 'CREW_ASSIGNED', 'SCHEDULE_ASSIGNED', 'TIME_LOGGED',
                      'WORK_APPROVED', 'EXPENSE_APPROVED', 'VARIATION_RAISED',
                      'VARIATION_DECIDED']) {
    check(`...carrying ${type}`, coTypes.has(type), [...coTypes]);
  }
  const coTimes = (coTimeline.json.items as any[]).map((i) => i.at);
  check('...in event-time order, newest first',
    coTimes.every((t, i) => i === 0 || (coTimes[i - 1] as string) >= (t as string)));
  check('...each item carrying a one-line description and a link',
    (coTimeline.json.items as any[]).every((i) => typeof i.description === 'string'
      && i.description.length > 0 && typeof i.href === 'string'));

  const coFiltered = await call(
    'GET', `/v1/projects/${projectId}/timeline?types=VARIATION_RAISED`, { ...coCtx });
  check('a type filter returns only that type',
    (coFiltered.json.items as any[]).every((i) => i.type === 'VARIATION_RAISED'),
    (coFiltered.json.items as any[]).map((i) => i.type));

  const coPage1 = await call('GET', `/v1/projects/${projectId}/timeline?limit=3`, { ...coCtx });
  eq('the page is the size that was asked for', (coPage1.json.items as any[]).length, 3);
  check('...with a cursor when there is more', coPage1.json.nextCursor !== null);
  const coPage2 = await call(
    'GET',
    `/v1/projects/${projectId}/timeline?limit=3&cursor=${encodeURIComponent(String(coPage1.json.nextCursor))}`,
    { ...coCtx });
  const coPage1Ids = new Set((coPage1.json.items as any[]).map((i) => i.id));
  check('...and the next page repeats nothing',
    (coPage2.json.items as any[]).every((i) => !coPage1Ids.has(i.id)));

  const coBadCursor = await call(
    'GET', `/v1/projects/${projectId}/timeline?cursor=nonsense`, { ...coCtx });
  eq('a cursor this endpoint never issued is refused rather than guessed at',
    coBadCursor.status, 422);

  /*
   * §35 names thirteen kinds of thing and INCIDENT has no table anywhere in the
   * plan's DDL. Reported rather than silently omitted, because the next reader of
   * §35 will come looking for exactly this.
   */
  const coSources = coTimeline.json.sources as any[];
  const coIncident = coSources.find((s) => s.type === 'INCIDENT');
  eq('INCIDENT is reported as having no table, rather than silently omitted',
    [coIncident?.included, coIncident?.reason], [false, 'NO_TABLE']);

  /*
   * The client variant is a PORTAL route, not a parameter on the owner's one.
   * `projectAccess` 404s a client — correctly, because a client is not on
   * `project_assignments` — which is the reason the portal has its own access check
   * at all. The first draft asked the owner's route and got a 404 that was the
   * product being right.
   */
  const coOwnerRouteForClient = await call(
    'GET', `/v1/projects/${projectId}/timeline`,
    { token: clientUser.token, companyId: harbour });
  eq('a client asking the owner’s timeline route is not found', coOwnerRouteForClient.status, 404);

  const coClientTimeline = await call(
    'GET', `/v1/portal/projects/${projectId}/timeline?limit=100`,
    { token: clientUser.token, companyId: harbour });
  eq('the client reads it through the portal instead',
    coClientTimeline.status, 200);
  const coClientTypes = new Set((coClientTimeline.json.items as any[]).map((i) => i.type));
  for (const forbidden of ['SCHEDULE_ASSIGNED', 'TIME_LOGGED', 'EXPENSE_APPROVED',
                           'VARIATION_RAISED']) {
    check(`...and never sees ${forbidden}`, !coClientTypes.has(forbidden), [...coClientTypes]);
  }
  check('...but does see the variation DECISION, which is money they agreed to pay',
    coClientTypes.has('VARIATION_DECIDED'), [...coClientTypes]);
  const coClientPayload = JSON.stringify(coClientTimeline.json);
  check('...and the whole payload carries no PAY figure', !coClientPayload.includes('40000'));

  const coPortalVariations = await call(
    'GET', `/v1/portal/projects/${projectId}/variations`,
    { token: clientUser.token, companyId: harbour });
  eq('the client sees the variations they agreed to', coPortalVariations.status, 200);
  const coPortalVars = coPortalVariations.json.variations as any[];
  check('...APPROVED and later only',
    coPortalVars.length > 0
      && coPortalVars.every((v) => ['APPROVED', 'COMPLETED', 'INVOICED'].includes(v.status)),
    coPortalVars.map((v) => v.status));
  check('...at the sell figure, with NO field a cost could occupy',
    coPortalVars.every((v) => typeof v.sellTotalCents === 'number'
      && !('costTotalCents' in v) && !('marginPct' in v) && !('lines' in v)),
    Object.keys(coPortalVars[0] ?? {}));
  check('...and nothing the contractor is still thinking about',
    !JSON.stringify(coPortalVars).includes('DRAFT')
      && !JSON.stringify(coPortalVars).includes('REJECTED'));

  // ── 14. The correction path ──────────────────────────────────────────────
  const coBeforeCorrection = (await call('GET', `/v1/projects/${projectId}/summary`, { ...coCtx }))
    .json.summary.variationSellCents as number;
  const coSecondVar = await call('POST', `/v1/projects/${projectId}/variations`, {
    ...coCtx,
    body: {
      reference: 'VO-015', description: 'Supersedes VO-014 ironmongery',
      requestedOn: '2026-07-26',
      lines: [{ kind: 'MATERIAL', description: 'Ironmongery sets', quantity: 4,
                unitCostCents: 5000, unitSellCents: 7000 }],
    },
  });
  eq('a correction is a NEW variation, which is the only path there is',
    coSecondVar.status, 201);
  const coSecondVarId = coSecondVar.json.variation.id as string;
  await call('POST', `/v1/variations/${coSecondVarId}/submit`, { ...coCtx });
  await call('POST', `/v1/variations/${coSecondVarId}/approve`, { ...coCtx });
  const coAfterCorrection = await call('GET', `/v1/projects/${projectId}/summary`, { ...coCtx });
  eq('...and both stand, with the revenue the sum of the two',
    coAfterCorrection.json.summary.variationSellCents, coBeforeCorrection + 28000);
  eq('...counted as two approved variations', coAfterCorrection.json.summary.approvedVariations, 2);

  // §30.1's later states still count as approved: marking the works complete must not
  // make a project's revenue fall.
  await call('POST', `/v1/variations/${coSecondVarId}/complete`, { ...coCtx });
  const coAfterComplete = await call('GET', `/v1/projects/${projectId}/summary`, { ...coCtx });
  eq('marking the works complete does not reduce the project’s revenue',
    coAfterComplete.json.summary.variationSellCents,
    coAfterCorrection.json.summary.variationSellCents);

  // ── 15. Delete refusals ──────────────────────────────────────────────────
  const coProjectDelete = await call('DELETE', `/v1/projects/${projectId}`, { ...coCtx });
  eq('the project refuses to be deleted', coProjectDelete.status, 409);
  check('...naming the variations alongside whatever else stands in the way',
    String(coProjectDelete.json.error?.message).includes('variation'),
    coProjectDelete.json.error?.message);

  const coVehicleDelete = await call('DELETE', `/v1/vehicles/${coVanId}`, { ...coCtx });
  eq('a vehicle with bookings refuses to be deleted', coVehicleDelete.status, 409);
  check('...offering Retire instead, and naming the count',
    String(coVehicleDelete.json.error?.message).includes('Retire')
      && String(coVehicleDelete.json.error?.message).includes('schedule assignment'),
    coVehicleDelete.json.error?.message);
  const coRetire = await call('PATCH', `/v1/vehicles/${coVanId}`, {
    ...coCtx, body: { active: false },
  });
  eq('...and retiring works', coRetire.json.vehicle.active, false);

  const coLocation = await call('POST', `/v1/projects/${projectId}/locations`, {
    ...coCtx, body: { name: 'Level 3 core', kind: 'SITE_AREA' },
  });
  eq('a location is created for the schedule to point at', coLocation.status, 201);
  const coLocationId = coLocation.json.location.id as string;
  await call('POST', `/v1/projects/${projectId}/schedule`, {
    ...coCtx,
    body: {
      assignments: [{ resourceType: 'USER', userId: coSup.userId, roleId, shiftType: 'WEEKDAY_DAY',
        locationId: coLocationId, startsAt: '2026-08-03T07:00:00.000Z',
        endsAt: '2026-08-03T17:00:00.000Z' }],
    },
  });
  const coLocationDelete = await call('DELETE', `/v1/locations/${coLocationId}`, { ...coCtx });
  eq('a location used by a scheduled crew refuses to be deleted', coLocationDelete.status, 409);
  check('...with the registry’s sentence, naming what is using it',
    String(coLocationDelete.json.error?.message).includes('scheduled crew'),
    coLocationDelete.json.error?.message);

  // ── The trail, the notices, and the invariants that had to be right ─────
  await drainWorkers();

  const { rows: coAudit } = await db.query<{ action: string; visible_to_client: boolean }>(
    `select action, visible_to_client from audit_logs
      where company_id in ($1, $2)
        and (action like 'variation.%' or action like 'schedule.%'
          or action like 'vehicle.%' or action like 'budget.%')
      order by created_at`, [meridian, northgate]);
  const coActions = coAudit.map((r) => r.action);
  for (const action of ['variation.created', 'variation.submitted', 'variation.rejected',
                        'variation.approved', 'variation.client_approval_recorded',
                        'budget.set', 'vehicle.created', 'schedule.assigned']) {
    check(`${action} is its own audited act`, coActions.includes(action), [...new Set(coActions)]);
  }
  check('an approved variation is visible in the client’s trail',
    coAudit.some((r) => r.action === 'variation.approved' && r.visible_to_client));
  check('...and a rejection is not — a client seeing a variation their contractor refused ' +
        'internally is a conversation the product should not start',
    coAudit.filter((r) => r.action === 'variation.rejected').every((r) => !r.visible_to_client));

  const { rows: coNotice } = await db.query<{ title: string }>(
    `select title from notifications where kind = 'variation.submitted' and subject_id = $1`,
    [coVarId]);
  check('the approver is told a variation is waiting for a decision', coNotice.length > 0, coNotice);

  const { rows: coLineIdentity } = await db.query<{ n: string }>(
    `select count(*)::int as n from variation_lines
      where cost_cents <> round(quantity * unit_cost_cents)
         or sell_cents <> round(quantity * unit_sell_cents)`);
  eq('no variation line in the database disagrees with its own arithmetic',
    coLineIdentity[0]?.n, 0);

  const { rows: coHeaderDrift } = await db.query<{ n: string }>(
    `select count(*)::int as n from (
       select v.id from variations v
         left join variation_lines l on l.variation_id = v.id
        group by v.id, v.sell_total_cents, v.cost_total_cents
       having v.sell_total_cents <> coalesce(sum(l.sell_cents), 0)
           or v.cost_total_cents <> coalesce(sum(l.cost_cents), 0)) drift`);
  eq('and no variation header in the database disagrees with its lines',
    coHeaderDrift[0]?.n, 0);

  const { rows: coBudgetCurrency } = await db.query<{ n: string }>(
    `select count(*)::int as n from information_schema.columns
      where table_name = 'project_budgets' and column_name = 'currency'`);
  eq('project_budgets has no currency column — 0017’s reasoning, held (finding 1)',
    coBudgetCurrency[0]?.n, 0);

  const { rows: coVehicleColumn } = await db.query<{ n: string }>(
    `select count(*)::int as n from information_schema.columns
      where table_name = 'project_activities' and column_name = 'vehicle_id'`);
  eq('project_activities.vehicle_id exists, now that it has a reader (finding 8)',
    coVehicleColumn[0]?.n, 1);

  /*
   * ── PHASE 10'S HOOK, PAID ────────────────────────────────────────────────
   *
   * `reporting-signoff.md` finding 11 gave `PACK_VARIATIONS` an `availableFrom` of
   * 11 so that a completion pack could not assert *no variations* about a feature
   * that did not exist. Moving `CURRENT_BUILD_PHASE` from 10 to 11 was the whole of
   * the edit: no change to the catalog, and every report generated before it keeps
   * its own stored `sections` array.
   *
   * The pack is generated on the project that now has two approved variations, so
   * this asserts the section is offered, chosen and populated — three different
   * things, and the middle one is what a phase gate actually controls.
   */
  const coSections = await call('GET', `/v1/projects/${projectId}/reports/sections`, { ...coCtx });
  const coPackKinds = (coSections.json.kinds as any[]).find((k) => k.kind === 'EVIDENCE_PACK');
  check('the evidence pack now offers §29.2’s variations section',
    (coPackKinds?.sections as any[]).some((s) => s.key === 'PACK_VARIATIONS'),
    (coPackKinds?.sections as any[])?.map((s) => s.key));
  check('...and defaults it on', (coPackKinds?.defaults as string[]).includes('PACK_VARIATIONS'),
    coPackKinds?.defaults);
  check('...while incidents stay absent, because no table for them exists anywhere',
    !(coPackKinds?.sections as any[]).some((s) => s.key === 'PACK_INCIDENTS'));

  const coPack = await call('POST', `/v1/projects/${projectId}/reports`, {
    ...coCtx, body: { kind: 'EVIDENCE_PACK', audience: 'INTERNAL' },
  });
  eq('an evidence pack is generated', coPack.status, 201);
  const coPackDetail = await call('GET', `/v1/reports/${coPack.json.report.id}`, { ...coCtx });
  const coPackBody = coPackDetail.json.snapshot.body;
  check('...with the variations section chosen',
    (coPackDetail.json.snapshot.meta.sections as string[]).includes('PACK_VARIATIONS'),
    coPackDetail.json.snapshot.meta.sections);
  check('...and the approved variations frozen into it',
    (coPackBody.variations as any[]).length >= 2,
    (coPackBody.variations as any[])?.map((v) => v.reference));
  /*
   * The one decision in that table: a pack listing a variation the contractor
   * approved without the client's own agreement on file, and not saying so, would be
   * asserting an agreement it cannot evidence — to the reader most likely to be
   * quoting it back during a dispute.
   */
  check('...each saying whether the client’s own agreement is on file',
    (coPackBody.variations as any[]).every(
      (v) => typeof v.clientApprovalRecorded === 'boolean'
    ));
  check('...and carrying NO cost figure or margin, because the pack has two audiences',
    (coPackBody.variations as any[]).every(
      (v) => !('costTotalCents' in v) && !('marginPct' in v)
    ),
    Object.keys((coPackBody.variations as any[])[0] ?? {}));
  eq('...with the project’s reporting currency frozen beside them, not read live',
    coPackBody.currency, 'USD');

  const coPackPdf = await call('GET', `/v1/reports/${coPack.json.report.id}/download.pdf`,
    { ...coCtx, raw: true });
  eq('the pack renders as a PDF with the new section in it', coPackPdf.status, 200);
  check('...and it is a real PDF', coPackPdf.buffer?.subarray(0, 4).toString() === '%PDF');

  // PHASE 12 - COMPLIANCE & ANALYTICS
  // `docs/operating-model/compliance-analytics.md` section 12, exercised against
  // the same live provider and project as the core loop.
  section('Compliance - warnings, enforcement, renewals and the expiry ladder');

  const cpEmpty = await call('GET', '/v1/compliance/summary', { ...coCtx });
  eq('the compliance portfolio answers before any requirement exists', cpEmpty.status, 200);
  const cpNorthgateEmpty = (cpEmpty.json.summary.providers as any[]).find(
    (provider) => provider.subjectCompanyId === northgate
  );
  eq('...calling an unrecorded provider unknown rather than compliant',
    cpNorthgateEmpty?.overallStatus, 'UNKNOWN');

  const cpWorkerDenied = await call('GET', '/v1/compliance/summary', { ...coSupCtx });
  eq('a supervisor without compliance.manage is denied independently', cpWorkerDenied.status, 403);
  const cpRivalList = await call('GET', '/v1/compliance-documents', {
    token: rival.token, companyId: rival.companyId!,
  });
  eq('a paying rival may open only its own empty register', cpRivalList.status, 200);
  eq('...without learning that Northgate has documents elsewhere', cpRivalList.json.documents, []);

  const cpMissing = await call('POST', '/v1/compliance-documents', {
    ...coCtx,
    body: {
      subjectCompanyId: northgate,
      kind: 'PUBLIC_LIABILITY',
      title: 'Public liability insurance',
      mandatory: true,
      notes: 'Owner-only review note',
    },
  });
  eq('a mandatory requirement can be recorded before a file arrives', cpMissing.status, 201);
  eq('...and that honest absence is MISSING', cpMissing.json.document.status, 'MISSING');
  const cpMissingId = cpMissing.json.document.id as string;

  const cpPendingFile = randomUUID();
  const cpReadyFile = randomUUID();
  const cpSelfFile = randomUUID();
  await db.query(
    `insert into stored_files
       (id, company_id, bucket_key, original_filename, content_type, byte_size,
        kind, status, uploaded_by_user_id)
     values
       ($1,$2,$3,'still-scanning.pdf','application/pdf',10,'DOCUMENT','SCANNING',$4),
       ($5,$2,$6,'public-liability.pdf','application/pdf',10,'DOCUMENT','READY',$4),
       ($7,$8,$9,'electrical-licence.pdf','application/pdf',10,'DOCUMENT','READY',$10)`,
    [
      cpPendingFile, meridian, `verify/${RUN}/compliance-pending`, owner.userId,
      cpReadyFile, `verify/${RUN}/compliance-ready`,
      cpSelfFile, northgate, `verify/${RUN}/compliance-self`, providerUser.userId,
    ]
  );
  const cpScanning = await call('POST', '/v1/compliance-documents', {
    ...coCtx,
    body: {
      subjectCompanyId: northgate, kind: 'CERTIFICATE', title: 'Scanning certificate',
      fileId: cpPendingFile,
    },
  });
  eq('a file still being checked cannot become compliance evidence', cpScanning.status, 409);

  const cpRejectWithoutReason = await call('PATCH', `/v1/compliance-documents/${cpMissingId}`, {
    ...coCtx,
    body: { expectedRevision: cpMissing.json.document.revision, review: { decision: 'REJECT' } },
  });
  eq('rejecting a document without a reason is refused', cpRejectWithoutReason.status, 422);
  const cpRejected = await call('PATCH', `/v1/compliance-documents/${cpMissingId}`, {
    ...coCtx,
    body: {
      expectedRevision: cpMissing.json.document.revision,
      review: { decision: 'REJECT', reason: 'Policy schedule is absent' },
    },
  });
  eq('a reasoned rejection is accepted', cpRejected.status, 200);
  eq('...and becomes the explicit REJECTED state', cpRejected.json.document.status, 'REJECTED');

  const providerBooking = (date: string) => ({
    batchClientId: randomUUID(),
    assignments: [{
      resourceType: 'PROVIDER', providerCompanyId: northgate, roleId, headcount: 1,
      startsAt: `${date}T08:00:00.000Z`, endsAt: `${date}T17:00:00.000Z`,
    }],
  });
  const cpWarnBatch = await call('POST', `/v1/projects/${projectId}/schedule`, {
    ...coCtx, body: providerBooking('2029-01-10'),
  });
  eq('with enforcement off, a non-compliant provider booking still saves', cpWarnBatch.status, 201);
  eq('...and the saved row carries the named compliance state',
    cpWarnBatch.json.assignments?.[0]?.compliance?.status, 'REJECTED');
  check('...with a warning rather than a silent flag',
    String(cpWarnBatch.json.assignments?.[0]?.compliance?.warning ?? '').includes('Public liability'));

  await db.query(
    `update sustainability_settings set enforce_compliance = true, updated_at = now()
      where company_id = $1`,
    [meridian]
  );
  const cpBlockedBooking = await call('POST', `/v1/projects/${projectId}/schedule`, {
    ...coCtx, body: providerBooking('2029-01-11'),
  });
  eq('turning enforcement on refuses the same provider booking', cpBlockedBooking.status, 409);
  check('...and names the record which must be fixed',
    String(cpBlockedBooking.json.error?.message ?? '').includes('Public liability'));

  const cpDraftSubmission = await call('POST', '/v1/project-submissions', {
    ...coProviderCtx,
    body: { projectId, periodStart: '2029-01-01', periodEnd: '2029-01-07' },
  });
  eq('a provider can still prepare a draft while enforcement is on', cpDraftSubmission.status, 201);
  const cpBlockedSubmission = await call(
    'POST',
    `/v1/project-submissions/${cpDraftSubmission.json.submission.id}/submit`,
    coProviderCtx
  );
  eq('...but cannot submit it while a mandatory record is rejected', cpBlockedSubmission.status, 409);

  const cpRenewed = await call('POST', '/v1/compliance-documents', {
    ...coCtx,
    body: {
      subjectCompanyId: northgate,
      kind: 'PUBLIC_LIABILITY',
      title: 'Public liability insurance 2029',
      fileId: cpReadyFile,
      issuedOn: '2028-01-01',
      expiresOn: '2029-12-31',
      mandatory: true,
      supersedesId: cpMissingId,
    },
  });
  eq('renewal inserts a new evidence row', cpRenewed.status, 201);
  eq('...whose dates make it valid', cpRenewed.json.document.status, 'VALID');
  const cpRenewedId = cpRenewed.json.document.id as string;

  const cpValidBooking = await call('POST', `/v1/projects/${projectId}/schedule`, {
    ...coCtx, body: providerBooking('2029-01-12'),
  });
  eq('once current, an enforced provider booking succeeds', cpValidBooking.status, 201);
  eq('...and its compliance badge is valid',
    cpValidBooking.json.assignments?.[0]?.compliance?.status, 'VALID');
  const cpSubmitted = await call(
    'POST',
    `/v1/project-submissions/${cpDraftSubmission.json.submission.id}/submit`,
    coProviderCtx
  );
  eq('the prepared provider submission now passes the same central policy', cpSubmitted.status, 200);

  await subscribe(northgate, 'pro');
  const { rows: cpExpiryDate } = await db.query<{ day: string }>(
    `select to_char((now() at time zone coalesce(time_zone, 'UTC'))::date + 45, 'YYYY-MM-DD') as day
       from companies where id = $1`,
    [northgate]
  );
  const cpSelf = await call('POST', '/v1/compliance-documents', {
    ...coProviderCtx,
    body: {
      subjectCompanyId: northgate,
      kind: 'LICENCE',
      title: 'Electrical contractor licence',
      fileId: cpSelfFile,
      expiresOn: cpExpiryDate[0]!.day,
      mandatory: true,
      notes: 'Northgate internal note',
    },
  });
  eq('a subcontractor can file a company certificate once', cpSelf.status, 201);
  const cpSelfId = cpSelf.json.document.id as string;
  const cpHirerReads = await call('GET', `/v1/compliance-documents/${cpSelfId}`, coCtx);
  eq('its direct hirer can read that self-filed certificate', cpHirerReads.status, 200);
  eq('...but not the subcontractor\'s internal note', cpHirerReads.json.document.notes, null);
  const cpRivalReads = await call('GET', `/v1/compliance-documents/${cpSelfId}`, {
    token: rival.token, companyId: rival.companyId!,
  });
  eq('an unrelated paying company cannot discover it by id', cpRivalReads.status, 404);

  await db.query(`update compliance_documents set status = 'VALID' where id = $1`, [cpSelfId]);
  const cpExpiryPass = await runComplianceExpiryBatch();
  check('the nightly pass reconciles a stale date-derived status', cpExpiryPass.statusChanged >= 1,
    cpExpiryPass);
  check('...and emits the next applicable ladder rung', cpExpiryPass.alerted >= 1, cpExpiryPass);
  const { rows: cpOneAlert } = await db.query<{ threshold_days: number }>(
    `select threshold_days from compliance_alerts where document_id = $1`, [cpSelfId]);
  eq('45 days remaining lands on the 60-day rung', cpOneAlert.map((row) => row.threshold_days), [60]);
  await runComplianceExpiryBatch();
  const { rows: cpStillOneAlert } = await db.query<{ n: string }>(
    `select count(*)::text as n from compliance_alerts where document_id = $1`, [cpSelfId]);
  eq('running the nightly pass twice does not repeat a rung', cpStillOneAlert[0]?.n, '1');

  await drainWorkers();
  const { rows: cpNotifiedCompanies } = await db.query<{ company_id: string }>(
    `select distinct company_id from notifications
      where kind = 'compliance.expiring' and subject_id = $1 order by company_id`,
    [cpSelfId]
  );
  check('a self-filed expiry reaches both the subcontractor and every direct tracking hirer',
    [meridian, northgate].every((id) => cpNotifiedCompanies.some((row) => row.company_id === id)),
    cpNotifiedCompanies);

  const cpRaceBody = {
    subjectCompanyId: northgate,
    kind: 'PUBLIC_LIABILITY',
    title: 'Public liability insurance 2030',
    fileId: cpReadyFile,
    issuedOn: '2029-01-01',
    expiresOn: '2030-12-31',
    mandatory: true,
    supersedesId: cpRenewedId,
  };
  const cpRace = await Promise.all([
    call('POST', '/v1/compliance-documents', { ...coCtx, body: cpRaceBody }),
    call('POST', '/v1/compliance-documents', { ...coCtx, body: cpRaceBody }),
  ]);
  eq('two concurrent renewals produce one successor and one conflict',
    cpRace.map((response) => response.status).sort(), [201, 409]);
  const cpWinner = cpRace.find((response) => response.status === 201)!;
  const { rows: cpSuccessors } = await db.query<{ n: string }>(
    `select count(*)::text as n from compliance_documents
      where supersedes_id = $1 and deleted_at is null`,
    [cpRenewedId]
  );
  eq('the database, not timing in the route, keeps the renewal chain single',
    cpSuccessors[0]?.n, '1');
  const cpHistory = await call('GET',
    `/v1/compliance-documents?subjectCompanyId=${northgate}&includeHistory=true`, coCtx);
  check('the superseded evidence remains in explicit history',
    (cpHistory.json.documents as any[]).some(
      (document) => document.id === cpRenewedId && document.superseded === true
    ));

  await db.query(
    `update compliance_documents
        set issued_on = null, expires_on = (now() at time zone 'UTC')::date - 1, status = 'VALID'
      where id = $1`,
    [cpWinner.json.document.id]
  );
  await runComplianceExpiryBatch();
  const cpExpiredBooking = await call('POST', `/v1/projects/${projectId}/schedule`, {
    ...coCtx, body: providerBooking('2029-01-13'),
  });
  eq('the nightly EXPIRED state immediately feeds the same enforcement gate',
    cpExpiredBooking.status, 409);

  section('Client analytics - quarterly/yearly workflow and project comparison inputs');
  const cpPeriodList = await call('GET', '/v1/reports?kind=CLIENT_PERIOD', { ...suCtx });
  eq('the client-report workspace can load existing frozen periods', cpPeriodList.status, 200);
  check('...including the annual aggregate Phase 10 already proved project by project',
    (cpPeriodList.json.reports as any[]).some((report) => report.id === rpPeriod.json.report.id));
  const cpAnnual = await call('POST', '/v1/reports/client-period', {
    ...suCtx,
    body: {
      audience: 'INTERNAL', clientCompanyId: rpClientCompany,
      periodStart: '2027-01-01', periodEnd: '2027-12-31',
    },
  });
  check('a full client year is one report, whether newly inserted or content-addressed',
    [200, 201].includes(cpAnnual.status), cpAnnual.status);
  const cpAnnualDetail = await call('GET', `/v1/reports/${cpAnnual.json.report.id}`, { ...suCtx });
  check('the annual report exposes every contributing project as comparison input',
    (cpAnnualDetail.json.snapshot.body.projects as any[]).length >= 1,
    cpAnnualDetail.json.snapshot.body.projects);
  eq('...and keeps mixed-factor-year disclosure explicit',
    typeof cpAnnualDetail.json.snapshot.body.mixedFactorYears, 'boolean');

  const cpPurgeFile = randomUUID();
  const cpHeldFile = randomUUID();
  await db.query(
    `update company_subscriptions
        set entitlements_snapshot = jsonb_set(entitlements_snapshot, '{limits,artifact_retention_days}', '0')
      where company_id = $1;
     update projects set status = 'COMPLETED', updated_at = '2000-01-01' where id = $2;
     insert into stored_files
       (id, company_id, project_id, bucket_key, original_filename, content_type, byte_size,
        kind, status, uploaded_by_user_id, created_at)
     values
       ($3,$1,$2,$4,'aged.jpg','image/jpeg',1,'IMAGE','READY',$5,'2000-01-01'),
       ($6,$1,$2,$7,'held.jpg','image/jpeg',1,'IMAGE','READY',$5,'2000-01-01');
     insert into report_file_references (report_id, file_id, role) values ($8,$6,'EVIDENCE')`,
    [
      meridian, coEmptyProject, cpPurgeFile, `verify/${RUN}/aged-artifact`, owner.userId,
      cpHeldFile, `verify/${RUN}/held-artifact`, coPack.json.report.id,
    ]
  );
  const cpRetention = await runArtifactRetentionBatch();
  check('the artifact-class sweep reclaims completed-project bytes after the plan period',
    cpRetention.reclaimed >= 1, cpRetention);
  const { rows: cpRetentionRows } = await db.query<{ id: string; status: string }>(
    `select id, status from stored_files where id = any($1::uuid[]) order by id`,
    [[cpPurgeFile, cpHeldFile]]
  );
  eq('an unheld artifact becomes unavailable while its evidence row survives',
    cpRetentionRows.find((row) => row.id === cpPurgeFile)?.status, 'DELETED');
  eq('a file cited by a frozen report remains ready regardless of the plan period',
    cpRetentionRows.find((row) => row.id === cpHeldFile)?.status, 'READY');
  const { rows: cpQueuedDelete } = await db.query<{ status: string }>(
    `select status from artifact_deletion_queue where file_id = $1`, [cpPurgeFile]);
  eq('object deletion is durable work and reaches a terminal queue state',
    cpQueuedDelete[0]?.status, 'DELETED');

  // ── Result ────────────────────────────────────────────────────────────────
  console.log(`\n${'═'.repeat(72)}`);
  if (failures.length === 0) {
    console.log(`ALL GREEN — ${passed} checks passed`);
  } else {
    console.log(`${passed} passed, ${failures.length} FAILED:`);
    for (const f of failures) console.log(`  · ${f}`);
  }
  await db.end();
  await pool.end();
  process.exitCode = failures.length === 0 ? 0 : 1;
}

main().catch(async (err) => {
  console.error('\nverify-e2e crashed:', err);
  await db.end().catch(() => {});
  await pool.end().catch(() => {});
  process.exitCode = 1;
});
