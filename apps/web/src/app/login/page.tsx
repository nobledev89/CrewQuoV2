'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button, ErrorText, Field, Input } from '@crewquo/ui';
import { useAuth } from '@/auth/AuthProvider';
import { ApiError } from '@/api/client';

export default function LoginPage() {
  const { ready, session, login } = useAuth();
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    document.title = 'Sign in · CrewQuo';
    if (ready && session) router.replace('/app');
  }, [ready, session, router]);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(email.trim(), password);
      router.replace('/app');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'We could not sign you in. Check your details and try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="cq-auth">
      <header className="cq-auth__bar"><div className="cq-brand" style={{ height: 'auto', padding: 0, border: 0 }} translate="no"><span className="cq-brand__mark" aria-hidden="true">CQ</span><span className="cq-brand__name">CrewQuo</span></div></header>
      <main className="cq-auth__main">
        <div className="cq-auth__panel">
          <div className="cq-auth__heading"><p className="cq-overline" style={{ margin: '0 0 8px' }}>Contractor operations</p><h1 className="cq-h1">Sign in to your workspace</h1><p className="cq-page-header__description">Manage rates, costing rules and operational controls.</p></div>
          <form onSubmit={onSubmit} className="cq-stack" aria-busy={busy}>
            <Field label="Email address"><Input name="email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="email" spellCheck={false} required autoFocus /></Field>
            <Field label="Password"><Input name="password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" required /></Field>
            <ErrorText>{error}</ErrorText>
            <Button type="submit" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</Button>
          </form>
        </div>
      </main>
      <footer className="cq-auth__footer">Secure access to your CrewQuo workspace</footer>
    </div>
  );
}
