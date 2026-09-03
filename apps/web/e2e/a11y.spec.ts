import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import {
  RUN,
  createProjectHeadless,
  makeSuperAdmin,
  provisionCompany,
  seedProjectSections,
  signIn,
} from './helpers';

// Derived rather than imported from `axe-core`: that package is a transitive dependency
// of @axe-core/playwright and is not hoisted here, so naming it directly would be an
// undeclared import that happens to resolve on some installs. Deriving it also cannot
// drift from the version actually installed.
type AxeViolation = Awaited<ReturnType<AxeBuilder['analyze']>>['violations'][number];

/**
 * The WCAG 2.2 AA gate, automated half.
 *
 * This replaces the exploratory inventory of 2026-08-20, which ran axe over 8
 * representative screens and printed what it found. Two things were wrong with that as
 * a gate rather than as a survey: it covered a fifth of the routes, and it reported
 * instead of failing — so the next regression would have been printed into a log nobody
 * reads. Every route the app has is here, and a violation fails the run.
 *
 * **What this cannot do, stated because the previous inventory's headline invited the
 * wrong conclusion.** axe asserts the automatable subset only. It cannot tell you that a
 * workflow is completable by keyboard, that a drag has a non-drag equivalent, or that a
 * validation error was announced rather than merely rendered. Those are separate specs
 * and they are the larger half of the gate. A green run here means "no machine-checkable
 * violation on any route", which is a real claim and a smaller one than "accessible".
 *
 * The token arithmetic is checked separately and offline in `packages/ui/src/contrast.ts`,
 * because axe can only measure pairings that a page happened to render while it looked —
 * it missed a 2.87:1 placeholder and a 1.59:1 input border for exactly that reason.
 *
 * Prerequisites are the parity spec's: Postgres up, migrated and seeded, API on :4000.
 *
 * **`/projects/[id]` is now covered**, and the debt this note used to record is paid:
 * Phase 7 gave the project sections content worth scanning, so the case below builds a
 * location tree, a photograph, a document and a closed diary day and sweeps each section
 * with real rows in it. A shell with three empty tabs would have passed and proved
 * nothing, which is why it waited.
 *
 * **Still not covered, recorded rather than left to be discovered:** `/portal/[id]` and
 * `/invite/[token]`, both of which need a row belonging to a *different* cast — a client
 * company and an invited stranger. Their parents are covered. `/portal/[id]` is the one
 * that matters most, because it is the only screen a client company ever sees.
 */

/** WCAG 2.2 AA and everything it builds on. Level AAA is deliberately not included. */
const WCAG_22_AA = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

const OWNER_CO = `Axe Contracts ${RUN}`;

/** Signed-out routes: reachable with no session, so they are checked with none. */
const PUBLIC_ROUTES = [
  '/',
  '/pricing',
  '/terms',
  '/privacy',
  '/login',
  '/register',
  '/forgot-password',
  // Both of these render their "this link is no good" state without a valid token, which
  // is a real state a user reaches and the only one reachable without minting a token.
  '/reset-password',
  '/verify-email',
];

/** Company-scoped routes, as an owner on a paid plan. */
const WORKSPACE_ROUTES = [
  '/app',
  '/projects',
  '/work',
  '/review',
  '/commercial',
  '/invoices',
  '/rates/cards',
  '/rates/roles',
  '/rates/templates',
  '/rates/resolve',
  '/network/providers',
  '/network/clients',
  '/network/engagements',
  '/company/members',
  '/portal',
  '/notifications',
  '/audit',
  /*
   * Phase 9's three (§38.1, §26, §39). The owner fixture is on `business`, which
   * carries `sustainability`, `carbon_engine` and `custom_factors` — so all three
   * render their real state rather than a feature lock, which is the only version
   * of them worth scanning.
   */
  '/sustainability',
  '/sustainability/factors',
  '/sustainability/settings',
  /*
   * Phase 11's two (§31). The week planner is the one screen in the product with
   * drag-and-drop, so it is the one whose axe sweep matters most — a drop target
   * that is a `<td>` with handlers and no accessible role is exactly the shape a
   * scanner catches and a human does not. Its *keyboard* half is
   * `keyboard.spec.ts`'s "a scheduled booking can be moved to another day without a
   * pointer", because axe cannot press a key.
   */
  '/schedule',
  '/schedule/fleet',
  '/settings',
  '/security',
  '/profile',
  '/plan',
];

