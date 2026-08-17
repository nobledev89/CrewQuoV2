'use client';

import { useState } from 'react';
import type { ClientView } from '@crewquo/shared';
import {
  Badge,
  Button,
  EmptyState,
  ErrorText,
  Field,
  Input,
  PageHeader,
  Row,
  Section,
  Stack,
  Table,
} from '@crewquo/ui';
import { Shell } from '@/components/Shell';
import { api, ApiError, refusedFeature } from '@/api/client';
import { useAuth, useSessionCtx } from '@/auth/AuthProvider';
import { useAsyncList } from '@/lib/useAsyncList';
import { useEntitlements } from '@/lib/useEntitlements';
import { EngagementStatusBadge } from '@/components/Status';
import { InviteLink } from '@/components/InviteLink';
import { FeatureNotice, LimitReached } from '@/components/FeatureLock';
import { formatUsage } from '@/lib/format';

/**
 * Portal clients — the mirror of the subcontractors screen (§7).
 *
 * `POST /v1/clients` is gated on `client_portal` rather than `operates_downstream`:
 * being hired is something every plan may do, but only a plan that sells a portal has
 * somewhere to send the client. Metered against `clients`, and only real portal
 * logins count — placeholder clients are free (§5B), which is why a company can be
 * recorded here before anyone accepts.
 */
export default function ClientsPage() {
  return (
    <Shell>
      <Clients />
    </Shell>
  );
}

function Clients() {
  const ctx = useSessionCtx();
  const { activeMembership } = useAuth();
  const ent = useEntitlements();
  const canManage =
    activeMembership?.role === 'OWNER' ||
    activeMembership?.role === 'ADMIN' ||
    activeMembership?.role === 'MANAGER';

  const list = useAsyncList<ClientView>(
    ctx ? () => api.listClients(ctx.accessToken, ctx.companyId).then((r) => r.data) : null,
    [ctx?.companyId]
  );

  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [invite, setInvite] = useState<{ token: string; email: string } | null>(null);

  const hasPortal = ent.has('client_portal');
  const usage = ent.usage('clients');
  const atLimit = ent.atLimit('clients');

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!ctx) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.createClient(ctx.accessToken, ctx.companyId, {
        name: name.trim(),
        email: email.trim(),
      });
      setInvite({ token: res.inviteToken, email: email.trim() });
      setName('');
      setEmail('');
      setOpen(false);
      list.reload();
      ent.reload();
    } catch (err) {
      const feature = refusedFeature(err);
      setError(
        feature === 'client_portal'
          ? 'Your plan does not include the client portal, so there is nowhere to invite a client to.'
          : err instanceof ApiError
            ? err.message
            : 'Could not add the client'
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Stack>
      <PageHeader
        eyebrow="Network"
        title="Clients"
        description="Companies you deliver for. Inviting one gives them portal access to the projects you publish."
        actions={
          canManage && !open ? (
            <Button
              size="sm"
              onClick={() => setOpen(true)}
              disabled={!hasPortal || atLimit}
              title={
                !hasPortal
                  ? 'The client portal is not on your plan'
                  : atLimit
                    ? 'You are at your plan limit'
                    : undefined
              }
            >
              Add client
            </Button>
          ) : null
        }
      />

      {ent.data && !hasPortal ? <FeatureNotice feature="client_portal" /> : null}

      {atLimit && usage && usage.value !== null ? (
        <LimitReached limit="clients" used={usage.used} value={usage.value} />
      ) : null}

      {invite ? (
        <InviteLink token={invite.token} email={invite.email} onDismiss={() => setInvite(null)} />
      ) : null}

      {open ? (
        <Section
          title="Add a client"
          description="A placeholder company stands in for them until they accept, then it merges into their real company."
        >
          <form onSubmit={submit} className="cq-stack" aria-busy={busy}>
            <div className="cq-form-grid">
              <Field label="Client company name">
                <Input value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
              </Field>
              <Field label="Contact email" hint="Only this address can accept the invitation.">
                <Input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  spellCheck={false}
                  required
                />
              </Field>
            </div>
            <ErrorText>{error}</ErrorText>
            <Row>
              <Button type="submit" disabled={busy || !name.trim() || !email.trim()}>
                {busy ? 'Adding…' : 'Add and invite'}
              </Button>
              <Button variant="secondary" onClick={() => setOpen(false)} disabled={busy}>
                Cancel
              </Button>
            </Row>
          </form>
        </Section>
      ) : null}

      <Section
        title="Your clients"
        description={
          usage
            ? `Using ${formatUsage(usage.used, usage.value)} portal clients. Only clients who have accepted count toward the limit.`
            : undefined
        }
        className="cq-section--table"
      >
        <ErrorText>{list.error}</ErrorText>
        {list.loading ? (
          <p className="cq-muted">Loading clients…</p>
        ) : list.items.length === 0 ? (
          <EmptyState title="No clients yet">
            Add a client to give them read access to the projects you mark as client-visible,
            with their line items priced at your BILL rates.
          </EmptyState>
        ) : (
          <Table label="Clients">
            <thead>
              <tr>
                <th scope="col">Company</th>
                <th scope="col">Currency</th>
                <th scope="col">Status</th>
                <th scope="col">Portal access</th>
              </tr>
            </thead>
            <tbody>
              {list.items.map((c) => (
                <tr key={c.engagementId}>
                  <td className="cq-table__primary">{c.name}</td>
                  <td>{c.currency}</td>
                  <td>
                    <EngagementStatusBadge status={c.status} />
                  </td>
                  <td>
                    {/* Engagement status, not `isPlaceholder` — see the note on the
                        subcontractors screen: claiming a placeholder never clears that
                        flag, so it cannot mean "has not joined". */}
                    {c.status === 'PENDING' ? (
                      <Badge tone="warning">Invitation pending</Badge>
                    ) : (
                      <Badge tone="success">Active</Badge>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Section>
    </Stack>
  );
}
