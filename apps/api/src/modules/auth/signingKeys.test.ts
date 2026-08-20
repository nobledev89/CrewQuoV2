import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  buildSigningKeyring,
  deriveKid,
  parseRetiredSecrets,
  verificationKeysFor,
} from './signingKeys';

describe('deriveKid', () => {
  it('is stable for a secret and different for a different one', () => {
    expect(deriveKid('secret-a')).toBe(deriveKid('secret-a'));
    expect(deriveKid('secret-a')).not.toBe(deriveKid('secret-b'));
  });

  it('is a short hex label, safe to put in a header and a log', () => {
    expect(deriveKid('secret-a')).toMatch(/^[0-9a-f]{12}$/);
  });

  it('is domain-separated from a bare hash of the same secret', () => {
    // `rateLimit.ts` hashes a signing secret too. Two hashes of one input that
    // happened to match would leak one context into the other, so the kid is
    // taken over a labelled input rather than over the secret alone.
    const bare = createHash('sha256').update('foo').digest('hex').slice(0, 12);
    expect(deriveKid('foo')).not.toBe(bare);
  });
});

describe('parseRetiredSecrets', () => {
  it('reads a comma-separated list and trims it', () => {
    expect(parseRetiredSecrets(' old-1 , old-2 ')).toEqual(['old-1', 'old-2']);
  });

  it('is empty for an unset variable', () => {
    expect(parseRetiredSecrets('')).toEqual([]);
  });

  it('drops empty entries rather than minting a key with an empty secret', () => {
    // A trailing comma is a typo; a key whose secret is '' would be a signing
    // oracle for anybody who noticed.
    expect(parseRetiredSecrets('old-1,,')).toEqual(['old-1']);
  });
});

describe('buildSigningKeyring', () => {
  it('signs with the current key and verifies against all of them', () => {
    const ring = buildSigningKeyring('current', ['old']);
    expect(ring.current.secret).toBe('current');
    expect(ring.all.map((k) => k.secret)).toEqual(['current', 'old']);
  });

  it('needs no retired keys — one key is the steady state', () => {
    const ring = buildSigningKeyring('only');
    expect(ring.all).toHaveLength(1);
    expect(ring.current.kid).toBe(deriveKid('only'));
  });

  it('collapses a secret that appears as both current and retired', () => {
    // The safe rotation procedure has a deploy in the middle where the new
    // secret is legitimately in both places. Refusing to boot through it would
    // make the safe procedure the one that causes an outage.
    const ring = buildSigningKeyring('shared', ['shared', 'old']);
    expect(ring.all.map((k) => k.secret)).toEqual(['shared', 'old']);
  });

  it('refuses an empty current secret', () => {
    expect(() => buildSigningKeyring('')).toThrow(/cannot be empty/);
  });
});

describe('verificationKeysFor', () => {
  const ring = buildSigningKeyring('current', ['old']);
  const currentKid = deriveKid('current');
  const oldKid = deriveKid('old');

  it('selects exactly the named key', () => {
    expect(verificationKeysFor(ring, oldKid).map((k) => k.secret)).toEqual(['old']);
    expect(verificationKeysFor(ring, currentKid).map((k) => k.secret)).toEqual(['current']);
  });

  it('returns nothing for a kid the ring does not hold', () => {
    // A kid is a positive claim about which key signed the token. Once that key
    // has left the ring the honest answer is no — not "try everything".
    expect(verificationKeysFor(ring, deriveKid('retired-long-ago'))).toEqual([]);
  });

  it('falls back to every key when the token carries no kid', () => {
    // Tokens minted before kids existed stay valid for their remaining lifetime.
    // Demanding a kid would sign out every user on the platform at the deploy
    // that introduced the ring.
    expect(verificationKeysFor(ring, undefined).map((k) => k.secret)).toEqual(['current', 'old']);
    expect(verificationKeysFor(ring, '')).toHaveLength(2);
  });
});

describe('a rotation, step by step', () => {
  // access.md §12.10: both keys active, old tokens still verify, new tokens carry
  // the new kid, nobody is signed out.
  const OLD = 'the-old-signing-secret';
  const NEW = 'the-new-signing-secret';

  it('publish: the new key verifies before anything is signed with it', () => {
    const published = buildSigningKeyring(OLD, [NEW]);
    expect(published.current.secret).toBe(OLD);
    expect(verificationKeysFor(published, deriveKid(NEW))).toHaveLength(1);
  });

  it('promote: tokens signed by the old key still verify, new ones carry a new kid', () => {
    const promoted = buildSigningKeyring(NEW, [OLD]);
    expect(promoted.current.kid).toBe(deriveKid(NEW));
    expect(promoted.current.kid).not.toBe(deriveKid(OLD));
    expect(verificationKeysFor(promoted, deriveKid(OLD)).map((k) => k.secret)).toEqual([OLD]);
  });

  it('retire: the old key stops verifying only once it leaves the ring', () => {
    const retired = buildSigningKeyring(NEW);
    expect(verificationKeysFor(retired, deriveKid(OLD))).toEqual([]);
  });
});
