'use client';

import { useCallback, useEffect, useState } from 'react';
import type { DeletionStatusResponse } from '@crewquo/shared';
import {
  Badge,
  Button,
  ErrorText,
  Field,
  Input,
  Notice,
  Row,
  Section,
  Stack,
} from '@crewquo/ui';
import { api, ApiError } from '@/api/client';
import { useAuth, useSessionCtx } from '@/auth/AuthProvider';
// `formatDateTime`, not `formatDate`: the deadline is an instant somebody was
// emailed, and a date alone leaves "some time on the 28th" as the answer to "how
// long do I have to change my mind".
import { formatDateTime } from '@/lib/format';

/**
 * Closing an account, or a company (packet §14 step 5, decision §13.1).
 *
 * **The screen's job is to be honest, not to be hard to use.** §13.1 committed the
 * product to saying one specific thing *before* the button rather than after it — the
 * hours you logged remain, without your name on them — and named the place that
 * commitment gets lost: "a confirmation dialog that says *this cannot be undone* and
 * nothing else". Which is true of a promise kept and a promise broken alike, and tells
 * the reader nothing about which they are getting.
 *
 * So the promises come **from the server**, in the status response, rather than being
 * written here. A sentence the product is committed to saying is not a sentence that
 * should live only in a React component, where a redesign removes it without anybody
 * noticing a decision was reversed.
 *
 * Three deliberate frictions, and each is a different failure it prevents:
 *
 *  - **The name is typed out**, not a checkbox. A checkbox is one click from an
 *    accident on the most irreversible screen in the product; typing is the cheapest
 *    proof that somebody knows *which* thing they are closing.
 *  - **The password is re-entered.** An access token is re-minted by refresh without
 *    anybody re-proving anything, so its age is not evidence a human is at the
 *    keyboard — and the person this protects against is somebody else sitting at it.
 *  - **The export is offered first**, as a link to the panel above rather than a
 *    reminder afterwards. Afterwards there is no account to download from, which is
 *    why the packet's build order put export before deletion and never the reverse.
 */
