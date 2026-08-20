import type { SessionRevokeCause, SessionView } from '@crewquo/shared';
import { classifyRefreshToken, sessionState, type RefreshPresentation } from '@crewquo/shared';
import { query, queryOne, withTransaction, type Queryable } from '../../db';
import { hashRefreshToken } from './tokens';

/**
 * Sessions and refresh-token lineage (CREWQUO_V2_PLAN.md §42).
 * Operating-model packet: `docs/operating-model/access.md` §3.
 *
 * **A session is the row a person acts on; tokens are its lineage.** Ending "a
 * token" means nothing to the owner of a lost phone — the token they signed in
 * with was retired the next time they opened the app. So every revocation in this
 * file ends a *session*, and the tokens follow.
 *
 * This replaces `refreshTokens.ts`, whose four functions had no notion of a family
 * and so could not express the one operation reuse detection needs: revoke
 * everything descended from a compromised sign-in.
 */

export interface PresentedToken {
  presentation: RefreshPresentation;
  /** Present whenever the hash matched a row, whatever state it was in. */
  token: { id: string; userId: string; sessionId: string | null } | null;
}

interface PresentedRow {
  id: string;
  user_id: string;
  session_id: string | null;
  expired: boolean;
  session_revoked: boolean;
  rotated_age_seconds: string | null;
  revoked_without_rotation: boolean;
}

/**
 * Look up a presented refresh token and say what it means.
 *
 * The facts are gathered in one query and classified by a pure function, because
 * the classification is where a mistake is expensive in both directions: a false
 * `REUSE` signs a working user out of every device they own, and a missed one
 * throws away the only theft signal this product has.
 *
 * **Ages are computed by Postgres, not Node.** The grace window is two minutes, and
 * a container whose clock has drifted by more than that would otherwise either open
 * the window permanently or close it entirely — both silently.
 */
export async function findPresentedToken(token: string): Promise<PresentedToken> {
  const row = await queryOne<PresentedRow>(
    `select t.id, t.user_id, t.session_id,
            (t.expires_at <= now()) as expired,
            (s.revoked_at is not null) as session_revoked,
            extract(epoch from (now() - t.rotated_at))::text as rotated_age_seconds,
            (t.revoked_at is not null and t.rotated_at is null) as revoked_without_rotation
       from refresh_tokens t
       left join auth_sessions s on s.id = t.session_id
      where t.token_hash = $1`,
    [hashRefreshToken(token)]
  );

  const presentation = classifyRefreshToken({
    found: row !== null,
    expired: row?.expired ?? false,
    sessionRevoked: row?.session_revoked ?? false,
    rotatedAgeSeconds:
      row?.rotated_age_seconds === null || row?.rotated_age_seconds === undefined
        ? null
        : Number(row.rotated_age_seconds),
    revokedWithoutRotation: row?.revoked_without_rotation ?? false,
  });

  return {
    presentation,
    token: row ? { id: row.id, userId: row.user_id, sessionId: row.session_id } : null,
  };
}

/** Open a session and mint its first token, in one transaction. */
export async function startSession(
  input: { userId: string; deviceLabel: string | null; tokenHash: string; expiresAt: Date },
  runner?: Queryable
): Promise<{ sessionId: string }> {
  const run = async (client: Queryable): Promise<{ sessionId: string }> => {
    const session = await queryOne<{ id: string }>(
      `insert into auth_sessions (user_id, device_label, expires_at)
       values ($1, $2, $3) returning id`,
      [input.userId, input.deviceLabel, input.expiresAt],
      client
    );
    await query(
      `insert into refresh_tokens (user_id, token_hash, expires_at, session_id)
       values ($1, $2, $3, $4)`,
      [input.userId, input.tokenHash, input.expiresAt, session!.id],
      client
    );
    return { sessionId: session!.id };
  };
  return runner ? run(runner) : withTransaction(run);
}

