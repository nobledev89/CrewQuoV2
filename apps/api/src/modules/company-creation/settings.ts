import { getPlatformSettings } from '../admin/platform.repo';

/**
 * The two policy flags the creation gate reads (§3.1.1), named from this
 * domain's point of view rather than the console's.
 *
 * Both ship off, and both are waiting on a *different* Phase 6 bullet rather than
 * on a decision — which is why they are settings and not constants. Turning
 * either on is an operator action the day its dependency lands, not a deploy.
 */
export interface CompanyCreationSettings {
  /**
   * Gate the *automatic* first company on a verified address. Verification links
   * are only logged until Resend lands, so enabling it today would lock every new
   * signup out of its own company. The additional-company request requires
   * verification unconditionally and never reads this.
   */
  requireVerifiedEmail: boolean;
  /** Routes a paid-plan request to `PENDING_CHECKOUT`. False until Gumroad exists. */
  checkoutEnabled: boolean;
}

export async function getCompanyCreationSettings(): Promise<CompanyCreationSettings> {
  const settings = await getPlatformSettings();
  return {
    requireVerifiedEmail: settings.requireVerifiedEmailForFirstCompany,
    checkoutEnabled: settings.companyCheckoutEnabled,
  };
}
