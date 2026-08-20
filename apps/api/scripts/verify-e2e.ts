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
import jwt from 'jsonwebtoken';
import pg from 'pg';
import { env } from '../src/env';
import { pool } from '../src/db';
import {
  base32Decode,
  totpCounter,
  totpCounterBytes,
  totpTruncate,
} from '@crewquo/shared';
import { deriveKid, parseRetiredSecrets } from '../src/modules/auth/signingKeys';
import { currentAccessKid, signPurposeToken } from '../src/modules/auth/tokens';
import { readJobHealth, recordJobRun } from '../src/jobs/jobRuns';
import { runOutboxBatch } from '../src/modules/delivery/worker';
import { recoverStaleOutboxClaims } from '../src/modules/delivery/repo';
import { runNotificationDeliveryBatch } from '../src/modules/notifications/deliveryWorker';
import { NOTIFICATION_HANDLERS } from '../src/modules/notifications/handlers';

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
  let outbox = { claimed: 0, delivered: 0, failed: 0 };
  let deliveries = { claimed: 0, sent: 0, skipped: 0, failed: 0 };
  for (let pass = 0; pass < MAX_PASSES; pass += 1) {
    await recoverStaleOutboxClaims(0);
    const o = await runOutboxBatch({ workerId: 'verify-e2e', handlers: NOTIFICATION_HANDLERS });
    const d = await runNotificationDeliveryBatch();
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
    if (o.claimed === 0 && d.claimed === 0) break;
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
  // Checkout is off until Gumroad, so everything lands in the audited-admin arm.
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
  eq('every scheduled job is reported, so a missing one cannot read as healthy',
    jobsHealth.length, 3);
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
