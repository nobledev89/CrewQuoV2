import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { RUN, provisionCompany, signIn } from './helpers';

/**
 * The WCAG 2.2 AA gate, the half no scanner asserts.
 *
 * `a11y.spec.ts` runs axe over every route and is a real check, but it reads a static
 * DOM: it cannot press a key, so it cannot tell you that a dialog holds focus, that a
 * task can be finished without a pointer, or that a refusal was *announced* rather than
 * merely drawn. Those three are this file, and they are the larger half of §42.
 *
 * The distinction is not academic. Every defect this file was written against passed the
 * full 40-route axe sweep on the same commit — a dialog that leaks focus has correct
 * markup, and `aria-modal="true"` is exactly the attribute a scanner wants to see.
 *
 * Prerequisites are the other specs': Postgres up, migrated and seeded, API on :4000.
 */

const OWNER_CO = `Keys Contracts ${RUN}`;

/** What has focus right now, in the terms these assertions are written in. */
async function focused(page: Page) {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el) return { exists: false, dropped: true, inDialog: false, name: '', tag: '' };
    return {
      exists: true,
      /*
       * Focus landing on the document root is the failure mode that matters most: it is
       * what the browser does when the element holding focus is removed, and it means
       * the next Tab starts from the top of the page.
       *
       * `<html>` as well as `<body>`, because that is what actually happened when this
       * spec first ran — checking only `body` reported the drawer's real focus bug as a
       * confusing name mismatch against the contents of an inline Next.js script tag,
       * rather than as "focus was dropped".
       */
      dropped: el === document.body || el === document.documentElement,
      inDialog: el.closest('[role="dialog"]') !== null,
      name: (el.getAttribute('aria-label') ?? el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 48),
      tag: el.tagName.toLowerCase(),
    };
  });
}

/**
 * Press Tab until `predicate` matches what is focused, up to `max` presses.
 *
 * The press count is the assertion, not an implementation detail: "reachable within 40
 * tabs" is the machine-checkable half of SC 2.1.1, and a loop that never matched is the
 * signature of either an unreachable control or a keyboard trap ahead of it.
 */
async function tabUntil(
  page: Page,
  predicate: (f: Awaited<ReturnType<typeof focused>>) => boolean,
  max = 40
): Promise<{ found: boolean; presses: number; trail: string[] }> {
  // The trail is kept so a failure says where Tab actually went. Without it the report
  // is "not reachable in 40 presses", which is true of an unreachable control, of a
  // trap, and of a name this spec guessed wrong — three different fixes.
  const trail: string[] = [];
  for (let i = 1; i <= max; i += 1) {
    await page.keyboard.press('Tab');
    const f = await focused(page);
    trail.push(`<${f.tag}> "${f.name}"`);
    if (predicate(f)) return { found: true, presses: i, trail };
  }
  return { found: false, presses: max, trail };
}

test.describe.configure({ mode: 'serial' });

