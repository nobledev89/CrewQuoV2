import { expect, test, type Locator, type Page } from '@playwright/test';
import { RUN, provisionCompany, signIn } from './helpers';

/**
 * Assets & materials in a browser (item 8.6) — the packet's §12 acceptance script,
 * walked on the screen rather than through the API.
 *
 * **What this proves that `verify-e2e.ts` cannot.** That suite drives 1,539 checks
 * over the same rules and none of it says the rules are *reachable*. A register
 * that renders no rows, a "Move on from storage" button that never appears because
 * the destination catalog resolved after the movement list did, an empty state
 * that says `0.00 t` — every one of those passes a green API suite.
 *
 * So the assertions are about what a person sees, and the four that carry the
 * phase are:
 *
 *  - **An empty project says "Nothing recorded yet", not `0.00 t`.** A zero is a
 *    claim about a floor nobody has walked.
 *  - **A weight upgrade nothing backs degrades and says so, on a success.** The
 *    16.5 kg is saved; the label is not; the sentence explains which.
 *  - **Pending mass is on screen beside the rates.** The stored mass, in none of
 *    them, said in words — §28.2's *"hiding pending mass in a denominator is how a
 *    diversion rate becomes a lie"* is only a lie if a screen renders it.
 *  - **Storage is a door.** The stored leg offers a continuation and not a second
 *    movement, and taking it moves 240 kg out of pending and into reuse while the
 *    handled total does not move by a gram.
 *
 * Prerequisites are the other specs': Postgres up, migrated and seeded, API on :4000.
 */

const OWNER_CO = `Meridian Facilities ${RUN}`;
const PROJECT = `Kings Court Floor 2 ${RUN}`;

function railButton(page: Page, label: string) {
  return page.getByRole('navigation', { name: 'Project' }).getByRole('button', { name: label });
}

/** A `<section>` by its own heading, so two panels with one empty state stay apart. */
function panel(page: Page, heading: string) {
  return page
    .locator('section.cq-section')
    .filter({ has: page.getByRole('heading', { name: heading, exact: true }) });
}

/** The register's row for one asset type. */
function assetRow(page: Page, type: string) {
  return page.locator('tbody tr').filter({ hasText: type }).first();
}

/**
 * Pick a destination by name rather than by the option's rendered label.
 *
 * Two things this works around, both of them about `<select>`:
 *
 *  - The label carries a hierarchy tier — "Donation — tier 2" — a presentational
 *    suffix this spec has no business pinning, and `selectOption({ label })`
 *    matches exactly. So the option is found by its text and selected by its value.
 *  - **`exact: true` cannot be used on a select's label.** A wrapping `<label>`
 *    contains the control, so its text is "Destination" *plus every option in the
 *    list*; the first version of this helper asked for an exact "Destination" and
 *    matched nothing, which then looked exactly like a catalog that had failed to
 *    load. Inputs are unaffected — they contribute no text — which is why
 *    `Quantity` below is still exact.
 */
async function chooseDestination(drawer: Locator, name: string): Promise<void> {
  const select = drawer.getByLabel('Destination');
  const value = await select.locator('option', { hasText: name }).first().getAttribute('value');
  await select.selectOption(value ?? '');
}

test.describe.configure({ mode: 'serial' });

