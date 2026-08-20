import { describe, expect, it } from 'vitest';
import {
  AUTH_RATE_POLICIES,
  AUTH_RATE_SCOPES,
  mfaIsRequired,
  platformAccessRefusal,
  REFRESH_ROTATION_GRACE_SECONDS,
  classifyRefreshToken,
  deviceLabelFromUserAgent,
  lockoutWindowBucket,
  rateLimitDecision,
  rateLimitIdentityKey,
  rateLimitMessage,
  sessionState,
  shouldNotifyLockout,
  type AuthRatePolicy,
  type RateLimitFacts,
  type RefreshTokenFacts,
} from './access';

/**
 * One test per rule (§13, §44). The two that matter most are not "does it count" —
 * they are that a limiter must not become a lockout button anybody can point at
 * anybody, and that its refusal must not answer a question the login endpoint
 * itself refuses to answer.
 */

const facts = (over: Partial<RateLimitFacts> = {}): RateLimitFacts => ({
  identityFailures: 0,
  sourceFailures: 0,
  oldestIdentityFailureAgeSeconds: null,
  oldestSourceFailureAgeSeconds: null,
  ...over,
});

const policy: AuthRatePolicy = {
  identity: { max: 10, windowSeconds: 900 },
  source: { max: 30, windowSeconds: 900 },
};

describe('rateLimitDecision', () => {
  it('allows an attempt when nothing has failed', () => {
    expect(rateLimitDecision(policy, facts()).allowed).toBe(true);
  });

  it('allows the attempt that reaches the limit, and refuses the one after', () => {
    // Off-by-one here is the difference between 10 guesses and 11, forever.
    expect(rateLimitDecision(policy, facts({ identityFailures: 9 })).allowed).toBe(true);
    expect(rateLimitDecision(policy, facts({ identityFailures: 10 })).allowed).toBe(false);
  });

  it('waits only until the oldest failure falls out of the window', () => {
    // Not the whole window: that would round every wait up to the maximum and read
    // as a punishment rather than a queue.
    const decision = rateLimitDecision(
      policy,
      facts({ identityFailures: 10, oldestIdentityFailureAgeSeconds: 880 })
    );
    expect(decision.retryAfterSeconds).toBe(20);
  });

  it('never reports a zero or negative wait', () => {
    // A refusal that says "retry in 0 seconds" is a client-side infinite loop.
    const decision = rateLimitDecision(
      policy,
      facts({ sourceFailures: 30, oldestSourceFailureAgeSeconds: 100_000 })
    );
    expect(decision.allowed).toBe(false);
    expect(decision.retryAfterSeconds).toBeGreaterThanOrEqual(1);
  });

  it('names the source budget when the source is what ran out', () => {
    const decision = rateLimitDecision(
      policy,
      facts({ sourceFailures: 30, identityFailures: 30 })
    );
    expect(decision.exhausted).toBe('source');
  });
});

describe('the limiter must not become a lockout button', () => {
  it('gives an address a looser budget than a caller, on LOGIN', () => {
    // The asymmetry is the design: keying only on the address hands anybody a
    // lockout button for anybody else's account. The source budget has to bite
    // first, so an attacker is stopped by their own volume.
    const login = AUTH_RATE_POLICIES.LOGIN;
    expect(login.source.max).toBeGreaterThan(login.identity.max);
    expect(login.source.windowSeconds).toBe(login.identity.windowSeconds);
  });

  it('stops a single attacker on their own budget before the victim is locked out', () => {
    // One source guessing at one address: the source budget is reached at 30 while
    // the address has taken 30 too, so the refusal is the attacker's, not Dana's.
    const attacker = facts({ sourceFailures: 30, identityFailures: 30 });
    expect(rateLimitDecision(AUTH_RATE_POLICIES.LOGIN, attacker).exhausted).toBe('source');
  });

  it('keys reset tighter on the address than login does', () => {
    // Reset is the one scope where the identity budget protects the *recipient*:
    // the abuse is mail-bombing an inbox, not guessing a secret.
    expect(AUTH_RATE_POLICIES.RESET.identity.max)
      .toBeLessThan(AUTH_RATE_POLICIES.LOGIN.identity.max);
  });

  it('does not budget register by identity at all', () => {
    // There is no account yet to key to, and keying on the requested address would
    // let somebody reserve an address by failing at it.
    expect(AUTH_RATE_POLICIES.REGISTER.identity.max).toBe(Number.POSITIVE_INFINITY);
    expect(
      rateLimitDecision(AUTH_RATE_POLICIES.REGISTER, facts({ identityFailures: 9_999 })).allowed
    ).toBe(true);
  });
});

