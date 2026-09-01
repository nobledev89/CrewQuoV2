import Link from 'next/link';
import type { ReactNode } from 'react';
import styles from '@/app/legal.module.css';

interface PublicPageLayoutProps {
  current: 'pricing' | 'terms' | 'privacy';
  eyebrow: string;
  title: string;
  summary: string;
  updated: string;
  children: ReactNode;
}

/**
 * Shared chrome for every public page that is not the landing page. Kept outside
 * the authenticated route group, so nothing here may read a session.
 *
 * Named for what it is rather than for legal pages specifically: pricing joined
 * terms and privacy behind the same header, and a visitor comparing plans and
 * then reading the terms should not cross a visual seam doing it.
 */
export function PublicPageLayout({
  current,
  eyebrow,
  title,
  summary,
  updated,
  children,
}: PublicPageLayoutProps) {
  return (
    <div className={styles.site}>
      <a className={styles.skipLink} href="#main-content">
        Skip to content
      </a>
      <header className={styles.header}>
        <div className={styles.navInner}>
          <Link className={styles.brand} href="/" translate="no">
            <span className={styles.brandMark} aria-hidden="true">CQ</span>
            <span>CrewQuo</span>
          </Link>
          <nav className={styles.navLinks} aria-label="Public site navigation">
            <Link href="/pricing" aria-current={current === 'pricing' ? 'page' : undefined}>
              Pricing
            </Link>
            <Link href="/terms" aria-current={current === 'terms' ? 'page' : undefined}>
              Terms
            </Link>
            <Link href="/privacy" aria-current={current === 'privacy' ? 'page' : undefined}>
              Privacy
            </Link>
            <Link className={styles.workspaceLink} href="/login">
              Open workspace <span aria-hidden="true">↗</span>
            </Link>
          </nav>
        </div>
      </header>

      <main id="main-content" className={styles.main}>
        <header className={styles.hero}>
          <p className={styles.eyebrow}>{eyebrow}</p>
          <h1>{title}</h1>
          <p className={styles.summary}>{summary}</p>
          <p className={styles.updated}>Last updated {updated}</p>
        </header>
        {children}
      </main>

      <footer className={styles.footer}>
        <Link className={styles.brand} href="/" translate="no">
          <span className={styles.brandMark} aria-hidden="true">CQ</span>
          <span>CrewQuo</span>
        </Link>
        <nav aria-label="Footer navigation">
          <Link href="/pricing">Pricing</Link>
          <Link href="/terms">Terms</Link>
          <Link href="/privacy">Privacy</Link>
          <Link href="/login">Sign in</Link>
        </nav>
        <p>© 2026 CrewQuo</p>
      </footer>
    </div>
  );
}

