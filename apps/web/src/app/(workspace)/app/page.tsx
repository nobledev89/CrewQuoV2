'use client';

import Link from 'next/link';
import type {
  ClientView,
  EngagementView,
  ExpenseView,
  PortalProjectView,
  ProjectView,
  RateCardTemplateView,
  RateCardView,
  RoleCatalogView,
  TimeLogView,
  WorkContext,
} from '@crewquo/shared';
import { Badge, EmptyState, PageHeader, Section, Stack } from '@crewquo/ui';
import { Shell } from '@/components/Shell';
import { api } from '@/api/client';
import { useAuth, useSessionCtx } from '@/auth/AuthProvider';
import { useAsyncList } from '@/lib/useAsyncList';
import { useAsyncData } from '@/lib/useAsyncData';
import { useEntitlements } from '@/lib/useEntitlements';
import { formatUsage, titleCase } from '@/lib/format';

/**
 * Overview — deliberately role-aware rather than one fixed dashboard.
 *
 * The same company can be a hirer, a subcontractor, and somebody's client all at once,
 * and which of those it *is* comes from its engagements, not from a user role (§3.2).
 * So the panels are driven by what the company actually has: work waiting for a
 * decision only appears if it hires, the log-work prompt only if it is assigned to
 * someone's project, the portal only if something is shared with it.
 */
export default function OverviewPage() {
  return (
    <Shell>
      <Overview />
    </Shell>
  );
}

