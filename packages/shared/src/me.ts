import { z } from 'zod';
import { membershipSummarySchema, publicUserSchema } from './auth';

/** GET /v1/me — the authenticated profile. */
export const meResponseSchema = z.object({
  user: publicUserSchema,
});
export type MeResponse = z.infer<typeof meResponseSchema>;

/** GET /v1/me/memberships — company switcher source. */
export const membershipsResponseSchema = z.object({
  memberships: z.array(membershipSummarySchema),
});
export type MembershipsResponse = z.infer<typeof membershipsResponseSchema>;

/** ISO 4217 currency code; set once per company, rate cards inherit it (§3.1). */
export const currencyCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{3}$/, 'must be a 3-letter ISO 4217 code');

/** POST /v1/me/companies — create a company; the caller becomes OWNER. */
export const createCompanyRequestSchema = z.object({
  name: z.string().trim().min(1).max(200),
  currency: currencyCodeSchema.default('GBP'),
});
export type CreateCompanyRequest = z.infer<typeof createCompanyRequestSchema>;

export const companySummarySchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  currency: z.string(),
  isPlaceholder: z.boolean(),
});
export type CompanySummary = z.infer<typeof companySummarySchema>;
