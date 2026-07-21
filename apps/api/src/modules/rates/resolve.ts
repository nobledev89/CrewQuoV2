import { selectEffectiveCard, type RateCardView } from '@crewquo/shared';

/**
 * Pick the effective rate card from resolve candidates (§6). A counterparty-
 * specific card always wins over the default (null-counterparty) card when one
 * is effective on the date; otherwise the default applies. Pure over plain data
 * so the preference rule is unit-tested in isolation.
 */
export function pickEffectiveCard(
  candidates: readonly RateCardView[],
  isoDate: string,
  counterpartyId?: string
): RateCardView | null {
  const scoped = counterpartyId
    ? candidates.filter((c) => c.counterpartyCompanyId === counterpartyId)
    : [];
  const defaults = candidates.filter((c) => c.counterpartyCompanyId === null);
  return selectEffectiveCard(scoped, isoDate) ?? selectEffectiveCard(defaults, isoDate);
}
