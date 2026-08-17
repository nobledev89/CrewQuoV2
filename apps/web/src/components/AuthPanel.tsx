'use client';

import Link from 'next/link';
import { useEffect, type ReactNode } from 'react';

/**
 * The centred panel every unauthenticated page sits in. Extracted from the Phase 2
 * login page so sign-in, register, password recovery, verification and invite accept
 * share one piece of chrome rather than five copies of it.
 */
export function AuthPanel({
  eyebrow,
  title,
  description,
  documentTitle,
  children,
  footer,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  /** Browser tab title; defaults to `title`. */
  documentTitle?: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  useEffect(() => {
    document.title = `${documentTitle ?? title} · CrewQuo`;
  }, [documentTitle, title]);

  return (
    <div className="cq-auth">
      <header className="cq-auth__bar">
        <Link
          className="cq-brand"
          href="/"
          style={{ height: 'auto', padding: 0, border: 0 }}
          translate="no"
        >
          <span className="cq-brand__mark" aria-hidden="true">
            CQ
          </span>
          <span className="cq-brand__name">CrewQuo</span>
        </Link>
      </header>
      <main className="cq-auth__main">
        <div className="cq-auth__panel">
          <div className="cq-auth__heading">
            {eyebrow ? (
              <p className="cq-overline" style={{ margin: '0 0 8px' }}>
                {eyebrow}
              </p>
            ) : null}
            <h1 className="cq-h1">{title}</h1>
            {description ? <p className="cq-page-header__description">{description}</p> : null}
          </div>
          {children}
        </div>
      </main>
      <footer className="cq-auth__footer">
        {footer ?? 'Secure access to your CrewQuo workspace'}
      </footer>
    </div>
  );
}
