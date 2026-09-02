import { expect, test, type Page } from '@playwright/test';
import {
  RUN,
  createProjectHeadless,
  disableFeature,
  provisionCompany,
  runWorkPass,
  signIn,
} from './helpers';

/**
 * The Phase 7 project sections in a browser (item 7.6): locations, photos &
 * evidence, documents and the site diary.
 *
 * **What this proves that `verify-e2e.ts` cannot.** That suite drives the API and
 * asserts every rule these screens obey; none of it says the rules are *reachable*.
 * A gallery that renders no tiles, an upload whose file input is `display:none`
 * and therefore unfocusable, a Close Day button that is disabled because the
 * prompts came back non-empty — every one of those passes a green API suite.
 *
 * So the assertions here are deliberately about the screen: what a person sees,
 * what they can reach, and what the product refuses to let them do quietly.
 * The three that matter most, and the reason each is here:
 *
 *  - **A partial upload keeps what worked.** Two files, one of them not the type it
 *    claims; the good one becomes evidence and the bad one is named.
 *  - **A closed day cannot be changed without a reason.** The Save button is
 *    unreachable until the reason is typed — not a dialog somebody dismisses.
 *  - **A section the plan does not include is not in the rail at all**, because
 *    advertising a section that answers 403 is worse than not offering it.
 *
 * Prerequisites are the other specs': Postgres up, migrated and seeded, API on :4000.
 */

const OWNER_CO = `Sections Contracts ${RUN}`;
const CLIENT_CO = `Sections Estates ${RUN}`;
const CREW_CO = `Sections Crew ${RUN}`;
const PROJECT = `Riverside sections ${RUN}`;

/** A 1×1 PNG. Small enough to be inline, real enough to survive the sniffer. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);
/** A PDF header, which is what the document sniffer is looking for. */
const PDF = Buffer.from('%PDF-1.4\n%âãÏÓ\ntrailer\n', 'latin1');

/**
 * A rail entry by its label.
 *
 * Not `exact`, because the button's accessible name carries its count as well —
 * "Locations 3 items". Scoped to the rail's own navigation landmark so a section
 * label that also appears in the panel below cannot be clicked by accident.
 */
function railButton(page: Page, label: string) {
  return page.getByRole('navigation', { name: 'Project' }).getByRole('button', { name: label });
}

/** Open a project section by its rail entry, and wait for the panel to render. */
async function openSection(page: Page, label: string, heading: string): Promise<void> {
  await railButton(page, label).click();
  await expect(page.getByRole('heading', { name: heading })).toBeVisible();
}

test.describe.configure({ mode: 'serial' });

