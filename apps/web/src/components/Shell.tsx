'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { DEFAULT_CURRENCY, type FeatureKey } from '@crewquo/shared';
import { Button, ErrorText, Field, Input, Select } from '@crewquo/ui';
import { useAuth } from '@/auth/AuthProvider';
import { ApiError } from '@/api/client';
import { useEntitlements } from '@/lib/useEntitlements';
import { titleCase } from '@/lib/format';

interface NavItem {
  href: string;
  label: string;
  icon: string;
  /** Platform-staff only (§5B super-admin console). */
  superAdmin?: boolean;
  /**
   * Hide unless the company's plan grants this feature. A link to a screen the plan
   * refuses is not a discovery affordance — it is a promise the API breaks (§5B).
   * `/plan` is where what-you-don't-have is on show; the sidebar is for work.
   */
  feature?: FeatureKey;
  /** Hide unless the plan allows this company to engage subcontractors. */
  requiresDownstream?: boolean;
}

const NAV: { label: string; items: NavItem[] }[] = [
  {
    label: 'Workspace',
    items: [
      { href: '/app', label: 'Overview', icon: 'overview' },
      { href: '/projects', label: 'Projects', icon: 'template' },
      { href: '/work', label: 'Log work', icon: 'clock' },
      { href: '/review', label: 'Approvals', icon: 'check', requiresDownstream: true },
      { href: '/invoices', label: 'Invoices', icon: 'card', feature: 'invoicing' },
      { href: '/portal', label: 'Shared with me', icon: 'portal' },
    ],
  },
  {
    label: 'Network',
    items: [
      { href: '/network/engagements', label: 'Engagements', icon: 'link' },
      {
        href: '/network/providers',
        label: 'Subcontractors',
        icon: 'people',
        requiresDownstream: true,
      },
      { href: '/network/clients', label: 'Clients', icon: 'building', feature: 'client_portal' },
    ],
  },
  {
    label: 'Rates',
    items: [
      /**
       * Deliberately ungated. Every other item here needs `rate_cards`, but a
       * provider on the free Crew plan proposes its own PAY schedule — that is what
       * the free tier is for (§5B), and the gate sits on the hiring company at
       * approval time instead. Hiding this would hide the negotiation from exactly
       * the people who start it.
       */
      { href: '/commercial', label: 'Agreements', icon: 'link' },
      { href: '/rates/roles', label: 'Roles', icon: 'people', feature: 'rate_cards' },
      { href: '/rates/cards', label: 'Rate cards', icon: 'card', feature: 'rate_cards' },
      { href: '/rates/templates', label: 'Templates', icon: 'template', feature: 'rate_cards' },
      { href: '/rates/resolve', label: 'Rate resolver', icon: 'resolve', feature: 'rate_cards' },
    ],
  },
  {
    label: 'Company',
    items: [
      { href: '/company/members', label: 'Members', icon: 'people' },
      { href: '/audit', label: 'Audit trail', icon: 'list', feature: 'audit_visibility' },
      { href: '/plan', label: 'Plan & usage', icon: 'gauge' },
      { href: '/settings', label: 'Settings', icon: 'settings' },
    ],
  },
  {
    label: 'Platform',
    items: [
      { href: '/admin/companies', label: 'Companies', icon: 'building', superAdmin: true },
      { href: '/admin/plans', label: 'Plans', icon: 'gauge', superAdmin: true },
    ],
  },
];

const PAGE_NAMES: Record<string, string> = {
  '/app': 'Overview',
  '/projects': 'Projects',
  '/invoices': 'Invoices',
  '/review': 'Approvals',
  '/work': 'Log work',
  '/network/engagements': 'Engagements',
  '/network/providers': 'Subcontractors',
  '/network/clients': 'Clients',
  '/portal': 'Shared with me',
  '/commercial': 'Commercial agreements',
  '/rates/roles': 'Roles',
  '/rates/cards': 'Rate cards',
  '/rates/templates': 'Templates',
  '/rates/resolve': 'Rate resolver',
  '/company/members': 'Members',
  '/audit': 'Audit trail',
  '/plan': 'Plan & usage',
  '/settings': 'Settings',
  '/profile': 'Profile',
  '/admin/plans': 'Plans',
  '/admin/companies': 'Companies',
};

