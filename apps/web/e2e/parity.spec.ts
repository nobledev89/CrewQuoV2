import { expect, test, type Page } from '@playwright/test';
import {
  PARITY_PASSWORD,
  RUN,
  acceptInviteAsNewUser,
  emailFor,
  freshPage,
  makeSuperAdmin,
  provisionCompany,
  readInviteUrl,
  registerHeadless,
  registerViaUi,
  setRegistrationIdentity,
  signIn,
  verifyEmail,
} from './helpers';

/**
 * The web core loop, as one story: every workflow CrewQuo supports, done from a
 * browser with no phone involved.
 *
 *   register -> company -> rates -> invite a subcontractor -> they accept
 *   -> invite a client -> they accept -> project -> assign -> log time -> submit
 *   -> bulk approve -> client sees it in the portal -> the trail records it
 *
 * Three companies and three users, because that is the smallest cast that can prove
 * the important property: the same data reads differently depending on which side of
 * an engagement you are on. The subcontractor sees what they are paid, the client sees
 * what they are charged, and neither sees the other's figure.
 */

const CONTRACTOR_CO = `Meridian Contracts ${RUN}`;
const SUB_CO = `Pashe Rigging ${RUN}`;
const CLIENT_CO = `Hanmore Estates ${RUN}`;
// The company-creation safeguard (§3.1.1) needs one identity owning two tenants:
// the included one, and a second that has to be approved before it exists.
const FIRST_CO = `Northlight Rigging ${RUN}`;
const SECOND_CO = `Northlight Plant Hire ${RUN}`;
const ROLE = 'Rigger';

// PAY 50.00/h, BILL 82.00/h. 8 hours -> cost 40000c, bill 65600c.
const PAY_HOURLY = '50.00';
const BILL_HOURLY = '82.00';
const HOURS = '8';
// The rate the subcontractor proposes as a rise: 50.00 -> 55.00 is +$5.00 / 10.0%,
// which is exactly what the reviewer's delta column is asserted to compute.
const NEW_PAY_HOURLY = '55.00';
const EXPECTED_COST = 40000;
const EXPECTED_BILL = 65600;

/**
 * A date comfortably in the future, for a rate schedule. Computed rather than
 * written down: a literal would quietly stop being in the future and turn a
 * straightforward approval into the owner-only back-dated path.
 */
const FUTURE_DATE = (() => {
  const d = new Date();
  d.setDate(d.getDate() + 30);
  return d.toISOString().slice(0, 10);
})();

/** A weekday, so the baseline MON_FRI_DAY label applies with no label rules set up. */
const WORK_DATE = (() => {
  const d = new Date();
  d.setDate(d.getDate() - 7);
  while (d.getDay() === 0 || d.getDay() === 5 || d.getDay() === 6) d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
})();

test.describe.configure({ mode: 'serial' });

