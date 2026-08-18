'use client';

import { Suspense, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Button, ErrorText, Field, Input, Row } from '@crewquo/ui';
import { resolveLandingRoute } from '@crewquo/shared';
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
  const { ready, session, login } = useAuth();
  const router = useRouter();
  const params = useSearchParams();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const user = await login(email.trim(), password);
      router.replace(resolveLandingRoute({
        requestedPath: next,
        isSuperAdmin: user.isSuperAdmin,
        view: 'OPERATIONS',
      }));
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
