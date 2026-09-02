import { expect, test, type Page } from '@playwright/test';
import {
  RUN,
  createProjectHeadless,
  freshPage,
  inviteAndAccept,
  provisionCompany,
  registerHeadless,
  seedProjectSections,
  setBundle,
  signIn,
} from './helpers';

/**
 * Phase 9 through the browser (§28, §38.1, §39).
 *
 * `verify:e2e` proves the arithmetic against the API; this proves the four things
 * only a rendered page can be wrong about, and each of them is a rule the packet
 * states about a *screen* rather than about a payload:
 *
 *  1. **The two headlines are side by side and there is no third figure.** §27.5
 *     forbids a net headline, and the way one appears is somebody adding it to a
 *     page, not to a type. Asserted over the rendered text.
 *  2. **A supervisor sees masses and no carbon at all** — absent keys, not zeros.
 *     The API omits them; this asserts nothing renders `0.00 tCO₂e` anyway.
 *  3. **The methodology warning is on the screen with the figure**, which is where
 *     §27.4 says it must be — *"in the UI and in the report, not only in an
 *     appendix"*.
 *  4. **The completeness score is itemised**, because a bare percentage arriving
 *     on projects nobody edited is the regression packet finding 5 predicts.
 *
 * Serial, sharing one signed-in page: the fixture is provisioned once and the
 * assertions read it, which is the shape `project-assets.spec.ts` uses.
 */
test.describe.configure({ mode: 'serial' });

const OWNER_CO = `Sustain Owner ${RUN}`;

let page: Page;
let ownerEmail: string;
let projectId: string;

test.beforeAll(async ({ browser }) => {
  ownerEmail = await provisionCompany({
    handle: `sus-owner-${RUN}`,
    name: 'Sustain Owner',
    companyName: OWNER_CO,
    planId: 'business',
  });
  projectId = await createProjectHeadless(ownerEmail, `Sustainability ${RUN}`);
  await seedProjectSections(ownerEmail, projectId);

  page = await freshPage(browser);
  await signIn(page, ownerEmail);
});

test.afterAll(async () => {
  await page.close();
});

async function openSection(target: Page, name: string): Promise<void> {
  await target.goto(`/projects/${projectId}`);
  await target.getByRole('navigation', { name: 'Project' }).getByRole('button', { name }).click();
}

test.describe('the project Sustainability section', () => {
  test('renders both headlines, side by side and never netted', async () => {
    await openSection(page, 'Sustainability');

    await expect(page.getByText('Project GHG emissions')).toBeVisible();
    await expect(page.getByText('Estimated avoided emissions')).toBeVisible();

    /*
     * The negative assertion is the one that matters. A "net" or "total carbon"
     * figure is what §27.5 forbids and locked decision #17 makes uncompilable in
     * the engine — but a page can still add two numbers it was handed separately,
     * and no type stops that.
     */
    const body = (await page.locator('main').innerText()).toLowerCase();
    expect(body).not.toContain('net emissions');
    expect(body).not.toContain('net carbon');
    expect(body).not.toContain('total carbon');
  });

  test('shows the methodology warning beside the avoided figure, not in an appendix', async () => {
    await openSection(page, 'Sustainability');
    await expect(
      page.getByText(/not a reduction in this project’s Scope 1, 2 or 3 emissions/i)
    ).toBeVisible();
  });

  test('labels which basis electricity is reported on', async () => {
    // sustainability.md §13.1, built as recommended: location-based only, and said
    // out loud rather than left for a reader to assume the favourable one.
    await openSection(page, 'Sustainability');
    await expect(page.getByText(/location-based basis/i)).toBeVisible();
  });

  test('itemises the completeness score rather than publishing a bare percentage', async () => {
    await openSection(page, 'Sustainability');

    const table = page.getByRole('table', { name: 'Data completeness components' });
    await expect(table).toBeVisible();
    // All five, including the fifth Phase 8 could not compute.
    await expect(table.getByRole('row')).toHaveCount(6); // header + five
    await expect(table.getByText('Avoided mass on a product-specific factor')).toBeVisible();
  });

  test('names its gaps in plain language', async () => {
    await openSection(page, 'Sustainability');
    // The stored desks have no final destination, which is Phase 8's sentence,
    // rendered unchanged rather than regenerated in Phase 9's words.
    await expect(page.getByText(/Final destination for .* is currently unknown/i)).toBeVisible();
  });

  test('shows the working, and every row names its factor and version', async () => {
    await openSection(page, 'Sustainability');
    await page.getByRole('button', { name: 'Show the working' }).click();

    const trace = page.getByRole('table', { name: 'Carbon calculations' });
    await expect(trace).toBeVisible();
    await expect(trace.getByText(/CrewQuo Test Factors 2026/).first()).toBeVisible();
    await expect(trace.getByText(/Reporting year 2026/).first()).toBeVisible();
  });

  test('records an activity through the drawer and prices it', async () => {
    await openSection(page, 'Sustainability');
    await page.getByRole('button', { name: 'Record activity' }).click();

    const drawer = page.getByRole('dialog');
    await expect(drawer).toBeVisible();
    await drawer.getByLabel('What happened').selectOption('FUEL');
    // The form asks for the measure the chosen kind is priced from, and only that.
    await expect(drawer.getByLabel('Litres')).toBeVisible();
    await expect(drawer.getByLabel('Distance (km)')).toHaveCount(0);

    await drawer.getByLabel('Date').fill('2026-03-05');
    await drawer.getByLabel('Litres').fill('180');
    await drawer.getByLabel('Fuel type').fill('DIESEL');
    await drawer.getByRole('button', { name: 'Record' }).click();

    await expect(page.getByRole('table', { name: 'Project activities' })).toContainText('Fuel');
    // 180 litres, in the unit the person typed — not converted into something else.
    await expect(page.getByRole('table', { name: 'Project activities' })).toContainText('180 litre');
  });
});

