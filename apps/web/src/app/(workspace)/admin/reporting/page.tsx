'use client';

import { useState } from 'react';
import type { AdminReporting } from '@crewquo/shared';
import { EmptyState, PageHeader, RecordHeader, Section, Select, Stack, Table } from '@crewquo/ui';
import { api } from '@/api/client';
import { useAuth } from '@/auth/AuthProvider';
import { AdminGate } from '@/components/admin/AdminGate';
import { Shell } from '@/components/Shell';
import { titleCase } from '@/lib/format';
import { useAsyncData } from '@/lib/useAsyncData';

export default function AdminReportingPage() {
  return <Shell><AdminGate title="Reporting"><Reporting /></AdminGate></Shell>;
}

function Reporting() {
  const { session } = useAuth();
  const [days, setDays] = useState(30);
  const report = useAsyncData<AdminReporting>(
    session ? () => api.adminReporting(session.accessToken, days) : null,
    [session?.accessToken, days]
  );
  if (report.loading) return <p className="cq-muted">Loading platform reporting…</p>;
  if (report.error || !report.data) return <EmptyState title="Reporting unavailable">{report.error ?? 'No report was returned.'}</EmptyState>;
  const data = report.data;
  const newUsers = data.signupsByDay.reduce((sum, row) => sum + row.count, 0);
  const newCompanies = data.companiesByDay.reduce((sum, row) => sum + row.count, 0);
  return (
    <Stack>
      <PageHeader eyebrow="CrewQuo Platform" title="Reporting" description="Platform adoption and workflow volume. Currency totals stay separate until the money boundary can normalize them." actions={
        <Select value={days} onChange={(event) => setDays(Number(event.target.value))} aria-label="Reporting period">
          <option value={7}>Last 7 days</option><option value={30}>Last 30 days</option><option value={90}>Last 90 days</option><option value={365}>Last year</option>
        </Select>
      } />
      <RecordHeader figures={[
        { label: 'New users', value: newUsers, note: `Last ${days} days` },
        { label: 'New companies', value: newCompanies, note: `Last ${days} days` },
        { label: 'Projects created', value: data.workflow.projects },
        { label: 'Time logs', value: data.workflow.timeLogs, note: `${data.workflow.submittedTimeLogs} submitted` },
        { label: 'Invoices', value: data.workflow.invoices, note: `${data.workflow.issuedInvoices} issued` },
      ]} />
      <Section title="Acquisition by day" className="cq-section--table">
        <Table label="Daily platform acquisition" compact><thead><tr><th>Date</th><th className="cq-numeric">Users</th><th className="cq-numeric">Companies</th></tr></thead><tbody>
          {mergeDays(data).map((row) => <tr key={row.day}><td>{row.day}</td><td className="cq-numeric">{row.users}</td><td className="cq-numeric">{row.companies}</td></tr>)}
        </tbody></Table>
      </Section>
      <div className="cq-two-col">
        <Section title="Companies by plan" className="cq-section--table"><Distribution label="Plan distribution" rows={data.planDistribution} /></Section>
        <Section title="Subscriptions by status" className="cq-section--table"><Distribution label="Subscription distribution" rows={data.subscriptionDistribution} /></Section>
      </div>
    </Stack>
  );
}

function Distribution({ label, rows }: { label: string; rows: { key: string; count: number }[] }) {
  return <Table label={label} compact><thead><tr><th>Type</th><th className="cq-numeric">Companies</th></tr></thead><tbody>
    {rows.map((row) => <tr key={row.key}><td>{titleCase(row.key)}</td><td className="cq-numeric">{row.count}</td></tr>)}
  </tbody></Table>;
}

function mergeDays(data: AdminReporting) {
  const rows = new Map<string, { day: string; users: number; companies: number }>();
  data.signupsByDay.forEach((row) => rows.set(row.day, { day: row.day, users: row.count, companies: 0 }));
  data.companiesByDay.forEach((row) => {
    const current = rows.get(row.day) ?? { day: row.day, users: 0, companies: 0 };
    current.companies = row.count; rows.set(row.day, current);
  });
  return [...rows.values()].sort((a, b) => b.day.localeCompare(a.day));
}

