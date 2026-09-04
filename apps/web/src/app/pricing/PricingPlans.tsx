'use client';

import {
  FEATURE_KEYS,
  LIMIT_KEYS,
  type BillingPlan,
  type FeatureKey,
  type LimitKey,
} from '@crewquo/shared';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { api } from '@/api/client';
import { useAsyncData } from '@/lib/useAsyncData';
import styles from './pricing.module.css';

const LIMIT_LABELS: Record<LimitKey, string> = {
  active_subcontractors: 'Active subcontractors',
  internal_seats: 'Team seats',
  clients: 'Portal clients',
  audit_retention_days: 'Audit history',
  storage_gb: 'File storage',
  evidence_uploads_per_month: 'Evidence uploads / month',
  factor_sets: 'Imported factor sets',
  artifact_retention_days: 'Completed-project records',
};

const LIMIT_UNITS: Partial<Record<LimitKey, string>> = {
  audit_retention_days: 'days',
  storage_gb: 'GB',
  artifact_retention_days: 'days',
};

const FEATURE_LABELS: Record<FeatureKey, string> = {
  rate_cards: 'Rate cards',
  holiday_rates: 'Holiday & timeframe rates',
  exports: 'PDF & spreadsheet exports',
  client_portal: 'Client portal',
  client_portal_notes: 'Portal notes',
  project_evidence: 'Photos & evidence',
  project_documents: 'Project documents',
  site_diary: 'Site diary',
  asset_tracking: 'Asset & material tracking',
  sustainability: 'Sustainability & carbon reporting',
  carbon_engine: 'Carbon engine',
  custom_factors: 'Custom emission factors',
  sustainability_reports: 'Sustainability reports',
  evidence_pack: 'Evidence & completion pack',
  client_signoff: 'Client sign-off',
  client_reporting: 'Client-level reporting',
  variations: 'Variations & extra works',
  scheduling: 'Crew scheduling',
  compliance_tracking: 'Compliance tracking',
  invoicing: 'Invoicing',
  audit_visibility: 'Client-visible audit trail',
  api_access: 'API access',
  sso: 'Single sign-on',
  white_label: 'White label',
};

const FEATURE_PRIORITY: readonly FeatureKey[] = [
  'client_portal',
  'rate_cards',
  'scheduling',
  'invoicing',
  'compliance_tracking',
  'sustainability_reports',
  'api_access',
  'sso',
];

type BillingPeriod = 'MONTH' | 'YEAR';

function formatAmount(amountCents: number, maximumFractionDigits = 0): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits,
  }).format(amountCents / 100);
}

function formatLimit(plan: BillingPlan, key: LimitKey): string {
  const value = plan.entitlements.limits[key];
  if (value === null) return 'Unlimited';
  if (value === 0 || value === undefined) return 'Not included';
  const unit = LIMIT_UNITS[key];
  return unit ? `${value.toLocaleString()} ${unit}` : value.toLocaleString();
}

function planHighlights(plan: BillingPlan): string[] {
  if (!plan.entitlements.operatesDownstream) {
    return [
      'Work as a subcontractor',
      'Log and submit time',
      'Join client workspaces',
      'Export your data',
    ];
  }

  const highlights = [
    `${formatLimit(plan, 'active_subcontractors')} active subcontractors`,
    `${formatLimit(plan, 'internal_seats')} team seats`,
  ];
  for (const key of FEATURE_PRIORITY) {
    if (plan.entitlements.features.includes(key)) highlights.push(FEATURE_LABELS[key]);
    if (highlights.length === 5) break;
  }
  return highlights;
}

function savingPercent(plan: BillingPlan): number | null {
  const monthly = plan.prices.find((price) => price.interval === 'MONTH');
  const yearly = plan.prices.find((price) => price.interval === 'YEAR');
  if (!monthly || !yearly || monthly.amountCents === 0) return null;
  return Math.round((1 - yearly.amountCents / (monthly.amountCents * 12)) * 100);
}