/** The longest registered prefix wins, so `/projects/<id>` reads as "Projects". */
function pageNameFor(pathname: string): string {
  const exact = PAGE_NAMES[pathname];
  if (exact) return exact;
  const match = Object.keys(PAGE_NAMES)
    .filter((href) => href !== '/app' && pathname.startsWith(`${href}/`))
    .sort((a, b) => b.length - a.length)[0];
  return (match ? PAGE_NAMES[match] : undefined) ?? 'Workspace';
}

export function Shell({ children }: { children: ReactNode }) {
  const { ready, session, companyId, activeMembership, setCompanyId, logout } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const pageName = pageNameFor(pathname);
  // The sidebar is entitlement-aware (§5B): the plan decides what work exists, so it
  // decides what the navigation offers. This is the same resolver every gate reads, so
  // the menu and the API cannot disagree about what this company may do.
  const { data: entitlements } = useEntitlements();

  useEffect(() => {
    if (ready && !session) router.replace('/login');
  }, [ready, session, router]);

  useEffect(() => {
    document.title = `${pageName} · CrewQuo`;
  }, [pageName]);

  if (!ready) return <CenteredMessage>Loading workspace…</CenteredMessage>;
  if (!session) return <CenteredMessage>Redirecting to sign in…</CenteredMessage>;

  const isSuperAdmin = session.user.isSuperAdmin;
  /**
   * The platform console is the one area that needs no company context — it sends no
   * `X-Company-Id` and operates *on* companies rather than from inside one. Platform
   * staff usually own no company at all, so gating it behind "select a company" would
   * make support unreachable by exactly the people it belongs to. Every other screen
   * still requires a membership, because every other screen reads company-scoped data.
   */
  const platformScreen = isSuperAdmin && pathname.startsWith('/admin');

  /**
   * Staff with no company get the platform group alone. Showing them the workspace
   * navigation offers fifteen links that every one of them lands on "create a company",
   * and buries the two that work below the fold.
   */
  const companyless = !activeMembership;
  const groups = NAV.map((group) => ({
    ...group,
    items: group.items.filter((item) => {
      if (item.superAdmin) return isSuperAdmin;
      if (companyless) return false;
      // Until entitlements resolve, show the full set rather than flashing a short nav
      // that grows a moment later — a menu that moves under the cursor is worse than a
      // menu that briefly offers one refusal.
      if (!entitlements) return true;
      if (item.requiresDownstream && !entitlements.operatesDownstream) return false;
      if (item.feature && !entitlements.features.includes(item.feature)) return false;
      return true;
    }),
  })).filter((group) => group.items.length > 0);

  return (
    <>
      <a className="cq-skip-link" href="#main-content">
        Skip to content
      </a>
      <div className="cq-app-shell">
        <aside className="cq-sidebar" aria-label="Primary navigation">
          <Link className="cq-brand" href="/app" translate="no">
            <span className="cq-brand__mark" aria-hidden="true">
              CQ
            </span>
            <span className="cq-brand__name">CrewQuo</span>
          </Link>

          <div className="cq-sidebar__body">
            <nav>
              {groups.map((group) => (
                <div className="cq-nav-group" key={group.label}>
                  <div className="cq-nav-label">{group.label}</div>
                  {group.items.map((item) => {
                    const active =
                      pathname === item.href ||
                      (item.href !== '/app' && pathname.startsWith(`${item.href}/`));
                    return (
                      <Link
                        className="cq-nav-link"
                        key={item.href}
                        href={item.href}
                        aria-current={active ? 'page' : undefined}
                        title={item.label}
                      >
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
            <Link className="cq-account" href="/profile">
              <span className="cq-account__avatar" aria-hidden="true">
                {initials(session.user.name || activeMembership?.companyName || 'CQ')}
              </span>
              <span className="cq-account__copy">
                <span className="cq-account__name">{session.user.name}</span>
                <span className="cq-account__role">
                  {activeMembership ? titleCase(activeMembership.role) : 'No company'}
                </span>
              </span>
            </Link>
          </div>
        </aside>

        <div className="cq-app">
          <header className="cq-topbar">
            <div className="cq-breadcrumbs" aria-label="Breadcrumb">
              <span>{activeMembership?.companyName ?? 'Workspace'}</span>
              <span className="cq-breadcrumbs__separator" aria-hidden="true">
                /
              </span>
              <span aria-current="page">{pageName}</span>
            </div>
            <div className="cq-row" style={{ gap: 8 }}>
              {session.memberships.length > 0 ? (
                <Select
                  className="cq-company-select"
                  value={companyId ?? ''}
                  onChange={(event) => setCompanyId(event.target.value)}
                  aria-label="Active company"
                >
                  {session.memberships.map((membership) => (
                    <option key={membership.companyId} value={membership.companyId}>
                      {membership.companyName} · {titleCase(membership.role)}
                    </option>
                  ))}
                </Select>
              ) : null}
              <Button variant="secondary" size="sm" onClick={() => void logout()}>
                Sign out
              </Button>
            </div>
          </header>

          <main className="cq-main" id="main-content" tabIndex={-1}>
            <div className="cq-container">
              {activeMembership || platformScreen ? children : <NoCompany />}
            </div>
          </main>
        </div>
      </div>
    </>
  );
}

/**
 * A signed-in user with no membership. Registration allows skipping the company
 * name, and accepting nothing leaves you here — so this is a real state, not an
 * error, and it needs the one action that resolves it rather than "select a company
 * to continue" with no company to select.
 */
function NoCompany() {
  const { session, createCompany } = useAuth();
  const [name, setName] = useState('');
  const [currency, setCurrency] = useState(DEFAULT_CURRENCY);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const hasMemberships = (session?.memberships.length ?? 0) > 0;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await createCompany(name.trim(), currency.toUpperCase());
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create the company');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="cq-stack">
      <header className="cq-page-header">
        <div className="cq-page-header__copy">
          <h1 className="cq-h1">
            {hasMemberships ? 'Select a company' : 'Create your company'}
          </h1>
          <p className="cq-page-header__description">
            {hasMemberships
              ? 'Pick a company from the switcher above to continue.'
              : 'Your account is not attached to a company yet. Create one to start, or accept an invitation if you were sent one.'}
          </p>
        </div>
      </header>
      {hasMemberships ? null : (
        <section className="cq-section">
          <div className="cq-section__body">
            <form onSubmit={submit} className="cq-stack" aria-busy={busy}>
              <div className="cq-form-grid">
                <Field label="Company name">
                  <Input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    required
                    autoFocus
                  />
                </Field>
                <Field label="Currency (ISO 4217)" hint="Rate cards inherit this. Changeable later.">
                  <Input
                    value={currency}
                    onChange={(e) => setCurrency(e.target.value.toUpperCase().slice(0, 3))}
                    maxLength={3}
                    required
                  />
                </Field>
              </div>
              <ErrorText>{error}</ErrorText>
              <div>
                <Button type="submit" disabled={busy || !name.trim()}>
                  {busy ? 'Creating…' : 'Create company'}
                </Button>
              </div>
            </form>
          </div>
        </section>
      )}
    </div>
  );
}

function CenteredMessage({ children }: { children: ReactNode }) {
  return (
    <div className="cq-centered-message" role="status">
      {children}
    </div>
  );
}

function initials(value: string): string {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join('')
    .toUpperCase();
}

function NavIcon({ name }: { name: string }) {
  const common = {
    className: 'cq-nav-link__icon',
    viewBox: '0 0 20 20',
    fill: 'none',
    'aria-hidden': true,
  } as const;
  if (name === 'overview')
    return (
      <svg {...common}>
        <path
          d="M3.5 4.5h5v5h-5zm8 0h5v3h-5zm0 6h5v5h-5zm-8 2h5v3h-5z"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinejoin="round"
        />
      </svg>
    );
  if (name === 'people')
    return (
      <svg {...common}>
        <circle cx="8" cy="7" r="2.5" stroke="currentColor" strokeWidth="1.5" />
        <path
          d="M3.8 15.5c.35-2.6 1.75-4 4.2-4s3.85 1.4 4.2 4M12.5 5.2a2.4 2.4 0 0 1 0 4.6M14 11.6c1.4.5 2.2 1.8 2.4 3.9"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
      </svg>
    );
  if (name === 'card')
    return (
      <svg {...common}>
        <rect x="3" y="4.5" width="14" height="11" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
        <path d="M3 8h14M6 12h3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    );
  if (name === 'template')
    return (
      <svg {...common}>
        <path d="M5 3.5h7l3 3v10H5z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
        <path d="M12 3.5v3h3M8 10h4M8 13h4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    );
  if (name === 'settings')
    return (
      <svg {...common}>
        <circle cx="10" cy="10" r="2.5" stroke="currentColor" strokeWidth="1.5" />
        <path
          d="M10 3v2m0 10v2m-4.95-9.95 1.4 1.4m5.1 5.1 1.4 1.4M3 10h2m10 0h2M5.05 14.95l1.4-1.4m5.1-5.1 1.4-1.4"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
      </svg>
    );
  if (name === 'check')
    return (
      <svg {...common}>
        <circle cx="10" cy="10" r="6.75" stroke="currentColor" strokeWidth="1.5" />
        <path d="m7 10.2 2.1 2.1L13.2 8.2" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  if (name === 'clock')
    return (
      <svg {...common}>
        <circle cx="10" cy="10" r="6.75" stroke="currentColor" strokeWidth="1.5" />
        <path d="M10 6.4V10l2.6 1.7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    );
  if (name === 'link')
    return (
      <svg {...common}>
        <path
          d="M8.2 11.8 11.8 8.2M7.4 9 5.8 10.6a2.6 2.6 0 0 0 3.6 3.6L11 12.6m1.6-1.6 1.6-1.6a2.6 2.6 0 0 0-3.6-3.6L9 7.4"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
      </svg>
    );
  if (name === 'building')
    return (
      <svg {...common}>
        <path d="M4.5 16.5v-11l6-2v13m0-8h5v8" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
        <path d="M7 8h1.2M7 11h1.2M12.8 11H14M12.8 13.5H14" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      </svg>
    );
  if (name === 'portal')
    return (
      <svg {...common}>
        <rect x="3" y="4" width="14" height="12" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
        <path d="M3 7.5h14M7 11h6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    );
  if (name === 'list')
    return (
      <svg {...common}>
        <path d="M7 6h9M7 10h9M7 14h9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        <circle cx="4.3" cy="6" r="1" fill="currentColor" />
        <circle cx="4.3" cy="10" r="1" fill="currentColor" />
        <circle cx="4.3" cy="14" r="1" fill="currentColor" />
      </svg>
    );
  if (name === 'gauge')
    return (
      <svg {...common}>
        <path d="M4 13.5a6.5 6.5 0 1 1 12 0" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        <path d="M10 13 12.8 9.4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
    );
  return (
    <svg {...common}>
      <path d="M4 6h12M4 14h12M7 3v6M13 11v6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <circle cx="7" cy="6" r="1.5" fill="currentColor" />
      <circle cx="13" cy="14" r="1.5" fill="currentColor" />
    </svg>
  );
}