test.describe('Keyboard and announcement acceptance', () => {
  let page: Page;

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
    const email = await provisionCompany({
      handle: 'keys-owner',
      name: 'Keys Owner',
      companyName: OWNER_CO,
      planId: 'business',
    });
    await signIn(page, email);
  });

  test.afterAll(async () => {
    await page.close();
  });

  /*
   * ── SC 2.4.3 / 2.1.2: the dialog contract ─────────────────────────────────────
   *
   * Driven against /rates/templates deliberately: its drawer is one of the five that
   * carry no `autoFocus`, so it is the case where the component itself has to move
   * focus. Testing only a drawer whose page happens to autofocus an input would prove
   * the page's habit rather than the component's behaviour.
   */

  /*
   * Each case opens the drawer it needs rather than inheriting one from the case before.
   *
   * Learned by breaking the trap on purpose: with the panel opened once and reused, a
   * single failure skipped the three cases after it, and running any one of them alone
   * with `--grep` failed because no drawer was open — a wrong reason that looks exactly
   * like the right one. Independence costs about 300ms per case and buys a failure that
   * names one defect.
   */
  async function openTemplateDrawer(): Promise<void> {
    await page.goto('/rates/templates');
    await page.getByRole('button', { name: 'New template' }).click();
    await expect(page.getByRole('dialog', { name: 'Add template' })).toBeVisible();
  }

  test('opening a drawer that autofocuses nothing still moves focus into it', async () => {
    await openTemplateDrawer();

    const f = await focused(page);
    // The panel itself, not its close button: the dialog's name is announced and the
    // first Tab goes forward into the form rather than starting the user on "dismiss".
    expect(f.inDialog, `focus was on <${f.tag}> "${f.name}", outside the dialog`).toBe(true);
    expect(f.tag).toBe('aside');
  });

  test('Tab cannot leave an open drawer', async () => {
    await openTemplateDrawer();
    // Well past the number of stops this panel has, so the cycle is exercised several
    // times over rather than merely reaching the end once.
    for (let i = 0; i < 30; i += 1) {
      await page.keyboard.press('Tab');
      const f = await focused(page);
      expect(f.inDialog, `Tab #${i + 1} escaped to <${f.tag}> "${f.name}"`).toBe(true);
    }
  });

  test('Shift+Tab from the first stop wraps to the last, rather than escaping backwards', async () => {
    await openTemplateDrawer();
    // Forwards from the panel lands on the first stop, which is the close button.
    await page.keyboard.press('Tab');
    expect((await focused(page)).name).toBe('Close panel');

    await page.keyboard.press('Shift+Tab');
    const f = await focused(page);
    expect(f.inDialog, `Shift+Tab escaped to <${f.tag}> "${f.name}"`).toBe(true);
    // The last *enabled* stop. "Add template" sits after it in the DOM but is disabled
    // while the name is empty, and a trap that treated a disabled control as its
    // boundary would strand Shift+Tab exactly when the form is still incomplete.
    expect(f.name).toBe('Cancel');
  });

  test('Escape closes the drawer and returns focus to the control that opened it', async () => {
    await openTemplateDrawer();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'Add template' })).toBeHidden();

    const f = await focused(page);
    // The specific failure this pins: the panel unmounts with focus inside it, focus
    // falls to the document root, and the next Tab restarts at the skip link — from
    // wherever in the page the user had walked to.
    expect(f.dropped, `focus was dropped to <${f.tag}> when the drawer closed`).toBe(false);
    expect(f.name).toBe('New template');
  });

  test('a drawer that autofocuses a field is left alone, and still returns focus on close', async () => {
    await page.goto('/rates/roles');
    await page.getByRole('button', { name: 'New role' }).click();
    await expect(page.getByRole('dialog', { name: 'Add role' })).toBeVisible();

    // The page's own choice of destination beats anything generic, so it is honoured.
    expect((await focused(page)).tag).toBe('input');

    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'Add role' })).toBeHidden();
    const after = await focused(page);
    expect(after.dropped, `focus was dropped to <${after.tag}> when the drawer closed`).toBe(false);
    expect(after.name).toBe('New role');
  });

  /*
   * ── SC 2.1.1: a real task, finished with no pointer at all ────────────────────
   */

  test('the navigation is reachable by Tab, with no trap on the way', async () => {
    await page.goto('/app');
    await expect(page.locator('.cq-account__name')).toBeVisible();

    // A nav *link*, not the "Rates" group heading above it — a heading is not a tab stop
    // and asking for one is how this assertion failed on its first run.
    const reached = await tabUntil(page, (f) => f.name === 'Roles');
    expect(
      reached.found,
      `the Roles nav link was not reached in 40 presses. Tab went: ${reached.trail.join(' → ')}`
    ).toBe(true);
  });

  test('a role is created start to finish using only the keyboard', async () => {
    const roleName = `Keyboard Rigger ${RUN}`;
    await page.goto('/rates/roles');
    await expect(page.getByRole('button', { name: 'New role' })).toBeVisible();

    // From here on, no click of any kind — Tab to reach, Enter to operate, and the
    // keyboard to type. A pointer is never used to open the panel, fill it or submit it.
    const reached = await tabUntil(page, (f) => f.name === 'New role');
    expect(
      reached.found,
      `the New role button was not reached by Tab. Tab went: ${reached.trail.join(' → ')}`
    ).toBe(true);

    await page.keyboard.press('Enter');
    await expect(page.getByRole('dialog', { name: 'Add role' })).toBeVisible();

    await page.keyboard.type(roleName);
    const onSubmit = await tabUntil(page, (f) => f.name === 'Add role', 10);
    expect(
      onSubmit.found,
      `the submit button was not reached from the field. Tab went: ${onSubmit.trail.join(' → ')}`
    ).toBe(true);
    await page.keyboard.press('Enter');

    /*
     * The proof is the row in the register, not a toast: the task is done when the
     * record exists.
     *
     * `exact` because the row's own Delete button is named "Delete <role>", so a
     * substring match resolves to two cells — the name cell and the actions cell. The
     * first run reported that as a strict-mode violation, which was the assertion being
     * imprecise rather than the workflow failing: the role had in fact been created by
     * keyboard alone.
     */
    await expect(page.getByRole('cell', { name: roleName, exact: true })).toBeVisible();
  });

  /*
   * ── SC 4.1.3: a refusal is announced, not just drawn ─────────────────────────
   */

  test('a refused sign-in is announced in a live region', async () => {
    const anon = await page.context().browser()!.newPage();
    try {
      await anon.goto('/login');
      await anon.getByLabel('Email address').fill(`nobody+${RUN}@parity.crewquo.test`);
      await anon.getByLabel('Password').fill('definitely-not-the-password');
      await anon.getByRole('button', { name: 'Sign in' }).click();

      /*
       * The message is found first and then required to be *inside* a live region —
       * rather than finding a live region and hoping the message is in it. That is the
       * whole point of the case: a refusal rendered into an ordinary <p> is visible to a
       * sighted reader and silent to a screen reader, so the form appears to have done
       * nothing and the button gets pressed again. Asserting the text alone passes
       * either way.
       *
       * `getByRole('alert')` on its own is not usable here: Next's route announcer is
       * itself a permanent `role="alert"` on every page, so the role is ambiguous and a
       * bare role query is a strict-mode violation waiting for its first failure.
       */
      const refusal = anon.locator('.cq-error');
      await expect(refusal).toBeVisible();
      await expect(refusal).not.toBeEmpty();
      const announced = await refusal.evaluate((el) => el.closest('[role="alert"]') !== null);
      expect(announced, 'the refusal was rendered outside any live region').toBe(true);
    } finally {
      await anon.close();
    }
  });

  test('a form that refuses on the server keeps the message in a live region', async () => {
    // A duplicate role is a server-side refusal rather than a browser validation
    // message, which is the path that has to be announced by the app rather than the
    // user agent. The role created above is the duplicate.
    await page.goto('/rates/roles');
    await page.getByRole('button', { name: 'New role' }).click();
    await page.keyboard.type(`Keyboard Rigger ${RUN}`);
    await page.getByRole('button', { name: 'Add role' }).click();

    const refusal = page.locator('.cq-error');
    await expect(refusal).toBeVisible();
    const announced = await refusal.evaluate((el) => el.closest('[role="alert"]') !== null);
    expect(announced, 'the server refusal was rendered outside any live region').toBe(true);
  });

  test('a client-side navigation announces the page it arrived at', async () => {
    /*
     * The SPA problem SC 4.1.3 exists for: an in-app link swaps the page contents with
     * no browser navigation, so nothing tells a screen reader anything happened.
     *
     * Next's route announcer already handles this — a permanent `role="alert"` region it
     * writes the new page's name into — and this case is here to *pin* that rather than
     * to add it. It is framework behaviour the app depends on and does not own: it is
     * fed by the document title, which `Shell` sets from the route, so a refactor that
     * stopped setting the title would silence every navigation in the product while
     * every axe check stayed green.
     */
    await page.goto('/app');
    await expect(page.locator('.cq-account__name')).toBeVisible();

    await page.getByRole('link', { name: 'Roles' }).click();
    await expect(page).toHaveURL(/\/rates\/roles/);

    const announcer = page.locator('[role="alert"][aria-live]');
    await expect(announcer).toHaveText(/Roles/);
  });
});