/**
 * Exchange a token for a successor inside the same session.
 *
 * The retirement is a **single conditional update** — `where id = $1 and
 * revoked_at is null` — so when two devices refresh the same token at once the
 * database picks the winner and the loser is handed a `false`. That is the whole
 * concurrency story from §3.
 *
 * `expectRetire` is false only on a grace-window re-rotation, where the presented
 * token is *already* retired and must not be retired again: the conditional would
 * report a loss that never happened. **This is the branch where a family can grow
 * a second live leaf** — the winner's successor and the loser's — and that is
 * accepted rather than fixed, because the alternative is handing back a token the
 * server cannot re-derive (only the hash is stored) or revoking the successor the
 * winner is already using. Both leaves die together when the session ends.
 */
export async function rotateRefreshToken(input: {
  tokenId: string;
  sessionId: string;
  userId: string;
  newTokenHash: string;
  expiresAt: Date;
  expectRetire: boolean;
}): Promise<boolean> {
  return withTransaction(async (client) => {
    /*
     * **Lock the session first, and refuse if it has gone.**
     *
     * Without this there is a window: the token classifies as `LIVE`, the holder
     * hits "sign out other devices" on another tab, and this transaction then
     * inserts a successor into a session that is already revoked — a live token row
     * inside a dead session. Nothing unsafe came of it (the next refresh reads the
     * session and refuses, and the access token fails the middleware check), but the
     * device list and the tokens table would disagree about what is signed in, and
     * that is the sort of disagreement that gets discovered during an incident.
     *
     * `for update` also serialises two devices rotating the same session, which
     * makes the conditional retirement below a clean win-or-lose rather than a race
     * with itself. Locks are taken in the same order as `revokeSessionsWhere`
     * (session, then tokens), so the two cannot deadlock against each other.
     */
    const session = await queryOne<{ id: string }>(
      `select id from auth_sessions where id = $1 and revoked_at is null for update`,
      [input.sessionId],
      client
    );
    if (!session) return false;

    if (input.expectRetire) {
      const retired = await queryOne<{ id: string }>(
        `update refresh_tokens set revoked_at = now(), rotated_at = now()
          where id = $1 and revoked_at is null
          returning id`,
        [input.tokenId],
        client
      );
      if (!retired) return false;
    }

    await query(
      `insert into refresh_tokens (user_id, token_hash, expires_at, session_id, parent_id)
       values ($1, $2, $3, $4, $5)`,
      [input.userId, input.newTokenHash, input.expiresAt, input.sessionId, input.tokenId],
      client
    );

    // The session's own expiry slides with its newest token, so "is this session
    // live" stays answerable from the session row alone — which is what lets the
    // auth middleware check a session it was given only an id for.
    await query(
      `update auth_sessions set last_used_at = now(), expires_at = $2
        where id = $1 and revoked_at is null`,
      [input.sessionId, input.expiresAt],
      client
    );
    return true;
  });
}

export interface RevokeSessionsInput {
  cause: SessionRevokeCause;
  /** An operator's stated reason (§13.2). Null for everything a user does themselves. */
  reason?: string | null;
  revokedByUserId?: string | null;
}

const REVOKE_SESSIONS_SQL = `update auth_sessions
     set revoked_at = now(), revoked_cause = $1, revoked_reason = $2, revoked_by_user_id = $3
   where revoked_at is null`;

/**
 * End sessions and every live token in them.
 *
 * One transaction, tokens first by session id, because a session marked revoked
 * whose tokens still refresh is the worst of both worlds: the device list says
 * "ended" and the device carries on working.
 */
async function revokeSessionsWhere(
  clause: string,
  params: unknown[],
  input: RevokeSessionsInput,
  runner?: Queryable
): Promise<number> {
  const run = async (client: Queryable): Promise<number> => {
    const ended = await query<{ id: string }>(
      `${REVOKE_SESSIONS_SQL} and ${clause} returning id`,
      [input.cause, input.reason ?? null, input.revokedByUserId ?? null, ...params],
      client
    );
    if (ended.length === 0) return 0;
    await query(
      `update refresh_tokens set revoked_at = now()
        where session_id = any($1::uuid[]) and revoked_at is null`,
      [ended.map((row) => row.id)],
      client
    );
    return ended.length;
  };
  return runner ? run(runner) : withTransaction(run);
}

/** One session, and only if it belongs to this user. */
export function revokeSession(
  sessionId: string,
  userId: string,
  input: RevokeSessionsInput,
  runner?: Queryable
): Promise<number> {
  return revokeSessionsWhere('id = $4 and user_id = $5', [sessionId, userId], input, runner);
}

