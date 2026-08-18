# Operating-model packet — commercial agreements

**Domain:** cross-company PAY rate schedules (proposal → approval → immutable
versions), engagement commercial terms (payment terms, purchase-order reference
and ceiling), and engagement/assignment acceptance.
**Phase:** 6 · **Status:** adopted · **Last updated:** 2026-08-18
**Plan refs:** §3.3.1 (the workflow), §3.3 (`rate_cards`), §4 (authorization),
§16 decision #23, §36 (`record_revisions`), §41 (calculation principles), §42.

---

## 1. Persona / job

| Persona | Company side | Job | Device / connectivity |
|---|---|---|---|
| **Provider manager** | provider on the edge | "The rate I agreed with this contractor went up in April. Get the new schedule in front of them without arguing over a spreadsheet." | Desktop web, online. Money entry is deliberate, seated work — not a field task. |
| **Hiring commercial manager** | client on the edge | "Somebody wants more money. Show me exactly which lines change, against what they're on now, and let me approve or send it back with a reason." | Desktop web, online. |
| **Hiring owner** | client | "Approve a schedule that should have started last month, and own that decision in writing." | Desktop web. |
| **Provider owner accepting work** | provider | "I've been added as a subcontractor / put on a project. Say yes, and know what the payment terms are before I put people on site." | Desktop web; mobile read is enough (Phase 13). |

Nobody does this offline. Rate negotiation is not a field workflow, which is why
§8 below refuses offline capture outright rather than deferring it.

## 2. Resource responsibility

| Resource | Creator | Owner | Reader | Reviewer | Publisher | Corrector | Exporter | Retention owner |
|---|---|---|---|---|---|---|---|---|
| `rate_proposals` (header) | provider manager+ | provider company | both endpoints of the edge | hiring manager+ | — (approval publishes) | nobody — a submitted proposal is frozen; correction is a successor proposal | both sides, own copy | provider company |
| `rate_proposal_lines` | provider manager+ | provider company | both endpoints | hiring manager+ | — | nobody once submitted | both sides | provider company |
| approved PAY `rate_cards` | the approval transaction, or hiring manager+ via direct entry | **hiring company** (it is the card owner — `rate_cards.company_id`) | hiring company; the provider reads only the schedule it proposed, never the hiring company's BILL cards | — | — | nobody — locked. A change is a new version | hiring company | hiring company |
| engagement commercial terms | hiring manager+ | hiring company | both endpoints | — | — | hiring manager+, revision-tracked | both | hiring company |
| engagement acceptance | provider owner/admin/manager | provider company | both endpoints | — | — | nobody — decline then re-invite | both | both |
| assignment acceptance | provider manager+ | provider company | both endpoints | — | — | provider may accept after declining | hiring company | hiring company |

**The load-bearing row is the third.** An approved PAY card belongs to the hiring
company even though the provider proposed it, because `rate_cards.company_id` is
the card *owner* and PAY means "what this owner pays a provider". That is why the
`role_id` on every proposal line must resolve in the **hiring** company's
`role_catalog` — the same catalog `time_logs.role_id` already points at.

## 3. State machine

```
                                    ┌── approve (hiring) ──▶ APPROVED   ── terminal
                                    │                        └ writes immutable
                                    │                          rate_card versions
  (none) ──create──▶ DRAFT ──submit──▶ SUBMITTED ──reject (hiring, ──▶ REJECTED  ── terminal
           provider    │     provider    (frozen)  │  reason required)
                       │                           │
                       └── delete (provider)       └── withdraw (provider) ──▶ WITHDRAWN ── terminal
                            row is gone
```

- **Actors.** `DRAFT` mutations, `submit`, `withdraw` and `delete`: provider-side
  `OWNER|ADMIN|MANAGER` only. `approve` / `reject`: hiring-side
  `OWNER|ADMIN|MANAGER` only. Neither side can act for the other, and `MEMBER` can
  act on neither.
- **Delete and withdraw are different verbs for different audiences.** A `DRAFT`
  the hiring side has never seen is *deleted* — there is nothing to explain to
  anyone. A `SUBMITTED` proposal has landed in someone else's queue, so pulling it
  back is a *withdrawal* that leaves a terminal row behind. This is why no state
  exists with a null `submitted_at` other than `DRAFT`, and the DB check says so.
- **Submission freezes the payload.** After `submit`, no line may be added, edited
  or removed by anyone — including the reviewer. §3.3.1: *"the reviewer cannot
  silently edit and approve different numbers"*. The reviewer's only lever is
  reject-with-a-reason.
- **Rejection is terminal, and resubmission is a new proposal** carrying
  `predecessor_proposal_id`. The history is a chain, not a mutable row.
