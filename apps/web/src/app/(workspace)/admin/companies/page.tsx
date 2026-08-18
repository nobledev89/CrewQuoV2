'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  FEATURE_KEYS,
  LIMIT_KEYS,
  SUBSCRIPTION_STATUSES,
  type AdminCompanyDetail,
  type AdminCompanySummary,
  type AdminPlanView,
  type FeatureKey,
  type LimitKey,
  type SubscriptionStatus,
} from '@crewquo/shared';
import {
  Badge,
  Button,
  EmptyState,
  ErrorText,
  Field,
  Input,
  Notice,
  PageHeader,
  Row,
  SearchInput,
  Section,
  Select,
  Stack,
  Table,
} from '@crewquo/ui';
import { Shell } from '@/components/Shell';
import { api, ApiError } from '@/api/client';
import { useAuth } from '@/auth/AuthProvider';
import { useAsyncData } from '@/lib/useAsyncData';
import { formatDateTime, formatUsage, titleCase } from '@/lib/format';

/**
 * Super-admin companies console (§5B, §7).
 *
 * The support view: who exists, what they resolve to, how close they are to their
 * caps, and the three levers a platform operator has — an entitlement override, a
 * comped trial, and a forced plan change. Every one of them is written to the
 * *subject company's* audit trail, so a customer can see what was done to their
 * account rather than only being told.
 *
 * Two things this screen states rather than hides:
 *
 *  - A company with **no subscription row** is not a company with no entitlements.
 *    It resolves against the free plan, and the table says so ("Crew · no
 *    subscription") instead of showing a blank that reads as broken.
 *  - Placeholder companies are **excluded by default**. Every invited provider and
 *    portal client creates one (§3.6), so they outnumber real accounts; the toggle
 *    is there for the case where support is chasing a specific stub.
 */
export default function AdminCompaniesPage() {
  return (
    <Shell>
      <AdminCompanies />
    </Shell>
  );
}

