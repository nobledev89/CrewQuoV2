'use client';

import { Suspense, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { DEFAULT_CURRENCY } from '@crewquo/shared';
import { Button, ErrorText, Field, Input, Notice, Row } from '@crewquo/ui';
import { useAuth } from '@/auth/AuthProvider';
import { ApiError } from '@/api/client';
import { AuthPanel } from '@/components/AuthPanel';

/**
 * Registration. `companyName` is optional on the API, and the distinction matters:
 * someone signing up to *accept an invite* joins an existing company and must not
 * create a second one, while someone signing up to run their own crews needs one
 * immediately. So the field is offered but skippable, and the invite path defaults
 * it off.
 */
export default function RegisterPage() {
  return (
    <Suspense fallback={<AuthPanel title="Register" documentTitle="Register">{null}</AuthPanel>}>
      <Register />
    </Suspense>
  );
}

function Register() {
  const { ready, session, register } = useAuth();
  const router = useRouter();
  const params = useSearchParams();

  const next = params.get('next');
  const destination = next && next.startsWith('/') ? next : '/app';
  const joiningByInvite = destination.startsWith('/invite/');

  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [wantsCompany, setWantsCompany] = useState(!joiningByInvite);
  const [companyName, setCompanyName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (ready && session) router.replace(destination);
  }, [ready, session, router, destination]);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await register({
        name: name.trim(),
        email: email.trim(),
        password,
        ...(wantsCompany && companyName.trim() ? { companyName: companyName.trim() } : {}),
      });
      router.replace(destination);
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : 'We could not create your account. Try again.'
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthPanel
      eyebrow="Get started"
      title="Create your CrewQuo account"
      documentTitle="Register"
      description={
        joiningByInvite
          ? 'Create an account to accept your invitation.'
          : 'Set up your company and start costing work.'
      }
    >
      <form onSubmit={onSubmit} className="cq-stack" aria-busy={busy}>
        <Field label="Your name">
          <Input
            name="name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoComplete="name"
            required
            autoFocus
          />
        </Field>
        <Field label="Email address">
          <Input
            name="email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
            spellCheck={false}
            required
          />
        </Field>
        <Field label="Password" hint="At least 8 characters.">
          <Input
            name="password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
            minLength={8}
            maxLength={72}
            required
          />
        </Field>

        {joiningByInvite ? (
          <Notice>
            You are creating an account to accept an invitation. You will join the inviting
            company — you do not need one of your own.
          </Notice>
        ) : null}

        <label className="cq-row" style={{ gap: 8 }}>
          <input
            type="checkbox"
            checked={wantsCompany}
            onChange={(e) => setWantsCompany(e.target.checked)}
          />
          <span>I am setting up my own company</span>
        </label>

        {wantsCompany ? (
          <Field
            label="Company name"
            hint={`Your currency starts as ${DEFAULT_CURRENCY} and is changeable in settings.`}
          >
            <Input
              name="companyName"
              value={companyName}
              onChange={(e) => setCompanyName(e.target.value)}
              required
            />
          </Field>
        ) : null}

        <ErrorText>{error}</ErrorText>
        <Button type="submit" disabled={busy}>
          {busy ? 'Creating your account…' : 'Create account'}
        </Button>
        <Row between>
          <span className="cq-muted">Already have an account?</span>
          <Link
            className="cq-muted"
            href={next ? `/login?next=${encodeURIComponent(next)}` : '/login'}
          >
            Sign in
          </Link>
        </Row>
      </form>
    </AuthPanel>
  );
}
