-- Client sign-off and the artifact hold (CREWQUO_V2_PLAN.md §34, decision #27) —
-- step 3 of the Phase 10 build order in docs/operating-model/reporting-signoff.md
-- §14.
--
-- Two tables and one column, and the second table is the one Phase 7 refused to
-- build.
--
-- ── `client_signoffs`: A RECORD WITH NO LIFECYCLE ────────────────────────────
--
-- Every other record in this product has states. A sign-off has none, and the
-- absence is the design (packet §3). It is created, and from that instant it is a
-- fact. §34's supersession is not a transition: it is a NEW ROW pointing at the
-- one it supersedes, and the old row is not modified — not its status, not a flag,
-- nothing. Both are retained with their signatures, which §34 calls "the
-- immutable-evidence-plus-audit-history requirement".
--
-- So there is no `status` column and no `is_current` boolean. The current sign-off
-- is the row nothing supersedes: a query, not a column, for the same reason 0032
-- refused the diary an amendment counter — a flag beside a supersession chain is
-- two answers to one question, and they drift.
--
-- UPDATE AND DELETE ARE REFUSED BY A TRIGGER, not merely unimplemented in the API.
-- "Append-only" enforced by the absence of a route is enforced by nothing: the
-- route that breaks it will be added in good faith by somebody fixing a typo in a
-- signer's name, which is precisely the edit that must produce a second signature
-- rather than a quieter first one.
--
-- ── `report_file_references`: THE HOLD, AND IT HAS A CALLER (finding 6) ──────
--
-- §34's `evidence_snapshot` freezes "the evidence set as it stood at that moment".
-- §29.4's `snapshot` does the same for a report's photographs. Both are jsonb, and
-- a stored_files row referenced only from inside a jsonb document is invisible to
-- Postgres: `stored_files.project_id … on delete cascade` removes it, and the
-- artifact-class retention sweep Phase 7 designed and did not build would remove
-- it on a schedule. Decision #27 says it must not. Nothing enforced that, and
-- nothing could, because the reference was not a reference.
--
-- PROGRESS records why Phase 7 declined to build the hold: "a mechanism with no
-- caller". It has two on the day it lands.
--
--   * It is the RETENTION HOLD — `on delete restrict` from `file_id`, so a cited
--     file cannot be reclaimed by a sweep that has not been written yet.
--   * It is the DISCLOSURE GRANT, which is a caller today. FILE_CLIENT_DISCLOSURES
--     currently knows published evidence and published documents, so a photograph
--     inside a signed completion report that was never individually published to
--     the client returns 403 to the very client holding the signed document. The
--     file becomes readable BECAUSE A DOCUMENT THEY WERE GIVEN CITES IT, which is
--     a narrower grant than publishing the photograph generally, and it expires
--     with nothing, because the document does not expire.

create table if not exists client_signoffs (
  id uuid primary key default gen_random_uuid(),

  -- `restrict` for the same reason generated_reports carries it: §34 says both
  -- rows are retained with their signatures, and DELETE /v1/projects/:id would
  -- otherwise erase a client's signature with no confirmation step.
  project_id uuid not null references projects(id) on delete restrict,

  -- The contractor capturing it (§34).
  company_id uuid not null references companies(id),
  engagement_id uuid references engagements(id),

  -- Null = the whole project (§34). A phase is free text because a phase is
  -- whatever the contract calls it, and a catalog of phases is Phase 11's
  -- variations problem rather than this one.
  phase text,

  -- ── The signer, who is not a user of this system ──────────────────────────
  --
  -- These are the only actor columns in the schema that describe somebody outside
  -- the tenancy model. Dana is a person standing next to a supervisor holding a
  -- tablet; she has no membership, frequently no login, and the row is EVIDENCE
  -- about her rather than IDENTITY for her. That is why they are text and not a
  -- foreign key, and why §7 of the packet classifies them as personal data that
  -- survives an erasure request with the contact detail cleared.
  signer_name text not null check (length(btrim(signer_name)) > 0),
  signer_company text,
  signer_role text,
  signer_email text,

  -- `restrict`: a signature is the one file in the product whose loss makes the
  -- record it belongs to worthless.
  signature_file_id uuid references stored_files(id) on delete restrict,

  completion_statement text not null check (length(btrim(completion_statement)) > 0),
  comments text,

  -- THE SERVER'S CLOCK, NOT THE DEVICE'S. §34 makes this `not null` and says
  -- nothing about whose clock; a timestamp a client chooses is a timestamp a
  -- client can choose, and this one is anti-repudiation evidence. What the device
  -- captured is inside `evidence_snapshot`, where it is a claim rather than a
  -- record.
  signed_at timestamptz not null default now(),

  -- Anti-repudiation, captured and NEVER RENDERED (packet §7). Putting a person's
  -- network location into a document that gets emailed publishes it for no
  -- benefit; the snapshot builder cannot reach these because they are not on the
  -- type it consumes.
  signed_ip inet,
  signed_user_agent text,

  -- ── What was signed for, built ON THE DEVICE ──────────────────────────────
  --
  -- Packet §8, and it inverts the usual instinct deliberately. If the server
  -- assembled this at sync time, a signature captured at 14:02 on a tablet with no
  -- signal would freeze the state at 18:40 — after that afternoon's photographs
  -- were uploaded — and attest to an evidence set the signer never saw. So the
  -- device sends what it displayed and the server stores it verbatim.
  evidence_snapshot jsonb not null,

  -- sha256 of canonicalJson(evidence_snapshot), computed SERVER-SIDE. The one
  -- thing the device is not trusted to assert about its own submission.
  content_hash text not null check (content_hash ~ '^[0-9a-f]{64}$'),

  supersedes_id uuid references client_signoffs(id) on delete restrict,
  -- Required when superseding: "why was this signed again" is the only question
  -- anybody asks a supersession chain.
  supersede_reason text,

  -- The offline contract's idempotency key (§8, 0029). Without it, Ade's tablet
  -- retrying in a stairwell captures two signatures for one act.
  client_id uuid,

  -- Nullable for the reason 0030, 0034 and 0040 each are: the closure promise
  -- anonymises rather than deletes, and a preserved record should not depend on
  -- that staying true.
  captured_by_user_id uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),

  constraint client_signoffs_supersede_reason
    check ((supersedes_id is null) = (supersede_reason is null)),
  constraint client_signoffs_not_own_predecessor
    check (supersedes_id is null or supersedes_id <> id)
);

