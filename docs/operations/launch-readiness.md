# Production launch readiness

`pnpm --filter @crewquo/api launch-check` is the read-only release gate. Run it
from the built deployment with the same environment and database that will serve
customers. It prints every result and exits `0` only when nothing is blocked and
all manual evidence is present.

The API and web app deploy separately. Run the command from a controlled shell
with the API deployment variables and the `NEXT_PUBLIC_*` values used to build
the exact Vercel release being checked. Those browser values are public by
design, but the Paddle lifecycle and Sentry receipts below are still required:
copying a setting does not prove the deployed browser received it.

The gate reads configuration as booleans only; it never prints a credential. It
also reads the production database without changing it. It checks:

- production runtime, a public HTTPS application URL and a non-local database;
- every checked-in migration against `schema_migrations`;
- independent access/refresh/pepper values and the documented reverse-proxy
  trust boundary;
- Resend with a non-shared production sender, and API/browser Sentry
  configuration including release names;
- scheduled-job recency and terminal outbox, webhook and notification failures;
- Paddle server, webhook and browser configuration with matching production
  environments;
- every active public paid price having a provider price id; and
- the operator checkout switch actually being on.

## Record the facts code cannot observe

Copy `docs/operations/launch-evidence.example.json` to an operations-controlled
location and replace every placeholder. Then run:

```bash
pnpm --filter @crewquo/api launch-check -- --evidence /path/to/launch-evidence.json
```

Each entry requires an ISO 8601 completion timestamp and a non-empty reference.
A reference can be a controlled document id, ticket, receipt or public URL; do
not put credentials, personal data or Paddle secrets in this file. The gate
rejects unknown keys so a misspelling cannot silently create evidence for a check
that was never evaluated.

The eight manual claims are intentionally narrow:

1. the production terms/privacy particulars received legal approval;
2. a real non-owner address received mail from the verified production domain;
3. the hosted Sentry project received scrubbed API and browser events;
4. Paddle approved the seller and payout setup;
5. purchase, renewal, failed payment, cancellation, refund and replay were
   rehearsed through Paddle;
6. a provider backup was restored and its RPO/RTO measured;
7. a public status channel exists outside the application failure domain; and
8. one real company completed one real project end to end.

An evidence entry is an attestation, not the underlying record. Keep the record
where its access and retention belong, and make the reference durable enough for
the next operator to retrieve it.

## How to use the result

`BLOCK` means the deployment or database contradicts a launch requirement.
`MANUAL` means the repository has no evidence file, or that file lacks the named
attestation. Do not suppress either result in CI. Fix the condition or add real
evidence, rerun the command, and retain the final output with the release record.

This gate complements the incident and recovery procedure in
`docs/operations/recovery-and-incidents.md`; it does not replace the hosted
restore rehearsal described there.