function Overview() {
  const { activeMembership } = useAuth();
  const ctx = useSessionCtx();
  const ent = useEntitlements();

  const engagements = useAsyncList<EngagementView>(
    ctx ? () => api.listEngagements(ctx.accessToken, ctx.companyId).then((r) => r.data) : null,
    [ctx?.companyId]
  );
  const projects = useAsyncList<ProjectView>(
    ctx ? () => api.listProjects(ctx.accessToken, ctx.companyId).then((r) => r.data) : null,
    [ctx?.companyId]
  );
  const pendingTime = useAsyncList<TimeLogView>(
    ctx
      ? () =>
          api.listTimeLogs(ctx.accessToken, ctx.companyId, { status: 'SUBMITTED' }).then((r) => r.data)
      : null,
    [ctx?.companyId]
  );
  const pendingExpenses = useAsyncList<ExpenseView>(
    ctx
      ? () =>
          api.listExpenses(ctx.accessToken, ctx.companyId, { status: 'SUBMITTED' }).then((r) => r.data)
      : null,
    [ctx?.companyId]
  );
  const work = useAsyncData<WorkContext>(
    ctx ? () => api.workContext(ctx.accessToken, ctx.companyId) : null,
    [ctx?.companyId]
  );
  const portal = useAsyncList<PortalProjectView>(
    ctx ? () => api.portalProjects(ctx.accessToken, ctx.companyId).then((r) => r.data) : null,
    [ctx?.companyId]
  );
  const roles = useAsyncList<RoleCatalogView>(
    ctx ? () => api.listRoles(ctx.accessToken, ctx.companyId).then((r) => r.data) : null,
    [ctx?.companyId]
  );
  const cards = useAsyncList<RateCardView>(
    ctx ? () => api.listRateCards(ctx.accessToken, ctx.companyId).then((r) => r.data) : null,
    [ctx?.companyId]
  );
  const clients = useAsyncList<ClientView>(
    ctx ? () => api.listClients(ctx.accessToken, ctx.companyId).then((r) => r.data) : null,
    [ctx?.companyId]
  );
  const templates = useAsyncList<RateCardTemplateView>(
    ctx ? () => api.listTemplates(ctx.accessToken, ctx.companyId).then((r) => r.data) : null,
    [ctx?.companyId]
  );

  const companyId = ctx?.companyId;
  const hires = engagements.items.some((e) => e.side === 'client');
  const delivers = (work.data?.assignments.length ?? 0) > 0;
  const isSomeonesClient = portal.items.length > 0;

  // Only work we are the *client* on is ours to approve (§4).
  const clientEngagementIds = new Set(
    engagements.items.filter((e) => e.side === 'client').map((e) => e.id)
  );
  const toApprove =
    pendingTime.items.filter((l) => clientEngagementIds.has(l.engagementId)).length +
    pendingExpenses.items.filter((x) => clientEngagementIds.has(x.engagementId)).length;

  // Ours to submit: rows where we are the provider and nothing has been handed up yet.
  const mySubmitted = pendingTime.items.filter((l) => l.providerCompanyId === companyId).length;

  const payCards = cards.items.filter((c) => c.kind === 'PAY').length;
  const billCards = cards.items.filter((c) => c.kind === 'BILL').length;
  const activeProjects = projects.items.filter((p) => p.status === 'ACTIVE').length;
  const subUsage = ent.usage('active_subcontractors');

  const loading = engagements.loading || projects.loading || work.loading;
  const brandNew =
    !loading &&
    engagements.items.length === 0 &&
    projects.items.length === 0 &&
    !delivers &&
    !isSomeonesClient;

  return (
    <Stack>
      <PageHeader
        eyebrow="Workspace overview"
        title={activeMembership?.companyName ?? 'Overview'}
        description="What needs your attention, and what this company is set up to do."
        actions={
          <>
            {activeMembership ? <Badge tone="success">{titleCase(activeMembership.role)}</Badge> : null}
            {ent.data ? <Badge tone="accent">{titleCase(ent.data.planId)}</Badge> : null}
          </>
        }
      />

      {brandNew ? (
        <Section title="Get started" className="cq-section--table">
          <ul className="cq-object-list">
            <SetupRow
              href="/rates/roles"
              title="1. Add the roles you hire"
              description="Rate cards match on a role, so this comes first"
              done={roles.items.length > 0}
            />
            <SetupRow
              href="/rates/cards"
              title="2. Set your pay and bill rates"
              description="PAY is what you pay a subcontractor; BILL is what you charge a client"
              done={cards.items.length > 0}
            />
            <SetupRow
              href="/network/providers"
              title="3. Invite a subcontractor"
              description="They get a link, and the engagement opens when they accept"
              done={hires}
            />
            <SetupRow
              href="/projects"
              title="4. Create a project and assign them"
              description="Assignment is what lets their crew log time against it"
              done={projects.items.length > 0}
            />
          </ul>
        </Section>
      ) : null}

      <div className="cq-metrics" aria-label="Workspace summary">
        <Metric
          label="Awaiting your approval"
          value={loading ? '—' : toApprove}
          context={toApprove > 0 ? 'Time logs and expenses submitted to you' : 'Nothing waiting'}
        />
        <Metric
          label="Active projects"
          value={projects.loading ? '—' : activeProjects}
          context={`${projects.items.length} in total`}
        />
        <Metric
          label="Subcontractors"
          value={
            engagements.loading
              ? '—'
              : subUsage
                ? formatUsage(subUsage.used, subUsage.value)
                : engagements.items.filter((e) => e.side === 'client').length
          }
          context="Against your plan's allowance"
        />
        <Metric
          label="Rate cards"
          value={cards.loading ? '—' : cards.items.length}
          context={`${payCards} pay · ${billCards} bill`}
        />
      </div>

      <div className="cq-dashboard-grid">
        <Section
          title="Needs a decision"
          description="Work handed up to you that nobody has approved or rejected yet"
          className="cq-section--table"
        >
          {!hires ? (
            <EmptyState title="You have no subcontractors">
              Nothing can be submitted to you until you engage one.{' '}
              <Link href="/network/providers">Add a subcontractor</Link>.
            </EmptyState>
          ) : toApprove === 0 ? (
            <EmptyState title="Everything is decided">
              New submissions appear here as your subcontractors send them.
            </EmptyState>
          ) : (
            <ul className="cq-object-list">
              <ActionRow
                href="/review"
                title={`${toApprove} ${toApprove === 1 ? 'item' : 'items'} to review`}
                description="Approve or reject many at once, with filters by subcontractor and project"
                action="Open approvals"
              />
            </ul>
          )}
        </Section>

        <Section
          title="Your work"
          description="Projects other companies have assigned you to"
          className="cq-section--table"
        >
          {!delivers ? (
            <EmptyState title="Nobody has assigned you work">
              When a company you work for assigns you to one of their projects, you can log time
              against it here.
            </EmptyState>
          ) : (
            <ul className="cq-object-list">
              <ActionRow
                href="/work"
                title={`${work.data?.assignments.length} assigned ${work.data?.assignments.length === 1 ? 'project' : 'projects'}`}
                description={
                  mySubmitted > 0
                    ? `${mySubmitted} submitted and awaiting a decision`
                    : 'Log time and expenses, then submit them'
                }
                action="Log work"
              />
            </ul>
          )}
        </Section>

        <Section
          title="Shared with you"
          description="Work others are doing for you, as they have published it"
          className="cq-section--table"
        >
          {!isSomeonesClient ? (
            <EmptyState title="Nothing shared with you">
              A contractor you have hired can publish a project to their client portal, and it
              appears here.
            </EmptyState>
          ) : (
            <ul className="cq-object-list">
              <ActionRow
                href="/portal"
                title={`${portal.items.length} shared ${portal.items.length === 1 ? 'project' : 'projects'}`}
                description="Line items and totals at the rates agreed with you"
                action="Open portal"
              />
            </ul>
          )}
        </Section>

        <Section
          title="Setup checks"
          description="Configuration that costing depends on"
          className="cq-section--table"
        >
          <ul className="cq-object-list">
            <ReadinessRow
              label="Roles configured"
              ready={roles.items.length > 0}
              loading={roles.loading}
            />
            <ReadinessRow
              label="Pay rates for subcontractors"
              ready={payCards > 0}
              loading={cards.loading}
              irrelevant={!hires}
            />
            <ReadinessRow
              label="Bill rates for clients"
              ready={billCards > 0}
              loading={cards.loading}
              irrelevant={clients.items.length === 0}
            />
            {/*
              A company with templates but none elected as default has label rules that
              are silently ignored, which quietly mis-prices night and weekend work — so
              this is a real check, not a decoration.
            */}
            <ReadinessRow
              label="A default rate-label template"
              ready={templates.items.some((t) => t.isDefault)}
              loading={templates.loading}
              irrelevant={templates.items.length === 0}
              hint={
                templates.items.length > 0 && !templates.items.some((t) => t.isDefault)
                  ? 'Templates exist but none is the default, so their label rules are ignored'
                  : undefined
              }
            />
          </ul>
        </Section>
      </div>
    </Stack>
  );
}

