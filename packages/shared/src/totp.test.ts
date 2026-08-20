import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  TOTP_PERIOD_SECONDS,
  base32Decode,
  base32Encode,
  formatRecoveryCode,
  normalizeRecoveryCode,
  totpCounter,
  totpCounterBytes,
  totpMatch,
  totpTruncate,
  totpUri,
} from './totp';

/**
 * Pinned against **RFC 6238's published test vectors**, which is the whole
 * justification for hand-writing this instead of taking a dependency: the
 * algorithm has an official answer sheet, so "did we implement it correctly" is a
 * question with a real answer rather than a matter of trust.
 *
 * The vectors use the ASCII secret `12345678901234567890` (RFC 6238 Appendix B)
 * with HMAC-SHA1 and 8 digits. Six-digit codes are the last six of the same value,
 * which is exactly what the truncation rule means, so the same table proves both.
 */
const RFC_SECRET = Buffer.from('12345678901234567890', 'ascii');

const digestFor = (secret: Buffer) => (counter: number) =>
  new Uint8Array(createHmac('sha1', secret).update(totpCounterBytes(counter)).digest());

describe('RFC 6238 test vectors', () => {
  // time (seconds) → the RFC's expected 8-digit code.
  const VECTORS: Array<[number, string]> = [
    [59, '94287082'],
    [1111111109, '07081804'],
    [1111111111, '14050471'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
    [20000000000, '65353130'],
  ];

  for (const [seconds, expected] of VECTORS) {
    it(`matches the published code at T=${seconds}`, () => {
      const counter = totpCounter(seconds * 1000);
      const digest = digestFor(RFC_SECRET)(counter);
      expect(totpTruncate(digest, 8)).toBe(expected);
      // And the six-digit form is the last six digits of the same number — the
      // property that lets one vector table prove both widths.
      expect(totpTruncate(digest, 6)).toBe(expected.slice(-6));
    });
  }

  it('counts periods from the Unix epoch in 30-second steps', () => {
    expect(totpCounter(0)).toBe(0);
    expect(totpCounter(29_999)).toBe(0);
    expect(totpCounter(30_000)).toBe(1);
    expect(totpCounter(59 * 1000)).toBe(1); // the RFC's first vector
  });

  it('encodes the counter big-endian across the 32-bit boundary', () => {
    // The half-word arithmetic in `totpCounterBytes` is exactly where a naive
    // implementation breaks, and it breaks silently in the year 2038 rather than
    // in a test run.
    expect(Array.from(totpCounterBytes(1))).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
    expect(Array.from(totpCounterBytes(2 ** 32))).toEqual([0, 0, 0, 1, 0, 0, 0, 0]);
    expect(Array.from(totpCounterBytes(20000000000 / TOTP_PERIOD_SECONDS))).toEqual([
      0, 0, 0, 0, 0x27, 0xbc, 0x86, 0xaa,
    ]);
  });
});

describe('totpMatch', () => {
  const at = (seconds: number) => totpCounter(seconds * 1000);
  const code = (counter: number, digits = 6) => totpTruncate(digestFor(RFC_SECRET)(counter), digits);

  it('accepts the current code', () => {
    const counter = at(1111111111);
    expect(totpMatch({ code: code(counter), counter, digestFor: digestFor(RFC_SECRET) })).toBe(
      counter
    );
  });

  it('accepts one step either side, and no further', () => {
    /*
     * The drift window is the single number in this file most likely to be
     * "improved" later, in both directions. Too tight and a phone two seconds out
     * of sync can never sign in — the failure looks like a broken feature and the
     * fix people reach for is turning MFA off. Too wide and every code stays usable
     * for minutes, which is precisely how long a shoulder-surfed code needs to be.
     */
    const counter = at(1111111111);
    for (const offset of [-1, 0, 1]) {
      expect(
        totpMatch({ code: code(counter + offset), counter, digestFor: digestFor(RFC_SECRET) }),
        `offset ${offset}`
      ).toBe(counter + offset);
    }
    for (const offset of [-2, 2]) {
      expect(
        totpMatch({ code: code(counter + offset), counter, digestFor: digestFor(RFC_SECRET) }),
        `offset ${offset}`
      ).toBeNull();
    }
  });

  it('reports which counter matched, so a code cannot be replayed', () => {
    // A boolean would leave a code valid for its whole 90-second window. The
    // matched counter is what a factor stores to make one code worth one login.
    const counter = at(1234567890);
    expect(totpMatch({ code: code(counter - 1), counter, digestFor: digestFor(RFC_SECRET) })).toBe(
      counter - 1
    );
  });

  it('refuses anything that is not the right shape', () => {
    const counter = at(59);
    for (const bad of ['', '1234', '1234567', 'abcdef', '12 34 56', '  ']) {
      expect(
        totpMatch({ code: bad, counter, digestFor: digestFor(RFC_SECRET) }),
        bad
      ).toBeNull();
    }
  });

  it('tolerates spaces inside an otherwise valid code', () => {
    // Authenticator apps display `123 456`, and people paste what they see.
    const counter = at(59);
    const spaced = code(counter).replace(/^(\d{3})/, '$1 ');
    expect(totpMatch({ code: spaced, counter, digestFor: digestFor(RFC_SECRET) })).toBe(counter);
  });

  it('never accepts a wrong code from a different secret', () => {
    const counter = at(59);
    const other = Buffer.from('09876543210987654321', 'ascii');
    expect(totpMatch({ code: code(counter), counter, digestFor: digestFor(other) })).toBeNull();
  });
});

describe('base32', () => {
  it('round-trips arbitrary bytes', () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255, 128, 64]);
    expect(Array.from(base32Decode(base32Encode(bytes)))).toEqual(Array.from(bytes));
  });

  it('matches the RFC 4648 alphabet on a known value', () => {
    expect(base32Encode(Buffer.from('12345678901234567890', 'ascii'))).toBe(
      'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'
    );
  });

  it('accepts what a person types off a screen', () => {
    // Spaces, lower case and padding are all things a human adds. A secret
    // rejected for a space is a support ticket, and the retyped one is identical.
    const encoded = base32Encode(new Uint8Array([1, 2, 3, 4, 5]));
    const typed = `${encoded.slice(0, 4).toLowerCase()} ${encoded.slice(4)}==`;
    expect(Array.from(base32Decode(typed))).toEqual(Array.from(base32Decode(encoded)));
  });

  it('refuses a character it would have to guess about', () => {
    // `0` and `O` look alike. Guessing produces a different secret and an
    // enrolment that rejects every code with no explanation.
    expect(() => base32Decode('AAAA0AAA')).toThrow();
  });
});

describe('otpauth URI', () => {
  it('carries the issuer in both places an app might read it', () => {
    const uri = totpUri({
      issuer: 'CrewQuo',
      account: 'dana@example.test',
      secretBase32: 'GEZDGNBVGY3TQOJQ',
    });
    expect(uri).toContain('otpauth://totp/CrewQuo%3Adana%40example.test?');
    expect(uri).toContain('issuer=CrewQuo');
    expect(uri).toContain('secret=GEZDGNBVGY3TQOJQ');
    expect(uri).toContain('period=30');
    expect(uri).toContain('digits=6');
  });
});

describe('recovery codes', () => {
  it('formats for paper and compares without it', () => {
    expect(formatRecoveryCode('abcdefghij')).toBe('ABCDE-FGHIJ');
    // The dash is presentation. Somebody typing it back with or without, in either
    // case, is the same code — anything else turns a rescue path into a puzzle.
    expect(normalizeRecoveryCode('abcde-fghij')).toBe('ABCDEFGHIJ');
    expect(normalizeRecoveryCode(' ABCDE FGHIJ ')).toBe('ABCDEFGHIJ');
    expect(normalizeRecoveryCode('ABCDEFGHIJ')).toBe('ABCDEFGHIJ');
  });
});
