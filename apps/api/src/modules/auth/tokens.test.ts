import { afterEach, describe, expect, it, vi } from 'vitest';
import jwt from 'jsonwebtoken';
import { deriveKid } from './signingKeys';
import { AppError } from '../../http/errors';
import {
  createRefreshToken,
  hashRefreshToken,
  signAccessToken,
  signPurposeToken,
  verifyAccessToken,
  verifyPurposeToken,
} from './tokens';

describe('access tokens', () => {
  it('round-trips userId and optional companyId', () => {
    const token = signAccessToken({ userId: 'user-1', companyId: 'company-1' });
    const claims = verifyAccessToken(token);
    expect(claims.sub).toBe('user-1');
    expect(claims.companyId).toBe('company-1');
  });

  it('omits companyId when not provided', () => {
    const claims = verifyAccessToken(signAccessToken({ userId: 'user-2' }));
    expect(claims.sub).toBe('user-2');
    expect(claims.companyId).toBeUndefined();
  });

  it('carries the session it was minted in, under the short claim name', () => {
    // The claim is `sid` on the wire and `sessionId` in the app. The device list
    // needs it to mark "this device", and `requireAuth` needs it to notice a
    // session that has been ended.
    const claims = verifyAccessToken(
      signAccessToken({ userId: 'user-3', sessionId: 'session-3' })
    );
    expect(claims.sessionId).toBe('session-3');
  });

  it('verifies a token minted before the session claim existed', () => {
    // Every access token issued before 0018 stays valid for its remaining fifteen
    // minutes. A verifier that required `sid` would sign out every user on the
    // platform at deployment — the forced-logout failure §10 objects to about
    // rotating a signing secret, arriving through a different door.
    const claims = verifyAccessToken(signAccessToken({ userId: 'user-4' }));
    expect(claims.sub).toBe('user-4');
    expect(claims.sessionId).toBeUndefined();
  });

  it('rejects a garbage token', () => {
    expect(() => verifyAccessToken('not-a-jwt')).toThrow(AppError);
  });
});

