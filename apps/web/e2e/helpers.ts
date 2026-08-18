import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import { expect, type Browser, type Page } from '@playwright/test';

/**
 * Fixtures for the parity E2E. Everything here exists to *set up* a scenario; the
 * assertions live in the spec and go through the browser.
 */

/** One id per run, so re-running does not collide on unique emails or company names. */
export const RUN = Math.random().toString(36).slice(2, 8);

const PASSWORD = 'Parity-passw0rd!';

/**
 * The same password, exported for the one flow that asks for it again: the
 * additional-company request re-authenticates (§3.1.1(7)), because an access
 * token is re-minted by refresh without anyone re-proving anything.
 */
export const PARITY_PASSWORD = PASSWORD;

/** Read `DATABASE_URL` from the repo-root `.env` when it is not already exported. */
function databaseUrl(): string {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const envPath = join(__dirname, '..', '..', '..', '.env');
  const line = readFileSync(envPath, 'utf8')
    .split(/\r?\n/)
    .find((l) => l.startsWith('DATABASE_URL='));
  if (!line) {
    throw new Error('DATABASE_URL is not set and was not found in the repo-root .env');
  }
  return line.slice('DATABASE_URL='.length).trim().replace(/^["']|["']$/g, '');
}

/**
 * Put a company on a seeded plan.
 *
 * This writes to `company_subscriptions` directly, exactly as `verify-e2e.ts` does.
 * `POST /v1/admin/companies/:id/subscription` would do the same thing through the
 * API, but it needs a super-admin — and, more importantly, the fixture has to land
 * *before* anything resolves this company's entitlements (see `provisionCompany`).
 * A fresh company defaults to `crew`, which cannot hire, cannot export and has no
 * portal, so without this the whole loop is unreachable by design rather than by bug.
 */
export async function subscribe(companyName: string, planId: string): Promise<void> {
  const db = new Client({ connectionString: databaseUrl() });
  await db.connect();
  try {
    const { rows } = await db.query<{ id: string }>(
      `select id from companies where name = $1`,
      [companyName]
    );
    const company = rows[0];
    if (!company) throw new Error(`No company named "${companyName}" to subscribe`);
    await db.query(
      `insert into company_subscriptions (company_id, plan_id, status)
         values ($1, $2, 'ACTIVE')
       on conflict (company_id) do update
         set plan_id = excluded.plan_id, status = 'ACTIVE'`,
      [company.id, planId]
    );
  } finally {
    await db.end();
  }
}

export function emailFor(handle: string): string {
  return `${handle}+${RUN}@parity.crewquo.test`;
}

/**
 * Promote a registered account to platform staff.
 *
 * `is_super_admin` is a column with no endpoint that sets it — deliberately, since a
 * route that grants platform staff would be the single most valuable target in the
 * product. Support access is granted at the database, so the fixture grants it there.
 */
export async function makeSuperAdmin(email: string): Promise<void> {
  const db = new Client({ connectionString: databaseUrl() });
  await db.connect();
  try {
    const { rowCount } = await db.query(
      `update users set is_super_admin = true where email = $1`,
      [email]
    );
    if (rowCount === 0) throw new Error(`No user ${email} to promote`);
  } finally {
    await db.end();
  }
}

/** Register a user with no company at all — the state platform staff are in. */
export async function registerHeadless(opts: {
  handle: string;
  name: string;
}): Promise<string> {
  const email = emailFor(opts.handle);
  const res = await fetch(`${API_URL}/v1/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD, name: opts.name }),
  });
  if (res.status !== 201 && res.status !== 200) {
    throw new Error(`register ${opts.handle} failed: ${res.status} ${await res.text()}`);
  }
  return email;
}

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://127.0.0.1:4000';

/**
 * Register a user and company over HTTP, with no browser involved, then put the
 * company on a paid plan.
 *
 * The order matters and is the whole reason this helper exists. The API memoizes
 * resolved entitlements for 60 seconds in process, and a company created through the
 * *UI* is read immediately — the dashboard asks for `/v1/entitlements` the moment it
 * mounts, caching the free `crew` plan. Subscribing after that point has no visible
 * effect for up to a minute, which reads as "the paid feature is broken" when nothing
 * is wrong.
 *
 * Registering headlessly means nothing has asked about the company yet, so the
 * subscription is in place before its first resolution. The register *screen* is proven
 * separately, by its own test.
 */
export async function provisionCompany(opts: {
  handle: string;
  name: string;
  companyName: string;
  planId: string;
}): Promise<string> {
  const email = emailFor(opts.handle);
  const res = await fetch(`${API_URL}/v1/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email,
      password: PASSWORD,
      name: opts.name,
      companyName: opts.companyName,
    }),
  });
  if (res.status !== 201 && res.status !== 200) {
    throw new Error(`provision ${opts.handle} failed: ${res.status} ${await res.text()}`);
  }
  await subscribe(opts.companyName, opts.planId);
  return email;
}

