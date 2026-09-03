import { expect, test, type Page } from '@playwright/test';
import {
  PARITY_PASSWORD,
  RUN,
  createProjectHeadless,
  disableFeature,
  freshPage,
  inviteAndAccept,
  provisionCompany,
  registerHeadless,
  setBundle,
  signIn,
} from './helpers';

/**
 * Phase 11 through the browser (§30, §31, §35).
 *
 * `verify:e2e` proves the arithmetic and every refusal against the API. This proves
 * the five things **only a rendered page can be wrong about**, and each of them is a
 * rule the packet states about a screen rather than about a payload:
 *
 *  1. **A sourceless budget row prints "Not tracked", never a zero and never
 *     −100%.** The API returns `null`; the way a zero appears is a `?? 0` in a
 *     component, which type-checks and renders a number nobody measured on the
 *     screen a contractor reads before a client meeting. This is the assertion that
 *     catches it (packet finding 2).
 *  2. **An approved variation has no edit affordance at all** — not a disabled
 *     button. A form that looks editable teaches somebody to try, and the whole
 *     point of finding 4 is that a client's agreement to a figure cannot be quietly
 *     rewritten.
 *  3. **A supervisor sees the Schedule and not the Budget.** That is the single
 *     clearest demonstration that §37's capability layer earns its existence, and
 *     it is a property of a rail rather than of a route.
 *  4. **A clash is rendered beside a saved row**, not as a refusal. §31 says so in
 *     words, and the way it gets broken is a modal that stays open.
 *  5. **The timeline says why a filter is empty.** §35 names incidents and the plan
 *     declares no table for them; a blank panel reads as a bug.
 *
 * Serial, sharing one signed-in page — the shape `project-assets.spec.ts` and
 * `project-sustainability.spec.ts` both use.
 */
test.describe.configure({ mode: 'serial' });

const OWNER_CO = `Commercial Owner ${RUN}`;

let page: Page;
let ownerEmail: string;
let supervisorEmail: string;
let projectId: string;
let roleId: string;

/** A role and a PAY/BILL pair, so a LABOUR line has something to resolve against. */
async function seedRates(email: string): Promise<string> {
  const { token, companyId } = await apiSession(email);
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
    'X-Company-Id': companyId,
  };
  const role = await fetch(`${API_URL}/v1/role-catalog`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ name: `Rigger ${RUN}` }),
  });
  const id = ((await role.json()) as { role: { id: string } }).role.id;
  for (const kind of ['PAY', 'BILL'] as const) {
    await fetch(`${API_URL}/v1/rate-cards`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        kind,
        roleId: id,
        rateMode: 'HOURLY',
        rateLabel: 'MON_FRI_DAY',
        hourlyRateCents: kind === 'PAY' ? 5000 : 8000,
        effectiveFrom: '2026-01-01',
      }),
    });
  }
  return id;
}

const API_URL = process.env.VERIFY_API_URL ?? 'http://127.0.0.1:4000';

