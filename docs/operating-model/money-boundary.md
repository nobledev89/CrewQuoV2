# Operating-model packet — money identity

**Domain:** the unit every stored money figure is denominated in. A company's one
currency, the **project reporting currency** that snapshots it so history cannot be
relabelled, the pin that fixes it once money commits, and the explicit gate that
stops CrewQuo describing its invoices as tax documents.
**Phase:** 6 · **Status:** adopted · **Last updated:** 2026-08-19
**Plan refs:** §3.3 (rate tables, decision #5), §3.4 (projects), §3.5 (invoices),
§6 (the frozen PAY snapshot), §41.9 (precision and rounding), §44 (the test list
this packet answers to).

---

> **This packet was rewritten on 2026-08-19, and the rewrite is the interesting
> part.** It originally specified a multi-currency money boundary: per-row currency
> on rates and invoices, human-recorded exchange rates with required provenance, FX
> citations frozen onto approved work, and a reporting pipeline that withheld any
> figure it could not convert and named the gap. All of that shipped (migration
> 0013) and was withdrawn the same day by owner decision:
>
> **A company works in exactly one currency, and the currency is a label — something
> printed in front of an amount.**
>
> Migration 0017 reverses it. The old design is described below only where knowing
> it prevents somebody rebuilding it.

**The distinction this domain rests on:** an amount is a *number* and a *unit*.
CrewQuo stores the number as integer minor units and the unit as a **label on the
company** — and that is safe, because a company has exactly one. There is no
conversion anywhere in the product, no exchange rate stored or fetched, and no
arithmetic that crosses units, because there is never a second unit to cross into.

**The one thing a label can still get wrong is being retroactive.** The stored
minor units never move. So if a company changes its currency, every historical
figure keeps its number and silently acquires a new meaning — a project quoted and
closed in one unit, displayed a year later in another. That single failure mode is
what the rest of this packet is about.

## 1. Persona / job

| Persona | Job | Device / connectivity |
|---|---|---|
| **Company owner at signup** | "Show my money in my currency." | Desktop. Sets it once and never thinks about it again. |
| **Owner who picked wrong** | "We set this up as USD and we're a UK business." | Desktop. Wants to fix a young account, not restate a year of history. |
| **Anyone reading a figure** | "What unit is this number in?" | Any. Needs the label next to the number, not in a settings screen two clicks away. |
| **Client in the portal** | "What am I being charged, and in what?" | Any. Sees the provider's label without seeing the provider's costs. |

**Nobody in this table is trading across currencies**, and that is the decision, not
an oversight. A business operating in two currencies needs two CrewQuo companies —
which is a real answer, because a separate currency almost always comes with
separate books, a separate entity and separate reporting anyway.

## 2. Resource responsibility

| Resource | Creator | Owner | Reader | Corrector | Retention owner |
|---|---|---|---|---|---|
| `companies.currency` | signup (defaults `USD`) | the company | its members, and clients through the portal | OWNER/ADMIN, any time | the company |
| `projects.reporting_currency` | project creation, **snapshotted from the company** | the project | owner-company members; the client sees it as `currency` | OWNER/ADMIN, **until the project holds committed money** | the company |
| A stored minor-unit amount | whatever wrote it | that record | per that record's rules | that record's own correction path | that record |
| The unit of a rate card, proposal or invoice | **nobody — it is not stored** | — | derived from the company or the project | n/a | n/a |
| `currency_model_change_log` | migration 0017, once | the platform | operators | **nobody — insert-only** | the platform |

**The fourth row is the point of the rewrite.** Rate cards, rate proposals and
invoices each used to carry their own `currency`. Every one of them could only ever
hold a copy of the owning company's, and a copy that *can* drift is worse than no
copy: it makes "which of these two is authoritative?" a real question with no
answer. They were dropped in 0017.

## 3. State machine

Currency has no workflow. What matters is when the label may still change.

| Stage | Rule |
|---|---|
| Company currency | changeable by OWNER/ADMIN at any time. **Changing it relabels nothing that already exists** — every project keeps the label it snapshotted, and only projects created afterwards inherit the new one. |
| Project label, **unpinned** | a project with no approved time log, no approved expense and no non-void invoice may have its label changed by OWNER/ADMIN. |
| Project label, **pinned** | after any of those exist, it is fixed for the life of the project. |
| A stored amount | only its own domain's correction path may alter it. A label change must never rewrite one. |

**The invariant, stated once:** *changing a currency label changes presentation and
future inheritance, never a stored number and never a past project's label.*

**Concurrency: the count runs inside the transaction that holds the project row
lock.** Reading "is this project empty?" and then updating it leaves a window where
the first time log is approved between the two — giving a project whose history is
half labelled one way. Row lock first, count inside it. A `VOID` invoice is
deliberately not a pin: it is a document withdrawn before it became a claim, the
same exclusion the purchase-order ceiling already makes.

## 4. Permission + scope matrix

| Operation | Feature entitlement | Capability / role | Company edge | Resource scope |
|---|---|---|---|---|
| Read a currency label | none | any member | active membership | own company; clients read a published project's |
| `PATCH /v1/companies/:id` (`currency`) | none | **OWNER or ADMIN** | active membership | acting company |
| `PATCH /v1/projects/:id` (`reportingCurrency`) | none | **OWNER or ADMIN** | active membership | must own the project; refused once pinned |
| Set a currency on a rate card, proposal or invoice | — | **nobody** | — | there is no such field, in the API or the database |

**No entitlement key, and §43 adds none.** Gating a label behind a plan would mean
a company on the cheap tier gets figures labelled with a unit it does not use — not
fewer features, *wrong numbers*. A plan says what a company may do, not whether its
arithmetic is allowed to be legible.

## 5. Domain events

| Event | Payload | Idempotency key | Consumers |
|---|---|---|---|
| `project.reporting_currency_set` | projectId, from, to, actor | per occurrence (`:<uuid>`) | none yet; audited, and available to reporting later |

**Keyed per occurrence, not per aggregate.** `<projectId>:<currency>` would swallow
the second event of a USD → GBP → USD sequence. Atomicity with the domain write
comes from the transaction; the key only has to be unique per event.

A company currency change emits **no** event, because nothing downstream
recomputes: no stored number moves and no existing project's label follows it.
Stated as a decision rather than left as an omission — an event here would imply a
migration of past data that must never happen.

## 6. Notification matrix

Not applicable, and deliberately so. A currency change is a settings edit by the
person who owns the setting; notifying them of their own action is noise. It is
audited, which is where the question "who changed this and when" is answered.

## 7. Data classification + retention

A currency label is **low-sensitivity configuration** and is the one piece of money
metadata that *is* client-facing: the portal shows a project's label, because a
figure without a unit is not a figure. Everything else on the owner's side of the
money — PAY costs, margin, rate snapshots — stays off that payload, enforced
structurally by the `PortalProjectView` shape rather than by a filter somebody can
forget.

`currency_model_change_log` is platform data, never customer-visible, insert-only
and never purged. It holds the previous label of every figure whose label changed
when multi-currency was withdrawn, so *"why does this 2026 rate card read USD when
it was entered as GBP?"* has an answer years later.

## 8. Offline / conflict policy

Nothing here is offline-editable. A field client captures amounts, never units: the
unit is a property of the company the work belongs to, resolved server-side. A
device that has been offline across a currency change syncs its numbers and picks up
whatever label the server says — which is correct, because it never had an opinion.

## 9. Failure matrix

| Failure | Retryable? | What the user sees | Repair |
|---|---|---|---|
| A currency code that is not three uppercase letters | no | refused at validation, naming the field | enter an ISO 4217 code |
| Changing a pinned project's label | no | refused, **naming what pins it** — "3 approved time logs" | none; this is the rule, not a fault |
| Changing a company's currency after years of use | n/a | allowed, and nothing already recorded is relabelled | none needed |
| A BILL rate missing for approved work | no | the bill total and margin are **withheld**, not zeroed | agree a rate for that role and label |

**The withholding rule that survives is about rates, not currency.** A line with no
covering BILL card is "not priced yet", and folding it in at zero would understate
an invoice. The bill total, and any margin computed from it, are withheld rather
than guessed (§41.1). The old `conversionGaps` mechanism did the same thing for
unconvertible figures and is gone with them.

## 10. Security / threat model

Small surface. A currency label is not a secret, and the only injection-shaped path
is validation, closed by a three-letter regex at the edge and a check constraint in
the database.

**The abuse worth naming: relabelling as misrepresentation.** An owner can change a
company's currency, and a client reading the portal sees the label a project
snapshotted. Because the snapshot is taken at creation and pinned once money
commits, an owner *cannot* retroactively present a closed project's figures in a
different unit — which is the only version of this with a victim. Bounded rather
than eliminated: an unpinned project's label can still be changed, and that is
correct, because nothing has been agreed against it yet.

## 11. Analytics contract

Distribution of currencies across companies, count of company-currency changes per
month, and count of pinned-project refusals (a rising number means people are
trying to do something the model forbids, which is a product signal).

**Excluded as sensitive:** any amount, and anything correlating a named company with
its figures.

## 12. Acceptance script

**Persona: Dana, whose company is set up in USD.**

1. **Empty.** A new project reports in the company's currency without anybody
   choosing. *The overwhelming majority never meets this domain at all.*
2. **Unpinned.** Dana changes an empty project's label; it is audited with both
   sides and emits one durable event in the same transaction.
3. **Snapshotted, not referenced.** Dana changes the *company* currency. Every
   existing project keeps its label; a project created afterwards inherits the new
   one. This is the assertion the whole design exists for.
4. **Denied.** A MEMBER cannot change a project's label — asserted after a real
   membership exists, so the refusal is about the role rule and not the company
   edge.
5. **Gone.** There is no exchange-rate API, no `fx_rates` table, and no per-row
   currency column on invoices, rate cards or rate proposals. Asserted as absences,
   because the way multi-currency comes back is somebody re-adding one column.
6. **Not the proposer's choice.** A PAY schedule takes the hiring company's
   currency; a currency sent by the proposer is ignored rather than honoured.
7. **Frozen, unconverted.** An approved log's PAY snapshot carries its cost and its
   label, and **no** FX block. The summary reports that cost as-is.
8. **Pinned.** With approved work on the project, a label change is refused, naming
   what pins it and saying the harm is *relabelling* rather than arithmetic.
9. **Tax honesty.** No API response, export or screen calls the document a tax
   invoice.
10. **Portal.** The client sees the project's label and no PAY cost, no margin and
    no rate snapshot; the payload is exactly its nine documented fields.

## What went, and why it is not coming back by accident

Recorded because the fastest way to rebuild a withdrawn feature is one plausible
column at a time.

- **`fx_rates`** — human-recorded rates with required provenance and an
  immutability trigger. Gone with its trigger and function.
- **`invoices.currency`, `rate_cards.currency`, `rate_proposals.currency`** — each
  could only ever copy its company's label.
- **The `fx` key inside `time_logs.resolved_rate`** — a frozen rate citation per
  approved log.
- **`convertMinorUnits` / `convertToReportingCurrency` / `pickFxRate`** — exact
  `bigint` arithmetic with one deliberate rounding, as-of rate selection, and a
  refusal that named the missing row.
- **`conversionGaps`** — the mechanism that withheld an unconvertible figure and
  reported its pair, earliest date and count rather than folding it in at zero.
- **`currencyBoundaryRefusal`** — the check that refused an unlike PAY schedule
  until a covering rate existed.
- **The exchange-rate screen** in company settings.

**The expense hole closed itself.** An earlier version of this packet documented at
length that `expenses` carries no currency column, making a provider's amount in
another unit read at face value in the project's. Under one currency per company
there is no other unit, so the column is not missing — it was never needed.

**If multi-currency is ever wanted again**, it is a new packet, not a revived
column: the requirement would be per-*entity* currency with conversion, and the
hard parts are the ones the deleted design had already solved — an as-of date for
every conversion, provenance for every rate, and withholding rather than estimating
when no rate covers a figure. Read 0013 and this file's history before starting.

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
