import { expect, test, type Page } from '@playwright/test';
import {
  RUN,
  amendSeededDiaryAgain,
  createProjectHeadless,
  freshPage,
  provisionCompany,
  seedProjectSections,
  signIn,
} from './helpers';

/**
 * Phase 10 through the browser (§29, §34).
 *
 * `verify:e2e` proves the seal, the two audiences and the supersession chain
 * against the API. This proves the things only a rendered page can be wrong about,
 * and each of them is a rule the packet states about a *screen*:
 *
 *  1. **The staleness banner is on the screen and not in the file.** It is the
 *     correction the acceptance script forced — a live comparison inside a frozen
 *     document makes the document a function of the present — so the sentence has
 *     to appear *somewhere*, and this is the only place it can.
 *  2. **"Share with the client" is not offered on an internal document.** Not
 *     offered-and-disabled: an internal snapshot is not a shareable one that
 *     happens to be switched off, and the database refuses the combination.
 *  3. **A superseded report is still openable**, because whoever holds the old
 *     numbers has to be able to see the document they were sent.
 *  4. **A sign-off cannot be edited from the screen** — the only control on a
 *     captured signature is "capture a correction", which makes a second row.
 *
 * Serial, sharing one signed-in page: the fixture is provisioned once and the
 * assertions read it, which is the shape `project-sustainability.spec.ts` uses.
 */
test.describe.configure({ mode: 'serial' });

const OWNER_CO = `Report Owner ${RUN}`;

let page: Page;
let ownerEmail: string;
let projectId: string;

test.beforeAll(async ({ browser }) => {
  ownerEmail = await provisionCompany({
    handle: `rep-owner-${RUN}`,
    name: 'Report Owner',
    companyName: OWNER_CO,
    planId: 'business',
  });
  projectId = await createProjectHeadless(ownerEmail, `Reporting ${RUN}`);
  await seedProjectSections(ownerEmail, projectId);

  page = await freshPage(browser);
  await signIn(page, ownerEmail);
});

test.afterAll(async () => {
  await page.close();
});

async function openReports(target: Page): Promise<void> {
  await target.goto(`/projects/${projectId}`);
  await target
    .getByRole('navigation', { name: 'Project' })
    .getByRole('button', { name: 'Reports' })
    .click();
}

/**
 * Generate a document and land on the detail drawer the app opens for it.
 *
 * The screen swaps one dialog for another — the generate form closes and the new
 * document opens — because the thing a person wants immediately after pressing
 * Generate is the document, not the list. So the wait is for the seal, which only
 * the detail drawer shows.
 */
async function generate(audience: 'Internal' | 'For the client'): Promise<void> {
  await page.getByRole('button', { name: 'Generate a report' }).click();
  const drawer = page.getByRole('dialog');
  await expect(drawer).toBeVisible();
  await drawer
    .getByRole('combobox', { name: /^Reader/ })
    .selectOption(audience === 'Internal' ? 'INTERNAL' : 'CLIENT');
  await drawer.getByRole('button', { name: 'Generate', exact: true }).click();
  await expect(page.getByRole('dialog').getByText('Seal')).toBeVisible();
}