describe('the refusal is not an oracle', () => {
  it('says nothing about whether an account exists', () => {
    const message = rateLimitMessage(600);
    for (const leak of ['account', 'user', 'email', 'address', 'exists', 'password']) {
      expect(message.toLowerCase()).not.toContain(leak);
    }
  });

  it('rounds the wait up to whole minutes and reads as a sentence', () => {
    expect(rateLimitMessage(30)).toContain('a minute');
    expect(rateLimitMessage(600)).toContain('10 minutes');
  });
});

describe('lockout notification', () => {
  it('emails the holder when their address is locked out by failed sign-ins', () => {
    const decision = rateLimitDecision(policy, facts({ identityFailures: 10 }));
    expect(shouldNotifyLockout('LOGIN', decision)).toBe(true);
  });

  it('says nothing when it was the caller who hit their own limit', () => {
    // Means nothing to the account owner, and would tell them about traffic that
    // was never aimed at them.
    const decision = rateLimitDecision(policy, facts({ sourceFailures: 30 }));
    expect(shouldNotifyLockout('LOGIN', decision)).toBe(false);
  });

  it('never emails about a reset lockout', () => {
    // The abuse being rate-limited is mail to that address. Mailing about it is
    // the abuse repeating itself.
    const decision = rateLimitDecision(policy, facts({ identityFailures: 10 }));
    expect(shouldNotifyLockout('RESET', decision)).toBe(false);
  });

  it('says nothing when the attempt was allowed', () => {
    expect(shouldNotifyLockout('LOGIN', rateLimitDecision(policy, facts()))).toBe(false);
  });
});

describe('identity keys', () => {
  it('folds case and whitespace into one budget', () => {
    // Without this, spelling alone multiplies an attacker's allowance.
    expect(rateLimitIdentityKey('  Dana@Example.TEST ')).toBe('dana@example.test');
  });
});

// ── Rotation & reuse detection (build-order step 2) ──────────────────────────

const token = (over: Partial<RefreshTokenFacts> = {}): RefreshTokenFacts => ({
  found: true,
  expired: false,
  sessionRevoked: false,
  rotatedAgeSeconds: null,
  revokedWithoutRotation: false,
  ...over,
});

