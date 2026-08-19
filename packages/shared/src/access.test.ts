import { describe, expect, it } from 'vitest';
import {
  AUTH_RATE_POLICIES,
  rateLimitDecision,
  rateLimitIdentityKey,
  rateLimitMessage,
  shouldNotifyLockout,
  type AuthRatePolicy,
  type RateLimitFacts,
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
