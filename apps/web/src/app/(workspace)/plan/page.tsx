'use client';

import { useState } from 'react';
import { initializePaddle } from '@paddle/paddle-js';
import { FEATURE_KEYS, LIMIT_KEYS, type FeatureKey, type LimitKey } from '@crewquo/shared';
import { Badge, Button, EmptyState, PageHeader, Row, Section, Stack, Table } from '@crewquo/ui';
import { Shell } from '@/components/Shell';
import { useEntitlements } from '@/lib/useEntitlements';
import { formatUsage, titleCase } from '@/lib/format';
import { useAuth, useSessionCtx } from '@/auth/AuthProvider';
import { useAsyncData } from '@/lib/useAsyncData';
import { api, ApiError } from '@/api/client';

/**
 * Plan & usage — the web surface for `GET /v1/entitlements` (§5B).
 *
 * Two things this screen must get right:
 *
 *  - **`null` is unlimited, not zero.** The seed ships plans with both (Crew allows 0
 *    subcontractors; Enterprise allows unlimited), and rendering them the same way
 *    would invert the meaning of the most expensive tier.
 *  - **Every catalog key is listed, not just the granted ones.** A customer deciding
 *    whether to upgrade needs to see what they do *not* have; a list of only what
 *    they own answers a different question.
 */
export default function PlanPage() {
  return (
    <Shell>
      <Plan />
    </Shell>
  );
}

const LIMIT_LABELS: Record<LimitKey, string> = {
  active_subcontractors: 'Active subcontractors',
  internal_seats: 'Team seats',
  clients: 'Portal clients',
  audit_retention_days: 'Audit retention (days)',
  storage_gb: 'File storage (GB)',
  evidence_uploads_per_month: 'Evidence uploads per month',
};

const FEATURE_LABELS: Record<FeatureKey, string> = {
  rate_cards: 'Rate cards',
  holiday_rates: 'Holiday & timeframe rates',
  exports: 'PDF & spreadsheet exports',
  client_portal: 'Client portal',
  client_portal_notes: 'Portal notes',
  project_evidence: 'Photos & evidence',
  project_documents: 'Project documents',
  site_diary: 'Site diary',
  asset_tracking: 'Asset & material tracking',
  invoicing: 'Invoicing',
  audit_visibility: 'Client-visible audit trail',
  api_access: 'API access',
  sso: 'Single sign-on',
  white_label: 'White label',
};

