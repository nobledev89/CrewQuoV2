'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  AgreementRate,
  CommercialAgreement,
  EngagementView,
  RateLabel,
  RateMode,
  RateProposalLineInput,
  RateProposalView,
  RoleCatalogView,
} from '@crewquo/shared';
import {
  RATE_LABELS,
  RATE_MODES,
  isRetroactive,
  supersededEffectiveTo,
} from '@crewquo/shared';
import {
  Badge,
  Button,
  Drawer,
  EmptyState,
  ErrorText,
  Field,
  Input,
  Notice,
  PageHeader,
  RecordHeader,
  Row,
  Section,
  Select,
  Stack,
  Table,
} from '@crewquo/ui';
import { Shell } from '@/components/Shell';
import { api, ApiError } from '@/api/client';
import { useAuth, useSessionCtx } from '@/auth/AuthProvider';
import { useAsyncData } from '@/lib/useAsyncData';
import { useAsyncList } from '@/lib/useAsyncList';
import { centsToInput, formatCents, formatDate, formatDateTime, inputToCents, titleCase, todayIso } from '@/lib/format';

/**
 * Commercial agreements (§3.3.1) — one screen for both sides of a PAY negotiation.
 *
 * Deliberately **not** two screens. A company can be the provider on one edge and
 * the hiring party on another (§3.2), so "am I proposing or deciding?" is a property
 * of the engagement in front of you, not of who you are. The same mistake was
 * caught and rejected in Phase 5.5 for the portal shell; the fix is the same —
 * branch on the edge, at the row.
 *
 * The reviewer's central need is *what changes*, so every proposed line renders
 * beside the amount currently in force. The API supplies that comparison
 * (`currentAmountCents`) rather than the browser assembling it, so the number the
 * reviewer approves against is the same one the approval will supersede.
 */
export default function CommercialPage() {
  return (
    <Shell>
      <Commercial />
    </Shell>
  );
}

type DraftLine = {
  operation: 'CREATE' | 'REPLACE' | 'END';
  roleId: string;
  rateLabel: RateLabel;
  rateMode: RateMode;
  amount: string;
  otAmount: string;
  minHours: string;
  replacesRateCardId: string;
};

const BLANK_LINE: DraftLine = {
  operation: 'CREATE',
  roleId: '',
  rateLabel: 'MON_FRI_DAY',
  rateMode: 'HOURLY',
  amount: '',
  otAmount: '',
  minHours: '',
  replacesRateCardId: '',
};

/** The amount field a mode actually requires (§6 `extractRate`). */
function amountFieldFor(mode: RateMode): 'hourlyRateCents' | 'shiftRateCents' | 'dailyRateCents' {
  if (mode === 'HOURLY') return 'hourlyRateCents';
  if (mode === 'SHIFT') return 'shiftRateCents';
  return 'dailyRateCents';
}

function toLineInput(line: DraftLine): RateProposalLineInput {
  const amounts = {
    hourlyRateCents: null as number | null,
    otHourlyRateCents: null as number | null,
    shiftRateCents: null as number | null,
    dailyRateCents: null as number | null,
  };
  // An END line closes a rate and carries no amount at all, so nothing is parsed
  // into it — the API refuses one that arrives priced.
  if (line.operation !== 'END') {
    amounts[amountFieldFor(line.rateMode)] = inputToCents(line.amount);
    if (line.rateMode === 'HOURLY') amounts.otHourlyRateCents = inputToCents(line.otAmount);
  }
  return {
    operation: line.operation,
    roleId: line.roleId,
    rateLabel: line.rateLabel,
    rateMode: line.rateMode,
    ...amounts,
    minHours: line.operation === 'END' ? null : inputToCents(line.minHours) === null ? null : Number(line.minHours),
    weekendMultiplier: null,
    nightMultiplier: null,
    replacesRateCardId: line.operation === 'CREATE' ? null : line.replacesRateCardId || null,
  };
}

/** The single amount a card or line carries, whichever mode it is in. */
function lineAmount(line: RateProposalView['lines'][number]): number | null {
  if (line.operation === 'END') return null;
  if (line.rateMode === 'HOURLY') return line.hourlyRateCents;
  if (line.rateMode === 'SHIFT') return line.shiftRateCents;
  return line.dailyRateCents;
}