export function AccountClosurePanel({ scope }: { scope: 'personal' | 'company' }) {
  const ctx = useSessionCtx();
  const { session, activeMembership } = useAuth();
  const accessToken = session?.accessToken ?? null;

  const [status, setStatus] = useState<DeletionStatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState('');
  const [password, setPassword] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const subject =
    scope === 'personal'
      ? (session?.user.email ?? 'your email address')
      : (activeMembership?.companyName ?? 'the company name');

  const load = useCallback(async () => {
    if (!accessToken) return;
    setLoading(true);
    setError(null);
    try {
      setStatus(
        scope === 'personal'
          ? await api.getMyClosure(accessToken)
          : await api.getCompanyClosure(accessToken, ctx!.companyId)
      );
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not read the closure status');
    } finally {
      setLoading(false);
    }
  }, [accessToken, ctx, scope]);

  useEffect(() => {
    void load();
  }, [load]);

  function reset(): void {
    setOpen(false);
    setConfirm('');
    setPassword('');
    setReason('');
  }

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (!accessToken) return;
    setBusy(true);
    setError(null);
    try {
      const body = { confirm, password, reason: reason.trim() || undefined };
      if (scope === 'personal') await api.requestMyClosure(accessToken, body);
      else await api.requestCompanyClosure(accessToken, ctx!.companyId, body);
      reset();
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not schedule the closure');
    } finally {
      setBusy(false);
    }
  }

  async function cancel(): Promise<void> {
    if (!accessToken) return;
    setBusy(true);
    setError(null);
    try {
      if (scope === 'personal') await api.cancelMyClosure(accessToken);
      else await api.cancelCompanyClosure(accessToken, ctx!.companyId);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not stop the closure');
    } finally {
      setBusy(false);
    }
  }

  const pending = status?.request ?? null;
  const blocks = status?.blocks ?? [];

  return (
    <Section
      title={scope === 'personal' ? 'Close your account' : 'Close this company'}
      description={
        scope === 'personal'
          ? 'Remove your name, your email address and your ability to sign in.'
          : 'End everyone’s access and cancel the subscription. Not reversible.'
      }
    >
      <Stack>
        {loading && !status ? <p className="cq-muted">Loading…</p> : null}

        {/*
          The pending state comes first and replaces the form entirely. Somebody
          arriving here with a closure already scheduled needs one thing — the date and
          the way to stop it — and offering the request form again beside it is how you
          get a second request and a confusing 409.
        */}
        {pending ? (
          <Stack>
            <Notice>
              <strong>
                {scope === 'personal' ? 'Your account' : 'This company'} is scheduled to close
                on {formatDateTime(pending.scheduledFor)}.
              </strong>{' '}
              {pending.requestedByYou
                ? 'You asked for this.'
                : 'Somebody else with access asked for this. If that was not expected, stop it now and change your password.'}{' '}
              {pending.cancellable
                ? 'Nothing has been removed yet, and stopping it puts everything back exactly as it was.'
                : 'It has already started and can no longer be stopped.'}
            </Notice>

            {/*
              Why a due closure has not run. §13.1's "settle or hand over" is checked
              when the run happens, not when the request is made — otherwise the notice
              that asks a counterparty to settle could never be sent. So this box is the
              difference between a closure that is waiting and one that quietly never
              happens.
            */}
            {pending.blockedReason ? (
              <Notice>
                <strong>Waiting on you.</strong> {pending.blockedReason}
              </Notice>
            ) : null}

            <Row>
              {pending.cancellable ? (
                <Button onClick={() => void cancel()} disabled={busy}>
                  {busy ? 'Stopping…' : 'Stop the closure'}
                </Button>
              ) : (
                <Badge tone="danger">In progress</Badge>
              )}
              <ErrorText>{error}</ErrorText>
            </Row>
          </Stack>
        ) : null}

        {!pending && status ? (
          <Stack>
            <Notice>
              <ul className="cq-object-list">
                {status.promises.map((promise) => (
                  <li key={promise}>{promise}</li>
                ))}
              </ul>
            </Notice>

            {/*
              Blocks shown before the button, not after it. For a person these are hard
              refusals the server will repeat — being the only owner of a company —
              so telling them here saves a rejected form. For a company they are not
              refusals: the request is accepted so the counterparty notice can go out,
              and the run waits. The wording distinguishes the two.
            */}
            {blocks.length > 0 ? (
              <Notice>
                <strong>
                  {scope === 'personal'
                    ? 'This has to be sorted out first:'
                    : 'These have to be settled before the closure can run. You can still schedule it now — your counterparties are told so they can settle or hand over:'}
                </strong>
                <ul className="cq-object-list">
                  {blocks.map((block) => (
                    <li key={block}>{block}</li>
                  ))}
                </ul>
              </Notice>
            ) : null}

            {open ? (
              <form onSubmit={submit} className="cq-stack" aria-busy={busy}>
                <div className="cq-form-grid">
                  <Field
                    label={
                      scope === 'personal'
                        ? 'Type your email address to confirm'
                        : 'Type the company name to confirm'
                    }
                    hint={subject}
                  >
                    <Input
                      name="closure-confirm"
                      value={confirm}
                      onChange={(event) => setConfirm(event.target.value)}
                      autoComplete="off"
                      required
                      autoFocus
                    />
                  </Field>
                  <Field
                    label="Confirm your password"
                    hint="Re-entered because being signed in is not proof that you are the one asking."
                  >
                    <Input
                      name="closure-password"
                      type="password"
                      value={password}
                      onChange={(event) => setPassword(event.target.value)}
                      autoComplete="current-password"
                      required
                    />
                  </Field>
                </div>
                <Field label="Why, if you want to tell us" hint="Optional, and never required.">
                  <Input
                    name="closure-reason"
                    value={reason}
                    onChange={(event) => setReason(event.target.value)}
                    maxLength={1000}
                  />
                </Field>
                <ErrorText>{error}</ErrorText>
                <Row>
                  <Button type="submit" disabled={busy || !confirm.trim() || !password}>
                    {busy
                      ? 'Scheduling…'
                      : scope === 'personal'
                        ? 'Schedule my account to close'
                        : 'Schedule this company to close'}
                  </Button>
                  <Button variant="secondary" onClick={reset} disabled={busy}>
                    Keep it
                  </Button>
                </Row>
              </form>
            ) : (
              <Row>
                <Button
                  variant="secondary"
                  onClick={() => setOpen(true)}
                  // Disabled only for a person, where a block is a real refusal. A
                  // company's blocks are things to settle during the window, and
                  // disabling the button would leave an owner with no way to start
                  // the process that tells the counterparty to settle them.
                  disabled={scope === 'personal' && blocks.length > 0}
                >
                  {scope === 'personal' ? 'Close my account' : 'Close this company'}
                </Button>
                <ErrorText>{error}</ErrorText>
              </Row>
            )}
          </Stack>
        ) : null}
      </Stack>
    </Section>
  );
}
