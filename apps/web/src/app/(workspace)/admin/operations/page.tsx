'use client';

import { useState } from 'react';
import type { AdminCompanyCreationRequest, AdminOperations } from '@crewquo/shared';
import { Badge, Button, EmptyState, ErrorText, Input, PageHeader, Section, Stack, Table } from '@crewquo/ui';
import { api, ApiError } from '@/api/client';
import { useAuth } from '@/auth/AuthProvider';
import { AdminGate } from '@/components/admin/AdminGate';
import { Shell } from '@/components/Shell';
import { formatDate, formatDateTime, titleCase } from '@/lib/format';
import { useAsyncData } from '@/lib/useAsyncData';

export default function AdminOperationsPage() { return <Shell><AdminGate title="Operations"><Operations /></AdminGate></Shell>; }

function Operations() {
  const { session } = useAuth();
  const operations = useAsyncData<AdminOperations>(session ? () => api.adminOperations(session.accessToken) : null, [session?.accessToken]);
  if (operations.loading && !operations.data) return <p className="cq-muted">Loading operations…</p>;
  if (operations.error || !operations.data) return <EmptyState title="Operations unavailable">{operations.error ?? 'No operations data returned.'}</EmptyState>;
  const data = operations.data;
  return <Stack>
    <PageHeader eyebrow="CrewQuo Platform" title="Operations" description="Delivery health, company-creation decisions, pending invitations, expiring grants and recent administrative actions." />
    <Section title="Service health"><div className="cq-kpi-grid">{data.services.map((service) => (
      <div className="cq-kpi" key={service.name}><span className="cq-overline">{service.name}</span><Badge tone={service.status === 'HEALTHY' ? 'success' : service.status === 'ATTENTION' ? 'warning' : 'neutral'}>{titleCase(service.status)}</Badge><span className="cq-muted">{service.detail}</span></div>
    ))}</div></Section>
    <Section title="Durable delivery"><div className="cq-kpi-grid">
      <div className="cq-kpi"><span className="cq-overline">Outbox ready</span><strong>{data.delivery.pendingOutbox}</strong><span className="cq-muted">{data.delivery.processingOutbox} processing</span></div>
      <div className="cq-kpi"><span className="cq-overline">Webhooks ready</span><strong>{data.delivery.receivedWebhooks}</strong><span className="cq-muted">{data.delivery.processingWebhooks} processing</span></div>
      <div className="cq-kpi"><span className="cq-overline">Dead letters</span><strong>{data.delivery.deadOutbox + data.delivery.deadWebhooks}</strong><span className="cq-muted">Outbox and webhook failures</span></div>
    </div></Section>
    {/*
      * A second queue, shown separately because it drains separately. The outbox
      * can be empty and healthy while every email in the system is failing — the
      * channel send is claimed, retried and failed on its own loop.
      *
      * Skipped is given equal billing with sent deliberately: a skip is a
      * recorded non-send, not a quiet success, and a climbing skip count is
      * almost always a misconfiguration rather than a user preference.
      */}
    <Section title="Notification delivery" description="Email and push. In-product delivery is the inbox row itself and never queues."><div className="cq-kpi-grid">
      <div className="cq-kpi"><span className="cq-overline">Queued</span><strong>{data.notifications.pending}</strong><span className="cq-muted">Waiting on quiet hours, a digest window or a retry</span></div>
      <div className="cq-kpi"><span className="cq-overline">Sent (24h)</span><strong>{data.notifications.sentLastDay}</strong><span className="cq-muted">Accepted by the provider</span></div>
      <div className="cq-kpi"><span className="cq-overline">Skipped (24h)</span><strong>{data.notifications.skippedLastDay}</strong><span className="cq-muted">Deliberately not sent, with a recorded reason</span></div>
      <div className="cq-kpi"><span className="cq-overline">Failed</span><strong>{data.notifications.failed}</strong><span className="cq-muted">Out of retries</span></div>
    </div></Section>
    <DeadLetters rows={data.deadLetters} onChanged={operations.reload} />
    <CompanyCreationQueue />
    <Section title="Pending invitations" className="cq-section--table">{data.pendingInvites.length ? <Table label="Pending invitations" compact><thead><tr><th>Company</th><th>Kind</th><th>Recipient</th><th>Expires</th></tr></thead><tbody>
      {data.pendingInvites.map((invite) => <tr key={invite.id}><td>{invite.companyName}</td><td>{titleCase(invite.kind)}</td><td>{invite.email}</td><td>{formatDateTime(invite.expiresAt)}</td></tr>)}
    </tbody></Table> : <p className="cq-muted">No live pending invitations.</p>}</Section>
    <Section title="Expiring entitlement overrides" className="cq-section--table">{data.expiringOverrides.length ? <Table label="Expiring overrides" compact><thead><tr><th>Company</th><th>Override</th><th>Expires</th></tr></thead><tbody>
      {data.expiringOverrides.map((override) => <tr key={override.id}><td>{override.companyName}</td><td>{titleCase(override.subject)}</td><td>{formatDateTime(override.expiresAt)}</td></tr>)}
    </tbody></Table> : <p className="cq-muted">No overrides expire in the next 30 days.</p>}</Section>
  </Stack>;
}

