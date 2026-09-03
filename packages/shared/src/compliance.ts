import { z } from 'zod';

/** Subcontractor compliance (§33). All date arithmetic is calendar-date based. */
export const COMPLIANCE_KINDS = [
  'PUBLIC_LIABILITY',
  'EMPLOYERS_LIABILITY',
  'PROFESSIONAL_INDEMNITY',
  'RAMS',
  'TRAINING',
  'QUALIFICATION',
  'LICENCE',
  'CERTIFICATE',
  'OTHER',
] as const;
export const complianceKindSchema = z.enum(COMPLIANCE_KINDS);
export type ComplianceKind = z.infer<typeof complianceKindSchema>;

export const COMPLIANCE_STATUSES = [
  'VALID',
  'EXPIRING',
  'EXPIRED',
  'MISSING',
  'REJECTED',
] as const;
export const complianceStatusSchema = z.enum(COMPLIANCE_STATUSES);
export type ComplianceStatus = z.infer<typeof complianceStatusSchema>;

export const COMPLIANCE_ALERT_THRESHOLDS = [90, 60, 30, 14, 7] as const;
export type ComplianceAlertThreshold = (typeof COMPLIANCE_ALERT_THRESHOLDS)[number];

const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const optionalText = (max: number) => z.string().trim().max(max).nullable().optional();

export const createComplianceDocumentSchema = z
  .object({
    subjectCompanyId: z.string().uuid(),
    engagementId: z.string().uuid().nullable().optional(),
    kind: complianceKindSchema,
    title: z.string().trim().min(1).max(200),
    reference: optionalText(200),
    insurer: optionalText(200),
    coverAmountCents: z.number().int().nonnegative().safe().nullable().optional(),
    fileId: z.string().uuid().nullable().optional(),
    issuedOn: isoDateSchema.nullable().optional(),
    expiresOn: isoDateSchema.nullable().optional(),
    mandatory: z.boolean().default(true),
    notes: optionalText(4000),
    supersedesId: z.string().uuid().nullable().optional(),
  })
  .superRefine((value, ctx) => {
    if (value.issuedOn && value.expiresOn && value.expiresOn < value.issuedOn) {
      ctx.addIssue({ code: 'custom', path: ['expiresOn'], message: 'Expiry cannot precede issue' });
    }
    if (value.supersedesId && !value.fileId) {
      ctx.addIssue({ code: 'custom', path: ['fileId'], message: 'A renewal needs a file' });
    }
  });
export type CreateComplianceDocument = z.infer<typeof createComplianceDocumentSchema>;

export const updateComplianceDocumentSchema = z
  .object({
    expectedRevision: z.number().int().positive(),
    title: z.string().trim().min(1).max(200).optional(),
    reference: optionalText(200),
    insurer: optionalText(200),
    coverAmountCents: z.number().int().nonnegative().safe().nullable().optional(),
    issuedOn: isoDateSchema.nullable().optional(),
    expiresOn: isoDateSchema.nullable().optional(),
    mandatory: z.boolean().optional(),
    notes: optionalText(4000),
    review: z
      .object({
        decision: z.enum(['ACCEPT', 'REJECT']),
        reason: z.string().trim().min(1).max(1000).nullable().optional(),
      })
      .optional(),
  })
  .superRefine((value, ctx) => {
    if (value.review?.decision === 'REJECT' && !value.review.reason) {
      ctx.addIssue({ code: 'custom', path: ['review', 'reason'], message: 'A rejection needs a reason' });
    }
    if (value.issuedOn && value.expiresOn && value.expiresOn < value.issuedOn) {
      ctx.addIssue({ code: 'custom', path: ['expiresOn'], message: 'Expiry cannot precede issue' });
    }
  });
export type UpdateComplianceDocument = z.infer<typeof updateComplianceDocumentSchema>;

export const complianceListQuerySchema = z.object({
  subjectCompanyId: z.string().uuid().optional(),
  status: complianceStatusSchema.optional(),
  expiringWithinDays: z.coerce.number().int().min(0).max(3650).optional(),
  includeHistory: z.enum(['true', 'false']).optional(),
});

