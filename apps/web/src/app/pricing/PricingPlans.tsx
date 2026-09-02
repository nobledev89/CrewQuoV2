'use client';

import { FEATURE_KEYS, LIMIT_KEYS, type FeatureKey, type LimitKey } from '@crewquo/shared';
import { api } from '@/api/client';
import { useAsyncData } from '@/lib/useAsyncData';
import styles from '@/app/legal.module.css';

/**
 * The public plan catalog, read from `GET /v1/public/pricing`.
 *
 * A client component inside a server page on purpose. The catalog is operator
 * data that changes in the platform console without a deploy, so rendering it at
 * build time would show whatever was true when the site was last built — and a
 * stale price is worse than a price that takes a moment to arrive.
 */

const LIMIT_LABELS: Record<LimitKey, string> = {
  active_subcontractors: 'Active subcontractors',
  internal_seats: 'Team seats',
  clients: 'Portal clients',
  audit_retention_days: 'Audit history (days)',
  storage_gb: 'File storage (GB)',
  evidence_uploads_per_month: 'Evidence uploads per month',
  factor_sets: 'Imported factor sets',
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
  invoicing: 'Invoicing',
  audit_visibility: 'Client-visible audit trail',
  api_access: 'API access',
  sso: 'Single sign-on',
  white_label: 'White label',
};

function formatAmount(amountCents: number): string {
  const dollars = amountCents / 100;
  return `$${dollars % 1 === 0 ? dollars.toFixed(0) : dollars.toFixed(2)}`;
}

export function PricingPlans() {
  const { data, loading, error } = useAsyncData(() => api.publicPricing(), []);

  if (loading) {
    return <p className={styles.updated}>Loading plans…</p>;
  }
  if (error || !data) {
    return (
      <p role="alert" className={styles.updated}>
        {error ?? 'Plans could not be loaded.'} You can still create an account — every workspace
        starts on the free plan.
      </p>
    );
  }
  if (data.plans.length === 0) {
    return (
      <p className={styles.updated}>
        No plans are published yet. Create an account to start on the free plan.
      </p>
    );
  }

  return (
    <>
      <div className={styles.planGrid}>
        {data.plans.map((plan) => {
          const monthly = plan.prices.find((price) => price.interval === 'MONTH');
          const yearly = plan.prices.find((price) => price.interval === 'YEAR');
          return (
            <article key={plan.id} className={styles.planCard}>
              <h3 className={styles.planName}>{plan.name}</h3>
              {/*
                A plan with no price is a *free* plan only when the catalog says so
                by having no price at all — which is exactly how the Crew plan is
                modelled. "Contact us" would be an invented sales motion.
              */}
              <p className={styles.planPrice}>
                {monthly ? (
                  <>
                    {formatAmount(monthly.amountCents)}
                    <span className={styles.planPeriod}> / month</span>
                  </>
                ) : (
                  <>
                    Free
                    <span className={styles.planPeriod}> to use</span>
                  </>
                )}
              </p>
              {yearly ? (
                <p className={styles.planAlt}>
                  or {formatAmount(yearly.amountCents)} / year
                </p>
              ) : null}
              {plan.description ? <p className={styles.planBody}>{plan.description}</p> : null}
              <p className={styles.planBody}>
                {plan.entitlements.operatesDownstream
                  ? 'Can hire and be hired.'
                  : 'Can be hired; cannot engage its own subcontractors.'}
              </p>
              {plan.trialDays > 0 ? (
                <p className={styles.planBody}>{plan.trialDays}-day trial.</p>
              ) : null}
            </article>
          );
        })}
      </div>

      <h3 id="allowances">What each plan allows</h3>
      <div className={styles.tableScroll}>
        <table className={styles.compare}>
          <caption className={styles.srOnly}>Included allowances by plan</caption>
          <thead>
            <tr>
              <th scope="col">Allowance</th>
              {data.plans.map((plan) => (
                <th key={plan.id} scope="col">{plan.name}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {LIMIT_KEYS.map((key) => (
              <tr key={key}>
                <th scope="row">{LIMIT_LABELS[key]}</th>
                {data.plans.map((plan) => {
                  const value = plan.entitlements.limits[key];
                  return (
                    <td key={plan.id}>
                      {/* `null` is unlimited and `0` is none — printing both as
                          "0" would invert the most expensive tier. */}
                      {value === null ? 'Unlimited' : value === 0 ? 'Not included' : value}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h3 id="features">What each plan includes</h3>
      <div className={styles.tableScroll}>
        <table className={styles.compare}>
          <caption className={styles.srOnly}>Included features by plan</caption>
          <thead>
            <tr>
              <th scope="col">Feature</th>
              {data.plans.map((plan) => (
                <th key={plan.id} scope="col">{plan.name}</th>
              ))}
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
                      {/* The word, not a tick: a screen reader announcing "✓" is
                          announcing a character, not an answer. */}
                      {included ? 'Included' : <span className={styles.absent}>Not included</span>}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