/** The internal console. A separate cast, because a super admin is a different account. */
const ADMIN_ROUTES = [
  '/admin',
  '/admin/companies',
  '/admin/users',
  '/admin/plans',
  '/admin/access',
  '/admin/audit',
  '/admin/operations',
  '/admin/reporting',
  '/admin/settings',
];

/**
 * Renders violations so the failure names the fix rather than the count.
 *
 * The inventory's most useful output was not "58 nodes" but "in all 58 the foreground is
 * --cq-text-muted" — one cause, one line to change. A message that omits the colours and
 * the selectors makes the reader re-run the tool by hand to learn anything, so the
 * summary carries whatever axe knows about *why*, not just where.
 */
function describeViolations(where: string, violations: readonly AxeViolation[]): string {
  if (violations.length === 0) return '';
  const lines = violations.map((v) => {
    /*
     * Nodes are grouped by their reason, not listed.
     *
     * 21 contrast nodes on the landing page were three colour pairs used repeatedly, and
     * printing 21 lines (or worse, the first 6 of 21) hides that. The single most useful
     * sentence the 2026-08-20 inventory produced was "in all 58 nodes the foreground is
     * the same token" — one cause, one line to change — and it only appeared because a
     * human read the output and noticed. Grouping makes the tool say it.
     */
    const byReason = new Map<string, string[]>();
    for (const n of v.nodes) {
      const summary = (n.failureSummary ?? 'no summary').replace(/\s+/g, ' ').trim();
      // Collapse to the colour pair and ratio where axe reports one; that is the fix.
      const pair = /contrast of ([\d.]+) \(foreground color: (#\w+), background color: (#\w+)/.exec(summary);
      const reason = pair ? `${pair[2]} on ${pair[3]} = ${pair[1]}:1` : summary;
      byReason.set(reason, [...(byReason.get(reason) ?? []), n.target.join(' ')]);
    }
    const groups = [...byReason.entries()].map(
      ([reason, targets]) =>
        `      ${reason}  (${targets.length} node${targets.length === 1 ? '' : 's'})\n` +
        `        e.g. ${targets.slice(0, 3).join(' | ')}`,
    );
    return (
      `  [${v.impact ?? 'unknown'}] ${v.id}: ${v.help}  — ${v.nodes.length} node(s)\n` +
      `    ${v.helpUrl}\n${groups.join('\n')}`
    );
  });
  return `${where} has ${violations.length} WCAG 2.2 AA violation(s):\n${lines.join('\n')}`;
}

async function expectNoViolations(page: Page, where: string): Promise<void> {
  const results = await new AxeBuilder({ page }).withTags(WCAG_22_AA).analyze();
  // Asserted on a one-line-per-rule projection rather than on the violation objects
  // themselves. `toEqual([])` against the raw results prints axe's entire node tree —
  // every `any`/`all`/`none` check, every tag — which buried the message above under
  // hundreds of lines of diff and made the first failing run harder to read than the
  // console.log it replaced.
  const summary = results.violations.map((v) => `${v.id} × ${v.nodes.length}`);
  expect(summary, describeViolations(where, results.violations)).toEqual([]);
}

/**
 * Waits for the screen to have finished resolving before scanning.
 *
 * Scanning mid-load is the way this spec would go quietly useless: a page still showing
 * "Loading…" has almost no nodes, so it passes, and the screen it was supposed to check
 * is never looked at. Every workspace screen ends up with either real content or a
 * deliberate empty/error state, and all three are things to check — a spinner is not.
 */
async function settled(page: Page): Promise<void> {
  await page.waitForLoadState('networkidle');
  await expect(page.locator('text=/^Loading/').first()).toBeHidden({ timeout: 15_000 }).catch(() => {
    // A screen with no loading text at all never had one to hide. Not a failure.
  });
}

/**
 * Not serial, unlike the parity spec, and the difference is the point.
 *
 * Parity is one story where step 9 depends on step 8, so a failure there makes the rest
 * meaningless and skipping them is correct. Every case here is an independent route, and
 * a sweep that stops at the first violation is a sweep that reports one route per run —
 * which is how a 40-route gate turns into forty sequential fix-and-rerun cycles. The
 * first run of this spec did exactly that: the landing page failed and 39 routes were
 * skipped, so the actual state of the app was still unknown.
 */
test.describe.configure({ mode: 'default' });

test.describe('WCAG 2.2 AA — automated', () => {
  test.describe('signed out', () => {
    for (const route of PUBLIC_ROUTES) {
      test(`${route} has no violations`, async ({ page }) => {
        await page.goto(route);
        await settled(page);
        await expectNoViolations(page, route);
      });
    }

    /**
     * A form that has been submitted and refused.
     *
     * This state is unreachable by navigation and is where accessible forms usually
     * fail: the error is painted next to the field and never associated with it, so a
     * screen reader user hears a labelled input with no indication it is invalid and no
     * route to the message. Checking only the pristine form is checking the easy half.
     */
    test('/login shows its refusal accessibly', async ({ page }) => {
      await page.goto('/login');
      await page.getByLabel('Email address').fill('nobody@crewquo.test');
      await page.getByLabel('Password').fill('wrong-password-on-purpose');
      await page.getByRole('button', { name: 'Sign in' }).click();
      await expect(page.getByRole('alert')).toBeVisible();
      await expectNoViolations(page, '/login (credentials refused)');
    });

    /** Client-side validation, which is a different code path from a server refusal. */
    test('/register shows its validation accessibly', async ({ page }) => {
      await page.goto('/register');
      await page.getByRole('button', { name: 'Create account' }).click();
      await settled(page);
      await expectNoViolations(page, '/register (submitted empty)');
    });
  });

  test.describe('as a company owner', () => {
    let page: Page;

    let ownerEmail: string;

    test.beforeAll(async ({ browser }) => {
      ownerEmail = await provisionCompany({
        handle: `axe-owner-${RUN}`,
        name: 'Axe Owner',
        companyName: OWNER_CO,
        planId: 'business',
      });
      page = await (await browser.newContext()).newPage();
      await signIn(page, ownerEmail);
    });

    test.afterAll(async () => {
      await page.close();
    });

    for (const route of WORKSPACE_ROUTES) {
      test(`${route} has no violations`, async () => {
        await page.goto(route);
        await settled(page);
        await expectNoViolations(page, route);
      });
    }

    /**
     * A drawer, checked because it is a focus trap by construction and because §40 puts
     * side panels at the centre of the information architecture — so whatever is wrong
     * with one drawer is wrong with the product's main editing surface.
     */
    test('a create drawer has no violations while open', async () => {
      // /rates/roles, not /projects. The first version of this test used /projects and
      // failed looking for a dialog that is not there: creating a project swaps an inline
      // <Section> into the page rather than opening a panel. Worth recording, because the
      // test was wrong about the product and the product is not wrong — but it does mean
      // "the create surface" is two different patterns depending on the screen.
      await page.goto('/rates/roles');
      await settled(page);
      await page.getByRole('button', { name: 'New role' }).click();
      await expect(page.getByRole('dialog')).toBeVisible();
      await expectNoViolations(page, '/rates/roles (create drawer open)');
    });

    /**
     * `/projects/[id]`, with every Phase 7 section holding real rows.
     *
     * This is the screen the note at the top of this file owed a case, and it is the
     * densest surface in the product: a section rail, a figure strip, a gallery of
     * images, three tables and four drawers. Scanning it empty would pass and prove
     * nothing, so the fixture puts something in each section first — which is also
     * why this is one test rather than four: the rows are built once and each section
     * is swept against them.
     */
    test('/projects/[id] has no violations in any project section', async () => {
      const projectId = await createProjectHeadless(ownerEmail, `Axe project ${RUN}`);
      await seedProjectSections(ownerEmail, projectId);

      await page.goto(`/projects/${projectId}`);
      await settled(page);
      await expectNoViolations(page, '/projects/[id] (overview)');

      for (const section of [
        'Locations',
        'Site diary',
        'Photos & evidence',
        'Documents',
        // Phase 9's section, swept with the rest: it is a figure strip, four tables
        // and a drawer, and its densest surface — the trace — is behind a toggle
        // that the sweep below opens.
        'Sustainability',
        // Phase 10's, which is two tables, a `details` disclosure and two drawers.
        // Swept empty here and with rows in the case below it: the empty state is
        // the one a reader meets first and the one nobody remembers to check.
        'Reports',
      ]) {
        await page
          .getByRole('navigation', { name: 'Project' })
          .getByRole('button', { name: section })
          .click();
        await settled(page);
        await expectNoViolations(page, `/projects/[id] (${section})`);
      }

      /*
       * Assets is swept last and **expanded**, because its densest state is not the
       * one it opens in: the movement ledger lives in a `colspan` row under the
       * register, and a table nested inside another table's cell is exactly the
       * shape that breaks header association. Scanning it collapsed would sweep a
       * table that is not in the DOM.
       */
      await page
        .getByRole('navigation', { name: 'Project' })
        .getByRole('button', { name: 'Assets & materials' })
        .click();
      await settled(page);
      await page.getByRole('button', { name: 'Movements' }).first().click();
      await settled(page);
      await expectNoViolations(page, '/projects/[id] (Assets & materials)');

      /*
       * Phase 10's two drawers, which are the densest forms in the product: the
       * generate form is a pair of selects and a fieldset of checkboxes, and the
       * sign-off form is seven fields including two multi-line ones. A modal is
       * also the shape most likely to be wrong about focus and about labelling,
       * which is what makes scanning it worth the two extra clicks.
       */
      await page
        .getByRole('navigation', { name: 'Project' })
        .getByRole('button', { name: 'Reports' })
        .click();
      await settled(page);
      await page.getByRole('button', { name: 'Generate a report' }).click();
      await settled(page);
      await expectNoViolations(page, '/projects/[id] (Reports — generate)');
      await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();

      await page.getByRole('button', { name: 'Capture a sign-off' }).click();
      await settled(page);
      await expectNoViolations(page, '/projects/[id] (Reports — sign-off)');
      await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();

      /*
       * And Sustainability with its working shown, for the reason Assets is swept
       * expanded: the calculation trace is the densest table in the phase and it is
       * not in the DOM until somebody asks for it.
       */
      await page
        .getByRole('navigation', { name: 'Project' })
        .getByRole('button', { name: 'Sustainability' })
        .click();
      await settled(page);
      await page.getByRole('button', { name: 'Show the working' }).click();
      await settled(page);
      await expectNoViolations(page, '/projects/[id] (Sustainability, working shown)');
    });

    /**
     * The mobile layout, which is a different DOM and not merely a narrower one: the
     * sidebar collapses behind a toggle and the tables reflow. A gate that only ever
     * looks at 1280px has not looked at the layout most tablet-on-site users get.
     */
    test('the narrow layout has no violations', async () => {
      await page.setViewportSize({ width: 390, height: 844 });
      try {
        await page.goto('/app');
        await settled(page);
        await expectNoViolations(page, '/app (390px)');
      } finally {
        // Restored even on failure: the page is shared, so leaving it at 390px would
        // silently re-run every later route in the mobile layout and attribute any
        // finding to the wrong viewport.
        await page.setViewportSize({ width: 1280, height: 720 });
      }
    });
  });

  /**
   * One sign-in for the whole console, and this one is not an optimisation.
   *
   * Super admins hold a mandatory second factor (the 2026-08-19 access decision), and a
   * TOTP code is consumed by the step that accepts it. Signing in before each of nine
   * routes means nine codes inside a couple of 30-second windows, so a later sign-in
   * meets its own spent code, burns the helper's one-window retry, and lands back on
   * /login — which is what happened to /admin/users on the first full run while its
   * eight siblings passed. A flake that only appears in the middle of a run is the kind
   * that gets re-run until it is green and then believed.
   */
  test.describe('as a super admin', () => {
    let page: Page;

    test.beforeAll(async ({ browser }) => {
      const email = await provisionCompany({
        handle: `axe-admin-${RUN}`,
        name: 'Axe Admin',
        companyName: `Axe Platform ${RUN}`,
        planId: 'business',
      });
      await makeSuperAdmin(email);
      page = await (await browser.newContext()).newPage();
      await signIn(page, email);
    });

    test.afterAll(async () => {
      await page.close();
    });

    for (const route of ADMIN_ROUTES) {
      test(`${route} has no violations`, async () => {
        await page.goto(route);
        await settled(page);
        await expectNoViolations(page, route);
      });
    }
  });
});
