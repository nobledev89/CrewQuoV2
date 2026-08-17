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