test.describe('Web core workflows', () => {
  let contractor: Page;
  let sub: Page;
  let client: Page;
  /** The identity that ends up owning two companies (§3.1.1). */
  let twoCoEmail: string;

  test('the register screen creates a free account and lands in account setup', async ({ browser }) => {
    // Proves the registration UI in isolation. This company stays on the free `crew`
    // plan, which is exactly what a real sign-up gets.
    const page = await freshPage(browser);
    await registerViaUi(page, {
      handle: 'signup',
      name: 'Robin Signup',
      companyName: `Signup Test Co ${RUN}`,
    });

    await expect(page).toHaveURL(/\/profile/);
    await expect(page.getByRole('heading', { name: 'Profile' })).toBeVisible();

    // Owning a free company does not invent an Operations workspace. Until this
    // company is assigned as a subcontractor/client or upgrades, it gets only the
    // compact account-setup navigation and cannot enter an Ops URL manually.
    const sidebar = page.getByRole('complementary', { name: 'Primary navigation' });
    await expect(sidebar.getByRole('link', { name: 'Profile' })).toBeVisible();
    await expect(sidebar.getByRole('link', { name: 'Subcontractors' })).toHaveCount(0);
    await expect(page.getByLabel('Workspace view')).toHaveValue('ACCOUNT');
    await page.goto('/network/providers');
    await expect(page).toHaveURL(/\/profile/);
    await page.close();
  });

  test('a contractor on a paid plan signs in', async ({ browser }) => {
    const email = await provisionCompany({
      handle: 'owner',
      name: 'Dana Owner',
      companyName: CONTRACTOR_CO,
      planId: 'pro',
    });

    contractor = await freshPage(browser);
    await signIn(contractor, email);
    await expect(contractor.getByRole('heading', { name: CONTRACTOR_CO })).toBeVisible();

    await contractor.goto('/plan');
    await expect(contractor.getByRole('heading', { name: 'Plan & usage' })).toBeVisible();
    await expect(
      contractor.getByText('You can engage your own subcontractors')
    ).toBeVisible();
  });

  test('rates are set up: a role, a PAY card and a BILL card', async () => {
    /*
     * Creating happens in a side panel, not in a form pinned above the register (§40).
     * The header button opens it ("New role") and the panel's own button commits
     * ("Add role") — deliberately different words, because two controls sharing one
     * accessible name is ambiguous for a screen reader as much as for a test.
     */
    await contractor.goto('/rates/roles');
    await contractor.getByRole('button', { name: 'New role' }).click();
    await contractor.getByPlaceholder('e.g. Lighting technician…').fill(ROLE);
    await contractor.getByRole('button', { name: 'Add role' }).click();
    // `exact` matters: the row's action cell reads "Delete Rigger", so a loose name
    // match resolves to two cells and trips strict mode.
    await expect(contractor.getByRole('cell', { name: ROLE, exact: true })).toBeVisible();

    for (const [kind, rate, expected] of [
      ['PAY (to provider)', PAY_HOURLY, '$50.00'],
      ['BILL (to client)', BILL_HOURLY, '$82.00'],
    ] as const) {
      await contractor.goto('/rates/cards');
      await contractor.getByRole('button', { name: 'New rate card' }).click();
      const form = contractor.locator('#add-rate-card');
      await form.getByLabel('Kind').selectOption({ label: kind });
      await form.getByLabel('Role').selectOption({ label: ROLE });
      await form.getByLabel('Hourly rate ($)').fill(rate);
      // Backdate so the card covers the work date, which is in the past.
      await form.getByLabel('Effective from', { exact: true }).fill('2020-01-01');
      await contractor.getByRole('button', { name: 'Add rate card' }).click();
      // The panel stays open for the next card, so close it before reading the register.
      await contractor.getByRole('button', { name: 'Done' }).click();
      await expect(contractor.getByText(expected).first()).toBeVisible();
    }
  });

  test('a subcontractor is invited and accepts, claiming their placeholder', async ({ browser }) => {
    await contractor.goto('/network/providers');
    await contractor.getByRole('button', { name: 'Add subcontractor' }).click();
    await contractor.getByLabel('Company name').fill(SUB_CO);
    await contractor.getByLabel('Contact email').fill(`sub+${RUN}@parity.crewquo.test`);
    await contractor.getByRole('button', { name: 'Add and invite' }).click();

    const inviteUrl = await readInviteUrl(contractor);

    sub = await freshPage(browser);
    await acceptInviteAsNewUser(sub, inviteUrl, { handle: 'sub', name: 'Sam Rigger' });

    // Accepting activates the edge, so the contractor now sees them as joined.
    await contractor.goto('/network/providers');
    await expect(contractor.getByRole('cell', { name: SUB_CO })).toBeVisible();
    await expect(contractor.getByRole('row', { name: new RegExp(SUB_CO) })).toContainText('Joined');
  });

  test('a portal client is invited and accepts', async ({ browser }) => {
    await contractor.goto('/network/clients');
    await contractor.getByRole('button', { name: 'Add client' }).click();
    await contractor.getByLabel('Client company name').fill(CLIENT_CO);
    await contractor.getByLabel('Contact email').fill(`client+${RUN}@parity.crewquo.test`);
    await contractor.getByRole('button', { name: 'Add and invite' }).click();

    const inviteUrl = await readInviteUrl(contractor);

    client = await freshPage(browser);
    await acceptInviteAsNewUser(client, inviteUrl, { handle: 'client', name: 'Chris Client' });
  });

  test('each participant receives only its eligible workspace navigation', async () => {
    await contractor.goto('/app');
    const operationsNav = contractor.getByRole('complementary', { name: 'Primary navigation' });
    await expect(contractor.getByLabel('Workspace view')).toHaveValue('OPERATIONS');
    await expect(contractor.getByLabel('Workspace view').getByRole('option')).toHaveText(['Contractor']);
    await expect(operationsNav.getByRole('link', { name: 'Overview' })).toBeVisible();
    await expect(operationsNav.getByRole('link', { name: 'Rate cards' })).toBeVisible();
    await expect(operationsNav.getByRole('link', { name: 'Profile' })).toBeVisible();
    await expect(operationsNav.getByRole('link', { name: 'My work' })).toHaveCount(0);

    await sub.goto('/work');
    const subcontractorNav = sub.getByRole('complementary', { name: 'Primary navigation' });
    await expect(sub.getByLabel('Workspace view')).toHaveValue('SUBCONTRACTOR');
    await expect(sub.getByLabel('Workspace view').getByRole('option')).toHaveText(['Subcontractor']);
    await expect(subcontractorNav.getByRole('link', { name: 'My work' })).toBeVisible();
    await expect(subcontractorNav.getByRole('link', { name: 'Rate agreements' })).toBeVisible();
    await expect(subcontractorNav.getByRole('link', { name: 'Profile' })).toBeVisible();
    await expect(subcontractorNav.getByRole('link', { name: 'Overview' })).toHaveCount(0);

    await client.goto('/portal');
    const clientNav = client.getByRole('complementary', { name: 'Primary navigation' });
    await expect(client.getByLabel('Workspace view')).toHaveValue('CLIENT');
    await expect(client.getByLabel('Workspace view').getByRole('option')).toHaveText(['Client']);
    await expect(clientNav.getByRole('link', { name: 'Projects' })).toBeVisible();
    await expect(clientNav.getByRole('link', { name: 'Invoices' })).toBeVisible();
    await expect(clientNav.getByRole('link', { name: 'Profile' })).toBeVisible();
    await expect(clientNav.getByRole('link', { name: 'Commercial' })).toHaveCount(0);
  });

  test('a project is created for the client, published, and the subcontractor assigned', async () => {
    await contractor.goto('/projects');
    await contractor.getByRole('button', { name: 'New project' }).click();

    const form = contractor.locator('form').first();
    await form.getByLabel('Project name').fill(`Atrium refit ${RUN}`);
    await form.getByLabel('Client company').selectOption({ label: CLIENT_CO });
    await form.getByLabel('Publish to the client portal').check();
    await form.getByRole('button', { name: 'Create project' }).click();

    // Creating navigates to the detail page.
    await expect(contractor).toHaveURL(/\/projects\/[0-9a-f-]{36}/);
    await expect(contractor.getByText('Shared with client')).toBeVisible();

    /*
     * A project is one record with sections (§20), so assignment lives under Crew
     * rather than on an ever-growing single page. The rail is how you get there, and
     * the section is in the URL so it stays linkable.
     */
    await contractor.getByRole('button', { name: 'Crew' }).click();
    await contractor.getByLabel('Subcontractor to assign').selectOption({ label: SUB_CO });
    await contractor.getByRole('button', { name: 'Assign', exact: true }).click();
    await expect(contractor.getByRole('cell', { name: SUB_CO })).toBeVisible();
  });

  test('the subcontractor logs time and submits it', async () => {
    await sub.goto('/work');
    // Entry is a side panel here too, so the daily list of what is still yours to fix
    // is the first thing on the screen rather than the second form.
    await sub.getByRole('button', { name: 'Log time' }).click();
    await expect(sub.getByRole('heading', { name: 'Log time', exact: true })).toBeVisible();

    const form = sub.locator('#log-time');
    await form.getByLabel('Role').selectOption({ label: ROLE });
    await form.getByLabel('Work date').fill(WORK_DATE);
    await form.getByLabel('Regular hours').fill(HOURS);
    await sub.getByRole('button', { name: 'Save draft' }).click();
    await expect(sub.getByText(/Draft saved for/)).toBeVisible();
    await sub.getByRole('button', { name: 'Done' }).click();

    // Submitting freezes the PAY snapshot server-side.
    await sub.getByRole('button', { name: /^Submit all/ }).click();
    // `exact`, or this also matches the "Not yet submitted" section heading above it.
    await expect(sub.getByRole('heading', { name: 'Submitted', exact: true })).toBeVisible();
    // The subcontractor sees what they are paid — the frozen PAY snapshot, 8h x $50.
    await expect(sub.getByText('$400.00').first()).toBeVisible();
  });

  test('the contractor approves it from the bulk review screen', async () => {
    await contractor.goto('/review');
    await expect(contractor.getByRole('heading', { name: 'Approvals' })).toBeVisible();

    // The cost shown to the hirer is the PAY figure — what they pay the subcontractor.
    const row = contractor.getByRole('row', { name: new RegExp(SUB_CO) });
    await expect(row).toContainText('$400.00');

    await contractor.getByLabel(/^Select time log/).check();
    await expect(contractor.getByText('1 selected · $400.00')).toBeVisible();
    await contractor.getByRole('button', { name: 'Approve 1' }).click();

    await expect(contractor.getByText('1 item approved.')).toBeVisible();
  });

  test('the project summary shows cost, bill and margin from the server', async () => {
    await contractor.goto('/projects');
    await contractor.getByRole('link', { name: new RegExp(`Atrium refit ${RUN}`) }).click();

    await expect(contractor.getByText('$400.00').first()).toBeVisible(); // cost
    await expect(contractor.getByText('$656.00').first()).toBeVisible(); // bill
    await expect(contractor.getByText('$256.00').first()).toBeVisible(); // margin
    await expect(contractor.getByText('39.02% of the billed total')).toBeVisible();

    // Sanity-check the arithmetic this test is asserting, so a rate typo above shows
    // up as a failing expectation rather than a silently different "correct" number.
    expect(EXPECTED_BILL - EXPECTED_COST).toBe(25600);
  });

  test('the client sees the BILL figure in the portal, and never the PAY figure', async () => {
    await client.goto('/portal');
    await client.getByRole('link', { name: new RegExp(`Atrium refit ${RUN}`) }).click();

    await expect(client.getByText('$656.00').first()).toBeVisible();

    // The portal payload has no PAY field at all, so the cost must appear nowhere on
    // the page — this is the margin guard of §4, checked from the client's browser.
    await expect(client.getByText('$400.00')).toHaveCount(0);
    await expect(client.getByText('$256.00')).toHaveCount(0);
    await expect(client.getByText(SUB_CO)).toHaveCount(0);
  });

  test('the audit trail records the submission and the approval', async () => {
    await contractor.goto('/audit');
    await expect(contractor.getByRole('heading', { name: 'Audit trail' })).toBeVisible();
    await expect(contractor.getByText('Time log approved').first()).toBeVisible();
    await expect(contractor.getByText('Project created').first()).toBeVisible();
  });

  test('an owner can export the project as PDF and as a spreadsheet', async () => {
    await contractor.goto('/projects');
    await contractor.getByRole('link', { name: new RegExp(`Atrium refit ${RUN}`) }).click();
    // Exports live in the record's Reports section (§20), which is where §29's report
    // engine lands in Phase 10 — so the rail entry is already the right home for it.
    await contractor.getByRole('button', { name: 'Reports' }).click();

    for (const [button, extension] of [
      ['Download PDF', 'pdf'],
      ['Download spreadsheet', 'xlsx'],
    ] as const) {
      const download = contractor.waitForEvent('download');
      await contractor.getByRole('button', { name: button }).click();
      const file = await download;
      expect(file.suggestedFilename()).toMatch(new RegExp(`\\.${extension}$`));
    }
  });

  /*
   * Commercial agreements (§3.3.1). Two sides, one screen, and the property worth
   * proving in a browser: the reviewer sees the rate in force beside the proposed
   * one, and neither side can act for the other.
   */
  test('the subcontractor proposes a rate rise and sends it for approval', async () => {
    await sub.goto('/commercial');
    await expect(sub.getByRole('heading', { name: 'Commercial agreements' })).toBeVisible();

    // The row says which way the money flows, because that decides who may propose.
    const row = sub.getByRole('row', { name: new RegExp(CONTRACTOR_CO) });
    await expect(row).toContainText('They pay you');
    await row.getByRole('button', { name: 'Open' }).click();

    await expect(sub.getByRole('heading', { name: CONTRACTOR_CO })).toBeVisible();
    // The provider reads its own agreed PAY rate. That is not the hiring company's
    // BILL side, so there is nothing here it should not see.
    await expect(sub.getByRole('cell', { name: '$50.00' }).first()).toBeVisible();

    await sub.getByRole('button', { name: 'Propose new rates' }).click();
    const panel = sub.getByRole('dialog', { name: 'Propose new rates' });
    await expect(panel).toBeVisible();

    await panel.getByLabel('Effective from').fill(FUTURE_DATE);
    await panel.getByLabel('Note').fill('Annual uplift');
    /*
     * A CREATE line, not a REPLACE, and that is the interesting part: the $50 rate in
     * force here is the contractor's *company default* for the role, inherited by
     * every engagement. Superseding it would reprice every other subcontractor at
     * once, so the panel deliberately does not offer it as a REPLACE target. Asking
     * for your own rate is a new engagement-specific card, which then beats the
     * default on the resolver's own precedence (§6).
     */
    /*
     * No `exact` here, deliberately. `Field` renders a *wrapping* `<label>`, so the
     * label's accessible text is its caption plus the control's own rendered text —
     * for a `<select>` that is every option. `exact: true` therefore matches nothing
     * on any select in this design system, which is why the older log-time test also
     * matches loosely. 'Role' is still unambiguous inside this panel.
     */
    await panel.getByLabel('Role').selectOption({ label: ROLE });
    await panel.getByLabel('Rate (USD)').fill(NEW_PAY_HOURLY);
    await expect(panel.getByLabel('Rate it supersedes')).toHaveCount(0);
    await panel.getByRole('button', { name: 'Save draft' }).click();

    await expect(sub.getByText(/Draft schedule created/)).toBeVisible();
    // A draft shows the change it is asking for, against what is in force today.
    await expect(sub.getByRole('cell', { name: '+$5.00 (10.0%)' })).toBeVisible();

    await sub.getByRole('button', { name: 'Send for approval' }).click();
    await expect(sub.getByText(/numbers are now frozen/)).toBeVisible();
  });

  test('the hiring company sees what changes, returns it, and the reason reaches the provider', async () => {
    await contractor.goto('/commercial');
    // The same screen, the other side of the same edge.
    const row = contractor.getByRole('row', { name: new RegExp(SUB_CO) });
    await expect(row).toContainText('You pay them');
    await expect(row).toContainText('Submitted');
    await row.getByRole('button', { name: 'Open' }).click();

    // The reviewer's whole job is "what changes": now, proposed, and the delta.
    await expect(contractor.getByRole('cell', { name: '$50.00' }).first()).toBeVisible();
    await expect(contractor.getByRole('cell', { name: '$55.00' }).first()).toBeVisible();
    await expect(contractor.getByRole('cell', { name: '+$5.00 (10.0%)' })).toBeVisible();

    // Returning without a reason is not offered: the button stays disabled until
    // there is something for the provider to work from.
    await contractor.getByRole('button', { name: 'Return', exact: true }).click();
    const returnIt = contractor.getByRole('button', { name: 'Return it' });
    await expect(returnIt).toBeDisabled();
    await contractor.getByLabel('Why are you returning this?').fill('Above the framework cap');
    await expect(returnIt).toBeEnabled();
    await returnIt.click();
    await expect(contractor.getByText(/returned to the provider/)).toBeVisible();

    // The provider gets the reason, and no way to edit what was already decided.
    await sub.goto('/commercial');
    await sub
      .getByRole('row', { name: new RegExp(CONTRACTOR_CO) })
      .getByRole('button', { name: 'Open' })
      .click();
    await expect(sub.getByText(/Returned: Above the framework cap/)).toBeVisible();
    await expect(sub.getByText(/cannot be edited/)).toBeVisible();
  });

  test('the hiring company sets payment terms and a purchase order', async () => {
    await contractor.goto('/commercial');
    await contractor
      .getByRole('row', { name: new RegExp(SUB_CO) })
      .getByRole('button', { name: 'Open' })
      .click();

    await contractor.getByRole('button', { name: 'Edit terms' }).click();
    const panel = contractor.getByRole('dialog', { name: 'Commercial terms' });
    await panel.getByLabel('Payment terms (days)').fill('30');
    await panel.getByLabel('Purchase order reference').fill('PO-9001');
    await panel.getByLabel('Reason for the change').fill('Signed framework');
    await panel.getByRole('button', { name: 'Save terms' }).click();

    await expect(contractor.getByText('Commercial terms updated.')).toBeVisible();
    await expect(contractor.getByText('30 days')).toBeVisible();
    await expect(contractor.getByText('PO-9001')).toBeVisible();

    // The provider works under these terms, so it reads them — and cannot set them.
    await sub.goto('/commercial');
    await sub
      .getByRole('row', { name: new RegExp(CONTRACTOR_CO) })
      .getByRole('button', { name: 'Open' })
      .click();
    await expect(sub.getByText('30 days')).toBeVisible();
    await expect(sub.getByRole('button', { name: 'Edit terms' })).toHaveCount(0);
  });

  test('the subcontractor accepts the project assignment it was offered', async () => {
    // Acceptance is recorded, never a gate: the time log in the earlier test was
    // submitted and approved while this assignment was still unanswered.
    await sub.goto('/work');
    const offered = sub.getByRole('row', { name: new RegExp(`Atrium refit ${RUN}`) });
    await expect(offered.first()).toBeVisible();
    await offered.first().getByRole('button', { name: 'Accept' }).click();
    await expect(
      sub.getByRole('heading', { name: 'Projects you have been added to' })
    ).toHaveCount(0);

    // And the hiring company can see where it stands, on the Crew section.
    await contractor.goto('/projects');
    await contractor.getByRole('link', { name: new RegExp(`Atrium refit ${RUN}`) }).click();
    await contractor.getByRole('button', { name: 'Crew' }).click();
    await expect(contractor.getByRole('row', { name: new RegExp(SUB_CO) })).toContainText('Yes');
  });

  test('a user edits their own profile and the shell picks up the new name', async () => {
    await contractor.goto('/profile');
    await contractor.getByLabel('Name').fill('Dana Renamed');
    await contractor.getByRole('button', { name: 'Save profile' }).click();
    await expect(contractor.getByText('Your profile was saved.')).toBeVisible();

    // The sidebar renders the name from the cached session, so this only passes if the
    // save re-read `/v1/me` — otherwise it keeps showing the old name until sign-in.
    await expect(contractor.locator('.cq-account__name')).toHaveText('Dana Renamed');

    // The address is the identity an invite is bound to, so it is not a text field.
    await expect(contractor.getByLabel('Email address')).toHaveAttribute('readonly', '');
  });

  test('the sole owner cannot be demoted or removed, and the table says why', async () => {
    await contractor.goto('/company/members');
    const ownerRow = contractor.getByRole('row', { name: /Dana Renamed/ });
    await expect(ownerRow).toContainText('Only owner');
    // No role dropdown and no destructive button on the row that would strand the company.
    await expect(ownerRow.getByRole('combobox')).toHaveCount(0);
    await expect(ownerRow.getByRole('button', { name: 'Remove' })).toHaveCount(0);
  });

  test('a member is invited, re-roled, suspended, restored and removed', async ({ browser }) => {
    await contractor.goto('/company/members');
    await contractor.getByRole('button', { name: 'Invite member' }).click();
    await contractor.getByLabel('Email address').fill(`staffer+${RUN}@parity.crewquo.test`);
    await contractor.getByLabel('Role').selectOption({ label: 'Member' });
    await contractor.getByRole('button', { name: 'Create invitation' }).click();

    const inviteUrl = await readInviteUrl(contractor);
    const staffer = await freshPage(browser);
    await acceptInviteAsNewUser(staffer, inviteUrl, { handle: 'staffer', name: 'Mel Staffer' });
    await staffer.close();

    await contractor.goto('/company/members');
    const row = contractor.getByRole('row', { name: /Mel Staffer/ });
    await expect(row).toBeVisible();

    await row.getByLabel('Role for Mel Staffer').selectOption({ label: 'Manager' });
    await expect(contractor.getByRole('row', { name: /Mel Staffer/ })).toBeVisible();
    await expect(
      contractor.getByRole('row', { name: /Mel Staffer/ }).getByLabel('Role for Mel Staffer')
    ).toHaveValue('MANAGER');

    // Suspending keeps the seat; the badge is the only signal that says so.
    await contractor.getByRole('row', { name: /Mel Staffer/ }).getByRole('button', { name: 'Suspend' }).click();
    await expect(contractor.getByRole('row', { name: /Mel Staffer/ })).toContainText('Suspended');
    await contractor.getByRole('row', { name: /Mel Staffer/ }).getByRole('button', { name: 'Restore' }).click();
    await expect(contractor.getByRole('row', { name: /Mel Staffer/ })).toContainText('Active');

    // Removal asks first — it frees the seat and ends their access.
    await contractor.getByRole('row', { name: /Mel Staffer/ }).getByRole('button', { name: 'Remove' }).click();
    await contractor.getByRole('button', { name: 'Confirm remove' }).click();
    await expect(contractor.getByRole('row', { name: /Mel Staffer/ })).toHaveCount(0);
  });

  test('platform staff run the companies console without owning a company', async ({ browser }) => {
    const email = await registerHeadless({ handle: 'platform', name: 'Pat Platform' });
    await makeSuperAdmin(email);

    const staff = await freshPage(browser);
    await signIn(staff, email);

    await expect(staff).toHaveURL(/\/admin$/);
    await expect(staff.getByRole('heading', { name: 'Platform dashboard' })).toBeVisible();
    await expect(staff.getByLabel('Active company')).toHaveValue('PLATFORM');
    await expect(staff.getByLabel('Active company').getByRole('option', { name: 'CrewQuo Platform' })).toHaveCount(1);
    await expect(staff.getByLabel('Workspace view')).toHaveValue('SUPER_ADMIN');
    await expect(staff.getByLabel('Workspace view').getByRole('option', { name: 'Super Admin' })).toHaveCount(1);
    for (const item of ['Dashboard', 'Users', 'Companies', 'Plans & pricing', 'Operations', 'Reporting', 'Platform audit', 'Settings', 'Admin access']) {
      await expect(staff.getByRole('link', { name: item, exact: true })).toBeVisible();
    }

    await staff.getByRole('link', { name: 'Users', exact: true }).click();
    await expect(staff.getByRole('heading', { name: 'Users' })).toBeVisible();
    await staff.getByLabel('Search users').fill(email);
    await staff.getByRole('button', { name: 'Search' }).click();
    const userRow = staff.getByRole('row').filter({ hasText: email });
    // This fixture is intentionally elevated directly in SQL without completing
    // email verification; the real bootstrap CLI refuses that state.
    await expect(userRow).toContainText('Unverified');
    await userRow.getByRole('button', { name: 'Open' }).click();
    await expect(staff.getByText('Super Admin', { exact: true }).last()).toBeVisible();
    await staff.getByRole('button', { name: 'Close panel' }).click();

    await staff.getByRole('link', { name: 'Reporting', exact: true }).click();
    await expect(staff.getByRole('heading', { name: 'Reporting' })).toBeVisible();
    await staff.getByRole('link', { name: 'Operations', exact: true }).click();
    await expect(staff.getByRole('heading', { name: 'Operations' })).toBeVisible();
    await staff.getByRole('link', { name: 'Settings', exact: true }).click();
    await expect(staff.getByRole('heading', { name: 'Platform settings' })).toBeVisible();

    // A staff account owns nothing, so every ordinary screen correctly asks for a
    // company — but the console must not, or support is unreachable by its own audience.
    await staff.goto('/projects');
    await expect(staff.getByRole('heading', { name: 'Create your company' })).toBeVisible();

    await staff.goto('/admin/companies');
    await expect(staff.getByRole('heading', { name: 'Companies' })).toBeVisible();

    await staff.getByLabel('Name or member email').fill(CONTRACTOR_CO);
    await staff.getByRole('button', { name: 'Search' }).click();
    const row = staff.getByRole('row', { name: new RegExp(CONTRACTOR_CO) });
    await expect(row).toBeVisible();
    await expect(row).toContainText('pro');

    await row.getByRole('button', { name: 'Open' }).click();
    await expect(staff.getByRole('heading', { name: CONTRACTOR_CO })).toBeVisible();

    // Live usage, read through the same meters the product enforces: one real client.
    // Scoped by table, because "Internal seats" and "Clients" name a row in the usage
    // table *and* a row in the overrides table below it.
    const usageTable = staff.getByRole('table', { name: /usage against limits/ });
    await expect(usageTable.getByRole('row', { name: /^Clients/ })).toContainText('1 / ');

    // An override, then its revocation — both must show immediately, because the
    // resolver memoizes for 60s and only an invalidation makes this visible at all.
    //
    // Anchored regexes, not plain strings: `Field` wraps its control in the `<label>`,
    // so a select's accessible name is its label text *plus its current value*
    // ("LimitActive subcontractors"), and plain-string matching is case-insensitive
    // substring — which makes "Limit" also match the allowance hint's "unlimited".
    const overrideForm = staff
      .locator('form')
      .filter({ has: staff.getByRole('button', { name: 'Apply override' }) });
    await overrideForm.getByLabel(/^Kind/).selectOption('limit');
    await overrideForm.getByLabel(/^Limit/).selectOption('internal_seats');
    await overrideForm.getByLabel(/^Allowance/).fill('99');
    await overrideForm.getByLabel(/^Note/).fill('parity e2e');
    await overrideForm.getByRole('button', { name: 'Apply override' }).click();

    // Case-insensitive: the keys are rendered through `titleCase`, so `internal_seats`
    // reaches the page as "Internal Seats".
    const overrideRow = staff
      .getByRole('table', { name: 'Overrides' })
      .getByRole('row', { name: /internal seats/i });
    await expect(overrideRow).toContainText('parity e2e');
    await expect(overrideRow).toContainText('99');

    // The raised allowance is live at once on the company's own meter.
    await expect(usageTable.getByRole('row', { name: /^internal seats/i })).toContainText('/ 99');

    await overrideRow.getByRole('button', { name: 'Revoke' }).click();
    await expect(staff.getByText('This company gets exactly what its plan grants.')).toBeVisible();

    await staff.close();
  });

  test('the paid company sees a comped trial appear on its own plan screen', async ({ browser }) => {
    // A second staff journey, ending on the *customer's* screen: the point of the
    // console is that what an operator does is visible to the company it was done to.
    const email = await registerHeadless({ handle: 'platform2', name: 'Sal Platform' });
    await makeSuperAdmin(email);
    const staff = await freshPage(browser);
    await signIn(staff, email);

    await staff.goto('/admin/companies');
    await staff.getByLabel('Name or member email').fill(`Signup Test Co ${RUN}`);
    await staff.getByRole('button', { name: 'Search' }).click();
    const row = staff.getByRole('row', { name: new RegExp(`Signup Test Co ${RUN}`) });
    await expect(row).toContainText('No subscription');
    await row.getByRole('button', { name: 'Open' }).click();

    // Anchored: the status field's hint mentions "plan change", and its accessible
    // name carries its selected value too.
    await staff.getByLabel(/^Plan/).selectOption('starter');
    await staff.getByLabel(/^Trial days/).fill('14');
    await staff.getByRole('button', { name: 'Comp / extend trial' }).click();
    await expect(staff.getByText(/Trial of starter runs to/)).toBeVisible();
    await staff.close();

    const signup = await freshPage(browser);
    await signIn(signup, emailFor('signup'));
    await signup.goto('/plan');
    // The free plan could not hire; the comped trial can.
    await expect(signup.getByText('You can engage your own subcontractors')).toBeVisible();
    await signup.close();
  });
  /*
   * ── Company ownership & creation safeguard (§3.1.1) ────────────────────────
   *
   * Three screens, one policy: the profile section that offers the included
   * company, the same section once the allowance is spent, and the Platform
   * console queue where the decision is actually made. Only a browser can prove
   * that the three agree — the API script proves the rules, but not that a
   * refused customer is shown the way forward rather than a dead end.
   */

  test('the included company is offered once, and the second one is not', async ({ browser }) => {
    const email = await registerHeadless({ handle: 'twoco', name: 'Priya Two' });
    // Verified, because an unverified address cannot request an additional
    // company at all — that refusal is asserted by the API script, and asserting
    // it again here would only prove the same rule twice.
    await verifyEmail(email);
    const page = await freshPage(browser);
    await signIn(page, email);

    // An account with no membership never reaches a page's own content — the
    // shell shows the companyless empty state instead. That is the real first
    // creation surface, and it is on the same allowance as every other one.
    await page.goto('/profile');
    await expect(page.getByRole('heading', { name: 'Create your company' })).toBeVisible();
    await page.getByLabel('Company name').fill(FIRST_CO);
    await page.getByRole('button', { name: 'Create company' }).click();
    await expect(page.getByRole('heading', { name: 'Profile' })).toBeVisible();
    await expect(page.getByRole('table', { name: 'Your company memberships' })).toContainText(
      FIRST_CO
    );

    // The allowance is spent, so the same section is now the advanced flow. The
    // wording change is the point: nothing says "you cannot", it says what the
    // next company costs you in ceremony.
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Start your company' })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Start another company' })).toBeVisible();

    twoCoEmail = email;
    await page.close();
  });

  test('a duplicate registration number routes to recovery instead of a second tenant', async ({
    browser,
  }) => {
    // Give the company a registered identity, then have somebody try to claim the
    // same one. This is the "confused re-registrant" persona: the answer is an
    // invitation, not a new empty tenant.
    await setRegistrationIdentity(FIRST_CO, 'GB', `SC ${RUN} 001`);

    const email = await registerHeadless({ handle: 'dupe', name: 'Sam Duplicate' });
    await verifyEmail(email);
    const page = await freshPage(browser);
    await signIn(page, email);

    await page.goto('/profile');
    await page.getByLabel('Company name').fill(`Duplicate Co ${RUN}`);
    await page.getByRole('button', { name: 'Create company' }).click();
    await expect(page.getByRole('heading', { name: 'Profile' })).toBeVisible();

    await page.getByRole('button', { name: 'Request a company' }).click();
    await page.getByLabel('Registered legal name').fill(`Copycat Holdings ${RUN}`);
    await page.getByLabel('Country').fill('GB');
    await page.getByLabel('Registration number').fill(`sc-${RUN}-001`);
    await page.getByLabel('Confirm your password').fill(PARITY_PASSWORD);
    await page.getByText(/separate legal business/).click();
    await page.getByRole('button', { name: 'Send request' }).click();

    // Refused — and the three ways out are on screen, which is the whole
    // difference between a safeguard and a wall.
    await expect(
      page.getByText('A company with this registration number is already on CrewQuo.')
    ).toBeVisible();
    await expect(page.getByText(/Ask an existing owner or admin/)).toBeVisible();
    await expect(page.getByText(/request ownership recovery from support/)).toBeVisible();
    await page.close();
  });

  test('an additional company is requested, approved in the console, and created', async ({
    browser,
  }) => {
    const page = await freshPage(browser);
    await signIn(page, twoCoEmail);
    await page.goto('/profile');

    await page.getByRole('button', { name: 'Request a company' }).click();
    await page.getByLabel('Registered legal name').fill(SECOND_CO);
    await page.getByLabel('Country').fill('GB');
    await page.getByLabel('Registration number').fill(`SC ${RUN} 777`);
    await page.getByLabel('Confirm your password').fill(PARITY_PASSWORD);

    // The attestation is the whole reason this flow is not a text field: it is
    // refused until it is ticked, by the schema as well as the button.
    const send = page.getByRole('button', { name: 'Send request' });
    await expect(send).toBeDisabled();
    await page.getByText(/separate legal business/).click();
    await expect(send).toBeEnabled();
    await send.click();

    // No email exists yet, so the row itself is the notification — and it appears
    // twice on purpose: once as the live status, once in the history table.
    const filed = page
      .locator('.cq-section')
      .filter({ has: page.getByRole('heading', { name: 'Your company request is with us' }) });
    await expect(filed).toBeVisible();
    await expect(filed.getByText('Pending review')).toBeVisible();
    await expect(
      page.getByRole('table', { name: 'Company creation requests' }).getByText('Pending review')
    ).toBeVisible();

    // ── The reviewer ────────────────────────────────────────────────────────
    const staffEmail = await registerHeadless({ handle: 'platform3', name: 'Mo Platform' });
    await makeSuperAdmin(staffEmail);
    const staff = await freshPage(browser);
    await signIn(staff, staffEmail);
    await staff.goto('/admin/operations');

    const queue = staff.getByRole('table', { name: 'Company creation requests' });
    const row = queue.getByRole('row', { name: new RegExp(SECOND_CO) });
    await expect(row).toBeVisible();
    // The reviewer's actual job in one column: this person already owns one.
    await expect(row).toContainText('Priya Two');

    // A decision with no reason is refused on the screen, not just by the API.
    await row.getByRole('button', { name: 'Approve' }).click();
    await expect(staff.getByText('Give a reason — it is the only record of why.')).toBeVisible();

    await staff.getByLabel('Decision reason').fill('Verified separate legal entity');
    await row.getByRole('button', { name: 'Approve' }).click();
    await expect(row).toContainText('Approved');
    await staff.close();

    // ── Back to the customer ────────────────────────────────────────────────
    await page.reload();
    await expect(
      page.getByRole('heading', { name: 'Your additional company is approved' })
    ).toBeVisible();
    // The legal identity is fixed to what was reviewed; only the trading name is open.
    await expect(page.getByLabel('Trading name')).toHaveValue(SECOND_CO);
    await page.getByRole('button', { name: 'Create company' }).click();

    // It exists, it is separate, and it is now switchable to.
    await expect(page.getByRole('table', { name: 'Your company memberships' })).toContainText(
      SECOND_CO
    );
    await expect(
      page.getByRole('table', { name: 'Company creation requests' }).getByText('Consumed')
    ).toBeVisible();

    // And the allowance stays spent: the section offers a request, not a company.
    await expect(page.getByRole('heading', { name: 'Start your company' })).toHaveCount(0);
    await page.close();
  });

  test('a second trial cannot be comped to the same owner through the new company', async ({
    browser,
  }) => {
    // The reset this ledger exists to stop, driven from the console an operator
    // would actually use: same person, new tenant, second free evaluation.
    const staffEmail = await registerHeadless({ handle: 'platform4', name: 'Ash Platform' });
    await makeSuperAdmin(staffEmail);
    const staff = await freshPage(browser);
    await signIn(staff, staffEmail);

    await staff.goto('/admin/companies');
    await staff.getByLabel('Name or member email').fill(FIRST_CO);
    await staff.getByRole('button', { name: 'Search' }).click();
    await staff
      .getByRole('row', { name: new RegExp(FIRST_CO) })
      .getByRole('button', { name: 'Open' })
      .click();
    await staff.getByLabel(/^Plan/).selectOption('starter');
    await staff.getByLabel(/^Trial days/).fill('14');
    await staff.getByRole('button', { name: 'Comp / extend trial' }).click();
    await expect(staff.getByText(/Trial of starter runs to/)).toBeVisible();

    await staff.goto('/admin/companies');
    await staff.getByLabel('Name or member email').fill(SECOND_CO);
    await staff.getByRole('button', { name: 'Search' }).click();
    await staff
      .getByRole('row', { name: new RegExp(SECOND_CO) })
      .getByRole('button', { name: 'Open' })
      .click();
    await staff.getByLabel(/^Plan/).selectOption('starter');
    await staff.getByLabel(/^Trial days/).fill('14');
    await staff.getByRole('button', { name: 'Comp / extend trial' }).click();

    await expect(
      staff.getByText(/does not reset trial eligibility|already had a trial on another company/)
    ).toBeVisible();
    await staff.close();
  });

  /*
   * Money boundary (§3.3 decision #5, docs/operating-model/money-boundary.md).
   *
   * The API script proves the arithmetic and every refusal. What only a browser
   * can prove is that the repair path is *reachable*: a figure withheld for a
   * missing rate is useless as a design if the person who can record that rate
   * cannot find the screen. These walk that path.
   */
  test('an exchange rate is recorded with the source its figures will cite', async () => {
    await contractor.goto('/settings');

    const fx = contractor.getByRole('region').filter({ hasText: 'Exchange rates' });
    await expect(
      contractor.getByRole('heading', { name: 'Exchange rates' })
    ).toBeVisible();
    // The empty state has to say who needs this, because most companies never do.
    await expect(contractor.getByText('No exchange rates recorded')).toBeVisible();

    // `Field` wraps its control, so the accessible name is the caption plus the
    // hint. Every label here is matched loosely for that reason — see the §40
    // label note in PROGRESS.md.
    await contractor.getByLabel(/^From \(ISO 4217\)/).fill('GBP');
    await expect(contractor.getByLabel(/^To \(ISO 4217\)/)).toHaveValue('USD');
    await contractor.getByLabel(/^Rate/).fill('1.2700');
    await contractor.getByLabel(/^As of/).fill(FUTURE_DATE);
    await contractor.getByLabel(/^Source/).fill('ECB reference rate');
    await contractor.getByRole('button', { name: 'Record rate' }).click();

    const row = contractor.getByRole('row', { name: /GBP to USD/ });
    await expect(row).toBeVisible();
    await expect(row).toContainText('1.2700000000');
    // Provenance is on the screen, not just in the database: this is the whole
    // reason Source is a required field rather than an optional note.
    await expect(row).toContainText('ECB reference rate');
    await expect(row).toContainText('not yet used');
  });

  test('a rate nothing cites can be deleted from the screen', async () => {
    await contractor.goto('/settings');
    const row = contractor.getByRole('row', { name: /GBP to USD/ });
    await expect(row).toBeVisible();

    // Nothing cites it, so Delete is live. There is deliberately no Edit control
    // anywhere on this row: a correction is a new rate at a later date, so a
    // figure that already cited the old one never moves.
    await expect(row.getByRole('button', { name: 'Edit' })).toHaveCount(0);
    await row.getByRole('button', { name: 'Delete' }).click();
    await expect(contractor.getByText('No exchange rates recorded')).toBeVisible();
  });

  test('a project names the currency it reports in, and says when that is fixed', async () => {
    await contractor.goto('/projects');
    await contractor.getByRole('link', { name: new RegExp(`Atrium refit ${RUN}`) }).click();
    await expect(contractor).toHaveURL(/\/projects\/[0-9a-f-]{36}/);
    await contractor.getByRole('button', { name: 'Settings' }).click();

    const reporting = contractor.getByLabel(/^Reporting currency/);
    await expect(reporting).toHaveValue('USD');

    // This project already carries approved work, so its unit is pinned. The
    // refusal has to explain itself rather than just fail.
    await reporting.fill('EUR');
    await contractor.getByRole('button', { name: 'Save changes' }).click();
    await expect(contractor.getByText(/already reports money/)).toBeVisible();
    await expect(contractor.getByText(/approved time log/)).toBeVisible();
  });
});
