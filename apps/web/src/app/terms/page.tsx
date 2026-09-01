import type { Metadata } from 'next';
import Link from 'next/link';
import { PublicPageLayout } from '@/components/PublicPageLayout';
import styles from '@/app/legal.module.css';

export const metadata: Metadata = {
  title: 'Terms of use',
  description: 'Preview terms for accessing and evaluating CrewQuo.',
};

const sections = [
  ['status', 'Status of these terms'],
  ['accounts', 'Accounts and authority'],
  ['service', 'Using the service'],
  ['data', 'Customer data and privacy'],
  ['commercial', 'Commercial boundaries'],
  ['availability', 'Preview availability'],
  ['ending', 'Suspension and closure'],
  ['open', 'Terms still to be settled'],
] as const;

export default function TermsPage() {
  return (
    <PublicPageLayout
      current="terms"
      eyebrow="Legal · Preview"
      title="Terms of use"
      summary="The rules for evaluating the current CrewQuo preview, written to match what the product actually does today. Final subscription terms will replace these before paid public availability."
      updated="31 August 2026"
    >
      <aside className={styles.status} aria-label="Pre-launch legal status">
        <strong>These are preview rules, not final paid-service terms.</strong>
        <p>
          CrewQuo has no live checkout and is not yet offered as a production service. The repository
          does not identify the contracting legal entity, registered address, governing law, dispute
          forum, warranty allocation or liability cap. Those are owner and legal-review decisions and
          are deliberately left open instead of being fabricated in boilerplate.
        </p>
      </aside>

      <nav className={styles.toc} aria-label="Terms contents">
        <h2>On this page</h2>
        <ol>{sections.map(([id, label]) => <li key={id}><a href={`#${id}`}>{label}</a></li>)}</ol>
      </nav>

      <div className={styles.content}>
        <section className={styles.section} id="status">
          <h2>1. Status of these terms</h2>
          <p>These terms govern invited access to the local, pre-production CrewQuo preview. They explain the behavioural and data rules a preview user is expected to follow. They do not create a paid subscription, service-level commitment, production data-processing agreement, or promise that every feature shown on the public site is already available.</p>
          <p>Do not use the preview for irreplaceable production records, regulated special-category data, payment-card data, government identity documents, or any data you are not authorised to provide.</p>
        </section>

        <section className={styles.section} id="accounts">
          <h2>2. Accounts and authority</h2>
          <ul>
            <li>You must provide accurate account information and keep your credentials and recovery material secure.</li>
            <li>You are responsible for activity performed through your account unless you promptly report unauthorised access.</li>
            <li>If you create or act for a company, you confirm that you are authorised to bind or administer that company’s preview workspace.</li>
            <li>Membership of invited companies is unlimited, but automatically creating a new legal company is limited. A second business requires a separate, reviewed creation path.</li>
            <li>You may not share an individual account, bypass access controls, or use another person’s identity.</li>
          </ul>
        </section>

        <section className={styles.section} id="service">
          <h2>3. Using the service</h2>
          <p>You may use the preview to evaluate contractor operations workflows and for no unlawful, harmful or abusive purpose. You must not probe or defeat security controls; introduce malware; overload the service; scrape other users’ data; misrepresent evidence, rates, approvals or sustainability outcomes; or use CrewQuo to infringe privacy, confidentiality, employment, intellectual-property or other rights.</p>
          <p>You retain ownership of material you are entitled to upload or enter. You give CrewQuo the limited permission needed to host, process, display, export and transmit that material to the people and companies you authorise through the product.</p>
        </section>

        <section className={styles.section} id="data">
          <h2>4. Customer data and privacy</h2>
          <p>You are responsible for having a lawful basis and giving any required notices before entering information about workers, subcontractors, clients or other people. You must configure access and client visibility deliberately and respond to requests relating to data for which your company is responsible.</p>
          <p>CrewQuo applies the access, export, retention and closure behaviour described in the <Link href="/privacy">privacy notice</Link>. A personal closure anonymises the person while preserving shared commercial and work evidence where deleting it would alter another company’s legitimate record. A company must settle or hand over blocking relationships and records before its closure can complete.</p>
          <p>The preview database is local and has the durability of one development machine. You must keep your own source records and exports. Production backup and recovery commitments do not exist yet.</p>
        </section>

        <section className={styles.section} id="commercial">
          <h2>5. Commercial boundaries</h2>
          <p>PAY rates, BILL rates, margins, proposals, invoices and approvals are separate records with separate readers. You may only enter or approve commercial terms you are authorised to set. You must not use an invitation, project relationship or exported file to obtain or disclose a counterparty’s protected rate or margin.</p>
          <p>CrewQuo records calculations and workflow evidence; it does not provide accounting, tax, employment, legal, engineering, environmental verification or carbon-assurance advice. Tax remains manually entered in the current product, and sustainability claims must retain their methodology, factors, assumptions and source evidence.</p>
        </section>

        <section className={styles.section} id="availability">
          <h2>6. Preview availability</h2>
          <p>The preview may change, stop, lose data or be unavailable without notice. Scheduled jobs are currently run by hand, so notification delivery, retention passes and due closures do not have a production service-level guarantee. Features may be incomplete, deferred or removed as the unified product is built.</p>
          <p>Feedback may be used to improve CrewQuo without restriction, provided it does not contain confidential customer data. CrewQuo’s software, design, documentation and branding remain the property of their respective owner; no right is granted except the limited preview access described here.</p>
        </section>

        <section className={styles.section} id="ending">
          <h2>7. Suspension and closure</h2>
          <p>Access may be suspended to protect the service or another person, investigate misuse, comply with law, or respond to a material breach of these preview rules. Where practical, CrewQuo will explain the reason and the available recovery path.</p>
          <p>You can export personal data and request account closure from Profile. A company owner can export and request closure for a company. Closure uses a seven-day cooling-off period after notice and can be cancelled before execution. Some evidence is anonymised and retained rather than deleted for the reasons described in the privacy notice.</p>
        </section>

        <section className={styles.section} id="open">
          <h2>8. Terms still to be settled before launch</h2>
          <p className={styles.callout}>Paid or public production use must not rely on this page. The final agreement still needs the contracting entity and address, customer and support contacts, governing law and disputes, subscription prices and renewal, Paddle checkout and refunds, taxes, service and support commitments, data-processing terms, warranties, indemnities, liability limits, and a process for material term changes.</p>
          <p>When those facts are decided, the final terms will identify their effective date and replace these preview terms. They will not be treated as retroactively agreed merely because a person evaluated this preview.</p>
        </section>
      </div>
    </PublicPageLayout>
  );
}

