'use client';

import { Suspense, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Button, ErrorText, Field, Input, Notice } from '@crewquo/ui';
import { api, ApiError } from '@/api/client';
import { AuthPanel } from '@/components/AuthPanel';

/**
 * Complete a password reset. The token arrives in the query string, exactly as the
 * API's own link builds it (`APP_BASE_URL/reset-password?token=...`).
 *
 * Resetting revokes every refresh token for the account server-side, so the user is
 * signed out everywhere. The screen says so rather than leaving them to discover it
 * on their other devices.
 */
export default function ResetPasswordPage() {
  return (
    <Suspense
      fallback={
        <AuthPanel title="Reset your password" documentTitle="Reset password">
          {null}
        </AuthPanel>
      }
    >
      <ResetPassword />
    </Suspense>
  );
}

function ResetPassword() {
  const params = useSearchParams();
  const router = useRouter();
  const token = params.get('token') ?? '';

  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const mismatch = confirm.length > 0 && password !== confirm;

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (mismatch) return;
    setBusy(true);
    setError(null);
    try {
      await api.resetPassword(token, password);
      setDone(true);
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : 'Could not reset your password. The link may have expired.'
      );
    } finally {
      setBusy(false);
    }
  }

  if (!token) {
    return (
      <AuthPanel
        eyebrow="Account recovery"
        title="This link is incomplete"
        documentTitle="Reset password"
      >
        <div className="cq-stack">
          <Notice>
            The reset link is missing its token. Open the most recent link you were sent, or
            request a new one — each link is single-use and expires after an hour.
          </Notice>
          <Link className="cq-muted" href="/forgot-password">
            Request a new link
          </Link>
        </div>
      </AuthPanel>
    );
  }

  if (done) {
    return (
      <AuthPanel
        eyebrow="Account recovery"
        title="Password updated"
        documentTitle="Reset password"
      >
        <div className="cq-stack">
          <Notice>
            Your password has been changed, and every existing session was signed out —
            including on your other devices. Sign in again with the new password.
          </Notice>
          <Button onClick={() => router.replace('/login')}>Go to sign in</Button>
        </div>
      </AuthPanel>
    );
  }

  return (
    <AuthPanel
      eyebrow="Account recovery"
      title="Choose a new password"
      documentTitle="Reset password"
      description="This link works once. Existing sessions will be signed out."
    >
      <form onSubmit={onSubmit} className="cq-stack" aria-busy={busy}>
        <Field label="New password" hint="At least 8 characters.">
          <Input
            name="password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
            minLength={8}
            maxLength={72}
            required
            autoFocus
          />
        </Field>
        <Field label="Confirm new password">
          <Input
            name="confirm"
            type="password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            autoComplete="new-password"
            required
          />
        </Field>
        {mismatch ? <ErrorText>Those passwords do not match.</ErrorText> : null}
        <ErrorText>{error}</ErrorText>
        <Button type="submit" disabled={busy || mismatch || password.length < 8}>
          {busy ? 'Updating…' : 'Update password'}
        </Button>
      </form>
    </AuthPanel>
  );
}
