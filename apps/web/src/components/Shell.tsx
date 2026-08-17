'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, type ReactNode } from 'react';
import { Button, Select } from '@crewquo/ui';
import { useAuth } from '@/auth/AuthProvider';

const NAV = [
  {
    label: 'Workspace',
    items: [{ href: '/', label: 'Overview', icon: 'overview' }],
  },
  {
    label: 'Rate management',
    items: [
      { href: '/rates/roles', label: 'Roles', icon: 'people' },
      { href: '/rates/cards', label: 'Rate cards', icon: 'card' },
      { href: '/rates/templates', label: 'Templates', icon: 'template' },
      { href: '/rates/resolve', label: 'Rate resolver', icon: 'resolve' },
    ],
  },
];

const PAGE_NAMES: Record<string, string> = {
  '/': 'Overview',
  '/rates/roles': 'Roles',
  '/rates/cards': 'Rate cards',
  '/rates/templates': 'Templates',
  '/rates/resolve': 'Rate resolver',
};

export function Shell({ children }: { children: ReactNode }) {
  const { ready, session, companyId, activeMembership, setCompanyId, logout } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const pageName = PAGE_NAMES[pathname] ?? 'Workspace';

  useEffect(() => {
    if (ready && !session) router.replace('/login');
  }, [ready, session, router]);

  useEffect(() => {
    document.title = `${pageName} · CrewQuo`;
  }, [pageName]);

  if (!ready) return <CenteredMessage>Loading workspace…</CenteredMessage>;
  if (!session) return <CenteredMessage>Redirecting to sign in…</CenteredMessage>;

  return (
    <>
      <a className="cq-skip-link" href="#main-content">Skip to content</a>
      <div className="cq-app-shell">
        <aside className="cq-sidebar" aria-label="Primary navigation">
          <Link className="cq-brand" href="/" translate="no">
            <span className="cq-brand__mark" aria-hidden="true">CQ</span>
            <span className="cq-brand__name">CrewQuo</span>
          </Link>

          <div className="cq-sidebar__body">
            <nav>
              {NAV.map((group) => (
                <div className="cq-nav-group" key={group.label}>
                  <div className="cq-nav-label">{group.label}</div>
                  {group.items.map((item) => {
                    const active = item.href === '/' ? pathname === '/' : pathname.startsWith(item.href);
                    return (
                      <Link className="cq-nav-link" key={item.href} href={item.href} aria-current={active ? 'page' : undefined} title={item.label}>
                        <NavIcon name={item.icon} />
                        <span className="cq-nav-link__label">{item.label}</span>
                      </Link>
                    );
                  })}
                </div>
              ))}
            </nav>
          </div>

          <div className="cq-sidebar__footer">
            <div className="cq-account">
              <span className="cq-account__avatar" aria-hidden="true">{initials(activeMembership?.companyName ?? 'CQ')}</span>
              <span className="cq-account__copy">
                <span className="cq-account__name">{activeMembership?.companyName ?? 'Workspace'}</span>
                <span className="cq-account__role">{activeMembership?.role.toLowerCase() ?? 'member'}</span>
              </span>
            </div>
          </div>
        </aside>

        <div className="cq-app">
          <header className="cq-topbar">
            <div className="cq-breadcrumbs" aria-label="Breadcrumb">
              <span>{activeMembership?.companyName ?? 'Workspace'}</span>
              <span className="cq-breadcrumbs__separator" aria-hidden="true">/</span>
              <span aria-current="page">{pageName}</span>
            </div>
            <div className="cq-row" style={{ gap: 8 }}>
              <Select className="cq-company-select" value={companyId ?? ''} onChange={(event) => setCompanyId(event.target.value)} aria-label="Active company">
                {session.memberships.map((membership) => (
                  <option key={membership.companyId} value={membership.companyId}>{membership.companyName} · {titleCase(membership.role)}</option>
                ))}
              </Select>
              <Button variant="secondary" size="sm" onClick={() => void logout()}>Sign out</Button>
            </div>
          </header>

          <main className="cq-main" id="main-content" tabIndex={-1}>
            <div className="cq-container">
              {activeMembership ? children : <p className="cq-muted">Select a company to continue.</p>}
            </div>
          </main>
        </div>
      </div>
    </>
  );
}

function CenteredMessage({ children }: { children: ReactNode }) {
  return <div className="cq-centered-message" role="status">{children}</div>;
}

function initials(value: string): string {
  return value.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join('').toUpperCase();
}

function titleCase(value: string): string {
  return value.toLowerCase().replace(/(^|_)(\w)/g, (_, separator: string, letter: string) => `${separator ? ' ' : ''}${letter.toUpperCase()}`);
}

function NavIcon({ name }: { name: string }) {
  const common = { className: 'cq-nav-link__icon', viewBox: '0 0 20 20', fill: 'none', 'aria-hidden': true } as const;
  if (name === 'overview') return <svg {...common}><path d="M3.5 4.5h5v5h-5zm8 0h5v3h-5zm0 6h5v5h-5zm-8 2h5v3h-5z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/></svg>;
  if (name === 'people') return <svg {...common}><circle cx="8" cy="7" r="2.5" stroke="currentColor" strokeWidth="1.5"/><path d="M3.8 15.5c.35-2.6 1.75-4 4.2-4s3.85 1.4 4.2 4M12.5 5.2a2.4 2.4 0 0 1 0 4.6M14 11.6c1.4.5 2.2 1.8 2.4 3.9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>;
  if (name === 'card') return <svg {...common}><rect x="3" y="4.5" width="14" height="11" rx="1.5" stroke="currentColor" strokeWidth="1.5"/><path d="M3 8h14M6 12h3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>;
  if (name === 'template') return <svg {...common}><path d="M5 3.5h7l3 3v10H5z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/><path d="M12 3.5v3h3M8 10h4M8 13h4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>;
  return <svg {...common}><path d="M4 6h12M4 14h12M7 3v6M13 11v6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/><circle cx="7" cy="6" r="1.5" fill="currentColor"/><circle cx="13" cy="14" r="1.5" fill="currentColor"/></svg>;
}
