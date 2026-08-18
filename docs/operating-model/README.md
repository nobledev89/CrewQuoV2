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

Earlier domains (identity, rates, the delivery loop, portal/audit, invoices) were
built before the §19.5 decision was adopted on 2026-08-18 and have no packet. They
are not retro-fitted on principle: a packet is worth writing when it can still
change the design. Where one of those domains is next reopened, its packet gets
written then — which is exactly what `company-creation.md` is. It covers the part
of identity §3.1.1 reopens (who may create a tenant) and nothing else; auth,
sessions and invitations keep no packet until something reopens them.
