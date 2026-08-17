'use client';

import { useState } from 'react';
import type { MemberView, MembershipRole } from '@crewquo/shared';
import { MEMBERSHIP_ROLES } from '@crewquo/shared';
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
  Select,
  Stack,
  Table,
} from '@crewquo/ui';
import { Shell } from '@/components/Shell';
import { api, ApiError } from '@/api/client';
import { useAuth, useSessionCtx } from '@/auth/AuthProvider';
import { useAsyncList } from '@/lib/useAsyncList';
import { useEntitlements } from '@/lib/useEntitlements';
import { InviteLink } from '@/components/InviteLink';
import { LimitReached } from '@/components/FeatureLock';
import { formatUsage, titleCase } from '@/lib/format';

/**
 * Members of the active company (§3.1). A membership role governs what someone may
 * do *inside this company*; whether the company is a client or a provider on a given
 * piece of work comes from the engagement, never from the role. That distinction is
 * stated here because it is the single most misunderstood part of the model.
 *
 * Inviting, re-roling and removing are all OWNER/ADMIN; inviting meters against
 * `internal_seats`. Two refusals are shown rather than hidden, because both are
 * about lock-out and a disabled control with no reason reads as a bug: an admin
 * may not change or remove an owner, and the last active owner may not be demoted,
 * suspended or removed at all.
 */
export default function MembersPage() {
  return (
    <Shell>
      <Members />
    </Shell>
  );
}

const ROLE_HELP: Record<MembershipRole, string> = {
  OWNER: 'Full control, including company settings and billing.',
  ADMIN: 'Manages people, rates, projects and approvals.',
  MANAGER: 'Manages projects, rates and approvals; cannot invite members.',
  MEMBER: 'Logs their own time and expenses.',
};

