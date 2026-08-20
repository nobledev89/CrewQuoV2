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

export const AUTH_RATE_SCOPES = ['LOGIN', 'RESET', 'REGISTER', 'MFA'] as const;
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
  /*
   * Second-factor codes. **Tighter than login on identity, and the arithmetic is
   * why.** A six-digit code is a million possibilities and about three of them are
   * valid at any moment across the drift window, so an unlimited guesser reaches
   * even odds in roughly 300,000 attempts — minutes of scripted traffic. Ten
   * attempts per fifteen minutes turns that into centuries.
   *
   * The login budget does not cover this: the code is checked *after* the password
   * has already been accepted, on a different endpoint, against a challenge the
   * attacker legitimately holds. A separate scope also keeps the two histories
   * apart, so "somebody is guessing codes" is answerable without unpicking it from
   * "somebody is guessing passwords".
   */
  MFA: {
    identity: { max: 10, windowSeconds: 15 * 60 },
    source: { max: 20, windowSeconds: 15 * 60 },
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
 * Which lockout window a moment falls in.
 *
 * The notification for a lockout has to be **one per window**, and there is no
 * lockout *row* to key it on — the budget is a count over attempts, not an entity.
 * Flooring the clock into window-sized buckets supplies the missing identity:
 * a replayed notification inside one lockout collapses onto a single row, and the
 * next window is a different key.
 *
 * The bucket boundary does not line up with the lockout that produced it, so a
 * lockout starting near the end of a bucket can be followed by another notification
 * sooner than a full window later. That is the right way round: a bucket too coarse
 * *silences* an alert, and this domain would rather send one alarm too many than
 * swallow one.
 */
export function lockoutWindowBucket(
  nowMs: number,
  windowSeconds: number = AUTH_RATE_POLICIES.LOGIN.identity.windowSeconds
): number {
  return Math.floor(nowMs / (windowSeconds * 1000));
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

// ── Second factors ───────────────────────────────────────────────────────────

/**
 * Must this account hold a second factor? (§13.1, reaffirmed 2026-08-20.)
 *
 * **Platform staff only.** The asymmetry is the entire decision and it is worth
 * restating wherever it is enforced: a compromised *customer* password is one
 * tenant's incident, and a compromised *staff* password is every tenant's, because
 * staff read across the whole platform. So the mandate follows the blast radius,
 * not the seniority.
 *
 * Customer OWNER/ADMIN are **offered** a factor and never required to hold one —
 * rejected alternatives, both recorded in §13.1: super-admins-only (which leaves
 * every money-touching customer account on a password alone) and a per-company
 * policy toggle (a policy engine bought before anybody asked for it). And Crew-plan
 * field accounts are out of scope entirely: the persona logging hours from a car
 * park gets no new friction.
 */
export function mfaIsRequired(user: { isSuperAdmin: boolean }): boolean {
  return user.isSuperAdmin;
}

export const MFA_ENROLMENT_STATES = ['NONE', 'PENDING', 'ACTIVE'] as const;
export type MfaEnrolmentState = (typeof MFA_ENROLMENT_STATES)[number];

/**
 * May this request proceed, given what the account holds and what it is reaching
 * for?
 *
 * **Enforced on the platform surface rather than at sign-in**, which is the
 * narrowest place that achieves the goal. Blocking a staff *login* would lock an
 * operator out of their own customer-side account — many of them own a real
 * company — over a rule that exists to protect the platform console. Blocking the
 * console means the factor is required exactly where the blast radius is.
 *
 * `PENDING` is refused as firmly as `NONE`: a secret that was issued and never
 * proven is not a factor, it is an unfinished form, and treating it as protection
 * is how somebody ends up believing they have MFA when they have a QR code.
 */
export function platformAccessRefusal(input: {
  isSuperAdmin: boolean;
  factorState: MfaEnrolmentState;
}): string | null {
  if (!input.isSuperAdmin) return null;
  if (input.factorState === 'ACTIVE') return null;
  return input.factorState === 'PENDING'
    ? 'Finish setting up your authenticator app — enter a code to confirm it — before using the platform console'
    : 'Platform staff must set up an authenticator app before using the platform console';
}

// ── Sessions, rotation and reuse detection ───────────────────────────────────
//
// Build-order step 2 (`docs/operating-model/access.md` §14). Pure for the same
// reason the budgets above are: the counting is a `where` clause, and everything
// that can go wrong lives in the classification.

/**
 * How long a just-retired refresh token still rotates instead of raising the
 * alarm.
 *
 * **The window is what stops the alarm being useless.** Two devices refreshing at
 * once is the ordinary race, not an attack — a phone waking up while a laptop
 * polls, or this product's own web app mounting a second `AuthProvider` when a
 * sign-in crosses a route group, which it does on every sign-in. Without a grace
 * window those cases revoke the whole family, people get signed out at random,
 * and they learn to ignore the one alert that matters.
 *
 * **Two minutes (owner decision, 2026-08-20).** Shipped at thirty seconds; widened
 * deliberately, on the grounds that CrewQuo holds commercial terms rather than
 * moving money, and a false alarm here is expensive in a way this product feels
 * immediately — every one of them signs a working person out of every device they
 * own, on a platform whose field persona is already reluctant to record work.
 *
 * The cost is stated rather than hidden, and widening it makes the cost bigger: a
 * thief who replays a stolen token *within two minutes* of the victim is
 * indistinguishable from a slow client and is not caught. Two minutes is still far
 * short of what a stolen token is worth to somebody — its own lifetime is thirty
 * days — so the trade buys quiet at the edges without turning detection off. What
 * would turn it off is a window measured in hours, dressed up as tolerance for bad
 * networks.
 */
export const REFRESH_ROTATION_GRACE_SECONDS = 120;

export const REFRESH_PRESENTATIONS = ['LIVE', 'GRACE', 'REUSE', 'DEAD'] as const;
export type RefreshPresentation = (typeof REFRESH_PRESENTATIONS)[number];

export interface RefreshTokenFacts {
  /** Did the hash match a stored token at all? */
  found: boolean;
  /** Past its own `expires_at`. */
  expired: boolean;
  /** Its session has been ended — by the user, an operator, a reset, or reuse. */
  sessionRevoked: boolean;
  /** Seconds since it was retired by an exchange; null if it never was. */
  rotatedAgeSeconds: number | null;
  /** Revoked for any reason *other* than rotation. */
  revokedWithoutRotation: boolean;
}

/**
 * What a presented refresh token means.
 *
 * **`REUSE` is the only interesting answer, and every other branch exists to keep
 * something innocent out of it.** A false positive here signs a working user out
 * of every device they own, so the classification is deliberately conservative:
 * anything that could be an ordinary client — an expired token, a signed-out one,
 * a double-submit inside the grace window — is `DEAD` or `GRACE`, and `REUSE` is
 * reached only by a token that was exchanged for a successor and then presented
 * again later.
 *
 * The order of the branches is the design:
 *
 *  - **Not found first.** An unknown string is somebody guessing, or a client
 *    holding a token from a database that has since been reset. There is no family
 *    to revoke, so there is nothing to raise.
 *  - **A revoked session next, before rotation is even considered.** This is what
 *    makes the alarm fire *once*: the reuse that revoked the family leaves every
 *    other token in it revoked too, so the thief's next attempt — and the
 *    victim's, and every retry of both — is simply dead. Without this branch, one
 *    theft would notify the holder on every subsequent request.
 *  - **Expiry before reuse.** A token retired forty days ago and expired thirty
 *    days ago is not worth an alarm: the family it belonged to is already gone, so
 *    revoking it changes nothing and the email would be about an attack on nothing.
 *  - **Deliberate revocation before reuse.** Replaying a token from a sign-out is
 *    a client that has not noticed yet. Treating it as theft would fire the alarm
 *    at every sign-out, which is the fastest possible way to make the alarm
 *    ignored.
 */
export function classifyRefreshToken(
  facts: RefreshTokenFacts,
  graceSeconds: number = REFRESH_ROTATION_GRACE_SECONDS
): RefreshPresentation {
  if (!facts.found) return 'DEAD';
  if (facts.sessionRevoked) return 'DEAD';
  if (facts.expired) return 'DEAD';
  if (facts.revokedWithoutRotation) return 'DEAD';
  if (facts.rotatedAgeSeconds === null) return 'LIVE';
  return facts.rotatedAgeSeconds <= graceSeconds ? 'GRACE' : 'REUSE';
}

export const SESSION_STATES = ['ACTIVE', 'REVOKED', 'EXPIRED'] as const;
export type SessionState = (typeof SESSION_STATES)[number];

/**
 * Why a session ended — a closed set, because a device list that says "ended" and
 * cannot say by whom is the one screen where that answer matters most.
 *
 * `SIGNED_OUT` is this device saying goodbye; `ENDED_BY_USER` is another of the
 * holder's devices ending it; `OPERATOR` is somebody at the platform (§13.2);
 * `TOKEN_REUSE` is the alarm. Distinguishing the middle two is the point: "I did
 * this" and "somebody did this to me" are a tidy-up and an incident.
 */
export const SESSION_REVOKE_CAUSES = [
  'SIGNED_OUT',
  'ENDED_BY_USER',
  'PASSWORD_RESET',
  'TOKEN_REUSE',
  'OPERATOR',
] as const;
export type SessionRevokeCause = (typeof SESSION_REVOKE_CAUSES)[number];

/**
 * A session's state, derived rather than stored (§3).
 *
 * Expiry is lazy here as it is everywhere else in this product: no timer writes a
 * row, so a session that has simply run out reads as `EXPIRED` the moment anybody
 * looks. Revocation wins over expiry, because *how* a session ended is the fact a
 * device list exists to show — "you ended this" and "it lapsed" are different
 * answers to the same question.
 */
export function sessionState(input: {
  revokedAt: string | null;
  expiresAt: string;
  now?: Date;
}): SessionState {
  if (input.revokedAt !== null) return 'REVOKED';
  const now = input.now ?? new Date();
  return new Date(input.expiresAt).getTime() <= now.getTime() ? 'EXPIRED' : 'ACTIVE';
}

/**
 * A coarse, human-readable device label from a `User-Agent`, or null.
 *
 * **Deliberately lossy, and the loss is the feature.** "Chrome on Windows" is
 * enough for somebody to recognise their own laptop in a list, and it is not
 * enough to fingerprint them: no version numbers, no build strings, no engine
 * detail, and — per §7 — nothing derived from an address. A precise label would
 * make this table a better device-tracking dataset than anything the product
 * needs, and datasets leak.
 *
 * **Null when nothing is recognised, never a guess.** A curl call, this repo's own
 * verification script and any future server-to-server caller all arrive with a
 * User-Agent that names none of these; a label invented for them would read as a
 * device the account holder does not own, which is exactly the false alarm a
 * device list must not raise. The UI says "Unknown device" instead, which is true.
 *
 * Order matters: every one of these strings appears inside others. Edge names
 * itself Chrome and Safari, Chrome names itself Safari, and every iOS browser is
 * Safari underneath — so the most specific claim has to be tested first or
 * everything collapses into "Safari".
 */
export function deviceLabelFromUserAgent(userAgent: string | null | undefined): string | null {
  if (!userAgent) return null;
  const ua = userAgent.toLowerCase();

  // The mobile client is an app, not a browser: an Expo build reports the OS and
  // no browser at all, so "unknown on Android" would be a worse answer than naming
  // the app the user actually installed. Tested first because its User-Agent also
  // names a platform, and "Chrome on the CrewQuo app" is not a thing.
  if (ua.includes('crewquo')) return 'The CrewQuo app';

  const browser =
    ua.includes('edg/') || ua.includes('edge') ? 'Edge'
    : ua.includes('opr/') || ua.includes('opera') ? 'Opera'
    : ua.includes('firefox') || ua.includes('fxios') ? 'Firefox'
    : ua.includes('chrome') || ua.includes('crios') ? 'Chrome'
    : ua.includes('safari') ? 'Safari'
    : null;

  const platform =
    ua.includes('iphone') || ua.includes('ipad') || ua.includes('ios') ? 'iOS'
    : ua.includes('android') ? 'Android'
    : ua.includes('mac os') || ua.includes('macintosh') ? 'macOS'
    : ua.includes('windows') ? 'Windows'
    : ua.includes('linux') ? 'Linux'
    : null;

  if (browser && platform) return `${browser} on ${platform}`;
  return platform ?? browser;
}
