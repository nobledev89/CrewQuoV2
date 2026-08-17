'use client';

import { useState } from 'react';
import type { ProviderView } from '@crewquo/shared';
import {
  Badge,
  Button,
  EmptyState,
  ErrorText,
  Field,
  Input,
  Notice,
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
import { LimitReached } from '@/components/FeatureLock';
import { formatUsage } from '@/lib/format';

/**
 * Subcontractors — the client side of my engagements, and the add-and-invite flow.
 *
 * `POST /v1/providers` does four things atomically: creates a placeholder company to
 * stand in for the subcontractor, opens the engagement, issues an ENGAGEMENT invite,
 * and returns the token. It is gated on `operates_downstream` and metered against
 * `active_subcontractors` — the product's only metering axis (§5B) — so this screen
 * shows the allowance next to the button rather than letting people discover the cap
 * by hitting it.
 */
export default function ProvidersPage() {
  return (
    <Shell>
      <Providers />
    </Shell>
  );
}

function Providers() {
  const ctx = useSessionCtx();
  const { activeMembership } = useAuth();
  const ent = useEntitlements();
  const canManage =
    activeMembership?.role === 'OWNER' ||
    activeMembership?.role === 'ADMIN' ||
    activeMembership?.role === 'MANAGER';

  const list = useAsyncList<ProviderView>(
    ctx ? () => api.listProviders(ctx.accessToken, ctx.companyId).then((r) => r.data) : null,
    [ctx?.companyId]
  );

  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [invite, setInvite] = useState<{ token: string; email: string } | null>(null);

  const usage = ent.usage('active_subcontractors');
  const atLimit = ent.atLimit('active_subcontractors');
  const noDownstream = ent.data !== null && !ent.data.operatesDownstream;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!ctx) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.createProvider(ctx.accessToken, ctx.companyId, {
        name: name.trim(),
        email: email.trim(),
      });
      setInvite({ token: res.inviteToken, email: email.trim() });
      setName('');
      setEmail('');
      setOpen(false);
      list.reload();
      ent.reload(); // the meter just moved
    } catch (err) {
      const feature = refusedFeature(err);
      setError(
        feature === 'operates_downstream'
          ? 'Your plan cannot add subcontractors. See plan & usage for what unlocks it.'
          : err instanceof ApiError
            ? err.message
            : 'Could not add the subcontractor'
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Stack>
      <PageHeader
        eyebrow="Network"
        title="Subcontractors"
        description="The companies you engage to deliver work. Adding one invites them and opens the engagement."
        actions={
          canManage && !open ? (
            <Button
              size="sm"
              onClick={() => setOpen(true)}
              disabled={noDownstream || atLimit}
              title={
                noDownstream
                  ? 'Your plan cannot add subcontractors'
                  : atLimit
                    ? 'You are at your plan limit'
                    : undefined
              }
            >
              Add subcontractor
            </Button>
          ) : null
        }
      />

      {noDownstream ? (
        <Notice>
          <strong>This plan cannot hire.</strong> Adding subcontractors needs a plan with
          downstream operation enabled — see <a href="/plan">plan &amp; usage</a>. You can
          still be hired by others and log work for them.
        </Notice>
      ) : null}

      {atLimit && usage && usage.value !== null ? (
        <LimitReached limit="active_subcontractors" used={usage.used} value={usage.value} />
      ) : null}

      {invite ? (
        <InviteLink
          token={invite.token}
          email={invite.email}
          onDismiss={() => setInvite(null)}
        />
      ) : null}

      {open ? (
        <Section
          title="Add a subcontractor"
          description="They do not need a CrewQuo account yet — we create a placeholder and merge it into their real company when they accept."
        >
          <form onSubmit={submit} className="cq-stack" aria-busy={busy}>
            <div className="cq-form-grid">
              <Field label="Company name">
                <Input value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
              </Field>
              <Field label="Contact email" hint="The invitation can only be accepted by this address.">
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
        title="Your subcontractors"
        description={
          usage
            ? `Using ${formatUsage(usage.used, usage.value)} of your plan's allowance.`
            : undefined
        }
        className="cq-section--table"
      >
        <ErrorText>{list.error}</ErrorText>
        {list.loading ? (
          <p className="cq-muted">Loading subcontractors…</p>
        ) : list.items.length === 0 ? (
          <EmptyState title="No subcontractors yet">
            Add one to open an engagement, then assign them to a project so their crew can log
            time against it.
          </EmptyState>
        ) : (
          <Table label="Subcontractors">
            <thead>
              <tr>
                <th scope="col">Company</th>
                <th scope="col">Currency</th>
                <th scope="col">Status</th>
                <th scope="col">On CrewQuo</th>
              </tr>
            </thead>
            <tbody>
              {list.items.map((p) => (
                <tr key={p.engagementId}>
                  <td className="cq-table__primary">{p.name}</td>
                  <td>{p.currency}</td>
                  <td>
                    <EngagementStatusBadge status={p.status} />
                  </td>
                  <td>
                    {/*
                      Derived from the engagement status, NOT from `isPlaceholder`.
                      Accepting an invite without already owning a company *claims* the
                      placeholder — it becomes the invitee's real company but the
                      `is_placeholder` flag is never cleared, so that field stays true
                      for a subcontractor who has plainly joined. The edge going ACTIVE
                      is the accurate signal that someone accepted.
                    */}
                    {p.status === 'PENDING' ? (
                      <Badge tone="warning">Invitation pending</Badge>
                    ) : (
                      <Badge tone="success">Joined</Badge>
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
