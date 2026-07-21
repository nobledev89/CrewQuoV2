import { z } from 'zod';
import { membershipRoleSchema } from './enums';

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