function Commercial() {
  const ctx = useSessionCtx();
  const { activeMembership } = useAuth();
  const role = activeMembership?.role;
  const isManager = role === 'OWNER' || role === 'ADMIN' || role === 'MANAGER';
  const isOwner = role === 'OWNER';

  const [selected, setSelected] = useState<string | null>(null);

  // The selected engagement lives in the URL so a link to "this negotiation" works.
  useEffect(() => {
    const fromUrl = new URLSearchParams(window.location.search).get('engagement');
    if (fromUrl) setSelected(fromUrl);
  }, []);
  const select = useCallback((id: string | null) => {
    setSelected(id);
    const url = new URL(window.location.href);
    if (id) url.searchParams.set('engagement', id);
    else url.searchParams.delete('engagement');
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}`);
  }, []);

  const engagements = useAsyncList<EngagementView>(
    ctx ? () => api.listEngagements(ctx.accessToken, ctx.companyId).then((r) => r.data) : null,
    [ctx?.companyId]
  );
  const proposals = useAsyncList<RateProposalView>(
    ctx ? () => api.listRateProposals(ctx.accessToken, ctx.companyId).then((r) => r.data) : null,
    [ctx?.companyId]
  );

  const openByEngagement = useMemo(() => {
    const map = new Map<string, RateProposalView>();
    for (const p of proposals.items) {
      if (p.status === 'DRAFT' || p.status === 'SUBMITTED') map.set(p.engagementId, p);
    }
    return map;
  }, [proposals.items]);

  // An ENDED edge cannot take new work, so it cannot take a new rate either.
  const live = engagements.items.filter((e) => e.status !== 'ENDED');
  const awaitingMyDecision = proposals.items.filter(
    (p) => p.status === 'SUBMITTED' && p.side === 'client'
  ).length;
  const awaitingTheirDecision = proposals.items.filter(
    (p) => p.status === 'SUBMITTED' && p.side === 'provider'
  ).length;

  if (selected) {
    return (
      <AgreementDetail
        engagementId={selected}
        onBack={() => select(null)}
        isManager={isManager}
        isOwner={isOwner}
        onChanged={() => proposals.reload()}
      />
    );
  }

  return (
    <Stack>
      <PageHeader
        eyebrow="Rates"
        title="Commercial agreements"
        description="The PAY rates agreed with each company you work with, and the schedules waiting on a decision."
      />

      <div className="cq-metrics" aria-label="Agreement summary">
        <div className="cq-metric">
          <div className="cq-overline">Awaiting your decision</div>
          <div className="cq-metric__value">{proposals.loading ? '—' : awaitingMyDecision}</div>
          <div className="cq-metric__context">Schedules subcontractors have sent you</div>
        </div>
        <div className="cq-metric">
          <div className="cq-overline">Awaiting their decision</div>
          <div className="cq-metric__value">{proposals.loading ? '—' : awaitingTheirDecision}</div>
          <div className="cq-metric__context">Schedules you have sent upstream</div>
        </div>
        <div className="cq-metric">
          <div className="cq-overline">Relationships</div>
          <div className="cq-metric__value">{engagements.loading ? '—' : live.length}</div>
          <div className="cq-metric__context">Engagements that can carry a rate</div>
        </div>
      </div>

      <Section
        title="Engagements"
        description="Open one to see the rates in force, agree a change, or set payment terms."
        className="cq-section--table"
      >
        <ErrorText>{engagements.error ?? proposals.error}</ErrorText>
        {engagements.loading ? (
          <p className="cq-muted">Loading engagements…</p>
        ) : live.length === 0 ? (
          <EmptyState title="No engagements to price yet">
            A commercial agreement sits on a relationship. Add a subcontractor, or accept an
            invitation from a company that wants to hire you, and the agreement appears here.
          </EmptyState>
        ) : (
          <Table label="Engagements with commercial agreements" compact>
            <thead>
              <tr>
                <th scope="col">Counterparty</th>
                <th scope="col">Your position</th>
                <th scope="col">Open schedule</th>
                <th scope="col">
                  <span className="cq-table__actions">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {live.map((e) => {
                const open = openByEngagement.get(e.id);
                const counterparty =
                  e.side === 'client' ? e.providerCompanyName : e.clientCompanyName;
                return (
                  <tr key={e.id}>
                    <td className="cq-table__primary">{counterparty}</td>
                    <td>
                      {/* The words matter more than the enum: "you pay them" is the
                          fact that decides who proposes and who approves. */}
                      {e.side === 'client' ? 'You pay them' : 'They pay you'}
                    </td>
                    <td>
                      {open ? (
                        <ProposalStatusBadge status={open.status} />
                      ) : (
                        <span className="cq-muted">None</span>
                      )}
                    </td>
                    <td className="cq-table__actions">
                      <Button size="sm" variant="secondary" onClick={() => select(e.id)}>
                        Open
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        )}
      </Section>
    </Stack>
  );
}

function ProposalStatusBadge({ status }: { status: RateProposalView['status'] }) {
  const tone =
    status === 'APPROVED'
      ? 'success'
      : status === 'SUBMITTED'
        ? 'warning'
        : status === 'REJECTED'
          ? 'warning'
          : 'neutral';
  return <Badge tone={tone}>{titleCase(status)}</Badge>;
}

function AgreementDetail({
  engagementId,
  onBack,
  isManager,
  isOwner,
  onChanged,
}: {
  engagementId: string;
  onBack: () => void;
  isManager: boolean;
  isOwner: boolean;
  onChanged: () => void;
}) {
  const ctx = useSessionCtx();
  const agreement = useAsyncData<CommercialAgreement>(
    ctx
      ? () =>
          api
            .getCommercialAgreement(ctx.accessToken, ctx.companyId, engagementId)
            .then((r) => r.agreement)
      : null,
    [ctx?.companyId, engagementId]
  );
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [termsOpen, setTermsOpen] = useState(false);
  const [proposeOpen, setProposeOpen] = useState(false);

  const a = agreement.data;
  const isHiring = a?.side === 'client';
  const isProviding = a?.side === 'provider';

  async function act(run: () => Promise<void>, success: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await run();
      setNotice(success);
      agreement.reload();
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  }

  // Branch on `loading && !data`, never `loading`: a post-save reload must not
  // unmount the panel and discard the notice it just set (Phase 5.5 note).
  if (agreement.loading && !a) {
    return (
      <Stack>
        <PageHeader eyebrow="Rates" title="Commercial agreement" />
        <p className="cq-muted">Loading agreement…</p>
      </Stack>
    );
  }
  if (!a) {
    return (
      <Stack>
        <PageHeader
          eyebrow="Rates"
          title="Commercial agreement"
          actions={
            <Button variant="secondary" size="sm" onClick={onBack}>
              Back
            </Button>
          }
        />
        <ErrorText>{agreement.error ?? 'Agreement not found'}</ErrorText>
      </Stack>
    );
  }

  const counterparty = isHiring ? a.providerCompanyName : a.clientCompanyName;
  const openProposal = a.proposals.find(
    (p) => p.status === 'DRAFT' || p.status === 'SUBMITTED'
  );

  return (
    <Stack>
      <PageHeader
        eyebrow="Commercial agreement"
        title={counterparty}
        description={
          isHiring
            ? 'You hire this company. They propose their PAY rates; you approve or return them.'
            : 'This company hires you. You propose your PAY rates; they approve or return them.'
        }
        actions={
          <Row>
            <Button variant="secondary" size="sm" onClick={onBack}>
              Back
            </Button>
            {isHiring && isManager ? (
              <Button variant="secondary" size="sm" onClick={() => setTermsOpen(true)}>
                Edit terms
              </Button>
            ) : null}
            {isManager && !openProposal ? (
              <Button size="sm" onClick={() => setProposeOpen(true)}>
                {isProviding ? 'Propose new rates' : 'Record agreed rates'}
              </Button>
            ) : null}
          </Row>
        }
      />

      <RecordHeader
        figures={[
          {
            label: 'Payment terms',
            value:
              a.terms.paymentTermsDays === null ? '—' : `${a.terms.paymentTermsDays} days`,
            note: a.terms.paymentTermsDays === null ? 'Not agreed' : 'From invoice issue',
          },
          {
            label: 'Purchase order',
            value: a.terms.purchaseOrderReference ?? '—',
            note: a.terms.purchaseOrderReference ? 'Reference' : 'Not set',
          },
          {
            label: 'PO ceiling',
            value:
              a.terms.purchaseOrderCeilingCents === null
                ? '—'
                : formatCents(a.terms.purchaseOrderCeilingCents, a.currency),
            note:
              a.terms.purchaseOrderCeilingCents === null
                ? 'No cap'
                : `${formatCents(a.terms.committedCents, a.currency)} committed`,
          },
          {
            label: 'Rates in force',
            value: a.liveRates.length,
            note: `${a.currency} · ${a.acceptance.status.toLowerCase()}`,
          },
        ]}
      />

      <ErrorText>{error}</ErrorText>
      {notice ? <Notice>{notice}</Notice> : null}

      {a.terms.purchaseOrderCeilingCents !== null &&
      a.terms.committedCents > a.terms.purchaseOrderCeilingCents * 0.9 ? (
        <Notice>
          {formatCents(a.terms.committedCents, a.currency)} of{' '}
          {formatCents(a.terms.purchaseOrderCeilingCents, a.currency)} is already invoiced
          against this purchase order. Issuing past the ceiling is refused, so the PO needs
          varying before the next invoice.
        </Notice>
      ) : null}

      <Section
        title="Rates in force"
        description="The approved PAY schedule this engagement resolves against. A rate marked Default is the hiring company’s standard rate for that role, inherited by every engagement that has no rate of its own."
        className="cq-section--table"
      >
        {a.liveRates.length === 0 ? (
          <EmptyState title="No agreed rates yet">
            {isProviding
              ? 'Propose a schedule and the hiring company can approve it. Until a rate is agreed, work on this engagement cannot be priced.'
              : 'Nothing is agreed on this engagement yet. Your subcontractor can propose a schedule, or you can record one you agreed elsewhere.'}
          </EmptyState>
        ) : (
          <Table label="Approved PAY rates" compact>
            <thead>
              <tr>
                <th scope="col">Role</th>
                <th scope="col">Label</th>
                <th scope="col">Mode</th>
                <th scope="col" className="cq-numeric">
                  Rate
                </th>
                <th scope="col" className="cq-numeric">
                  Overtime
                </th>
                <th scope="col">From</th>
                <th scope="col" className="cq-numeric">
                  Version
                </th>
              </tr>
            </thead>
            <tbody>
              {a.liveRates.map((r: AgreementRate) => (
                <tr key={r.rateCardId}>
                  <td className="cq-table__primary">{r.roleName}</td>
                  <td>{titleCase(r.rateLabel)}</td>
                  <td>{titleCase(r.rateMode)}</td>
                  <td className="cq-numeric">{formatCents(r.amountCents, r.currency)}</td>
                  <td className="cq-numeric">
                    {formatCents(r.otHourlyRateCents, r.currency)}
                  </td>
                  <td>{formatDate(r.effectiveFrom)}</td>
                  <td className="cq-numeric">
                    v{r.version}
                    {/* A locked version is an approved commercial fact; the rate-cards
                        screen will refuse to edit it, so say so where it is shown. */}
                    {r.locked ? (
                      <>
                        {' '}
                        <Badge tone="success">Agreed</Badge>
                      </>
                    ) : null}
                    {r.scope === 'COMPANY_DEFAULT' ? (
                      <>
                        {' '}
                        <Badge tone="neutral">Default</Badge>
                      </>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Section>

      <Section
        title="Schedules"
        description="Every revision of this agreement, including the ones that were returned."
        className="cq-section--table"
      >
        {a.proposals.length === 0 ? (
          <EmptyState title="No schedules yet">
            A schedule is one atomic revision of the rates on this engagement — a raise, a
            new shift type, or a rate being retired. Submitting it freezes the numbers so the
            decision is made on exactly what was sent.
          </EmptyState>
        ) : (
          <Stack>
            {a.proposals.map((p) => (
              <ProposalCard
                key={p.id}
                proposal={p}
                currency={a.currency}
                isManager={isManager}
                isOwner={isOwner}
                busy={busy}
                onAct={act}
              />
            ))}
          </Stack>
        )}
      </Section>

      {isHiring && isManager ? (
        <TermsDrawer
          open={termsOpen}
          agreement={a}
          onClose={() => setTermsOpen(false)}
          onSaved={(message) => {
            setTermsOpen(false);
            setNotice(message);
            agreement.reload();
          }}
        />
      ) : null}

      {isManager ? (
        <ScheduleDrawer
          open={proposeOpen}
          agreement={a}
          mode={isProviding ? 'propose' : 'direct'}
          isOwner={isOwner}
          onClose={() => setProposeOpen(false)}
          onSaved={(message) => {
            setProposeOpen(false);
            setNotice(message);
            agreement.reload();
            onChanged();
          }}
        />
      ) : null}
    </Stack>
  );
}

function ProposalCard({
  proposal,
  currency,
  isManager,
  isOwner,
  busy,
  onAct,
}: {
  proposal: RateProposalView;
  currency: string;
  isManager: boolean;
  isOwner: boolean;
  busy: boolean;
  onAct: (run: () => Promise<void>, success: string) => Promise<void>;
}) {
  const ctx = useSessionCtx();
  const isHiring = proposal.side === 'client';
  const isProviding = proposal.side === 'provider';
  const retro = isRetroactive(proposal.effectiveFrom, todayIso());

  if (!ctx) return null;
  const t = ctx.accessToken;
  const c = ctx.companyId;

  return (
    <div className="cq-fieldset">
      <Row between>
        <div>
          <Row>
            <ProposalStatusBadge status={proposal.status} />
            <strong>Effective {formatDate(proposal.effectiveFrom)}</strong>
            {retro && proposal.status !== 'APPROVED' ? (
              <Badge tone="warning">Back-dated</Badge>
            ) : null}
            {proposal.predecessorProposalId ? (
              <Badge tone="neutral">Replaces a returned schedule</Badge>
            ) : null}
          </Row>
          <p className="cq-muted">
            {proposal.lines.length} line{proposal.lines.length === 1 ? '' : 's'} ·{' '}
            {proposal.currency}
            {proposal.submittedAt
              ? ` · sent ${formatDateTime(proposal.submittedAt)}${proposal.submittedByName ? ` by ${proposal.submittedByName}` : ''}`
              : ' · not sent yet'}
            {proposal.reviewedAt
              ? ` · decided ${formatDateTime(proposal.reviewedAt)}${proposal.reviewedByName ? ` by ${proposal.reviewedByName}` : ''}`
              : ''}
          </p>
        </div>
        <Row>
          {isProviding && isManager && proposal.status === 'DRAFT' ? (
            <>
              <Button
                size="sm"
                disabled={busy}
                onClick={() =>
                  void onAct(
                    async () => {
                      await api.submitRateProposal(t, c, proposal.id);
                    },
                    'Schedule sent for approval. The numbers are now frozen.'
                  )
                }
              >
                Send for approval
              </Button>
              <Button
                size="sm"
                variant="danger"
                disabled={busy}
                onClick={() =>
                  void onAct(async () => {
                    await api.deleteRateProposal(t, c, proposal.id);
                  }, 'Draft schedule deleted.')
                }
              >
                Delete
              </Button>
            </>
          ) : null}
          {isProviding && isManager && proposal.status === 'SUBMITTED' ? (
            <Button
              size="sm"
              variant="secondary"
              disabled={busy}
              onClick={() =>
                void onAct(async () => {
                  await api.withdrawRateProposal(t, c, proposal.id);
                }, 'Schedule withdrawn.')
              }
            >
              Withdraw
            </Button>
          ) : null}
          {isHiring && isManager && proposal.status === 'SUBMITTED' ? (
            <ReviewActions
              proposal={proposal}
              isOwner={isOwner}
              retro={retro}
              busy={busy}
              onAct={onAct}
            />
          ) : null}
        </Row>
      </Row>

      {proposal.note ? <p className="cq-muted">“{proposal.note}”</p> : null}
      {proposal.decisionReason ? (
        <Notice>
          Returned: {proposal.decisionReason}
          {isProviding
            ? ' — a returned schedule cannot be edited. Send a new one that corrects it.'
            : ''}
        </Notice>
      ) : null}
      {proposal.retroactiveReason ? (
        <Notice>
          Approved with a back-dated effective date. Reason on the record:{' '}
          {proposal.retroactiveReason}
        </Notice>
      ) : null}

      <Table label={`Schedule effective ${proposal.effectiveFrom}`} compact>
        <thead>
          <tr>
            <th scope="col">Change</th>
            <th scope="col">Role</th>
            <th scope="col">Label</th>
            <th scope="col">Mode</th>
            <th scope="col" className="cq-numeric">
              Now
            </th>
            <th scope="col" className="cq-numeric">
              Proposed
            </th>
            <th scope="col" className="cq-numeric">
              Change
            </th>
          </tr>
        </thead>
        <tbody>
          {proposal.lines.map((line) => {
            const proposed = lineAmount(line);
            const now = line.currentAmountCents;
            // Only a like-for-like pair can be differenced. A new rate has nothing
            // to compare against, and an END has nothing to compare to.
            const delta = proposed !== null && now !== null ? proposed - now : null;
            return (
              <tr key={line.id}>
                <td>
                  {line.operation === 'CREATE' ? (
                    <Badge tone="neutral">New rate</Badge>
                  ) : line.operation === 'REPLACE' ? (
                    <Badge tone="accent">Replaces</Badge>
                  ) : (
                    <Badge tone="warning">Ends</Badge>
                  )}
                </td>
                <td className="cq-table__primary">{line.roleName}</td>
                <td>{titleCase(line.rateLabel)}</td>
                <td>{titleCase(line.rateMode)}</td>
                <td className="cq-numeric">{formatCents(now, currency)}</td>
                <td className="cq-numeric">{formatCents(proposed, currency)}</td>
                <td className="cq-numeric">
                  {delta === null ? (
                    '—'
                  ) : (
                    <>
                      {delta > 0 ? '+' : ''}
                      {formatCents(delta, currency)}
                      {/* A percentage needs a non-zero base. `delta` being non-null
                          already implies `now` is too, but say it so the reader of
                          this line does not have to re-derive that. */}
                      {now !== null && now > 0
                        ? ` (${((delta / now) * 100).toFixed(1)}%)`
                        : ''}
                    </>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </Table>
      {proposal.status === 'SUBMITTED' ? (
        <p className="cq-muted">
          Approving opens these rates on {formatDate(proposal.effectiveFrom)} and closes
          whatever they replace on {formatDate(supersededEffectiveTo(proposal.effectiveFrom))}.
          Time already approved keeps the rate it was approved at.
        </p>
      ) : null}
    </div>
  );
}

function ReviewActions({
  proposal,
  isOwner,
  retro,
  busy,
  onAct,
}: {
  proposal: RateProposalView;
  isOwner: boolean;
  retro: boolean;
  busy: boolean;
  onAct: (run: () => Promise<void>, success: string) => Promise<void>;
}) {
  const ctx = useSessionCtx();
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const [retroReason, setRetroReason] = useState('');
  if (!ctx) return null;
  const t = ctx.accessToken;
  const c = ctx.companyId;

  if (rejecting) {
    return (
      <Stack>
        <Field
          label="Why are you returning this?"
          hint="Required. It is the only thing the provider has to work from."
        >
          <Input value={reason} onChange={(e) => setReason(e.target.value)} autoFocus />
        </Field>
        <Row>
          <Button
            size="sm"
            variant="danger"
            disabled={busy || reason.trim().length === 0}
            onClick={() =>
              void onAct(async () => {
                await api.rejectRateProposal(t, c, proposal.id, reason.trim());
              }, 'Schedule returned to the provider with your reason.')
            }
          >
            Return it
          </Button>
          <Button size="sm" variant="secondary" onClick={() => setRejecting(false)}>
            Cancel
          </Button>
        </Row>
      </Stack>
    );
  }

  // Back-dating is an owner decision with a reason on the record, because approved
  // time keeps its frozen rate and the two then disagree about money already owed.
  if (retro) {
    if (!isOwner) {
      return (
        <Row>
          <span className="cq-muted">
            Back-dated — an owner must approve this
          </span>
          <Button size="sm" variant="secondary" onClick={() => setRejecting(true)}>
            Return
          </Button>
        </Row>
      );
    }
    return (
      <Stack>
        <Field
          label="This schedule starts in the past — why?"
          hint="Required, and kept on the record. Time already approved keeps its own rate."
        >
          <Input value={retroReason} onChange={(e) => setRetroReason(e.target.value)} />
        </Field>
        <Row>
          <Button
            size="sm"
            disabled={busy || retroReason.trim().length === 0}
            onClick={() =>
              void onAct(async () => {
                await api.approveRateProposal(t, c, proposal.id, retroReason.trim());
              }, 'Schedule approved. The new rates are in force.')
            }
          >
            Approve as back-dated
          </Button>
          <Button size="sm" variant="secondary" onClick={() => setRejecting(true)}>
            Return
          </Button>
        </Row>
      </Stack>
    );
  }

  return (
    <>
      <Button
        size="sm"
        disabled={busy}
        onClick={() =>
          void onAct(async () => {
            await api.approveRateProposal(t, c, proposal.id);
          }, 'Schedule approved. The new rates are in force from its effective date.')
        }
      >
        Approve
      </Button>
      <Button size="sm" variant="secondary" onClick={() => setRejecting(true)}>
        Return
      </Button>
    </>
  );
}

function TermsDrawer({
  open,
  agreement,
  onClose,
  onSaved,
}: {
  open: boolean;
  agreement: CommercialAgreement;
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const ctx = useSessionCtx();
  const [days, setDays] = useState('');
  const [reference, setReference] = useState('');
  const [ceiling, setCeiling] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Re-seed from the record only when the drawer opens, never on every render:
  // keying the effect on the fields the form edits is what wiped a confirmation
  // in Phase 5.5's companies console.
  useEffect(() => {
    if (!open) return;
    setDays(
      agreement.terms.paymentTermsDays === null ? '' : String(agreement.terms.paymentTermsDays)
    );
    setReference(agreement.terms.purchaseOrderReference ?? '');
    setCeiling(centsToInput(agreement.terms.purchaseOrderCeilingCents));
    setReason('');
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, agreement.engagementId]);

  async function save() {
    if (!ctx) return;
    setBusy(true);
    setError(null);
    try {
      await api.updateEngagementTerms(ctx.accessToken, ctx.companyId, agreement.engagementId, {
        paymentTermsDays: days.trim() === '' ? null : Number(days),
        purchaseOrderReference: reference.trim() === '' ? null : reference.trim(),
        purchaseOrderCeilingCents: inputToCents(ceiling),
        ...(reason.trim() ? { reason: reason.trim() } : {}),
      });
      onSaved('Commercial terms updated.');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save the terms');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Drawer
      open={open}
      title="Commercial terms"
      description="What you agreed with this company. Every project on this engagement inherits it."
      onClose={onClose}
      footer={
        <Row>
          <Button disabled={busy} onClick={() => void save()}>
            Save terms
          </Button>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
        </Row>
      }
    >
      <Stack>
        <ErrorText>{error}</ErrorText>
        <Field
          label="Payment terms (days)"
          hint="New invoices on this engagement default to this many days from issue. Blank means no agreed terms."
        >
          <Input
            type="number"
            min={0}
            max={365}
            value={days}
            onChange={(e) => setDays(e.target.value)}
          />
        </Field>
        <Field label="Purchase order reference" hint="Printed on invoices. Blank if there is none.">
          <Input value={reference} onChange={(e) => setReference(e.target.value)} />
        </Field>
        <Field
          label={`Purchase order ceiling (${agreement.currency})`}
          hint={`Issuing an invoice past this is refused. ${formatCents(agreement.terms.committedCents, agreement.currency)} is already issued against this engagement. Blank means no cap.`}
        >
          <Input value={ceiling} onChange={(e) => setCeiling(e.target.value)} />
        </Field>
        <Field
          label="Reason for the change"
          hint="Optional, kept in the record history beside the before and after values."
        >
          <Input value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
      </Stack>
    </Drawer>
  );
}

function ScheduleDrawer({
  open,
  agreement,
  mode,
  isOwner,
  onClose,
  onSaved,
}: {
  open: boolean;
  agreement: CommercialAgreement;
  /** `propose` = provider asking; `direct` = hiring company recording what was agreed. */
  mode: 'propose' | 'direct';
  isOwner: boolean;
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const ctx = useSessionCtx();
  const [effectiveFrom, setEffectiveFrom] = useState('');
  const [note, setNote] = useState('');
  const [retroReason, setRetroReason] = useState('');
  const [lines, setLines] = useState<DraftLine[]>([BLANK_LINE]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /**
   * The roles a line may name are the **hiring** company's, because a PAY card
   * belongs to the hiring company (`rate_cards.company_id`). A provider therefore
   * cannot read them from its own catalog; it picks from the rates already in force
   * on this edge, plus whatever the hiring company has published there.
   */
  const roles = useAsyncList<RoleCatalogView>(
    ctx && open && mode === 'direct'
      ? () => api.listRoles(ctx.accessToken, ctx.companyId).then((r) => r.data)
      : null,
    [ctx?.companyId, open, mode]
  );

  const roleOptions = useMemo(() => {
    if (mode === 'direct') {
      return roles.items.map((r) => ({ id: r.id, name: r.name }));
    }
    // Provider side: the only roles it can see are the ones already priced on this
    // edge. A genuinely new role has to come from the hiring company first — which
    // is honest, because the role is theirs to define.
    const seen = new Map<string, string>();
    for (const rate of agreement.liveRates) seen.set(rate.roleId, rate.roleName);
    for (const p of agreement.proposals) {
      for (const l of p.lines) seen.set(l.roleId, l.roleName);
    }
    return [...seen].map(([id, name]) => ({ id, name }));
  }, [mode, roles.items, agreement.liveRates, agreement.proposals]);

  useEffect(() => {
    if (!open) return;
    setEffectiveFrom(todayIso());
    setNote('');
    setRetroReason('');
    setLines([BLANK_LINE]);
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, agreement.engagementId]);

  const retro = effectiveFrom !== '' && isRetroactive(effectiveFrom, todayIso());

  function updateLine(index: number, patch: Partial<DraftLine>) {
    setLines((current) =>
      current.map((line, i) => (i === index ? { ...line, ...patch } : line))
    );
  }

  async function save() {
    if (!ctx) return;
    setBusy(true);
    setError(null);
    try {
      const payload = lines.map(toLineInput);
      if (mode === 'propose') {
        await api.createRateProposal(ctx.accessToken, ctx.companyId, {
          engagementId: agreement.engagementId,
          effectiveFrom,
          currency: agreement.currency,
          note: note.trim() === '' ? null : note.trim(),
          predecessorProposalId: null,
          lines: payload,
        });
        onSaved('Draft schedule created. Send it for approval when it is right.');
      } else {
        await api.recordRateSchedule(ctx.accessToken, ctx.companyId, agreement.engagementId, {
          effectiveFrom,
          currency: agreement.currency,
          note: note.trim() === '' ? null : note.trim(),
          retroactiveReason: retroReason.trim() === '' ? null : retroReason.trim(),
          lines: payload,
        });
        onSaved('Agreed schedule recorded as an approved version.');
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save the schedule');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Drawer
      open={open}
      title={mode === 'propose' ? 'Propose new rates' : 'Record agreed rates'}
      description={
        mode === 'propose'
          ? 'One schedule is one atomic change to this agreement. Sending it freezes the numbers, so the decision is made on exactly what you sent.'
          : 'For a schedule agreed outside CrewQuo. It creates the same immutable approved versions an approval does — not an editable shortcut.'
      }
      onClose={onClose}
      footer={
        <Row>
          <Button disabled={busy} onClick={() => void save()}>
            {mode === 'propose' ? 'Save draft' : 'Record schedule'}
          </Button>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
        </Row>
      }
    >
      <Stack>
        <ErrorText>{error}</ErrorText>
        <Field
          label="Effective from"
          hint={`New rates open on this date; whatever they replace closes the day before${effectiveFrom ? ` (${formatDate(supersededEffectiveTo(effectiveFrom))})` : ''}.`}
        >
          <Input
            type="date"
            value={effectiveFrom}
            onChange={(e) => setEffectiveFrom(e.target.value)}
          />
        </Field>
        {retro ? (
          <Notice>
            This date has already passed. Time already approved keeps the rate it was approved
            at, so back-dating needs an owner{mode === 'direct' ? ' and a reason' : ''} — the
            {mode === 'propose' ? ' hiring company will be asked for one.' : ' reason is kept on the record.'}
          </Notice>
        ) : null}
        {retro && mode === 'direct' ? (
          <Field label="Reason for back-dating" hint="Required, and kept on the record.">
            <Input
              value={retroReason}
              onChange={(e) => setRetroReason(e.target.value)}
              disabled={!isOwner}
            />
          </Field>
        ) : null}
        <Field label="Note" hint="Optional context for whoever reads this schedule.">
          <Input value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>

        <div className="cq-fieldset">
          <p className="cq-overline">Lines</p>
          {roleOptions.length === 0 ? (
            <p className="cq-muted">
              {mode === 'propose'
                ? 'No roles are priced on this engagement yet, so there is nothing to name. The hiring company adds the first rate — ask them to record one, then you can propose changes to it.'
                : 'This company has no roles in its catalog yet. Add one on the Roles screen first.'}
            </p>
          ) : (
            <Stack>
              {lines.map((line, index) => (
                <div key={index} className="cq-fieldset">
                  <Row>
                    <Field label="Change">
                      <Select
                        value={line.operation}
                        onChange={(e) =>
                          updateLine(index, {
                            operation: e.target.value as DraftLine['operation'],
                          })
                        }
                      >
                        <option value="CREATE">New rate</option>
                        <option value="REPLACE">Replace a rate</option>
                        <option value="END">End a rate</option>
                      </Select>
                    </Field>
                    <Field label="Role">
                      <Select
                        value={line.roleId}
                        onChange={(e) => updateLine(index, { roleId: e.target.value })}
                      >
                        <option value="">Choose a role…</option>
                        {roleOptions.map((r) => (
                          <option key={r.id} value={r.id}>
                            {r.name}
                          </option>
                        ))}
                      </Select>
                    </Field>
                    <Field label="Label">
                      <Select
                        value={line.rateLabel}
                        onChange={(e) =>
                          updateLine(index, { rateLabel: e.target.value as RateLabel })
                        }
                      >
                        {RATE_LABELS.map((l) => (
                          <option key={l} value={l}>
                            {titleCase(l)}
                          </option>
                        ))}
                      </Select>
                    </Field>
                  </Row>
                  {line.operation !== 'CREATE' ? (
                    <Field
                      label="Rate it supersedes"
                      hint="Its window closes the day before this schedule opens."
                    >
                      <Select
                        value={line.replacesRateCardId}
                        onChange={(e) =>
                          updateLine(index, { replacesRateCardId: e.target.value })
                        }
                      >
                        <option value="">Choose the rate in force…</option>
                        {agreement.liveRates
                          .filter(
                            (r) =>
                              // A company-default rate is not this engagement's to
                              // supersede: closing its window would reprice every
                              // other provider on the same role. Overriding it is a
                              // CREATE line, which wins on precedence instead.
                              r.scope === 'ENGAGEMENT' &&
                              (!line.roleId || r.roleId === line.roleId) &&
                              r.rateLabel === line.rateLabel
                          )
                          .map((r) => (
                            <option key={r.rateCardId} value={r.rateCardId}>
                              {r.roleName} · {titleCase(r.rateLabel)} ·{' '}
                              {formatCents(r.amountCents, r.currency)} (v{r.version})
                            </option>
                          ))}
                      </Select>
                    </Field>
                  ) : null}
                  {line.operation !== 'END' ? (
                    <Row>
                      <Field label="Mode">
                        <Select
                          value={line.rateMode}
                          onChange={(e) =>
                            updateLine(index, { rateMode: e.target.value as RateMode })
                          }
                        >
                          {RATE_MODES.map((m) => (
                            <option key={m} value={m}>
                              {titleCase(m)}
                            </option>
                          ))}
                        </Select>
                      </Field>
                      <Field label={`Rate (${agreement.currency})`}>
                        <Input
                          value={line.amount}
                          onChange={(e) => updateLine(index, { amount: e.target.value })}
                        />
                      </Field>
                      {line.rateMode === 'HOURLY' ? (
                        <Field label="Overtime" hint="Blank defaults to 1.5× the base rate.">
                          <Input
                            value={line.otAmount}
                            onChange={(e) => updateLine(index, { otAmount: e.target.value })}
                          />
                        </Field>
                      ) : null}
                      <Field label="Minimum hours" hint="Optional.">
                        <Input
                          value={line.minHours}
                          onChange={(e) => updateLine(index, { minHours: e.target.value })}
                        />
                      </Field>
                    </Row>
                  ) : (
                    <p className="cq-muted">
                      An ending line closes a rate without opening one, so it carries no
                      amount.
                    </p>
                  )}
                  {lines.length > 1 ? (
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => setLines((c) => c.filter((_, i) => i !== index))}
                    >
                      Remove this line
                    </Button>
                  ) : null}
                </div>
              ))}
              <Button
                size="sm"
                variant="secondary"
                onClick={() => setLines((c) => [...c, BLANK_LINE])}
              >
                Add a line
              </Button>
            </Stack>
          )}
        </div>
      </Stack>
    </Drawer>
  );
}
