import { createHash } from 'node:crypto';
import type { Request } from 'express';
import {
  AUTH_RATE_POLICIES,
  rateLimitDecision,
  rateLimitIdentityKey,
  rateLimitMessage,
  shouldNotifyLockout,
  type AuthRateScope,
  type RateLimitDecision,
} from '@crewquo/shared';
import { query, queryOne } from '../../db';
import { env } from '../../env';
import { AppError } from '../../http/errors';

/**
 * Rate limiting for the unauthenticated auth surface (§42).
 * Operating-model packet: `docs/operating-model/access.md` §10.
 *
 * The counting half. The policy half is pure and lives in `@crewquo/shared`,
 * because the interesting decisions — which budget bites first, what the refusal
 * is allowed to say, whether a lockout is worth an email — are all testable
 * without a database, and all easy to get subtly wrong.
 */

/**
 * A stable, non-reversible key for "the same caller again".
 *
 * Hashed because the limiter needs to compare sources and never needs to know
 * one: an un-hashed column here would be a log of which addresses signed in from
 * where, which is the location history the packet's §7 explicitly refuses to
 * build. Salted with the refresh-token secret so the hashes are not comparable
 * against a rainbow table of the IPv4 space, which is small enough to enumerate.
 */
function sourceKeyFor(req: Request): string {
  // `req.ip` honours Express's trust-proxy setting; falling back to the socket
  // keeps this working in tests and direct-connection dev.
  const raw = req.ip ?? req.socket.remoteAddress ?? 'unknown';
  return createHash('sha256')
    .update(`auth-source:${env.JWT_REFRESH_SECRET}:${raw}`)
    .digest('hex');
}

interface Counted {
  failures: number;
  oldestAgeSeconds: number | null;
}

async function countFailures(
  scope: AuthRateScope,
  column: 'identity_key' | 'source_key',
  key: string,
  windowSeconds: number
): Promise<Counted> {
  const row = await queryOne<{ failures: string; oldest_age: string | null }>(
    `select count(*)::text as failures,
            extract(epoch from (now() - min(occurred_at)))::text as oldest_age
       from auth_attempts
      where scope = $1 and ${column} = $2 and succeeded = false
        and occurred_at > now() - ($3 || ' seconds')::interval`,
    [scope, key, String(windowSeconds)]
  );
  return {
    failures: Number(row?.failures ?? 0),
    oldestAgeSeconds: row?.oldest_age === null || row?.oldest_age === undefined
      ? null
      : Number(row.oldest_age),
  };
}

export interface RateLimitContext {
  scope: AuthRateScope;
  identityKey: string | null;
  sourceKey: string;
  decision: RateLimitDecision;
}

/**
 * Read both budgets and decide, **without recording anything and without
 * throwing**.
 *
 * Separate from `enforceAuthRateLimit` because the caller needs to ask this
 * question twice per failed sign-in — once as a gate, and once afterwards to see
 * whether *this* failure was the one that exhausted the budget. Asking the
 * enforcing version the second time would record a second attempt and count every
 * failure twice, halving the real limit.
 */
export async function evaluateAuthRateLimit(
  req: Request,
  scope: AuthRateScope,
  email: string | null
): Promise<RateLimitContext> {
  const policy = AUTH_RATE_POLICIES[scope];
  const identityKey = email === null ? null : rateLimitIdentityKey(email);
  const sourceKey = sourceKeyFor(req);

  const [identity, source] = await Promise.all([
    identityKey === null || policy.identity.max === Number.POSITIVE_INFINITY
      ? Promise.resolve<Counted>({ failures: 0, oldestAgeSeconds: null })
      : countFailures(scope, 'identity_key', identityKey, policy.identity.windowSeconds),
    countFailures(scope, 'source_key', sourceKey, policy.source.windowSeconds),
  ]);

  return {
    scope,
    identityKey,
    sourceKey,
    decision: rateLimitDecision(policy, {
      identityFailures: identity.failures,
      sourceFailures: source.failures,
      oldestIdentityFailureAgeSeconds: identity.oldestAgeSeconds,
      oldestSourceFailureAgeSeconds: source.oldestAgeSeconds,
    }),
  };
}

/**
 * Refuse the attempt if either budget is spent, and hand back what the caller
 * needs to record its outcome.
 *
 * **Throws before the expensive work, not after.** The point is to stop bcrypt
 * being run tens of thousands of times by somebody with a word list — a limiter
 * checked after the hash comparison would still burn the CPU it exists to protect.
 */
export async function enforceAuthRateLimit(
  req: Request,
  scope: AuthRateScope,
  email: string | null
): Promise<RateLimitContext> {
  const ctx = await evaluateAuthRateLimit(req, scope, email);
  if (ctx.decision.allowed) return ctx;

  // A refused attempt is itself recorded, or an attacker who keeps hammering
  // after the lockout silently rolls the window forward off their earlier
  // failures and gets a fresh budget for free.
  await recordAuthAttempt(ctx, false);

  throw new AppError('RATE_LIMITED', rateLimitMessage(ctx.decision.retryAfterSeconds), {
    retryAfterSeconds: ctx.decision.retryAfterSeconds,
  });
}

/**
 * Record the outcome of an attempt that was allowed to proceed.
 *
 * Failures are what the budget counts; successes are stored so the ratio is
 * answerable — "logins are failing" and "nobody is logging in" look identical
 * without a denominator.
 */
export async function recordAuthAttempt(
  ctx: RateLimitContext,
  succeeded: boolean
): Promise<void> {
  await query(
    `insert into auth_attempts (scope, identity_key, source_key, succeeded)
     values ($1, $2, $3, $4)`,
    [ctx.scope, ctx.identityKey, ctx.sourceKey, succeeded]
  );
}

/**
 * Does this state deserve an email to the account holder? Packet §6.
 *
 * **Fires exactly once per lockout, and gets that for free rather than by
 * bookkeeping.** It is only ever asked immediately after a failure that was
 * *allowed* through the gate — so the first time it answers true is the attempt
 * that exhausted the budget. Every later attempt in that window is refused by
 * `enforceAuthRateLimit` before this code is reached, so there is no second
 * notification and no "have we already told them" flag to keep in sync.
 */
export function lockoutIsNotifiable(ctx: RateLimitContext): boolean {
  return shouldNotifyLockout(ctx.scope, ctx.decision);
}

/**
 * Drop attempt rows older than the longest window in use.
 *
 * These are operational counters, not evidence: the durable record that somebody
 * was locked out is a `platform_audit_logs` row, which is insert-only and outside
 * every purge. Pruning here can never erase that.
 */
export async function pruneAuthAttempts(olderThanHours = 48): Promise<number> {
  const row = await queryOne<{ pruned: string }>(
    `with gone as (
       delete from auth_attempts
        where occurred_at < now() - ($1 || ' hours')::interval
       returning 1
     )
     select count(*)::text as pruned from gone`,
    [String(olderThanHours)]
  );
  return Number(row?.pruned ?? 0);
}
