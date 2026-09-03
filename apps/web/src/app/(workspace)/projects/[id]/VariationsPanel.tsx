'use client';

import { useState } from 'react';
import {
  SHIFT_TYPES,
  VARIATION_LINE_KINDS,
  computeVariationTotals,
  findVariationTransition,
  variationEditRefusal,
  variationIsEditable,
  variationMarginPct,
  type ShiftType,
  type VariationLineInput,
  type VariationLineKind,
  type VariationStatus,
  type VariationView,
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
  Row,
  Section,
  Select,
  Stack,
  Table,
  Textarea,
} from '@crewquo/ui';
import { api, ApiError } from '@/api/client';
import { useSessionCtx } from '@/auth/AuthProvider';
import { useAsyncList } from '@/lib/useAsyncList';
import { centsToInput, formatCents, formatDate, inputToCents, titleCase } from '@/lib/format';

/**
 * The project Variations section (§30.1) — step 11.9 of the Phase 11 build order.
 *
 * Four things the API refuses to do, that this screen has to refuse to *render*:
 *
 *  - **An approved variation has no edit affordance at all.** Not a disabled
 *    button: `variationIsEditable` decides whether the form exists, because
 *    `client_approved_by` records that a named person outside the tenancy agreed a
 *    figure and a form that looks editable teaches somebody to try (finding 4).
 *  - **A `PARTIAL` line shows its notice, never its zero as a price.** The API
 *    stores an unresolved side as 0 with `pricedFrom: 'PARTIAL'`, and rendering
 *    that as "$0.00" would present a price nobody quoted. §41.1 on a screen.
 *  - **`clientApprovalRecorded: false` is a visible badge.** Approving without the
 *    client's own agreement is permitted — the crew works on Wednesday and the
 *    paperwork arrives on Friday — and the whole reason it is permitted is that it
 *    is never silent.
 *  - **The transitions offered come from the shared table**, not from a list of
 *    buttons somebody kept in step by hand. `findVariationTransition` is what
 *    decides whether Approve exists on this row.
 *
 * The totals preview uses `computeVariationTotals` — the same function the server
 * writes with — so the figure somebody sees before saving is the figure that gets
 * stored, down to the half-cent rounding.
 */

const KIND_LABELS: Readonly<Record<VariationLineKind, string>> = {
  LABOUR: 'Labour',
  VEHICLE: 'Vehicle',
  MATERIAL: 'Material',
  WASTE: 'Waste',
  SUBCONTRACTOR: 'Subcontractor',
  OTHER: 'Other',
};

const STATUS_TONE: Readonly<
  Record<VariationStatus, 'neutral' | 'accent' | 'success' | 'warning' | 'danger'>
> = {
  DRAFT: 'neutral',
  SUBMITTED: 'warning',
  APPROVED: 'success',
  REJECTED: 'danger',
  COMPLETED: 'success',
  INVOICED: 'accent',
};

interface LineDraft {
  kind: VariationLineKind;
  description: string;
  quantity: string;
  unitCost: string;
  unitSell: string;
  roleId: string;
  shiftType: string;
}

const emptyLine = (): LineDraft => ({
  kind: 'LABOUR',
  description: '',
  quantity: '1',
  unitCost: '',
  unitSell: '',
  roleId: '',
  shiftType: '',
});

