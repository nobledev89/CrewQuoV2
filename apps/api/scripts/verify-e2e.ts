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
import { randomUUID } from 'node:crypto';
import ExcelJS from 'exceljs';
import pg from 'pg';
import { env } from '../src/env';

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

/** Put a company on a seeded plan. Fresh companies default to `crew` (no exports). */
async function subscribe(companyId: string, planId: string): Promise<void> {
  await db.query(
    `insert into company_subscriptions (company_id, plan_id, status)
     values ($1, $2, 'ACTIVE')
     on conflict (company_id) do update set plan_id = excluded.plan_id, status = 'ACTIVE'`,
    [companyId, planId]
  );
  // The API memoizes entitlements for 60s; wait it out or restart. Instead we
  // subscribe before the company is ever asked about, so nothing is cached yet.
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
  await wb.xlsx.load(xlsx.buffer!);
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
  await db.query(`update users set is_super_admin = true where id = $1`, [staff.userId]);

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
    'the raised limit is live at once, not after the 60s TTL',
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
  eq('...inheriting the company currency rather than carrying its own',
    livePayCard?.currency, null);

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

  const unlikeCurrency = await call('POST', '/v1/rate-proposals', {
    token: providerUser.token,
    companyId: northgate,
    body: {
      engagementId: cEngagement,
      effectiveFrom: futureFrom,
      currency: 'GBP',
      lines: [{ operation: 'CREATE', roleId, rateLabel: 'DAILY', rateMode: 'DAILY', dailyRateCents: 40000 }],
    },
  });
  eq('an unlike currency is refused until the FX boundary exists', unlikeCurrency.status, 422);
  check('...and the refusal says what is missing',
    /exchange rate|FX snapshot/i.test(unlikeCurrency.json?.error?.message ?? ''),
    unlikeCurrency.json?.error?.message);

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
    `select rate_label, hourly_rate_cents, version, locked, currency,
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
  eq('...carries the agreement currency', newMonFri?.currency, 'USD');
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
  // provider is usually on the free Crew plan, which has `audit_retention_days: 0`
  // and no `audit_visibility` — so `recordAudit` writes nothing for it and it cannot
  // read a trail either. Both halves are asserted, because this is a product gap
  // worth seeing rather than a bug to paper over: the negotiation is recorded only
  // on the side that pays for retention.
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
  eq('...consistently, zero rows were written for it (retention 0 ⇒ nothing written)',
    providerRows.rows[0].n, 0);

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
    otherCountry.json.warning);
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

  // ── Result ────────────────────────────────────────────────────────────────
  console.log(`\n${'═'.repeat(72)}`);
  if (failures.length === 0) {
    console.log(`ALL GREEN — ${passed} checks passed`);
  } else {
    console.log(`${passed} passed, ${failures.length} FAILED:`);
    for (const f of failures) console.log(`  · ${f}`);
  }
  await db.end();
  process.exitCode = failures.length === 0 ? 0 : 1;
}

main().catch(async (err) => {
  console.error('\nverify-e2e crashed:', err);
  await db.end().catch(() => {});
  process.exitCode = 1;
});
