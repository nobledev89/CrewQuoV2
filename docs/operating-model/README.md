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
| Commercial agreements — PAY rate proposals, engagement terms, acceptance | [commercial-agreements.md](./commercial-agreements.md) | Phase 6 |
| Company ownership & creation — the first-company allowance, additional-company approval, duplicate routing, trial eligibility | [company-creation.md](./company-creation.md) | Phase 6 |
| Durable delivery — transactional events/jobs, inbound webhooks, retry, dead letters and replay | [durable-delivery.md](./durable-delivery.md) | Phase 6 |
| Money boundary — currency identity, project reporting currency, FX snapshots and the tax-compliance gate | [money-boundary.md](./money-boundary.md) | Phase 6 |
| Notifications & the Action Centre — the durable per-recipient projection, channels, quiet hours, delivery evidence | [notifications.md](./notifications.md) | Phase 6 |
| Time & time zones — company/project IANA zones, instant-vs-date, DST, date-bound rules | [time.md](./time.md) | Phase 6 |

Earlier domains (identity, rates, the delivery loop, portal/audit, invoices) were
built before the §19.5 decision was adopted on 2026-08-18 and have no packet. They
are not retro-fitted on principle: a packet is worth writing when it can still
change the design. Where one of those domains is next reopened, its packet gets
written then — which is exactly what `company-creation.md` is. It covers the part
of identity §3.1.1 reopens (who may create a tenant) and nothing else; auth,
sessions and invitations keep no packet until something reopens them.

`money-boundary.md` is the same rule applied twice over: the money boundary
reopened **rates** and **invoices** together, so it was written before the
migration — and it earned that timing immediately. Writing §2's responsibility
table is what settled that nobody may edit a recorded rate; §3's pinning states
are what produced the row-lock-then-count concurrency rule rather than a
check-then-act; and §4's decision that a converted figure must cite its rate is
what turned "an invoice converts BILL rates" into "an invoice refuses them",
which removed a table from the migration instead of adding one.