/** Every session this user has, used by password reset and the operator path. */
export function revokeAllSessions(
  userId: string,
  input: RevokeSessionsInput,
  runner?: Queryable
): Promise<number> {
  return revokeSessionsWhere('user_id = $4', [userId], input, runner);
}

/**
 * Every session except one — "sign out my other devices".
 *
 * Keeping the current one is the difference between a control people use and one
 * they avoid: an action that also signs *you* out reads as a mistake you just made.
 */
export function revokeOtherSessions(
  userId: string,
  keepSessionId: string,
  input: RevokeSessionsInput,
  runner?: Queryable
): Promise<number> {
  return revokeSessionsWhere(
    'user_id = $4 and id <> $5',
    [userId, keepSessionId],
    input,
    runner
  );
}

interface SessionRow {
  id: string;
  device_label: string | null;
  created_at: Date;
  last_used_at: Date;
  expires_at: Date;
  revoked_at: Date | null;
  revoked_cause: SessionRevokeCause | null;
}

/**
 * The caller's own device list.
 *
 * Live sessions, plus a short tail of recently-ended ones — §7's "pruned after
 * expiry plus a short forensic tail, so *when did that device last sign in*
 * survives the token". The tail is the half that answers the question somebody
 * actually asks after a scare: not "what is signed in now", which they can see,
 * but "what *was*, and when did it stop".
 *
 * Sessions predating 0018 have no row and cannot appear. That is stated in the
 * migration rather than papered over here: inventing a device for every historical
 * token would fill this list with phantoms nobody lost.
 */
export async function listSessions(
  userId: string,
  currentSessionId: string | null,
  tailDays = 30
): Promise<SessionView[]> {
  const rows = await query<SessionRow>(
    `select id, device_label, created_at, last_used_at, expires_at, revoked_at, revoked_cause
       from auth_sessions
      where user_id = $1
        and (revoked_at is null or revoked_at > now() - ($2 || ' days')::interval)
      order by (revoked_at is null) desc, last_used_at desc
      limit 50`,
    [userId, String(tailDays)]
  );

  return rows.map((row) => ({
    id: row.id,
    deviceLabel: row.device_label,
    state: sessionState({
      revokedAt: row.revoked_at?.toISOString() ?? null,
      expiresAt: row.expires_at.toISOString(),
    }),
    current: row.id === currentSessionId,
    createdAt: row.created_at.toISOString(),
    lastUsedAt: row.last_used_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
    endedAt: row.revoked_at?.toISOString() ?? null,
    endedCause: row.revoked_cause,
  }));
}

/**
 * Is this session still usable? Asked by `requireAuth` on every request that
 * carries a `sid` claim.
 *
 * **This is what makes "end that device" immediate rather than eventual.** The
 * packet's honest bound was the next refresh — up to fifteen minutes of a
 * still-valid access token after a phone is reported lost — and one indexed read,
 * issued in parallel with the user lookup that already happens, closes it. The
 * offline caveat in §8 still stands and is not affected: a revocation cannot reach
 * data a stolen device has already cached.
 */
export async function sessionIsLive(sessionId: string, userId: string): Promise<boolean> {
  const row = await queryOne<{ id: string }>(
    `select id from auth_sessions
      where id = $1 and user_id = $2 and revoked_at is null and expires_at > now()`,
    [sessionId, userId]
  );
  return row !== null;
}

/**
 * Drop sessions long past their expiry, and the tokens with them.
 *
 * The forensic tail is why this is not "delete on expiry": a device that expired
 * last week is still the answer to "when did that thing last sign in". Beyond the
 * tail it is neither evidence nor state — the durable record of a revocation lives
 * in `platform_audit_logs`, which no purge touches.
 */
export async function pruneAuthSessions(olderThanDays = 90): Promise<number> {
  const row = await queryOne<{ pruned: string }>(
    `with gone as (
       delete from auth_sessions
        where expires_at < now() - ($1 || ' days')::interval
          and (revoked_at is null or revoked_at < now() - ($1 || ' days')::interval)
       returning 1
     )
     select count(*)::text as pruned from gone`,
    [String(olderThanDays)]
  );
  return Number(row?.pruned ?? 0);
}
