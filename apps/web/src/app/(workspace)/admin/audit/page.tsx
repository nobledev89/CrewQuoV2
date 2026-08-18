'use client';

import type { AdminPlatformAudit } from '@crewquo/shared';
import { EmptyState, PageHeader, Section, Stack, Table } from '@crewquo/ui';
import { api } from '@/api/client';
import { useAuth } from '@/auth/AuthProvider';
import { AdminGate } from '@/components/admin/AdminGate';
import { Shell } from '@/components/Shell';
import { formatDateTime, titleCase } from '@/lib/format';
import { useAsyncData } from '@/lib/useAsyncData';

export default function AdminAuditPage() { return <Shell><AdminGate title="Platform audit"><Audit /></AdminGate></Shell>; }
function Audit() {
  const { session } = useAuth();
  const audit = useAsyncData<AdminPlatformAudit[]>(session ? () => api.adminPlatformAudit(session.accessToken).then((r) => r.data) : null, [session?.accessToken]);
  return <Stack><PageHeader eyebrow="CrewQuo Platform" title="Platform audit" description="Append-only evidence for platform settings, access and user-security actions." />
    <Section className="cq-section--table">{audit.loading ? <p className="cq-muted">Loading audit…</p> : audit.error ? <EmptyState title="Audit unavailable">{audit.error}</EmptyState> : audit.data?.length ? (
      <Table label="Platform audit trail" compact><thead><tr><th>When</th><th>Actor</th><th>Action</th><th>Subject</th><th>Description</th></tr></thead><tbody>{audit.data.map((event) => (
        <tr key={event.id}><td>{formatDateTime(event.createdAt)}</td><td>{event.actorName ?? 'Bootstrap'}<div className="cq-muted">{event.actorEmail}</div></td><td>{titleCase(event.action)}</td><td>{titleCase(event.entityType)}</td><td>{event.description ?? '—'}</td></tr>
      ))}</tbody></Table>
    ) : <EmptyState title="No platform actions yet">The first settings or access change will appear here.</EmptyState>}</Section>
  </Stack>;
}