comment on table client_signoffs is
  'Client sign-off (§34). APPEND-ONLY: no status, no edit, no delete — a later amendment is a new row pointing at the one it supersedes, and both are retained with their signatures. The current sign-off is the row nothing supersedes.';
comment on column client_signoffs.evidence_snapshot is
  'Built on the DEVICE and stored verbatim (reporting-signoff.md §8). A server-built snapshot would attest to an evidence set the signer never saw.';
comment on column client_signoffs.signed_at is
  'The server''s clock. The device''s own capture time is a claim inside evidence_snapshot.';
comment on column client_signoffs.signed_ip is
  'Anti-repudiation evidence. Never rendered into a document — see reporting-signoff.md §7.';

create index if not exists client_signoffs_project_idx
  on client_signoffs (project_id, signed_at desc);
create index if not exists client_signoffs_company_idx
  on client_signoffs (company_id, signed_at desc);
create index if not exists client_signoffs_supersedes_idx
  on client_signoffs (supersedes_id) where supersedes_id is not null;
-- A replayed capture must find its own row rather than mint a second signature.
create unique index if not exists client_signoffs_client_id_idx
  on client_signoffs (project_id, client_id) where client_id is not null;

-- Append-only, at the database.
--
-- Two triggers rather than one because the messages differ, and the message IS
-- the mechanism here: somebody hits this while trying to correct a misspelled
-- signer name, and the useful answer names the thing they should do instead.
create or replace function client_signoffs_are_append_only() returns trigger as $$
begin
  if tg_op = 'UPDATE' then
    raise exception 'a client sign-off cannot be edited; capture a new one superseding it (§34)'
      using errcode = 'check_violation';
  end if;
  raise exception 'a client sign-off cannot be deleted; both a sign-off and the one it supersedes are retained (§34)'
    using errcode = 'check_violation';
