import { Router } from 'express';
import type { SessionsEndedResponse, SessionsResponse } from '@crewquo/shared';
import { asyncHandler } from '../../http/asyncHandler';
import { getCtx } from '../../http/context';
import { AppError } from '../../http/errors';
import { uuidParam } from '../../http/params';
import { listSessions, revokeOtherSessions, revokeSession } from './sessions.repo';

/**
 * Self-service session and device management (`access.md` §4).
 *
 * Mounted under `/v1/me`, because that is what these are: the caller's own
 * account, not a company's. No entitlement key gates any of it — selling a
 * security floor as a plan feature would make the cheapest tenant the softest
 * target on a platform where every tenant shares one database, so the weakest
 * customer's compromise becomes everybody's incident. The packet reaches that
 * conclusion for the fourth time in §4, which makes it a pattern rather than a
 * coincidence.
 *
 * **Every route here is scoped to `ctx.userId` in the query itself**, never
 * checked afterwards. There is deliberately no shape in this file in which one
 * user's id and another user's session can meet — no admin variant, no "on behalf
 * of", no filter that could be omitted and still return rows.
 */
export const sessionsRouter = Router();

/**
 * GET /v1/me/sessions — this account's devices.
 *
 * `current` marks the session this request's own access token was minted in, which
 * is the row a person is most certain about and the one a list without it cannot
 * identify. Sessions created before 0018 have no row and cannot appear; the
 * migration says so rather than this endpoint inventing one.
 */
sessionsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const ctx = getCtx(req);
    const body: SessionsResponse = {
      sessions: await listSessions(ctx.userId, ctx.sessionId),
    };
    res.json(body);
  })
);

/**
 * DELETE /v1/me/sessions/:id — end one device.
 *
 * **A session that is not yours is a 404, never a 403**, and the difference
 * matters: 403 confirms the id names something real, which is a fact about
 * somebody else's account. The same reasoning the sign-in path uses to refuse
 * being an account-existence oracle applies to every id in this domain.
 *
 * Ending the *current* session is allowed. It is the honest way to say "sign this
 * device out", the client discovers it on the next refresh, and refusing it would
 * mean the one device somebody is definitely holding is the one they cannot end.
 */
sessionsRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const ctx = getCtx(req);
    // `uuidParam` answers a malformed id with the same 404 a stranger's id gets,
    // rather than letting Postgres raise `22P02` on a uuid comparison.
    const id = uuidParam(req, 'id');

    const ended = await revokeSession(id, ctx.userId, {
      cause: ctx.sessionId === id ? 'SIGNED_OUT' : 'ENDED_BY_USER',
    });
    if (ended === 0) {
      // Already ended, expired, or somebody else's — one answer for all three. A
      // caller cannot tell "that was already over" from "that was never yours",
      // and neither can be acted on differently.
      throw new AppError('NOT_FOUND', 'Session not found');
    }

    const body: SessionsEndedResponse = { ended };
    res.json(body);
  })
);

/**
 * POST /v1/me/sessions/end-others — the panic button.
 *
 * Keeping the caller's own session is what makes this a control people use rather
 * than one they avoid: an action that also signs *you* out reads as a mistake you
 * just made, at the exact moment somebody is already worried.
 *
 * Without a `sid` claim — an access token minted before 0018 and still inside its
 * fifteen minutes — there is no session to keep, so this is refused rather than
 * silently ending everything including the caller's. The refusal names the fix,
 * because "sign in again" is a strange thing to be told while signed in.
 */
sessionsRouter.post(
  '/end-others',
  asyncHandler(async (req, res) => {
    const ctx = getCtx(req);
    if (!ctx.sessionId) {
      throw new AppError(
        'CONFLICT',
        'Sign in again before ending your other devices, so this one is not ended too'
      );
    }
    const body: SessionsEndedResponse = {
      ended: await revokeOtherSessions(ctx.userId, ctx.sessionId, { cause: 'ENDED_BY_USER' }),
    };
    res.json(body);
  })
);
