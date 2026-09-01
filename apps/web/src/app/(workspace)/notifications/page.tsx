'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  NotificationDigest,
  NotificationPreferences,
  NotificationView,
} from '@crewquo/shared';
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
  Select,
  Stack,
} from '@crewquo/ui';
import { Shell } from '@/components/Shell';
import { api, ApiError } from '@/api/client';
import { useSessionCtx } from '@/auth/AuthProvider';
import { formatDateTime } from '@/lib/format';

/**
 * The inbox, and the Universal Action Centre as its actionable subset.
 * Operating-model packet: `docs/operating-model/notifications.md`.
 *
 * **"Needs you" is the default tab, not "everything".** The question this screen
 * exists to answer is "what is waiting on me", and an inbox that opens on a
 * reverse-chronological wall of news makes the reader do the filtering. The
 * complete list is one click away for the times somebody is looking for
 * something they remember seeing.
 *
 * Read is deliberately not a button. Opening the tab marks what you looked at as
 * read, because clicking "mark as read" is a chore invented by software; **done**
 * is the click that matters and it is the one with a button.
 */
export default function NotificationsPage() {
  return (
    <Shell>
      <Notifications />
    </Shell>
  );
}

type Tab = 'open' | 'all';

function Notifications() {
  const ctx = useSessionCtx();
  const [tab, setTab] = useState<Tab>('open');
  const [items, setItems] = useState<NotificationView[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!ctx) return;
    setLoading(true);
    setError(null);
    try {
      const { data } = await api.listNotifications(ctx.accessToken, ctx.companyId, tab);
      setItems(data);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load your notifications');
    } finally {
      setLoading(false);
    }
  }, [ctx, tab]);

  useEffect(() => {
    void load();
  }, [load]);

  async function act(id: string, verb: 'resolve' | 'dismiss') {
    if (!ctx) return;
    setBusy(true);
    setError(null);
    try {
      await api.actOnNotification(ctx.accessToken, ctx.companyId, id, verb);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not update that item');
    } finally {
      setBusy(false);
    }
  }

  // Marking read on view rather than on a button press: see the note above. Only
  // what is actually on screen is marked, and only once.
  useEffect(() => {
    if (!ctx || loading) return;
    const unread = items.filter((i) => i.state === 'UNREAD');
    if (unread.length === 0) return;
    void Promise.all(
      unread.map((i) => api.actOnNotification(ctx.accessToken, ctx.companyId, i.id, 'read'))
    ).then(() => {
      setItems((current) =>
        current.map((i) => (i.state === 'UNREAD' ? { ...i, state: 'READ' as const } : i))
      );
    });
  }, [ctx, items, loading]);

  const openCount = items.filter((i) => i.state !== 'RESOLVED' && i.state !== 'DISMISSED' && i.requiresAction).length;

  return (
    <Stack>
      <PageHeader
        eyebrow="Action centre"
        title="What needs you"
        description="Approvals, decisions and anything that failed. Items stay here until they are done — reading one does not close it."
      />

      <Row>
        <Button variant={tab === 'open' ? 'primary' : 'secondary'} onClick={() => setTab('open')}>
          Needs you{tab === 'open' && openCount > 0 ? ` (${openCount})` : ''}
        </Button>
        <Button variant={tab === 'all' ? 'primary' : 'secondary'} onClick={() => setTab('all')}>
          Everything
        </Button>
      </Row>

      <ErrorText>{error}</ErrorText>

      <Section className="cq-section--table">
        {loading ? (
          <p className="cq-muted">Loading…</p>
        ) : items.length === 0 ? (
          <EmptyState title={tab === 'open' ? 'Nothing is waiting on you' : 'Nothing here yet'}>
            {tab === 'open'
              ? 'Approvals and decisions land here as they arrive. An empty list means there is genuinely nothing outstanding.'
              : 'Notifications appear here as work moves through the system.'}
          </EmptyState>
        ) : (
          <Stack>
            {items.map((item) => (
              <div key={item.id} className="cq-card">
                <Stack>
                  <Row between>
                    <Row>
                      <strong>{item.title}</strong>
                      {item.urgency === 'URGENT' ? <Badge tone="danger">Urgent</Badge> : null}
                      {item.state === 'UNREAD' ? <Badge tone="accent">New</Badge> : null}
                      {item.state === 'RESOLVED' ? <Badge tone="success">Done</Badge> : null}
                      {item.state === 'DISMISSED' ? <Badge>Dismissed</Badge> : null}
                    </Row>
                    <span className="cq-muted">{formatDateTime(item.createdAt)}</span>
                  </Row>

                  <p>{item.body}</p>

                  {item.state === 'RESOLVED' ? (
                    <p className="cq-muted">
                      {item.resolvedByName
                        ? `Marked done by ${item.resolvedByName}.`
                        : 'Closed automatically because the work behind it was done.'}
                    </p>
                  ) : null}

                  {item.requiresAction && item.state !== 'RESOLVED' && item.state !== 'DISMISSED' ? (
                    <Row>
                      {item.actionUrl ? (
                        <Button onClick={() => { window.location.href = item.actionUrl!; }}>
                          Open
                        </Button>
                      ) : null}
                      <Button variant="secondary" disabled={busy} onClick={() => void act(item.id, 'resolve')}>
                        Mark done
                      </Button>
                      <Button variant="secondary" disabled={busy} onClick={() => void act(item.id, 'dismiss')}>
                        Dismiss
                      </Button>
                    </Row>
                  ) : null}
                </Stack>
              </div>
            ))}
          </Stack>
        )}
      </Section>

      <Preferences />
    </Stack>
  );
}