export function PricingPlans() {
  const [period, setPeriod] = useState<BillingPeriod>('MONTH');
  const { data, loading, error } = useAsyncData(() => api.publicPricing(), []);
  const highestSaving = useMemo(
    () => Math.max(0, ...(data?.plans.map((plan) => savingPercent(plan) ?? 0) ?? [])),
    [data]
  );

  if (loading) {
    return (
      <section className={styles.plansSection} id="plans" aria-label="Loading plans">
        <div className={styles.loadingGrid} aria-hidden="true">
          {[0, 1, 2, 3].map((item) => <span key={item} />)}
        </div>
        <p className={styles.srOnly} role="status">Loading plans…</p>
      </section>
    );
  }

  if (error || !data || data.plans.length === 0) {
    return (
      <section className={styles.plansSection} id="plans">
        <div className={styles.loadError} role="alert">
          <h2>We couldn&apos;t load the plans.</h2>
          <p>{error ?? 'Please try again shortly.'}</p>
          <Link href="/register">Create a free workspace</Link>
        </div>
      </section>
    );
  }

  return (
    <>
      <section className={styles.plansSection} id="plans" aria-labelledby="plans-title">
        <div className={styles.plansHeader}>
          <div>
            <p className={styles.eyebrow}>Plans</p>
            <h2 id="plans-title">Start lean. Scale without changing systems.</h2>
          </div>
          <div className={styles.periodControl}>
            <div className={styles.periodToggle} role="group" aria-label="Billing period">
              <button
                type="button"
                aria-pressed={period === 'MONTH'}
                onClick={() => setPeriod('MONTH')}
              >
                Monthly
              </button>
              <button
                type="button"
                aria-pressed={period === 'YEAR'}
                onClick={() => setPeriod('YEAR')}
              >
                Yearly
              </button>
            </div>
            {highestSaving > 0 ? <span>Save up to {highestSaving}%</span> : null}
          </div>
        </div>

        <div className={styles.planGrid}>
          {data.plans.map((plan) => {
            const monthly = plan.prices.find((price) => price.interval === 'MONTH');
            const yearly = plan.prices.find((price) => price.interval === 'YEAR');
            const selectedPrice = period === 'MONTH' ? monthly : yearly;
            const free = plan.prices.length === 0 && !plan.entitlements.operatesDownstream;
            const custom = plan.prices.length === 0 && plan.entitlements.operatesDownstream;
            const popular = plan.id === 'pro';
            const savings = savingPercent(plan);

            return (
              <article
                key={plan.id}
                className={`${styles.planCard} ${popular ? styles.popularCard : ''}`}
              >
                <div className={styles.planTopline}>
                  <h3>{plan.name}</h3>
                  {popular ? <span className={styles.popularBadge}>Most popular</span> : null}
                </div>
                <p className={styles.planDescription}>{plan.description}</p>

                <div className={styles.priceBlock}>
                  {free ? (
                    <>
                      <strong>Free</strong>
                      <span>forever</span>
                    </>
                  ) : custom ? (
                    <>
                      <strong>Custom</strong>
                      <span>built around your operation</span>
                    </>
                  ) : selectedPrice ? (
                    <>
                      <strong>
                        {period === 'YEAR'
                          ? formatAmount(selectedPrice.amountCents / 12, 2)
                          : formatAmount(selectedPrice.amountCents)}
                      </strong>
                      <span>per company / month</span>
                    </>
                  ) : null}
                </div>

                {period === 'YEAR' && yearly ? (
                  <p className={styles.priceNote}>
                    Billed {formatAmount(yearly.amountCents)} yearly
                    {savings && savings > 0 ? ` · Save ${savings}%` : ''}
                  </p>
                ) : (
                  <p className={styles.priceNote}>
                    {free ? 'No card required' : custom ? 'Flexible limits and support' : 'Billed monthly'}
                  </p>
                )}

                <Link
                  className={`${styles.planAction} ${popular ? styles.planActionPrimary : ''}`}
                  href="/register"
                >
                  {custom ? 'Create an account' : free ? 'Start free' : `Start ${plan.trialDays}-day trial`}
                </Link>

                <div className={styles.planDivider} />
                <p className={styles.includesLabel}>{free ? 'Includes' : 'Everything you need for'}</p>
                <ul className={styles.highlightList}>
                  {planHighlights(plan).map((highlight) => (
                    <li key={highlight}><span aria-hidden="true">✓</span>{highlight}</li>
                  ))}
                </ul>
              </article>
            );
          })}
        </div>
      </section>

      <section className={styles.compareSection} id="compare" aria-labelledby="compare-title">
        <div className={styles.sectionHeading}>
          <p className={styles.eyebrow}>Full comparison</p>
          <h2 id="compare-title">See exactly what each plan includes.</h2>
          <p>Plan allowances update here directly from the CrewQuo catalog.</p>
        </div>

        <div className={styles.comparisonBlock}>
          <h3>Allowances</h3>
          <div className={styles.tableScroll}>
            <table className={styles.compare}>
              <caption className={styles.srOnly}>Included allowances by plan</caption>
              <thead>
                <tr>
                  <th scope="col">Allowance</th>
                  {data.plans.map((plan) => <th key={plan.id} scope="col">{plan.name}</th>)}
                </tr>
              </thead>
              <tbody>
                {LIMIT_KEYS.map((key) => (
                  <tr key={key}>
                    <th scope="row">{LIMIT_LABELS[key]}</th>
                    {data.plans.map((plan) => {
                      const value = formatLimit(plan, key);
                      return (
                        <td key={plan.id}>
                          {value === 'Not included' ? (
                            <span className={styles.notIncluded} role="img" aria-label="Not included">—</span>
                          ) : value}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className={styles.comparisonBlock}>
          <h3>Features</h3>
          <div className={styles.tableScroll}>
            <table className={styles.compare}>
              <caption className={styles.srOnly}>Included features by plan</caption>
              <thead>
                <tr>
                  <th scope="col">Feature</th>
                  {data.plans.map((plan) => <th key={plan.id} scope="col">{plan.name}</th>)}
                </tr>
              </thead>
              <tbody>
                {FEATURE_KEYS.map((key) => (
                  <tr key={key}>
                    <th scope="row">{FEATURE_LABELS[key]}</th>
                    {data.plans.map((plan) => {
                      const included = plan.entitlements.features.includes(key);
                      return (
                        <td key={plan.id}>
                          <span
                            className={included ? styles.included : styles.notIncluded}
                            role="img"
                            aria-label={included ? 'Included' : 'Not included'}
                          >
                            {included ? '✓' : '—'}
                          </span>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>
    </>
  );
}
