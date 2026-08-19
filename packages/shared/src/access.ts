/**
 * Access hardening — rate-limit policy (CREWQUO_V2_PLAN.md §42).
 * Operating-model packet: `docs/operating-model/access.md`.
 *
 * Pure, because the interesting part of a rate limiter is not the counting — the
 * database does that — but the *policy*, and policy is where the two failure modes
 * live. Too loose and `POST /v1/auth/login` stays what it is today: unlimited free
 * guesses against accounts that all have exactly one factor. Too tight, or keyed on
 * the wrong thing, and the limiter becomes an availability weapon that anybody can
 * point at anybody by typing their email address wrong on purpose.
 */

export const AUTH_RATE_SCOPES = ['LOGIN', 'RESET', 'REGISTER'] as const;
export type AuthRateScope = (typeof AUTH_RATE_SCOPES)[number];

export interface RateLimitBudget {
  /** How many failures are tolerated inside the window. */
  max: number;
  windowSeconds: number;
}

export interface AuthRatePolicy {
  /** Keyed on the email address being attempted. Deliberately the looser budget. */
  identity: RateLimitBudget;
  /** Keyed on the caller. Deliberately the tighter budget — this stops the attacker. */
  source: RateLimitBudget;
}

/**
 * **The identity budget is looser than the source budget, and that asymmetry is the
 * whole design.**
 *
 * Keying only on the email address hands anybody a lockout button for anybody
 * else's account: guess wrong at Dana ten times and Dana cannot sign in. Keying
 * only on the caller lets a distributed attacker spread guesses thin. So both are
 * counted, and the source budget is the one that bites first — an attacker working
 * through a credential list from anywhere is stopped by their own volume long before
 * their victim's address is exhausted.
 *
 * The residual risk is stated rather than pretended away: a genuinely distributed
 * attacker *can* still exhaust one address's budget and lock its owner out for the
 * window. That is why exhausting it raises a notification to the account holder —
 * a lockout the owner is told about is an incident; a silent one is a mystery.
 *
 * Register is source-keyed only: there is no account yet to key an identity budget
 * to, and keying on the requested address would let somebody reserve an address by
 * failing at it.
 */
export const AUTH_RATE_POLICIES: Readonly<Record<AuthRateScope, AuthRatePolicy>> = {
  LOGIN: {
    identity: { max: 10, windowSeconds: 15 * 60 },
    source: { max: 30, windowSeconds: 15 * 60 },
  },
  // Reset emails leave the platform and land in somebody's inbox, so the abuse here
  // is mail-bombing an address rather than guessing a secret. Tighter on identity
  // than login for exactly that reason — this is the one scope where the identity
  // budget protects the *recipient* rather than gating the *attacker*.
  RESET: {
    identity: { max: 5, windowSeconds: 60 * 60 },
    source: { max: 15, windowSeconds: 60 * 60 },
  },
  REGISTER: {
    identity: { max: Number.POSITIVE_INFINITY, windowSeconds: 60 * 60 },
    source: { max: 10, windowSeconds: 60 * 60 },
  },
};

export interface RateLimitDecision {
  allowed: boolean;
  /** Seconds until the caller may try again. Always a whole number, always ≥ 1. */
  retryAfterSeconds: number;
  /** Which budget ran out. `null` when allowed. */
  exhausted: 'identity' | 'source' | null;
}

export interface RateLimitFacts {
  /** Failed attempts against this address inside the identity window. */
  identityFailures: number;
  /** Failed attempts from this caller inside the source window. */
  sourceFailures: number;
  /**
   * Age in seconds of the *oldest* failure still inside each window. The wait is
   * until that one falls out, which is when a slot frees — not the whole window,
   * which would round every wait up to the maximum and read as a punishment.
   */
  oldestIdentityFailureAgeSeconds: number | null;
  oldestSourceFailureAgeSeconds: number | null;
}

/**
 * May this attempt proceed, and if not, for how long.
 *
 * Counts **failures only**. A successful sign-in must never consume budget, or a
 * person working normally on a shared office address eventually locks out their own
 * colleagues — which is a support ticket that looks exactly like an attack and is
 * resolved by turning the limiter off.
 *
 * Source is evaluated before identity so the refusal names the budget that actually
 * bit. When an attacker is stopped, the message should be about them, not about the
 * address they were aiming at.
 */
export function rateLimitDecision(
  policy: AuthRatePolicy,
  facts: RateLimitFacts
): RateLimitDecision {
  const wait = (budget: RateLimitBudget, oldestAgeSeconds: number | null): number =>
    Math.max(1, Math.ceil(budget.windowSeconds - (oldestAgeSeconds ?? 0)));

  if (facts.sourceFailures >= policy.source.max) {
    return {
      allowed: false,
      exhausted: 'source',
      retryAfterSeconds: wait(policy.source, facts.oldestSourceFailureAgeSeconds),
    };
  }
  if (facts.identityFailures >= policy.identity.max) {
    return {
      allowed: false,
      exhausted: 'identity',
      retryAfterSeconds: wait(policy.identity, facts.oldestIdentityFailureAgeSeconds),
    };
  }
  return { allowed: true, exhausted: null, retryAfterSeconds: 0 };
}

/**
 * What the caller is told when they are refused.
 *
 * **Says nothing about whether the account exists**, which is the entire point: a
 * limiter that says "too many attempts for this account" is a better
 * account-existence oracle than the thing it was added to protect. One sentence, one
 * number, no nouns that imply a lookup happened.
 */
export function rateLimitMessage(retryAfterSeconds: number): string {
  const minutes = Math.ceil(retryAfterSeconds / 60);
  const wait = minutes <= 1 ? 'a minute' : `${minutes} minutes`;
  return `Too many attempts. Try again in about ${wait}.`;
}

/**
 * Should exhausting this budget tell the account holder?
 *
 * Only an identity lockout is worth an email, and only on `LOGIN`. A source lockout
 * is somebody hitting their own limit and means nothing to the account owner; a
 * reset lockout is *already* mail to that address, so mailing about it is the abuse
 * repeating itself.
 *
 * The notification is then rate-limited by the lockout it reports — one per window,
 * because the window is what has to elapse before another can happen. An alert per
 * failed attempt turns the sign-in form into a mail bomb aimed at any address the
 * attacker picks, which is a worse hole than the one being closed.
 */
export function shouldNotifyLockout(
  scope: AuthRateScope,
  decision: RateLimitDecision
): boolean {
  return scope === 'LOGIN' && !decision.allowed && decision.exhausted === 'identity';
}

/**
 * The stored form of an email for rate-limit counting.
 *
 * Lower-cased and trimmed so `Dana@x.test` and `dana@x.test ` share one budget —
 * without it, case alone multiplies an attacker's allowance by however many
 * spellings they care to type.
 */
export function rateLimitIdentityKey(email: string): string {
  return email.trim().toLowerCase();
}
