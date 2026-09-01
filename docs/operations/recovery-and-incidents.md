# Recovery and incident runbook

Status: **pre-production rehearsal runbook**  
Owner: CrewQuo platform operator  
Review cadence: before launch, after every recovery event, and quarterly once live

This runbook implements the operational half of
`docs/operating-model/observability-data-lifecycle.md` §13.4 and §14.4. It does
not claim the production recovery promise has been proved. CrewQuo currently
keeps customer-shaped data in the local Docker stack by owner decision; the paid
hosted database and its point-in-time recovery are deliberately not provisioned.

## Recovery promise and acceptance gate

The adopted direction is a paid Postgres tier with point-in-time recovery, an
RPO measured in minutes, an RTO stated in hours, one restore rehearsal before
launch, and one each quarter afterwards. Exact published numbers remain unset
until the hosted rehearsal measures them.

The production gate closes only when an operator restores a backup that was not
created for the test into an isolated hosted scratch database, verifies it, and
records:

- incident/rehearsal identifier and operator;
- requested recovery timestamp and newest recovered transaction timestamp;
- start, database-ready, verification-complete and cleanup times;
- measured recovery point gap and total recovery time;
- backup/snapshot identifier, region and Postgres version;
- migration ledger head, table inventory and verification result;
- every deviation, failed command and follow-up owner.

A successful local rehearsal proves the procedure and the database are
restorable. It does **not** prove the host's backup exists, its retention, the
hosted network path, or the production RPO/RTO.

## Local rehearsal

Prerequisites: the repository Docker Postgres service is healthy, `.env` points
to loopback, migrations are current, and Docker is on `PATH`.

```sh
pnpm --filter @crewquo/api rehearse-restore
```

The command has three hard safety boundaries:

1. it refuses every non-loopback `DATABASE_URL`;
2. it restores only into a fresh database named
   `crewquo_restore_rehearsal_<timestamp>_<nonce>`;
3. cleanup refuses any database name outside that exact pattern.

It creates a custom-format logical backup under the ignored `.tmp` directory,
restores it, compares every public table and row count with the source, prints a
SHA-256 receipt and elapsed time, then removes the scratch database and backup.
It never writes to the source database.

### Rehearsal record

| Date (UTC) | Scope | Result | Elapsed | Backup | Verification | Cleanup |
|---|---|---:|---:|---:|---|---|
| 2026-09-01 | Local Docker Postgres 16 | PASS | 4.490 s | 7,925,474 bytes; SHA-256 `d6e219e7dd5adbd43c94820d88f0a4fd42a666f8a7f96ad01043d4b4adb5d29f` | 51/51 public tables and row counts matched | scratch database and local dump removed |

This record proves the current local logical backup can be restored. It sets no
production RPO or RTO and does not close the hosted acceptance gate above.

## Hosted restore rehearsal

1. Open an incident/rehearsal record and announce the exercise window. Keep the
   production application online; this is a restore into scratch, not a failover.
2. In the database host, select a recovery point from an existing backup/PITR
   window that was not created for the exercise.
3. Restore to a new isolated service. Never choose the production database as the
   destination and never repoint application secrets during a rehearsal.
4. Restrict scratch ingress to the operator, record its generated identity, and
   wait for the host to report ready.
5. Connect with read-only verification credentials. Check Postgres version,
   `schema_migrations`, public table inventory, critical aggregate counts, and a
   representative project/invoice/export chain. Do not copy row contents into the
   incident record.
6. Record the recovery-point gap and elapsed times against the proposed RPO/RTO.
   A miss is a failed rehearsal, not a reason to widen the promise silently.
7. Destroy the scratch service only after a second operator confirms the recorded
   target is the scratch identity. Retain the evidence record, not the restored
   customer data.
8. Resolve every follow-up before enabling checkout or onboarding a real company.

## Incident control loop

For any incident: declare one incident owner, capture the first request/job id,
classify severity, stop compounding writes when integrity is uncertain, post a
plain-language update, preserve logs/audit evidence, and keep a timestamped
decision log. Never paste customer records, tokens, raw webhook bodies, database
URLs or provider credentials into the incident record.

### Database unavailable or corrupt

Put the product into maintenance before attempting recovery. Distinguish
connectivity from integrity using `/healthz`, host state and correlated API logs.
If integrity is uncertain, stop workers and writes. Choose the recovery point,
restore to scratch, verify, then execute a separately reviewed cutover. Do not run
migrations as a diagnostic action and never restore over production in place.

### API unavailable

Check deployment health, boot-time environment validation and database reachability.
Roll back only the application artifact when the database schema remains compatible.
A schema rollback requires its own forward repair; migrations are forward-only.

### Scheduled work overdue

Treat the Platform Operations alarm as real. Run `work`, `run-closures`,
`purge-audit` and `purge-auth` once by hand, inspect their `job_runs`, then repair
the scheduler. Do not hide the alarm or reset timestamps. Before resuming, inspect
dead letters and closure notices so a backlog is not mistaken for a quiet queue.

### Email or payment provider failure

Leave durable rows queued. For email, verify sender-domain state and classify the
provider response before replay. For Paddle, disable checkout first, preserve the
signed webhook inbox, and reconcile subscription ordering before replay. Never
derive entitlement from a browser callback or edit a subscription row by hand.

### Suspected credential or tenant-boundary breach

Revoke affected sessions and rotate signing keys with the documented overlap.
Preserve platform audit and correlation evidence. Do not use customer impersonation
or direct tenant browsing—both are forbidden by the access operating model. Notify
affected parties and regulators according to the final legal/incident policy.

## Communications

The status page must be hosted independently of the API and database it reports;
an in-product status route disappearing with the incident is not a status page.
Its provider, public URL, subscriber workflow and message owner remain launch
configuration. Until selected, incident communications are an explicit open gate,
not something this repository claims to provide.
