import { expect, test } from '@playwright/test';

test.describe('Public surfaces', () => {
  test('the landing page links to pricing and both legal pages', async ({ page }) => {
    await page.goto('/');
    const footer = page.getByRole('contentinfo');
    await expect(footer.getByRole('link', { name: 'Pricing' })).toHaveAttribute('href', '/pricing');
    await expect(footer.getByRole('link', { name: 'Terms' })).toHaveAttribute('href', '/terms');
    await expect(footer.getByRole('link', { name: 'Privacy' })).toHaveAttribute('href', '/privacy');
  });

  for (const [route, heading, current, statusLabel] of [
    ['/terms', 'Terms of use', 'Terms', 'Pre-launch legal status'],
    ['/privacy', 'Privacy notice', 'Privacy', 'Pre-launch legal status'],
  ] as const) {
    test(`${route} is public, navigable and names its preview status`, async ({ page }) => {
      await page.goto(route);
      await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible();
      await expect(
        page
          .getByRole('navigation', { name: 'Public site navigation' })
          .getByRole('link', { name: current, exact: true })
      ).toHaveAttribute('aria-current', 'page');
      await expect(page.getByLabel(statusLabel)).toBeVisible();
      await expect(page.getByRole('link', { name: /Open workspace/ })).toHaveAttribute('href', '/login');
    });
  }

  /**
   * The prices on this page come from the live catalog, and this is the case that
   * proves it rather than asserting a number typed into the test.
   *
   * The free plan is the anchor. Its *absence* of a price is a product decision
   * (§5B — the Crew plan exists so a subcontractor can work for nothing), so a
   * page that renders it as free is reading real catalog data, and one that
   * renders it with a dollar figure has invented the figure.
   */
  test('the pricing page renders the live plan catalog, not hard-coded copy', async ({ page }) => {
    await page.goto('/pricing');

    await expect(
      page.getByRole('heading', { level: 1, name: 'Choose the control your operation needs.' })
    ).toBeVisible();
    await expect(page.getByText(/preview/i)).toHaveCount(0);
    await expect(
      page
        .getByRole('navigation', { name: 'Public site navigation' })
        .getByRole('link', { name: 'Pricing', exact: true })
    ).toHaveAttribute('aria-current', 'page');

    const plans = page.locator('#plans article');
    await expect(plans.first()).toBeVisible();
    expect(await plans.count()).toBeGreaterThan(1);

    // Both comparison tables are built from the whole key catalog, so what a plan
    // does *not* include is as visible as what it does.
    const allowances = page.getByRole('table', { name: 'Included allowances by plan' });
    const features = page.getByRole('table', { name: 'Included features by plan' });
    await expect(allowances.getByRole('rowheader', { name: 'Portal clients' })).toBeVisible();
    await expect(features.getByRole('rowheader', { name: 'Client portal' })).toBeVisible();

    // `null` is unlimited and `0` is none. Rendering both as a bare number would
    // invert the meaning of the most expensive tier, so both words must appear.
    await expect(allowances.getByText('Unlimited').first()).toBeVisible();
    await expect(allowances.getByRole('img', { name: 'Not included' }).first()).toBeVisible();
    await expect(features.getByRole('img', { name: 'Not included' }).first()).toBeVisible();

    // Structural, not a pinned figure: one plan priced at nothing renders as free,
    // and at least one renders a real monthly amount. Asserting "$47" would pin
    // the test to today's catalog, which is the thing this page must be free to
    // change without a code deploy.
    await expect(plans.filter({ hasText: 'Free' }).first()).toBeVisible();
    await expect(plans.filter({ hasText: /\$\d/ }).first()).toBeVisible();

    await page.getByRole('button', { name: 'Yearly' }).click();
    await expect(page.getByText(/Billed \$[\d,]+ yearly/).first()).toBeVisible();

    // One currency, so none of the machinery a multi-currency page would need.
    await page.getByText('What currency will I be charged in?', { exact: true }).click();
    await expect(page.getByText('Subscriptions are charged in US dollars.')).toBeVisible();
    await expect(page.getByRole('combobox', { name: /currency/i })).toHaveCount(0);

    // The page sends everybody to registration rather than to a buy button that
    // may refuse: whether checkout is live is a platform setting, and a public
    // page reporting it would be publishing platform configuration.
    await expect(page.getByRole('link', { name: 'Create your account' })).toHaveAttribute(
      'href',
      '/register'
    );
  });
});
