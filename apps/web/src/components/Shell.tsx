'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import {
  DEFAULT_CURRENCY,
  type FeatureKey,
  type WorkspaceView,
} from '@crewquo/shared';
import { Button, ErrorText, Field, Input, Select } from '@crewquo/ui';
import { useAuth } from '@/auth/AuthProvider';
import { ApiError } from '@/api/client';
import { useEntitlements } from '@/lib/useEntitlements';
import { titleCase } from '@/lib/format';
import { resolveLandingRoute } from '@crewquo/shared';
import { useWorkspace, WORKSPACE_VIEW_LABELS } from '@/workspaces/WorkspaceProvider';

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
  /**
   * Belongs to the *account*, not to a company — so it survives having no company.
   *
   * A person who registered without one, or who was removed from the only company
   * they were in, still has live sessions on real devices. "Everything is reversible
   * by the account holder without an operator" (`access.md` §12.12) has to hold for
   * them too, and a link the company filter hides makes it hold for nobody.
   */
  accountLevel?: boolean;
}

interface NavGroup {
  label: string;
  items: NavItem[];
}

/** Every destination stays in the sidebar; view switching alone lives in the top bar. */
const VIEW_NAV: Record<WorkspaceView, NavGroup[]> = {
  OPERATIONS: [
    {
      label: 'Workspace',
      items: [
        { href: '/app', label: 'Overview', icon: 'overview' },
        { href: '/notifications', label: 'Needs you', icon: 'check' },
        { href: '/projects', label: 'Projects', icon: 'template' },
        { href: '/review', label: 'Approvals', icon: 'check', requiresDownstream: true },
      ],
    },
    {
      label: 'Commercial',
      items: [
        { href: '/commercial', label: 'Agreements', icon: 'link' },
        { href: '/invoices', label: 'Invoices', icon: 'card', feature: 'invoicing' },
      ],
    },
    {
      label: 'Network',
      items: [
        { href: '/network/engagements', label: 'Engagements', icon: 'link' },
        { href: '/network/providers', label: 'Subcontractors', icon: 'people', requiresDownstream: true },
        { href: '/network/clients', label: 'Clients', icon: 'building', feature: 'client_portal' },
      ],
    },
    {
      label: 'Rates',
      items: [
        { href: '/rates/roles', label: 'Roles', icon: 'people', feature: 'rate_cards' },
        { href: '/rates/cards', label: 'Rate cards', icon: 'card', feature: 'rate_cards' },
        { href: '/rates/templates', label: 'Templates', icon: 'template', feature: 'rate_cards' },
        { href: '/rates/resolve', label: 'Rate resolver', icon: 'resolve', feature: 'rate_cards' },
      ],
    },
    {
      label: 'Reports',
      items: [{ href: '/audit', label: 'Audit trail', icon: 'list', feature: 'audit_visibility' }],
    },
    {
      label: 'Company',
      items: [
        { href: '/company/members', label: 'Members', icon: 'people' },
        { href: '/plan', label: 'Plan & usage', icon: 'gauge' },
        { href: '/settings', label: 'Settings', icon: 'settings' },
        { href: '/profile', label: 'Profile', icon: 'people' },
        { href: '/security', label: 'Security', icon: 'lock', accountLevel: true },
      ],
    },
  ],
  SUBCONTRACTOR: [
    {
      label: 'Work',
      items: [
        { href: '/notifications', label: 'Needs you', icon: 'check' },
        { href: '/work', label: 'My work', icon: 'clock' },
      ],
    },
    {
      label: 'Commercial',
      items: [
        { href: '/commercial', label: 'Rate agreements', icon: 'link' },
        { href: '/network/engagements', label: 'Engagements', icon: 'building' },
      ],
    },
    {
      label: 'Company',
      items: [
        { href: '/company/members', label: 'My team', icon: 'people' },
        { href: '/plan', label: 'Plan & usage', icon: 'gauge' },
        { href: '/settings', label: 'Settings', icon: 'settings' },
        { href: '/profile', label: 'Profile', icon: 'people' },
        { href: '/security', label: 'Security', icon: 'lock', accountLevel: true },
      ],
    },
  ],
  CLIENT: [
    {
      label: 'Workspace',
      items: [
        { href: '/notifications', label: 'Needs you', icon: 'check' },
        { href: '/portal', label: 'Projects', icon: 'portal' },
        { href: '/invoices', label: 'Invoices', icon: 'card' },
      ],
    },
    {
      label: 'Company',
      items: [
        { href: '/company/members', label: 'Members', icon: 'people' },
        { href: '/plan', label: 'Plan & usage', icon: 'gauge' },
        { href: '/settings', label: 'Settings', icon: 'settings' },
        { href: '/profile', label: 'Profile', icon: 'people' },
        { href: '/security', label: 'Security', icon: 'lock', accountLevel: true },
      ],
    },
  ],
};