export interface ComplianceDocumentView {
  id: string;
  subjectCompanyId: string;
  subjectCompanyName: string;
  ownerCompanyId: string;
  ownerCompanyName: string;
  engagementId: string | null;
  kind: ComplianceKind;
  title: string;
  reference: string | null;
  insurer: string | null;
  coverAmountCents: number | null;
  fileId: string | null;
  issuedOn: string | null;
  expiresOn: string | null;
  status: ComplianceStatus;
  mandatory: boolean;
  rejectReason: string | null;
  verifiedByUserId: string | null;
  verifiedAt: string | null;
  notes: string | null;
  uploadedByUserId: string | null;
  supersedesId: string | null;
  superseded: boolean;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export type ComplianceOverallStatus = ComplianceStatus | 'UNKNOWN';

export interface ComplianceProviderSummary {
  engagementId: string;
  subjectCompanyId: string;
  subjectCompanyName: string;
  overallStatus: ComplianceOverallStatus;
  blocking: Array<{ kind: ComplianceKind; title: string; status: ComplianceStatus }>;
  expiring: Array<{ kind: ComplianceKind; title: string; expiresOn: string | null }>;
  documentCount: number;
}

export interface ComplianceSummaryView {
  providers: ComplianceProviderSummary[];
  totals: Record<ComplianceOverallStatus, number>;
  enforceCompliance: boolean;
}

function utcDay(value: string): number {
  const [year, month, day] = value.split('-').map(Number);
  return Date.UTC(year!, month! - 1, day!);
}

export function complianceDaysUntil(expiresOn: string, today: string): number {
  return Math.round((utcDay(expiresOn) - utcDay(today)) / 86_400_000);
}

export function deriveComplianceStatus(input: {
  fileId: string | null;
  expiresOn: string | null;
  today: string;
  rejected: boolean;
}): ComplianceStatus {
  if (input.rejected) return 'REJECTED';
  if (!input.fileId) return 'MISSING';
  if (!input.expiresOn) return 'VALID';
  const days = complianceDaysUntil(input.expiresOn, input.today);
  if (days < 0) return 'EXPIRED';
  return days <= COMPLIANCE_ALERT_THRESHOLDS[0] ? 'EXPIRING' : 'VALID';
}

/** The next rung at or above the remaining days; null outside the ladder. */
export function complianceAlertThreshold(daysRemaining: number): ComplianceAlertThreshold | null {
  if (!Number.isFinite(daysRemaining) || daysRemaining < 0 || daysRemaining > 90) return null;
  for (let i = COMPLIANCE_ALERT_THRESHOLDS.length - 1; i >= 0; i -= 1) {
    const rung = COMPLIANCE_ALERT_THRESHOLDS[i]!;
    if (daysRemaining <= rung) return rung;
  }
  return null;
}

const BEST_STATUS: Record<ComplianceStatus, number> = {
  VALID: 5,
  EXPIRING: 4,
  EXPIRED: 3,
  REJECTED: 2,
  MISSING: 1,
};

/**
 * Evaluate current mandatory rows by kind. A valid self-filed certificate may
 * satisfy a hirer's explicit missing requirement of the same kind; without this,
 * recording the requirement first would make it impossible to clear without
 * mutating the placeholder and erasing its history.
 */
export function evaluateCompliance(
  documents: readonly Pick<ComplianceDocumentView, 'kind' | 'title' | 'status' | 'mandatory' | 'expiresOn'>[]
): Pick<ComplianceProviderSummary, 'overallStatus' | 'blocking' | 'expiring' | 'documentCount'> {
  const mandatory = documents.filter((document) => document.mandatory);
  if (mandatory.length === 0) {
    return { overallStatus: 'UNKNOWN', blocking: [], expiring: [], documentCount: documents.length };
  }

  const bestByKind = new Map<ComplianceKind, (typeof mandatory)[number]>();
  for (const document of mandatory) {
    const current = bestByKind.get(document.kind);
    if (!current || BEST_STATUS[document.status] > BEST_STATUS[current.status]) {
      bestByKind.set(document.kind, document);
    }
  }
  const best = [...bestByKind.values()];
  const blocking = best
    .filter((document) => ['EXPIRED', 'MISSING', 'REJECTED'].includes(document.status))
    .map(({ kind, title, status }) => ({ kind, title, status }));
  const expiring = best
    .filter((document) => document.status === 'EXPIRING')
    .map(({ kind, title, expiresOn }) => ({ kind, title, expiresOn }));

  let overallStatus: ComplianceOverallStatus = 'VALID';
  if (blocking.some((document) => document.status === 'MISSING')) overallStatus = 'MISSING';
  else if (blocking.some((document) => document.status === 'REJECTED')) overallStatus = 'REJECTED';
  else if (blocking.some((document) => document.status === 'EXPIRED')) overallStatus = 'EXPIRED';
  else if (expiring.length > 0) overallStatus = 'EXPIRING';

  return { overallStatus, blocking, expiring, documentCount: documents.length };
}

export function complianceWarning(summary: Pick<ComplianceProviderSummary, 'blocking' | 'expiring'>): string | null {
  const rows = [
    ...summary.blocking.map((row) => `${row.title} (${row.status.toLowerCase()})`),
    ...summary.expiring.map((row) => `${row.title} (expiring)`),
  ];
  return rows.length === 0 ? null : rows.join(', ');
}
