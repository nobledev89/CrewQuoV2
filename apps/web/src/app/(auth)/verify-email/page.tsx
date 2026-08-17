'use client';

import { Suspense, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Notice } from '@crewquo/ui';
import { api, ApiError } from '@/api/client';
import { AuthPanel } from '@/components/AuthPanel';

/**
 * Email verification. Registration issues a 24-hour link to
 * `APP_BASE_URL/verify-email?token=...`; this page spends it.
 *
 * The verify runs once per mount and is guarded by a ref: React's development
 * StrictMode double-invokes effects, and the second call against a spent token would
 * report a failure for a verification that actually succeeded.
 */
export default function VerifyEmailPage() {
  return (
    <Suspense
      fallback={
        <AuthPanel title="Verify your email" documentTitle="Verify email">
          {null}
        </AuthPanel>
      }
    >
      <VerifyEmail />
    </Suspense>
  );
}

function VerifyEmail() {
  const params = useSearchParams();
  const token = params.get('token') ?? '';
  const attempted = useRef(false);
  const [state, setState] = useState<'idle' | 'working' | 'done' | 'failed'>('idle');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!token || attempted.current) return;
    attempted.current = true;
    setState('working');
    api
      .verifyEmail(token)
      .then(() => setState('done'))
      .catch((err) => {
        setError(
          err instanceof ApiError
            ? err.message
            : 'We could not verify this address. The link may have expired.'
        );
        setState('failed');
      });
  }, [token]);

  return (
    <AuthPanel eyebrow="Your account" title="Verify your email" documentTitle="Verify email">
      <div className="cq-stack">
        {!token ? (
          <Notice>
            This link is missing its token. Open the most recent verification link you were
            sent — each one is valid for 24 hours.
          </Notice>
        ) : state === 'working' || state === 'idle' ? (
          <p className="cq-muted" role="status">
            Verifying…
          </p>
        ) : state === 'done' ? (
          <Notice>
            Your email address is verified. Nothing else is needed — you can carry on
            working.
          </Notice>
        ) : (
          <Notice>{error}</Notice>
        )}
        <Link className="cq-muted" href="/app">
          Go to your workspace
        </Link>
      </div>
    </AuthPanel>
  );
}
