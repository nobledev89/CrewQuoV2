'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import type { AcceptInviteResponse, InviteView } from '@crewquo/shared';
import { Badge, Button, ErrorText, Notice, Row } from '@crewquo/ui';
import { api, ApiError } from '@/api/client';
import { useAuth } from '@/auth/AuthProvider';
import { AuthPanel } from '@/components/AuthPanel';
import { useAsyncData } from '@/lib/useAsyncData';
import { formatDateTime, titleCase } from '@/lib/format';

/**
 * The public invite-accept page (§3.6, §7).
 *
 * `GET /v1/invites/:token` is public — the token *is* the capability — so the
 * invitation can be read before signing in. Accepting needs auth, and the API
 * matches the invite's email against the signed-in account, so someone holding a
 * link issued to a colleague cannot spend it.
 *
 * The interesting part is the merge outcome. For an ENGAGEMENT or CLIENT_PORTAL
 * invite the accepter has been standing behind a placeholder company, and accepting
 * either claims that placeholder or merges it into a company they already run (owner
 * decision, 2026-08-17: automatic, no prompt). `SKIPPED` is the case that must never
 * be glossed: the merge would have collided, so nothing was re-pointed and the
 * placeholder was claimed instead. The user is told, with the reason.
 */
export default function InviteAcceptPage() {
  const params = useParams<{ token: string }>();
  const token = typeof params.token === 'string' ? params.token : '';
  const router = useRouter();
  const { ready, session, companyId, setCompanyId, refreshMemberships } = useAuth();

  const invite = useAsyncData<InviteView>(
    token ? () => api.getInvite(token).then((r) => r.invite) : null,
    [token]
  );

  const [accepting, setAccepting] = useState(false);
  const [result, setResult] = useState<AcceptInviteResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const signInHref = `/login?next=${encodeURIComponent(`/invite/${token}`)}`;
  const registerHref = `/register?next=${encodeURIComponent(`/invite/${token}`)}`;

  async function accept() {
    if (!session) return;
    setAccepting(true);
    setError(null);
    try {
      // The active company is a *preference*, not a requirement: it tells the merge
      // which of the accepter's companies should claim the placeholder when they run
      // more than one.
      const res = await api.acceptInvite(session.accessToken, token, companyId);
      setResult(res);
      await refreshMemberships();
      setCompanyId(res.companyId);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not accept this invitation');
    } finally {
      setAccepting(false);
    }
  }

  if (invite.loading || !ready) {
    return (
      <AuthPanel title="Invitation" documentTitle="Invitation">
        <p className="cq-muted" role="status">
          Loading invitation…
        </p>
      </AuthPanel>
    );
  }

  if (invite.error || !invite.data) {
    return (
      <AuthPanel title="Invitation not found" documentTitle="Invitation">
        <div className="cq-stack">
          <Notice>
            {invite.error ??
              'This invitation link is not valid. Ask whoever invited you to send a new one.'}
          </Notice>
          <Link className="cq-muted" href="/login">
            Go to sign in
          </Link>
        </div>
      </AuthPanel>
    );
  }

  const data = invite.data;
  const expired = new Date(data.expiresAt).getTime() < Date.now();
  const spent = data.status !== 'PENDING';

  // ── Accepted: report what happened, including a declined merge ────────────────
  if (result) {
    return (
      <AuthPanel
        eyebrow="Welcome"
        title="Invitation accepted"
        documentTitle="Invitation accepted"
      >
        <div className="cq-stack">
          <Notice>
            You joined <strong>{data.targetCompanyName}</strong> as {titleCase(result.role)}.
          </Notice>

          {result.merge?.outcome === 'MERGED' ? (
            <Notice>
              The placeholder company that was standing in for you has been merged into your
              existing company. Its engagement, project assignments and any logged work now
              point at your real company.
            </Notice>
          ) : null}

          {result.merge?.outcome === 'SKIPPED' ? (
            <Notice>
              <strong>The placeholder was not merged into your existing company.</strong>{' '}
              {result.merge.reason ?? 'Merging would have collided with existing records.'}{' '}
              Nothing was moved or overwritten — you now own the placeholder company
              instead, and both remain intact. You can keep working in either.
            </Notice>
          ) : null}

          <Button onClick={() => router.replace('/app')}>Go to your workspace</Button>
        </div>
      </AuthPanel>
    );
  }

  return (
    <AuthPanel
      eyebrow="Invitation"
      title={inviteHeadline(data)}
      documentTitle="Invitation"
      description={inviteDescription(data)}
    >
      <div className="cq-stack">
        <div className="cq-object-list__item" style={{ borderRadius: 8 }}>
          <span>
            <span className="cq-object-list__title">{data.targetCompanyName}</span>
            <span className="cq-object-list__meta">
              Issued to {data.email}
              {data.role ? ` · as ${titleCase(data.role)}` : ''}
            </span>
          </span>
          <Badge tone={spent ? 'neutral' : expired ? 'warning' : 'accent'}>
            {spent ? titleCase(data.status) : expired ? 'Expired' : titleCase(data.kind)}
          </Badge>
        </div>

        {spent ? (
          <Notice>
            This invitation has already been {data.status.toLowerCase()}. If you still need
            access, ask for a new invitation.
          </Notice>
        ) : expired ? (
          <Notice>
            This invitation expired on {formatDateTime(data.expiresAt)}. Ask whoever invited
            you to issue a new one.
          </Notice>
        ) : !session ? (
          <>
            <Notice>
              Sign in as <strong>{data.email}</strong> to accept. An invitation can only be
              accepted by the address it was issued to.
            </Notice>
            <Row>
              <Button onClick={() => router.push(signInHref)}>Sign in to accept</Button>
              <Button variant="secondary" onClick={() => router.push(registerHref)}>
                Create an account
              </Button>
            </Row>
          </>
        ) : (
          <>
            {session.user.email.toLowerCase() !== data.email.toLowerCase() ? (
              <Notice>
                You are signed in as <strong>{session.user.email}</strong>, but this
                invitation was issued to <strong>{data.email}</strong>. Sign in as that
                address to accept it.
              </Notice>
            ) : (
              <p className="cq-muted">
                Accepting as <strong>{session.user.email}</strong>. Expires{' '}
                {formatDateTime(data.expiresAt)}.
              </p>
            )}
            <ErrorText>{error}</ErrorText>
            <Row>
              <Button
                onClick={() => void accept()}
                disabled={
                  accepting || session.user.email.toLowerCase() !== data.email.toLowerCase()
                }
              >
                {accepting ? 'Accepting…' : 'Accept invitation'}
              </Button>
              <Button variant="secondary" onClick={() => router.push('/app')}>
                Not now
              </Button>
            </Row>
          </>
        )}
      </div>
    </AuthPanel>
  );
}

function inviteHeadline(invite: InviteView): string {
  if (invite.kind === 'MEMBER') return `Join ${invite.targetCompanyName}`;
  if (invite.kind === 'ENGAGEMENT') return 'You have been engaged as a subcontractor';
  return 'You have been given portal access';
}

function inviteDescription(invite: InviteView): string {
  if (invite.kind === 'MEMBER') {
    return 'You have been invited to work inside this company on CrewQuo.';
  }
  if (invite.kind === 'ENGAGEMENT') {
    return 'Accepting sets up the working relationship so your crew can log time and expenses against their projects.';
  }
  return 'Accepting gives you read access to the projects your contractor publishes to you, with their line items and totals.';
}
