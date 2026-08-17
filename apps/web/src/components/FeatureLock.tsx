'use client';

import Link from 'next/link';
import type { FeatureKey, LimitKey } from '@crewquo/shared';
import { EmptyState, Notice } from '@crewquo/ui';
import { titleCase } from '@/lib/format';

/**
 * Feature and limit refusals, rendered as an explanation.
 *
 * The API is the gate (§5B) — these components never decide anything. Their job is
 * to say *which* entitlement is missing and where to go about it, because
 * "Forbidden" tells a paying customer nothing about what they bought.
 */

const FEATURE_COPY: Record<FeatureKey, string> = {
  rate_cards: 'Rate cards let you store effective-dated pay and bill rates.',
  holiday_rates: 'Holiday rates apply date-driven multipliers to a shift.',
  exports: 'Exports produce a PDF or spreadsheet of a project and its line items.',
  client_portal: 'The client portal gives a client read access to the projects you publish.',
  client_portal_notes: 'Portal notes let a client comment on a line item and you reply.',
  invoicing: 'Invoicing turns approved work into an invoice you can issue.',
  audit_visibility: 'Audit visibility lets a client see the trail of activity you publish.',
  api_access: 'API access issues keys for your own integrations.',
  sso: 'SSO signs your team in through your identity provider.',
  white_label: 'White label replaces CrewQuo branding on client-facing output.',
};

/** A whole screen that the plan does not include. */
export function FeatureLocked({ feature }: { feature: FeatureKey }) {
  return (
    <EmptyState title={`${titleCase(feature)} is not on your plan`}>
      {FEATURE_COPY[feature]} Your current plan does not include it — see{' '}
      <Link href="/plan">plan &amp; usage</Link> for what you have today.
    </EmptyState>
  );
}

/** An inline banner above an action the plan does not include. */
export function FeatureNotice({ feature }: { feature: FeatureKey }) {
  return (
    <Notice>
      <strong>{titleCase(feature)} is not on your plan.</strong> {FEATURE_COPY[feature]}{' '}
      <Link href="/plan">See plan &amp; usage</Link>.
    </Notice>
  );
}

const LIMIT_COPY: Record<LimitKey, string> = {
  active_subcontractors: 'subcontractors',
  internal_seats: 'team seats',
  clients: 'portal clients',
  audit_retention_days: 'days of audit retention',
};

/** The "23 / 23" state: the action is real, the allowance is spent. */
export function LimitReached({ limit, used, value }: { limit: LimitKey; used: number; value: number }) {
  return (
    <Notice>
      <strong>
        You are using all {value} {LIMIT_COPY[limit]} on your plan ({used} / {value}).
      </strong>{' '}
      Adding another needs a higher plan or an override — see{' '}
      <Link href="/plan">plan &amp; usage</Link>.
    </Notice>
  );
}
