# Operating-model packets

CREWQUO_V2_PLAN.md §19.5 makes twelve questions a **planning input** for every
domain, not a document written after the fact: *"Before a phase hardens a new
domain, its planning packet must answer the operating questions below."*

This directory is where those answers live. One file per domain, named after the
domain rather than the phase, because domains outlive the phase that shipped them.

`TEMPLATE.md` is the reusable packet. Copy it, answer every heading, and delete
nothing — a heading with "not applicable, because …" is an answer; a missing
heading is an unasked question, which is the failure mode §19.5 exists to prevent.

| Domain | Packet | Shipped in |
|---|---|---|
| Access, sessions & platform security — factors and recovery, session/device lifecycle, rate limiting, secret rotation, support access | [access.md](./access.md) | Phase 6 |
| Commercial agreements — PAY rate proposals, engagement terms, acceptance | [commercial-agreements.md](./commercial-agreements.md) | Phase 6 |
| Company ownership & creation — the first-company allowance, additional-company approval, duplicate routing, trial eligibility | [company-creation.md](./company-creation.md) | Phase 6 |
| Durable delivery — transactional events/jobs, inbound webhooks, retry, dead letters and replay | [durable-delivery.md](./durable-delivery.md) | Phase 6 |
| Money identity — one currency per company, the project label snapshot, its pin and the tax-compliance gate | [money-boundary.md](./money-boundary.md) | Phase 6 |
| Observability & data lifecycle — request/tenant/job correlation, the scheduler, error tracking, what a customer may export, what deletion does to a cross-tenant record, and the recovery promise | [observability-data-lifecycle.md](./observability-data-lifecycle.md) | 6 |
| Notifications & the Action Centre — the durable per-recipient projection, channels, quiet hours, delivery evidence | [notifications.md](./notifications.md) | Phase 6 |
| Time & time zones — company/project IANA zones, instant-vs-date, DST, date-bound rules | [time.md](./time.md) | Phase 6 |

Earlier domains (identity, rates, the delivery loop, portal/audit, invoices) were
built before the §19.5 decision was adopted on 2026-08-18 and have no packet. They
are not retro-fitted on principle: a packet is worth writing when it can still
change the design. Where one of those domains is next reopened, its packet gets
written then — which is exactly what `company-creation.md` is. It covers the part
of identity §3.1.1 reopens (who may create a tenant) and nothing else.

`access.md` is the second half of that sentence coming due. It read "auth, sessions
and invitations keep no packet until something reopens them" until 2026-08-19, when
the §42 security-hardening bullet reopened auth and sessions — so they got theirs.
Invitations still have none, and still do not need one.

**`access.md` is the first packet to have been written as `draft` and promoted to
`adopted`**, which is the template's own distinction being used rather than skipped.
Three of its questions — who must hold a second factor, what happens when somebody
loses both their device and their recovery codes, and whether platform support
access exists at all — changed *what* got built rather than how, so they went to the
owner instead of into a guess. All three were answered the same day and are recorded
in its §13 **with their rejected alternatives**, because a decision whose options are
lost reads a year later like something nobody considered.

It also earned its timing the way `money-boundary.md` did. Surveying `app.ts` to
answer §10 is what found the wide-open CORS and the absent login rate limit — neither
of which is in the §42 bullet the packet was written for, and the second of which is
the most severe hole in the product.

`observability-data-lifecycle.md` is the clearest case yet for writing the packet
before the code, and it did not have to look far. It was written because
`access.md` §13.3 **refused** platform support access — no impersonation, no
per-tenant operator read — on the strength of one following sentence: *"a customer
problem is diagnosed from audit rows and logs."* Surveying whether that sentence was
true is the whole of its §0, and it is not: an unhandled error is logged as a bare
stack trace with no request, no tenant and no user, and there is no correlation id
anywhere in the API. So the support model the access packet committed to does not
exist yet.

Answering §9's "what does the operator see when this fails" is what found the more
serious thing. Three deferred jobs exist and are deliberately one-shot, on the
correct reasoning that an external scheduler restarts a dead job where a
`setInterval` dies with its process — and **nothing schedules them**, in
`render.yaml` or anywhere else. Deployed, the outbox never drains, so no
notification is ever delivered, and the audit retention customers are sold is
enforced by nothing. That is the same fault `workers.cli.ts` was written to fix one
layer down; the caller got built and the thing that calls the caller did not. It is
step 1 of the build order and needs no decision from anybody, which is why the
packet says so rather than waiting to be adopted.

Its §13 is open. Four questions, and the load-bearing one is what deletion does to
an evidence row that belongs to two tenants at once: a subcontractor's time log is
also the hiring company's proof of an invoiced hour, so hard deletion is a
data-integrity attack anybody can run by asking politely, and deleting nothing
makes the promise a lie.

`money-boundary.md` is the same rule applied twice over: the money boundary
reopened **rates** and **invoices** together, so it was written before the
migration — and it earned that timing immediately. Writing §2's responsibility
table is what settled that nobody may edit a recorded rate; §3's pinning states
are what produced the row-lock-then-count concurrency rule rather than a
check-then-act; and §4's decision that a converted figure must cite its rate is
what turned "an invoice converts BILL rates" into "an invoice refuses them",
which removed a table from the migration instead of adding one.

**It is also the first packet to be substantially reversed, and it kept its
reasoning through the reversal.** Hours after the multi-currency design shipped,
the owner decided that a company works in exactly one currency and the currency is
a label. Migration 0017 undid most of 0013. The packet was rewritten rather than
patched, and it now carries a *What went, and why it is not coming back by
accident* section — because the way a withdrawn feature returns is one plausible
column at a time, added by somebody who never knew it had been removed on purpose.
The §3 pinning states and the row-lock concurrency rule survived the reversal
unchanged, which is a fair sign they were about the domain rather than about the
mechanism.