describe('refresh tokens', () => {
  it('produces a token whose hash is stable and matches the stored hash', () => {
    const { token, tokenHash, expiresAt } = createRefreshToken();
    expect(tokenHash).toBe(hashRefreshToken(token));
    expect(expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('generates distinct tokens each call', () => {
    expect(createRefreshToken().token).not.toBe(createRefreshToken().token);
  });
});

describe('purpose tokens', () => {
  it('round-trips for the matching purpose', () => {
    const token = signPurposeToken('user-9', 'password_reset', 3600);
    expect(verifyPurposeToken(token, 'password_reset')).toBe('user-9');
  });

  it('rejects when the purpose does not match', () => {
    const token = signPurposeToken('user-9', 'password_reset', 3600);
    expect(() => verifyPurposeToken(token, 'email_verify')).toThrow(AppError);
  });
});

/**
 * Signing-secret rotation (`docs/operating-model/access.md` §12.10, §14 step 4).
 *
 * The rings are built from the environment when the module loads, because a
 * rotation is a deploy and a deploy is a new process. So the only faithful way to
 * test one is to load the module twice under two environments, which is what
 * `vi.resetModules()` buys here — asserting the mechanism itself rather than a
 * stand-in for it.
 */
describe('signing-secret rotation', () => {
  const OLD = 'old-access-secret-for-rotation-test';
  const NEW = 'new-access-secret-for-rotation-test';

  type Tokens = typeof import('./tokens');

  async function loadTokensWith(overrides: Record<string, string>): Promise<Tokens> {
    vi.resetModules();
    for (const [key, value] of Object.entries(overrides)) vi.stubEnv(key, value);
    return import('./tokens');
  }

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });


  /**
   * These assert the refusal *message* rather than `instanceof AppError`, and the
   * reason is worth a line: `vi.resetModules()` gives the re-imported module its
   * own copy of `http/errors`, so the class the rotated module throws is not the
   * class this file imported. Asserting the message is the better check anyway —
   * every one of these refusals has to be the same opaque sentence, because a
   * refusal that said "unknown key id" would tell an attacker which of their
   * guesses had named a real key.
   */
  const ACCESS_REFUSAL = 'Invalid or expired access token';

  function kidOf(token: string): string | undefined {
    const decoded = jwt.decode(token, { complete: true });
    return typeof decoded?.header.kid === 'string' ? decoded.header.kid : undefined;
  }

  it('names the key that signed it, so an operator can tell two keys apart', async () => {
    const before = await loadTokensWith({ JWT_ACCESS_SECRET: OLD, JWT_ACCESS_SECRET_RETIRED: '' });
    expect(kidOf(before.signAccessToken({ userId: 'u-1' }))).toBe(deriveKid(OLD));
  });

  it('keeps a live session across the rotation, which is the whole point', async () => {
    const before = await loadTokensWith({ JWT_ACCESS_SECRET: OLD, JWT_ACCESS_SECRET_RETIRED: '' });
    const heldToken = before.signAccessToken({ userId: 'u-2', sessionId: 's-2' });

    const after = await loadTokensWith({ JWT_ACCESS_SECRET: NEW, JWT_ACCESS_SECRET_RETIRED: OLD });

    // Signed by the retired key, presented after the promotion: still a session.
    const claims = after.verifyAccessToken(heldToken);
    expect(claims.sub).toBe('u-2');
    expect(claims.sessionId).toBe('s-2');

    // And what is minted now carries the new key's kid.
    expect(after.currentAccessKid()).toBe(deriveKid(NEW));
    expect(kidOf(after.signAccessToken({ userId: 'u-2' }))).toBe(deriveKid(NEW));
  });

  it('stops accepting the old key once it leaves the ring, and not before', async () => {
    const before = await loadTokensWith({ JWT_ACCESS_SECRET: OLD, JWT_ACCESS_SECRET_RETIRED: '' });
    const oldToken = before.signAccessToken({ userId: 'u-3' });

    // Retiring is the third step, taken one access-token lifetime after the
    // promotion — by which point nothing the old key signed is still alive.
    const retired = await loadTokensWith({ JWT_ACCESS_SECRET: NEW, JWT_ACCESS_SECRET_RETIRED: '' });
    expect(() => retired.verifyAccessToken(oldToken)).toThrow(ACCESS_REFUSAL);
  });

  it('verifies a token minted before kids existed, under whichever key signed it', async () => {
    // The deploy that introduced the ring must not sign anybody out. Every token
    // in flight at that moment has no kid header at all.
    const kidless = jwt.sign({ sub: 'u-4' }, OLD, { algorithm: 'HS256', expiresIn: 900 });
    expect(kidOf(kidless)).toBeUndefined();

    const rotated = await loadTokensWith({ JWT_ACCESS_SECRET: NEW, JWT_ACCESS_SECRET_RETIRED: OLD });
    expect(rotated.verifyAccessToken(kidless).sub).toBe('u-4');
  });

  it('refuses a kid it does not hold, rather than trying every key anyway', async () => {
    const rotated = await loadTokensWith({ JWT_ACCESS_SECRET: NEW, JWT_ACCESS_SECRET_RETIRED: OLD });
    const forged = jwt.sign({ sub: 'u-5' }, 'a-secret-we-never-had', {
      algorithm: 'HS256',
      expiresIn: 900,
      keyid: deriveKid('a-secret-we-never-had'),
    });
    expect(() => rotated.verifyAccessToken(forged)).toThrow(ACCESS_REFUSAL);
  });

  it('refuses a known kid over a signature that is not ours', async () => {
    // Naming one of our keys must not be worth anything on its own — the kid
    // selects which key checks the signature, it does not stand in for one.
    const rotated = await loadTokensWith({ JWT_ACCESS_SECRET: NEW, JWT_ACCESS_SECRET_RETIRED: OLD });
    const forged = jwt.sign({ sub: 'u-6' }, 'not-a-key-of-ours', {
      algorithm: 'HS256',
      expiresIn: 900,
      keyid: deriveKid(NEW),
    });
    expect(() => rotated.verifyAccessToken(forged)).toThrow(ACCESS_REFUSAL);
  });

  it('refuses to sign at all in a process started as a job', async () => {
    // The scheduled workers mint no token and therefore hold no key, so the
    // production signing secrets never have to exist in the scheduler's
    // environment — where anybody able to push a workflow could read them back.
    const job = await loadTokensWith({ CREWQUO_PROCESS: 'job' });

    // Loud, on the line that tried, in the process that tried. The alternative —
    // a plausible placeholder key — would mint tokens no verifier holds, and that
    // failure surfaces later and elsewhere as "invalid or expired token" on
    // somebody's screen.
    expect(() => job.signAccessToken({ userId: 'u-8' })).toThrow(/holds no access signing key/);
    expect(() => job.signPurposeToken('u-8', 'password_reset', 60)).toThrow(
      /holds no purpose signing key/
    );
    expect(() => job.currentAccessKid()).toThrow(/CREWQUO_PROCESS=job/);
  });

  it('signs normally in the default process role', async () => {
    // The default is `api`, and the safe direction: a server mislabelled as a job
    // fails the first time it signs, whereas a job mislabelled as a server merely
    // asks for keys it never uses.
    const api = await loadTokensWith({ JWT_ACCESS_SECRET: OLD });
    expect(api.currentAccessKid()).toBe(deriveKid(OLD));
  });

  it('carries password-reset links across a rotation of the refresh secret', async () => {
    // Refresh tokens are opaque and unaffected, but this secret also signs the
    // single-purpose tokens — and a reset link is good for an hour, so it
    // routinely outlives a deploy. Rotating without an overlap would invalidate
    // every link already sitting in an inbox.
    const before = await loadTokensWith({ JWT_REFRESH_SECRET: OLD, JWT_REFRESH_SECRET_RETIRED: '' });
    const link = before.signPurposeToken('u-7', 'password_reset', 3600);

    const after = await loadTokensWith({ JWT_REFRESH_SECRET: NEW, JWT_REFRESH_SECRET_RETIRED: OLD });
    expect(after.verifyPurposeToken(link, 'password_reset')).toBe('u-7');
    // The purpose check is not weakened by the ring.
    expect(() => after.verifyPurposeToken(link, 'email_verify')).toThrow('Invalid token');
  });
});
