import { createHash } from 'node:crypto';
import { canonicalJson } from '@crewquo/shared';

/**
 * The seal: sha256 over the one canonical form (§29.4).
 *
 * `canonicalJson` lives in `packages/shared` because the writer and the verifier
 * must not be able to disagree about what was hashed, and because it is pure. The
 * digest lives here because `packages/shared` has no `node:crypto` — the seam
 * `totp.ts` established when it took its HMAC as an injected function.
 *
 * **It is taken over the parsed value, never over `snapshot::text`**, and that is
 * the whole of `reporting-signoff.md` §0 finding 4. Postgres reorders `jsonb` keys
 * on write, a `numeric` written as `1.500` parses back as `1.5`, and key insertion
 * order belongs to whichever code built the object. Hash the stored text and the
 * seal fails on every row — a tamper detector that fires on everything is one
 * somebody switches off.
 */
export function contentHash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

export class SealMismatch extends Error {
  constructor(
    readonly expected: string,
    readonly actual: string
  ) {
    super('stored contents do not match the seal');
    this.name = 'SealMismatch';
  }
}

/**
 * Verify a stored snapshot against its recorded hash, or refuse.
 *
 * **Refusing is the only honest response** (packet §9). A snapshot whose hash does
 * not verify is a document whose stored contents have changed since they were
 * sealed; rendering it anyway with a warning is a seal that does nothing, and the
 * warning lands on the screen of the person least able to act on it.
 */
export function assertSealed(snapshot: unknown, expected: string): void {
  const actual = contentHash(snapshot);
  if (actual !== expected) throw new SealMismatch(expected, actual);
}
