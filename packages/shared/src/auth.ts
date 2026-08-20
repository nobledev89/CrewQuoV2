import { z } from 'zod';
import { membershipRoleSchema } from './enums';
import { SESSION_REVOKE_CAUSES, SESSION_STATES } from './access';

/**
 * Auth request/response contracts (CREWQUO_V2_PLAN.md §5, §7). One schema per
 * endpoint; the API validates request bodies and the api-client derives types.
 */

export const emailSchema = z.string().trim().toLowerCase().email();
// bcrypt truncates at 72 bytes; cap length to avoid surprising truncation.
export const passwordSchema = z.string().min(8).max(72);

export const registerRequestSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  name: z.string().trim().min(1).max(200),
  companyName: z.string().trim().min(1).max(200).optional(), // creates an OWNER company
});
export type RegisterRequest = z.infer<typeof registerRequestSchema>;

export const loginRequestSchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(72),
});
export type LoginRequest = z.infer<typeof loginRequestSchema>;

export const googleRequestSchema = z.object({
  idToken: z.string().min(1),
});
export type GoogleRequest = z.infer<typeof googleRequestSchema>;

export const refreshRequestSchema = z.object({
  refreshToken: z.string().min(1),
});
export type RefreshRequest = z.infer<typeof refreshRequestSchema>;

export const logoutRequestSchema = z.object({
  refreshToken: z.string().min(1),
});
export type LogoutRequest = z.infer<typeof logoutRequestSchema>;

export const requestPasswordResetRequestSchema = z.object({
  email: emailSchema,
});
export type RequestPasswordResetRequest = z.infer<typeof requestPasswordResetRequestSchema>;

export const resetPasswordRequestSchema = z.object({
  token: z.string().min(1),
  password: passwordSchema,
});
export type ResetPasswordRequest = z.infer<typeof resetPasswordRequestSchema>;

export const verifyEmailRequestSchema = z.object({
  token: z.string().min(1),
});
export type VerifyEmailRequest = z.infer<typeof verifyEmailRequestSchema>;

/** Public user shape returned by the API (never includes password_hash). */
export const publicUserSchema = z.object({
  id: z.string().uuid(),
  email: z.string().email(),
  name: z.string(),
  avatarUrl: z.string().nullable(),
  isSuperAdmin: z.boolean(),
  emailVerified: z.boolean(),
});
export type PublicUser = z.infer<typeof publicUserSchema>;

/** A company the user belongs to, with their role — the switcher source. */
export const membershipSummarySchema = z.object({
  companyId: z.string().uuid(),
  companyName: z.string(),
  currency: z.string(),
  /**
   * The company's IANA zone, because **the browser's day is not the company's day**
   * and at least one screen was deciding a rule on the wrong one.
   *
   * `isRetroactive` keys the §3.3.1 back-dating safeguard off "today", and the API
   * resolves that against the *hiring company's* zone (`time.md` — the packet exists
   * because a UTC "today" had this exact bug server-side). The commercial screen was
   * computing the same predicate from the viewer's browser zone to decide whether to
   * warn, so a London reviewer and a Manila company disagreed for eight hours of
   * every day — the screen showing no warning and no reason field, and the server
   * then refusing the submit with a 403 the screen never predicted.
   *
   * Cached here beside `currency` for the same reason `currency` is: it is a
   * company-level label every screen needs and nothing should refetch per render.
   * A screen that changes it must call `refreshMemberships()`.
   */
  timeZone: z.string(),
  role: membershipRoleSchema,
});
export type MembershipSummary = z.infer<typeof membershipSummarySchema>;

/** Token pair returned on register/login/google/refresh. */
export const authTokensSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  expiresIn: z.number().int(), // access-token lifetime, seconds
});
export type AuthTokens = z.infer<typeof authTokensSchema>;

export const authResponseSchema = z.object({
  user: publicUserSchema,
  memberships: z.array(membershipSummarySchema),
  tokens: authTokensSchema,
});
export type AuthResponse = z.infer<typeof authResponseSchema>;

// ── Second factors ────────────────────────────────────────────────────────────
//
// `docs/operating-model/access.md` §3, §4. Enrolment is `NONE → PENDING → ACTIVE`,
// and the shapes below exist to make the middle state impossible to skip.

/** GET /v1/me/mfa — what this account holds, and what it is required to hold. */
export const mfaStatusSchema = z.object({
  state: z.enum(['NONE', 'PENDING', 'ACTIVE']),
  /** True for platform staff (§13.1). Customers are offered a factor, never made to hold one. */
  required: z.boolean(),
  confirmedAt: z.string().nullable(),
  /** How many single-use recovery codes are left. Zero is worth warning about. */
  recoveryCodesRemaining: z.number().int().min(0),
});
export type MfaStatus = z.infer<typeof mfaStatusSchema>;

/**
 * POST /v1/me/mfa — begin enrolment.
 *
 * **The secret is in the response, and this is the only time it ever will be.**
 * Everything after this point compares codes; there is no endpoint that reads a
 * secret back, and a future screen that wants one is a bug in the request rather
 * than a missing feature (§2).
 */
export const mfaEnrolmentSchema = z.object({
  /** Base32, for an app that cannot scan and for somebody typing it by hand. */
  secret: z.string(),
  /** `otpauth://` — what a QR code encodes. */
  uri: z.string(),
});
export type MfaEnrolment = z.infer<typeof mfaEnrolmentSchema>;

