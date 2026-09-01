import type { Metadata } from 'next';
import Link from 'next/link';
import { PublicPageLayout } from '@/components/PublicPageLayout';
import styles from '@/app/legal.module.css';

export const metadata: Metadata = {
  title: 'Privacy notice',
  description: 'How the CrewQuo preview collects, uses, shares, retains and removes personal data.',
};

const sections = [
  ['scope', 'Scope and roles'],
  ['data', 'Data we handle'],
  ['purposes', 'Why we use it'],
  ['sharing', 'Where data goes'],
  ['retention', 'How long data stays'],
  ['choices', 'Your choices and rights'],
  ['security', 'Security and international use'],
  ['changes', 'Changes and contact'],
] as const;

export default function PrivacyPage() {
  return (
    <PublicPageLayout
      current="privacy"
      eyebrow="Legal · Preview"
      title="Privacy notice"
      summary="A plain-language account of the data CrewQuo needs to run contractor operations, the boundaries around that data, and what happens when a person or company leaves."
      updated="31 August 2026"
    >
      <aside className={styles.status} aria-label="Pre-launch legal status">
        <strong>This is a product-accurate pre-launch notice, not the final production notice.</strong>
        <p>
          CrewQuo is currently operated as a local preview. Before public launch this notice must name
          the operating legal entity, postal and privacy contacts, applicable lawful bases and regulator,
          production hosting locations, transfer safeguards, and the final subprocessor list. Those facts
          are not present in the product record and have not been invented here.
        </p>
      </aside>

      <nav className={styles.toc} aria-label="Privacy notice contents">
        <h2>On this page</h2>
        <ol>{sections.map(([id, label]) => <li key={id}><a href={`#${id}`}>{label}</a></li>)}</ol>
      </nav>

      <div className={styles.content}>
        <section className={styles.section} id="scope">
          <h2>1. Scope and roles</h2>
          <p>
            This notice covers the public CrewQuo site, account and security features, workspaces,
            notifications, exports, and account or company closure. CrewQuo does not sell personal data
            and the current public site uses no advertising or behavioural-analytics cookies.
          </p>
          <p>
            A customer company normally decides why its crew, subcontractor, project and client data is
            recorded. For that operational data, CrewQuo acts on the company’s instructions. CrewQuo
            separately decides how account identity, authentication, platform security, service health,
            support and future billing records are used. Production contracts will state these roles and
            their jurisdiction-specific terms explicitly.
          </p>
        </section>

        <section className={styles.section} id="data">
          <h2>2. Data we handle</h2>
          <ul>
            <li><strong>Identity and account:</strong> name, email address, verification state, memberships, company role and account preferences.</li>
            <li><strong>Security:</strong> password hashes, sign-in and lockout records, multi-factor settings, session and device labels, and refresh-token family metadata. CrewQuo never stores a plain-text password.</li>
            <li><strong>Company and commercial records:</strong> legal and trading identity, memberships, engagements, rates, proposals, invoices, purchase-order terms, projects and audit history.</li>
            <li><strong>Work records:</strong> assignments, time logs, expenses, approvals, notes and the identity of the person who made a decision.</li>
            <li><strong>Communications:</strong> invitations, in-product notifications, delivery preferences, recipient addresses and the delivery state of email or push messages.</li>
            <li><strong>Operational metadata:</strong> request, user, company and job identifiers; route template, response status, duration, error code and class. Logs exclude request bodies, populated paths, headers, names, email addresses and tokens by policy.</li>
          </ul>
          <p>Data may come from you, a company that invites or manages you, a direct commercial counterparty, or the service as it records an action or security event.</p>
        </section>

        <section className={styles.section} id="purposes">
          <h2>3. Why we use it</h2>
          <p>CrewQuo uses data to create and protect accounts; authorize access; run projects, commercial agreements and approvals; deliver requested notifications; produce customer exports; diagnose failures; prevent abuse; keep decision evidence; and meet legal or accounting duties that apply to the operator or a customer.</p>
          <p>The production notice must map each purpose to the lawful basis that applies in each launch jurisdiction. The intended bases are performance of a contract, legitimate interests in operating and securing the service, compliance with legal obligations, and consent only where an optional feature genuinely depends on it. CrewQuo does not currently use personal data for targeted advertising or automated decisions with legal or similarly significant effects.</p>
        </section>

        <section className={styles.section} id="sharing">
          <h2>4. Where data goes</h2>
          <p>Access inside CrewQuo follows company membership, direct company relationships, project assignment and capability checks. A provider cannot read a hiring company’s BILL rate or margin, and a client cannot read a provider’s PAY rate.</p>
          <p>The current preview keeps its database on the operator’s local machine. One deliberate exception is email: when configured, Resend receives the recipient address and message needed to deliver it. Google receives information involved in Google sign-in when that option is configured. Sentry receives only allowlisted error metadata if error tracking is enabled; it is currently an optional integration and request bodies, headers, messages, breadcrumbs and local variables are removed before transmission.</p>
          <p>Paddle is the selected merchant of record for a future paid service, but checkout is not live. Production hosting, support, storage and billing providers must be listed here before they receive customer data. CrewQuo may also disclose information when required by law, to protect people or the service, or as part of a business transfer subject to appropriate safeguards.</p>
        </section>

        <section className={styles.section} id="retention">
          <h2>5. How long data stays</h2>
          <ul>
            <li>Operational request, job and error metadata has a 30-day policy.</li>
            <li>Customer audit history follows the retention period included in that company’s plan.</li>
            <li>Authentication attempts, ended sessions and delivery job history are pruned on their documented security schedules.</li>
            <li>Platform audit evidence and the fact and outcome of a deletion request are permanent, because removing that record would make a completed deletion indistinguishable from data loss.</li>
            <li>Commercial and cross-company evidence may be retained after a person leaves where it is also another company’s financial, payroll, approval or project record. The person’s identity is anonymised instead of falsifying that shared record.</li>
          </ul>
          <p>Exports are generated for the authenticated requester and streamed directly; CrewQuo does not store a downloadable export bundle. A closure request has a seven-day cooling-off period after its notice is dispatched and can be cancelled before execution.</p>
        </section>

        <section className={styles.section} id="choices">
          <h2>6. Your choices and rights</h2>
          <p>Depending on where you live and the reason data is used, you may have rights to be informed, access data, correct it, receive a portable copy, restrict or object to processing, ask for deletion, withdraw consent, and complain to a data-protection authority. Some rights have exceptions, especially where a record also belongs to an employer, client, provider or legal counterparty.</p>
          <p>Inside CrewQuo, <strong>Profile</strong> provides a machine-readable personal export and account closure. Company owners can export and request closure for their own company. Profile and company settings provide correction paths, and Security provides session and account controls. The export and closure paths are free and are not plan features.</p>
          <p className={styles.callout}>A monitored privacy address and the most relevant supervisory authority must be added before launch. Until then this local preview is not offered as a public production service.</p>
        </section>

        <section className={styles.section} id="security">
          <h2>7. Security and international use</h2>
          <p>CrewQuo uses scoped authorization, short-lived access tokens, rotating refresh tokens, optional multi-factor authentication, rate limits, append-only decision evidence, scrubbed operational logging and durable delivery records. No internet service can promise absolute security.</p>
          <p>The production operator must document where data is hosted and any safeguards used when data crosses borders before production infrastructure is provisioned. The local preview does not make a claim about an undecided production transfer mechanism.</p>
        </section>

        <section className={styles.section} id="changes">
          <h2>8. Changes and contact</h2>
          <p>Material changes will be dated on this page and, where appropriate, announced in the product or by email before they take effect. This notice will be replaced—not silently relabelled—when the operating entity and production data flow are settled.</p>
          <p>For product access today, use the support route shown inside your CrewQuo workspace. You can also review the <Link href="/terms">preview terms</Link>.</p>
        </section>
      </div>
    </PublicPageLayout>
  );
}

