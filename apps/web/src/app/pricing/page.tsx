import type { Metadata } from 'next';
import Link from 'next/link';
import { PublicPageLayout } from '@/components/PublicPageLayout';
import styles from '@/app/legal.module.css';
import { PricingPlans } from './PricingPlans';

export const metadata: Metadata = {
  title: 'Pricing',
  description: 'CrewQuo plans, allowances and what each one includes. Charged in USD.',
};

/**
 * The public pricing page (plan §19.5).
 *
 * Three rules it is written to, each of which was a way to get this page wrong:
 *
 *  - **The numbers come from the live catalog**, never from this file. A price
 *    typed into marketing copy is a price that disagrees with the checkout the
 *    first time somebody changes it in the platform console.
 *  - **One currency, so no currency machinery.** Payments are USD only (owner
 *    decision, 2026-08-20), which means no switcher, no "prices shown in your
 *    region" and no implied local total. Paddle is the merchant of record and
 *    determines tax at checkout, so the page says that rather than quoting a
 *    tax-inclusive figure it cannot compute.
 *  - **It does not claim to be able to take money yet.** Whether checkout is
 *    switched on is a platform setting, and a public page that reports it would
 *    be publishing platform configuration. So the page commits to the one thing
 *    that is unconditionally true — an account starts free — and sends everybody
 *    to registration rather than to a buy button that may refuse.
 */
export default function PricingPage() {
  return (
    <PublicPageLayout
      current="pricing"
      eyebrow="Plans · Preview"
      title="Pricing"
      summary="Every workspace starts free. Paid plans add subcontracting, the client portal, invoicing and longer audit history — charged in US dollars, on a monthly or yearly period."
      updated="31 August 2026"
    >
      <aside className={styles.status} aria-label="Pre-launch pricing status">
        <strong>These plans are published; paid subscriptions are still being finalised.</strong>
        <p>
          Prices shown here come from the live plan catalog and are the amounts a subscription will
          be charged. CrewQuo is in preview, so plans and allowances may still change before paid
          public availability, and no figure on this page is a binding quotation. Creating an
          account is free and always starts on the free plan.
        </p>
      </aside>

      <div className={styles.content}>
        <section className={styles.section} id="plans">
          <h2>Plans</h2>
          <PricingPlans />
        </section>

        <section className={styles.section} id="how-billing-works">
          <h2>How billing works</h2>
          <ul>
            <li>
              <strong>One currency.</strong> Subscriptions are charged in US dollars. There is no
              regional pricing, so the amount above is the amount charged wherever you are.
            </li>
            <li>
              <strong>Paddle is the merchant of record.</strong> Paddle handles the payment and
              determines and remits any sales tax or VAT, which is calculated at checkout and shown
              before you pay. It is not included in the figures above.
            </li>
            <li>
              <strong>Per company, not per user.</strong> A plan applies to one company workspace.
              Being a member of somebody else&rsquo;s company costs you nothing and needs no plan of
              your own — that is what the free plan is for.
            </li>
            <li>
              <strong>Only an owner can subscribe.</strong> Starting, changing or cancelling a
              subscription is an owner action, taken from Plan &amp; usage inside the workspace.
            </li>
            <li>
              <strong>Cancelling stops the renewal, not the period.</strong> A cancelled plan runs to
              the end of the period already paid for and then stops. Nothing is deleted by
              cancelling; closing a company is a separate, deliberate step.
            </li>
            <li>
              <strong>Exporting your data is free on every plan</strong>, including the free one. So
              is closing your account.
            </li>
          </ul>
        </section>

        <section className={styles.section} id="creating-companies">
          <h2>More than one company</h2>
          <p>
            Each account includes one company it can create on its own. A second, genuinely separate
            legal business is requested rather than created: it is billed separately, shares no data
            with the first, and is reviewed or paid for before it exists. This is deliberate — the
            limit is on bringing new tenants into existence, not on how many companies you can be a
            member of, which is unlimited.
          </p>
        </section>

        <section className={styles.section} id="next">
          <h2>Getting started</h2>
          <p>
            <Link href="/register">Create your account</Link> to start on the free plan, or{' '}
            <Link href="/login">sign in</Link> if you already have one. Plans are chosen from
            Plan &amp; usage once your workspace exists, so nothing needs paying for to look around.
          </p>
          <p>
            The <Link href="/terms">terms of use</Link> and the{' '}
            <Link href="/privacy">privacy notice</Link> explain what the preview does and does not
            commit to.
          </p>
        </section>
      </div>
    </PublicPageLayout>
  );
}
