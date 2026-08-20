/**
 * TOTP (RFC 6238) and its base32 alphabet (RFC 4648), pure.
 * Operating-model packet: `docs/operating-model/access.md` §3.
 *
 * **Hand-written rather than taken as a dependency**, for the same reason the six
 * security headers in `app.ts` are: the whole algorithm is HMAC plus a truncation
 * rule, it is pinned by published test vectors, and a dependency whose defaults
 * change between majors is harder to audit than thirty lines with a stated reason
 * each. The one thing a library would give that matters is somebody else's
 * attention to the drift window — so that is the part with the most tests.
 *
 * The HMAC itself is *not* here: `node:crypto` does it, and this file is pure so it
 * can be tested without a runtime. The caller passes the digest in.
 */

/** RFC 4648 base32, uppercase, no padding — what authenticator apps expect. */
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/**
 * Decode base32, tolerantly.
 *
 * **Tolerant on purpose, and only in ways that cannot change the secret.** People
 * type these by hand off a screen, so spaces, lower case and `=` padding are
 * accepted — a secret rejected for a space is a support ticket, and the retyped
 * version is identical anyway. Characters outside the alphabet are *not* accepted:
 * `0` and `O` look alike and silently guessing which was meant would produce a
 * different secret and an enrolment that fails every code with no explanation.
 */
export function base32Decode(input: string): Uint8Array {
  const cleaned = input.replace(/[\s=]/g, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of cleaned) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) throw new Error(`Not base32: ${char}`);
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

export const TOTP_PERIOD_SECONDS = 30;
export const TOTP_DIGITS = 6;

/**
 * How many periods either side of now still count.
 *
 * **One, meaning a code is valid for at most 90 seconds.** Zero is unusable in
 * practice: a phone clock is a second or two out, somebody starts typing at
 * 0:29, and the code they are looking at expires between reading and pressing
 * enter. Larger windows are the more tempting mistake — each step multiplies the
 * time a shoulder-surfed or phished code stays usable, and a six-digit code is
 * worth guarding for seconds rather than minutes.
 */
export const TOTP_DRIFT_STEPS = 1;

/** The counter for a moment — the shared input both sides derive the code from. */
export function totpCounter(nowMs: number, period = TOTP_PERIOD_SECONDS): number {
  return Math.floor(nowMs / 1000 / period);
}

/** The 8-byte big-endian counter RFC 4226 HMACs. */
export function totpCounterBytes(counter: number): Uint8Array {
  const bytes = new Uint8Array(8);
  // Written as a pair of 32-bit halves rather than with BigInt: the counter is
  // seconds/30, so it stays inside Number's exact range until the year 275,000.
  const high = Math.floor(counter / 2 ** 32);
  const low = counter >>> 0;
  for (let i = 0; i < 4; i += 1) {
    bytes[3 - i] = (high >>> (i * 8)) & 255;
    bytes[7 - i] = (low >>> (i * 8)) & 255;
  }
  return bytes;
}

/**
 * RFC 4226 dynamic truncation: the low nibble of the last byte picks the offset,
 * and the high bit of the selected word is masked off so the result is the same on
 * every platform regardless of signed-integer handling.
 */
export function totpTruncate(digest: Uint8Array, digits = TOTP_DIGITS): string {
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary =
    ((digest[offset]! & 0x7f) << 24) |
    (digest[offset + 1]! << 16) |
    (digest[offset + 2]! << 8) |
    digest[offset + 3]!;
  return String(binary % 10 ** digits).padStart(digits, '0');
}

/**
 * Is `code` one of the codes valid around `counter`?
 *
 * Takes a digest function rather than a secret so this file stays pure — the caller
 * supplies `node:crypto`'s HMAC. Returns the *matched counter* rather than a
 * boolean, because a factor has to remember the last counter it accepted: without
 * that, a code stays replayable for its whole 90-second window, and a code read
 * over somebody's shoulder is worth exactly one login.
 */
export function totpMatch(args: {
  code: string;
  counter: number;
  digits?: number;
  driftSteps?: number;
  digestFor: (counter: number) => Uint8Array;
}): number | null {
  const digits = args.digits ?? TOTP_DIGITS;
  const drift = args.driftSteps ?? TOTP_DRIFT_STEPS;
  const submitted = args.code.replace(/\s/g, '');
  if (!new RegExp(`^[0-9]{${digits}}$`).test(submitted)) return null;

  // Ordered from the current step outwards, so the common case compares first.
  const offsets = [0];
  for (let step = 1; step <= drift; step += 1) offsets.push(-step, step);

  for (const offset of offsets) {
    const candidate = args.counter + offset;
    if (candidate < 0) continue;
    if (timingSafeEqualString(totpTruncate(args.digestFor(candidate), digits), submitted)) {
      return candidate;
    }
  }
  return null;
}

/**
 * Compare two equal-length digit strings without leaking where they differ.
 *
 * A six-digit space is small enough that a timing oracle on the comparison is a
 * genuine shortcut, and `===` on strings exits at the first differing character.
 * Written here rather than using `crypto.timingSafeEqual` to keep this file free of
 * a runtime dependency; the inputs are always the same length by construction.
 */
function timingSafeEqualString(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * The `otpauth://` URI an authenticator app scans or accepts pasted.
 *
 * The issuer appears twice — as a label prefix and as a parameter — which looks
 * redundant and is not: older apps read only the prefix, newer ones only the
 * parameter, and an app that reads neither shows the account with no clue which
 * service it belongs to. The account name is the email address, because somebody
 * with two CrewQuo accounts needs to tell the entries apart.
 */
export function totpUri(args: { issuer: string; account: string; secretBase32: string }): string {
  const label = encodeURIComponent(`${args.issuer}:${args.account}`);
  const params = new URLSearchParams({
    secret: args.secretBase32,
    issuer: args.issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_PERIOD_SECONDS),
  });
  // SHA1 is not a mistake here: RFC 6238's HMAC-SHA1 is what every authenticator
  // app implements, and the property TOTP needs from it (a 30-second one-time code
  // from a shared secret) is unaffected by the collision attacks that retired SHA1
  // for signatures. An app that cannot read `algorithm=SHA256` silently derives the
  // wrong codes, which is a worse security outcome than the theoretical one.
  return `otpauth://totp/${label}?${params.toString()}`;
}

/**
 * How recovery codes are shown, and why they look like that.
 *
 * Grouped with a dash because these get written on paper and read back later, and
 * an unbroken run of ten characters is where transcription errors happen. Base32
 * for the same reason the secret is: no `0`/`O` or `1`/`l` to mistake.
 */
export const RECOVERY_CODE_COUNT = 10;

export function formatRecoveryCode(raw: string): string {
  const cleaned = raw.replace(/[\s-]/g, '').toUpperCase();
  return `${cleaned.slice(0, 5)}-${cleaned.slice(5, 10)}`;
}

/** The stored/compared form: formatting is presentation, never identity. */
export function normalizeRecoveryCode(input: string): string {
  return input.replace(/[\s-]/g, '').toUpperCase();
}
