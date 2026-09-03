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
  project_evidence:
    'Photos & evidence keeps site photographs, scans and files against a project, with categories, dates and locations.',
  project_documents:
    'Project documents file RAMS, insurance, waste transfer notes and drawings, with versions kept and expiry dates tracked.',
  site_diary:
    'The site diary is a day-by-day record of what happened on site — attendance, delays, deliveries and health & safety — closed at the end of the day and amendable only with a recorded reason.',
  asset_tracking:
    'Asset & material tracking records what came off a site, what it weighed and where it went — reuse, recycling, landfill — so a project can report its tonnage split.',
  sustainability:
    'Sustainability turns those tonnes into a project’s carbon picture: two headline figures reported side by side and never netted, the data-completeness score behind them, and an organisation dashboard across every project.',
  carbon_engine:
    'The carbon engine is what calculates those figures — activity data and material masses multiplied by published emission factors, with every result naming the factor, its version and its reporting year.',
  custom_factors:
    'Custom factors let you import your own emission factor sets and maintain your own product carbon factor library, rather than working from the shared one.',
  sustainability_reports:
    'Sustainability reports produce the twelve-section completion document from what you recorded — frozen into a snapshot, so a client re-opening it next year sees the numbers they were shown.',
  evidence_pack:
    'The evidence pack is the operational handover: diary, crew, photographs, destination records and waste paperwork, with the sections you choose stored on the document so a regeneration reproduces it.',
  client_signoff:
    'Client sign-off captures a signature on site against what was being signed for, and keeps both the signature and that snapshot. A later amendment is a new sign-off; neither is ever edited.',
  client_reporting:
    'Client-level reporting rolls every project you ran for one client into a single period report, following a client through a name change or a placeholder that later signed up.',
  variations:
    'Variations price extra works off your rate cards, record who on the client side asked for them, and feed approved ones into project revenue and the invoice.',
  scheduling:
    'Scheduling puts named people, subcontractor crews and vehicles on a day, a week or a month, and names the clash at the moment you create it rather than on Monday.',
  compliance_tracking:
    'Compliance tracking keeps subcontractor requirements and certificates current with a 90/60/30/14/7 renewal ladder and optional enforcement.',
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
  storage_gb: 'gigabytes of file storage',
  evidence_uploads_per_month: 'evidence uploads this month',
  factor_sets: 'imported factor sets',
  artifact_retention_days: 'completed-project artifact retention',
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