/**
 * Delivery preferences.
 *
 * The copy carries the one rule people most need to trust: **turning a channel
 * off, or setting quiet hours, never hides anything from this screen.** A user
 * who believes silencing email might lose them a task will not silence email, and
 * will instead stop reading it — which is worse for everyone.
 */
function Preferences() {
  const ctx = useSessionCtx();
  const [prefs, setPrefs] = useState<NotificationPreferences | null>(null);
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [digest, setDigest] = useState<NotificationDigest>('IMMEDIATE');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * Whether the editable fields have been filled from the server yet.
   *
   * A ref rather than state because nothing renders differently for it, and because
   * it must be readable inside `load` without putting `load` back in its own
   * dependency list.
   */
  const seeded = useRef(false);

  const load = useCallback(async () => {
    if (!ctx) return;
    try {
      const { preferences } = await api.notificationPreferences(ctx.accessToken);
      setPrefs(preferences);
      /*
       * **Seeded once, and never re-seeded over somebody's typing.**
       *
       * Honest about its provenance: this was written while chasing an intermittent
       * failure of the "quiet hours are set" browser case, and it did **not** turn out
       * to be the cause — the case failed twice and then passed twice with this code
       * both present and reverted, so that flake is still unexplained. What is kept
       * here is the mechanism the search turned up, which is real on its own terms and
       * is the same one the profile page's `loading && !data` comment describes from
       * the other direction.
       *
       * `ctx` comes from `useSessionCtx`, which memoizes on the session object, and
       * `refreshUser()` mints a new session — so this effect re-runs at moments
       * nobody chose, including while a form is half filled in. The old version
       * answered that by overwriting `start`/`end`/`digest` with the stored values.
       * Losing the text would have been bad enough; what actually happened is worse,
       * because `save` sends the *state*, so the next click submitted the values the
       * server already had and saving appeared to silently do nothing.
       *
       * `prefs` above is still refreshed every time, so the "Quiet from …" summary
       * keeps telling the truth about what is stored. Only the inputs are left
       * alone, because they belong to whoever is typing in them.
       */
      if (!seeded.current) {
        seeded.current = true;
        setStart(preferences.quietHoursStart ?? '');
        setEnd(preferences.quietHoursEnd ?? '');
        setDigest(preferences.digest);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load your preferences');
    }
  }, [ctx]);

  useEffect(() => {
    void load();
  }, [load]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!ctx) return;

    /*
     * The submitted form is the source of truth for the submitted values.
     *
     * These controls are still controlled because their live values drive the
     * digest hint. React state, however, is an asynchronous rendering model: an
     * input event and a submit can be delivered in one browser task before the
     * state update has produced a new `save` closure. The old implementation read
     * `start` and `end` here, so the fields could visibly contain 22:00 / 07:00
     * while the request carried two nulls. Reading the successful controls from
     * the submit event removes that timing boundary; it is also how a native form
     * defines what was submitted.
     */
    const form = new FormData(e.currentTarget as HTMLFormElement);
    const submittedStart = String(form.get('quiet-start') ?? '');
    const submittedEnd = String(form.get('quiet-end') ?? '');
    const submittedDigest = String(form.get('digest') ?? 'IMMEDIATE') as NotificationDigest;

    // A half-window is almost certainly an unfinished edit. Clearing the stored
    // pair would be a successful but destructive answer, so refuse it on-screen.
    if ((submittedStart === '') !== (submittedEnd === '')) {
      setSaved(false);
      setError('Set both ends of quiet hours, or leave both blank.');
      return;
    }

    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const both = submittedStart !== '' && submittedEnd !== '';
      const { preferences } = await api.saveNotificationPreferences(ctx.accessToken, {
        quietHoursStart: both ? submittedStart : null,
        quietHoursEnd: both ? submittedEnd : null,
        digest: submittedDigest,
      });
      setPrefs(preferences);
      // Canonicalise the editable state to the values the API accepted. This is
      // normally a no-op; it matters if a browser normalises a time input.
      setStart(preferences.quietHoursStart ?? '');
      setEnd(preferences.quietHoursEnd ?? '');
      setDigest(preferences.digest);
      setSaved(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save your preferences');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section
      title="Delivery preferences"
      description="When CrewQuo may email you or send a push notification."
    >
      <Stack>
        <Notice>
          Quiet hours and digests hold back email and push only. <strong>Anything waiting on
          you still appears on this screen straight away</strong> — silencing or batching a
          channel can never hide a task from you. A digest batches email; push is never
          batched, because one notification standing in for six is not a summary.
        </Notice>
        <form onSubmit={save} aria-label="Delivery preferences">
          <Stack>
            <div className="cq-form-grid">
              <Field label="Quiet hours start" hint="Leave both blank for no quiet hours.">
                <Input
                  name="quiet-start"
                  type="time"
                  value={start}
                  onChange={(e) => setStart(e.target.value)}
                  disabled={busy}
                />
              </Field>
              <Field label="Quiet hours end" hint="A window may run past midnight, e.g. 22:00 to 07:00.">
                <Input
                  name="quiet-end"
                  type="time"
                  value={end}
                  onChange={(e) => setEnd(e.target.value)}
                  disabled={busy}
                />
              </Field>
              <Field
                label="Email digest"
                hint={
                  digest === 'IMMEDIATE'
                    ? 'One email per event.'
                    : digest === 'HOURLY'
                      ? 'One email per hour, covering everything raised in it.'
                      : `One email a day, at ${end || '08:00'}.`
                }
              >
                <Select
                  name="digest"
                  value={digest}
                  onChange={(e) => setDigest(e.target.value as NotificationDigest)}
                  disabled={busy}
                >
                  <option value="IMMEDIATE">Send each one</option>
                  <option value="HOURLY">Hourly summary</option>
                  <option value="DAILY">Daily summary</option>
                </Select>
              </Field>
            </div>
            <Row>
              <Button type="submit" disabled={busy}>
                {busy ? 'Saving…' : 'Save preferences'}
              </Button>
              {saved ? <Badge tone="success">Saved</Badge> : null}
              {prefs?.quietHoursStart ? (
                <span className="cq-muted">
                  Quiet from {prefs.quietHoursStart} to {prefs.quietHoursEnd}
                </span>
              ) : null}
              <ErrorText>{error}</ErrorText>
            </Row>
          </Stack>
        </form>
      </Stack>
    </Section>
  );
}
