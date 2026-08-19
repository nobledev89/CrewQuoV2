# Operating-model packet — money boundary

**Domain:** the unit every stored money figure is denominated in — currency
identity on companies, rate cards, agreements and invoices; the **project
reporting currency** a summary is expressed in; the **FX snapshots** that let an
unlike-currency figure be reported without inventing a rate; and the explicit
gate that stops CrewQuo describing its invoices as tax documents.
**Phase:** 6 · **Status:** adopted · **Last updated:** 2026-08-19
**Plan refs:** §3.3 (rate tables, decision #5), §3.4 (projects), §3.5 (invoices),
§6 (the frozen PAY snapshot), §41.9 (precision and rounding), §41 closing rule (a
principle beats a product decision), §36 (revisions), §44 (the test list this
packet answers to).

---

**The distinction this whole domain rests on:** an amount is a *number* and a
*unit*, and CrewQuo has only ever stored the number. `companies.currency` was a
label on a company, not a property of each figure — which is safe exactly as long
as every figure in one company shares one unit. Phase 6 broke that assumption in
two places at once: a rate proposal carries its own currency (0009) and an invoice
carries its own currency (0008). Both shipped with an outright refusal of anything
unlike, because §41 forbids adding unlike units and CrewQuo holds no exchange
rate. **This packet is what replaces that refusal with a mechanism** — and the
mechanism's first rule is that it still never invents a rate.

> **Why "reporting currency" and not "convert everything to the company
> currency".** A conversion has to be *as of* something. Company currency is a
> live column an owner may change; a project is where work, cost and margin
> actually meet, and it has a life span. Making the project the unit of reporting
> means one project's history has one unit forever, and changing a company's
> currency next year cannot silently restate a project that closed last year.

## 1. Persona / job

| Persona | Job | Device / connectivity |
|---|---|---|
| **Contractor owner/admin (multi-currency)** | "My rigging crew in London bills me in GBP, my client pays me in USD, and I need one true margin figure for this project." | Desktop web, online, seated finance work. |
| **Contractor owner/admin (single-currency)** | "I work in one currency and always will. Do not make me think about any of this." | Desktop web. **This is the majority persona and the design's main constraint.** |
| **Subcontractor (provider)** | "I quote in my own currency. I should not have to quote in someone else's." | Desktop web; proposes rates (see the commercial-agreements packet). |
| **Finance reviewer** | "Where did this number come from? Show me the rate and who entered it." | Desktop web, reading a summary or an export. |
| **Platform support** | "A customer says their margin is wrong. Is it a missing rate or a wrong rate?" | Platform console, read-only over the customer's own records. |

Nobody does this on a phone and nobody does it offline — an FX rate is a finance
decision taken at a desk. §8 refuses offline capture outright rather than
deferring it.

## 2. Resource responsibility

| Resource | Creator | Owner | Reader | Reviewer | Publisher | Corrector | Exporter | Retention owner |
|---|---|---|---|---|---|---|---|---|
| `companies.currency` | company creation | the company | its members | — | — | OWNER via `PATCH /v1/companies/:id` | company | company |
| `projects.reporting_currency` | project creation, snapshotted from the owner company | the project | owner-company members; never the client | — | — | OWNER/ADMIN, **only while the project holds no committed money** | company | company |
| `fx_rates` row | OWNER/ADMIN of the reporting company | that company | its members; every converted figure cites it | — | — | **nobody edits a rate** — supersede it with a later `as_of`, or delete one no snapshot cites | company | company |
| Frozen FX inside `time_logs.resolved_rate` | the submit transaction | the time log | anyone who may read PAY | — | — | **nobody** — the same immutability as the PAY snapshot it lives inside | company | company |
| An invoice's currency | the create transaction, from the project's reporting currency | the invoice | issuer + counterparty | — | issue | **nobody** — an issued invoice is immutable (0008) | both parties | company |
| Live BILL conversion in a summary | computed at read time | nobody — it is a derivation | owner-company members | — | — | recompute | company | not stored |

**"Nobody" appears three times on purpose.** A frozen rate anybody can edit is not
frozen, and a rate somebody edited is a rate no historical figure can cite
honestly.

## 3. State machine

Currency has no workflow of its own; it is a property that becomes immutable at
defined moments. The states that matter are **how firmly a figure's unit is
pinned**:

| Stage | What is pinned | Who may still change it | Concurrency rule |
|---|---|---|---|
| **Unpinned** | a project with no approved time log, no approved expense and no non-void invoice | OWNER/ADMIN may change `reporting_currency` | the change takes the project row lock and re-checks emptiness inside the same transaction, so a concurrent first approval cannot slip in behind the check |
| **Pinned** | the project holds committed money | **nobody** — a change is refused, naming what pins it | n/a |
| **Frozen (PAY)** | a submitted time log's `resolved_rate.fx` | nobody | frozen inside the existing submit transaction; there is no ordering where a log has a PAY snapshot and no FX snapshot |
| **Invoice** | the invoice's `currency`, taken from the project's reporting currency at create | nobody | set inside the existing create transaction, under the advisory lock creation already takes |
| **Live (BILL)** | a summary's BILL conversion | recomputed every read | none — it is not stored |

An `fx_rates` row has no lifecycle of its own: it is inserted, cited, and either
superseded by a row with a later `as_of` or deleted if nothing cites it. There is
no edit path, and deletion is refused once a frozen snapshot names the row.

## 4. Permission + scope matrix

| Operation | Feature entitlement | Capability / role | Company edge | Resource scope |
|---|---|---|---|---|
| `GET /v1/fx-rates` | none — a unit is not a feature | any member | active membership | company-scoped; never reads another company's rates |
| `POST /v1/fx-rates` | none | **OWNER or ADMIN** | active membership | the acting company only |
| `DELETE /v1/fx-rates/:id` | none | **OWNER or ADMIN** | active membership | refused if a frozen snapshot cites it |
| `PATCH /v1/projects/:id` (`reportingCurrency`) | none | **OWNER or ADMIN** | active membership | must own the project; refused once pinned |
| Read a converted summary figure | existing project read | existing project read | existing | unchanged — conversion adds no new read path |
| Client / portal reads | — | — | — | **unchanged and structural.** A client sees BILL figures in the invoice's own currency. Reporting currency, FX rates and PAY conversions are owner-side and never cross the portal boundary. |

**No new entitlement key, and §43 adds none.** Gating multi-currency behind a plan
would mean a company that legitimately operates in two currencies gets *wrong*
numbers rather than fewer features — the failure mode §41 exists to prevent. The
same argument as the company-creation packet's: a plan says what a company may
*do*, not whether its arithmetic is allowed to be correct.

## 5. Domain events

| Event | Payload | Idempotency key | Consumers | Replay |
|---|---|---|---|---|
| `fx_rate.recorded` | company, base, quote, `as_of`, source, actor | `fx_rate.recorded:<fxRateId>` | none yet | safe — the row already exists; consumers re-read |
| `project.reporting_currency_set` | project, from, to, actor | `project.reporting_currency_set:<uuid>` — per **occurrence**, not per aggregate: a project can legitimately move USD -> GBP -> USD, and a key of `<projectId>:<currency>` would silently swallow the third event | none yet | safe |

Both are emitted through `enqueueOutboxEvent` on the domain transaction's client,
per the durable-delivery packet §5. Neither has a consumer today, and that is
stated rather than hidden: they exist so the Action Centre does not have to
retro-fit emission into these paths later — which is exactly the retrofit the
durable-delivery item is still carrying for the older domains.

## 6. Notification matrix

| Situation | Recipient | Channel | Urgency | Action Centre item |
|---|---|---|---|---|
| A project summary cannot report a figure because no FX rate covers a work date | the project owner's OWNER/ADMIN | in-product now; email/push when the notifications slice lands | not urgent — the figure is withheld, not wrong | **yes** — "Add an exchange rate for GBP→USD as of 2026-08-01" is a task with a repair path, which is the shape the Action Centre exists for |
| An unlike-currency proposal is submitted | the hiring company's reviewer | the existing commercial-agreement notification | normal | existing |

Nothing here notifies about a *rate value*. A wrong rate is a finance judgement,
not a system-detectable event, and inventing an alert for it would imply CrewQuo
has an opinion about the correct rate — which §41 says it must not.

## 7. Data classification + retention

FX rates are **commercial** data: they reveal what a company pays and charges
across borders. They are company-private, never client-visible, never in a portal
read and never in a client export. They live as long as the company, because a
frozen snapshot from three years ago must still be able to name its source — a
deleted rate row would turn a traceable historical figure into an unexplainable
one, breaking the same reproducibility rule §41.3 states for reports. Deletion is
therefore allowed only while nothing cites the row.

Frozen FX snapshots inherit the retention of the record they live inside
(`time_logs`, `invoices`) and are not separately purgeable. The audit trail records
who entered a rate and who changed a reporting currency; `recordAudit` runs
unconditionally (the Phase 6 technical-integrity gate) and customer visibility
stays independently gated.

## 8. Offline / conflict policy

**Refused, not deferred.** Entering an exchange rate and choosing a project's
reporting currency are seated desk decisions with no field equivalent, so neither
participates in the offline sync contract — no client id, no expected version, no
tombstone. Concurrency is handled by the database: `fx_rates` is uniquely keyed on
`(company_id, base_currency, quote_currency, as_of)`, so two people recording the
same rate race to the same row rather than creating two competing truths, and the
loser is told the rate already exists rather than silently overwriting it.

Reporting-currency changes take the project row lock and re-verify emptiness inside
the transaction, so "change the currency" and "approve the first time log" cannot
interleave into a project whose history is half in each unit.

## 9. Failure matrix

| Failure | Retryable? | What the user sees | Operator repair |
|---|---|---|---|
| No FX rate covers a needed conversion | yes, once a rate is recorded | the figure is **withheld and named**: "3 approved logs in GBP cannot be reported in USD — no rate on or before 2026-08-01" | the owner records the rate; frozen PAY keeps its own snapshot and is not restated |
| A rate exists but post-dates the work | yes | the same withholding — a future rate is never applied backwards | record a rate with the correct `as_of` |
| Unlike currency on a proposal, no rate | yes | the existing 422, now naming the exact missing rate rather than "still to be built" | record the rate, resubmit |
| A BILL card in a currency the project does not report in | no — deliberately | invoice derivation refuses, naming the currencies | agree the charge-out rate in the project's currency, or invoice that work on its own project |
| Reporting-currency change on a pinned project | no | refused, naming what pins it (approved logs / expenses / issued invoices) | none — this is the rule, not a fault |
| Deleting a cited rate | no | refused, naming how many frozen snapshots cite it | none |
| A rate recorded with the wrong value | not detectable by the system | nothing | record a corrected rate at a later `as_of`; frozen snapshots keep the rate they were computed with, and the audit shows both |

**Partial success is the normal case and is designed for, not an error.** A summary
with three of five providers convertible reports the three, withholds the two, and
says which — the same shape `billResolvable` already uses when BILL cards have a
gap. A total that silently omitted the unconvertible part would be worse than no
total.

## 10. Security / threat model

FX rates are company-scoped and read through the existing company edge; there is no
cross-company rate lookup and no platform-wide rate table, so no tenant can
influence another tenant's arithmetic. Forged `fxRateId` values fail closed through
the same "scope the WHERE clause by company" rule the rest of the API uses, and
reveal no cross-tenant existence.

The abuse surface worth naming: **a rate is an input to money owed.** An ADMIN who
records a favourable rate changes what a margin report says — so the writer is
recorded on the row, the action is audited, and every converted figure cites the
rate it used, which makes the manipulation visible rather than invisible. Rates are
deliberately not editable, because an edit would restate history with no trace; a
correction is a new row at a later `as_of`, leaving both visible.

There is no upload surface and no webhook surface in this domain. Support access
reads through the existing platform console and cannot write a rate.

## 11. Analytics contract

Activation: a company records its first FX rate. Outcome: a project with unlike
PAY/BILL currencies produces a complete margin. Quality metric: the count of
withheld figures per company — a rising number means customers are hitting the
boundary and not repairing it, which is the signal that the §6 Action Centre item
is needed. Funnel: unlike-currency refusal → rate recorded → figure reported.

**Excluded as sensitive:** rate values, amounts, company and project names,
counterparty identity, and the `source` free text. The metrics are counts and
currency-pair codes; nothing that reconstructs a customer's commercial position
leaves the tenant.

## 12. Acceptance script

**Persona: Dana, owner of a USD contractor hiring a GBP rigging crew.**

1. **Empty.** A new project reports in USD without Dana choosing anything; no FX
   rate exists and nothing asks for one. *The single-currency majority never meets
   this domain.*
2. **Pinning.** Dana changes the project's reporting currency while it is empty —
   allowed and audited. She approves a time log, then tries again — refused, naming
   the approved log.
3. **Denied.** A MEMBER attempts to record an FX rate — 403. A MEMBER attempts to
   change the reporting currency — 403.
4. **Refused, and told what is missing.** The GBP crew submits a GBP rate proposal
   to Dana's USD company. It is refused with a message naming the exact missing
   rate: GBP→USD.
5. **Repair.** Dana records `GBP→USD @ 1.27, as of 2026-08-01, source "ECB
   reference rate"`. The proposal now submits and approves.
6. **Frozen.** A GBP time log is submitted and approved. Its `resolved_rate` carries
   both the GBP cost and the frozen FX — rate, `as_of` and source. Dana records a
   *different* rate at a later `as_of`; the approved log's reported cost **does not
   move**, and a newly submitted log uses the newer rate. Both logs name the rate
   they used.
6b. **The invoice refuses rather than converts.** A BILL card denominated in GBP on
   a USD-reporting project makes invoice derivation refuse, naming both currencies.
   An agreed charge-out rate is what the client owes; converting it would bill them
   a number nobody agreed, at a rate only the owner has seen.
7. **Withholding.** A log dated *before* the earliest recorded rate is approved. The
   summary reports what it can, withholds that log's cost, and names the missing
   rate rather than reporting a smaller total as if it were complete.
8. **Correction.** Dana deletes a rate nothing cites — allowed. She deletes one a
   frozen snapshot cites — refused, naming the count.
9. **Boundary.** The client portal read and the client export for the same project
   contain no reporting currency, no FX rate and no PAY conversion — the §3.6
   exclusions remain structural.
10. **Tax honesty.** Nothing in the invoice UI, the export or the API describes the
    document as a tax invoice, and `tax_cents` is labelled as a manually entered
    amount.

---

## The tax gate — defining, deliberately not building

The plan's wording is *"**Define** tax identity, addresses, line tax, credit notes
and payment allocation before marketing project invoices as jurisdiction-compliant
tax invoices."* The verb is define, and this section is that definition. **No tax
schema ships in this slice**, because inventing a tax shape before the
jurisdictions are known is exactly the invented-shape failure §0 rule 3 forbids —
and a half-built tax model is more dangerous than an honestly labelled manual
field, because it looks authoritative.

What today's invoice actually is: a commercial document with a **single
operator-entered `tax_cents` lump sum**, no tax identity on either party, no
per-line rate, no jurisdiction and no credit-note path. That is a legitimate
inter-company document. It is **not** a tax invoice in any jurisdiction, and the
product must not imply that it is.

**The five requirements, each of which must exist before that claim may be made:**

1. **Tax identity** — a registered tax number per company (VAT/GST/TIN), its issuing
   jurisdiction, and format validation per jurisdiction. Both issuer and
   counterparty identity must appear on the document.
2. **Addresses** — a structured registered address per company, plus the
   place-of-supply rules that decide which jurisdiction's tax applies. A free-text
   address does not answer place of supply.
3. **Line tax** — a tax rate and tax code per `invoice_items` row rather than a
   header lump sum; per-rate subtotals on the document; and the rounding rule stated
   per jurisdiction (round per line vs round per rate group — they give different
   totals, and §41.9 forbids choosing silently).
4. **Credit notes** — an immutable issued invoice cannot be edited, so a correction
   must be a separate linked credit-note document with its own numbering series, not
   a void-and-reissue that erases what the counterparty already received.
5. **Payment allocation** — payments as their own records allocated against
   invoices, supporting partial and over-payment, so `PAID` becomes a derived state
   rather than a manually flipped flag. The current `PAID` transition is an operator
   assertion and is documented as such.

**Until all five exist**, the honesty guard is: no surface — UI, export or API —
uses the phrase "tax invoice", and the tax field is labelled as manually entered.
This is asserted by test, not left to reviewer memory.
