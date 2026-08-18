'use client';

import { FEATURE_KEYS, LIMIT_KEYS, type FeatureKey, type LimitKey } from '@crewquo/shared';
import { Badge, EmptyState, PageHeader, Section, Stack, Table } from '@crewquo/ui';
import { Shell } from '@/components/Shell';
import { useEntitlements } from '@/lib/useEntitlements';
import { formatUsage, titleCase } from '@/lib/format';

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
};

const FEATURE_LABELS: Record<FeatureKey, string> = {
  rate_cards: 'Rate cards',
  holiday_rates: 'Holiday & timeframe rates',
  exports: 'PDF & spreadsheet exports',
  client_portal: 'Client portal',
  client_portal_notes: 'Portal notes',
  invoicing: 'Invoicing',
  audit_visibility: 'Client-visible audit trail',
  api_access: 'API access',
  sso: 'Single sign-on',
  white_label: 'White label',
};

function Plan() {
  const { loading, error, data } = useEntitlements();

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
