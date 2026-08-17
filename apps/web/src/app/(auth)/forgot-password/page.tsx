'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Button, ErrorText, Field, Input, Notice } from '@crewquo/ui';
import { api, ApiError } from '@/api/client';
import { AuthPanel } from '@/components/AuthPanel';

/**
 * Request a password-reset link.
 *
 * The endpoint answers 202 whether or not the address has an account — it must not
 * reveal which addresses are registered — so this screen cannot honestly say "check
 * your inbox, we sent it". It says what is actually true: if an account exists, a
 * link is on its way.
 *
 * Second truth worth stating plainly: **email delivery is not built yet** (Phase 5).
 * The API logs the link to the server console in non-production. Telling someone to
 * watch an inbox that will never receive anything would be a lie, so the note says
 * so.
 */
export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.requestPasswordReset(email.trim());
      setSent(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not request a reset link');
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthPanel
      eyebrow="Account recovery"
      title="Reset your password"
      documentTitle="Forgot password"
      description="We will send a single-use link that expires in one hour."
    >
      {sent ? (
        <div className="cq-stack">
          <Notice>
            If an account exists for <strong>{email.trim()}</strong>, a reset link has been
            issued. We do not confirm whether an address is registered.
          </Notice>
          <Notice>
            <strong>Note for this build:</strong> CrewQuo does not send email yet — that
            arrives with Phase 5. Until then the link is written to the API server log, and
            an administrator can retrieve it from there.
          </Notice>
          <Link className="cq-muted" href="/login">
            Back to sign in
          </Link>
        </div>
      ) : (
        <form onSubmit={onSubmit} className="cq-stack" aria-busy={busy}>
          <Field label="Email address">
            <Input
              name="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
              spellCheck={false}
              required
              autoFocus
            />
          </Field>
          <ErrorText>{error}</ErrorText>
          <Button type="submit" disabled={busy}>
            {busy ? 'Requesting…' : 'Send reset link'}
          </Button>
          <Link className="cq-muted" href="/login">
            Back to sign in
          </Link>
        </form>
      )}
    </AuthPanel>
  );
}
