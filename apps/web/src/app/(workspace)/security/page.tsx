'use client';

import { useState } from 'react';
import type { MfaEnrolment, SessionView } from '@crewquo/shared';
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
import { useAuth } from '@/auth/AuthProvider';
import { useAsyncData } from '@/lib/useAsyncData';
import { formatDateTime } from '@/lib/format';

/**
 * Security — the devices signed in to this account, and how to end one.
 *
 * The screen the packet's §12.12 asks for: "everything above is reversible by the
 * account holder without an operator". A person who has lost a phone should not
 * have to email support to get it signed out, and a person who suspects worse
 * should be able to end everything but the device in their hand.
 *
 * **Its own page rather than a panel on Profile**, because this is where MFA
 * enrolment and recovery codes land next (build-order step 3) and a security
 * surface that starts as a section of somebody's display-name form does not end up
 * looking like a security surface.
 */
export default function SecurityPage() {
  return (
    <Shell>
      <Security />
    </Shell>
  );
}

/** Why a session ended, in the words of the person it happened to. */
function endedLabel(session: SessionView): string {
  switch (session.endedCause) {
    case 'SIGNED_OUT':
      return 'Signed out';
    case 'ENDED_BY_USER':
      return 'You ended it';
    case 'PASSWORD_RESET':
      return 'Password reset';
    // The two that are not tidy-up. Named plainly: somebody reading this list after
    // a scare needs to be able to tell "I did this" from "this was done to me".
    case 'TOKEN_REUSE':
      return 'Ended for security';
    case 'OPERATOR':
      return 'Ended by CrewQuo';
    default:
      return 'Expired';
  }
}