function Metric({
  label,
  value,
  context,
}: {
  label: string;
  value: number | string;
  context: string;
}) {
  return (
    <div className="cq-metric">
      <div className="cq-overline">{label}</div>
      <div className="cq-metric__value">{value}</div>
      <div className="cq-metric__context">{context}</div>
    </div>
  );
}

function ActionRow({
  href,
  title,
  description,
  action,
}: {
  href: string;
  title: string;
  description: string;
  action: string;
}) {
  return (
    <li>
      <Link href={href} className="cq-object-list__item">
        <span>
          <span className="cq-object-list__title">{title}</span>
          <span className="cq-object-list__meta">{description}</span>
        </span>
        <span className="cq-row" style={{ gap: 10 }}>
          <span className="cq-muted">{action}</span>
          <span aria-hidden="true">›</span>
        </span>
      </Link>
    </li>
  );
}

function SetupRow({
  href,
  title,
  description,
  done,
}: {
  href: string;
  title: string;
  description: string;
  done: boolean;
}) {
  return (
    <li>
      <Link href={href} className="cq-object-list__item">
        <span>
          <span className="cq-object-list__title">{title}</span>
          <span className="cq-object-list__meta">{description}</span>
        </span>
        {done ? <Badge tone="success">Done</Badge> : <span aria-hidden="true">›</span>}
      </Link>
    </li>
  );
}

function ReadinessRow({
  label,
  ready,
  loading,
  irrelevant,
  hint,
}: {
  label: string;
  ready: boolean;
  loading: boolean;
  irrelevant?: boolean;
  hint?: string;
}) {
  return (
    <li className="cq-object-list__item">
      <span>
        <span className="cq-object-list__title">{label}</span>
        {hint ? <span className="cq-object-list__meta">{hint}</span> : null}
      </span>
      {loading ? (
        <span className="cq-muted">Checking…</span>
      ) : irrelevant ? (
        <span className="cq-muted">Not needed yet</span>
      ) : (
        <Badge tone={ready ? 'success' : 'warning'}>{ready ? 'Ready' : 'Needs setup'}</Badge>
      )}
    </li>
  );
}
