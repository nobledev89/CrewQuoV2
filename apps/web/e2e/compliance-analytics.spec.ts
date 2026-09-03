import { expect, test, type Page } from '@playwright/test';
import { RUN, createProjectHeadless, freshPage, provisionCompany, signIn } from './helpers';

test.describe.configure({ mode: 'serial' });

let page: Page;
let ownerEmail: string;
let firstProject: string;
let secondProject: string;

test.beforeAll(async ({ browser }) => {
  ownerEmail = await provisionCompany({
    handle: `phase12-${RUN}`,
    name: 'Phase Twelve Owner',
    companyName: `Phase Twelve ${RUN}`,
    planId: 'business',
  });
  firstProject = await createProjectHeadless(ownerEmail, `Quarter One ${RUN}`);
  secondProject = await createProjectHeadless(ownerEmail, `Quarter Two ${RUN}`);
  page = await freshPage(browser);
  await signIn(page, ownerEmail);
});

test.afterAll(async () => page.close());

test('the compliance register exposes honest empty and enforcement states', async () => {
  await page.goto('/compliance');
  await expect(page.getByRole('heading', { name: 'Compliance' })).toBeVisible();
  await expect(page.getByText(/Enforcement is off/)).toBeVisible();
  await expect(page.getByText('No subcontractors to check')).toBeVisible();
  await expect(page.getByText('No compliance records match')).toBeVisible();
  await page.getByRole('button', { name: 'Add requirement' }).click();
  await expect(page.getByRole('heading', { name: 'Add compliance requirement' })).toBeVisible();
  await expect(page.getByRole('checkbox', { name: 'Mandatory for work' })).toBeChecked();
});

test('client reporting offers quarter and year periods without inventing history', async () => {
  await page.goto('/sustainability/clients');
  await expect(page.getByRole('heading', { name: 'Client reporting' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'This year' })).toBeVisible();
  for (const quarter of ['Q1', 'Q2', 'Q3', 'Q4']) {
    await expect(page.getByRole('button', { name: quarter })).toBeVisible();
  }
  await expect(page.getByText('No client-period reports yet')).toBeVisible();
});

test('cross-project comparison keeps unknown carbon unknown', async () => {
  await page.goto('/sustainability');
  await expect(page.getByRole('heading', { name: /Sustainability/i })).toBeVisible();
  await page.getByLabel(`Compare Quarter One ${RUN}`).check();
  await page.getByLabel(`Compare Quarter Two ${RUN}`).check();
  const comparison = page.getByRole('table', { name: 'Cross-project comparison' });
  await expect(comparison).toBeVisible();
  await expect(comparison.getByText('Baseline')).toBeVisible();
  const rows = comparison.getByRole('row');
  await expect(rows.filter({ hasText: `Quarter One ${RUN}` })).toContainText('—');
  await expect(rows.filter({ hasText: `Quarter Two ${RUN}` })).toContainText('—');
  expect(firstProject).not.toBe(secondProject);
});