function Security() {
  const { session, logout } = useAuth();
  const token = session?.accessToken ?? null;
  const sessions = useAsyncData(token ? () => api.sessions(token) : null, [token]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const rows = sessions.data?.sessions ?? [];
  const active = rows.filter((s) => s.state === 'ACTIVE');
  const ended = rows.filter((s) => s.state !== 'ACTIVE');
  const others = active.filter((s) => !s.current).length;

  async function end(target: SessionView) {
    if (!token) return;
    setBusy(target.id);
    setError(null);
    setNote(null);
    try {
      await api.endSession(token, target.id);
      // Ending the device you are holding is allowed, and the honest response is
      // to sign out here rather than leave the screen sitting on a session the
      // server has already ended.
      if (target.current) {
        await logout();
        return;
      }
      setNote('That device was signed out.');
      sessions.reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not end that session');
    } finally {
      setBusy(null);
    }
  }

  async function endOthers() {
    if (!token) return;
    setBusy('others');
    setError(null);
    setNote(null);
    try {
      const { ended: count } = await api.endOtherSessions(token);
      setNote(
        count === 0
          ? 'Nothing else was signed in.'
          : `${count} other device${count === 1 ? '' : 's'} signed out.`
      );
      sessions.reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not end your other sessions');
    } finally {
      setBusy(null);
    }
  }

  return (
    <Stack>
      <PageHeader
        eyebrow="Your account"
        title="Security"
        description="Every device signed in to your account. Ending one stops it using your account within seconds."
        actions={
          others > 0 ? (
            <Button variant="secondary" onClick={endOthers} disabled={busy !== null}>
              Sign out other devices
            </Button>
          ) : null
        }
      />

      <ErrorText>{error ?? sessions.error}</ErrorText>
      {note ? <Notice>{note}</Notice> : null}

      {/* The factor comes first: it is the control that actually changes how hard
          this account is to take, and a page opening with a device list buries it. */}
      {token ? <TwoStepSignIn token={token} onChanged={() => sessions.reload()} /> : null}

      <Section
        title="Signed in"
        description="A device stays here until you end it, you change your password, or it goes unused for thirty days."
      >
        {sessions.loading ? (
          <p className="cq-muted">Loading…</p>
        ) : active.length === 0 ? (
          <EmptyState title="Nothing is signed in">
            Sessions appear here as you sign in on each device.
          </EmptyState>
        ) : (
          <Table label="Signed-in devices">
            <thead>
              <tr>
                <th scope="col">Device</th>
                <th scope="col">Signed in</th>
                <th scope="col">Last used</th>
                <th scope="col">
                  <span className="cq-table__actions">Manage</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {active.map((s) => (
                <tr key={s.id}>
                  <td>
                    <Row>
                      {/* Null is honest rather than guessed: a caller whose
                          User-Agent names nothing recognisable gets no label, and
                          inventing one would show a device the holder does not own. */}
                      <span>{s.deviceLabel ?? 'Unknown device'}</span>
                      {s.current ? <Badge tone="accent">This device</Badge> : null}
                    </Row>
                  </td>
                  <td>{formatDateTime(s.createdAt)}</td>
                  <td>{formatDateTime(s.lastUsedAt)}</td>
                  <td>
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => end(s)}
                      disabled={busy !== null}
                    >
                      {s.current ? 'Sign out' : 'End session'}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Section>

      {ended.length > 0 ? (
        <Section
          title="Recently ended"
          description="Kept for a short while so “when did that device last sign in” has an answer after the session is gone."
        >
          <Table label="Recently ended sessions" compact>
            <thead>
              <tr>
                <th scope="col">Device</th>
                <th scope="col">Last used</th>
                <th scope="col">Ended</th>
                <th scope="col">Why</th>
              </tr>
            </thead>
            <tbody>
              {ended.map((s) => (
                <tr key={s.id}>
                  <td>{s.deviceLabel ?? 'Unknown device'}</td>
                  <td>{formatDateTime(s.lastUsedAt)}</td>
                  <td>{formatDateTime(s.endedAt ?? s.expiresAt)}</td>
                  <td>
                    <Badge
                      tone={
                        s.endedCause === 'TOKEN_REUSE' || s.endedCause === 'OPERATOR'
                          ? 'warning'
                          : 'neutral'
                      }
                    >
                      {endedLabel(s)}
                    </Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Section>
      ) : null}

      <Section title="What CrewQuo does on its own">
        <Stack>
          <p className="cq-muted">
            Signing in issues a token that is replaced every time the app reconnects. If a
            replaced one is ever presented again — which means either somebody else has a
            copy of it, or an app is misbehaving — that session is ended everywhere and you
            are emailed. You cannot turn that email off.
          </p>
          <p className="cq-muted">
            Changing your password ends every session, on every device, including this one.
          </p>
        </Stack>
      </Section>
    </Stack>
  );
}

/**
 * Two-step sign-in, on the same screen as the device list.
 *
 * **Offered, not demanded** — for a customer, `required` is false and this is a
 * section they may ignore forever (§13.1). Platform staff see the same UI with a
 * different frame: the platform console refuses them until it is done, so the copy
 * says so rather than letting them discover it as a 403 on a page they used
 * yesterday.
 */
function TwoStepSignIn({ token, onChanged }: { token: string; onChanged: () => void }) {
  const status = useAsyncData(token ? () => api.mfaStatus(token) : null, [token]);
  const [enrolment, setEnrolment] = useState<MfaEnrolment | null>(null);
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState<string[] | null>(null);
  const [password, setPassword] = useState('');
  const [removing, setRemoving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const state = status.data?.state ?? 'NONE';
  const required = status.data?.required ?? false;

  async function begin() {
    setBusy(true);
    setError(null);
    try {
      setEnrolment(await api.startMfa(token));
      // Re-read the status, because the server now holds a PENDING factor and the
      // badge would otherwise keep saying "Off" — which is the one word this screen
      // must not get wrong. It also matters after a reload mid-enrolment: the state
      // is real, so the screen has to be able to show it.
      status.reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not start setup');
    } finally {
      setBusy(false);
    }
  }

  async function confirm(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await api.confirmMfa(token, code.trim());
      // Shown once, and the screen says so. There is no endpoint that returns these
      // again — regenerating is the only way to see a set, and it invalidates the old.
      setCodes(result.codes);
      setEnrolment(null);
      setCode('');
      status.reload();
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not confirm that code');
    } finally {
      setBusy(false);
    }
  }

  async function regenerate() {
    setBusy(true);
    setError(null);
    try {
      setCodes((await api.regenerateRecoveryCodes(token)).codes);
      status.reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not generate new codes');
    } finally {
      setBusy(false);
    }
  }

  async function remove(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.removeMfa(token, { password });
      setPassword('');
      setRemoving(false);
      setCodes(null);
      status.reload();
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not remove it');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section
      title="Two-step sign-in"
      description={
        required
          ? 'Required for platform staff: the console is refused until an authenticator app is confirmed.'
          : 'Ask for a code from an authenticator app as well as your password. Optional, and off unless you turn it on.'
      }
      actions={
        state === 'ACTIVE' && !removing ? (
          <Button variant="secondary" onClick={() => setRemoving(true)} disabled={busy}>
            Remove
          </Button>
        ) : null
      }
    >
      <Stack>
        <ErrorText>{error ?? status.error}</ErrorText>

        <Row>
          <Badge tone={state === 'ACTIVE' ? 'success' : required ? 'warning' : 'neutral'}>
            {state === 'ACTIVE' ? 'On' : state === 'PENDING' ? 'Unfinished' : 'Off'}
          </Badge>
          {state === 'ACTIVE' ? (
            <span className="cq-muted">
              {status.data?.recoveryCodesRemaining ?? 0} recovery code
              {status.data?.recoveryCodesRemaining === 1 ? '' : 's'} left
            </span>
          ) : null}
        </Row>

        {codes ? (
          <>
            <Notice>
              Save these now. Each one signs you in once if you lose your phone, and this
              is the only time they are shown.
            </Notice>
            <ul className="cq-recovery-codes">
              {codes.map((value) => (
                <li key={value}>
                  <code>{value}</code>
                </li>
              ))}
            </ul>
            <Row>
              <Button variant="secondary" onClick={() => setCodes(null)}>
                I have saved them
              </Button>
            </Row>
          </>
        ) : null}

        {state !== 'ACTIVE' && !enrolment ? (
          <Row>
            <Button onClick={begin} disabled={busy}>
              {state === 'PENDING' ? 'Start again' : 'Set up an authenticator app'}
            </Button>
          </Row>
        ) : null}

        {enrolment ? (
          <form onSubmit={confirm} className="cq-stack" aria-busy={busy}>
            <p className="cq-muted">
              Add this key to your authenticator app, then enter the code it shows. Enrolment
              is not finished until a code has been accepted — so a key that never scanned
              properly cannot lock you out.
            </p>
            {/* The key as text rather than only a QR: an authenticator app on the same
                device as this screen cannot scan it, and typing 32 characters is the
                fallback that always works. */}
            <Field label="Setup key">
              <Input value={enrolment.secret} readOnly onFocus={(e) => e.currentTarget.select()} />
            </Field>
            <p className="cq-muted">
              <a href={enrolment.uri}>Open in your authenticator app</a>
            </p>
            <Field label="Code from the app">
              <Input
                value={code}
                onChange={(event) => setCode(event.target.value)}
                autoComplete="one-time-code"
                inputMode="numeric"
                required
                autoFocus
              />
            </Field>
            <Row>
              <Button type="submit" disabled={busy}>
                {busy ? 'Checking…' : 'Confirm'}
              </Button>
              <Button variant="secondary" onClick={() => setEnrolment(null)} disabled={busy}>
                Cancel
              </Button>
            </Row>
          </form>
        ) : null}

        {state === 'ACTIVE' && !removing && !codes ? (
          <Row>
            <Button variant="secondary" onClick={regenerate} disabled={busy}>
              Generate new recovery codes
            </Button>
          </Row>
        ) : null}

        {removing ? (
          <form onSubmit={remove} className="cq-stack" aria-busy={busy}>
            {/* Removing protection is re-authenticated; adding it is not. Friction on
                the safe direction is how you get people who never turn it on. */}
            <Field label="Confirm your password to remove it">
              <Input
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete="current-password"
                required
                autoFocus
              />
            </Field>
            <Row>
              <Button type="submit" disabled={busy}>
                Remove two-step sign-in
              </Button>
              <Button
                variant="secondary"
                onClick={() => {
                  setRemoving(false);
                  setPassword('');
                }}
                disabled={busy}
              >
                Keep it
              </Button>
            </Row>
          </form>
        ) : null}
      </Stack>
    </Section>
  );
}