/** A signed-out browser context — each participant in the loop needs their own. */
export async function freshPage(browser: Browser): Promise<Page> {
  const context = await browser.newContext();
  return context.newPage();
}

/** Register through the UI and land in the workspace. */
export async function registerViaUi(
  page: Page,
  opts: { handle: string; name: string; companyName?: string }
): Promise<string> {
  const email = emailFor(opts.handle);
  await page.goto('/register');
  await page.getByLabel('Your name').fill(opts.name);
  await page.getByLabel('Email address').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);

  const ownCompany = page.getByLabel('I am setting up my own company');
  if (opts.companyName) {
    if (!(await ownCompany.isChecked())) await ownCompany.check();
    await page.getByLabel('Company name').fill(opts.companyName);
  } else if (await ownCompany.isChecked()) {
    await ownCompany.uncheck();
  }

  await page.getByRole('button', { name: 'Create account' }).click();
  return email;
}

export async function signIn(page: Page, email: string): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Email address').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  // `/profile` is a legitimate landing too: an unentitled free company gets the
  // Account setup view (§9.2), whose home *is* the profile. The real barrier is
  // the shell assertion below, not the URL — this pattern only exists to wait for
  // the redirect to have happened at all.
  await expect(page).toHaveURL(/\/(app|admin|profile)/);

  /*
   * Wait for the shell itself, not just the URL.
   *
   * `/login` and `/app` are in different route groups, so landing on `/app` mounts a
   * second AuthProvider, which refreshes on mount — and refresh tokens rotate. Until
   * that resolves the shell shows "Loading workspace…" and localStorage still holds
   * the *previous* token. A hard `goto` in that window loads a page whose stored token
   * has just been revoked, and the visitor is bounced to sign-in.
   *
   * The sidebar only renders once the refresh has resolved and the rotated token is
   * persisted, so this is the barrier that makes a following `goto` safe. (In-app links
   * stay inside one route group and never remount the provider, which is why a real
   * user does not hit this.)
   */
  await expect(page.locator('.cq-account__name')).toBeVisible();
}

/**
 * Accept an invite as a brand-new user: the page bounces an anonymous visitor to
 * register with `?next=` pointing back at the invite, which is the flow a real
 * invitee walks.
 */
export async function acceptInviteAsNewUser(
  page: Page,
  inviteUrl: string,
  opts: { handle: string; name: string }
): Promise<void> {
  await page.goto(inviteUrl);
  await page.getByRole('button', { name: 'Create an account' }).click();
  await expect(page).toHaveURL(/\/register\?next=/);

  await page.getByLabel('Your name').fill(opts.name);
  await page.getByLabel('Email address').fill(emailFor(opts.handle));
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();

  // Registration returns to the invite, now signed in.
  await expect(page).toHaveURL(/\/invite\//);
  await page.getByRole('button', { name: 'Accept invitation' }).click();
  await expect(page.getByText('Invitation accepted')).toBeVisible();
}

/** Read the one-time invite link the create-provider / create-client flow returns. */
export async function readInviteUrl(page: Page): Promise<string> {
  const field = page.getByLabel('Invite accept link');
  await expect(field).toBeVisible();
  const url = await field.inputValue();
  expect(url).toContain('/invite/');
  return url;
}

/**
 * Mark an address verified.
 *
 * There is no endpoint that does this without a link, and links are only logged
 * until Resend lands (its own Phase 6 bullet), so the fixture does it at the
 * database — the same reasoning as `makeSuperAdmin`. Requesting an *additional*
 * company requires verification unconditionally, so a test about that flow would
 * otherwise never get past the first refusal.
 */
export async function verifyEmail(email: string): Promise<void> {
  const db = new Client({ connectionString: databaseUrl() });
  await db.connect();
  try {
    const { rowCount } = await db.query(
      `update users set email_verified_at = coalesce(email_verified_at, now()) where email = $1`,
      [email]
    );
    if (rowCount === 0) throw new Error(`No user ${email} to verify`);
  } finally {
    await db.end();
  }
}

/**
 * Give a company the legal identity §3.1.1(6)'s duplicate check reads.
 *
 * Companies created before migration 0011 have none, and the only UI that sets
 * one is the additional-company request — so proving the *duplicate* path needs
 * an existing company that already carries an identifier.
 */
export async function setRegistrationIdentity(
  companyName: string,
  country: string,
  registrationId: string
): Promise<void> {
  const db = new Client({ connectionString: databaseUrl() });
  await db.connect();
  try {
    const { rowCount } = await db.query(
      `update companies set country = $2, registration_id = $3 where name = $1`,
      [companyName, country, registrationId]
    );
    if (rowCount === 0) throw new Error(`No company named "${companyName}" to identify`);
  } finally {
    await db.end();
  }
}
