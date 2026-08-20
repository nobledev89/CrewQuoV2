import { createHash, createHmac, randomBytes } from 'node:crypto';
import {
  RECOVERY_CODE_COUNT,
  base32Decode,
  base32Encode,
  formatRecoveryCode,
  normalizeRecoveryCode,
  totpCounter,
  totpCounterBytes,
  totpMatch,
  type MfaEnrolmentState,
} from '@crewquo/shared';
import { query, queryOne, withTransaction, type Queryable } from '../../db';

/**
 * Second-factor persistence and the crypto the pure layer cannot do.
 * Operating-model packet: `docs/operating-model/access.md` §3.
 *
 * The split is the same one 0016 and 0018 used: `packages/shared/src/totp.ts` holds
 * the algorithm and the policy, pinned against RFC 6238's published vectors, and
 * this file holds the HMAC, the randomness and the rows. Everything here that could
 * be decided without a database has been moved out of it.
 */

export interface FactorRow {
  id: string;
  user_id: string;
  secret: string;
  status: 'PENDING' | 'ACTIVE';
  confirmed_at: Date | null;
  last_counter: string | null;
}

export function findFactor(userId: string, runner?: Queryable): Promise<FactorRow | null> {
  return queryOne<FactorRow>(
    `select id, user_id, secret, status, confirmed_at, last_counter
       from auth_factors where user_id = $1 and kind = 'TOTP'`,
    [userId],
    runner
  );
}

export function factorState(row: FactorRow | null): MfaEnrolmentState {
  if (!row) return 'NONE';
  return row.status === 'ACTIVE' ? 'ACTIVE' : 'PENDING';
}

/**
 * Issue a secret and park it as `PENDING`.
 *
 * **Re-enrolling replaces a pending row rather than adding one**, which the unique
 * index enforces and this upsert relies on. Accumulating abandoned secrets would
 * leave every half-finished attempt as a working way in — and somebody who
 * restarts enrolment three times because the first QR would not scan should not be
 * leaving two live secrets behind them.
 *
 * **An `ACTIVE` factor is never overwritten here.** Replacing a confirmed factor
 * without the step-up removal path would make "start enrolment" a way to swap
 * somebody's second factor for your own, which is exactly what a stolen access
 * token would reach for.
 */
export async function beginEnrolment(userId: string): Promise<{ secret: string } | null> {
  // 20 bytes = 160 bits, RFC 4226's recommended length and what every
  // authenticator app expects; 32 base32 characters when encoded.
  const secret = base32Encode(new Uint8Array(randomBytes(20)));
  const row = await queryOne<{ id: string }>(
    `insert into auth_factors (user_id, kind, secret, status)
     values ($1, 'TOTP', $2, 'PENDING')
     on conflict (user_id, kind) do update
       set secret = excluded.secret, status = 'PENDING', confirmed_at = null,
           last_counter = null, updated_at = now()
      where auth_factors.status = 'PENDING'
     returning id`,
    [userId, secret]
  );
  return row ? { secret } : null;
}

/** The HMAC-SHA1 digest RFC 6238 truncates, for one counter. */
function digestFor(secretBase32: string): (counter: number) => Uint8Array {
  const key = Buffer.from(base32Decode(secretBase32));
  return (counter) =>
    new Uint8Array(createHmac('sha1', key).update(totpCounterBytes(counter)).digest());
}

export type CodeVerdict = 'OK' | 'WRONG' | 'REPLAY';

/**
 * Check a code against a factor and consume it.
 *
 * **`REPLAY` is a distinct answer from `WRONG`.** A code presented twice is right
 * but spent, and the two mean different things: one is somebody mistyping, the
 * other is somebody using a code they watched being typed. Collapsing them would
 * throw away the second signal, and returning `OK` would leave every code valid for
 * its whole 90-second window.
 *
 * The counter comparison is a single conditional update, so two requests racing the
 * same code cannot both win — the database picks one and the other reads as a
 * replay, which is precisely what it is.
 */