describe('classifyRefreshToken', () => {
  it('rotates a token that has never been exchanged', () => {
    expect(classifyRefreshToken(token())).toBe('LIVE');
  });

  it('calls a replay long after the exchange what it is', () => {
    // The only branch that raises an alarm, and the only branch that signs a
    // person out of every device they own.
    expect(classifyRefreshToken(token({ rotatedAgeSeconds: 600 }))).toBe('REUSE');
  });

  it('treats a double-submit inside the grace window as the ordinary race', () => {
    // A phone waking while a laptop polls — and this product's own web app, which
    // mounts a second AuthProvider on every sign-in that crosses a route group.
    expect(classifyRefreshToken(token({ rotatedAgeSeconds: 1 }))).toBe('GRACE');
    expect(classifyRefreshToken(token({ rotatedAgeSeconds: REFRESH_ROTATION_GRACE_SECONDS })))
      .toBe('GRACE');
    // One second past the window is the alarm. Off-by-one here is the difference
    // between an alarm that fires at random and one that never fires at all.
    expect(classifyRefreshToken(token({ rotatedAgeSeconds: REFRESH_ROTATION_GRACE_SECONDS + 1 })))
      .toBe('REUSE');
  });

  it('never raises an alarm for an unknown token', () => {
    // Somebody guessing, or a client holding a token from a reset database. There
    // is no family to revoke, so there is nothing to raise.
    expect(classifyRefreshToken(token({ found: false }))).toBe('DEAD');
  });

  it('stays quiet once the family is already revoked', () => {
    // This is what makes the alarm fire ONCE. Without it, the thief's next
    // attempt — and the victim's, and every retry of both — would notify again.
    expect(classifyRefreshToken(token({ rotatedAgeSeconds: 600, sessionRevoked: true })))
      .toBe('DEAD');
  });

  it('does not raise an alarm about an expired family', () => {
    // Revoking it changes nothing, and the email would be about an attack on
    // something already gone.
    expect(classifyRefreshToken(token({ rotatedAgeSeconds: 600, expired: true }))).toBe('DEAD');
  });

  it('does not treat a replay after sign-out as theft', () => {
    // A client that has not noticed yet. Treating this as theft would fire the
    // alarm at every sign-out, which is the fastest way to make it ignored.
    expect(classifyRefreshToken(token({ revokedWithoutRotation: true }))).toBe('DEAD');
  });

  it('honours a caller-supplied window, so the policy is not welded to the clock', () => {
    expect(classifyRefreshToken(token({ rotatedAgeSeconds: 45 }), 60)).toBe('GRACE');
  });

  it('holds the window at the number somebody chose', () => {
    // Pinned deliberately. Every other test here uses the constant symbolically, so
    // without this line the window could be widened to an hour and the whole suite
    // would still pass while detection was effectively off. Two minutes is an owner
    // decision (2026-08-20); changing it is another one, not a tuning exercise.
    expect(REFRESH_ROTATION_GRACE_SECONDS).toBe(120);
  });
});

describe('sessionState', () => {
  const now = new Date('2026-08-19T12:00:00Z');

  it('is active while unrevoked and unexpired', () => {
    expect(sessionState({ revokedAt: null, expiresAt: '2026-09-18T12:00:00Z', now }))
      .toBe('ACTIVE');
  });

  it('expires lazily, with no timer having written anything', () => {
    expect(sessionState({ revokedAt: null, expiresAt: '2026-08-19T11:59:59Z', now }))
      .toBe('EXPIRED');
  });

  it('reports a revocation even after the expiry has passed', () => {
    // HOW a session ended is the fact the device list exists to show: "you ended
    // this" and "it lapsed" are different answers to the same question.
    expect(sessionState({
      revokedAt: '2026-08-01T00:00:00Z',
      expiresAt: '2026-08-02T00:00:00Z',
      now,
    })).toBe('REVOKED');
  });
});

describe('deviceLabelFromUserAgent', () => {
  it('names the app before any platform it also mentions', () => {
    // Its User-Agent names an OS too, and "Chrome on the CrewQuo app" is not a
    // thing.
    expect(deviceLabelFromUserAgent('CrewQuo/1.2 (iPhone; iOS 18.2)')).toBe('The CrewQuo app');
  });

  it('prefers the most specific browser claim', () => {
    // Every one of these strings appears inside the others: Edge calls itself
    // Chrome and Safari, Chrome calls itself Safari, and every iOS browser is
    // Safari underneath. Test the specific one first or everything is "Safari".
    expect(deviceLabelFromUserAgent(
      'Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/141 Safari/537.36 Edg/141'
    )).toBe('Edge on Windows');
    expect(deviceLabelFromUserAgent(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1 Version/17 Safari/605.1'
    )).toBe('Safari on macOS');
    expect(deviceLabelFromUserAgent(
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_2) AppleWebKit/605.1 CriOS/141 Mobile Safari/604.1'
    )).toBe('Chrome on iOS');
  });

  it('says nothing rather than guessing', () => {
    // A label invented for curl, or for this repo's own verification script, would
    // read as a device the holder does not own — the false alarm a device list
    // must not raise. The UI says "Unknown device", which is true.
    expect(deviceLabelFromUserAgent('curl/8.7.1')).toBeNull();
    expect(deviceLabelFromUserAgent(null)).toBeNull();
    expect(deviceLabelFromUserAgent('')).toBeNull();
  });

  it('carries no version, build or engine detail into the label', () => {
    const label = deviceLabelFromUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/141.0.7390.55'
    );
    expect(label).toBe('Chrome on Windows');
    expect(label).not.toMatch(/\d/);
  });
});

