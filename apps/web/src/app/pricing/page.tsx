import type { Metadata } from 'next';
import Link from 'next/link';
import { SiteFooter } from '@/components/SiteFooter';
import { SiteHeader } from '@/components/SiteHeader';
import { PricingPlans } from './PricingPlans';
import styles from './pricing.module.css';

export const metadata: Metadata = {
  title: 'Pricing',
  description:
    'Simple CrewQuo pricing for subcontractors, growing contractors and multi-company operations.',
  alternates: { canonical: '/pricing' },
};

const PRICING_NAV = [
  { href: '/pricing', label: 'Pricing' },
  { href: '/terms', label: 'Terms' },
  { href: '/privacy', label: 'Privacy' },
] as const;

export default function PricingPage() {
  return (
    <div className={styles.site}>
      <a className={styles.skipLink} href="#main-content">
        Skip to content
      </a>
      <SiteHeader links={PRICING_NAV} current="/pricing" />

      <main id="main-content">
        <section className={styles.hero}>
          <div className={styles.heroGlow} aria-hidden="true" />
          <div className={styles.heroInner}>
            <p className={styles.eyebrow}>Simple, scalable pricing</p>
            <h1>Choose the control your operation needs.</h1>
            <p className={styles.heroLead}>
              Start free, then add the commercial, field and reporting tools your team needs as
              the work grows.
            </p>
            <div className={styles.heroProof} aria-label="Pricing highlights">
              <span>Free plan forever</span>
              <span>14-day paid-plan trial</span>
              <span>Export your data anytime</span>
            </div>
          </div>
        </section>

        <PricingPlans />

        <section className={styles.billingSection} aria-labelledby="billing-title">
          <div className={styles.sectionHeading}>
            <p className={styles.eyebrow}>Straightforward billing</p>
            <h2 id="billing-title">No surprises between the price and the work.</h2>
          </div>
          <div className={styles.billingGrid}>
            <article>
              <span className={styles.step}>01</span>
              <h3>One workspace, one plan</h3>
              <p>
                Pricing is per company—not per person. Join other companies without paying for
                another workspace.
              </p>
            </article>
            <article>
              <span className={styles.step}>02</span>
              <h3>Tax handled at checkout</h3>
              <p>
                Paddle is the merchant of record. Any applicable sales tax or VAT is calculated
                and shown before payment.
              </p>
            </article>
            <article>
              <span className={styles.step}>03</span>
              <h3>Stay in control</h3>
              <p>
                Owners can change or cancel a plan. Cancellation stops renewal at the end of the
                paid period; it does not delete company data.
              </p>
            </article>
          </div>
        </section>

        <section className={styles.faqSection} aria-labelledby="faq-title">
          <div className={styles.faqIntro}>
            <p className={styles.eyebrow}>Good to know</p>
            <h2 id="faq-title">A few quick answers.</h2>
            <p>Everything you need to choose a plan with confidence.</p>
          </div>
          <div className={styles.faqList}>
            <details>
              <summary>Can I start without a card?</summary>
              <p>Yes. The Crew plan is free forever and does not require payment details.</p>
            </details>
            <details>
              <summary>Can I move between plans?</summary>
              <p>Yes. A company owner can change the workspace plan as the team grows.</p>
            </details>
            <details>
              <summary>What currency will I be charged in?</summary>
              <p>Subscriptions are charged in US dollars. Applicable tax is shown at checkout.</p>
            </details>
            <details>
              <summary>Do I lose access to my data if I cancel?</summary>
              <p>
                No. Cancelling a subscription and closing a company are separate actions, and data
                export is available on every plan.
              </p>
            </details>
          </div>
        </section>

        <section className={styles.finalCta} aria-labelledby="final-cta-title">
          <p className={styles.eyebrow}>Ready when you are</p>
          <h2 id="final-cta-title">Run the job with one operational record.</h2>
          <p>Set up your workspace now. You can choose a paid plan when the need is real.</p>
          <div className={styles.finalActions}>
            <Link className={styles.primaryAction} href="/register">
              Create your account
            </Link>
            <Link className={styles.secondaryAction} href="/login">
              Sign in
            </Link>
          </div>
        </section>
      </main>

      <SiteFooter />
    </div>
  );
}
