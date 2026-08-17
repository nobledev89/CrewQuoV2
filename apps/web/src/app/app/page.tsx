'use client';

import Link from 'next/link';
import type { RateCardTemplateView, RateCardView, RoleCatalogView } from '@crewquo/shared';
import { Badge, PageHeader, Section, Stack } from '@crewquo/ui';
import { Shell } from '@/components/Shell';
import { api } from '@/api/client';
import { useAuth, useSessionCtx } from '@/auth/AuthProvider';
import { useAsyncList } from '@/lib/useAsyncList';

export default function OverviewPage() {
  return <Shell><Overview /></Shell>;
}

function Overview() {
  const { activeMembership } = useAuth();
  const ctx = useSessionCtx();
  const roles = useAsyncList<RoleCatalogView>(ctx ? () => api.listRoles(ctx.accessToken, ctx.companyId).then((response) => response.data) : null, [ctx?.companyId]);
  const cards = useAsyncList<RateCardView>(ctx ? () => api.listRateCards(ctx.accessToken, ctx.companyId).then((response) => response.data) : null, [ctx?.companyId]);
  const templates = useAsyncList<RateCardTemplateView>(ctx ? () => api.listTemplates(ctx.accessToken, ctx.companyId).then((response) => response.data) : null, [ctx?.companyId]);
  const loading = roles.loading || cards.loading || templates.loading;
  const payCards = cards.items.filter((card) => card.kind === 'PAY').length;
  const billCards = cards.items.filter((card) => card.kind === 'BILL').length;

  return (
    <Stack>
      <PageHeader eyebrow="Workspace overview" title={activeMembership?.companyName ?? 'Overview'} description="Monitor your rate catalog and keep the costing rules used across contractor operations ready for work." actions={<Badge tone="success">{activeMembership?.role ? formatRole(activeMembership.role) : 'Active'}</Badge>} />

      <div className="cq-metrics" aria-label="Rate catalog summary">
        <Metric label="Roles" value={loading ? '—' : roles.items.length} context="Available for assignment" />
        <Metric label="Pay rates" value={loading ? '—' : payCards} context="Provider cost rules" />
        <Metric label="Bill rates" value={loading ? '—' : billCards} context="Client charge rules" />
        <Metric label="Templates" value={loading ? '—' : templates.items.length} context="Holiday adjustments" />
      </div>

      <div className="cq-dashboard-grid">
        <Section title="Rate catalog" description="The controls that determine contractor costs and client charges" className="cq-section--table">
          <ul className="cq-object-list">
            <CatalogRow href="/rates/roles" title="Roles" description="Job functions used to match rate cards" count={roles.items.length} loading={roles.loading} />
            <CatalogRow href="/rates/cards" title="Rate cards" description="Effective-dated pay and bill rates" count={cards.items.length} loading={cards.loading} />
            <CatalogRow href="/rates/templates" title="Templates" description="Holiday dates and pricing multipliers" count={templates.items.length} loading={templates.loading} />
            <CatalogRow href="/rates/resolve" title="Rate resolver" description="Validate the rate selected for a shift" count={null} loading={false} action="Test a rate" />
          </ul>
        </Section>

        <Section title="Catalog readiness" description="Configuration checks for reliable costing" className="cq-section--table">
          <ul className="cq-object-list">
            <ReadinessRow label="Roles configured" ready={roles.items.length > 0} loading={roles.loading} />
            <ReadinessRow label="Provider pay rates" ready={payCards > 0} loading={cards.loading} />
            <ReadinessRow label="Client bill rates" ready={billCards > 0} loading={cards.loading} />
          </ul>
        </Section>
      </div>
    </Stack>
  );
}

function Metric({ label, value, context }: { label: string; value: number | string; context: string }) {
  return <div className="cq-metric"><div className="cq-overline">{label}</div><div className="cq-metric__value">{value}</div><div className="cq-metric__context">{context}</div></div>;
}

function CatalogRow({ href, title, description, count, loading, action }: { href: string; title: string; description: string; count: number | null; loading: boolean; action?: string }) {
  return <li><Link href={href} className="cq-object-list__item"><span><span className="cq-object-list__title">{title}</span><span className="cq-object-list__meta">{description}</span></span><span className="cq-row" style={{ gap: 10 }}><span className="cq-muted cq-numeric">{action ?? (loading ? 'Loading…' : `${count} ${count === 1 ? 'item' : 'items'}`)}</span><span aria-hidden="true">›</span></span></Link></li>;
}

function ReadinessRow({ label, ready, loading }: { label: string; ready: boolean; loading: boolean }) {
  return <li className="cq-object-list__item"><span className="cq-object-list__title">{label}</span>{loading ? <span className="cq-muted">Checking…</span> : <Badge tone={ready ? 'success' : 'warning'}>{ready ? 'Ready' : 'Needs setup'}</Badge>}</li>;
}

function formatRole(role: string): string {
  return role.toLowerCase().replace(/(^|_)(\w)/g, (_, separator: string, letter: string) => `${separator ? ' ' : ''}${letter.toUpperCase()}`);
}