test.describe('the omitted keys (§4)', () => {
  test('a supervisor sees the mass balance and no carbon at all', async ({ browser }) => {
    const supervisorEmail = await registerHeadless({
      handle: `sus-sup-${RUN}`,
      name: 'Sustain Supervisor',
    });
    // Invited into the owner's company and given the Supervisor bundle, which
    // deliberately carries `sustainability.write` and NOT `sustainability.read`.
    await inviteAndAccept(ownerEmail, supervisorEmail);
    await setBundle(OWNER_CO, supervisorEmail, 'supervisor');

    const supervisorPage = await freshPage(browser);
    try {
      await signIn(supervisorPage, supervisorEmail);
      await supervisorPage.goto(`/projects/${projectId}`);
      await supervisorPage
        .getByRole('navigation', { name: 'Project' })
        .getByRole('button', { name: 'Assets & materials' })
        .click();

      // The masses render — Phase 8's mass-only view is theirs.
      await expect(supervisorPage.getByText('Handled')).toBeVisible();

      await supervisorPage
        .getByRole('navigation', { name: 'Project' })
        .getByRole('button', { name: 'Sustainability' })
        .click();

      await expect(
        supervisorPage.getByText(/need the sustainability permission/i)
      ).toBeVisible();
      /*
       * The assertion the whole "omitted rather than nulled" rule exists for: a
       * `projectEmissionsKgCo2e: null` would let this page render "0.00 tCO₂e",
       * which reads as a measured nothing rather than as a figure this person was
       * not shown.
       */
      const text = await supervisorPage.locator('main').innerText();
      expect(text).not.toContain('tCO₂e');
      expect(text).not.toContain('kgCO₂e');
    } finally {
      await supervisorPage.close();
    }
  });
});

test.describe('the organisation dashboard (§38.1)', () => {
  test('lists every project with a click-through, and never nets the two figures', async () => {
    await page.goto('/sustainability');

    await expect(page.getByRole('heading', { name: 'Sustainability' })).toBeVisible();
    const projects = page.getByRole('table', { name: 'Sustainability by project' });
    await expect(projects).toBeVisible();
    await expect(projects.getByRole('link', { name: `Sustainability ${RUN}` })).toBeVisible();

    const body = (await page.locator('main').innerText()).toLowerCase();
    expect(body).not.toContain('net emissions');
    expect(body).not.toContain('total carbon');
  });

  test('states that rates are shares of allocated mass, with pending shown beside them', async () => {
    await page.goto('/sustainability');
    // §28.2: "hiding pending mass in a denominator is how a diversion rate becomes
    // a lie." The sentence is the screen's half of that rule.
    await expect(page.getByText(/shares of the .* that has reached a final destination/i)).toBeVisible();
  });

  test('clicks through to the project section behind a figure', async () => {
    await page.goto('/sustainability');
    await page
      .getByRole('table', { name: 'Sustainability by project' })
      .getByRole('link', { name: `Sustainability ${RUN}` })
      .click();
    await expect(page).toHaveURL(new RegExp(`/projects/${projectId}\\?section=sustainability`));
    await expect(page.getByText('Project GHG emissions')).toBeVisible();
  });
});

test.describe('assumptions (§39)', () => {
  test('says what each displacement choice means, where it is chosen', async () => {
    await page.goto('/sustainability/settings');

    await expect(page.getByRole('heading', { name: 'Assumptions' })).toBeVisible();
    const control = page.getByLabel('Default assumption');

    await control.selectOption('UNKNOWN');
    await expect(page.getByText(/No avoided-emissions claim is made for any reuse/i)).toBeVisible();

    await control.selectOption('ASSUMED_FULL');
    // The sentence standing between an unread tick and a published claim.
    await expect(
      page.getByText(/largest number the product will publish/i)
    ).toBeVisible();
  });

  test('refuses a user-defined basis with no percentage, before the request is made', async () => {
    await page.goto('/sustainability/settings');
    await page.getByLabel('Default assumption').selectOption('USER_DEFINED');
    await page.getByLabel('Displacement percentage').fill('');
    await expect(page.getByText(/needs a percentage/i)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Save' })).toBeDisabled();
  });
});

test.describe('emission factors (§26)', () => {
  test('lists the imported set with its source and what cites it', async () => {
    await page.goto('/sustainability/factors');

    const sets = page.getByRole('table', { name: 'Emission factor sets' });
    await expect(sets).toBeVisible();
    await expect(sets.getByText(/CrewQuo Test Factors 2026/)).toBeVisible();
    // Named as synthetic, so it cannot be mistaken for published data.
    await expect(sets.getByText('CrewQuo — synthetic test data').first()).toBeVisible();
  });

  test('shows the factor rows behind a set', async () => {
    await page.goto('/sustainability/factors');
    await page
      .getByRole('table', { name: 'Emission factor sets' })
      .getByRole('button', { name: 'View factors' })
      .first()
      .click();

    const drawer = page.getByRole('dialog');
    await expect(drawer).toBeVisible();
    await expect(drawer.getByRole('table', { name: 'Factors' })).toContainText('Diesel');
  });

  test('lists the product factor and says how well it is known', async () => {
    await page.goto('/sustainability/factors');
    const products = page.getByRole('table', { name: 'Product carbon factors' });
    await expect(products).toBeVisible();
    await expect(products.getByText('Verified EPD')).toBeVisible();
    await expect(products.getByText('72 / item')).toBeVisible();
  });
});
