import { createHash } from 'node:crypto';

/**
 * Signing-key rings and their key ids (§42).
 * Operating-model packet: `docs/operating-model/access.md` §10 hole 6, §14 step 4.
 *
 * The hole this closes is not that the secret is weak — it is that there is only
 * one of it, unlabelled, so the only way to change it is to change it for
 * everybody at once. Every access token in flight is signed by the old secret, so
 * the moment the new one is live those tokens stop verifying and every signed-in
 * user on the platform is thrown out simultaneously. The predictable consequence
 * is not a bad rotation; it is **no rotation, ever**, which is how a secret ends
 * up living for the lifetime of the product.
 *
 * A ring fixes it by making "which key signed this" a question the token can
 * answer. Signing uses exactly one key — the current one — while verification
 * accepts any key still in the ring, so a rotation is three ordered steps with no
 * user-visible moment in any of them: publish the new key beside the old, promote
 * it to current, then drop the old one once one access-token lifetime has passed
 * and nothing it signed is still alive.
 *
 * Pure, and separate from the JWT library, because the interesting part is the
 * key *selection* — which keys may verify a token, and which single key may sign
 * one. Getting that wrong in the lenient direction (accepting a key that has been
 * retired) is a secret that never actually dies; getting it wrong in the strict
 * direction is the mass logout the ring exists to prevent.
 *
 * **Here rather than in `@crewquo/shared`, unlike the other pure cores in this
 * domain.** Two reasons, and the second is the one that decided it. It needs a
 * real SHA-256, and `packages/shared` is bundled into the browser — which is why
 * `totp.ts` sitting beside it takes its digest from the caller rather than
 * importing `node:crypto`. The same trick would work here, but it would be
 * bending a server-only module into a browser-safe shape so that it can live
 * somewhere no browser should ever load it from: nothing in the web or mobile app
 * signs a token, and a module about signing secrets has no business in a bundle
 * shipped to a user.
 */

export interface SigningKey {
  /** Public label, safe to put in a token header and in logs. */
  kid: string;
  secret: string;
}

export interface SigningKeyring {
  /** The one key new tokens are signed with. */
  current: SigningKey;
  /** Every key a token may be verified against, current first. */
  all: SigningKey[];
}

/**
 * Domain separator. The kid is a hash of the secret, so it must not collide with
 * any other place this codebase hashes the same value — `rateLimit.ts` peppers
 * source addresses with a signing secret, and two hashes of one input that happen
 * to match would leak one context into the other.
 */
const KID_DOMAIN = 'crewquo/jwt-kid/v1';

/** 48 bits. Long enough that two keys colliding is not a thing that happens. */
const KID_LENGTH = 12;

/**
 * The kid is **derived from the secret rather than configured beside it**, and
 * that is the decision worth stating.
 *
 * The alternative is an explicit `kid:secret` map in the environment, which adds
 * a second thing to keep in sync and therefore a way for them to disagree — a kid
 * naming a key it was not generated from is a rotation that verifies nothing and
 * reports success. Deriving it means the label cannot be wrong: change the secret
 * and the kid changes with it, drop the secret and its kid is gone.
 *
 * **It publishes a truncated hash of a secret, and that costs nothing here.**
 * Anybody holding a token already holds an HMAC over known plaintext under that
 * same secret, which is a far better oracle for testing a guess than 48 bits of a
 * hash. The kid gives an attacker no capability the signature had not already
 * given them; it gives an operator reading a log the ability to tell two keys
 * apart, which nothing else does.
 */
export function deriveKid(secret: string): string {
  return createHash('sha256')
    .update(KID_DOMAIN)
    .update('\0')
    .update(secret)
    .digest('hex')
    .slice(0, KID_LENGTH);
}

/**
 * Read a comma-separated list of retired secrets from one environment variable.
 *
 * Empty entries are dropped rather than becoming a key with an empty secret,
 * because a trailing comma is a typo and a key that verifies against `''` would
 * be a signing oracle for anyone who noticed.
 */
export function parseRetiredSecrets(raw: string): string[] {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Build the ring. `current` signs; `current` and every retired key verify.
 *
 * Duplicates are collapsed rather than rejected, because the honest way to run a
 * rotation is to append the new secret to the retired list first and promote it
 * afterwards — so there is a deploy in the middle where one value legitimately
 * appears twice, and refusing to boot through it would make the safe procedure
 * the one that causes an outage.
 */
export function buildSigningKeyring(
  currentSecret: string,
  retiredSecrets: readonly string[] = []
): SigningKeyring {
  if (currentSecret.length === 0) {
    throw new Error('buildSigningKeyring: the current signing secret cannot be empty');
  }

  const all: SigningKey[] = [];
  const seenSecrets = new Set<string>();
  const seenKids = new Set<string>();

  for (const secret of [currentSecret, ...retiredSecrets]) {
    if (seenSecrets.has(secret)) continue;
    seenSecrets.add(secret);

    const kid = deriveKid(secret);
    // Two different secrets sharing a kid would silently make one of them
    // unverifiable. At 48 bits this is not a coincidence anybody will meet; if it
    // is ever seen it is a bug in the derivation, and a boot failure naming it is
    // worth more than a login failure that looks like a bad password.
    if (seenKids.has(kid)) {
      throw new Error(`buildSigningKeyring: two distinct secrets derive the same kid (${kid})`);
    }
    seenKids.add(kid);
    all.push({ kid, secret });
  }

  return { current: all[0] as SigningKey, all };
}

/**
 * Which keys may verify a token carrying this `kid` header.
 *
 * **An absent kid means "try them all", and that is deliberate rather than
 * sloppy.** Every access token minted before this file existed has no kid, is
 * signed by whichever secret was configured at the time, and stays valid for the
 * rest of its fifteen minutes. A verifier that demanded a kid would sign out
 * every user on the platform at the deploy that introduced the ring — the exact
 * failure the ring is here to prevent, arriving through the door marked "fix". It
 * concedes nothing: a kid-less token must still carry a real signature from a key
 * this ring holds, and the fallback costs one extra HMAC per key in a ring that
 * has two entries.
 *
 * **A kid we do not hold returns nothing**, rather than falling back to trying
 * everything. It is a positive claim about which key signed the token, and once
 * that key has left the ring the honest answer is no.
 */
export function verificationKeysFor(
  ring: SigningKeyring,
  kid: string | null | undefined
): SigningKey[] {
  if (kid === null || kid === undefined || kid === '') return ring.all;
  const match = ring.all.find((key) => key.kid === kid);
  return match ? [match] : [];
}