/*
 * ── SC 2.5.7: dragging movements ─────────────────────────────────────────────────
 *
 * A source scan rather than a browser case, because the requirement is about a class of
 * interaction that does not exist yet and must not arrive unaccompanied. Phase 7 has
 * "drag-and-drop batch upload" written into it (§22.3, 7.3, 7.6) and Phase 11 has a
 * drag-and-drop scheduler (§31); both are the exact shape SC 2.5.7 exists for.
 *
 * Asserting "there are no drags today" would be a test of a fact rather than of a rule,
 * and it would pass right up until the commit that matters and then fail with no
 * explanation of what to do. So this is the same mechanism the colour literals got: a
 * registry with a written reason per entry, empty for now, that fails the build when a
 * drag handler appears without one. The failure message carries the requirement.
 */

interface DragExemption {
  /** Path fragment the handler lives in. */
  readonly where: string;
  /** The pointer-free path to the same outcome. Not "it is also a button somewhere". */
  readonly nonDragEquivalent: string;
}

/**
 * Every drag interaction in the product, with the equivalent that satisfies SC 2.5.7.
 *
 * Empty on purpose. When Phase 7 lands drag-and-drop upload, the entry goes here *and*
 * the equivalent goes in the UI — a file input reachable by keyboard, a "move to…"
 * control on the row, whatever it is. An entry with a plausible sentence and no shipped
 * control is the failure this cannot catch, which is why the equivalent is named
 * specifically enough to be looked for.
 */