export async function verifyCode(
  row: FactorRow,
  code: string,
  nowMs = Date.now()
): Promise<CodeVerdict> {
  const matched = totpMatch({
    code,
    counter: totpCounter(nowMs),
    digestFor: digestFor(row.secret),
  });
  if (matched === null) return 'WRONG';

  const last = row.last_counter === null ? null : Number(row.last_counter);
  if (last !== null && matched <= last) return 'REPLAY';

  const consumed = await queryOne<{ id: string }>(
    `update auth_factors
        set last_counter = $2, updated_at = now()
      where id = $1 and (last_counter is null or last_counter < $2)
      returning id`,
    [row.id, matched]
  );
  return consumed ? 'OK' : 'REPLAY';
}

/** Promote a proven enrolment, and hand back whether it was already active. */
export async function activateFactor(factorId: string, runner?: Queryable): Promise<void> {
  await query(
    `update auth_factors set status = 'ACTIVE', confirmed_at = coalesce(confirmed_at, now()),
            updated_at = now()
      where id = $1`,
    [factorId],
    runner
  );
}

export async function removeFactor(userId: string, runner?: Queryable): Promise<number> {
  const run = async (client: Queryable): Promise<number> => {
    const gone = await query<{ id: string }>(
      `delete from auth_factors where user_id = $1 and kind = 'TOTP' returning id`,
      [userId],
      client
    );
    // The codes go with it. Leaving them would mean a later re-enrolment inherited
    // a set of recovery codes printed for a factor that no longer exists — and
    // whoever holds that piece of paper would be able to spend one.
    await query(`delete from auth_recovery_codes where user_id = $1`, [userId], client);
    return gone.length;
  };
  return runner ? run(runner) : withTransaction(run);
}

// ── Recovery codes ────────────────────────────────────────────────────────────

/** SHA-256, matching `refresh_tokens` — see the migration for why not bcrypt. */
function hashRecoveryCode(code: string): string {
  return createHash('sha256').update(normalizeRecoveryCode(code)).digest('hex');
}

/**
 * Mint a fresh set, invalidating every previous one.
 *
 * **Regenerating replaces rather than appends**, because a person who regenerates
 * has usually lost track of the old sheet, and a code from a sheet you no longer
 * control is a credential you no longer control.
 */
export async function issueRecoveryCodes(userId: string): Promise<string[]> {
  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, () =>
    // 50 bits: hopeless to guess, short enough to read off paper and retype.
    formatRecoveryCode(base32Encode(new Uint8Array(randomBytes(7))).slice(0, 10))
  );
  await withTransaction(async (client) => {
    await query(`delete from auth_recovery_codes where user_id = $1`, [userId], client);
    for (const code of codes) {
      await query(
        `insert into auth_recovery_codes (user_id, code_hash) values ($1, $2)
         on conflict (user_id, code_hash) do nothing`,
        [userId, hashRecoveryCode(code)],
        client
      );
    }
  });
  return codes;
}

export async function countRecoveryCodes(userId: string): Promise<number> {
  const row = await queryOne<{ n: string }>(
    `select count(*)::text as n from auth_recovery_codes
      where user_id = $1 and used_at is null`,
    [userId]
  );
  return Number(row?.n ?? 0);
}

/**
 * Spend a recovery code, once.
 *
 * A single conditional update on `used_at is null`, so two simultaneous
 * presentations of the same code cannot both succeed — the same set-once shape the
 * notification transitions and the token rotation use.
 */
export async function spendRecoveryCode(userId: string, code: string): Promise<CodeVerdict> {
  const hash = hashRecoveryCode(code);
  const row = await queryOne<{ id: string }>(
    `update auth_recovery_codes set used_at = now()
      where user_id = $1 and code_hash = $2 and used_at is null
      returning id`,
    [userId, hash]
  );
  if (row) return 'OK';

  /*
   * **Distinguishes a spent code from an unknown one**, for the same reason the TOTP
   * path does. Somebody reading a printed sheet who is told "did not match" concludes
   * the sheet is wrong and stops; told "already used", they try the next line — which
   * is the fix, and the only one available to them.
   *
   * The disclosure is that a presented code once existed on this account. These are
   * fifty bits of machine randomness, so nobody reaches this branch by guessing;
   * whoever is holding the code already had it.
   */
  const spent = await queryOne<{ id: string }>(
    `select id from auth_recovery_codes
      where user_id = $1 and code_hash = $2 and used_at is not null`,
    [userId, hash]
  );
  return spent ? 'REPLAY' : 'WRONG';
}
