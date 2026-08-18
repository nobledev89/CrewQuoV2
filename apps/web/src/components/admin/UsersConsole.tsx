'use client';

import { useState } from 'react';
import type { AdminUserDetail, AdminUserSummary } from '@crewquo/shared';
import {
  Badge,
  Button,
  Drawer,
  EmptyState,
  ErrorText,
  Field,
  Input,
  Notice,
  PageHeader,
  Row,
  SearchInput,
  Section,
  Select,
  Stack,
  Table,
} from '@crewquo/ui';
import { api, ApiError } from '@/api/client';
import { useAuth } from '@/auth/AuthProvider';
import { formatDateTime, titleCase } from '@/lib/format';
import { useAsyncData } from '@/lib/useAsyncData';

export function UsersConsole({ accessOnly = false }: { accessOnly?: boolean }) {
  const { session } = useAuth();
  const [search, setSearch] = useState('');
  const [appliedSearch, setAppliedSearch] = useState('');
  const [access, setAccess] = useState(accessOnly ? 'SUPER_ADMIN' : 'ALL');
  const [verification, setVerification] = useState('ALL');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const users = useAsyncData<AdminUserSummary[]>(
    session
      ? () => api.adminUsers(session.accessToken, {
          search: appliedSearch || undefined,
          access: accessOnly ? 'SUPER_ADMIN' : access,
          verification,
        }).then((response) => response.data)
      : null,
    [session?.accessToken, appliedSearch, access, verification, accessOnly]
  );

  return (
    <Stack>
      <PageHeader
        eyebrow="CrewQuo Platform"
        title={accessOnly ? 'Admin access' : 'Users'}
        description={accessOnly
          ? 'Who can enter CrewQuo Platform and perform super-admin actions.'
          : 'Every CrewQuo identity, its verification, memberships, sessions and platform access.'}
      />
      <Section className="cq-section--table">
        <form className="cq-table-toolbar" onSubmit={(event) => { event.preventDefault(); setAppliedSearch(search.trim()); }}>
          <Row>
            <SearchInput value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Name or email" aria-label="Search users" />
            {!accessOnly ? (
              <Select value={access} onChange={(event) => setAccess(event.target.value)} aria-label="Access type">
                <option value="ALL">All access</option>
                <option value="SUPER_ADMIN">Super Admin</option>
                <option value="CUSTOMER">Customer</option>
              </Select>
            ) : null}
            <Select value={verification} onChange={(event) => setVerification(event.target.value)} aria-label="Email verification">
              <option value="ALL">Any verification</option>
              <option value="VERIFIED">Verified</option>
              <option value="UNVERIFIED">Unverified</option>
            </Select>
            <Button type="submit" size="sm">Search</Button>
          </Row>
        </form>
        <ErrorText>{users.error}</ErrorText>
        {users.loading ? <p className="cq-muted">Loading users…</p> : users.data?.length ? (
          <Table label={accessOnly ? 'Super administrators' : 'Platform users'} compact>
            <thead><tr><th>User</th><th>Verification</th><th>Companies</th><th>Sessions</th><th>Created</th><th><span className="cq-table__actions">Action</span></th></tr></thead>
            <tbody>{users.data.map((user) => (
              <tr key={user.id}>
                <td><div className="cq-table__primary">{user.name}</div><div className="cq-muted">{user.email}</div></td>
                <td>{user.emailVerified ? <Badge tone="success">Verified</Badge> : <Badge tone="warning">Unverified</Badge>}</td>
                <td>{user.membershipCount}</td><td>{user.activeSessionCount}</td><td>{formatDateTime(user.createdAt)}</td>
                <td className="cq-table__actions"><Button size="sm" variant="secondary" onClick={() => setSelectedId(user.id)}>Open</Button></td>
              </tr>
            ))}</tbody>
          </Table>
        ) : <EmptyState title="No users found">Change the filters or search for another identity.</EmptyState>}
      </Section>
      <UserDrawer
        userId={selectedId}
        onClose={() => setSelectedId(null)}
        onChanged={() => users.reload()}
      />
    </Stack>
  );
}

function UserDrawer({ userId, onClose, onChanged }: { userId: string | null; onClose: () => void; onChanged: () => void }) {
  const { session } = useAuth();
  const detail = useAsyncData<AdminUserDetail>(
    session && userId ? () => api.adminUser(session.accessToken, userId) : null,
    [session?.accessToken, userId]
  );
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function act(action: 'sessions' | 'access') {
    if (!session || !userId || !detail.data || reason.trim().length < 3) return;
    setBusy(true); setError(null); setNotice(null);
    try {
      if (action === 'sessions') {
        const result = await api.adminRevokeUserSessions(session.accessToken, userId, reason.trim());
        setNotice(`${result.revoked} active session${result.revoked === 1 ? '' : 's'} revoked.`);
      } else {
        const enabled = !detail.data.user.isSuperAdmin;
        await api.adminSetSuperAdmin(session.accessToken, userId, enabled, reason.trim());
        setNotice(`Super-admin access ${enabled ? 'granted' : 'revoked'}.`);
      }
      setReason('');
      detail.reload();
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'The admin action failed');
    } finally { setBusy(false); }
  }

  return (
    <Drawer open={Boolean(userId)} title={detail.data?.user.name ?? 'User'} description={detail.data?.user.email} onClose={onClose}>
      {detail.loading ? <p className="cq-muted">Loading user…</p> : detail.error || !detail.data ? (
        <ErrorText>{detail.error ?? 'User not found'}</ErrorText>
      ) : (
        <Stack>
          <Row>
            <Badge tone={detail.data.user.emailVerified ? 'success' : 'warning'}>{detail.data.user.emailVerified ? 'Verified' : 'Unverified'}</Badge>
            {detail.data.user.isSuperAdmin ? <Badge tone="accent">Super Admin</Badge> : null}
          </Row>
          <Section title="Memberships" className="cq-section--table">
            {detail.data.memberships.length ? (
              <Table label="User memberships" compact><thead><tr><th>Company</th><th>Role</th><th>Status</th></tr></thead><tbody>
                {detail.data.memberships.map((membership) => <tr key={membership.membershipId}><td>{membership.companyName}</td><td>{titleCase(membership.role)}</td><td>{titleCase(membership.status)}</td></tr>)}
              </tbody></Table>
            ) : <p className="cq-muted">No company memberships.</p>}
          </Section>
          <Section title="Administrative actions" description="Every action requires a reason and is written to the platform audit trail.">
            <Stack>
              <Field label="Reason"><Input value={reason} onChange={(event) => setReason(event.target.value)} maxLength={1000} /></Field>
              <Row>
                <Button size="sm" variant="secondary" disabled={busy || reason.trim().length < 3} onClick={() => void act('sessions')}>Revoke sessions</Button>
                <Button size="sm" variant={detail.data.user.isSuperAdmin ? 'danger' : 'primary'} disabled={busy || reason.trim().length < 3 || (!detail.data.user.isSuperAdmin && !detail.data.user.emailVerified)} onClick={() => void act('access')}>
                  {detail.data.user.isSuperAdmin ? 'Revoke Super Admin' : 'Grant Super Admin'}
                </Button>
              </Row>
              {!detail.data.user.emailVerified && !detail.data.user.isSuperAdmin ? <p className="cq-muted">Email verification is required before platform access can be granted.</p> : null}
              <ErrorText>{error}</ErrorText>{notice ? <Notice>{notice}</Notice> : null}
            </Stack>
          </Section>
        </Stack>
      )}
    </Drawer>
  );
}
