'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import type {
  ClientView,
  EngagementView,
  ExpenseView,
  PendingAssignmentView,
  PortalProjectView,
  ProjectView,
  RateCardTemplateView,
  RateCardView,
  RateProposalView,
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
import { landingForWorkspaceView, useWorkspace } from '@/workspaces/WorkspaceProvider';

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
  const router = useRouter();
  const { activeWorkspace, selectedView } = useWorkspace();

  useEffect(() => {
    if (selectedView && selectedView !== 'OPERATIONS') {
      router.replace(landingForWorkspaceView(selectedView));
    } else if (activeWorkspace?.views.length === 0) {
      router.replace('/profile');
    }
  }, [activeWorkspace, router, selectedView]);

  const choosingInitialView = Boolean(
    activeWorkspace && activeWorkspace.views.length > 0 && selectedView === null
  );
  const leavingOverview = Boolean(
    (selectedView && selectedView !== 'OPERATIONS') || activeWorkspace?.views.length === 0
  );

  return (
    <Shell>
      {choosingInitialView || leavingOverview ? (
        <div className="cq-centered-message" role="status">
          {choosingInitialView
            ? 'Opening your workspace…'
            : `Opening ${selectedView === 'CLIENT' ? 'client projects' : selectedView === 'SUBCONTRACTOR' ? 'your work' : 'account setup'}…`}
        </div>
      ) : (
        <Overview />
      )}
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
  /**
   * Two things this company has been *offered* and not answered (Phase 6 acceptance
   * rules). Both are the provider side of an edge, and both are decisions somebody
   * upstream is waiting on — so they belong on the overview rather than buried on a
   * screen you would only open if you already knew.
   */
  const pendingAssignments = useAsyncList<PendingAssignmentView>(
    ctx
      ? () => api.listPendingAssignments(ctx.accessToken, ctx.companyId).then((r) => r.data)
      : null,
    [ctx?.companyId]
  );
  const pendingSchedules = useAsyncList<RateProposalView>(
    ctx
      ? () => api.listRateProposals(ctx.accessToken, ctx.companyId).then((r) => r.data)
      : null,
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

  /**
   * Things somebody upstream is waiting on us for (Phase 6 acceptance rules).
   * `pendingEngagements` is the provider side only — a hiring company waiting on its
   * own subcontractor to accept has nothing to decide, so counting those here would
   * put an item in the reader's queue that they cannot action.
   */
  const pendingEngagements = engagements.items.filter(
    (e) => e.status === 'PENDING' && e.side === 'provider'
  );
  const decidedSchedules = pendingSchedules.items.filter(
    (p) => p.side === 'provider' && p.status === 'REJECTED'
  );
  const schedulesToDecide = pendingSchedules.items.filter(
    (p) => p.side === 'client' && p.status === 'SUBMITTED'
  );
  const offeredCount =
    pendingEngagements.length +
    pendingAssignments.items.length +
    decidedSchedules.length +
    schedulesToDecide.length;

  const payCards = cards.items.filter((c) => c.kind === 'PAY').length;
  const billCards = cards.items.filter((c) => c.kind === 'BILL').length;
  const activeProjects = projects.items.filter((p) => p.status === 'ACTIVE').length;
  const subUsage = ent.usage('active_subcontractors');
  /**
   * Whether rate cards are this company's business at all. `operatesDownstream` is
   * false and `rate_cards` is absent on the free plan, so a subcontractor on it can
   * neither hire nor price — offering either is offering a refusal (§5B).
   */
  const canHire = ent.data?.operatesDownstream ?? true;
  const canPriceWork = ent.has('rate_cards');

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

      {/*
        The headline figures follow what the company *is*, not one fixed set. A company
        that only ever sells labour has no subcontractors and no rate cards by design —
        its plan forbids both — so leading with "0 / 0 subcontractors" and "0 rate cards"
        reports the shape of somebody else's business as if it were four failures.
        Its own work goes first instead.
      */}
      <div className="cq-metrics" aria-label="Workspace summary">
        {delivers ? (
          <>
            <Metric
              label="Assigned to you"
              value={work.loading ? '—' : (work.data?.assignments.length ?? 0)}
              context="Projects you can log time against"
            />
            <Metric
              label="Awaiting a decision"
              value={pendingTime.loading ? '—' : mySubmitted}
              context={mySubmitted > 0 ? 'Submitted, with the company that hired you' : 'Nothing outstanding'}
            />
          </>
        ) : null}
        {hires ? (
          <>
            <Metric
              label="Awaiting your approval"
              value={loading ? '—' : toApprove}
              context={toApprove > 0 ? 'Time logs and expenses submitted to you' : 'Nothing waiting'}
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
          </>
        ) : null}
        {isSomeonesClient ? (
          <Metric
            label="Shared with you"
            value={portal.loading ? '—' : portal.items.length}
            context="Projects published to you by a contractor"
          />
        ) : null}
        <Metric
          label="Active projects"
          value={projects.loading ? '—' : activeProjects}
          context={`${projects.items.length} in total`}
        />
        {canPriceWork ? (
          <Metric
            label="Rate cards"
            value={cards.loading ? '—' : cards.items.length}
            context={`${payCards} pay · ${billCards} bill`}
          />
        ) : null}
      </div>

      <div className="cq-dashboard-grid">
        <Section
          title="Needs a decision"
          description="Work handed up to you that nobody has approved or rejected yet"
          className="cq-section--table"
        >
          {!hires ? (
            <EmptyState title="You have no subcontractors">
              {canHire ? (
                <>
                  Nothing can be submitted to you until you engage one.{' '}
                  <Link href="/network/providers">Add a subcontractor</Link>.
                </>
              ) : (
                <>
                  Your plan does not include engaging subcontractors, so nothing is
                  submitted to you for approval. <Link href="/plan">See what does</Link>.
                </>
              )}
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
          title="Offered to you"
          description="Decisions companies upstream are waiting on"
          className="cq-section--table"
        >
          {offeredCount === 0 ? (
            <EmptyState title="Nothing waiting on you">
              When a company adds you to a project, or decides on a rate schedule you sent,
              it shows up here.
            </EmptyState>
          ) : (
            <ul className="cq-object-list">
              {pendingEngagements.length > 0 ? (
                <ActionRow
                  href="/network/engagements"
                  title={`${pendingEngagements.length} ${pendingEngagements.length === 1 ? 'engagement' : 'engagements'} to accept`}
                  description="A company wants to hire you — accept before putting crew on site"
                  action="Review"
                />
              ) : null}
              {pendingAssignments.items.length > 0 ? (
                // `/work`, not `/projects`: a provider cannot read the hiring
                // company's project list at all — it is scoped to the owner.
                <ActionRow
                  href="/work"
                  title={`${pendingAssignments.items.length} project ${pendingAssignments.items.length === 1 ? 'assignment' : 'assignments'} to accept`}
                  description={pendingAssignments.items
                    .slice(0, 3)
                    .map((a) => a.projectName)
                    .join(', ')}
                  action="Open your work"
                />
              ) : null}
              {decidedSchedules.length > 0 ? (
                <ActionRow
                  href="/commercial"
                  title={`${decidedSchedules.length} rate ${decidedSchedules.length === 1 ? 'schedule' : 'schedules'} returned`}
                  description="A hiring company sent a schedule back with a reason"
                  action="Open agreements"
                />
              ) : null}
              {schedulesToDecide.length > 0 ? (
                <ActionRow
                  href="/commercial"
                  title={`${schedulesToDecide.length} rate ${schedulesToDecide.length === 1 ? 'schedule' : 'schedules'} awaiting your decision`}
                  description="A subcontractor has proposed what you pay them"
                  action="Open agreements"
                />
              ) : null}
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
              // Roles exist to match rate cards. Without that feature there is nothing
              // to match, so "needs setup" would be nagging about work that has no effect.
              irrelevant={!canPriceWork}
            />
            <ReadinessRow
              label="Pay rates for subcontractors"
              ready={payCards > 0}
              loading={cards.loading}
              irrelevant={!hires || !canPriceWork}
            />
            <ReadinessRow
              label="Bill rates for clients"
              ready={billCards > 0}
              loading={cards.loading}
              irrelevant={clients.items.length === 0 || !canPriceWork}
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
