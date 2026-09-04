import Link from 'next/link';
import styles from './site-chrome.module.css';

/**
 * The public footer.
 *
 * It carries the two things the old landing footer did not: a way to reach
 * somebody, and a way to create an account.
 */
export function SiteFooter() {
  return (
    <footer className={styles.footer}>
      <div className={styles.footerInner}>
        <div className={styles.footerTop}>
          <div>
            <Link className={styles.brand} href="/" translate="no">
              <span className={styles.brandMark} aria-hidden="true">CQ</span>
              <span>CrewQuo</span>
            </Link>
            <p className={styles.footerBlurb}>
              Contractor operations software. Commercial control, crews and subcontractors, field
              evidence, assets and destinations, sustainability accounting and client reporting —
              one project, one operational record.
            </p>
          </div>

          <nav className={styles.footerNav} aria-label="Footer navigation">
            <div className={styles.footerGroup}>
              <h2>Product</h2>
              <Link href="/pricing">Pricing</Link>
              <Link href="/#platform">Platform</Link>
              <Link href="/#reporting">Reporting</Link>
            </div>
            <div className={styles.footerGroup}>
              <h2>Legal</h2>
              <Link href="/terms">Terms</Link>
              <Link href="/privacy">Privacy</Link>
            </div>
            <div className={styles.footerGroup}>
              <h2>Account</h2>
              <Link href="/login">Sign in</Link>
              <Link href="/register">Start free</Link>
            </div>
          </nav>
        </div>

        <div className={styles.footerBottom}>
          <p>© 2026 CrewQuo</p>
          <p>Built for contractor operations.</p>
        </div>
      </div>
    </footer>
  );
}
