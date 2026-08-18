'use client';

import { useState } from 'react';
import type {
  CompanyCreationRequestView,
  CompanyCreationState,
  MeResponse,
  PublicUser,
} from '@crewquo/shared';
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
import { formatDate, titleCase } from '@/lib/format';

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

/**
 * Starting another company (§3.1.1).
 *
 * One section, three states, chosen by the server rather than by the screen:
 *
 *  · **Allowance available** — the included company. Two fields, no ceremony;
 *    this is the person the safeguard is not aimed at.
 *  · **Allowance spent** — the advanced flow. Legal identity, an attestation and
 *    a password, because the next company is a separate subscription and a
 *    separate set of books.
 *  · **A request in flight or decided** — its status, and the reason if it was
 *    refused. No email or push exists yet (Resend is a later Phase 6 bullet), so
 *    this row *is* the notification and has to say everything.
 */
function CreateCompany() {
  const { session, createCompany } = useAuth();
  const state = useAsyncData<CompanyCreationState>(
    session ? () => api.companyCreationState(session.accessToken) : null,
    [session?.accessToken]
  );

  if (state.loading && !state.data) {
    return (
      <Section title="Another company">
        <p className="cq-muted">Loading…</p>
      </Section>
    );
  }
  if (state.error || !state.data) {
    return (
      <Section title="Another company">
        <EmptyState title="Could not load company options">
          {state.error ?? 'Nothing was returned.'}
        </EmptyState>
      </Section>
    );
  }

  const data = state.data;
  const approved = data.openRequest?.status === 'APPROVED' ? data.openRequest : null;

  return (
    <Stack>
      {data.allowanceAvailable ? (
        <FirstCompany onDone={() => state.reload()} />
      ) : approved ? (
        <ApprovedCompany request={approved} onDone={() => state.reload()} />
      ) : (
        <RequestCompany state={data} onDone={() => state.reload()} />
      )}
      {data.history.length ? (
        <Section
          title="Company requests"
          description="Every additional-company request on this account."
          className="cq-section--table"
        >
          <Table label="Company creation requests" compact>
            <thead>
              <tr>
                <th scope="col">Business</th>
                <th scope="col">Filed</th>
                <th scope="col">Status</th>
                <th scope="col">Decision</th>
              </tr>
            </thead>
            <tbody>
              {data.history.map((request) => (
                <tr key={request.id}>
                  <td className="cq-table__primary">
                    {request.legalName}
                    <span className="cq-muted"> · {request.country}</span>
                  </td>
                  <td>{formatDate(request.createdAt)}</td>
                  <td>
                    <Badge tone={REQUEST_TONE[request.status] ?? 'neutral'}>
                      {titleCase(request.status.replace('_', ' '))}
                    </Badge>
                  </td>
                  <td>{request.decisionReason ?? <span className="cq-muted">—</span>}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Section>
      ) : null}
    </Stack>
  );
}

const REQUEST_TONE: Record<string, 'success' | 'warning' | 'danger' | 'neutral' | 'accent'> = {
  PENDING_CHECKOUT: 'warning',
  PENDING_REVIEW: 'warning',
  APPROVED: 'accent',
  REJECTED: 'danger',
  EXPIRED: 'neutral',
  CONSUMED: 'success',
};

/** The included company: the one creation that needs no permission at all. */
function FirstCompany({ onDone }: { onDone: () => void }) {
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
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create the company');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section
      title="Start your company"
      description="Your account includes one company. You become its owner, and companies are separate books: rates, projects and work never cross between them."
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

/**
 * An approval in hand.
 *
 * The legal identity is fixed to what was reviewed and is not re-asked: the
 * approval was granted for *that* business, and the server overrides anything the
 * create body claims anyway. Only the trading name and currency are still open.
 */
function ApprovedCompany({
  request,
  onDone,
}: {
  request: CompanyCreationRequestView;
  onDone: () => void;
}) {
  const { createCompany } = useAuth();
  const [name, setName] = useState(request.displayName);
  const [currency, setCurrency] = useState(request.currency);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await createCompany(name.trim(), currency.toUpperCase(), request.id);
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create the company');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section
      title="Your additional company is approved"
      description={`Approved for ${request.legalName} (${request.country}). Create it by ${formatDate(
        request.expiresAt
      )} — after that the approval lapses and you would need a new request.`}
    >
      <form onSubmit={submit} className="cq-stack" aria-busy={busy}>
        <div className="cq-form-grid">
          <Field label="Trading name" hint="What the workspace shows. The legal identity is fixed.">
            <Input value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
          </Field>
          <Field label="Currency (ISO 4217)">
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
        </Row>
      </form>
    </Section>
  );
}

/** The advanced flow, and the status of a request already filed. */
function RequestCompany({ state, onDone }: { state: CompanyCreationState; onDone: () => void }) {
  const { session } = useAuth();
  const [open, setOpen] = useState(false);
  const [legalName, setLegalName] = useState('');
  const [country, setCountry] = useState('');
  const [registrationId, setRegistrationId] = useState('');
  const [currency, setCurrency] = useState(DEFAULT_CURRENCY);
  const [attestation, setAttestation] = useState(false);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [routes, setRoutes] = useState<string[]>([]);

  const pending = state.openRequest;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!session) return;
    setBusy(true);
    setError(null);
    setWarning(null);
    setRoutes([]);
    try {
      const res = await api.createCompanyCreationRequest(session.accessToken, {
        legalName: legalName.trim(),
        country: country.trim().toUpperCase(),
        registrationId: registrationId.trim() || null,
        currency: currency.toUpperCase(),
        attestation: true,
        password,
      });
      setWarning(res.warning);
      setPassword('');
      setOpen(false);
      onDone();
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
        // A registration collision is not a dead end — the refusal carries the
        // routes out of it, and swallowing them would leave the user with nothing
        // but a "no".
        const details = err.details as { routes?: string[] } | undefined;
        if (Array.isArray(details?.routes)) setRoutes(details.routes);
      } else {
        setError('Could not file the request');
      }
    } finally {
      setBusy(false);
    }
  }

  async function withdraw() {
    if (!session || !pending) return;
    setBusy(true);
    setError(null);
    try {
      await api.deleteCompanyCreationRequest(session.accessToken, pending.id);
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not withdraw the request');
    } finally {
      setBusy(false);
    }
  }

  if (pending) {
    return (
      <Section
        title="Your company request is with us"
        description={`${pending.legalName} (${pending.country}) — filed ${formatDate(
          pending.createdAt
        )}. It lapses on ${formatDate(pending.expiresAt)} if nobody decides it.`}
        actions={
          <Button size="sm" variant="secondary" onClick={() => void withdraw()} disabled={busy}>
            Withdraw
          </Button>
        }
      >
        <Row>
          <Badge tone="warning">{titleCase(pending.status.replace('_', ' '))}</Badge>
        </Row>
        <ErrorText>{error}</ErrorText>
      </Section>
    );
  }

  return (
    <Section
      title="Start another company"
      description="Your account's included company has been used. A second legal business is a separate subscription, a separate set of books and a separate data boundary, so it is approved before it is created."
      actions={
        open || !state.canRequest ? null : (
          <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
            Request a company
          </Button>
        )
      }
    >
      {warning ? <Notice>{warning}</Notice> : null}
      {!state.canRequest ? (
        <Notice>{state.blockedReason}</Notice>
      ) : open ? (
        <form onSubmit={submit} className="cq-stack" aria-busy={busy}>
          <div className="cq-form-grid">
            <Field label="Registered legal name">
              <Input
                value={legalName}
                onChange={(e) => setLegalName(e.target.value)}
                required
                autoFocus
              />
            </Field>
            <Field label="Country" hint="Two-letter code, e.g. GB.">
              <Input
                value={country}
                onChange={(e) => setCountry(e.target.value.toUpperCase().slice(0, 2))}
                maxLength={2}
                required
              />
            </Field>
            <Field
              label="Registration number"
              hint="Optional, where the business has one. Used to spot a company already on CrewQuo."
            >
              <Input
                value={registrationId}
                onChange={(e) => setRegistrationId(e.target.value)}
                spellCheck={false}
              />
            </Field>
            <Field label="Currency (ISO 4217)">
              <Input
                value={currency}
                onChange={(e) => setCurrency(e.target.value.toUpperCase().slice(0, 3))}
                maxLength={3}
                required
              />
            </Field>
            <Field
              label="Confirm your password"
              hint="Re-entered because this starts a separate subscription."
            >
              <Input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                autoComplete="current-password"
              />
            </Field>
          </div>
          <label className="cq-row">
            <input
              type="checkbox"
              checked={attestation}
              onChange={(e) => setAttestation(e.target.checked)}
            />
            <span>{state.attestationText}</span>
          </label>
          <ErrorText>{error}</ErrorText>
          {routes.length ? (
            <Notice>
              <ul className="cq-object-list">
                {routes.map((route) => (
                  <li key={route}>{route}</li>
                ))}
              </ul>
            </Notice>
          ) : null}
          <Row>
            <Button type="submit" disabled={busy || !attestation || !legalName.trim() || !password}>
              {busy ? 'Sending…' : 'Send request'}
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