test.describe('Assets & materials — the register, the split and the storage door', () => {
  let page: Page;

  test.beforeAll(async ({ browser }) => {
    // Pro carries `asset_tracking`, and this company owns the project — which is
    // whose plan the API asks about.
    const ownerEmail = await provisionCompany({
      handle: 'assets',
      name: 'Dolapo Assets',
      companyName: OWNER_CO,
      planId: 'pro',
    });
    page = await (await browser.newContext()).newPage();
    await signIn(page, ownerEmail);

    await page.goto('/projects');
    await page.getByRole('button', { name: 'New project' }).click();
    const form = page.locator('form').first();
    await form.getByLabel('Project name').fill(PROJECT);
    await form.getByRole('button', { name: 'Create project' }).click();
    await expect(page).toHaveURL(/\/projects\/[0-9a-f-]{36}/);
  });

  test.afterAll(async () => {
    await page.close();
  });

  // ── 1. Empty is not zero ───────────────────────────────────────────────────

  test('the section is in the rail, and an empty project is blank rather than nil', async () => {
    await expect(railButton(page, 'Assets & materials')).toBeVisible();
    await railButton(page, 'Assets & materials').click();

    await expect(page.getByRole('heading', { name: 'Asset lines' })).toBeVisible();
    await expect(
      panel(page, 'Asset lines').getByText('An asset line is a count of one kind of thing')
    ).toBeVisible();

    /*
     * The assertion the whole empty state exists for. A project with nothing
     * recorded has not diverted 0% and has not handled 0.00 t — it has been
     * measured by nobody, and a figure would say otherwise with the authority of
     * a number.
     */
    const balance = panel(page, 'Mass balance');
    await expect(balance.getByText('Nothing recorded yet')).toBeVisible();
    // Not "no zero in the copy" — no FIGURE at all. The roll-up renders three
    // metric values once there is something to total, and none before.
    await expect(balance.locator('.cq-metric__value')).toHaveCount(0);
  });

  // ── 2. Capture, and the degrade that saves the work ────────────────────────

  test('42 chairs are recorded at 16.5 kg each, and the line reads 693 kg', async () => {
    await page.getByRole('button', { name: 'Add a line' }).click();
    const drawer = page.getByRole('dialog');
    await drawer.getByLabel('Asset type').selectOption({ label: 'Operator chair' });
    await drawer.getByLabel('Quantity', { exact: true }).fill('42');
    await drawer.getByLabel('Weight basis').selectOption('UNIT');
    await drawer.getByLabel('Weight per unit (kg)').fill('16.5');
    await drawer.getByLabel('Where the weight came from').selectOption('USER_ESTIMATE');
    await drawer.getByRole('button', { name: 'Record line' }).click();

    const row = assetRow(page, 'Operator chair');
    await expect(row).toContainText('42');
    // 42 × 16.5, derived server-side; the screen renders what came back.
    await expect(row).toContainText('693.0 kg');
    await expect(row).toContainText('16.5 kg each');
    await expect(row).toContainText('ESTIMATED');
    await expect(row).toContainText('Not yet allocated');
  });

  /**
   * The one place in the product where a refused claim still writes.
   *
   * Ticking "weighed and verified" against a figure somebody estimated on site is
   * an upgrade nothing backs, so it is refused — and the **16.5 kg is saved
   * anyway**, as an estimate, with a sentence saying which half failed. Losing the
   * measurement to protect a label is what teaches people to stop recording
   * weights at all.
   */
  test('a verification nothing backs degrades the label and keeps the measurement', async () => {
    await assetRow(page, 'Operator chair').getByRole('button', { name: 'Weight' }).click();
    const drawer = page.getByRole('dialog');
    await drawer.getByLabel('Weighed and verified').check();
    await drawer.getByRole('button', { name: 'Save changes' }).click();

    const notice = page.getByRole('status');
    await expect(notice).toContainText('can be recorded as estimated at best');
    await expect(notice).toContainText('Saved as estimated');

    const row = assetRow(page, 'Operator chair');
    await expect(row).toContainText('693.0 kg');
    await expect(row).toContainText('ESTIMATED');
  });

  // ── 3. The paste, and the rows it could not read ───────────────────────────

  /**
   * A schedule out of a client's spreadsheet: four lines, two of them misspelt.
   *
   * **Two import and two come back, by the line number on the person's own
   * paste** — which is not the row number the API answered with, because the
   * header and the blank line never left the browser. The box is then rewritten to
   * hold exactly the two that failed: re-sending all six would either be refused
   * as a reused batch id or import two duplicates, and neither is what a person
   * fixing two typos means to do.
   */
  test('a pasted schedule imports what it understands and hands back the rest', async () => {
    await page.getByRole('button', { name: 'Paste a schedule' }).click();
    const drawer = page.getByRole('dialog');
    await drawer.getByLabel('Schedule').fill(
      [
        'Type,Quantity,Unit weight,Description',
        'DESK,8,30,Bench desks',
        'Chiar,9,16,Task chairs',
        'MONITOR,14,4.5',
        '',
        'LOKKER,2,22',
      ].join('\n')
    );
    await expect(drawer.getByRole('button', { name: 'Import 4 lines' })).toBeVisible();
    await expect(drawer.getByText('1 line looks like a header')).toBeVisible();
    await drawer.getByRole('button', { name: 'Import 4 lines' }).click();

    await expect(drawer.getByRole('status')).toContainText('2 lines imported');
    await expect(drawer.getByRole('status')).toContainText('2 did not');

    // The failures, by the line the person is looking at — 3 and 6, not 2 and 4.
    const failures = drawer.getByRole('table', { name: 'Rows that could not be imported' });
    await expect(failures).toContainText('Chiar');
    await expect(failures).toContainText('LOKKER');
    await expect(failures).toContainText('No asset type called');
    await expect(failures.locator('tbody tr').first()).toContainText('3');
    await expect(failures.locator('tbody tr').nth(1)).toContainText('6');

    /*
     * And the box now holds only what failed. The two that landed are gone from
     * it, so the obvious next act — fix the spelling, press Import again — cannot
     * duplicate them.
     */
    await expect(drawer.getByLabel('Schedule')).toHaveValue(/Chiar/);
    await expect(drawer.getByLabel('Schedule')).not.toHaveValue(/DESK/);
    await drawer.getByRole('button', { name: 'Done' }).click();

    await expect(assetRow(page, 'Desk')).toContainText('240.0 kg');
    await expect(assetRow(page, 'Monitor')).toContainText('63.0 kg');
  });

  // ── 4. The split, and the organisation that took it ────────────────────────

  test('30 chairs are donated and 12 recycled, against one line', async () => {
    await assetRow(page, 'Operator chair').getByRole('button', { name: 'Movements' }).click();
    await expect(page.getByText('All 42 are still unallocated.')).toBeVisible();

    await page.getByRole('button', { name: 'Record a movement' }).click();
    let drawer = page.getByRole('dialog');
    await chooseDestination(drawer, 'Donation');
    // What the destination means for the numbers, said before the write.
    await expect(drawer.getByText(/Counts as: .*reuse/)).toBeVisible();
    await drawer.getByLabel('Who took it').selectOption({ label: 'Add a new organisation…' });
    await drawer.getByLabel('Organisation name').fill(`Bright Futures ${RUN}`);
    await drawer.getByLabel('Kind').selectOption('CHARITY');
    await drawer.getByLabel('Quantity', { exact: true }).fill('30');
    await drawer.getByRole('button', { name: 'Record movement' }).click();

    await expect(page.getByText('12 of 42 still unallocated.')).toBeVisible();

    await page.getByRole('button', { name: 'Record a movement' }).click();
    drawer = page.getByRole('dialog');
    await chooseDestination(drawer, 'Recycling');
    await drawer.getByLabel('Quantity', { exact: true }).fill('12');
    await drawer.getByRole('button', { name: 'Record movement' }).click();

    // One line, two destinations, and the split is visible as such.
    const movements = page.getByRole('table', { name: 'Movements for Operator chair' });
    await expect(movements).toContainText('Donation');
    await expect(movements).toContainText('495.0 kg');
    await expect(movements).toContainText('Recycling');
    await expect(movements).toContainText('198.0 kg');
    await expect(movements).toContainText(`Bright Futures ${RUN}`);

    await expect(assetRow(page, 'Operator chair')).toContainText('All allocated');
  });

  /**
   * §25.4 rule 1, as a screen rather than as a 422.
   *
   * Nothing is left to allocate, so there is nothing to press. The API refuses it
   * too — under a row lock this client cannot hold, which is why the disabled
   * button is a courtesy and not the guard.
   */
  test('a line with nothing left to allocate offers no third movement', async () => {
    await expect(page.getByText('All 42 are recorded to a destination.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Record a movement' })).toBeDisabled();
    await assetRow(page, 'Operator chair').getByRole('button', { name: 'Hide movements' }).click();
  });

  // ── 5. Storage: the one that counts as nothing ─────────────────────────────

  test('8 desks into storage sit in pending, in no rate, and the screen says so', async () => {
    await assetRow(page, 'Desk').getByRole('button', { name: 'Movements' }).click();
    await page.getByRole('button', { name: 'Record a movement' }).click();

    const drawer = page.getByRole('dialog');
    await chooseDestination(drawer, 'Storage');
    /*
     * Decision #18 said out loud at the moment it is chosen. Storage counting
     * toward no rate is correct and completely silent everywhere else; this
     * sentence is the one place a person is told before they commit to it.
     */
    await expect(drawer.getByText('This is not a final outcome')).toBeVisible();
    await drawer.getByLabel('Quantity', { exact: true }).fill('8');
    await drawer.getByRole('button', { name: 'Record movement' }).click();

    await expect(assetRow(page, 'Desk')).toContainText('In storage');

    const balance = panel(page, 'Mass balance');
    // Pending is two things, and they are two figures: the warehouse, and the
    // monitors nobody has moved at all.
    await expect(balance).toContainText('240.0 kg in storage');
    await expect(balance).toContainText('63.0 kg with no destination yet');
    /*
     * **The assertion the build order names.** The rates are shares of what
     * reached a final destination, and the pending mass is beside them in words
     * rather than folded into a denominator. 693 of 996 would be 70%; 693 of 693
     * is 100%; the sentence is what stops a reader mistaking one for the other.
     */
    await expect(balance).toContainText('These rates are shares of the 693.0 kg');
    await expect(balance).toContainText(
      'A further 303.0 kg is still pending and is in none of them'
    );
    // Reuse above recycling, and storage in neither — it is not an outcome.
    const went = balance.getByRole('table', { name: 'Where material went' });
    await expect(went.locator('tbody tr').first()).toContainText('Donation');
    await expect(went.locator('tbody tr').nth(1)).toContainText('Recycling');
    await expect(went).not.toContainText('Storage');
    // …and the gap is named, in mass, with no score anywhere near it.
    await expect(balance).toContainText('of stored material is currently unknown');
    await expect(balance.getByText(/completeness score/i)).toHaveCount(0);
  });

  /**
   * The phase's whole point, in one act.
   *
   * The stored leg offers a **continuation** and never a second movement — the two
   * write different rows, and a continuation typed as a fresh movement is eight
   * desks in a warehouse *and* eight resold, from a line of eight. Taking it moves
   * the mass out of pending and into reuse, and the handled total does not move.
   */
  test('storage is a door: the stored leg is carried onward, and the total does not move', async () => {
    const balance = panel(page, 'Mass balance');
    await expect(balance).toContainText('996.0 kg');

    await expect(page.getByRole('button', { name: 'Move on from storage' })).toBeVisible();
    await page.getByRole('button', { name: 'Move on from storage' }).click();

    const drawer = page.getByRole('dialog');
    await expect(drawer).toContainText('the project’s total does not change');
    await chooseDestination(drawer, 'Resale');
    await drawer.getByLabel('Quantity', { exact: true }).fill('8');
    await drawer.getByRole('button', { name: 'Record movement' }).click();

    await expect(assetRow(page, 'Desk')).toContainText('All allocated');

    /*
     * The storage leg is kept and marked rather than hidden: a ledger records
     * where material has been, and "counts toward nothing" is exactly the thing a
     * reader needs to be told about a row that is still on their screen.
     */
    const movements = page.getByRole('table', { name: 'Movements for Desk' });
    await expect(movements).toContainText('Carried onward');
    await expect(movements).toContainText('Continues an earlier leg.');

    await expect(balance).toContainText('0.0 kg in storage');
    await expect(balance).toContainText('These rates are shares of the 933.0 kg');
    await expect(balance).toContainText('A further 63.0 kg is still pending');
    // Unmoved by the continuation, which is the invariant the phase is built on.
    await expect(balance).toContainText('996.0 kg');
  });
});