- **Terminal states are immutable.** `APPROVED`, `REJECTED`, `WITHDRAWN` accept no
  further transition; a second approve on an already-approved proposal is a 409,
  not a second set of rate cards.
- **Concurrency.** Two hiring managers approving at once: the transition is
  `update … where id = $1 and status = 'SUBMITTED'`, so exactly one wins and the
  loser gets `CONFLICT`. The approval additionally takes
  `pg_advisory_xact_lock('rate-proposal:<engagementId>')` so two proposals on the
  same edge cannot interleave their window-closing and leave two cards live for the
  same (role, label, date).
- **One open negotiation per edge.** A partial unique index allows at most one
  `DRAFT|SUBMITTED` proposal per engagement. Two open proposals would make "what
  are we currently arguing about" ambiguous, and whichever approved second would
  silently win.
- **Future-effective approval is honoured, retroactive is refused.** Approving with
  `effectiveFrom` in the future leaves the current schedule live until the date
  arrives — the existing effective-date resolver already does this, so nothing
  special is needed. Approving with `effectiveFrom` *before today* is refused
  unless the approver is an `OWNER` and supplies a reason, because already-approved
  time keeps its frozen PAY snapshot and a retroactive rate therefore disagrees
  with money already owed.

**Engagement acceptance.** `PENDING → ACTIVE` (provider accepts) or `PENDING →
ENDED` (provider declines, reason recorded). A hiring company creating an
engagement against an **existing real company** now lands in `PENDING`, not
`ACTIVE`: binding another company unilaterally is not something the product should
be able to do. The placeholder/invite path was already `PENDING → ACTIVE on
accept`, so the two paths now agree instead of contradicting each other.

**Assignment acceptance.** `PENDING → ACCEPTED | DECLINED`, provider-side. A
declined assignment may be accepted later. **Acceptance deliberately does not gate
work capture** — see §9.

## 4. Permission + scope matrix

| Operation | Feature entitlement | Role | Company edge | Resource scope |
|---|---|---|---|---|
| `GET /v1/rate-proposals` | none | any member | either endpoint | — |
| create / edit / delete draft | **none** | provider `OWNER\|ADMIN\|MANAGER` | provider side | the proposal's engagement |
| submit / withdraw | **none** | provider `OWNER\|ADMIN\|MANAGER` | provider side | the proposal |
| approve / reject | **`rate_cards`, resolved on the _hiring_ company** | hiring `OWNER\|ADMIN\|MANAGER` | client side | the proposal |
| retroactive approve | as above, plus `OWNER` | hiring `OWNER` | client side | the proposal |
| direct-entry schedule | **`rate_cards`** (hiring company) | hiring `OWNER\|ADMIN\|MANAGER` | client side | the engagement |
| edit engagement terms | none | hiring `OWNER\|ADMIN\|MANAGER` | client side | the engagement |
| accept / decline engagement | none | provider `OWNER\|ADMIN\|MANAGER` | provider side | the engagement |
| accept / decline assignment | none | provider `OWNER\|ADMIN\|MANAGER` | provider side | the assignment's project |

**Proposing is free on purpose.** The Crew plan has *no* features — it is the free
"be a subcontractor" funnel (§5B). Gating proposals on the proposer's plan would
mean a free subcontractor could never ask for a raise, which inverts who the free
tier is for. The gate sits on the side whose `rate_cards` actually get written: the
hiring company, which is also who pays for `rate_cards`. This mirrors the portal
rule already in force — *"a free-plan client can still be shown a portal by a
provider who pays for one"* — with the sides swapped.

**No new entitlement key.** §43 adds none for this domain and none is needed:
`rate_cards` already means "this company maintains rate cards", which is exactly
what approval does.

## 5. Domain events

No transactional outbox exists yet — it is a later Phase 6 bullet. Until it does,
"event" means *an `audit_logs` row plus, where the record needs before/after, a
`record_revisions` row*, both written inside the business transaction. Recording
the intended event names now means the outbox lands as a change of transport rather
than a redesign.

| Event | Payload (transactional) | Idempotency key | Consumers | Replay |
|---|---|---|---|---|
| `rate_proposal.submitted` | proposal id, engagement, line count, effective date | proposal id + `SUBMITTED` | hiring-side notification; Action Centre | idempotent — the status is already terminal for this key |
| `rate_proposal.approved` | proposal id, ids and versions of every card written, effective date | proposal id + `APPROVED` | provider notification; Action Centre; rate cache | replaying must not write a second card set — guarded by the status transition |
| `rate_proposal.rejected` | proposal id, decision reason | proposal id + `REJECTED` | provider notification | idempotent |
| `rate_proposal.withdrawn` | proposal id | proposal id + `WITHDRAWN` | hiring notification | idempotent |
| `engagement.terms_updated` | engagement id, changed fields, before/after | engagement id + `updated_at` | both sides | idempotent |
| `engagement.accepted` / `.declined` | engagement id, decision reason | engagement id + status | hiring notification | idempotent |
| `assignment.accepted` / `.declined` | assignment id, project, reason | assignment id + status | hiring notification | idempotent |