const DRAG_EXEMPTIONS: readonly DragExemption[] = [];

/** `onDragStart`, `onDrop`, `draggable`, and the pointer-drag primitives. */
const DRAG_PATTERN = /\bon(?:DragStart|DragEnd|DragOver|DragEnter|DragLeave|Drop)\b|\bdraggable\s*=|\bdataTransfer\b|\bsetPointerCapture\b/;

function sourceFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry === '.next' || entry === 'dist') continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry)) out.push(full);
    }
  };
  walk(root);
  return out;
}

test('every drag interaction has a registered non-drag equivalent', () => {
  const roots = [
    join(__dirname, '..', 'src'),
    join(__dirname, '..', '..', '..', 'packages', 'ui', 'src'),
  ];

  const found: string[] = [];
  for (const root of roots) {
    for (const file of sourceFiles(root)) {
      const source = readFileSync(file, 'utf8');
      /*
       * Comments are stripped before matching, because this file and the Drawer both
       * *discuss* dragging — the Drawer's note explains that a horizontally scrolling
       * table is a drag for a pointer user. The colour scan learned the same lesson the
       * hard way on its first run: a tool that reads prose as code makes documenting a
       * fix cost you a build.
       */
      const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
      if (!DRAG_PATTERN.test(code)) continue;
      const rel = file.replace(/\\/g, '/');
      if (DRAG_EXEMPTIONS.some((e) => rel.includes(e.where))) continue;
      found.push(rel.slice(rel.indexOf('/src/') + 1));
    }
  }

  expect(
    found,
    [
      'A drag interaction was added with no registered non-drag equivalent.',
      '',
      'WCAG 2.2 SC 2.5.7 requires every dragging movement to have a single-pointer',
      'alternative that reaches the same outcome — and §42 requires it to be operable',
      'by keyboard. A drop zone whose only other affordance is "you can also drag from',
      'your file manager" is not an alternative.',
      '',
      'Ship the equivalent, then add an entry to DRAG_EXEMPTIONS in this file naming it',
      'specifically enough that the next reader can go and look for it.',
      '',
      `Unregistered: ${found.join(', ')}`,
    ].join('\n')
  ).toEqual([]);
});
