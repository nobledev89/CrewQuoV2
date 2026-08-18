import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import { subscribe, makeSuperAdmin } from '../e2e/helpers';

/**
 * Design-review walk (see playwright.walk.config.ts). Not part of `test:e2e`.
 *
 * Provisions a densely-populated tenant, then screenshots every screen for each of
 * the four positions a company can be in. Density is deliberate: an empty table
 * says nothing about whether the layout holds at 20+ rows, which is what §40 asks.
 */

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://127.0.0.1:4000';
const PASSWORD = 'Walk-passw0rd!';
const RUN = Math.random().toString(36).slice(2, 7);
const OUT = process.env.WALK_OUT ?? join(__dirname, '..', '..', '..', '.tmp', 'walk');

mkdirSync(OUT, { recursive: true });

let shot = 0;
const captured: string[] = [];

interface Session {
  email: string;
  token: string;
  refreshToken: string;
  companyId: string | null;
  raw: unknown;
}

async function call<T = any>(
  method: string,
  path: string,
  opts: { token?: string; companyId?: string; body?: unknown } = {}
): Promise<{ status: number; json: T }> {
  const headers: Record<string, string> = {};
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  if (opts.companyId) headers['X-Company-Id'] = opts.companyId;
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${API}${path}`, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = text;
  }
  return { status: res.status, json: json as T };
}

async function register(handle: string, companyName?: string): Promise<Session> {
  const email = `${handle}+${RUN}@walk.crewquo.test`;
  const res = await call('POST', '/v1/auth/register', {
    body: { email, password: PASSWORD, name: nameFor(handle), companyName },
  });
  if (res.status !== 201 && res.status !== 200) {
    throw new Error(`register ${handle}: ${res.status} ${JSON.stringify(res.json)}`);
  }
  const j = res.json as any;
  return {
    email,
    token: j.tokens.accessToken,
    refreshToken: j.tokens.refreshToken,
    companyId: j.memberships[0]?.companyId ?? null,
    raw: j,
  };
}

function nameFor(handle: string): string {
  const names: Record<string, string> = {
    owner: 'Dana Whitfield',
    provider: 'Marcus Adeyemi',
    client: 'Priya Raghunathan',
    staff: 'CrewQuo Support',
    pm: 'Tom Halvorsen',
    coord: 'Ruth Okonjo',
    crew: 'Sam Petrov',
  };
  return names[handle] ?? handle;
}

/** Put a persona's session straight into localStorage — no login form to drive. */
async function beSession(page: Page, session: Session, companyId: string | null) {
  await page.goto('/login');
  await page.evaluate(
    ([raw, cid]) => {
      const j = raw as any;
      localStorage.setItem(
        'crewquo.session',
        JSON.stringify({
          accessToken: j.tokens.accessToken,
          refreshToken: j.tokens.refreshToken,
          user: j.user,
          memberships: j.memberships,
        })
      );
      if (cid) localStorage.setItem('crewquo.companyId', cid as string);
      else localStorage.removeItem('crewquo.companyId');
    },
    [session.raw, companyId] as const
  );
}

interface Density {
  label: string;
  path: string;
  /** Viewport y of the first table body row — everything above it is chrome. */
  firstRowY: number | null;
  rowsRendered: number;
  /** Rows whose bottom edge falls inside the viewport. §40 asks for 20+. */
  rowsVisible: number;
  rowHeight: number | null;
}

const density: Density[] = [];

/**
 * Measure how much vertical space a screen spends before its first row of data,
 * rather than eyeballing it off a screenshot. §40's density rule is quantitative,
 * so the audit of it should be too.
 */
async function measure(page: Page, label: string, path: string): Promise<void> {
  const m = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('.cq-table tbody tr'));
    const first = rows[0];
    if (!first) return { firstRowY: null, rowsRendered: 0, rowsVisible: 0, rowHeight: null };
    const box = first.getBoundingClientRect();
    const visible = rows.filter((r) => {
      const b = r.getBoundingClientRect();
      return b.bottom <= window.innerHeight && b.top >= 0;
    }).length;
    return {
      firstRowY: Math.round(box.top),
      rowsRendered: rows.length,
      rowsVisible: visible,
      rowHeight: Math.round(box.height),
    };
  });
  density.push({ label, path, ...m });
}

/** Screenshot one route. A broken screen is a finding, so failures are captured too. */
async function capture(page: Page, label: string, path: string, waitFor?: string) {
  shot += 1;
  const file = `${String(shot).padStart(2, '0')}-${label}.png`;
  try {
    await page.goto(path, { waitUntil: 'domcontentloaded' });
    // The shell renders once the on-mount refresh resolves; auth screens have no shell.
    if (!waitFor) {
      await page
        .locator('.cq-account__name, .cq-auth__panel')
        .first()
        .waitFor({ timeout: 30_000 })
        .catch(() => undefined);
    } else {
      await page.locator(waitFor).first().waitFor({ timeout: 30_000 }).catch(() => undefined);
    }
    // Let data land: every screen fetches on mount.
    await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => undefined);
    await page.waitForTimeout(600);
  } catch (err) {
    console.log(`  !! ${label} navigation problem: ${String(err).slice(0, 200)}`);
  }
  await page.screenshot({ path: join(OUT, file) });
  await measure(page, label, path);
  captured.push(`${file}  ${path}`);
  console.log(`  captured ${file}`);
}

test('design walk', async ({ browser }) => {
  test.setTimeout(600_000);

  // ── Provision ─────────────────────────────────────────────────────────────
  const owner = await register('owner', `Meridian Contracts ${RUN}`);
  const meridian = owner.companyId!;
  // Before anything resolves entitlements: the API memoizes for 60s.
  await subscribe(`Meridian Contracts ${RUN}`, 'pro');

  const asOwner = { token: owner.token, companyId: meridian };

  // Roles — enough to make the rate tables real.
  const ROLES = ['Electrician', 'Mate', 'Supervisor', 'Labourer', 'AV Technician'];
  const roleIds: Record<string, string> = {};
  for (const name of ROLES) {
    const r = await call('POST', '/v1/role-catalog', { ...asOwner, body: { name } });
    roleIds[name] = (r.json as any).role.id;
  }

  // A default template carrying two label rules.
  await call('POST', '/v1/rate-card-templates', {
    ...asOwner,
    body: {
      name: 'House rules',
      isDefault: true,
      timeframeDefinitions: [
        { type: 'label_rule', shiftType: 'NIGHT', daysOfWeek: [5, 6], label: 'FRI_SAT_NIGHT' },
        { type: 'holiday', holidayDates: ['2026-12-25', '2026-01-01'], holidayMultiplier: 1.5 },
      ],
    },
  });
  await call('POST', '/v1/rate-card-templates', {
    ...asOwner,
    body: { name: 'Legacy 2025 rules', timeframeDefinitions: [] },
  });

  // Two subcontractors: one who joined, one still pending.
  const northgateRes = await call('POST', '/v1/providers', {
    ...asOwner,
    body: { name: `Northgate Electrical ${RUN}`, email: `provider+${RUN}@walk.crewquo.test` },
  });
  const northgatePlaceholder = (northgateRes.json as any).provider.providerCompanyId as string;
  const northgateInvite = (northgateRes.json as any).inviteToken as string;
  await call('POST', '/v1/providers', {
    ...asOwner,
    body: { name: `Ridgeway Mechanical ${RUN}`, email: `ridgeway+${RUN}@walk.crewquo.test` },
  });

  const providerUser = await register('provider');
  const providerAccept = await call('POST', `/v1/invites/${northgateInvite}/accept`, {
    token: providerUser.token,
  });
  const northgate =
    ((providerAccept.json as any).companyId as string | undefined) ?? northgatePlaceholder;

  // Two portal clients: one who accepted, one still a stub.
  const harbourRes = await call('POST', '/v1/clients', {
    ...asOwner,
    body: { name: `Harbour Group ${RUN}`, email: `client+${RUN}@walk.crewquo.test` },
  });
  const harbour = (harbourRes.json as any).client.clientCompanyId as string;
  const harbourEngagement = (harbourRes.json as any).client.engagementId as string;
  const harbourInvite = (harbourRes.json as any).inviteToken as string;
  await call('POST', '/v1/clients', {
    ...asOwner,
    body: { name: `Calder Estates ${RUN}`, email: `calder+${RUN}@walk.crewquo.test` },
  });
  const clientUser = await register('client');
  const clientAccept = await call('POST', `/v1/invites/${harbourInvite}/accept`, {
    token: clientUser.token,
  });
  const harbourReal = ((clientAccept.json as any).companyId as string | undefined) ?? harbour;

  // Rate cards: PAY against the subcontractor, BILL against the client, per role+label.
  const LABELS: Array<[label: string, pay: number, bill: number]> = [
    ['MON_FRI_DAY', 5000, 8000],
    ['MON_THU_NIGHT', 6000, 9600],
    ['SUNDAY', 7500, 12000],
  ];
  for (const [i, roleName] of ROLES.entries()) {
    for (const [label, pay, bill] of LABELS) {
      const bump = i * 250;
      await call('POST', '/v1/rate-cards', {
        ...asOwner,
        body: {
          kind: 'PAY',
          counterpartyCompanyId: northgate,
          roleId: roleIds[roleName],
          rateMode: 'HOURLY',
          rateLabel: label,
          hourlyRateCents: pay + bump,
          effectiveFrom: '2026-01-01',
        },
      });
      await call('POST', '/v1/rate-cards', {
        ...asOwner,
        body: {
          kind: 'BILL',
          counterpartyCompanyId: harbourReal,
          roleId: roleIds[roleName],
          rateMode: 'HOURLY',
          rateLabel: label,
          hourlyRateCents: bill + bump * 2,
          effectiveFrom: '2026-01-01',
        },
      });
    }
  }

  // Projects — a spread of statuses, so the list filter has something to filter.
  const PROJECTS: Array<{ name: string; status?: string; visible?: boolean }> = [
    { name: `Pier 9 Fit-Out ${RUN}`, status: 'ACTIVE', visible: true },
    { name: `Harbour HQ Strip-Out ${RUN}`, status: 'ACTIVE', visible: true },
    { name: `Dockside Warehouse Refit ${RUN}`, status: 'PLANNED' },
    { name: `Aldgate Mezzanine ${RUN}`, status: 'ACTIVE' },
    { name: `Riverside Phase 1 ${RUN}`, status: 'COMPLETED', visible: true },
    { name: `Old Mill Decommission ${RUN}`, status: 'ARCHIVED' },
  ];
  const projectIds: string[] = [];
  for (const p of PROJECTS) {
    const res = await call('POST', '/v1/projects', {
      ...asOwner,
      body: {
        name: p.name,
        clientCompanyId: harbourReal,
        engagementId: harbourEngagement,
        clientVisible: p.visible ?? false,
        startsOn: '2026-07-06',
        notes: 'Design-review fixture.',
      },
    });
    const id = (res.json as any).project?.id;
    if (!id) throw new Error(`project ${p.name}: ${JSON.stringify(res.json)}`);
    projectIds.push(id);
    if (p.status && p.status !== 'ACTIVE') {
      await call('PATCH', `/v1/projects/${id}`, { ...asOwner, body: { status: p.status } });
    }
    await call('POST', `/v1/projects/${id}/assignments`, {
      ...asOwner,
      body: { providerCompanyId: northgate },
    });
  }
  const mainProject = projectIds[0]!;

  // Time logs: a fortnight of work across roles and shift types.
  const DATES = [
    '2026-07-06', '2026-07-07', '2026-07-08', '2026-07-09', '2026-07-10',
    '2026-07-13', '2026-07-14', '2026-07-15', '2026-07-16', '2026-07-17',
    '2026-07-20', '2026-07-21', '2026-07-22', '2026-07-23',
  ];
  const SHIFTS = ['WEEKDAY_DAY', 'WEEKDAY_DAY', 'WEEKDAY_DAY', 'NIGHT', 'SUNDAY'];
  const logIds: string[] = [];
  for (const [i, workDate] of DATES.entries()) {
    const roleName = ROLES[i % ROLES.length]!;
    const res = await call('POST', '/v1/time-logs', {
      token: providerUser.token,
      companyId: northgate,
      body: {
        projectId: projectIds[i % 3]!,
        roleId: roleIds[roleName],
        shiftType: SHIFTS[i % SHIFTS.length],
        workDate,
        hoursRegular: 8,
        hoursOt: i % 4 === 0 ? 2 : 0,
        notes: i % 5 === 0 ? 'Second fix, level 3 east.' : undefined,
      },
    });
    const id = (res.json as any).timeLog?.id;
    if (id) logIds.push(id);
  }
  // Submit all but the last two; approve most, return one with a reason.
  for (const id of logIds.slice(0, -2)) {
    await call('POST', `/v1/time-logs/${id}/submit`, {
      token: providerUser.token,
      companyId: northgate,
    });
  }
  for (const id of logIds.slice(0, 7)) {
    await call('POST', `/v1/time-logs/${id}/approve`, asOwner);
  }
  if (logIds[7]) {
    await call('POST', `/v1/time-logs/${logIds[7]}/reject`, {
      ...asOwner,
      body: { reason: 'Sunday premium claimed on a Thursday — please recheck the date.' },
    });
  }

  // Expenses.
  const EXPENSES: Array<[category: string, cents: number, description: string]> = [
    ['TRAVEL', 1550, 'Site parking, week 28'],
    ['MATERIALS', 24800, 'Consumables — fixings and trunking'],
    ['PLANT', 41000, 'Scissor lift hire, 2 days'],
    ['OTHER', 3200, 'Waste transfer note copies'],
  ];
  const expenseIds: string[] = [];
  for (const [category, amountCents, description] of EXPENSES) {
    const res = await call('POST', '/v1/expenses', {
      token: providerUser.token,
      companyId: northgate,
      body: { projectId: mainProject, amountCents, category, description },
    });
    const id = (res.json as any).expense?.id;
    if (id) expenseIds.push(id);
  }
  for (const id of expenseIds.slice(0, 3)) {
    await call('POST', `/v1/expenses/${id}/submit`, {
      token: providerUser.token,
      companyId: northgate,
    });
  }
  for (const id of expenseIds.slice(0, 2)) {
    await call('POST', `/v1/expenses/${id}/approve`, asOwner);
  }

  // An invoice off the approved work, plus a second left as a draft.
  await call('POST', '/v1/invoices', {
    ...asOwner,
    body: { projectId: mainProject, taxCents: 0, includeApprovedWork: true },
  });
  const issuable = await call('POST', '/v1/invoices', {
    ...asOwner,
    body: { projectId: projectIds[1]!, taxCents: 0, includeApprovedWork: true },
  });
  const issuableId = (issuable.json as any).invoice?.id;
  if (issuableId) {
    await call('POST', `/v1/invoices/${issuableId}/items`, {
      ...asOwner,
      body: {
        description: 'Preliminaries and site set-up',
        quantity: 1,
        unitAmountCents: 125000,
        sourceType: 'MANUAL',
      },
    });
    await call('POST', `/v1/invoices/${issuableId}/issue`, asOwner);
  }

  // A team: a manager, a coordinator and a suspended member.
  for (const [handle, role] of [['pm', 'MANAGER'], ['coord', 'ADMIN'], ['crew', 'MEMBER']] as const) {
    const inv = await call('POST', '/v1/members/invite', {
      ...asOwner,
      body: { email: `${handle}+${RUN}@walk.crewquo.test`, role },
    });
    const user = await register(handle);
    const token = (inv.json as any).inviteToken;
    if (token) await call('POST', `/v1/invites/${token}/accept`, { token: user.token });
  }
  const members = await call('GET', '/v1/members', asOwner);
  const crewRow = ((members.json as any).data ?? []).find((m: any) =>
    String(m.email ?? '').startsWith('crew+')
  );
  if (crewRow) {
    await call('PATCH', `/v1/members/${crewRow.membershipId}`, {
      ...asOwner,
      body: { status: 'SUSPENDED' },
    });
  }

  // Let the client comment on a line item, and turn the trail on for that edge.
  await call('PUT', `/v1/audit-settings/${harbourEngagement}`, {
    ...asOwner,
    body: { clientCanComment: true, showAuditTrail: true },
  });
  if (logIds[0]) {
    await call('POST', '/v1/line-item-notes', {
      token: clientUser.token,
      companyId: harbourReal,
      body: {
        engagementId: harbourEngagement,
        entityType: 'TIME_LOG',
        entityId: logIds[0],
        body: 'Can you confirm this covers the east riser as well? Our QS has queried it.',
      },
    });
  }

  const staff = await register('staff');
  await makeSuperAdmin(staff.email);
  const staffAgain = await call('POST', '/v1/auth/login', {
    body: { email: staff.email, password: PASSWORD },
  });

  console.log(`\nfixture ready (run ${RUN}) — screenshots to ${OUT}\n`);

  // ── Walk ──────────────────────────────────────────────────────────────────

  // Anonymous.
  const anon = await (await browser.newContext()).newPage();
  await capture(anon, 'login', '/login', '.cq-auth__panel');
  await capture(anon, 'register', '/register', '.cq-auth__panel');
  await capture(anon, 'landing', '/', 'body');
  await anon.close();

  // Owner of a paid, hiring company.
  const ownerPage = await (await browser.newContext()).newPage();
  await beSession(ownerPage, owner, meridian);
  await capture(ownerPage, 'owner-dashboard', '/app');
  await capture(ownerPage, 'owner-projects', '/projects');
  await capture(ownerPage, 'owner-project-detail', `/projects/${mainProject}`);
  await capture(ownerPage, 'owner-review', '/review');
  await capture(ownerPage, 'owner-invoices', '/invoices');
  await capture(ownerPage, 'owner-work', '/work');
  await capture(ownerPage, 'owner-engagements', '/network/engagements');
  await capture(ownerPage, 'owner-providers', '/network/providers');
  await capture(ownerPage, 'owner-clients', '/network/clients');
  await capture(ownerPage, 'owner-rate-cards', '/rates/cards');
  await capture(ownerPage, 'owner-roles', '/rates/roles');
  await capture(ownerPage, 'owner-templates', '/rates/templates');
  await capture(ownerPage, 'owner-resolve', '/rates/resolve');
  await capture(ownerPage, 'owner-members', '/company/members');
  await capture(ownerPage, 'owner-audit', '/audit');
  await capture(ownerPage, 'owner-plan', '/plan');
  await capture(ownerPage, 'owner-settings', '/settings');
  await capture(ownerPage, 'owner-profile', '/profile');
  await ownerPage.close();

  // The subcontractor side of the same data.
  const provPage = await (await browser.newContext()).newPage();
  await beSession(provPage, providerUser, northgate);
  await capture(provPage, 'provider-dashboard', '/app');
  await capture(provPage, 'provider-work', '/work');
  await capture(provPage, 'provider-projects', '/projects');
  await capture(provPage, 'provider-plan', '/plan');
  await provPage.close();

  // The client side.
  const clientPage = await (await browser.newContext()).newPage();
  await beSession(clientPage, clientUser, harbourReal);
  await capture(clientPage, 'client-dashboard', '/app');
  await capture(clientPage, 'client-portal', '/portal');
  await capture(clientPage, 'client-portal-detail', `/portal/${mainProject}`);
  await clientPage.close();

  // Platform staff, who own no company.
  const staffPage = await (await browser.newContext()).newPage();
  await beSession(
    staffPage,
    { ...staff, raw: (staffAgain.json as any) ?? staff.raw },
    null
  );
  await capture(staffPage, 'staff-companies', '/admin/companies', '.cq-page-header');
  await capture(staffPage, 'staff-plans', '/admin/plans', '.cq-page-header');
  await capture(staffPage, 'staff-projects-gated', '/projects', '.cq-page-header');
  await staffPage.close();

  console.log(`\n── captured ${captured.length} screens ──`);
  for (const line of captured) console.log(`  ${line}`);

  console.log(`\n── density: chrome height before the first data row (viewport 1440x900) ──`);
  console.log('  chromePx  rendered  visible  rowPx  screen');
  for (const d of density.filter((x) => x.firstRowY !== null).sort((a, b) => b.firstRowY! - a.firstRowY!)) {
    console.log(
      `  ${String(d.firstRowY).padStart(8)}  ${String(d.rowsRendered).padStart(8)}  ` +
        `${String(d.rowsVisible).padStart(7)}  ${String(d.rowHeight).padStart(5)}  ${d.label}`
    );
  }
  writeFileSync(join(OUT, 'density.json'), JSON.stringify(density, null, 2));

  expect(captured.length).toBeGreaterThan(20);
});