## 6. Notification matrix

Push and email are a later Phase 6 bullet, so today every row below is delivered as
an audit row the counterparty can see in its trail plus the pending count the
workspace already renders. Recorded so the notification phase has a specification
instead of a guess.

| Event | Recipient | Channel | Urgency | Digest / quiet hours | Escalation | Action Centre item |
|---|---|---|---|---|---|---|
| submitted | hiring `OWNER\|ADMIN\|MANAGER` | in-app + email | same-day | digestible | none | "Rate schedule awaiting your decision" |
| approved | provider submitter + provider owners | in-app + email | same-day | digestible | none | closes the provider's "awaiting decision" item |
| rejected | provider submitter + provider owners | in-app + email | same-day | never digest away the reason | none | "Rate schedule returned — <reason>" |
| withdrawn | hiring reviewers | in-app | low | digestible | none | closes the hiring item |
| engagement invited / accepted / declined | the other side | in-app + email | same-day | digestible | none | "New engagement awaiting your acceptance" |
| assignment offered / accepted / declined | the other side | in-app | low | digestible | none | "Project assignment awaiting acceptance" |

Every row is a *link* to the record. None of them is the only copy of the task.

## 7. Data classification + retention

- **Commercial, not personal.** Rates, PO references and ceilings are commercial
  confidential between the two endpoints of one edge. The one-hop rule (§3.2) is
  the whole boundary: nobody upstream or downstream sees them.
- **Default visibility.** Proposals are visible to both endpoints from creation —
  except a `DRAFT`, which only the provider sees. There is no "publish" step beyond
  `submit`.
- **BILL never appears.** No response on this surface carries a BILL amount, a
  margin, or a BILL card id, on either side. The provider-never-reads-BILL rule
  (§4) is unchanged by this domain; the approval and direct-entry paths write PAY
  cards only, and the API refuses a BILL `kind` anywhere in a proposal.
- **Lifecycle.** Proposals and approved card versions are **retained for the life
  of the company**, not `audit_retention_days`. They are the evidence for money
  already paid; expiring them would leave an approved time log whose PAY snapshot
  no schedule explains. `record_revisions` rows attached to them follow the same
  rule, which is the §36 exception for revisions backing a financial record.
- **Legal hold / deletion.** Company deletion cascades through the `companies` FK.
  A per-record deletion path is deliberately absent: the correction path is a
  successor version, never an erasure.
- **Export.** Both sides can export their own copy — *not built in this pass.* The
  export engine's model would need a commercial sheet; recorded as a known gap.

## 8. Offline / conflict policy

**Offline capture is out of scope for this domain, by design rather than by
deferral.** Every persona in §1 is a seated desktop user, and a rate schedule
composed on a plane and synced later would be a schedule negotiated against numbers
that have since changed. The refusal is enforced structurally: submission freezes
the payload and approval is a server-side transaction over live rows, so there is no
client-authored terminal state to reconcile.

Conflict handling for the concurrent-online case is §3's rule: every transition is a
conditional update on the source state, the loser gets `CONFLICT` carrying the
current status, and the UI reloads rather than retrying. No client ids, no expected
versions, no tombstones — because nothing here is created offline.

## 9. Failure matrix

| Failure | Class | Partial success possible? | Operator repair | What the user sees |
|---|---|---|---|---|
| a line's `roleId` is not in the hiring company's catalog | terminal, validation | no — validated before any write | none needed | 422 naming the line |
| a `REPLACE`/`END` target card is missing, not PAY, not this edge's, or already superseded | terminal, validation | no | none | 422 naming the line and the reason |
| proposal currency ≠ hiring company currency | terminal, validation | no | change the company currency, or wait for the FX bullet | 422 saying unlike currencies need the project reporting currency and frozen FX snapshot that Phase 6's money-boundary item adds |
| retroactive effective date, non-owner approver | terminal, forbidden | no | an owner approves with a reason | 403 explaining the override exists and who holds it |
| two approvals race | terminal for the loser | **no** — advisory lock plus conditional update make the whole approval atomic | none | 409 with the current status; the screen reloads |
| approval writes some cards then fails | **impossible** | no — one transaction; window-closing and version inserts commit together or not at all | none | 500, nothing written |
| `recordAudit` / `recordRevision` fails | non-fatal | yes: the business change commits, the trail row does not | logs carry the failure; §36 rule | nothing — an approval must not fail because its trail did |
| PO ceiling would be breached at invoice issue | terminal, validation | no | raise the ceiling (audited) or void an invoice | 422 naming the ceiling, what is already committed, and this invoice's total |

