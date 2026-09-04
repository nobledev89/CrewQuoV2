'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import styles from './site-chrome.module.css';

export interface SiteNavLink {
  /** Route or in-page anchor. Anchors only appear on the page that owns them. */
  href: string;
  label: string;
}

interface SiteHeaderProps {
  links: readonly SiteNavLink[];
  /** `href` of the link describing the page being viewed, if one of them does. */
  current?: string;
}

/**
 * The public header, for the landing page and every other signed-out page.
 *
 * The menu exists because the previous header simply set `display: none` on the
 * whole nav below 820px with nothing to replace it — so on the device this
 * product is pitched at, the header kept a logo and nothing else, and Pricing
 * and all four section anchors were unreachable.
 *
 * There is exactly one `<nav>` in this header in every state. A second, hidden
 * "mobile copy" of the same links would give the page two elements with the same
 * accessible name, which is a duplicate for a screen reader walking landmarks
 * and an ambiguity for anything querying by role.
 */
export function SiteHeader({ links, current }: SiteHeaderProps) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();

  // A route change closes the menu. An in-page anchor does not change the
  // pathname, so those are closed by the links' own handler instead.
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const close = () => {
    setOpen(false);
  };

  return (
    <header className={`${styles.header} ${styles.sticky}`}>
      <div className={styles.navInner}>
        <Link className={styles.brand} href="/" translate="no" onClick={close}>
          <span className={styles.brandMark} aria-hidden="true">CQ</span>
          <span>CrewQuo</span>
        </Link>

        <button
          className={styles.menuButton}
          type="button"
          aria-expanded={open}
          aria-controls="site-nav"
          onClick={() => {
            setOpen((wasOpen) => !wasOpen);
          }}
        >
          <span className={styles.menuIcon} aria-hidden="true" data-open={open ? '' : undefined} />
          {open ? 'Close' : 'Menu'}
        </button>

        <div className={styles.navGroup} id="site-nav" data-open={open ? '' : undefined}>
          <nav className={styles.navLinks} aria-label="Public site navigation">
            {links.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                aria-current={link.href === current ? 'page' : undefined}
                onClick={close}
              >
                {link.label}
              </Link>
            ))}
          </nav>
          <div className={styles.navActions}>
            <Link className={styles.signIn} href="/login" onClick={close}>Sign in</Link>
            <Link className={styles.navCta} href="/register" onClick={close}>Start free</Link>
          </div>
        </div>
      </div>
    </header>
  );
}
