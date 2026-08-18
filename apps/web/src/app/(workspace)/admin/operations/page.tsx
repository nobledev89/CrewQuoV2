'use client';

import type { AdminOperations } from '@crewquo/shared';
import { Badge, EmptyState, PageHeader, Section, Stack, Table } from '@crewquo/ui';
import { api } from '@/api/client';
import { useAuth } from '@/auth/AuthProvider';
import { AdminGate } from '@/components/admin/AdminGate';
import { Shell } from '@/components/Shell';
import { formatDateTime, titleCase } from '@/lib/format';
import { useAsyncData } from '@/lib/useAsyncData';

export default function AdminOperationsPage() { return <Shell><AdminGate title="Operations"><Operations /></AdminGate></Shell>; }

function Operations() {
  const { session } = useAuth();
  const operations = useAsyncData<AdminOperations>(session ? () => api.adminOperations(session.accessToken) : null, [session?.accessToken]);
  if (operations.loading) return <p className="cq-muted">Loading operations…</p>;
  if (operations.error || !operations.data) return <EmptyState title="Operations unavailable">{operations.error ?? 'No operations data returned.'}</EmptyState>;
  const data = operations.data;
  return <Stack>
    <PageHeader eyebrow="CrewQuo Platform" title="Operations" description="Delivery health, pending invitations, expiring grants and recent administrative actions." />
    <Section title="Service health"><div className="cq-kpi-grid">{data.services.map((service) => (
      <div className="cq-kpi" key={service.name}><span className="cq-overline">{service.name}</span><Badge tone={service.status === 'HEALTHY' ? 'success' : service.status === 'ATTENTION' ? 'warning' : 'neutral'}>{titleCase(service.status)}</Badge><span className="cq-muted">{service.detail}</span></div>
    ))}</div></Section>
    <Section title="Pending invitations" className="cq-section--table">{data.pendingInvites.length ? <Table label="Pending invitations" compact><thead><tr><th>Company</th><th>Kind</th><th>Recipient</th><th>Expires</th></tr></thead><tbody>
      {data.pendingInvites.map((invite) => <tr key={invite.id}><td>{invite.companyName}</td><td>{titleCase(invite.kind)}</td><td>{invite.email}</td><td>{formatDateTime(invite.expiresAt)}</td></tr>)}
    </tbody></Table> : <p className="cq-muted">No live pending invitations.</p>}</Section>
    <Section title="Expiring entitlement overrides" className="cq-section--table">{data.expiringOverrides.length ? <Table label="Expiring overrides" compact><thead><tr><th>Company</th><th>Override</th><th>Expires</th></tr></thead><tbody>
      {data.expiringOverrides.map((override) => <tr key={override.id}><td>{override.companyName}</td><td>{titleCase(override.subject)}</td><td>{formatDateTime(override.expiresAt)}</td></tr>)}
    </tbody></Table> : <p className="cq-muted">No overrides expire in the next 30 days.</p>}</Section>
  </Stack>;
}