async function apiSession(email: string): Promise<{ token: string; companyId: string }> {
  const res = await fetch(`${API_URL}/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PARITY_PASSWORD }),
  });
  if (!res.ok) throw new Error(`login ${email} failed: ${res.status}`);
  const body = (await res.json()) as {
    tokens: { accessToken: string };
    memberships: { companyId: string }[];
  };
  return { token: body.tokens.accessToken, companyId: body.memberships[0]!.companyId };
}

test.beforeAll(async ({ browser }) => {
  ownerEmail = await provisionCompany({
    handle: `com-owner-${RUN}`,
    name: 'Commercial Owner',
    companyName: OWNER_CO,
    planId: 'pro',
  });
  roleId = await seedRates(ownerEmail);
  projectId = await createProjectHeadless(ownerEmail, `Commercial ${RUN}`);

  supervisorEmail = await registerHeadless({
    handle: `com-sup-${RUN}`,
    name: 'Commercial Supervisor',
  });
  await inviteAndAccept(ownerEmail, supervisorEmail);
  await setBundle(OWNER_CO, supervisorEmail, 'supervisor');

  page = await freshPage(browser);
  await signIn(page, ownerEmail);
});

test.afterAll(async () => {
  await page.close();
});

test('the rail lists Variations, Budget, Schedule and Timeline', async () => {
  await page.goto(`/projects/${projectId}`);
  await expect(page.getByRole('button', { name: /^Variations/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Budget vs actual/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Schedule/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Timeline/ })).toBeVisible();
});

/**
 * Packet finding 2, on the screen it is about.
 *
 * Six of §30.2's ten categories have no source of money anywhere in the schema, and
 * the row a literal implementation renders is *"Vehicles · Budget £3,000 · Actual £0
 * · Variance −£3,000 / −100%"*. Every character of that is wrong in the favourable
 * direction, and the way it appears is one `?? 0` in a component.
 */
test('a budget category with no source says so, and never renders a zero', async () => {
  await page.goto(`/projects/${projectId}?section=budget`);
  await expect(page.getByRole('heading', { name: 'Budget vs actual' })).toBeVisible();

  await page.getByRole('button', { name: /Set a budget|Revise budget/ }).click();
  // The vehicle line, which is budgeted and has nothing to compare against.
  await page.getByLabel('Vehicles', { exact: false }).fill('3000');
  await page.getByLabel('Labour (your crews)').fill('1000');
  await page.getByRole('button', { name: 'Save budget' }).click();

  const table = page.getByRole('table', { name: 'Budget versus actual' });
  await expect(table).toBeVisible();
  const vehicles = table.getByRole('row').filter({ hasText: 'Vehicles' });
  await expect(vehicles.getByText('Not tracked')).toBeVisible();

  /*
   * **The assertion is scoped to the sourceless rows, and its first version was
   * not — which is the same confusion this whole module exists to prevent.**
   *
   * "No −100% anywhere in the table" failed on the Labour row, and the Labour row
   * was right: the project has a £1,000 labour budget and no approved labour, so
   * its actual is a **genuine zero** and −100% is a true variance. The distinction
   * between a real zero and an absent figure is the finding; a test that cannot
   * tell them apart was making exactly the mistake it was written to catch.
   *
   * So: every row with no source shows "Not tracked" and an em-dash, and no
   * percentage at all. The rows that can be computed are free to be as negative as
   * the facts are.
   */
  /*
   * The rows are read once and keyed on their **first cell**, not with
   * `filter({ hasText })`. The obvious version matched two rows for "Purchases",
   * because the Materials row's own explanation ends *"Record purchases as
   * expenses."* — a strict-mode violation caused by the panel doing exactly what
   * finding 2 asked of it, which is a nice way to be wrong.
   */
  const rows = await table.evaluate((el) =>
    [...el.querySelectorAll('tbody tr')].map((tr) => ({
      head: (tr.querySelector('th, td')?.textContent ?? '').trim(),
      text: (tr.textContent ?? '').replace(/\u2212/g, '-'),
    }))
  );

  const sourceless = ['Vehicles', 'Mileage', 'Waste & disposal', 'Materials', 'Purchases', 'Other'];
  for (const label of sourceless) {
    const row = rows.find((r) => r.head.startsWith(label));
    expect(row, `no row labelled ${label}`).toBeTruthy();
    expect(row!.text, `${label} should say Not tracked`).toContain('Not tracked');
    expect(row!.text, `${label} should carry no percentage`).not.toContain('%');
    expect(row!.text, `${label} should carry no invented variance`).not.toContain('-100');
  }

  // And the row that CAN be computed reports its real, honest −100%.
  const labour = rows.find((r) => r.head.startsWith('Labour (your crews)'));
  expect(labour, 'no labour row').toBeTruthy();
  expect(labour!.text).toContain('-100.0%');
  expect(labour!.text).not.toContain('Not tracked');

  // The reason is on the row, because "not tracked" on its own sends somebody to
  // support to ask whether it is a bug.
  await expect(vehicles.getByText(/CrewQuo|expense/i)).toBeVisible();
});

/**
 * The withholding rule propagating, which is the other half of finding 2.
 *
 * This project has no client, so no BILL card can resolve and `billCents` is null —
 * so `revenueCents` is null with it and the revenue row says "Not tracked" rather
 * than reporting a revenue of nothing. A project with one unpriced hour has an
 * unknown revenue, not a revenue of zero.
 */
test('a project with no priced work has no revenue figure, not a revenue of nothing', async () => {
  await page.goto(`/projects/${projectId}?section=budget`);
  const table = page.getByRole('table', { name: 'Budget versus actual' });
  const rows = await table.evaluate((el) =>
    [...el.querySelectorAll('tbody tr')].map((tr) => ({
      head: (tr.querySelector('th, td')?.textContent ?? '').trim(),
      text: tr.textContent ?? '',
    }))
  );
  expect(rows.find((r) => r.head.startsWith('Revenue'))?.text).toContain('Not tracked');
  // And the profit line goes with it rather than netting four of ten categories.
  expect(rows.find((r) => r.head.startsWith('Profit'))?.text).toContain('Not yet');
});

test('the budget explains the untracked share rather than leaving it implied', async () => {
  await page.goto(`/projects/${projectId}?section=budget`);
  await expect(
    page.getByText(/no actual to compare against/i)
  ).toBeVisible();
});

/**
 * Packet finding 4. An approved variation is what a named person outside the
 * tenancy agreed to pay, and the affordance has to be absent rather than disabled.
 */
test('an approved variation offers no way to edit it', async () => {
  await page.goto(`/projects/${projectId}?section=variations`);
  await expect(page.getByRole('heading', { name: 'Variations & extra works' })).toBeVisible();

  await page.getByRole('button', { name: 'Raise a variation' }).click();
  await page.getByLabel('Reference').fill('VO-001');
  await page.getByLabel('Description', { exact: true }).fill('Extra fire doors to core');
  await page.getByLabel('Who asked for it').fill('Dana Whitfield');

  // One stated MATERIAL line — no rate card needed, so the assertion is about the
  // state machine rather than about pricing.
  await page.getByLabel('Kind').selectOption('MATERIAL');
  await page.getByLabel('Line description').fill('Door sets');
  await page.getByLabel('Quantity').fill('4');
  await page.getByLabel('Unit cost').fill('240');
  await page.getByLabel('Unit sell').fill('310');
  await page.getByRole('button', { name: 'Save' }).click();

  const row = page.getByRole('row').filter({ hasText: 'VO-001' });
  await expect(row).toBeVisible();
  await expect(row.getByRole('button', { name: 'Edit' })).toBeVisible();

  /*
   * `{ exact: true }` on both, because the status badge and the edit refusal are two
   * correct renderings of the same word: the badge says "Approved" and the sentence
   * beside it says *"This variation is approved and the figures are what was
   * agreed."* A substring match resolves to both and Playwright refuses — which is
   * the test being imprecise rather than the panel being wrong.
   */
  await row.getByRole('button', { name: 'Submit' }).click();
  await expect(row.getByText('Submitted', { exact: true })).toBeVisible();
  await row.getByRole('button', { name: 'Approve' }).click();
  await expect(row.getByText('Approved', { exact: true })).toBeVisible();

  // The affordance is GONE, and the sentence is there instead.
  await expect(row.getByRole('button', { name: 'Edit' })).toHaveCount(0);
  await expect(row.getByText(/Raise a new variation/i)).toBeVisible();
});

/**
 * Packet §3's warning, visible. Approval without the client's own agreement is
 * permitted — the crew works on Wednesday and the paperwork arrives on Friday — and
 * the only reason it is permitted is that it is never silent.
 */
test('an approval with no client evidence is badged rather than hidden', async () => {
  await page.goto(`/projects/${projectId}?section=variations`);
  const row = page.getByRole('row').filter({ hasText: 'VO-001' });
  await expect(row.getByText('Client agreement not on file')).toBeVisible();
});

/**
 * The clearest demonstration that §37's layer earns its existence: one person, two
 * sections, and the money is the one they cannot reach.
 */
test('a supervisor sees the Schedule and not the Budget', async ({ browser }) => {
  const supPage = await freshPage(browser);
  try {
    await signIn(supPage, supervisorEmail);
    await supPage.goto(`/projects/${projectId}`);

    await expect(supPage.getByRole('button', { name: /^Schedule/ })).toBeVisible();
    // Not merely disabled — absent. A section that answers 403 when clicked is worse
    // than one that is not offered.
    await expect(supPage.getByRole('button', { name: /^Budget vs actual/ })).toHaveCount(0);

    // And Variations IS offered, because a supervisor holds `variation.create`. The
    // money columns are what is withheld.
    await supPage.goto(`/projects/${projectId}?section=variations`);
    await expect(
      supPage.getByRole('heading', { name: 'Variations & extra works' })
    ).toBeVisible();
    await expect(supPage.getByRole('columnheader', { name: 'To client' })).toHaveCount(0);
    await expect(supPage.getByRole('columnheader', { name: 'Margin' })).toHaveCount(0);
  } finally {
    await supPage.close();
  }
});

/**
 * §31: *"Conflict detection is a warning, not a block — overlapping assignments for
 * the same user or vehicle are surfaced at save time with the clash named."* So the
 * drawer closes, the row is there, and the clash is beside it.
 */
test('a double-booking saves, and the clash is named beside the row', async () => {
  await page.goto(`/projects/${projectId}?section=schedule`);
  await expect(page.getByRole('heading', { name: 'Schedule', exact: true })).toBeVisible();

  /*
   * **`{ exact: true }` on the plain inputs and NOT on the selects**, which looks
   * inconsistent and is forced.
   *
   * `getByLabel` matches a substring by default, and this drawer has three labels
   * containing "Day" — the Shift select, the date input and the "Supervisor for the
   * day" checkbox — so the date input needs an exact match.
   *
   * But an exact match is impossible on the selects, because `Field` renders a
   * wrapping `<label>`: everything inside it becomes part of the control's
   * accessible name, including the hint **and every option of a `<select>`**. The
   * Shift picker's accessible name is literally
   * `"ShiftNot statedWeekday dayNightSundayShiftDaily"`. That is a real
   * design-system defect rather than a quirk of this drawer — it affects every
   * hinted field and every select in the product — and it is recorded in PROGRESS
   * rather than fixed here, because `Field` is shared by 31 screens and changing how
   * it names its controls is a decision of its own, not a side effect of Phase 11.
   */
  const book = async (from: string, to: string) => {
    await page.getByRole('button', { name: 'Book someone' }).click();
    await page.getByLabel('What are you booking').selectOption('USER');
    await page.getByLabel('Person').selectOption({ index: 1 });
    await page.getByLabel('Role').selectOption({ index: 1 });
    await page.getByLabel('Shift').selectOption('WEEKDAY_DAY');
    await page.getByLabel('Day', { exact: true }).fill('2026-09-14');
    await page.getByLabel('From', { exact: true }).fill(from);
    await page.getByLabel('To', { exact: true }).fill(to);
    await page.getByRole('button', { name: 'Book', exact: true }).click();
  };

  await book('07:00', '17:00');
  await expect(page.getByRole('table', { name: 'Schedule' })).toBeVisible();

  await book('09:00', '14:00');
  // The drawer closed — a modal that stayed open with a warning in it would read as
  // a refusal, which is the one thing §31 says this must not be.
  await expect(page.getByRole('button', { name: 'Book', exact: true })).toHaveCount(0);
  await expect(page.getByRole('status')).toContainText(/also booked/i);
});

test('an assignment with no shift type shows no planned figure', async () => {
  await page.goto(`/projects/${projectId}?section=schedule`);
  await page.getByRole('button', { name: 'Book someone' }).click();
  await page.getByLabel('What are you booking').selectOption('USER');
  await page.getByLabel('Person').selectOption({ index: 1 });
  await page.getByLabel('Role').selectOption({ index: 1 });
  // Shift deliberately left at "Not stated" — packet finding 6.
  await page.getByLabel('Day', { exact: true }).fill('2026-09-21');
  await page.getByRole('button', { name: 'Book', exact: true }).click();

  await expect(page.getByText('Not priced').first()).toBeVisible();
  await expect(
    page.getByText(/needs a role and a shift type/i)
  ).toBeVisible();
});

/**
 * §35's test of whether the timeline works is a sentence: *"Someone who was not on
 * site should be able to read the timeline and understand what happened."*
 */
test('the timeline reads as a chronology, and says what it cannot show', async () => {
  await page.goto(`/projects/${projectId}?section=timeline`);
  await expect(page.getByRole('heading', { name: 'Timeline' })).toBeVisible();

  /*
   * The list is read once rather than asserted with `getByText`, which resolved to
   * three elements for "Project created": the filter's own `<option>`, the type
   * badge, and the description link. All three are correct — the badge carries the
   * type label and the description happens to be the same words for this one type —
   * and a selector that cannot tell a filter option from a rendered event is not
   * testing the chronology.
   */
  const story = await page.locator('ol.cq-timeline').innerText();
  expect(story).toContain('Project created');
  expect(story).toMatch(/Variation raised VO-001/);

  // The one class §35 names that has no table anywhere in the plan. A blank panel
  // reads as a bug; saying so is the honest answer.
  await expect(page.getByText(/Not shown:/)).toContainText(/Incidents/);
});

test('a timeline filter that matches nothing explains itself', async () => {
  await page.goto(`/projects/${projectId}?section=timeline`);
  await page.getByLabel('Filter the timeline by kind of event').selectOption('DIARY_ENTRY');
  await expect(
    page.getByText(/Nothing of that kind has been recorded/i)
  ).toBeVisible();
});

/**
 * §20's progressive disclosure, proved the way `project-sections.spec.ts` proves it:
 * a real per-company entitlement override rather than a plan that happens to lack
 * the key.
 */
test('a company without the feature is not offered the section', async ({ browser }) => {
  await disableFeature(OWNER_CO, 'variations');
  const fresh = await freshPage(browser);
  try {
    await signIn(fresh, ownerEmail);
    await fresh.goto(`/projects/${projectId}`);
    await expect(fresh.getByRole('button', { name: /^Schedule/ })).toBeVisible();
    await expect(fresh.getByRole('button', { name: /^Variations/ })).toHaveCount(0);
    // Budget goes with it: §30.2's actuals are sold under the same key.
    await expect(fresh.getByRole('button', { name: /^Budget vs actual/ })).toHaveCount(0);
    // And the Timeline stays, because §35 needs no feature key — it is structure
    // rather than content, and each of its sources is gated by its own records' key.
    await expect(fresh.getByRole('button', { name: /^Timeline/ })).toBeVisible();
  } finally {
    await fresh.close();
  }
});
