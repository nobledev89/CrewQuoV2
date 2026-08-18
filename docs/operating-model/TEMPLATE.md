# Operating-model packet — <domain>

> Copy this file, answer every heading, delete none. Plan reference: §19.5.
> Status: `draft` while the design is still moving · `adopted` once the phase builds against it.

**Domain:** <what set of records and workflows this covers>
**Phase:** <n> · **Status:** draft · **Last updated:** <YYYY-MM-DD>

## 1. Persona / job

Who is trying to complete which real-world job, on which device and connectivity
level? Name the personas; do not describe roles in the abstract.

## 2. Resource responsibility

One row per resource. Creator · owner · reader · reviewer · publisher · corrector
· exporter · retention owner. "Nobody" is a valid and important answer.

## 3. State machine

States, the allowed actor per transition, the rejection/withdraw/reopen path,
terminal states, and the concurrency rule for two actors racing the same
transition.

## 4. Permission + scope matrix

Four independent checks, per operation: **feature entitlement** · **user
capability/role** · **company edge** · **project/resource assignment**. A row that
only fills in one column is a hole.

## 5. Domain events

Event name · transactional payload · idempotency key · consumers · replay
behaviour.

## 6. Notification matrix

Recipient · channel · urgency · digest/quiet-hours rule · escalation · the durable
Action Centre item. Email and push are never the only copy of a task.

## 7. Data classification + retention

Personal / commercial / evidence / reference · default visibility · lifecycle ·
legal hold · deletion and export behaviour.

## 8. Offline / conflict policy

Client id · expected version · merge-or-refuse rule · tombstones · what the user
sees when their change is refused.

## 9. Failure matrix

Retryable vs terminal · partial-success behaviour · the operator's repair path ·
what the user sees.

## 10. Security / threat model

Tenant boundary · forged identifiers · abuse of any upload or webhook surface ·
privileged and support access · secret rotation.

## 11. Analytics contract

Activation event · outcome event · funnel · quality metric · the payload fields
explicitly excluded as sensitive.

## 12. Acceptance script

A named persona completing the job end to end, including the **empty**, **denied**,
**rejected**, **offline/retry** and **correction** paths. This is the script the
phase's e2e verification implements.