const ACCOUNT_NAV: NavGroup[] = [{
  label: 'Account',
  items: [
    { href: '/profile', label: 'Profile', icon: 'people' },
    { href: '/security', label: 'Security', icon: 'lock', accountLevel: true },
    { href: '/company/members', label: 'Members', icon: 'people' },
    { href: '/plan', label: 'Plan & usage', icon: 'gauge' },
    { href: '/settings', label: 'Settings', icon: 'settings' },
  ],
}];

const PLATFORM_NAV: NavGroup[] = [
  {
    label: 'Overview',
    items: [{ href: '/admin', label: 'Dashboard', icon: 'overview', superAdmin: true }],
  },
  {
    label: 'Directory',
    items: [
      { href: '/admin/users', label: 'Users', icon: 'people', superAdmin: true },
      { href: '/admin/companies', label: 'Companies', icon: 'building', superAdmin: true },
    ],
  },
  {
    label: 'Commercial',
    items: [{ href: '/admin/plans', label: 'Plans & pricing', icon: 'gauge', superAdmin: true }],
  },
  {
    label: 'Operations',
    items: [{ href: '/admin/operations', label: 'Operations', icon: 'check', superAdmin: true }],
  },
  {
    label: 'Insights',
    items: [
      { href: '/admin/reporting', label: 'Reporting', icon: 'list', superAdmin: true },
      { href: '/admin/audit', label: 'Platform audit', icon: 'resolve', superAdmin: true },
    ],
  },
  {
    label: 'Platform',
    items: [
      { href: '/admin/settings', label: 'Settings', icon: 'settings', superAdmin: true },
      // Platform staff usually own no company at all, and theirs are the most
      // valuable accounts on the platform — they are also where step 3 makes a
      // second factor mandatory. Reaching this screen must not depend on owning a
      // tenant.
      { href: '/security', label: 'Security', icon: 'lock', accountLevel: true },
      { href: '/admin/access', label: 'Admin access', icon: 'people', superAdmin: true },
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
  '/security': 'Security',
  '/admin/plans': 'Plans',
  '/admin/companies': 'Companies',
  '/admin/users': 'Users',
  '/admin/reporting': 'Reporting',
  '/admin/operations': 'Operations',
  '/admin/settings': 'Settings',
  '/admin/access': 'Admin access',
  '/admin/audit': 'Platform audit',
  '/admin': 'Dashboard',
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
  const { ready, session, companyId, activeMembership, logout } = useAuth();
  const workspace = useWorkspace();
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
  /*
   * `loading && no views yet` rather than `loading` — a *reload* must not unmount
   * the page, the same rule the profile screen already applies to its own fetch.
   *
   * The bug this closes: `refreshUser()` mints a new session object, which
   * re-runs the workspace effect, which flipped `loading` true and replaced
   * `children` with this message. Any screen that saves and then re-reads the
   * session was therefore torn down mid-save and rebuilt with its local state
   * gone — so "Your profile was saved." was a race with a network round-trip and
   * usually lost. Found as an intermittent browser-suite failure on 2026-08-19.
   */
  if (activeMembership && workspace.loading && workspace.workspaces.length === 0) {
    return <CenteredMessage>Loading workspace views…</CenteredMessage>;
  }

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
   * Screens that are about the account rather than about a company, and therefore
   * render without one.
   *
   * `/profile` deliberately stays behind the gate: the companyless prompt *is* the
   * create-a-company action, which is the thing that screen is for. Security is
   * different — a person with no company still has devices signed in, and being
   * told to create a company before they can sign a lost phone out would make the
   * one action that matters unreachable at the one moment it matters.
   */
  const accountLevelScreen = pathname === '/security' || pathname.startsWith('/security/');

  /**
   * Staff with no company get the platform group alone. Showing them the workspace
   * navigation offers fifteen links that every one of them lands on "create a company",
   * and buries the two that work below the fold.
   */
  const companyless = !activeMembership;
  const visible = (items: NavItem[]) =>
    items.filter((item) => {
      // Account-level first: a company filter must not hide the screen somebody
      // with no company needs.
      if (item.accountLevel) return true;
      if (item.superAdmin) return isSuperAdmin;
      if (companyless) return false;
      // Within Operations, effective plan entitlements still decide which controls
      // exist. Client/Subcontractor access itself came from `/me/workspaces` and is
      // not inferred from those plan features.
      if (!entitlements) return true;
      if (item.requiresDownstream && !entitlements.operatesDownstream) return false;
      if (item.feature && !entitlements.features.includes(item.feature)) return false;
      return true;
    });

  const sourceGroups = platformScreen || (companyless && isSuperAdmin)
    ? PLATFORM_NAV
    : workspace.selectedView
      ? VIEW_NAV[workspace.selectedView]
      : ACCOUNT_NAV;
  const groups = sourceGroups
    .map((group) => ({ ...group, items: visible(group.items) }))
    .filter((group) => group.items.length > 0);
  const showCompanySwitcher = isSuperAdmin || workspace.workspaces.length > 1;
  const showViewSwitcher = platformScreen || Boolean(workspace.activeWorkspace);
  const brandHref = platformScreen
    ? '/admin'
    : resolveLandingRoute({ view: workspace.selectedView });
  const companySelectorValue = platformScreen ? 'PLATFORM' : (companyId ?? '');

  return (
    <>
      <a className="cq-skip-link" href="#main-content">
        Skip to content
      </a>
      <div className="cq-app-shell">
        <aside className="cq-sidebar" aria-label="Primary navigation">
          <Link className="cq-brand" href={brandHref} translate="no">
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
                      (item.href !== '/app' && item.href !== '/admin' && pathname.startsWith(`${item.href}/`));
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
                  {activeMembership
                    ? `${titleCase(activeMembership.role)}${workspace.selectedView ? ` · ${WORKSPACE_VIEW_LABELS[workspace.selectedView]}` : ''}`
                    : platformScreen ? 'Super Admin' : 'No company'}
                </span>
              </span>
            </Link>
          </div>
        </aside>

        <div className="cq-app">
          <header className="cq-topbar">
            <div className="cq-breadcrumbs" aria-label="Breadcrumb">
              <span>{platformScreen ? 'CrewQuo Platform' : (activeMembership?.companyName ?? 'Workspace')}</span>
              <span className="cq-breadcrumbs__separator" aria-hidden="true">
                /
              </span>
              <span aria-current="page">{pageName}</span>
            </div>
            <div className="cq-row" style={{ gap: 8 }}>
              {workspace.error ? (
                <span className="cq-muted" role="alert">
                  {workspace.error}
                </span>
              ) : null}
              {showCompanySwitcher ? (
                <Select
                  className="cq-company-select"
                  value={companySelectorValue}
                  onChange={(event) => {
                    if (event.target.value === 'PLATFORM') router.push('/admin');
                    else workspace.selectCompany(event.target.value);
                  }}
                  aria-label="Active company"
                >
                  {isSuperAdmin ? <option value="PLATFORM">CrewQuo Platform</option> : null}
                  {workspace.workspaces.map((entry) => (
                    <option key={entry.companyId} value={entry.companyId}>
                      {entry.companyName} · {titleCase(entry.role)}
                    </option>
                  ))}
                </Select>
              ) : null}
              {showViewSwitcher ? (
                <Select
                  className="cq-view-select"
                  value={platformScreen ? 'SUPER_ADMIN' : (workspace.selectedView ?? 'ACCOUNT')}
                  onChange={(event) => {
                    if (event.target.value === 'SUPER_ADMIN') {
                      router.push('/admin');
                      return;
                    }
                    if (!companyId) return;
                    const rawView = event.target.value;
                    workspace.selectWorkspace(
                      companyId,
                      rawView === 'ACCOUNT' ? null : (rawView as WorkspaceView)
                    );
                  }}
                  aria-label="Workspace view"
                >
                  {platformScreen ? (
                    <option value="SUPER_ADMIN">Super Admin</option>
                  ) : workspace.activeWorkspace?.views.length ? (
                    workspace.activeWorkspace.views.map((view) => (
                      <option key={view} value={view}>{WORKSPACE_VIEW_LABELS[view]}</option>
                    ))
                  ) : (
                    <option value="ACCOUNT">Account setup</option>
                  )}
                </Select>
              ) : null}
              <Button variant="secondary" size="sm" onClick={() => void logout()}>
                Sign out
              </Button>
            </div>
          </header>

          <main className="cq-main" id="main-content" tabIndex={-1}>
            <div className="cq-container">
              {activeMembership || platformScreen || accountLevelScreen ? (
                children
              ) : (
                <NoCompany />
              )}
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
  if (name === 'lock')
    return (
      <svg {...common}>
        <rect x="4.5" y="8.5" width="11" height="8" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
        <path d="M7.25 8.5V6.75a2.75 2.75 0 0 1 5.5 0V8.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
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
