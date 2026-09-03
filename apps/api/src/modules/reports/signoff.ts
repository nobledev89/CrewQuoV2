import type { ClientSignoffView, CreateSignoff } from '@crewquo/shared';
import { query, queryOne, withTransaction, type Queryable } from '../../db';
import { AppError } from '../../http/errors';
import { recordAudit } from '../audit/record';
import { enqueueOutboxEvent } from '../delivery/repo';
import { addFileReferences } from './repo';
import { contentHash } from './seal';

/**
 * Client sign-off (§34) — step 10.8.
 *
 * ── APPEND-ONLY, AND THERE IS NO UPDATE PATH TO WRITE ───────────────────────
 *
 * §34: *"Rows are **append-only**: a later amendment is a new row pointing at the
 * one it supersedes, and both are retained with their signatures."* So this file
 * has an insert and two reads. `0044`'s triggers refuse `UPDATE` and `DELETE`
 * outright, because "append-only enforced by the absence of a route" is enforced by
 * nothing — the route that breaks it gets added in good faith by somebody fixing a
 * typo in a signer's name, which is precisely the edit that has to produce a second
 * signature rather than a quieter first one.
 *
 * ── THE SNAPSHOT COMES FROM THE DEVICE ──────────────────────────────────────
 *
 * `reporting-signoff.md` §8, and it inverts the usual instinct on purpose. If the
 * server built `evidence_snapshot` at sync time, a signature captured at 14:02 on a
 * tablet with no signal would freeze the state at 18:40 — after that afternoon's
 * photographs were uploaded — and attest to an evidence set the signer never saw.
 *
 * So the device sends what it displayed and the server stores it verbatim. The
 * server adds only what the device cannot be trusted to assert: `signed_at` is the
 * server's clock, and `content_hash` is computed here over the canonical form.
 */

export interface SignoffRow {
  id: string;
  project_id: string;
  company_id: string;
  engagement_id: string | null;
  phase: string | null;
  signer_name: string;
  signer_company: string | null;
  signer_role: string | null;
  signer_email: string | null;
  signature_file_id: string | null;
  completion_statement: string;
  comments: string | null;
  signed_at: Date;
  content_hash: string;
  supersedes_id: string | null;
  superseded_by_id: string | null;
  supersede_reason: string | null;
  captured_by_user_id: string | null;
  captured_by_name: string | null;
  evidence_snapshot: Record<string, unknown>;
  created_at: Date;
}

/*
 * `superseded_by_id` is derived rather than stored, for the reason 0032 refused
 * the diary an amendment counter: a back-pointer beside a forward one is two
 * answers to "which is current", and they drift the first time a write half-fails.
 */
const COLUMNS = `s.id, s.project_id, s.company_id, s.engagement_id, s.phase,
  s.signer_name, s.signer_company, s.signer_role, s.signer_email, s.signature_file_id,
  s.completion_statement, s.comments, s.signed_at, s.content_hash, s.supersedes_id,
  (select n.id from client_signoffs n where n.supersedes_id = s.id order by n.signed_at limit 1)
    as superseded_by_id,
  s.supersede_reason, s.captured_by_user_id, u.name as captured_by_name,
  s.evidence_snapshot, s.created_at`;

const FROM = `from client_signoffs s left join users u on u.id = s.captured_by_user_id`;

export function toSignoffView(row: SignoffRow): ClientSignoffView {
  return {
    id: row.id,
    projectId: row.project_id,
    companyId: row.company_id,
    engagementId: row.engagement_id,
    phase: row.phase,
    signerName: row.signer_name,
    signerCompany: row.signer_company,
    signerRole: row.signer_role,
    // Present for the two parties, and never rendered into a document — the
    // snapshot builder has no field for it.
    signerEmail: row.signer_email,
    signatureFileId: row.signature_file_id,
    completionStatement: row.completion_statement,
    comments: row.comments,
    signedAt: row.signed_at.toISOString(),
    contentHash: row.content_hash,
    supersedesId: row.supersedes_id,
    supersededById: row.superseded_by_id,
    supersedeReason: row.supersede_reason,
    capturedByUserId: row.captured_by_user_id,
    capturedByName: row.captured_by_name,
    createdAt: row.created_at.toISOString(),
  };
}

export function listSignoffs(projectId: string): Promise<SignoffRow[]> {
  return query<SignoffRow>(
    `select ${COLUMNS} ${FROM} where s.project_id = $1 order by s.signed_at desc`,
    [projectId]
  );
}

export function findSignoff(id: string, runner?: Queryable): Promise<SignoffRow | null> {
  return queryOne<SignoffRow>(`select ${COLUMNS} ${FROM} where s.id = $1`, [id], runner);
}

/** The replay's own row (§8). Two captures of one act are one signature. */
function findByClientId(
  projectId: string,
  clientId: string,
  runner?: Queryable
): Promise<SignoffRow | null> {
  return queryOne<SignoffRow>(
    `select ${COLUMNS} ${FROM} where s.project_id = $1 and s.client_id = $2`,
    [projectId, clientId],
    runner
  );
}

export interface CaptureArgs {
  projectId: string;
  companyId: string;
  engagementId: string | null;
  clientCompanyId: string | null;
  actorUserId: string;
  input: CreateSignoff;
  signedIp: string | null;
  userAgent: string | null;
}

