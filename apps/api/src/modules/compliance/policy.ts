import { complianceWarning, type ComplianceProviderSummary } from '@crewquo/shared';
import { AppError } from '../../http/errors';
import { ensureSettings } from '../sustainability/settings';
import { providerCompliance } from './repo';

export interface ComplianceCheck {
  enforced: boolean;
  summary: Pick<ComplianceProviderSummary, 'overallStatus' | 'blocking' | 'expiring' | 'documentCount'>;
  warning: string | null;
}

/**
 * The single compliance gate used by scheduling and work submission. Reading it
 * never blocks; the caller chooses `refuseWhenEnforced` only on the two operations
 * §33 names.
 */
export async function checkProviderCompliance(args: {
  ownerCompanyId: string;
  providerCompanyId: string;
  refuseWhenEnforced?: boolean;
  action?: string;
}): Promise<ComplianceCheck> {
  const [settings, summary] = await Promise.all([
    ensureSettings(args.ownerCompanyId),
    providerCompliance(args.ownerCompanyId, args.providerCompanyId),
  ]);
  const warning = complianceWarning(summary);
  const enforced = settings.enforce_compliance;
  if (args.refuseWhenEnforced && enforced && summary.blocking.length > 0) {
    throw new AppError(
      'CONFLICT',
      `Compliance enforcement is on. ${args.action ?? 'This work'} cannot continue until ${warning ?? 'the provider’s mandatory records are current'}.`,
      { feature: 'compliance_tracking', providerCompanyId: args.providerCompanyId, blocking: summary.blocking }
    );
  }
  return { enforced, summary, warning };
}