function Members() {
  const ctx = useSessionCtx();
  const { activeMembership, session } = useAuth();
  const ent = useEntitlements();
  const canInvite = activeMembership?.role === 'OWNER' || activeMembership?.role === 'ADMIN';

  const list = useAsyncList<MemberView>(
    ctx ? () => api.listMembers(ctx.accessToken, ctx.companyId).then((r) => r.data) : null,
    [ctx?.companyId]
  );

  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<MembershipRole>('MEMBER');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [invite, setInvite] = useState<{ token: string; email: string } | null>(null);

  const usage = ent.usage('internal_seats');
  const atLimit = ent.atLimit('internal_seats');
  // The same count the API guards on: a company must keep one active owner.
  const activeOwners = list.items.filter((m) => m.role === 'OWNER' && m.status === 'ACTIVE').length;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!ctx) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.inviteMember(ctx.accessToken, ctx.companyId, {
        email: email.trim(),
        role,
      });
      setInvite({ token: res.inviteToken, email: email.trim() });
      setEmail('');
      setOpen(false);
      list.reload();
      ent.reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not send the invitation');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Stack>
      <PageHeader
        eyebrow="Company"
        title="Members"
        description="People who work inside this company. Their role sets what they can do here."
        actions={
          canInvite && !open ? (
            <Button
              size="sm"
              onClick={() => setOpen(true)}
              disabled={atLimit}
              title={atLimit ? 'You are using every seat on your plan' : undefined}
            >
              Invite member
            </Button>
          ) : null
        }
      />

      {!canInvite ? (
        <Notice>
          Only an owner or admin can invite members. You can see the current team below.
        </Notice>
      ) : null}

      {atLimit && usage && usage.value !== null ? (
        <LimitReached limit="internal_seats" used={usage.used} value={usage.value} />
      ) : null}

      {invite ? (
        <InviteLink token={invite.token} email={invite.email} onDismiss={() => setInvite(null)} />
      ) : null}

      {open ? (
        <Section title="Invite a member" description="They join this company at the role you choose.">
          <form onSubmit={submit} className="cq-stack" aria-busy={busy}>
            <div className="cq-form-grid">
              <Field label="Email address">
                <Input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  spellCheck={false}
                  required
                  autoFocus
                />
              </Field>
              <Field label="Role" hint={ROLE_HELP[role]}>
                <Select value={role} onChange={(e) => setRole(e.target.value as MembershipRole)}>
                  {MEMBERSHIP_ROLES.map((r) => (
                    <option key={r} value={r}>
                      {titleCase(r)}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            <ErrorText>{error}</ErrorText>
            <Row>
              <Button type="submit" disabled={busy || !email.trim()}>
                {busy ? 'Inviting…' : 'Create invitation'}
              </Button>
              <Button variant="secondary" onClick={() => setOpen(false)} disabled={busy}>
                Cancel
              </Button>
            </Row>
          </form>
        </Section>
      ) : null}

      <Section
        title="Team"
        description={
          usage
            ? `Using ${formatUsage(usage.used, usage.value)} seats on your plan. Suspending keeps the seat; removing frees it.`
            : 'Suspending keeps the seat; removing frees it.'
        }
        className="cq-section--table"
      >
        <ErrorText>{list.error}</ErrorText>
        {list.loading ? (
          <p className="cq-muted">Loading members…</p>
        ) : list.items.length === 0 ? (
          <EmptyState title="No members listed">
            This company has no membership rows, which should not happen while you are signed
            in to it. Reload, and report it if it persists.
          </EmptyState>
        ) : (
          <Table label="Company members">
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Email</th>
                <th scope="col">Role</th>
                <th scope="col">Status</th>
                <th scope="col">
                  <span className="cq-table__actions">Manage</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {list.items.map((m) => (
                <MemberRow
                  key={m.membershipId}
                  member={m}
                  isSelf={m.userId === session?.user.id}
                  actorRole={activeMembership?.role ?? 'MEMBER'}
                  activeOwners={activeOwners}
                  onChanged={() => {
                    list.reload();
                    ent.reload();
                  }}
                />
              ))}
            </tbody>
          </Table>
        )}
      </Section>
    </Stack>
  );
}

/**
 * One member row and its two management actions.
 *
 * The refusals are computed here as well as enforced server-side — not to trust
 * the client, but so the reason appears *before* the click. `activeOwners` is
 * counted from the list the table is already showing, which is the same set the
 * API counts.
 */
function MemberRow({
  member,
  isSelf,
  actorRole,
  activeOwners,
  onChanged,
}: {
  member: MemberView;
  isSelf: boolean;
  actorRole: MembershipRole;
  activeOwners: number;
  onChanged: () => void;
}) {
  const ctx = useSessionCtx();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  const canManageMembers = actorRole === 'OWNER' || actorRole === 'ADMIN';
  const isLastActiveOwner =
    member.role === 'OWNER' && member.status === 'ACTIVE' && activeOwners <= 1;
  const adminVsOwner = actorRole === 'ADMIN' && member.role === 'OWNER';

  const refusal = !canManageMembers
    ? 'Only an owner or admin can manage members.'
    : adminVsOwner
      ? 'An admin cannot change an owner’s membership.'
      : isLastActiveOwner
        ? 'This is the only active owner — promote someone else first.'
        : null;

  async function run(action: () => Promise<unknown>) {
    if (!ctx) return;
    setBusy(true);
    setError(null);
    try {
      await action();
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not update this member');
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  }

  // An admin may not mint an owner, so OWNER is absent from their choices rather
  // than offered and then refused.
  const assignableRoles = MEMBERSHIP_ROLES.filter((r) => r !== 'OWNER' || actorRole === 'OWNER');

  return (
    <tr>
      <td className="cq-table__primary">
        {member.name}
        {isSelf ? (
          <>
            {' '}
            <Badge tone="neutral">You</Badge>
          </>
        ) : null}
        {error ? <ErrorText>{error}</ErrorText> : null}
      </td>
      <td>{member.email}</td>
      <td>
        {refusal ? (
          titleCase(member.role)
        ) : (
          <Select
            value={member.role}
            aria-label={`Role for ${member.name}`}
            disabled={busy}
            onChange={(e) =>
              void run(() =>
                api.updateMember(ctx!.accessToken, ctx!.companyId, member.membershipId, {
                  role: e.target.value as MembershipRole,
                })
              )
            }
          >
            {assignableRoles.map((r) => (
              <option key={r} value={r}>
                {titleCase(r)}
              </option>
            ))}
          </Select>
        )}
      </td>
      <td>
        {member.status === 'ACTIVE' ? (
          <Badge tone="success">Active</Badge>
        ) : member.status === 'INVITED' ? (
          <Badge tone="warning">Invited</Badge>
        ) : (
          <Badge tone="neutral">Suspended</Badge>
        )}
      </td>
      <td className="cq-table__actions">
        {refusal ? (
          <span className="cq-muted" title={refusal}>
            {isLastActiveOwner ? 'Only owner' : adminVsOwner ? 'Owner' : '—'}
          </span>
        ) : confirming ? (
          <Row>
            <Button
              size="sm"
              variant="danger"
              disabled={busy}
              onClick={() =>
                void run(() =>
                  api.removeMember(ctx!.accessToken, ctx!.companyId, member.membershipId)
                )
              }
            >
              {busy ? 'Removing…' : isSelf ? 'Remove me' : 'Confirm remove'}
            </Button>
            <Button size="sm" variant="secondary" disabled={busy} onClick={() => setConfirming(false)}>
              Cancel
            </Button>
          </Row>
        ) : (
          <Row>
            {member.status === 'SUSPENDED' ? (
              <Button
                size="sm"
                variant="secondary"
                disabled={busy}
                onClick={() =>
                  void run(() =>
                    api.updateMember(ctx!.accessToken, ctx!.companyId, member.membershipId, {
                      status: 'ACTIVE',
                    })
                  )
                }
              >
                Restore
              </Button>
            ) : (
              <Button
                size="sm"
                variant="secondary"
                disabled={busy}
                title="Keeps their history and their seat; they cannot sign in to this company."
                onClick={() =>
                  void run(() =>
                    api.updateMember(ctx!.accessToken, ctx!.companyId, member.membershipId, {
                      status: 'SUSPENDED',
                    })
                  )
                }
              >
                Suspend
              </Button>
            )}
            <Button
              size="sm"
              variant="secondary"
              disabled={busy}
              title="Deletes the membership and frees the seat. Their logged work stays on the project."
              onClick={() => setConfirming(true)}
            >
              Remove
            </Button>
          </Row>
        )}
      </td>
    </tr>
  );
}
