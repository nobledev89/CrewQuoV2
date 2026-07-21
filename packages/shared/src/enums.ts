import { z } from 'zod';

/**
 * Enumerated domain values. These mirror the CHECK constraints in the Postgres
 * schema (see CREWQUO_V2_PLAN.md §3). Keep them in sync with the migrations.
 */

export const MEMBERSHIP_ROLES = ['OWNER', 'ADMIN', 'MANAGER', 'MEMBER'] as const;
export const membershipRoleSchema = z.enum(MEMBERSHIP_ROLES);
export type MembershipRole = z.infer<typeof membershipRoleSchema>;

export const MEMBERSHIP_STATUSES = ['ACTIVE', 'INVITED', 'SUSPENDED'] as const;
export const membershipStatusSchema = z.enum(MEMBERSHIP_STATUSES);
export type MembershipStatus = z.infer<typeof membershipStatusSchema>;

export const ENGAGEMENT_STATUSES = ['PENDING', 'ACTIVE', 'PAUSED', 'ENDED'] as const;
export const engagementStatusSchema = z.enum(ENGAGEMENT_STATUSES);
export type EngagementStatus = z.infer<typeof engagementStatusSchema>;

export const WORK_STATUSES = ['DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED'] as const;
export const workStatusSchema = z.enum(WORK_STATUSES);
export type WorkStatus = z.infer<typeof workStatusSchema>;

export const RATE_KINDS = ['PAY', 'BILL'] as const;
export const rateKindSchema = z.enum(RATE_KINDS);
export type RateKind = z.infer<typeof rateKindSchema>;

export const RATE_MODES = ['HOURLY', 'SHIFT', 'DAILY'] as const;
export const rateModeSchema = z.enum(RATE_MODES);
export type RateMode = z.infer<typeof rateModeSchema>;

export const RATE_LABELS = [
  'MON_FRI_DAY',
  'FRI_SAT_NIGHT',
  'MON_THU_NIGHT',
  'SUNDAY',
  'SHIFT',
  'DAILY',
] as const;
export const rateLabelSchema = z.enum(RATE_LABELS);
export type RateLabel = z.infer<typeof rateLabelSchema>;

export const SHIFT_TYPES = ['WEEKDAY_DAY', 'NIGHT', 'SUNDAY', 'SHIFT', 'DAILY'] as const;
export const shiftTypeSchema = z.enum(SHIFT_TYPES);
export type ShiftType = z.infer<typeof shiftTypeSchema>;

export const PROJECT_STATUSES = ['PLANNED', 'ACTIVE', 'COMPLETED', 'ARCHIVED'] as const;
export const projectStatusSchema = z.enum(PROJECT_STATUSES);
export type ProjectStatus = z.infer<typeof projectStatusSchema>;

export const PLAN_STATUSES = ['DRAFT', 'ACTIVE', 'ARCHIVED'] as const;
export const planStatusSchema = z.enum(PLAN_STATUSES);
export type PlanStatus = z.infer<typeof planStatusSchema>;

export const SUBSCRIPTION_STATUSES = ['TRIALING', 'ACTIVE', 'PAST_DUE', 'CANCELED'] as const;
export const subscriptionStatusSchema = z.enum(SUBSCRIPTION_STATUSES);
export type SubscriptionStatus = z.infer<typeof subscriptionStatusSchema>;

export const PRICE_INTERVALS = ['MONTH', 'YEAR'] as const;
export const priceIntervalSchema = z.enum(PRICE_INTERVALS);
export type PriceInterval = z.infer<typeof priceIntervalSchema>;

export const INVOICE_STATUSES = ['DRAFT', 'ISSUED', 'PAID', 'VOID'] as const;
export const invoiceStatusSchema = z.enum(INVOICE_STATUSES);
export type InvoiceStatus = z.infer<typeof invoiceStatusSchema>;

/**
 * Rate engine: maps a logged shift type to the rate-card label used for lookup.
 * Ported from v1 functions/src/rates.ts (see CREWQUO_V2_PLAN.md §6).
 */
export const SHIFT_TYPE_TO_RATE_LABEL = {
  WEEKDAY_DAY: 'MON_FRI_DAY',
  NIGHT: 'MON_THU_NIGHT',
  SUNDAY: 'SUNDAY',
  SHIFT: 'SHIFT',
  DAILY: 'DAILY',
} as const satisfies Record<ShiftType, RateLabel>;