function DeadLetters({ rows, onChanged }: {
  rows: AdminOperations['deadLetters'];
  onChanged: () => void;
}) {
  const { session } = useAuth();
  const [reason, setReason] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function replay(source: 'OUTBOX' | 'WEBHOOK', id: string) {
    if (!session || reason.trim().length < 3) {
      setError('Give a reason before replaying a failed delivery.');
      return;
    }
    setBusyId(id); setError(null);
    try {
      await api.adminReplayDelivery(session.accessToken, source, id, reason.trim());
      setReason('');
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not replay the delivery');
    } finally { setBusyId(null); }
  }

  return <Section title="Dead-letter queue" description="Terminal failures stay here until a Super Admin deliberately replays them." className="cq-section--table">
    {rows.length ? <>
      <div className="cq-table-toolbar"><Input value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Replay reason (required)" aria-label="Replay reason" maxLength={1000} /></div>
      <ErrorText>{error}</ErrorText>
      <Table label="Dead-letter deliveries" compact><thead><tr><th>Source</th><th>Kind</th><th>Attempts</th><th>Failure</th><th>Failed</th><th><span className="cq-table__actions">Action</span></th></tr></thead><tbody>
        {rows.map((row) => <tr key={`${row.source}:${row.id}`}><td>{titleCase(row.source)}</td><td>{row.kind}</td><td>{row.attempts}</td><td>{row.lastError ?? 'No error detail'}</td><td>{formatDateTime(row.failedAt)}</td><td className="cq-table__actions"><Button size="sm" variant="secondary" disabled={busyId === row.id || reason.trim().length < 3} onClick={() => void replay(row.source, row.id)}>Replay</Button></td></tr>)}
      </tbody></Table>
    </> : <p className="cq-muted">No dead-lettered deliveries.</p>}
  </Section>;
}

/**
 * The additional-company review queue (§3.1.1(3)).
 *
 * Until Gumroad lands there is no checkout arm, so **every** additional company
 * a customer asks for arrives here — this queue is the safeguard's only approval
 * path, not a rarely-used exception screen.
 *
 * The reviewer's actual job is the `Owns` column: somebody on their second
 * company is ordinary, somebody on their fifth with a name matching the previous
 * four is what the policy exists to catch. `Signals` carries the duplicate
 * registration warning, which routes to recovery rather than to a new tenant.
 */
function CompanyCreationQueue() {
  const { session } = useAuth();
  const requests = useAsyncData<{ data: AdminCompanyCreationRequest[] }>(
    session ? () => api.adminCompanyCreationRequests(session.accessToken) : null,
    [session?.accessToken]
  );
  const [busyId, setBusyId] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function decide(id: string, decision: 'approve' | 'reject') {
    if (!session) return;
    // A decision with no reason is indistinguishable from a mistake later, and
    // the API refuses it anyway — say so here rather than round-trip a 422.
    if (!reason.trim()) { setError('Give a reason — it is the only record of why.'); return; }
    setBusyId(id); setError(null);
    try {
      await api.adminDecideCompanyCreationRequest(session.accessToken, id, decision, reason.trim());
      setReason('');
      requests.reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not record the decision');
    } finally { setBusyId(null); }
  }

  const rows = requests.data?.data ?? [];
  const pending = rows.filter((r) => r.status === 'PENDING_REVIEW' || r.status === 'PENDING_CHECKOUT');

  return <Section
    title="Company creation requests"
    description="Every additional company a customer has asked for. One included company per identity is automatic; these are the rest."
    className="cq-section--table"
  >
    {requests.loading && !requests.data ? <p className="cq-muted">Loading requests…</p> : rows.length === 0 ? (
      <p className="cq-muted">No additional-company requests have been filed.</p>
    ) : <>
      {pending.length ? <div className="cq-form-grid">
        <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason for the decision (required)" maxLength={500} aria-label="Decision reason" />
      </div> : null}
      <ErrorText>{error}</ErrorText>
      <Table label="Company creation requests" compact><thead><tr>
        <th>Business</th><th>Requester</th><th>Owns</th><th>Signals</th><th>Status</th><th>Filed</th>
        <th><span className="cq-table__actions">Decision</span></th>
      </tr></thead><tbody>
        {rows.map((request) => <tr key={request.id}>
          <td className="cq-table__primary">{request.legalName}<span className="cq-muted"> · {request.country}{request.registrationId ? ` · ${request.registrationId}` : ''}</span></td>
          <td>{request.userName}<span className="cq-muted"> · {request.userEmail}</span></td>
          <td>{request.ownedCompanies}</td>
          <td>
            {request.emailVerified ? null : <Badge tone="warning">Unverified</Badge>}
            {request.duplicateWarning ? <Badge tone="danger">Duplicate identifier</Badge> : null}
            {request.emailVerified && !request.duplicateWarning ? <span className="cq-muted">—</span> : null}
          </td>
          <td>
            <Badge tone={request.status === 'APPROVED' || request.status === 'CONSUMED' ? 'success' : request.status === 'REJECTED' ? 'danger' : request.status === 'EXPIRED' ? 'neutral' : 'warning'}>
              {titleCase(request.status.replace('_', ' '))}
            </Badge>
            {request.decisionReason ? <div className="cq-muted">{request.decisionReason}</div> : null}
          </td>
          <td>{formatDate(request.createdAt)}</td>
          <td className="cq-table__actions">
            {request.status === 'PENDING_REVIEW' || request.status === 'PENDING_CHECKOUT' ? <>
              <Button size="sm" onClick={() => void decide(request.id, 'approve')} disabled={busyId === request.id}>Approve</Button>
              <Button size="sm" variant="secondary" onClick={() => void decide(request.id, 'reject')} disabled={busyId === request.id}>Reject</Button>
            </> : <span className="cq-muted">{request.decidedByName ?? '—'}</span>}
          </td>
        </tr>)}
      </tbody></Table>
    </>}
  </Section>;
}
