'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, type ReactNode } from 'react';
import { Select } from '@crewquo/ui';
import { useAuth } from '@/auth/AuthProvider';

const NAV = [
  { href: '/', label: 'Overview' },
  { href: '/rates/roles', label: 'Roles' },
  { href: '/rates/cards', label: 'Rate cards' },
  { href: '/rates/templates', label: 'Templates' },
  { href: '/rates/resolve', label: 'Resolve' },
];

/**
 * Authenticated app frame: top bar (brand, nav, company switcher, sign-out) with
 * a client-side guard that bounces signed-out visitors to /login.
 */
export function Shell({ children }: { children: ReactNode }) {
  const { ready, session, companyId, activeMembership, setCompanyId, logout } = useAuth();
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (ready && !session) router.replace('/login');
  }, [ready, session, router]);

  if (!ready) return <CenteredMessage>Loading…</CenteredMessage>;
  if (!session) return <CenteredMessage>Redirecting to sign in…</CenteredMessage>;

  return (
    <div>
      <header
        style={{
          borderBottom: '1px solid var(--cq-border)',
          background: 'var(--cq-surface)',
        }}
      >
        <div
          className="cq-container cq-row cq-row--between"
          style={{ paddingTop: 14, paddingBottom: 14, flexWrap: 'wrap', gap: 12 }}
        >
          <div className="cq-row" style={{ gap: 20, flexWrap: 'wrap' }}>
            <strong style={{ fontSize: 16 }}>CrewQuo</strong>
            <nav className="cq-row" style={{ gap: 4, flexWrap: 'wrap' }}>
              {NAV.map((item) => {
                const active =
                  item.href === '/' ? pathname === '/' : pathname.startsWith(item.href);
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    style={{
                      padding: '6px 10px',
                      borderRadius: 7,
                      fontSize: 14,
                      fontWeight: 600,
                      color: active ? 'var(--cq-accent)' : 'var(--cq-text-muted)',
                      background: active ? 'rgba(37,99,235,0.1)' : 'transparent',
                      textDecoration: 'none',
                    }}
                  >
                    {item.label}
                  </Link>
                );
              })}
            </nav>
          </div>

          <div className="cq-row" style={{ gap: 10 }}>
            <Select
              value={companyId ?? ''}
              onChange={(e) => setCompanyId(e.target.value)}
              style={{ width: 'auto', minWidth: 180 }}
              aria-label="Active company"
            >
              {session.memberships.map((m) => (
                <option key={m.companyId} value={m.companyId}>
                  {m.companyName} · {m.role}
                </option>
              ))}
            </Select>
            <button
              className="cq-btn cq-btn--secondary cq-btn--sm"
              onClick={() => {
                void logout();
              }}
            >
              Sign out
            </button>
          </div>
        </div>
      </header>

      <main className="cq-container">
        {activeMembership ? (
          children
        ) : (
          <p className="cq-muted" style={{ marginTop: 24 }}>
            Select a company to continue.
          </p>
        )}
      </main>
    </div>
  );
}

function CenteredMessage({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        minHeight: '60vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: 'var(--cq-text-muted)',
      }}
    >
      {children}
    </div>
  );
}