export function VariationsPanel({
  projectId,
  currency,
  roles,
  canCreate,
  canApprove,
  canReadCommercial,
  onCountChanged,
}: {
  projectId: string;
  currency: string;
  roles: { id: string; name: string }[];
  canCreate: boolean;
  canApprove: boolean;
  /**
   * Whether the reader may see money at all. A supervisor holds `variation.create`
   * and not `commercial.read`, which is the split §37 exists for — they capture the
   * price the client asked for and do not read the margin on it.
   */
  canReadCommercial: boolean;
  onCountChanged?: () => void;
}) {
  const ctx = useSessionCtx();
  const variations = useAsyncList<VariationView>(
    ctx
      ? () => api.listVariations(ctx.accessToken, ctx.companyId, projectId).then((r) => r.variations)
      : null,
    [ctx?.companyId, projectId]
  );

  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<VariationView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notices, setNotices] = useState<string[]>([]);

  const [reference, setReference] = useState('');
  const [description, setDescription] = useState('');
  const [reason, setReason] = useState('');
  const [requestedBy, setRequestedBy] = useState('');
  const [requestedOn, setRequestedOn] = useState(new Date().toISOString().slice(0, 10));
  const [lines, setLines] = useState<LineDraft[]>([emptyLine()]);

  const reset = () => {
    setEditing(null);
    setReference('');
    setDescription('');
    setReason('');
    setRequestedBy('');
    setRequestedOn(new Date().toISOString().slice(0, 10));
    setLines([emptyLine()]);
    setError(null);
  };

  const openEdit = (variation: VariationView) => {
    setEditing(variation);
    setReference(variation.reference ?? '');
    setDescription(variation.description);
    setReason(variation.reason ?? '');
    setRequestedBy(variation.requestedBy ?? '');
    setRequestedOn(variation.requestedOn);
    setLines(
      variation.lines.length === 0
        ? [emptyLine()]
        : variation.lines.map((l) => ({
            kind: l.kind,
            description: l.description,
            quantity: String(l.quantity),
            unitCost: centsToInput(l.unitCostCents),
            unitSell: centsToInput(l.unitSellCents),
            roleId: l.roleId ?? '',
            shiftType: '',
          }))
    );
    setError(null);
    setOpen(true);
  };

  /**
   * A line the caller sends. Prices are omitted when both boxes are empty **and**
   * the line is LABOUR with a role — that is the one shape the rate engine can
   * price, and omitting them is how a caller asks it to.
   */
  const toInput = (line: LineDraft): VariationLineInput => {
    const cost = inputToCents(line.unitCost);
    const sell = inputToCents(line.unitSell);
    const resolvable = line.kind === 'LABOUR' && line.roleId !== '';
    return {
      kind: line.kind,
      description: line.description.trim(),
      quantity: Number(line.quantity) || 0,
      ...(resolvable && cost === null && sell === null
        ? {}
        : { unitCostCents: cost ?? 0, unitSellCents: sell ?? 0 }),
      roleId: line.roleId === '' ? null : line.roleId,
      assetId: null,
      shiftType: line.shiftType === '' ? null : (line.shiftType as ShiftType),
    };
  };

  /*
   * The preview, from the same function the server writes with — so the figure
   * somebody reads before saving is the figure that gets stored. A second
   * implementation here would disagree at exactly the rounding boundary the check
   * constraint refuses.
   */
  const preview = computeVariationTotals(
    lines.map((l) => ({
      quantity: Number(l.quantity) || 0,
      unitCostCents: inputToCents(l.unitCost) ?? 0,
      unitSellCents: inputToCents(l.unitSell) ?? 0,
    }))
  );

  const save = async () => {
    if (!ctx) return;
    setBusy(true);
    setError(null);
    try {
      const payload = {
        reference: reference.trim() === '' ? null : reference.trim(),
        description: description.trim(),
        reason: reason.trim() === '' ? null : reason.trim(),
        requestedBy: requestedBy.trim() === '' ? null : requestedBy.trim(),
        requestedOn,
        lines: lines.filter((l) => l.description.trim() !== '').map(toInput),
      };
      const result = editing
        ? await api.updateVariation(ctx.accessToken, ctx.companyId, editing.id, payload)
        : await api.createVariation(ctx.accessToken, ctx.companyId, projectId, payload);
      setNotices(result.notices);
      setOpen(false);
      reset();
      variations.reload();
      onCountChanged?.();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save that variation');
    } finally {
      setBusy(false);
    }
  };

  const act = async (
    variation: VariationView,
    action: 'submit' | 'withdraw' | 'approve' | 'reject' | 'complete',
    body?: { reason: string }
  ) => {
    if (!ctx) return;
    setBusy(true);
    setError(null);
    try {
      await api.variationAction(ctx.accessToken, ctx.companyId, variation.id, action, body);
      variations.reload();
      onCountChanged?.();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'That could not be done');
    } finally {
      setBusy(false);
    }
  };

  const reject = async (variation: VariationView) => {
    // A rejection with no reason is refused by the API, so it is refused here too —
    // the person who has to re-price is on a different site and "no" costs them a
    // phone call they should not need.
    const entered = window.prompt('Why is this being rejected?');
    if (entered === null || entered.trim().length < 3) return;
    await act(variation, 'reject', { reason: entered.trim() });
  };

  /** Which actions this row offers, from the shared transition table. */
  const actionsFor = (variation: VariationView) => {
    const can = (to: VariationStatus, held: boolean): boolean => {
      const transition = findVariationTransition(variation.status, to);
      return transition !== null && transition.actor !== 'SYSTEM' && held;
    };
    return {
      submit: can('SUBMITTED', canCreate),
      withdraw: can('DRAFT', canCreate),
      approve: can('APPROVED', canApprove),
      reject: can('REJECTED', canApprove),
      complete: can('COMPLETED', canApprove),
    };
  };

  const totalApproved = variations.items
    .filter((v) => ['APPROVED', 'COMPLETED', 'INVOICED'].includes(v.status))
    .reduce((sum, v) => sum + v.sellTotalCents, 0);

  return (
    <Stack>
      <Section
        title="Variations & extra works"
        description="Extra scope the client asked for, priced off your rate cards. Approved variations feed project revenue and the invoice."
        actions={
          canCreate ? (
            <Button
              onClick={() => {
                reset();
                setOpen(true);
              }}
            >
              Raise a variation
            </Button>
          ) : null
        }
      >
        <ErrorText>{error ?? variations.error}</ErrorText>

        {notices.length > 0 ? (
          <Notice live>
            <strong>Saved, with something to look at:</strong>
            <ul className="cq-list">
              {notices.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          </Notice>
        ) : null}

        {variations.loading ? (
          <p className="cq-muted">Loading variations…</p>
        ) : variations.items.length === 0 ? (
          <EmptyState title="No variations yet">
            When a client asks for something outside the original scope, raise it here
            while you are still on site — the price is easiest to agree on the day.
          </EmptyState>
        ) : (
          <>
            {canReadCommercial ? (
              <Notice>
                {formatCents(totalApproved, currency)} of approved extra works on this project.
              </Notice>
            ) : null}
            <Table label="Variations">
              <thead>
                <tr>
                  <th scope="col">Reference</th>
                  <th scope="col">Description</th>
                  <th scope="col">Requested</th>
                  <th scope="col">Status</th>
                  {canReadCommercial ? (
                    <>
                      <th scope="col" className="cq-num">
                        To client
                      </th>
                      <th scope="col" className="cq-num">
                        Margin
                      </th>
                    </>
                  ) : null}
                  <th scope="col">Actions</th>
                </tr>
              </thead>
              <tbody>
                {variations.items.map((variation) => {
                  const actions = actionsFor(variation);
                  const refusal = variationEditRefusal(variation.status);
                  return (
                    <tr key={variation.id}>
                      <td>{variation.reference ?? '—'}</td>
                      <td>
                        {variation.description}
                        {variation.rejectReason ? (
                          <div className="cq-muted">Rejected: {variation.rejectReason}</div>
                        ) : null}
                        {variation.lines.some((l) => l.pricedFrom === 'PARTIAL') ? (
                          /*
                           * The `PARTIAL` badge, and it is the whole of §41.1 on this
                           * screen: the API stored an unresolved side as 0, and a
                           * reader must not be shown that 0 as a price somebody
                           * quoted.
                           */
                          <div>
                            <Badge tone="warning">Some lines are not priced yet</Badge>
                          </div>
                        ) : null}
                      </td>
                      <td>
                        {formatDate(variation.requestedOn)}
                        {variation.requestedBy ? (
                          <div className="cq-muted">by {variation.requestedBy}</div>
                        ) : null}
                      </td>
                      <td>
                        <Row>
                          <Badge tone={STATUS_TONE[variation.status]}>
                            {titleCase(variation.status)}
                          </Badge>
                          {/*
                            * Packet §3's warning, visible. Approval without the
                            * client's own agreement is permitted, and the only
                            * reason it is permitted is that it is never silent.
                            */}
                          {['APPROVED', 'COMPLETED', 'INVOICED'].includes(variation.status) &&
                          !variation.clientApprovalRecorded ? (
                            <Badge tone="warning">Client agreement not on file</Badge>
                          ) : null}
                        </Row>
                        {variation.invoiceNumber ? (
                          <div className="cq-muted">Invoice {variation.invoiceNumber}</div>
                        ) : null}
                      </td>
                      {canReadCommercial ? (
                        <>
                          <td className="cq-num">
                            {formatCents(variation.sellTotalCents, currency)}
                          </td>
                          <td className="cq-num">
                            {/*
                              * Null, not "0%", when nothing was sold — see
                              * `variationMarginPct`. A variation quoted at nothing
                              * has no margin percentage, and printing 0% says "we
                              * made nothing" where the truth is that there is
                              * nothing to divide by.
                              */}
                            {variation.marginPct === null
                              ? '—'
                              : `${variation.marginPct.toFixed(1)}%`}
                          </td>
                        </>
                      ) : null}
                      <td>
                        <Row>
                          {/*
                            * No edit affordance at all past APPROVED — not a
                            * disabled button. A form that looks editable teaches
                            * somebody to try, and the refusal is the sentence
                            * instead.
                            */}
                          {variationIsEditable(variation.status) && canCreate ? (
                            <Button size="sm" variant="secondary" onClick={() => openEdit(variation)}>
                              Edit
                            </Button>
                          ) : refusal !== null && canCreate ? (
                            <span className="cq-muted">{refusal}</span>
                          ) : null}
                          {actions.submit ? (
                            <Button size="sm" disabled={busy} onClick={() => void act(variation, 'submit')}>
                              Submit
                            </Button>
                          ) : null}
                          {actions.withdraw ? (
                            <Button
                              size="sm"
                              variant="secondary"
                              disabled={busy}
                              onClick={() => void act(variation, 'withdraw')}
                            >
                              Withdraw
                            </Button>
                          ) : null}
                          {actions.approve ? (
                            <Button size="sm" disabled={busy} onClick={() => void act(variation, 'approve')}>
                              Approve
                            </Button>
                          ) : null}
                          {actions.reject ? (
                            <Button
                              size="sm"
                              variant="secondary"
                              disabled={busy}
                              onClick={() => void reject(variation)}
                            >
                              Reject
                            </Button>
                          ) : null}
                          {actions.complete ? (
                            <Button
                              size="sm"
                              variant="secondary"
                              disabled={busy}
                              onClick={() => void act(variation, 'complete')}
                            >
                              Mark complete
                            </Button>
                          ) : null}
                        </Row>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>
          </>
        )}
      </Section>

      <Drawer
        open={open}
        title={editing ? 'Edit variation' : 'Raise a variation'}
        description="A LABOUR line with a role and no prices is priced from your rate cards on the requested date."
        onClose={() => {
          setOpen(false);
          reset();
        }}
        footer={
          <Row between>
            <span className="cq-muted">
              {canReadCommercial
                ? `${formatCents(preview.sellTotalCents, currency)} to the client · ${formatCents(
                    preview.costTotalCents,
                    currency
                  )} cost${
                    variationMarginPct(preview.sellTotalCents, preview.costTotalCents) === null
                      ? ''
                      : ` · ${(variationMarginPct(
                          preview.sellTotalCents,
                          preview.costTotalCents
                        ) as number).toFixed(1)}% margin`
                  }`
                : ''}
            </span>
            <Row>
              <Button
                variant="secondary"
                onClick={() => {
                  setOpen(false);
                  reset();
                }}
              >
                Cancel
              </Button>
              <Button disabled={busy || description.trim() === ''} onClick={() => void save()}>
                {busy ? 'Saving…' : 'Save'}
              </Button>
            </Row>
          </Row>
        }
      >
        <Stack>
          <ErrorText>{error}</ErrorText>
          <Row>
            <Field label="Reference" hint="Your own numbering, e.g. VO-014">
              <Input value={reference} onChange={(e) => setReference(e.target.value)} maxLength={60} />
            </Field>
            <Field label="Requested on">
              <Input
                type="date"
                value={requestedOn}
                onChange={(e) => setRequestedOn(e.target.value)}
              />
            </Field>
          </Row>
          <Field label="Description" wide>
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              maxLength={2000}
            />
          </Field>
          <Field
            label="Who asked for it"
            hint="The person on the client side. They do not need a CrewQuo login."
          >
            <Input
              value={requestedBy}
              onChange={(e) => setRequestedBy(e.target.value)}
              maxLength={200}
            />
          </Field>
          <Field label="Why" wide hint="What changed. Useful when somebody disputes it later.">
            <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} />
          </Field>

          <Section title="Lines">
            <Stack>
              {lines.map((line, index) => (
                <Row key={index}>
                  <Field label="Kind">
                    <Select
                      value={line.kind}
                      onChange={(e) =>
                        setLines((prev) =>
                          prev.map((l, i) =>
                            i === index ? { ...l, kind: e.target.value as VariationLineKind } : l
                          )
                        )
                      }
                    >
                      {VARIATION_LINE_KINDS.map((kind) => (
                        <option key={kind} value={kind}>
                          {KIND_LABELS[kind]}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  {/*
                    * "Line description", not "Description" — the drawer already has a
                    * Description for the variation itself, and two controls in one
                    * form with the same accessible name is a real defect rather than
                    * a test inconvenience: a screen-reader user hears "Description"
                    * twice with nothing to tell them apart. Found by a Playwright
                    * strict-mode violation, which is the one tool in this repository
                    * that reads a form the way an assistive technology does.
                    */}
                  <Field label="Line description">
                    <Input
                      value={line.description}
                      onChange={(e) =>
                        setLines((prev) =>
                          prev.map((l, i) => (i === index ? { ...l, description: e.target.value } : l))
                        )
                      }
                      maxLength={300}
                    />
                  </Field>
                  <Field label="Quantity">
                    <Input
                      type="number"
                      step="0.01"
                      min="0"
                      value={line.quantity}
                      onChange={(e) =>
                        setLines((prev) =>
                          prev.map((l, i) => (i === index ? { ...l, quantity: e.target.value } : l))
                        )
                      }
                    />
                  </Field>
                  {line.kind === 'LABOUR' ? (
                    <>
                      <Field label="Role" hint="Leave the prices empty to use your rate cards">
                        <Select
                          value={line.roleId}
                          onChange={(e) =>
                            setLines((prev) =>
                              prev.map((l, i) => (i === index ? { ...l, roleId: e.target.value } : l))
                            )
                          }
                        >
                          <option value="">Not from a rate card</option>
                          {roles.map((role) => (
                            <option key={role.id} value={role.id}>
                              {role.name}
                            </option>
                          ))}
                        </Select>
                      </Field>
                      {/*
                        * Packet finding 6 on the line: there is no rate LABEL without a
                        * shift type, and deriving one from a date would be the
                        * hardcoded rule the owner had removed in 2026.
                        */}
                      <Field label="Shift" hint="Needed to resolve a rate label">
                        <Select
                          value={line.shiftType}
                          onChange={(e) =>
                            setLines((prev) =>
                              prev.map((l, i) =>
                                i === index ? { ...l, shiftType: e.target.value } : l
                              )
                            )
                          }
                        >
                          <option value="">Choose…</option>
                          {SHIFT_TYPES.map((shift) => (
                            <option key={shift} value={shift}>
                              {titleCase(shift)}
                            </option>
                          ))}
                        </Select>
                      </Field>
                    </>
                  ) : null}
                  {canReadCommercial ? (
                    <Field label="Unit cost">
                      <Input
                        inputMode="decimal"
                        value={line.unitCost}
                        placeholder="From rate card"
                        onChange={(e) =>
                          setLines((prev) =>
                            prev.map((l, i) => (i === index ? { ...l, unitCost: e.target.value } : l))
                          )
                        }
                      />
                    </Field>
                  ) : null}
                  <Field label="Unit sell">
                    <Input
                      inputMode="decimal"
                      value={line.unitSell}
                      placeholder="From rate card"
                      onChange={(e) =>
                        setLines((prev) =>
                          prev.map((l, i) => (i === index ? { ...l, unitSell: e.target.value } : l))
                        )
                      }
                    />
                  </Field>
                  <Button
                    size="sm"
                    variant="secondary"
                    aria-label={`Remove line ${String(index + 1)}`}
                    onClick={() => setLines((prev) => prev.filter((_, i) => i !== index))}
                  >
                    Remove
                  </Button>
                </Row>
              ))}
              <Row>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => setLines((prev) => [...prev, emptyLine()])}
                >
                  Add a line
                </Button>
              </Row>
            </Stack>
          </Section>
        </Stack>
      </Drawer>
    </Stack>
  );
}
