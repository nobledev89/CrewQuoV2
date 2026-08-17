import { z } from 'zod';
import {
  engagementStatusSchema,
  inviteKindSchema,
  inviteStatusSchema,
  membershipRoleSchema,
} from './enums';

/**
 * Engagements, providers, members & invites (CREWQUO_V2_PLAN.md §3.2, §3.6, §7).
 * An engagement is the client⇄provider edge; roles are per-company, the client/
 * provider position is derived from the edge, never a user role.
 */

// ── Engagements ────────────────────────────────────────────────────────────────

export const engagementViewSchema = z.object({
  id: z.string().uuid(),
  clientCompanyId: z.string().uuid(),
  clientCompanyName: z.string(),
  providerCompanyId: z.string().uuid(),
  providerCompanyName: z.string(),
  providerIsPlaceholder: z.boolean(),
  status: engagementStatusSchema,
  createdByCompanyId: z.string().uuid(),
  /** 'client' when the active company is the hirer, 'provider' when the subcontractor. */
  side: z.enum(['client', 'provider']),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type EngagementView = z.infer<typeof engagementViewSchema>;

/** Create an engagement to an existing company (active company becomes the client). */
export const createEngagementSchema = z.object({
  providerCompanyId: z.string().uuid(),
});
export type CreateEngagement = z.infer<typeof createEngagementSchema>;

/** Only the status may be patched (pause / resume / end). */
export const updateEngagementSchema = z.object({
  status: engagementStatusSchema,
});
export type UpdateEngagement = z.infer<typeof updateEngagementSchema>;

// ── Providers (client side of my engagements) ──────────────────────────────────

export const providerViewSchema = z.object({
  engagementId: z.string().uuid(),
  providerCompanyId: z.string().uuid(),
  name: z.string(),
  currency: z.string(),
  isPlaceholder: z.boolean(),
  status: engagementStatusSchema,
});
export type ProviderView = z.infer<typeof providerViewSchema>;

/**
 * Create a provider: spins up a placeholder company, an engagement (active
 * company = client), and an ENGAGEMENT invite in one call.
 */
export const createProviderSchema = z.object({
  name: z.string().trim().min(1).max(200),
  email: z.string().trim().toLowerCase().email(),
  currency: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{3}$/)
    .optional(),
});
export type CreateProvider = z.infer<typeof createProviderSchema>;

export const createProviderResponseSchema = z.object({
  provider: providerViewSchema,
  inviteToken: z.string(),
});
export type CreateProviderResponse = z.infer<typeof createProviderResponseSchema>;

// ── Clients (provider side of my engagements) ──────────────────────────────────

/** The mirror of ProviderView: an engagement seen from the provider's side. */
export const clientViewSchema = z.object({
  engagementId: z.string().uuid(),
  clientCompanyId: z.string().uuid(),
  name: z.string(),
  currency: z.string(),
  isPlaceholder: z.boolean(),
  status: engagementStatusSchema,
});
export type ClientView = z.infer<typeof clientViewSchema>;

/**
 * Create a client: placeholder company + engagement (active company = provider)
 * + CLIENT_PORTAL invite. The counterpart to `createProviderSchema`, and the only
 * origin of a CLIENT_PORTAL invite.
 */
export const createClientSchema = z.object({
  name: z.string().trim().min(1).max(200),
  email: z.string().trim().toLowerCase().email(),
  currency: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{3}$/)
    .optional(),
});
export type CreateClient = z.infer<typeof createClientSchema>;

export const createClientResponseSchema = z.object({
  client: clientViewSchema,
  inviteToken: z.string(),
});
export type CreateClientResponse = z.infer<typeof createClientResponseSchema>;

// ── Members ─────────────────────────────────────────────────────────────────────

export const memberViewSchema = z.object({
  userId: z.string().uuid(),
  name: z.string(),
  email: z.string(),
  role: membershipRoleSchema,
  status: z.enum(['ACTIVE', 'INVITED', 'SUSPENDED']),
});
export type MemberView = z.infer<typeof memberViewSchema>;

/** Invite a member to the active company (MEMBER-kind invite). */
export const inviteMemberSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  role: membershipRoleSchema.default('MEMBER'),
});
export type InviteMember = z.infer<typeof inviteMemberSchema>;

// ── Invites (public accept flow) ──────────────────────────────────────────────

export const inviteViewSchema = z.object({
  token: z.string(),
  kind: inviteKindSchema,
  targetCompanyId: z.string().uuid(),
  targetCompanyName: z.string(),
  email: z.string(),
  role: membershipRoleSchema.nullable(),
  engagementId: z.string().uuid().nullable(),
  status: inviteStatusSchema,
  expiresAt: z.string(),
});
export type InviteView = z.infer<typeof inviteViewSchema>;

/**
 * What accepting an ENGAGEMENT/CLIENT_PORTAL invite did with the placeholder
 * company that was standing in for the invitee (owner decision, 2026-08-17:
 * auto-merge, no confirmation prompt).
 *
 *  - `CLAIMED`  — the invitee had no company of their own, so they simply became
 *                 OWNER of the placeholder and it is now their real company.
 *  - `MERGED`   — the invitee already ran a company; the placeholder was marked
 *                 claimed and the edge (plus its assignments and work) re-pointed
 *                 at the real one.
 *  - `SKIPPED`  — a merge was possible in principle but would have collided with
 *                 an existing edge, assignment, or the client company itself.
 *                 Nothing was re-pointed; the invitee claimed the placeholder
 *                 instead and `reason` says why. Never silently destructive.
 */
export const mergeOutcomeSchema = z.object({
  outcome: z.enum(['CLAIMED', 'MERGED', 'SKIPPED']),
  placeholderCompanyId: z.string().uuid(),
  mergedIntoCompanyId: z.string().uuid().nullable(),
  reason: z.string().nullable(),
});
export type MergeOutcome = z.infer<typeof mergeOutcomeSchema>;

export const acceptInviteResponseSchema = z.object({
  companyId: z.string().uuid(),
  role: membershipRoleSchema,
  /** Present only for ENGAGEMENT / CLIENT_PORTAL invites. */
  merge: mergeOutcomeSchema.optional(),
});
export type AcceptInviteResponse = z.infer<typeof acceptInviteResponseSchema>;