end;
$$ language plpgsql;

drop trigger if exists client_signoffs_no_update on client_signoffs;
create trigger client_signoffs_no_update
  before update on client_signoffs
  for each row execute function client_signoffs_are_append_only();

drop trigger if exists client_signoffs_no_delete on client_signoffs;
create trigger client_signoffs_no_delete
  before delete on client_signoffs
  for each row execute function client_signoffs_are_append_only();

-- ── The hold ─────────────────────────────────────────────────────────────────

create table if not exists report_file_references (
  id uuid primary key default gen_random_uuid(),

  -- THE HOLD ITSELF. Nothing may reclaim a file a frozen document points at.
  file_id uuid not null references stored_files(id) on delete restrict,

  report_id uuid references generated_reports(id) on delete cascade,
  signoff_id uuid references client_signoffs(id) on delete restrict,

  -- What the file is doing in the document. `RENDERED` is the PDF itself, which
  -- is held for the same reason as everything else it contains.
  role text not null check (role in ('EVIDENCE','DOCUMENT','SIGNATURE','LOGO','RENDERED')),

  created_at timestamptz not null default now(),

  -- Exactly one owner. A reference belonging to both would be held by two
  -- lifetimes and released by neither.
  constraint report_file_references_one_owner
    check ((report_id is null) <> (signoff_id is null))
);

comment on table report_file_references is
  'Which files a frozen report or sign-off points at (decision #27). Two callers: it is the retention hold that a future artifact-class sweep must consult, and it is the disclosure grant that lets a client open a photograph inside a document they were given without that photograph being published to them generally.';
comment on column report_file_references.report_id is
  'on delete CASCADE: a report row cannot be deleted while its project stands, and if a company is ever purged wholesale the references go with the reports rather than blocking the purge.';
comment on column report_file_references.signoff_id is
  'on delete RESTRICT, because a sign-off itself cannot be deleted — this is defence in depth, not a second policy.';

-- Two partial unique indexes rather than one over both columns: Postgres treats
-- NULLs as distinct in a unique constraint, so `unique (report_id, signoff_id,
-- file_id)` would permit the same file twice on the same report.
create unique index if not exists report_file_references_report_idx
  on report_file_references (report_id, file_id) where report_id is not null;
create unique index if not exists report_file_references_signoff_idx
  on report_file_references (signoff_id, file_id) where signoff_id is not null;
-- The download authorization asks "which documents cite this file?" on every
-- signed-URL request, so the file side is the hot one.
create index if not exists report_file_references_file_idx
  on report_file_references (file_id);

-- ── Branding (decision #30) ──────────────────────────────────────────────────
--
-- "A client company supplies its default logo/brand details; a project may
-- override them for a specific report. Generated reports freeze the resolved
-- branding in their reproducible snapshot."
--
-- The default is the CLIENT COMPANY'S OWN `sustainability_settings.report_logo_file_id`
-- — the same asset it would put on its own reports, because a company has one
-- logo. This column is the override, and it is where a placeholder client's logo
-- has to live: a placeholder has no members, so nobody can set its settings row,
-- and the contractor is the only party in a position to supply the asset.
--
-- `on delete set null` rather than restrict: a project's branding is a
-- presentation choice, and losing it degrades the next report rather than
-- falsifying a frozen one — every generated report has already frozen the file id
-- it resolved, and holds it through report_file_references.
alter table projects add column if not exists client_logo_file_id uuid
  references stored_files(id) on delete set null;

comment on column projects.client_logo_file_id is
  'Per-project override of the client''s report logo (decision #30). The default is the client company''s own sustainability_settings.report_logo_file_id; this is what a placeholder client — which has no members to set one — uses instead.';