**Why assignment acceptance does not gate work capture.** Gating it would mean an
unaccepted assignment silently stops a crew logging the hours they have already
worked — the failure would land on the worker, hours after the decision that caused
it, and the repair would sit with a different company. Phase 3 proved the loop
without it. Acceptance is therefore recorded and surfaced, and whether it becomes a
hard gate is left as an explicit later decision rather than smuggled in here.

## 10. Security / threat model

- **Tenant boundary.** Every read resolves the engagement edge first and answers
  `NOT_FOUND` for a company that is not an endpoint — the same answer a forged id
  gets, so existence is never disclosed. `uuidParam` rejects malformed ids before
  they reach Postgres.
- **Privilege escalation across the edge.** The two act-side checks
  (provider-side for drafting, client-side for deciding) are separate policy
  functions with separate unit tests, so widening one cannot silently widen the
  other.
- **Forged line targets.** `replacesRateCardId` is re-validated inside the approval
  transaction against `(company_id = hiring, kind = 'PAY', counterparty =
  provider)` — a provider cannot aim a `REPLACE` at a card belonging to another
  edge, another counterparty, or the BILL side.
- **Tampering with approved money.** Locked `rate_cards` are protected by a
  **database trigger**, not only by route logic: an `UPDATE` may touch
  `effective_to` / `active` / `updated_*` and nothing else, and a `DELETE` is
  refused outright. A future "tidy-up" that adds a `PATCH` path cannot quietly
  rewrite an approved rate.
- **No upload or webhook surface** in this domain, so neither abuse class applies.
- **Support access.** Platform staff have no path into this data — the super-admin
  console operates on plans and subscriptions, not on commercial agreements. Stated
  because it is a deliberate absence, not an oversight.
- **Secret rotation:** nothing new. No third-party credential is involved.

## 11. Analytics contract

- **Activation:** first `rate_proposal.submitted` per provider company; first
  `rate_proposal.approved` per hiring company.
- **Outcome:** approved / rejected / withdrawn / still-open, by edge.
- **Funnel:** engagement accepted → proposal drafted → submitted → decided → time
  logged against an approved card.
- **Quality metric:** median hours from `submitted_at` to `reviewed_at`, and the
  share of proposals that are successors of a rejection — a high share means the
  form is not showing the reviewer what they need.
- **Excluded from every payload:** all amounts (`*_cents`, multipliers,
  `min_hours`), `purchase_order_reference`, `purchase_order_ceiling_cents`,
  `decision_reason`, the retroactive reason, role names and company names. Counts,
  timestamps and opaque ids only. A rate is the most commercially sensitive number
  in the product and has no business in an analytics pipeline.

## 12. Acceptance script

Implemented as the *Commercial agreements* section of
[`apps/api/scripts/verify-e2e.ts`](../../apps/api/scripts/verify-e2e.ts).

1. **Empty.** A provider with no proposals opens the screen and is told what a
   proposal is for, not shown an empty table.
2. **Happy path.** Provider manager drafts a schedule (one `CREATE`, one
   `REPLACE`) and submits it; the hiring manager sees the lines with the current
   rate beside each one and approves; the new PAY cards are live, the replaced
   card's window is closed the day before the new one opens, and
   `/v1/rates/resolve` returns the new amount on or after the effective date and
   the old one before it.
3. **Denied.** The provider tries to approve its own proposal (403). A hiring
   `MEMBER` tries to approve (403). An outsider company reads the proposal (404).
   A hiring company whose plan lacks `rate_cards` tries to approve (403 naming the
   feature).
4. **Rejected → corrected.** The hiring manager rejects with a reason; the provider
   cannot edit the rejected proposal (409), clones it into a successor, fixes the
   number and resubmits; the successor approves and the chain is walkable.
5. **Frozen.** The provider tries to edit a `SUBMITTED` line (409). The reviewer has
   no edit path at all — there is no route that would accept one.
6. **Retroactive.** A manager approves a back-dated schedule (403); the owner
   approves it with a reason (200) and the reason is on the record; an
   already-approved time log's PAY snapshot is unchanged.
7. **Immutability.** A direct `UPDATE` of a locked card's amount is refused by the
   database. Closing its window is allowed.
8. **Terms.** The hiring company sets 30-day payment terms and a PO ceiling; a new
   invoice's due date defaults from the terms; issuing an invoice that would breach
   the ceiling is refused, and the refusal names the committed total.
9. **Acceptance.** A direct-created engagement starts `PENDING`; the provider
   accepts and it goes `ACTIVE`; an assignment is offered, declined with a reason,
   then accepted. Work capture is proven still to function while an assignment is
   unaccepted.
10. **Correction.** Engagement terms are changed twice; `record_revisions` holds
    both before/after pairs with the actor and the reason.