describe('lockoutWindowBucket', () => {
  it('gives one lockout one key', () => {
    const windowSeconds = AUTH_RATE_POLICIES.LOGIN.identity.windowSeconds;
    const start = 1_000_000 * windowSeconds * 1000;
    expect(lockoutWindowBucket(start)).toBe(lockoutWindowBucket(start + windowSeconds * 1000 - 1));
  });

  it('gives the next window a different one', () => {
    // Without this, a second lockout months later would deduplicate against the
    // first and never reach the account holder.
    const windowSeconds = AUTH_RATE_POLICIES.LOGIN.identity.windowSeconds;
    const start = 1_000_000 * windowSeconds * 1000;
    expect(lockoutWindowBucket(start + windowSeconds * 1000)).toBe(lockoutWindowBucket(start) + 1);
  });
});

// ── Second factors (build-order step 3) ──────────────────────────────────────

describe('who must hold a factor', () => {
  it('requires one of platform staff and of nobody else', () => {
    // §13.1, reaffirmed 2026-08-20. The asymmetry is the decision: a compromised
    // customer password is one tenant's incident, a compromised staff password is
    // every tenant's.
    expect(mfaIsRequired({ isSuperAdmin: true })).toBe(true);
    expect(mfaIsRequired({ isSuperAdmin: false })).toBe(false);
  });
});

describe('platformAccessRefusal', () => {
  it('lets a customer past whatever they hold', () => {
    // The mandate is about the platform console. A customer's own workspace is not
    // gated on a factor they were only ever offered.
    for (const factorState of ['NONE', 'PENDING', 'ACTIVE'] as const) {
      expect(platformAccessRefusal({ isSuperAdmin: false, factorState })).toBeNull();
    }
  });

  it('lets staff with a confirmed factor through', () => {
    expect(platformAccessRefusal({ isSuperAdmin: true, factorState: 'ACTIVE' })).toBeNull();
  });

  it('refuses staff who hold nothing, and says what to do', () => {
    const refusal = platformAccessRefusal({ isSuperAdmin: true, factorState: 'NONE' });
    expect(refusal).toMatch(/authenticator app/i);
  });

  it('refuses an unfinished enrolment as firmly as none at all', () => {
    // A secret issued and never proven is not a factor, it is an abandoned form.
    // Accepting it would let somebody believe they have two-step sign-in when what
    // they have is a QR code — and for a mandatory-MFA operator, that belief is the
    // whole exposure.
    const refusal = platformAccessRefusal({ isSuperAdmin: true, factorState: 'PENDING' });
    expect(refusal).toMatch(/finish/i);
  });
});

describe('the MFA guessing budget', () => {
  it('is tighter than the login budget', () => {
    // A six-digit code is a million possibilities with about three valid at any
    // moment: an unlimited guesser reaches even odds in minutes. A password is not
    // guessable at that rate, so the two budgets are not interchangeable.
    expect(AUTH_RATE_POLICIES.MFA.identity.max).toBeLessThanOrEqual(
      AUTH_RATE_POLICIES.LOGIN.identity.max
    );
    expect(AUTH_RATE_POLICIES.MFA.source.max).toBeLessThan(AUTH_RATE_POLICIES.LOGIN.source.max);
  });

  it('exists at all, which the scope list has to allow', () => {
    // The database has a check constraint on `scope`; a policy the constraint
    // rejects would fail at the first attempt rather than at deploy.
    expect(AUTH_RATE_SCOPES).toContain('MFA');
  });
});