export interface CaptureResult {
  row: SignoffRow;
  /** True when the request was a replay and nothing new was written. */
  replayed: boolean;
}

export async function captureSignoff(args: CaptureArgs): Promise<CaptureResult> {
  const { input } = args;

  if (input.supersedesId && !input.supersedeReason) {
    throw new AppError('VALIDATION', 'Superseding a sign-off needs a stated reason');
  }

  if (input.clientId) {
    const replay = await findByClientId(args.projectId, input.clientId);
    if (replay) return { row: replay, replayed: true };
  }

  const result = await withTransaction(async (client) => {
    if (input.supersedesId) {
      const predecessor = await findSignoff(input.supersedesId, client);
      if (!predecessor || predecessor.project_id !== args.projectId) {
        throw new AppError('NOT_FOUND', 'The sign-off being superseded is not on this project');
      }
      /*
       * The predecessor is **not modified** — not a status, not a flag. §34 keeps
       * both rows exactly as they were signed, and 0044's trigger would refuse the
       * update anyway. Which one is current is derived from the chain.
       */
    }

    const row = await queryOne<{ id: string }>(
      `insert into client_signoffs
         (project_id, company_id, engagement_id, phase, signer_name, signer_company,
          signer_role, signer_email, signature_file_id, completion_statement, comments,
          signed_at, signed_ip, signed_user_agent, evidence_snapshot, content_hash,
          supersedes_id, supersede_reason, client_id, captured_by_user_id)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,
               now(), $12::inet, $13, $14::jsonb, $15, $16, $17, $18, $19)
       returning id`,
      [
        args.projectId,
        args.companyId,
        args.engagementId,
        input.phase ?? null,
        input.signerName,
        input.signerCompany ?? null,
        input.signerRole ?? null,
        input.signerEmail ?? null,
        input.signatureFileId ?? null,
        input.completionStatement,
        input.comments ?? null,
        // `now()` above, not a value from the caller. §34 makes this
        // anti-repudiation evidence, and a timestamp a client chooses is a
        // timestamp a client can choose; the device's own capture time is a claim
        // inside `evidence_snapshot`, where it belongs.
        args.signedIp,
        args.userAgent,
        JSON.stringify(input.evidenceSnapshot),
        contentHash(input.evidenceSnapshot),
        input.supersedesId ?? null,
        input.supersedeReason ?? null,
        input.clientId ?? null,
        args.actorUserId,
      ],
      client
    );

    /*
     * The signature image is held (decision #27). It is the one file in the product
     * whose loss makes the record it belongs to worthless, and a `jsonb` reference
     * is not a reference — so it gets a row in `report_file_references` inside the
     * same transaction that wrote the signature.
     */
    if (input.signatureFileId) {
      await addFileReferences(
        { signoffId: row!.id },
        [{ fileId: input.signatureFileId, role: 'SIGNATURE' }],
        client
      );
    }

    await enqueueOutboxEvent(
      {
        topic: input.supersedesId ? 'signoff.superseded' : 'signoff.captured',
        aggregateType: 'CLIENT_SIGNOFF',
        aggregateId: row!.id,
        companyId: args.companyId,
        payload: {
          signoffId: row!.id,
          supersedesId: input.supersedesId ?? null,
          projectId: args.projectId,
          companyId: args.companyId,
          clientCompanyId: args.clientCompanyId,
          phase: input.phase ?? null,
          signerName: input.signerName,
          reason: input.supersedeReason ?? null,
        },
        idempotencyKey: `signoff:${row!.id}`,
      },
      client
    );

    return (await findSignoff(row!.id, client))!;
  });

  await recordAudit({
    companyId: args.companyId,
    actorUserId: args.actorUserId,
    action: input.supersedesId ? 'signoff.superseded' : 'signoff.captured',
    entityType: 'CLIENT_SIGNOFF',
    entityId: result.id,
    changes: {
      phase: input.phase ?? null,
      contentHash: result.content_hash,
      supersedes: input.supersedesId ?? null,
      reason: input.supersedeReason ?? null,
    },
    description: `Client sign-off captured from ${input.signerName}`,
    /*
     * **Client-visible, and it is the one row in this phase that is.** The client
     * is a party to it — they signed it — and a trail that recorded somebody's own
     * signature as invisible to them would be the wrong way round.
     */
    visibleToClient: true,
  });

  return { row: result, replayed: false };
}

/** The current sign-off for a project or phase: the row nothing supersedes (§3). */
export function currentSignoffs(projectId: string): Promise<SignoffRow[]> {
  return query<SignoffRow>(
    `select ${COLUMNS} ${FROM}
      where s.project_id = $1
        and not exists (select 1 from client_signoffs n where n.supersedes_id = s.id)
      order by s.signed_at desc`,
    [projectId]
  );
}

/**
 * Is this file a signature on a sign-off this company can see?
 *
 * Registered in the storage access registry so the contractor and the client can
 * each render the signature they are a party to.
 */
export async function signoffGrantsFileAccess(
  fileId: string,
  companyId: string
): Promise<boolean> {
  const row = await queryOne<{ ok: boolean }>(
    `select true as ok
       from stored_files f
       join client_signoffs s
         on s.signature_file_id = coalesce(f.derivative_of, f.id)
       join projects p on p.id = s.project_id
      where f.id = $1 and (s.company_id = $2 or p.client_company_id = $2)
      limit 1`,
    [fileId, companyId]
  );
  return row !== null;
}
