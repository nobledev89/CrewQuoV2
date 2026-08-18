'use client';

import Link from 'next/link';
import type { AdminDashboard } from '@crewquo/shared';
import { Badge, EmptyState, PageHeader, RecordHeader, Section, Stack, Table } from '@crewquo/ui';
import { api } from '@/api/client';
import { useAuth } from '@/auth/AuthProvider';
import { AdminGate } from '@/components/admin/AdminGate';
import { Shell } from '@/components/Shell';
import { formatDateTime, titleCase } from '@/lib/format';
import { useAsyncData } from '@/lib/useAsyncData';

export default function PlatformDashboardPage() {
  return <Shell><AdminGate title="Platform dashboard"><PlatformDashboard /></AdminGate></Shell>;
}

function PlatformDashboard() {
  const { session } = useAuth();
  const dashboard = useAsyncData<AdminDashboard>(
    session ? () => api.adminDashboard(session.accessToken) : null,
    [session?.accessToken]
  );

  if (dashboard.loading) return <p className="cq-muted" role="status">Loading platform dashboard…</p>;
  if (dashboard.error || !dashboard.data) {
    return <EmptyState title="Dashboard unavailable">{dashboard.error ?? 'No dashboard data was returned.'}</EmptyState>;
  }
  const data = dashboard.data;
  const attentionTotal = Object.values(data.attention).reduce((sum, value) => sum + value, 0);

  return (
    <Stack>
      <PageHeader
        eyebrow="CrewQuo Platform"
        title="Platform dashboard"
        description="Users, companies, subscriptions, product activity and operational attention across CrewQuo."
      />
      <RecordHeader figures={[
        { label: 'Users', value: data.totals.users, note: `${data.totals.verifiedUsers} verified` },
        { label: 'Companies', value: data.totals.companies, note: `${data.totals.placeholders} open placeholders` },
        { label: 'Paid companies', value: data.totals.paidCompanies, note: `${data.totals.trialingCompanies} trialing` },
        { label: 'Active projects', value: data.totals.activeProjects, note: `${data.totals.pendingWork} work items waiting` },
        { label: 'Needs attention', value: attentionTotal, note: 'Across billing, access and overrides' },
      ]} />

      <Section title="Needs attention" description="Every count links to the platform area where it can be investigated.">
        <div className="cq-kpi-grid">
          <AttentionLink href="/admin/operations" label="Pending invitations" value={data.attention.pendingInvites} />
          <AttentionLink href="/admin/companies" label="Past-due subscriptions" value={data.attention.pastDueSubscriptions} />
          <AttentionLink href="/admin/companies" label="Trials expiring in 14 days" value={data.attention.trialsExpiringSoon} />
          <AttentionLink href="/admin/operations" label="Overrides expiring in 14 days" value={data.attention.overridesExpiringSoon} />
        </div>
      </Section>

      <Section title="Plan distribution" className="cq-section--table">
        <Table label="Companies by resolved plan" compact>
          <thead><tr><th>Plan</th><th className="cq-numeric">Companies</th></tr></thead>
          <tbody>{data.planDistribution.map((row) => (
            <tr key={row.key}><td className="cq-table__primary">{titleCase(row.key)}</td><td className="cq-numeric">{row.count}</td></tr>
          ))}</tbody>
        </Table>
      </Section>

      <Section title="Newest companies" actions={<Link href="/admin/companies">View all companies</Link>} className="cq-section--table">
        <Table label="Newest companies" compact>
          <thead><tr><th>Company</th><th>Plan</th><th>Members</th><th>Created</th></tr></thead>
          <tbody>{data.recentCompanies.map((company) => (
            <tr key={company.id}>
              <td className="cq-table__primary">{company.name}</td>
              <td><Badge tone={company.subscriptionStatus ? 'success' : 'neutral'}>{titleCase(company.planId)}</Badge></td>
              <td>{company.memberCount}</td>
              <td>{formatDateTime(company.createdAt)}</td>
            </tr>
          ))}</tbody>
        </Table>
      </Section>

      <Section title="Newest users" actions={<Link href="/admin/users">View all users</Link>} className="cq-section--table">
        <Table label="Newest users" compact>
          <thead><tr><th>User</th><th>Email</th><th>Access</th><th>Created</th></tr></thead>
          <tbody>{data.recentUsers.map((user) => (
            <tr key={user.id}>
              <td className="cq-table__primary">{user.name}</td><td>{user.email}</td>
              <td>{user.isSuperAdmin ? <Badge tone="accent">Super Admin</Badge> : 'Customer'}</td>
              <td>{formatDateTime(user.createdAt)}</td>
            </tr>
          ))}</tbody>
        </Table>
      </Section>
    </Stack>
  );
}

function AttentionLink({ href, label, value }: { href: string; label: string; value: number }) {
  return <Link href={href} className="cq-kpi"><span className="cq-overline">{label}</span><strong>{value}</strong><span className="cq-muted">Open queue →</span></Link>;
}

