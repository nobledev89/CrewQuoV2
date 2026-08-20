'use client';

import { Suspense, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Button, ErrorText, Field, Input, Notice, Row } from '@crewquo/ui';
import { resolveLandingRoute, type LoginChallenge } from '@crewquo/shared';
import { useAuth } from '@/auth/AuthProvider';
import { ApiError } from '@/api/client';
import { AuthPanel } from '@/components/AuthPanel';

/**
 * `useSearchParams` opts a page out of static prerendering unless it sits inside a
 * Suspense boundary, so the query-reading half is separated from the exported page.
 * Every auth page that takes a `?token=` or `?next=` follows this shape.
 */
export default function LoginPage() {
  return (
    <Suspense fallback={<AuthPanel title="Sign in" documentTitle="Sign in">{null}</AuthPanel>}>
      <Login />
    </Suspense>
  );
}

function Login() {
  const { ready, session, login, completeMfa } = useAuth();
  const router = useRouter();
  const params = useSearchParams();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /**
   * The challenge, held in component state for the seconds it is needed.
   *
   * Not persisted anywhere: it grants nothing on its own, it expires in five
   * minutes, and storing it would leave half a sign-in lying in `localStorage` for
   * anybody who closes the tab at the wrong moment.
   */
  const [challenge, setChallenge] = useState<LoginChallenge | null>(null);
  const [code, setCode] = useState('');
  const [useRecoveryCode, setUseRecoveryCode] = useState(false);

  /**
   * Where to go after signing in. The invite-accept page sends people here with
   * `?next=/invite/<token>` so accepting an invitation survives the detour through
   * sign-in instead of dropping them on the dashboard with a lost token.
   */
  const next = params.get('next');
  const destination = resolveLandingRoute({
    requestedPath: next,
    isSuperAdmin: session?.user.isSuperAdmin,
    view: session ? 'OPERATIONS' : null,
  });

  useEffect(() => {
    if (ready && session) router.replace(destination);
  }, [ready, session, router, destination]);

  function land(user: { isSuperAdmin: boolean }) {
    router.replace(resolveLandingRoute({
      requestedPath: next,
      isSuperAdmin: user.isSuperAdmin,
      view: 'OPERATIONS',
    }));
  }

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await login(email.trim(), password);
      // The password was right, and that is now only half of it. Nothing has been
      // issued yet — the second step is what mints a session.
      // One discriminating check, not two: `A && B` leaves the compiler unable to
      // rule the challenge out of the *else* branch, because it cannot see that a
      // literal `status` makes the second test redundant.
      if ('status' in result) {
        setChallenge(result);
        setPassword('');
        return;
      }
      land(result);
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : 'We could not sign you in. Check your details and try again.'
      );
    } finally {
      setBusy(false);
    }
  }

  async function onSubmitCode(event: React.FormEvent) {
    event.preventDefault();
    if (!challenge) return;
    setBusy(true);
    setError(null);
    try {
      const user = await completeMfa({
        challengeToken: challenge.challengeToken,
        ...(useRecoveryCode ? { recoveryCode: code.trim() } : { code: code.trim() }),
      });
      land(user);
    } catch (err) {
      // The server distinguishes a wrong code from a spent one, and that message is
      // the useful half — "wait for the next code" is advice no generic copy gives.
      setError(
        err instanceof ApiError ? err.message : 'We could not check that code. Try again.'
      );
      setCode('');
    } finally {
      setBusy(false);
    }
  }

  if (challenge) {
    return (
      <AuthPanel
        eyebrow="Two-step sign-in"
        title="Enter your code"
        documentTitle="Two-step sign-in"
        description={
          useRecoveryCode
            ? 'Type one of the recovery codes you saved when you set up two-step sign-in.'
            : 'Open your authenticator app and enter the six-digit code it shows.'
        }
      >
        <form onSubmit={onSubmitCode} className="cq-stack" aria-busy={busy}>
          <Field label={useRecoveryCode ? 'Recovery code' : 'Six-digit code'}>
            <Input
              name={useRecoveryCode ? 'recoveryCode' : 'code'}
              value={code}
              onChange={(event) => setCode(event.target.value)}
              // `one-time-code` is what lets a phone offer the code from its own
              // messages or password manager instead of making somebody switch apps
              // and retype it from memory.
              autoComplete={useRecoveryCode ? 'off' : 'one-time-code'}
              inputMode={useRecoveryCode ? 'text' : 'numeric'}
              spellCheck={false}
              required
              autoFocus
            />
          </Field>
          <ErrorText>{error}</ErrorText>
          <Button type="submit" disabled={busy}>
            {busy ? 'Checking…' : 'Sign in'}
          </Button>
          <Row between>
            {challenge.recoveryAvailable ? (
              <button
                type="button"
                className="cq-link-button"
                onClick={() => {
                  setUseRecoveryCode((current) => !current);
                  setCode('');
                  setError(null);
                }}
              >
                {useRecoveryCode ? 'Use my authenticator app' : 'Use a recovery code instead'}
              </button>
            ) : (
              // Said plainly rather than hidden: somebody who never saved codes needs
              // to know the way back is support, not a button they cannot find.
              <span className="cq-muted">Lost your phone? Contact support.</span>
            )}
            <button
              type="button"
              className="cq-link-button"
              onClick={() => {
                setChallenge(null);
                setCode('');
                setError(null);
                setUseRecoveryCode(false);
              }}
            >
              Start again
            </button>
          </Row>
        </form>
      </AuthPanel>
    );
  }

  return (
    <AuthPanel
      eyebrow="Contractor operations"
      title="Sign in to your workspace"
      documentTitle="Sign in"
      description="Manage rates, projects, approvals and client reporting."
    >
      <form onSubmit={onSubmit} className="cq-stack" aria-busy={busy}>
        <Field label="Email address">
          <Input
            name="email"
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            autoComplete="email"
            spellCheck={false}
            required
            autoFocus
          />
        </Field>
        <Field label="Password">
          <Input
            name="password"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="current-password"
            required
          />
        </Field>
        <ErrorText>{error}</ErrorText>
        <Button type="submit" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </Button>
        <Row between>
          <Link className="cq-muted" href="/forgot-password">
            Forgot your password?
          </Link>
          <Link
            className="cq-muted"
            href={next ? `/register?next=${encodeURIComponent(next)}` : '/register'}
          >
            Create an account
          </Link>
        </Row>
      </form>
    </AuthPanel>
  );
}