function Plan() {
  const { loading, error, data } = useEntitlements();
  const ctx = useSessionCtx();
  const { activeMembership } = useAuth();
  const billing = useAsyncData(
    ctx ? () => api.billing(ctx.accessToken, ctx.companyId) : null,
    [ctx?.companyId]
  );
  const [checkoutPriceId, setCheckoutPriceId] = useState<string | null>(null);
  const [checkoutError, setCheckoutError] = useState<string | null>(null);
  const [managing, setManaging] = useState<string | null>(null);
  const [managementNotice, setManagementNotice] = useState<string | null>(null);

  const subscription = billing.data?.subscription ?? null;
  const isOwner = activeMembership?.role === 'OWNER';
  /**
   * A provider-managed subscription changes what a price button *means*. Buying a
   * second subscription for a company that already has one is the one thing this
   * screen must not allow, so the same button becomes a plan change.
   */
  const managed = subscription?.selfManageable === true && subscription.status !== 'CANCELED';

  /**
   * Run one provider action, then re-read.
   *
   * `reload()` rather than trusting the returned subscription alone: the webhook
   * for the same change may land in between, and the plan list and the current
   * price come from the same read anyway.
   */
  async function manage(
    key: string,
    action: (token: string, companyId: string) => Promise<{ message: string }>
  ) {
    // The session is handed to the action rather than read inside it: these
    // callbacks are built in JSX, where nothing has narrowed `ctx` yet.
    if (!ctx) return;
    setManaging(key);
    setManagementNotice(null);
    setCheckoutError(null);
    try {
      const result = await action(ctx.accessToken, ctx.companyId);
      setManagementNotice(result.message);
      billing.reload();
    } catch (err) {
      setCheckoutError(err instanceof ApiError ? err.message : 'That change could not be made.');
    } finally {
      setManaging(null);
    }
  }

  async function openPaymentMethod() {
    if (!ctx) return;
    setManaging('payment-method');
    setManagementNotice(null);
    setCheckoutError(null);
    try {
      const { updatePaymentMethodUrl } = await api.subscriptionPaymentMethodUrl(
        ctx.accessToken,
        ctx.companyId
      );
      if (!updatePaymentMethodUrl) {
        setManagementNotice(
          'Paddle has no self-serve payment page for this subscription. Contact support to change how it is paid.'
        );
        return;
      }
      window.open(updatePaymentMethodUrl, '_blank', 'noopener,noreferrer');
    } catch (err) {
      setCheckoutError(err instanceof ApiError ? err.message : 'That page could not be opened.');
    } finally {
      setManaging(null);
    }
  }

  async function openCheckout(priceId: string) {
    if (!ctx) return;
    setCheckoutPriceId(priceId);
    setCheckoutError(null);
    setManagementNotice(null);
    try {
      const created = await api.startBillingCheckout(ctx.accessToken, ctx.companyId, priceId);
      const token = process.env.NEXT_PUBLIC_PADDLE_CLIENT_TOKEN;
      if (!token) {
        setCheckoutError('Checkout was prepared, but the Paddle client token is not configured.');
        return;
      }
      const paddle = await initializePaddle({
        token,
        environment: process.env.NEXT_PUBLIC_PADDLE_ENVIRONMENT === 'production'
          ? 'production'
          : 'sandbox',
      });
      if (!paddle) {
        window.location.assign(created.checkoutUrl);
        return;
      }
      paddle.Checkout.open({
        transactionId: created.transactionId,
        settings: { displayMode: 'overlay', variant: 'one-page', theme: 'light' },
      });
    } catch (err) {
      setCheckoutError(err instanceof ApiError ? err.message : 'Checkout could not be started.');
    } finally {
      setCheckoutPriceId(null);
    }
  }

  if (loading) {
    return (
      <Stack>
        <PageHeader eyebrow="Company" title="Plan & usage" />
        <p className="cq-muted">Loading your plan…</p>
      </Stack>
    );
  }

  if (error || !data) {
    return (
      <Stack>
        <PageHeader eyebrow="Company" title="Plan & usage" />
        <EmptyState title="Could not load your plan">
          {error ?? 'No entitlements were returned for this company.'}
        </EmptyState>
      </Stack>
    );
  }

  return (
    <Stack>
      <PageHeader
        eyebrow="Company"
        title="Plan & usage"
        description="What this company's plan includes, and how much of each allowance is in use."
        actions={<Badge tone="accent">{titleCase(data.planId)}</Badge>}
      />

      <div className="cq-metrics" aria-label="Plan summary">
        <div className="cq-metric">
          <div className="cq-overline">Plan</div>
          <div className="cq-metric__value">{titleCase(data.planId)}</div>
          <div className="cq-metric__context">Resolved from plan + any overrides</div>
        </div>
        <div className="cq-metric">
          <div className="cq-overline">Subcontracting</div>
          <div className="cq-metric__value">{data.operatesDownstream ? 'Enabled' : 'Off'}</div>
          <div className="cq-metric__context">
            {data.operatesDownstream
              ? 'You can engage your own subcontractors'
              : 'This plan can be hired, but cannot hire'}
          </div>
        </div>
        <div className="cq-metric">
          <div className="cq-overline">Features</div>
          <div className="cq-metric__value">
            {data.features.length} / {FEATURE_KEYS.length}
          </div>
          <div className="cq-metric__context">Included on this plan</div>
        </div>
      </div>

      <Section
        title="Plans and billing"
        description="Paddle is the merchant of record. Prices are charged in USD; taxes are calculated at checkout."
      >
        <Stack>
          {billing.loading ? <p className="cq-muted">Loading available plans…</p> : null}
          {billing.error ? <p role="alert" className="cq-error">{billing.error}</p> : null}
          {subscription ? (
            <Row>
              <Badge tone={subscription.status === 'ACTIVE' ? 'success' : 'warning'}>
                {titleCase(subscription.status)}
              </Badge>
              <span className="cq-muted">
                {titleCase(subscription.planId)}
                {subscription.currentPeriodEnd
                  ? ` · current period ends ${new Date(subscription.currentPeriodEnd).toLocaleDateString()}`
                  : ''}
                {subscription.cancelAtPeriodEnd ? ' · will not renew' : ''}
              </span>
            </Row>
          ) : null}
          {billing.data?.plans.map((plan) => (
            <div key={plan.id} className="cq-card">
              <Row between>
                <div>
                  <strong>{plan.name}</strong>
                  {plan.description ? <div className="cq-muted">{plan.description}</div> : null}
                </div>
                {plan.id === data.planId ? <Badge tone="accent">Current plan</Badge> : null}
              </Row>
              <Row>
                {plan.prices.map((price) => {
                  const busy = checkoutPriceId === price.id || managing === `plan:${price.id}`;
                  const amount = `$${(price.amountCents / 100).toFixed(2)} / ${price.interval === 'MONTH' ? 'month' : 'year'}`;
                  return (
                    <Button
                      key={price.id}
                      size="sm"
                      variant="secondary"
                      disabled={
                        !billing.data?.checkoutEnabled ||
                        !isOwner ||
                        checkoutPriceId !== null ||
                        managing !== null
                      }
                      onClick={() =>
                        managed
                          ? void manage(`plan:${price.id}`, (t, c) =>
                              api.changeSubscriptionPlan(t, c, price.id)
                            )
                          : void openCheckout(price.id)
                      }
                    >
                      {busy ? (managed ? 'Changing…' : 'Opening…') : amount}
                    </Button>
                  );
                })}
              </Row>
            </div>
          ))}
          {managed ? (
            <Row>
              {subscription?.cancelAtPeriodEnd ? (
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={!isOwner || managing !== null}
                  onClick={() =>
                    void manage('resume', (t, c) => api.resumeSubscription(t, c))
                  }
                >
                  {managing === 'resume' ? 'Restoring…' : 'Keep my subscription'}
                </Button>
              ) : (
                <Button
                  size="sm"
                  variant="danger"
                  disabled={!isOwner || managing !== null}
                  onClick={() =>
                    void manage('cancel', (t, c) => api.cancelSubscription(t, c))
                  }
                >
                  {managing === 'cancel' ? 'Cancelling…' : 'Cancel subscription'}
                </Button>
              )}
              <Button
                size="sm"
                variant="secondary"
                disabled={!isOwner || managing !== null}
                onClick={() => void openPaymentMethod()}
              >
                {managing === 'payment-method' ? 'Opening…' : 'Update payment method'}
              </Button>
            </Row>
          ) : null}
          {managed ? (
            <p className="cq-muted">
              Cancelling keeps this plan until the end of the period you have already paid for and
              stops it renewing. Your data stays where it is — closing the company is a separate,
              deliberate step in Settings.
            </p>
          ) : null}
          {subscription && !subscription.selfManageable ? (
            <p className="cq-muted">
              This plan was set by CrewQuo support rather than bought through Paddle, so it is
              changed by contacting support.
            </p>
          ) : null}
          {managementNotice ? <p role="status" className="cq-muted">{managementNotice}</p> : null}
          {billing.data && !billing.data.checkoutEnabled ? (
            <p className="cq-muted">Checkout is not live yet. Your current plan remains unchanged.</p>
          ) : !isOwner ? (
            <p className="cq-muted">Only a company owner can start or change a subscription.</p>
          ) : null}
          {checkoutError ? <p role="alert" className="cq-error">{checkoutError}</p> : null}
        </Stack>
      </Section>

      <Section
        title="Allowances"
        description="Live usage against each metered limit. Unlimited is not the same as zero."
        className="cq-section--table"
      >
        <Table label="Plan limits and usage">
          <thead>
            <tr>
              <th scope="col">Limit</th>
              <th scope="col" className="cq-numeric">In use</th>
              <th scope="col">State</th>
            </tr>
          </thead>
          <tbody>
            {LIMIT_KEYS.map((key) => {
              const row = data.usage.find((u) => u.key === key);
              const value = row?.value ?? data.limits[key] ?? null;
              const used = row?.used ?? 0;
              // A metered key with no usage row is not reported live; say so rather
              // than printing "0 / 5" as though it had been measured.
              const metered = row !== undefined;
              const full = metered && value !== null && used >= value;
              const noAllowance = value !== null && value === 0;
              return (
                <tr key={key}>
                  <td className="cq-table__primary">{LIMIT_LABELS[key]}</td>
                  <td className="cq-numeric">
                    {metered ? formatUsage(used, value) : value === null ? 'unlimited' : value}
                  </td>
                  <td>
                    {noAllowance ? (
                      <Badge tone="neutral">Not on this plan</Badge>
                    ) : full ? (
                      <Badge tone="warning">At limit</Badge>
                    ) : value === null ? (
                      <Badge tone="success">Unlimited</Badge>
                    ) : metered ? (
                      <Badge tone="success">Within limit</Badge>
                    ) : (
                      <span className="cq-muted">Not metered live</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      </Section>

      <Section
        title="Features"
        description="The whole catalog, so what is missing is as visible as what is included."
        className="cq-section--table"
      >
        <Table label="Plan features">
          <thead>
            <tr>
              <th scope="col">Feature</th>
              <th scope="col">Included</th>
            </tr>
          </thead>
          <tbody>
            {FEATURE_KEYS.map((key) => {
              const included = data.features.includes(key);
              return (
                <tr key={key}>
                  <td className="cq-table__primary">{FEATURE_LABELS[key]}</td>
                  <td>
                    {included ? (
                      <Badge tone="success">Included</Badge>
                    ) : (
                      <span className="cq-muted">Not on this plan</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      </Section>
    </Stack>
  );
}