/** POST /v1/me/mfa/confirm — prove the app is set up before it counts as a factor. */
export const mfaConfirmSchema = z.object({
  code: z.string().trim().min(6).max(10),
});
export type MfaConfirm = z.infer<typeof mfaConfirmSchema>;

/**
 * The recovery codes, returned exactly once each time the set is created.
 *
 * Shown after confirmation rather than alongside the QR: codes handed over before
 * the factor is proven are codes for a factor that may never exist, and people
 * save them anyway.
 */
export const mfaRecoveryCodesSchema = z.object({
  codes: z.array(z.string()),
});
export type MfaRecoveryCodes = z.infer<typeof mfaRecoveryCodesSchema>;

/**
 * DELETE /v1/me/mfa — remove the factor. **Step-up re-authentication required.**
 *
 * Adding protection is never the dangerous direction, so enrolment asks for
 * nothing; removing it is exactly what somebody holding a stolen access token
 * would do first (§4). Google-only accounts prove themselves with an ID token for
 * the same reason the additional-company flow does — they have no password to
 * re-enter.
 */
export const mfaRemoveSchema = z.object({
  password: z.string().min(1).max(72).optional(),
  googleIdToken: z.string().min(1).optional(),
});
// Deliberately no `.refine` requiring one of them. An empty body is refused by
// `requireStepUpAuth`, which knows whether this account even *has* a password —
// a Google-only user asked to "confirm your password" is being asked for something
// they do not have, and a schema cannot tell the difference.
export type MfaRemove = z.infer<typeof mfaRemoveSchema>;

/**
 * What `POST /v1/auth/login` answers with when the account holds a factor.
 *
 * A discriminated union rather than a nullable-token response, because the two
 * outcomes mean genuinely different things to a client and the compiler should not
 * let one be mistaken for the other. **An older client that does not know about
 * `mfa_required` sees a response with no `tokens` and fails to sign in** — which is
 * the correct failure: the alternative is a client that believes it signed in
 * without a factor being checked.
 */
export const loginChallengeSchema = z.object({
  status: z.literal('mfa_required'),
  /** Short-lived, single-purpose, and useless for anything but answering this challenge. */
  challengeToken: z.string(),
  /** Whether spending a recovery code is an option, so the screen can offer it honestly. */
  recoveryAvailable: z.boolean(),
});
export type LoginChallenge = z.infer<typeof loginChallengeSchema>;

export const loginResultSchema = z.union([
  authResponseSchema.extend({ status: z.literal('signed_in').optional() }),
  loginChallengeSchema,
]);
export type LoginResult = z.infer<typeof loginResultSchema>;

/** POST /v1/auth/mfa — answer the challenge with a code, or with a recovery code. */
export const mfaChallengeAnswerSchema = z
  .object({
    challengeToken: z.string().min(1),
    code: z.string().trim().min(6).max(12).optional(),
    recoveryCode: z.string().trim().min(6).max(20).optional(),
  })
  .refine((v) => Boolean(v.code || v.recoveryCode), {
    message: 'Enter the code from your authenticator app, or one of your recovery codes',
  });
export type MfaChallengeAnswer = z.infer<typeof mfaChallengeAnswerSchema>;

/** POST /v1/admin/users/:id/reset-mfa — the operator path (§13.2). Reason required. */
export const adminResetMfaSchema = z.object({
  reason: z.string().trim().min(8).max(500),
});
export type AdminResetMfa = z.infer<typeof adminResetMfaSchema>;

// ── Sessions & devices ────────────────────────────────────────────────────────
//
// `docs/operating-model/access.md` §4. Every read is the caller's own: another
// user's session id is a **404, not a 403**, because "that exists but is not
// yours" is a fact about somebody else's account and this surface answers no
// questions about other accounts.

/**
 * One sign-in on one device, as the holder sees it.
 *
 * **The operator's stated reason is deliberately absent.** A revocation by
 * platform staff requires a reason (§13.2) and that reason is evidence — it lands
 * in `platform_audit_logs`, which is insert-only and outside every purge. It is
 * not a message to the customer: internal support notes rendered into somebody
 * else's device list would be a private field with a public reader. The holder is
 * told *that* an operator ended their sessions, unconditionally, and support
 * explains why in the conversation that produced the reason.
 */
export const sessionViewSchema = z.object({
  id: z.string().uuid(),
  /** Coarse, from the User-Agent family. Null renders as "Unknown device". */
  deviceLabel: z.string().nullable(),
  state: z.enum(SESSION_STATES),
  /** True for the session whose access token made this request. */
  current: z.boolean(),
  createdAt: z.string(),
  lastUsedAt: z.string(),
  expiresAt: z.string(),
  endedAt: z.string().nullable(),
  endedCause: z.enum(SESSION_REVOKE_CAUSES).nullable(),
});
export type SessionView = z.infer<typeof sessionViewSchema>;

export const sessionsResponseSchema = z.object({
  sessions: z.array(sessionViewSchema),
});
export type SessionsResponse = z.infer<typeof sessionsResponseSchema>;

/** How many sessions an action ended — 0 is a success, not a failure. */
export const sessionsEndedResponseSchema = z.object({
  ended: z.number().int().min(0),
});
export type SessionsEndedResponse = z.infer<typeof sessionsEndedResponseSchema>;