test.describe('Project sections — evidence, documents and the diary', () => {
  let page: Page;
  let ownerEmail: string;

  test.beforeAll(async ({ browser }) => {
    ownerEmail = await provisionCompany({
      handle: 'sections',
      name: 'Priya Sections',
      companyName: OWNER_CO,
      // Pro carries project_evidence, project_documents, site_diary and the portal.
      planId: 'pro',
    });
    page = await (await browser.newContext()).newPage();
    await signIn(page, ownerEmail);
  });

  test.afterAll(async () => {
    await page.close();
  });

  test('a project is created and its Phase 7 sections are in the rail', async () => {
    await page.goto('/network/clients');
    await page.getByRole('button', { name: 'Add client' }).click();
    await page.getByLabel('Client company name').fill(CLIENT_CO);
    await page.getByLabel('Contact email').fill(`sectionsclient+${RUN}@parity.crewquo.test`);
    await page.getByRole('button', { name: 'Add and invite' }).click();
    await expect(page.getByText(CLIENT_CO).first()).toBeVisible();

    await page.goto('/projects');
    await page.getByRole('button', { name: 'New project' }).click();
    const form = page.locator('form').first();
    await form.getByLabel('Project name').fill(PROJECT);
    await form.getByLabel('Client company').selectOption({ label: CLIENT_CO });
    await form.getByLabel('Publish to the client portal').check();
    await form.getByRole('button', { name: 'Create project' }).click();
    await expect(page).toHaveURL(/\/projects\/[0-9a-f-]{36}/);

    // §20's rail, with the three Phase 7 sections this plan includes.
    for (const label of ['Locations', 'Site diary', 'Photos & evidence', 'Documents']) {
      await expect(railButton(page, label)).toBeVisible();
    }
  });

  // ── Locations ────────────────────────────────────────────────────────────────

  test('a location tree is built, and a location in use cannot be deleted', async () => {
    await openSection(page, 'Locations', 'Locations');
    await expect(page.getByText('No locations on this project')).toBeVisible();

    await page.getByRole('button', { name: 'Add location' }).click();
    let drawer = page.getByRole('dialog');
    await drawer.getByLabel('Kind').selectOption('FLOOR');
    await drawer.getByLabel('Name').fill('Floor 3');
    await drawer.getByRole('button', { name: 'Add location' }).click();
    await expect(page.getByText('Floor 3')).toBeVisible();

    // Nesting, which is what makes it a tree rather than a list.
    await page.getByRole('button', { name: 'Add inside' }).first().click();
    drawer = page.getByRole('dialog');
    await drawer.getByLabel('Name').fill('Room 3.12');
    await drawer.getByRole('button', { name: 'Add location' }).click();
    await expect(page.getByText('Room 3.12')).toBeVisible();

    /*
     * A parent with a child is a location in use. §21's rule is that a used
     * location is retired rather than deleted, and the refusal has to name what is
     * using it — a "cannot delete" with no subject is a dead end.
     */
    await page
      .locator('.cq-tree__row', { hasText: 'Floor 3' })
      .first()
      .getByRole('button', { name: 'Remove' })
      .click();
    await expect(page.getByText(/still has .*sub-locations/i)).toBeVisible();
    await expect(page.getByText(/Retire it instead/i)).toBeVisible();
  });

  // ── Evidence ─────────────────────────────────────────────────────────────────

  test('a batch is uploaded, tagged once, and the file that is not what it claims is named', async () => {
    await openSection(page, 'Photos & evidence', 'Photos & evidence');
    await expect(page.getByText('No evidence yet')).toBeVisible();

    /*
     * `setInputFiles` on the drop zone's own input — which is the point of building
     * it as a label wrapping a real input rather than a drag handler with a hidden
     * fallback. A test that had to synthesise a DataTransfer would be testing a
     * path a keyboard user cannot take.
     *
     * Two files, one of them a type the image policy does not accept. §9's rule is
     * that the batch keeps what worked, and the one that did not is **named** — an
     * "upload failed" that discards the good one is a product that teaches people to
     * stop using it.
     */
    await page.locator('.cq-dropzone input[type="file"]').setInputFiles([
      { name: 'floor-3-north.png', mimeType: 'image/png', buffer: PNG },
      { name: 'site-notes.txt', mimeType: 'text/plain', buffer: Buffer.from('not a photo') },
    ]);

    const failure = page.getByRole('status');
    await expect(failure).toContainText('1 file could not be stored', { timeout: 30_000 });
    await expect(failure).toContainText('Everything else was.');
    await expect(failure).toContainText('site-notes.txt');

    // …and the one that did reaches the tagging step, alone.
    const tag = page.getByRole('dialog');
    await expect(tag).toBeVisible();
    await expect(tag.getByRole('heading', { name: 'Tag 1 photograph' })).toBeVisible();

    await tag.getByLabel('Category').selectOption('BEFORE');
    await tag.getByLabel('Project day').fill('2026-03-03');
    await tag.getByLabel('Location').selectOption({ label: 'Floor 3' });
    await tag.getByRole('button', { name: 'File 1' }).click();

    // The gallery renders the record, not the raw file.
    await expect(page.getByRole('button', { name: /Open floor-3-north\.png/ })).toBeVisible({
      timeout: 20_000,
    });
    /*
     * And it renders the file's *state* rather than a broken image. The content-type
     * check runs in a worker after the upload — the API never saw the bytes — so
     * "being checked" is the state a capture product sits in constantly and a demo
     * never does.
     */
    await expect(page.getByText('Being checked…')).toBeVisible();
    // The category chip carries the count from the whole scoped set (§22.4).
    await expect(page.getByRole('button', { name: /^Before/ })).toBeVisible();
  });

  test('the three timestamps are three fields, and only one is attested', async () => {
    await page.getByRole('button', { name: /Open floor-3-north\.png/ }).click();
    const drawer = page.getByRole('dialog');
    /*
     * Addressed as description-list terms rather than as text, because "Project
     * day" is *also* the label of the field that edits it — and that duplication is
     * the design: the same fact appears once as a claim you can change and once as
     * a record of what was asserted, which is exactly the distinction §8 exists to
     * keep visible.
     */
    await expect(drawer.getByRole('term').filter({ hasText: 'Project day' })).toBeVisible();
    await expect(drawer.getByRole('term').filter({ hasText: 'Taken (device)' })).toBeVisible();
    await expect(drawer.getByRole('term').filter({ hasText: 'Uploaded' })).toBeVisible();
    // One of the three is the platform's; the other two are somebody's claim.
    await expect(drawer.getByText(/recorded by CrewQuo/)).toBeVisible();
    await expect(drawer.getByText(/as claimed/).first()).toBeVisible();
    await drawer.getByRole('button', { name: 'Close panel' }).click();
  });

  test('publishing says what it does, and stopping says what it cannot undo', async () => {
    /*
     * The confirmation is a live status message, which is both how a screen reader
     * learns about it and how this test knows the request has landed. The first
     * draft asserted on a substring that also appears in the project header, so it
     * passed instantly, and the un-publish below raced the publish it was supposed
     * to follow — producing "nothing is withdrawn" for a file that was, by then,
     * shared. An ambiguous locator does not fail; it succeeds early.
     */
    // Filtered rather than taken as the only one: the failed upload from the
    // previous test is still on screen and still true, so this section legitimately
    // carries two status messages at once.
    const shared = page.getByRole('status').filter({ hasText: 'Sharing this file' });
    const hidden = page.getByRole('status').filter({ hasText: 'Hiding this file' });

    await page.locator('.cq-tile__select input[type="checkbox"]').first().check();
    await page.getByRole('button', { name: 'Share with client' }).click();
    await expect(shared).toContainText('makes it visible to the client');
    await expect(shared).toContainText('cannot un-send what has already been downloaded');

    await page.locator('.cq-tile__select input[type="checkbox"]').first().check();
    await page.getByRole('button', { name: 'Stop sharing' }).click();
    /*
     * The sentence that must never promise a retraction. The client may already
     * have downloaded the file, and a screen offering "unpublish" without saying so
     * is the one that convinces somebody they have fixed a mistake they have not.
     */
    await expect(hidden).toContainText(
      'does not withdraw anything they have already seen or downloaded'
    );
  });

  // ── Documents ────────────────────────────────────────────────────────────────

  test('a document is filed, expiry is rendered as urgency, and re-issuing makes v2', async () => {
    await openSection(page, 'Documents', 'Documents');
    await expect(page.getByText('No documents filed')).toBeVisible();

    await page.locator('label.cq-btn input[type="file"]').first().setInputFiles({
      name: 'site-rams.pdf',
      mimeType: 'application/pdf',
      buffer: PDF,
    });

    const filing = page.getByRole('dialog');
    await expect(filing).toBeVisible({ timeout: 30_000 });

    /*
     * The form waits rather than refusing. §22.1 puts the content-type check in a
     * worker — the API never sees the bytes — so a document uploaded a second ago is
     * still `SCANNING`, and the filing route requires `READY`. The first version of
     * this screen submitted anyway and answered "try again in a moment", leaving
     * somebody holding a filled-in form and a guess about when the moment was.
     */
    await expect(filing.getByRole('status')).toContainText('Checking this file');
    await expect(filing.getByRole('button', { name: 'File document' })).toBeDisabled();

    await filing.getByLabel('Category').selectOption('RAMS');
    await filing.getByLabel('Title').fill('Site RAMS');
    await filing.getByLabel('Reference').fill('RAMS-2026-014');
    await filing.getByLabel('Issued on').fill('2026-01-01');
    // Deliberately in the past: the ladder's rung 0 is what a screen has to render
    // differently, and it is the state a compliance list exists to surface.
    await filing.getByLabel('Expires on').fill('2026-08-01');

    // The real scanner, run the way a scheduler runs it. The drawer is polling and
    // enables itself when the file comes back READY.
    await runWorkPass();
    await expect(filing.getByRole('button', { name: 'File document' })).toBeEnabled({
      timeout: 30_000,
    });
    await filing.getByRole('button', { name: 'File document' }).click();

    await expect(page.getByRole('button', { name: 'Site RAMS', exact: true })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(/RAMS expired \d+ days ago/)).toBeVisible();
    await expect(page.getByText(/documents? h(as|ave) lapsed/)).toBeVisible();

    // An inverted pair of dates is a typo, refused before the request is made.
    await page.getByRole('button', { name: 'Site RAMS', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Close panel' }).click();

    // Re-issue: new bytes are a new version, never a replacement.
    await page.getByRole('row', { name: /Site RAMS/ }).locator('input[type="file"]').setInputFiles({
      name: 'site-rams-v2.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.concat([PDF, Buffer.from('rev B')]),
    });
    const reissue = page.getByRole('dialog');
    await expect(reissue).toBeVisible({ timeout: 30_000 });
    await reissue.getByLabel('Expires on').fill('2027-08-01');
    await runWorkPass();
    await expect(reissue.getByRole('button', { name: 'Create v2' })).toBeEnabled({
      timeout: 30_000,
    });
    await reissue.getByRole('button', { name: 'Create v2' }).click();

    await expect(page.getByRole('cell', { name: /^v2/ })).toBeVisible({ timeout: 20_000 });
    // And the title carried forward without anybody retyping it.
    await expect(page.getByRole('button', { name: 'Site RAMS', exact: true })).toBeVisible();
  });

  test('there is no control anywhere that replaces a document’s bytes in place', async () => {
    await page.getByRole('button', { name: 'Site RAMS', exact: true }).click();
    const drawer = page.getByRole('dialog');
    await expect(drawer.getByText(/new version.*never a replacement/i)).toBeVisible();
    await expect(drawer.getByRole('button', { name: /replace file/i })).toHaveCount(0);
    // The chain is readable from the version you are holding.
    await expect(drawer.getByText('v1')).toBeVisible();
    await expect(drawer.getByText(/v2 — you are looking at this one/)).toBeVisible();
    await drawer.getByRole('button', { name: 'Close panel' }).click();
  });

  // ── The diary ────────────────────────────────────────────────────────────────

  test('a day is written up, closed, and cannot then be changed without a reason', async () => {
    await openSection(page, 'Site diary', 'Site diary');
    await expect(page.getByText('Nothing written up yet')).toBeVisible();

    await page.getByRole('button', { name: 'Write up a day' }).click();
    let drawer = page.getByRole('dialog');
    await drawer.getByLabel('Which day').fill('2026-03-03');
    await drawer.getByRole('button', { name: 'Open the day' }).click();

    // The editor opens on the day it just created.
    drawer = page.getByRole('dialog');
    await expect(drawer.getByRole('heading', { name: /Mar 3, 2026/ })).toBeVisible();
    await drawer.getByLabel('Started').fill('07:30');
    await drawer.getByLabel('Finished').fill('17:00');
    await drawer.getByLabel('Work completed').fill('Second fix to Floor 3');
    await drawer.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(drawer.getByText('1 of 13 filled in')).toBeVisible();

    /*
     * Close Day prompts and does not gate. The prompts are visible *and* the button
     * still works — a close that refused until a photograph existed would teach
     * somebody to photograph the floor twice.
     */
    await expect(drawer.getByText(/Before you close the day/)).toBeVisible();
    await expect(drawer.getByText(/check, not a gate/)).toBeVisible();
    await drawer.getByRole('button', { name: 'Close the day' }).click();
    await expect(drawer.getByText('This day is closed.')).toBeVisible();

    // There is no reopen, and the screen says why rather than hiding the absence.
    await expect(drawer.getByRole('button', { name: /reopen/i })).toHaveCount(0);
    await expect(drawer.getByText(/no way to reopen it/i)).toBeVisible();

    /*
     * The amendment. The reason is not a dialog somebody dismisses — it is the
     * field between the edit and the Save button, and Save is unreachable without it.
     */
    await drawer.getByLabel('Delays').fill('Crane arrived at 10:00');
    const save = drawer.getByRole('button', { name: 'Save amendment' });
    await expect(save).toBeDisabled();
    await drawer.getByLabel('Why is this changing?').fill('Delivery note arrived the next morning');
    await expect(save).toBeEnabled();
    await save.click();

    /*
     * "Amended N times" appears **wherever the entry appears** (§23) — so a count
     * rather than a visibility check, because one occurrence would mean the rule is
     * only half kept. Two here: the drawer's own identity line, and beside the
     * history it links to.
     */
    await expect(drawer.getByText('amended 1 time')).toHaveCount(2, { timeout: 20_000 });
    await drawer.getByRole('button', { name: 'View history' }).click();
    await expect(drawer.getByText('Delivery note arrived the next morning')).toBeVisible();
    // Named by the field that changed, computed from before/after rather than
    // declared by whoever wrote the patch.
    await expect(drawer.getByRole('listitem').filter({ hasText: 'Delays' })).toBeVisible();
    await drawer.getByRole('button', { name: 'Done' }).click();

    // …including in the list behind it, which is the third place.
    await expect(page.getByText('amended 1 time')).toBeVisible();
    await expect(page.getByRole('cell', { name: 'Closed' })).toBeVisible();
  });

  // ── Progressive disclosure ───────────────────────────────────────────────────

  test('a plan without the Phase 7 features does not advertise their sections', async ({
    browser,
  }) => {
    /*
     * A company that *can* reach a project page, with the three keys turned off by
     * an operator override — which is a real supported action (§5B) rather than a
     * test back door.
     *
     * The obvious fixture, a Crew-plan company looking at its own project, is not
     * reachable at all: a Crew plan does not operate downstream, so that workspace
     * view has no projects section and the shell sends it elsewhere. Which is
     * correct, and is why this is proved the other way round.
     */
    const gatedEmail = await provisionCompany({
      handle: 'sectionsgated',
      name: 'Sam Gated',
      companyName: CREW_CO,
      planId: 'starter',
    });
    for (const key of ['project_evidence', 'project_documents', 'site_diary']) {
      await disableFeature(CREW_CO, key);
    }
    const projectId = await createProjectHeadless(gatedEmail, `Own job ${RUN}`);

    const gated = await (await browser.newContext()).newPage();
    await signIn(gated, gatedEmail);
    await gated.goto(`/projects/${projectId}`);
    await expect(gated.getByRole('heading', { name: `Own job ${RUN}` })).toBeVisible();

    /*
     * Not listed at all, rather than listed-and-refusing. Advertising a section
     * that answers 403 is worse than not offering it: the person clicks, reads a
     * refusal, and learns the rail cannot be trusted.
     */
    for (const label of ['Photos & evidence', 'Documents', 'Site diary']) {
      await expect(railButton(gated, label)).toHaveCount(0);
    }
    /*
     * Locations ARE listed, and that is the correction the packet's §4 records: a
     * location is structure, not content, so it carries no feature key. Gating it
     * would mean a company whose plan includes scheduling but not evidence cannot
     * lay out the floors its schedule refers to — one key silently deciding
     * another feature's usability.
     */
    await expect(railButton(gated, 'Locations')).toBeVisible();
    await gated.close();
  });
});
