'use client';

import { useState } from 'react';
import type { MeResponse, PublicUser } from '@crewquo/shared';
import { DEFAULT_CURRENCY } from '@crewquo/shared';
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
import { api, ApiError } from '@/api/client';
import { useAuth, useSessionCtx } from '@/auth/AuthProvider';
import { useAsyncData } from '@/lib/useAsyncData';
import { titleCase } from '@/lib/format';

/**
 * Profile — the signed-in account, its companies, and the one action that is
 * genuinely missing everywhere else: starting a second company.
 *
 * Name and avatar are editable (`PATCH /v1/me`). Email is not: it is the address
 * an invite is bound to and where a reset link is sent, so changing it is a
 * re-verification flow rather than a text field, and it is shown as the fixed
 * identity it is instead of a disabled input implying an editor is coming.
 */
export default function ProfilePage() {
  return (
    <Shell>
      <Profile />
    </Shell>
  );
}

function Profile() {
  const ctx = useSessionCtx();
  const { session, companyId, setCompanyId } = useAuth();
  const me = useAsyncData<MeResponse>(
    session ? () => api.me(session.accessToken) : null,
    [session?.accessToken]
  );

  return (
    <Stack>
      <PageHeader
        eyebrow="Your account"
        title="Profile"
        description="The account you are signed in as, and every company it belongs to."
      />

      <Section title="Account">
        {/*
          `loading && !data` rather than `loading`: a *reload* must not unmount the form.
          Swapping it for a spinner after a save threw away the form's own state, so a
          successful save flashed its confirmation and then erased it — the change had
          landed, and the screen said nothing.
        */}
        {me.loading && !me.data ? (
          <p className="cq-muted">Loading…</p>
        ) : me.error || !me.data ? (
          <EmptyState title="Could not load your profile">
            {me.error ?? 'No profile was returned.'}
          </EmptyState>
        ) : (
          <AccountForm user={me.data.user} onSaved={() => me.reload()} />
        )}
      </Section>

      <Section
        title="Companies"
        description="Every membership on this account. The active one is used by every screen."
        className="cq-section--table"
      >
        {(session?.memberships.length ?? 0) === 0 ? (
          <EmptyState title="No companies yet">
            Create one below, or accept an invitation you were sent.
          </EmptyState>
        ) : (
          <Table label="Your company memberships">
            <thead>
              <tr>
                <th scope="col">Company</th>
                <th scope="col">Your role</th>
                <th scope="col">Currency</th>
                <th scope="col">
                  <span className="cq-table__actions">Active</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {session?.memberships.map((m) => (
                <tr key={m.companyId}>
                  <td className="cq-table__primary">{m.companyName}</td>
                  <td>{titleCase(m.role)}</td>
                  <td>{m.currency}</td>
                  <td className="cq-table__actions">
                    {m.companyId === companyId ? (
                      <Badge tone="success">Active</Badge>
                    ) : (
                      <Button size="sm" variant="secondary" onClick={() => setCompanyId(m.companyId)}>
                        Switch to
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Section>

      <CreateCompany />

      {ctx ? null : (
        <Notice>Select or create a company to use the rest of the workspace.</Notice>
      )}
    </Stack>
  );
}

/**
 * Name + avatar editor. The name is what appears on every approval and audit row
 * this account produces, which is why the API records the change against each
 * company the user belongs to — and why that is said here rather than left as a
 * surprise in someone else's trail.
 */
function AccountForm({ user, onSaved }: { user: PublicUser; onSaved: () => void }) {
  const { session, refreshUser } = useAuth();
  const [name, setName] = useState(user.name);
  const [avatarUrl, setAvatarUrl] = useState(user.avatarUrl ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const trimmedName = name.trim();
  const trimmedAvatar = avatarUrl.trim();
  const dirty = trimmedName !== user.name || trimmedAvatar !== (user.avatarUrl ?? '');

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!session || !dirty) return;
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      await api.updateMe(session.accessToken, {
        ...(trimmedName !== user.name ? { name: trimmedName } : {}),
        // An emptied field means "clear it", which is an explicit null — not an
        // empty string, which would fail URL validation.
        ...(trimmedAvatar !== (user.avatarUrl ?? '')
          ? { avatarUrl: trimmedAvatar === '' ? null : trimmedAvatar }
          : {}),
      });
      setSaved(true);
      onSaved();
      // The shell renders the name from the session, so it has to be re-read or
      // the sidebar keeps showing the old one until the next sign-in.
      await refreshUser();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save your profile');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="cq-stack" aria-busy={busy}>
      <div className="cq-form-grid">
        <Field label="Name" hint="Shown on approvals, notes and audit rows.">
          <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={200} required />
        </Field>
        <Field label="Email address" hint="Fixed: invites and reset links are bound to it.">
          <Input value={user.email} readOnly />
        </Field>
        <Field label="Avatar URL" hint="Optional. Clear the field to remove it.">
          <Input
            type="url"
            value={avatarUrl}
            onChange={(e) => setAvatarUrl(e.target.value)}
            placeholder="https://…"
            spellCheck={false}
          />
        </Field>
      </div>
      <Row>
        {user.emailVerified ? (
          <Badge tone="success">Email verified</Badge>
        ) : (
          <Badge tone="warning">Email not verified</Badge>
        )}
        {user.isSuperAdmin ? <Badge tone="accent">Platform staff</Badge> : null}
      </Row>
      {!user.emailVerified ? (
        <Notice>
          Your address is not verified yet. Registration issued a 24-hour link; opening it
          completes verification. Nothing is blocked in the meantime.
        </Notice>
      ) : null}
      {saved ? <Notice>Your profile was saved.</Notice> : null}
      <ErrorText>{error}</ErrorText>
      <Row>
        <Button type="submit" disabled={busy || !dirty || trimmedName === ''}>
          {busy ? 'Saving…' : 'Save profile'}
        </Button>
      </Row>
    </form>
  );
}

function CreateCompany() {
  const { createCompany } = useAuth();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [currency, setCurrency] = useState(DEFAULT_CURRENCY);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await createCompany(name.trim(), currency.toUpperCase());
      setCreated(name.trim());
      setName('');
      setOpen(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create the company');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section
      title="Start another company"
      description="You become its owner. Companies are separate books: rates, projects and work never cross between them."
      actions={
        open ? null : (
          <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
            New company
          </Button>
        )
      }
    >
      {created ? (
        <Notice>
          <strong>{created}</strong> was created and is now your active company.
        </Notice>
      ) : null}
      {open ? (
        <form onSubmit={submit} className="cq-stack" aria-busy={busy}>
          <div className="cq-form-grid">
            <Field label="Company name">
              <Input value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
            </Field>
            <Field label="Currency (ISO 4217)" hint="Rate cards inherit this.">
              <Input
                value={currency}
                onChange={(e) => setCurrency(e.target.value.toUpperCase().slice(0, 3))}
                maxLength={3}
                required
              />
            </Field>
          </div>
          <ErrorText>{error}</ErrorText>
          <Row>
            <Button type="submit" disabled={busy || !name.trim()}>
              {busy ? 'Creating…' : 'Create company'}
            </Button>
            <Button variant="secondary" onClick={() => setOpen(false)} disabled={busy}>
              Cancel
            </Button>
          </Row>
        </form>
      ) : null}
    </Section>
  );
}