test.describe('the project Reports section', () => {
  test('offers the documents this build can actually produce', async () => {
    await openReports(page);
    await page.getByRole('button', { name: 'Generate a report' }).click();

    const drawer = page.getByRole('dialog');
    await expect(drawer.getByRole('combobox', { name: /^Document/ })).toBeVisible();

    /*
     * Packet finding 11 on the screen. §29.2 lists variations and incidents;
     * Phase 11 builds the first and nothing in the plan builds the second, so
     * neither is offered as a toggle. A completion pack that could render "no
     * variations" about a feature nobody has built is an invented fact, and this
     * is where somebody would put the checkbox back.
     */
    await drawer.getByRole('combobox', { name: /^Document/ }).selectOption('EVIDENCE_PACK');
    await expect(drawer.getByText('Site diary')).toBeVisible();
    /*
     * **Rewritten on 2026-09-03, and the rewrite is the gate working.**
     *
     * This read `toHaveCount(0)` for Variations until Phase 11, and it failed on the
     * commit that shipped §30.1 — which is exactly what `availableFrom: 11` was for.
     * The rule being asserted is *"this drawer offers only what the build can
     * actually produce"*, not *"Variations do not exist"*, so the two keys now sit
     * on opposite sides of the same assertion:
     *
     *  - `Variations` IS offered, because Phase 11 built the records behind it.
     *  - `Incidents` is NOT, and never will be on this evidence: §29.2 names them and
     *    **no table for them exists anywhere in the plan's DDL**, which is why
     *    `PACK_INCIDENTS` carries `availableFrom: null` rather than a guessed phase.
     *
     * The thing this protects is unchanged: a completion pack that asserts *no
     * incidents* about a record class the product does not keep is an invented fact,
     * and it is the most quotable line in the document during a dispute.
     */
    await expect(drawer.getByText('Variations')).toBeVisible();
    await expect(drawer.getByText('Incidents')).toHaveCount(0);

    await drawer.getByRole('button', { name: 'Cancel' }).click();
  });

  test('generates a client copy and lets it be shared', async () => {
    await openReports(page);
    await generate('For the client');

    const detail = page.getByRole('dialog');
    await expect(detail.getByText('The client', { exact: true })).toBeVisible();
    // The seal, printed where a reader with two copies can compare them.
    await expect(detail.getByText('Seal')).toBeVisible();
    await detail.getByRole('button', { name: 'Close', exact: true }).click();

    const table = page.getByRole('table', { name: 'Generated reports' });
    await expect(table.getByRole('button', { name: 'Share with client' })).toBeVisible();
    await table.getByRole('button', { name: 'Share with client' }).click();
    await expect(table.getByText('Shared')).toBeVisible();
  });

  test('never offers to share an internal document', async () => {
    await openReports(page);
    await generate('Internal');
    await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click();

    const table = page.getByRole('table', { name: 'Generated reports' });
    const internalRow = table.getByRole('row').filter({ hasText: 'Internal' });
    await expect(internalRow.getByText('Not shareable')).toBeVisible();
    // Absent, not disabled: an internal snapshot names the subcontractors, and
    // "shareable but switched off" would be one click from a leak.
    await expect(internalRow.getByRole('button', { name: 'Share with client' })).toHaveCount(0);
  });

  test('reports a changed source beside the document, and keeps the document', async () => {
    /*
     * The correction the acceptance script forced. The sentence cannot be printed
     * inside the PDF — a live comparison inside a frozen document makes the
     * document a function of the present — so this screen is the only place it can
     * appear, and it has to say that the document is still correct.
     */
    await openReports(page);
    await generate('Internal');
    await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click();

    await amendSeededDiaryAgain(ownerEmail, projectId, 'Lift out of service 11:00-13:00');

    await openReports(page);
    const table = page.getByRole('table', { name: 'Generated reports' });
    await table.getByRole('button', { name: 'Open' }).first().click();

    const detail = page.getByRole('dialog');
    await expect(
      detail.getByText(/records behind this document have changed since it was generated/i)
    ).toBeVisible();
    await expect(detail.getByText(/has been amended since this report was generated/i)).toBeVisible();
    await expect(
      detail.getByText(/The document itself is unchanged and still shows the figures/i)
    ).toBeVisible();
    await detail.getByRole('button', { name: 'Close', exact: true }).click();
  });

  test('keeps a superseded document openable', async () => {
    /*
     * Regenerating after the amendment above produces a new document — the
     * previous one cited an earlier diary revision — and the one it replaces is
     * kept rather than removed. Somebody may already be holding the old numbers,
     * and they have to be able to see the document they were sent.
     */
    await openReports(page);
    await generate('Internal');
    await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click();

    const history = page.getByText(/superseded or voided document/);
    await expect(history).toBeVisible();
    await history.click();

    const table = page.getByRole('table', { name: 'Superseded reports' });
    await expect(table.getByText('Superseded').first()).toBeVisible();
    await table.getByRole('button', { name: 'Open' }).first().click();
    await expect(page.getByRole('dialog').getByText('Seal')).toBeVisible();
    await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click();
  });
});

test.describe('client sign-off', () => {
  test('captures a signature and offers no way to edit it', async () => {
    await openReports(page);
    await page.getByRole('button', { name: 'Capture a sign-off' }).click();

    const drawer = page.getByRole('dialog');
    await drawer.getByRole('textbox', { name: /^Signed by/ }).fill('Dana Whitfield');
    await drawer.getByRole('textbox', { name: /^Their role/ }).fill('Facilities Manager');
    await drawer.getByRole('button', { name: 'Record sign-off' }).click();
    await expect(drawer).toBeHidden();

    const table = page.getByRole('table', { name: 'Client sign-offs' });
    await expect(table.getByText('Dana Whitfield')).toBeVisible();
    await expect(table.getByText('Current')).toBeVisible();

    // The only control on a captured signature. §34 is append-only, and an "Edit"
    // button here would be the single change that makes every other signature in
    // the product worth less.
    await expect(table.getByRole('button', { name: 'Capture a correction' })).toBeVisible();
    await expect(table.getByRole('button', { name: /^Edit/ })).toHaveCount(0);
    await expect(table.getByRole('button', { name: /^Delete/ })).toHaveCount(0);
  });

  test('a correction requires a reason and keeps both signatures', async () => {
    await openReports(page);
    await page.getByRole('button', { name: 'Capture a correction' }).click();

    const drawer = page.getByRole('dialog');
    await drawer.getByRole('textbox', { name: /^Signed by/ }).fill('Dana Whitfield-Rowe');
    // Refused until the reason is given: it goes on the permanent record.
    await expect(drawer.getByRole('button', { name: 'Record sign-off' })).toBeDisabled();
    await drawer.getByRole('textbox', { name: /^Why it is being signed again/ }).fill('Signer name corrected');
    await drawer.getByRole('button', { name: 'Record sign-off' }).click();
    await expect(drawer).toBeHidden();

    // Both rows, and neither replaced the other: §34 keeps a sign-off and the one
    // it supersedes, with their signatures.
    const rows = page.getByRole('table', { name: 'Client sign-offs' }).getByRole('row');
    await expect(rows).toHaveCount(3); // header + two signatures
    await expect(rows.filter({ hasText: 'Dana Whitfield-Rowe' }).getByText('Current')).toBeVisible();
    await expect(rows.filter({ hasText: 'Superseded' })).toHaveCount(1);
    // The reason is on the row that supersedes, because that is the act it explains.
    await expect(
      rows.filter({ hasText: 'Dana Whitfield-Rowe' }).getByText(/Signer name corrected/)
    ).toBeVisible();
  });
});