function AdminCompanies() {
  const { session } = useAuth();
  const token = session?.accessToken ?? null;

  const [search, setSearch] = useState('');
  const [applied, setApplied] = useState('');
  const [planFilter, setPlanFilter] = useState('');
  const [includePlaceholders, setIncludePlaceholders] = useState(false);
  // Cursor paging is forward-only by design (§7 keyset), so the page stack is kept
  // client-side: `pages[i]` is the cursor that produced page i.
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  const [pageIndex, setPageIndex] = useState(0);
  const [expanded, setExpanded] = useState<string | null>(null);

  const plans = useAsyncData<AdminPlanView[]>(
    token ? () => api.adminListPlans(token).then((r) => r.plans) : null,
    [token]
  );

  const cursor = cursors[pageIndex];
  const list = useAsyncData(
    token
      ? () =>
          api.adminListCompanies(token, {
            search: applied || undefined,
            planId: planFilter || undefined,
            includePlaceholders,
            cursor,
          })
      : null,
    [token, applied, planFilter, includePlaceholders, cursor]
  );

  /** Any filter change invalidates the page stack — cursor 3 of a different query is meaningless. */
  const resetPaging = useCallback(() => {
    setCursors([undefined]);
    setPageIndex(0);
  }, []);

  if (!session?.user.isSuperAdmin) {
    return (
      <Stack>
        <PageHeader eyebrow="Platform" title="Companies" />
        <EmptyState title="Platform staff only">
          The companies console is limited to CrewQuo platform staff. Your own plan and usage
          are under <a href="/plan">plan &amp; usage</a>.
        </EmptyState>
      </Stack>
    );
  }

  const rows = list.data?.data ?? [];

  return (
    <Stack>
      <PageHeader
        eyebrow="Platform"
        title="Companies"
        description="Every account, what it resolves to, and the three support levers: overrides, comped trials and forced plan changes."
      />

      {/*
        The filters are a toolbar on the table they filter, not a panel above it. This
        screen is read by support with a customer waiting, and the search form plus its
        own panel header used to push the first result to 653px — one visible row.
        The advisory that used to sit here as a page banner now sits on the actions it
        qualifies, in the detail view where those actions are (§40: warnings inline and
        specific, not a banner at the top of the page).
      */}
      <Section className="cq-section--table">
        <form
          className="cq-table-toolbar"
          onSubmit={(e) => {
            e.preventDefault();
            setApplied(search.trim());
            resetPaging();
          }}
        >
          <Row>
            <SearchInput
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Name or member email"
              aria-label="Search by company name or member email"
            />
            <Select
              value={planFilter}
              onChange={(e) => {
                setPlanFilter(e.target.value);
                resetPaging();
              }}
              aria-label="Resolved plan"
            >
              <option value="">Any plan</option>
              {(plans.data ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
            <label className="cq-row" style={{ gap: 6 }} title="Every invite creates a stub company, so these outnumber real accounts">
              <input
                type="checkbox"
                checked={includePlaceholders}
                onChange={(e) => {
                  setIncludePlaceholders(e.target.checked);
                  resetPaging();
                }}
              />
              <span className="cq-muted">Include placeholders</span>
            </label>
            <Button type="submit" size="sm">Search</Button>
            {applied || planFilter || includePlaceholders ? (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  setSearch('');
                  setApplied('');
                  setPlanFilter('');
                  setIncludePlaceholders(false);
                  resetPaging();
                }}
              >
                Clear
              </Button>
            ) : null}
          </Row>
          <span className="cq-table-toolbar__meta">
            {applied ? `Matching “${applied}”` : 'Newest first'}
          </span>
        </form>

        <ErrorText>{list.error}</ErrorText>
        {list.loading ? (
          <p className="cq-muted">Loading companies…</p>
        ) : rows.length === 0 ? (
          <EmptyState title="No companies matched">
            {applied || planFilter
              ? 'Nothing matched those filters. Placeholder companies are hidden unless you tick the box above.'
              : 'There are no companies yet, which on a live database would be a surprise.'}
          </EmptyState>
        ) : (
          <>
            <Table label="Companies">
              <thead>
                <tr>
                  <th scope="col">Company</th>
                  <th scope="col">Plan</th>
                  <th scope="col" className="cq-numeric">Members</th>
                  <th scope="col" className="cq-numeric">Overrides</th>
                  <th scope="col" className="cq-numeric">Created</th>
                  <th scope="col">
                    <span className="cq-table__actions">Manage</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((company) => (
                  <tr key={company.id}>
                    <td className="cq-table__primary">
                      {company.name}
                      {company.isPlaceholder ? (
                        <>
                          {' '}
                          <Badge tone="warning">Placeholder</Badge>
                        </>
                      ) : null}
                      {company.claimedByCompanyId ? (
                        <>
                          {' '}
                          <Badge tone="neutral">Merged away</Badge>
                        </>
                      ) : null}
                      <div className="cq-muted">{company.currency}</div>
                    </td>
                    <td>
                      <PlanCell company={company} />
                    </td>
                    <td className="cq-numeric">{company.memberCount}</td>
                    <td className="cq-numeric">
                      {company.overrideCount === 0 ? (
                        <span className="cq-muted">None</span>
                      ) : (
                        <Badge tone="accent">{company.overrideCount}</Badge>
                      )}
                    </td>
                    <td>{formatDateTime(company.createdAt)}</td>
                    <td className="cq-table__actions">
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => setExpanded(expanded === company.id ? null : company.id)}
                      >
                        {expanded === company.id ? 'Close' : 'Open'}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>

            <Row between>
              <span className="cq-muted">
                Page {pageIndex + 1} · {rows.length} shown
              </span>
              <Row>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={pageIndex === 0}
                  onClick={() => setPageIndex((i) => Math.max(0, i - 1))}
                >
                  Previous
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={!list.data?.nextCursor}
                  onClick={() => {
                    const next = list.data?.nextCursor;
                    if (!next) return;
                    setCursors((prev) => {
                      const copy = [...prev];
                      copy[pageIndex + 1] = next;
                      return copy;
                    });
                    setPageIndex((i) => i + 1);
                  }}
                >
                  Next
                </Button>
              </Row>
            </Row>
          </>
        )}
      </Section>

      {expanded && token ? (
        <CompanyDetail
          token={token}
          companyId={expanded}
          plans={plans.data ?? []}
          onChanged={() => list.reload()}
        />
      ) : null}
    </Stack>
  );
}

function PlanCell({ company }: { company: AdminCompanySummary }) {
  return (
    <Stack>
      <div>
        <strong>{company.planId}</strong>
      </div>
      {company.subscriptionStatus === null ? (
        // Not an error state: no row means the free default, and saying "none"
        // without saying what it resolves to is how support misreads this screen.
        <span className="cq-muted">No subscription — free default</span>
      ) : (
        <Row>
          <Badge
            tone={
              company.subscriptionStatus === 'ACTIVE'
                ? 'success'
                : company.subscriptionStatus === 'TRIALING'
                  ? 'accent'
                  : 'warning'
            }
          >
            {titleCase(company.subscriptionStatus)}
          </Badge>
          {company.trialEnd ? (
            <span className="cq-muted">trial ends {formatDateTime(company.trialEnd)}</span>
          ) : company.currentPeriodEnd ? (
            <span className="cq-muted">renews {formatDateTime(company.currentPeriodEnd)}</span>
          ) : null}
        </Row>
      )}
    </Stack>
  );
}

// ── Detail: resolved entitlements, live usage, overrides, the three levers ──────

function CompanyDetail({
  token,
  companyId,
  plans,
  onChanged,
}: {
  token: string;
  companyId: string;
  plans: AdminPlanView[];
  onChanged: () => void;
}) {
  const detail = useAsyncData<AdminCompanyDetail>(
    () => api.adminCompany(token, companyId),
    [token, companyId]
  );

  const reload = useCallback(() => {
    detail.reload();
    onChanged();
  }, [detail, onChanged]);

  // `loading && !data`: a *reload* after an action must not blank the panel. Doing so
  // unmounts the forms below and throws away the confirmation they just set, so a
  // successful override or comped trial would flash its message and erase it.
  if (detail.loading && !detail.data) {
    return (
      <Section title="Loading account…">
        <p className="cq-muted">Reading entitlements and live usage…</p>
      </Section>
    );
  }
  if (detail.error || !detail.data) {
    return (
      <Section title="Account">
        <EmptyState title="Could not load this company">
          {detail.error ?? 'Nothing was returned.'}
        </EmptyState>
      </Section>
    );
  }

  const { company, entitlements, usage, overrides } = detail.data;

  return (
    <>
      <Section
        title={company.name}
        description="Resolved entitlements and live usage — read from the same resolver and meters the product itself enforces."
        className="cq-section--table"
      >
        <Stack>
          <div className="cq-metrics">
            <div className="cq-metric">
              <div className="cq-overline">Resolved plan</div>
              <div className="cq-metric__value" style={{ fontSize: 20 }}>
                {entitlements.planId}
              </div>
              <div className="cq-metric__context">
                {company.subscriptionStatus ?? 'no subscription row'}
              </div>
            </div>
            <div className="cq-metric">
              <div className="cq-overline">Can subcontract</div>
              <div className="cq-metric__value" style={{ fontSize: 20 }}>
                {entitlements.operatesDownstream ? 'Yes' : 'No'}
              </div>
              <div className="cq-metric__context">operates_downstream</div>
            </div>
            <div className="cq-metric">
              <div className="cq-overline">Features</div>
              <div className="cq-metric__value" style={{ fontSize: 20 }}>
                {entitlements.features.length} / {FEATURE_KEYS.length}
              </div>
              <div className="cq-metric__context">after overrides</div>
            </div>
            <div className="cq-metric">
              <div className="cq-overline">Active members</div>
              <div className="cq-metric__value" style={{ fontSize: 20 }}>
                {company.memberCount}
              </div>
              <div className="cq-metric__context">membership rows</div>
            </div>
          </div>

          <Table label={`${company.name} usage against limits`}>
            <thead>
              <tr>
                <th scope="col">Limit</th>
                <th scope="col" className="cq-numeric">Used</th>
                <th scope="col" className="cq-numeric">Allowance</th>
                <th scope="col">State</th>
              </tr>
            </thead>
            <tbody>
              {usage.map((u) => {
                const atLimit = u.value !== null && u.used >= u.value;
                return (
                  <tr key={u.key}>
                    <td className="cq-table__primary">{titleCase(u.key)}</td>
                    <td className="cq-numeric">{formatUsage(u.used, u.value)}</td>
                    <td className="cq-numeric">
                      {u.value === null ? (
                        <Badge tone="success">Unlimited</Badge>
                      ) : u.value === 0 ? (
                        <span className="cq-muted">None</span>
                      ) : (
                        u.value
                      )}
                    </td>
                    <td>
                      {u.key === 'audit_retention_days' ? (
                        // A config value, not a meter — `used` is always 0 and
                        // rendering it as "0 / 90" would read as unused capacity.
                        <span className="cq-muted">Retention setting, not a meter</span>
                      ) : atLimit ? (
                        <Badge tone="warning">At limit</Badge>
                      ) : (
                        <Badge tone="success">Within</Badge>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </Table>

          <div>
            <div className="cq-overline">Enabled features</div>
            <Row>
              {entitlements.features.length === 0 ? (
                <span className="cq-muted">None</span>
              ) : (
                entitlements.features.map((f) => (
                  <Badge key={f} tone="neutral">
                    {titleCase(f)}
                  </Badge>
                ))
              )}
            </Row>
          </div>
        </Stack>
      </Section>

      <SubscriptionLevers
        token={token}
        company={company}
        plans={plans}
        onDone={reload}
      />

      <Overrides
        token={token}
        companyId={company.id}
        overrides={overrides}
        onDone={reload}
      />
    </>
  );
}

/** Force a plan, or comp/extend a trial. Both write `company_subscriptions`. */
function SubscriptionLevers({
  token,
  company,
  plans,
  onDone,
}: {
  token: string;
  company: AdminCompanySummary;
  plans: AdminPlanView[];
  onDone: () => void;
}) {
  const [planId, setPlanId] = useState(company.planId);
  const [status, setStatus] = useState<SubscriptionStatus>(company.subscriptionStatus ?? 'ACTIVE');
  const [trialDays, setTrialDays] = useState('14');
  const [busy, setBusy] = useState<'plan' | 'trial' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  /*
   * Re-seed only when a *different* company is opened.
   *
   * Keyed on `company.id` alone on purpose: the plan and status are exactly what these
   * controls change, so depending on them would make every successful action re-seed the
   * form and clear the confirmation it had just set.
   */
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    setPlanId(company.planId);
    setStatus(company.subscriptionStatus ?? 'ACTIVE');
    setDone(null);
    setError(null);
  }, [company.id]);

  async function forcePlan() {
    setBusy('plan');
    setError(null);
    setDone(null);
    try {
      await api.adminSetSubscription(token, company.id, { planId, status });
      setDone(`Plan set to ${planId} (${status}).`);
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not change the plan');
    } finally {
      setBusy(null);
    }
  }

  async function comp() {
    const days = Number(trialDays);
    if (!Number.isInteger(days) || days < 1) {
      setError('Trial length must be a whole number of days.');
      return;
    }
    setBusy('trial');
    setError(null);
    setDone(null);
    try {
      const res = await api.adminCompTrial(token, company.id, { planId, days });
      setDone(
        `Trial of ${planId} runs to ${formatDateTime(res.company.trialEnd)}.`
      );
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not comp the trial');
    } finally {
      setBusy(null);
    }
  }

  return (
    <Section
      title="Plan & trial"
      description="Takes effect immediately — the entitlement cache is invalidated on write — and is recorded in this company's own audit trail. There is no merchant of record yet (Phase 6), so changing a plan here is the billing system."
    >
      <Stack>
        <div className="cq-form-grid">
          <Field label="Plan">
            <Select value={planId} onChange={(e) => setPlanId(e.target.value)}>
              {plans.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} ({p.id})
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Subscription status" hint="Used by the forced plan change, not by the trial.">
            <Select
              value={status}
              onChange={(e) => setStatus(e.target.value as SubscriptionStatus)}
            >
              {SUBSCRIPTION_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {titleCase(s)}
                </option>
              ))}
            </Select>
          </Field>
          <Field
            label="Trial days"
            hint="Added to a live trial; started fresh from today if the last one lapsed."
          >
            <Input
              type="number"
              min="1"
              value={trialDays}
              onChange={(e) => setTrialDays(e.target.value)}
            />
          </Field>
        </div>
        {done ? <Notice>{done}</Notice> : null}
        <ErrorText>{error}</ErrorText>
        <Row>
          <Button onClick={() => void forcePlan()} disabled={busy !== null}>
            {busy === 'plan' ? 'Saving…' : 'Force plan change'}
          </Button>
          <Button variant="secondary" onClick={() => void comp()} disabled={busy !== null}>
            {busy === 'trial' ? 'Granting…' : 'Comp / extend trial'}
          </Button>
        </Row>
        <p className="cq-muted">
          Grandfathering is snapshot-based and arrives with Phase 6 billing, so nothing here
          writes an entitlement snapshot — the company resolves live against the plan it is on.
        </p>
      </Stack>
    </Section>
  );
}

/** Per-company entitlement overrides: grant, withdraw, raise a cap, or revoke one. */
function Overrides({
  token,
  companyId,
  overrides,
  onDone,
}: {
  token: string;
  companyId: string;
  overrides: AdminCompanyDetail['overrides'];
  onDone: () => void;
}) {
  const [kind, setKind] = useState<'feature' | 'limit'>('feature');
  const [featureKey, setFeatureKey] = useState<FeatureKey>(FEATURE_KEYS[0]);
  const [featureEnabled, setFeatureEnabled] = useState(true);
  const [limitKey, setLimitKey] = useState<LimitKey>(LIMIT_KEYS[0]);
  const [unlimited, setUnlimited] = useState(false);
  const [limitValue, setLimitValue] = useState('');
  const [note, setNote] = useState('');
  const [expires, setExpires] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function apply(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.adminAddOverride(token, companyId, {
        ...(kind === 'feature'
          ? { featureKey, featureEnabled }
          : { limitKey, limitValue: unlimited ? null : Number(limitValue) }),
        ...(note.trim() ? { note: note.trim() } : {}),
        // A date input gives `YYYY-MM-DD`; the API wants a datetime. End of that
        // day in UTC, so "expires on the 30th" includes the 30th.
        ...(expires ? { expiresAt: new Date(`${expires}T23:59:59Z`).toISOString() } : {}),
      });
      setNote('');
      setExpires('');
      setLimitValue('');
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not apply the override');
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    setBusy(true);
    setError(null);
    try {
      await api.adminRemoveOverride(token, companyId, id);
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not remove the override');
    } finally {
      setBusy(false);
    }
  }

  const limitInvalid = kind === 'limit' && !unlimited && !/^\d+$/.test(limitValue.trim());

  return (
    <Section
      title="Entitlement overrides"
      description="Applied on top of the plan and live on the next request. A feature override wins over the plan; a limit override replaces the plan's number. Each change is recorded in this company's own audit trail."
      className="cq-section--table"
    >
      <Stack>
        {overrides.length === 0 ? (
          <p className="cq-muted">
            No overrides. This company gets exactly what its plan grants.
          </p>
        ) : (
          <Table label="Overrides">
            <thead>
              <tr>
                <th scope="col">Override</th>
                <th scope="col">Value</th>
                <th scope="col">Note</th>
                <th scope="col">Expires</th>
                <th scope="col">
                  <span className="cq-table__actions">Revoke</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {overrides.map((o) => (
                <tr key={o.id}>
                  <td className="cq-table__primary">
                    {titleCase(o.featureKey ?? o.limitKey ?? 'unknown')}
                    <div className="cq-muted">{o.featureKey ? 'Feature' : 'Limit'}</div>
                  </td>
                  <td>
                    {o.featureKey ? (
                      o.featureEnabled ? (
                        <Badge tone="success">Granted</Badge>
                      ) : (
                        <Badge tone="warning">Withdrawn</Badge>
                      )
                    ) : o.limitValue === null ? (
                      <Badge tone="success">Unlimited</Badge>
                    ) : (
                      <span className="cq-numeric">{o.limitValue}</span>
                    )}
                  </td>
                  <td>{o.note ?? <span className="cq-muted">—</span>}</td>
                  <td>
                    {o.expiresAt === null ? (
                      <span className="cq-muted">Never</span>
                    ) : o.expired ? (
                      // Kept visible on purpose: a lapsed grant explains a feature
                      // that "stopped working", which hiding the row would not.
                      <Badge tone="neutral">Lapsed {formatDateTime(o.expiresAt)}</Badge>
                    ) : (
                      formatDateTime(o.expiresAt)
                    )}
                  </td>
                  <td className="cq-table__actions">
                    <Button
                      size="sm"
                      variant="danger"
                      disabled={busy}
                      onClick={() => void remove(o.id)}
                    >
                      Revoke
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}

        <form onSubmit={apply} className="cq-stack" aria-busy={busy}>
          <div className="cq-overline">Apply an override</div>
          <div className="cq-form-grid">
            <Field label="Kind">
              <Select
                value={kind}
                onChange={(e) => setKind(e.target.value as 'feature' | 'limit')}
              >
                <option value="feature">Feature</option>
                <option value="limit">Limit</option>
              </Select>
            </Field>
            {kind === 'feature' ? (
              <>
                <Field label="Feature">
                  <Select
                    value={featureKey}
                    onChange={(e) => setFeatureKey(e.target.value as FeatureKey)}
                  >
                    {FEATURE_KEYS.map((k) => (
                      <option key={k} value={k}>
                        {titleCase(k)}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Effect">
                  <Select
                    value={featureEnabled ? 'grant' : 'withdraw'}
                    onChange={(e) => setFeatureEnabled(e.target.value === 'grant')}
                  >
                    <option value="grant">Grant, even if the plan lacks it</option>
                    <option value="withdraw">Withdraw, even if the plan has it</option>
                  </Select>
                </Field>
              </>
            ) : (
              <>
                <Field label="Limit">
                  <Select
                    value={limitKey}
                    onChange={(e) => setLimitKey(e.target.value as LimitKey)}
                  >
                    {LIMIT_KEYS.map((k) => (
                      <option key={k} value={k}>
                        {titleCase(k)}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field
                  label="Allowance"
                  hint="Zero means none allowed; unlimited means no cap. They are opposite instructions."
                >
                  <Input
                    type="number"
                    min="0"
                    value={unlimited ? '' : limitValue}
                    disabled={unlimited}
                    placeholder={unlimited ? 'Unlimited' : '30'}
                    onChange={(e) => setLimitValue(e.target.value)}
                  />
                </Field>
              </>
            )}
            <Field label="Note" hint="Why. Read back on the audit row.">
              <Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} />
            </Field>
            <Field label="Expires on" hint="Leave blank for permanent until revoked.">
              <Input type="date" value={expires} onChange={(e) => setExpires(e.target.value)} />
            </Field>
          </div>
          {kind === 'limit' ? (
            <label className="cq-row" style={{ gap: 8 }}>
              <input
                type="checkbox"
                checked={unlimited}
                onChange={(e) => setUnlimited(e.target.checked)}
              />
              <span>Unlimited</span>
            </label>
          ) : null}
          <ErrorText>{error}</ErrorText>
          <Row>
            <Button type="submit" disabled={busy || limitInvalid}>
              {busy ? 'Applying…' : 'Apply override'}
            </Button>
          </Row>
        </form>
      </Stack>
    </Section>
  );
}
