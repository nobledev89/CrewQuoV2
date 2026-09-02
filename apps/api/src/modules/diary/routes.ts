import { Router } from 'express';
import {
  DIARY_NARRATIVE_FIELDS,
  closeDayPrompts,
  closeDiaryEntrySchema,
  createDiaryAttendanceSchema,
  createDiaryEntrySchema,
  describeAmendments,
  describeCloseRace,
  diaryAmendedEventPayload,
  diaryClosedEventPayload,
  diaryFilterSchema,
  mergeDiaryEdit,
  narrativeFieldsFilled,
  refuseDiaryEdit,
  refuseDiaryTimes,
  refuseFutureEntryDate,
  suggestAttendance,
  updateDiaryAttendanceSchema,
  updateDiaryEntrySchema,
  type DiaryEntryView,
  type DiaryNarrativeField,
  type DiaryPrefillResponse,
} from '@crewquo/shared';
import { asyncHandler } from '../../http/asyncHandler';
import { getCompanyCtx, type Ctx } from '../../http/context';
import { AppError } from '../../http/errors';
import { uuidParam } from '../../http/params';
import { withIdempotency } from '../../http/idempotency';
import { query, queryOne, withTransaction, type Queryable } from '../../db';
import { assertCapability } from '../capabilities/guards';
import { hasFeature } from '../entitlements/guards';
import { enqueueOutboxEvent } from '../delivery/repo';
import { recordAudit } from '../audit/record';
import { listRevisions, recordRevision } from '../revisions/record';
import {
  DIARY_REVISION_ENTITY,
  closeDiaryEntry,
  countDraftTimeLogs,
  deleteAttendance,
  existingTimeLogIds,
  findAttendance,
  findDiaryEntry,
  findDiaryEntryForDay,
  findPrefillTimeLogs,
  insertAttendance,
  insertDiaryEntry,
  listDiaryEntries,
  loadDiaryChildren,
  narrativeOf,
  projectClock,
  replaceDiaryDocuments,
  replaceDiaryLocations,
  toDiaryEntryView,
  touchDiaryEntry,
  updateAttendance,
  updateDiaryEntry,
  viewOf,
  type DiaryEntryRow,
  type DiaryScope,
} from './repo';

/**
 * The site diary (§23) — step 6 of the Phase 7 build order, and the last record
 * in the phase.
 *
 * Three rules shape every route below, and all three come from what a diary is
 * for — somebody reads it in a dispute, months later, and has to be able to trust
 * it:
 *
 *  - **There is no reopen and there is no delete.** A day is closed once, and a
 *    change after that is an amendment with a reason, recorded in
 *    `record_revisions` and counted on the entry wherever it appears.
 *  - **Two companies on one site keep two diaries.** The project owner reads both;
 *    a provider reads only its own, and writes only its own.
 *  - **Closing races honestly.** `where status = 'OPEN'` decides, and the loser is
 *    told who won and when — because its recovery is an amendment, not a retry.
 */

interface ProjectAccess {
  projectId: string;
  ownerCompanyId: string;
  isOwner: boolean;
}

async function projectAccess(projectId: string, companyId: string): Promise<ProjectAccess> {
  const row = await queryOne<{ owner_company_id: string; assigned: boolean }>(
    `select p.owner_company_id,
            exists (
              select 1 from project_assignments a
               where a.project_id = p.id and a.provider_company_id = $2
            ) as assigned
       from projects p where p.id = $1`,
    [projectId, companyId]
  );
  if (!row) throw new AppError('NOT_FOUND', 'Project not found');
  const isOwner = row.owner_company_id === companyId;
  if (!isOwner && !row.assigned) throw new AppError('NOT_FOUND', 'Project not found');
  return { projectId, ownerCompanyId: row.owner_company_id, isOwner };
}

/**
 * `site_diary` on the **project owner** to write, and on the **reader** to read
 * somebody else's.
 *
 * The first half is decision #2 unchanged: capture is free and the record is the
 * project owner's entitlement, so a Crew-plan subcontractor keeps a diary on a
 * hiring company's job and consumes that owner's key doing it. A subcontractor
 * who cannot write up the day cannot do the paperwork the hiring company is
 * paying for.
 *
 * The second half is the packet's §4 row that differs from every other in this
 * phase — *"read a counterparty's diary: `site_diary` on the reader"*. Being
 * shown a narrative record you did not author is a feature of your own plan, not
 * of the plan belonging to whoever wrote it. Reading **your own** diary is not
 * gated a second time: you already paid for it once, through the owner, at the
 * moment you were allowed to write it.
 */
async function assertDiaryFeature(access: ProjectAccess): Promise<void> {
  if (!(await hasFeature(access.ownerCompanyId, 'site_diary'))) {
    throw new AppError(
      'FORBIDDEN',
      access.isOwner
        ? 'Your plan does not include: site_diary'
        : 'This project’s owner does not have the site diary enabled',
      { feature: 'site_diary' }
    );
  }
}

async function assertCounterpartyRead(
  readerCompanyId: string,
  authorCompanyId: string
): Promise<void> {
  if (readerCompanyId === authorCompanyId) return;
  if (!(await hasFeature(readerCompanyId, 'site_diary'))) {
    throw new AppError(
      'FORBIDDEN',
      'Your plan does not include reading other companies’ site diaries: site_diary',
      { feature: 'site_diary' }
    );
  }
}

function scopeFor(access: ProjectAccess, companyId: string): DiaryScope {
  return access.isOwner ? { kind: 'OWNER' } : { kind: 'AUTHOR', companyId };
}

/**
 * A diary entry belongs to the company that wrote it, and only that company may
 * change it.
 *
 * **The project owner is not an exception here, and it is the one place in this
 * phase where they are not.** Priya may re-tag a subcontractor's photograph
 * (`evidence.manage`) and may share their document with the client, because those
 * are filing and disclosure decisions on her own project. A diary entry is a
 * *statement by a person about what they saw*. Editing somebody else's statement
 * and leaving it attributed to them is the one thing an evidence trail must never
 * permit, whatever it does about the paperwork around it.
 */
function assertAuthoring(row: DiaryEntryRow, companyId: string): void {
  if (row.company_id !== companyId) {
    throw new AppError(
      'FORBIDDEN',
      'This day was written by another company. Their diary is theirs to correct.'
    );
  }
}

/** Loads an entry the caller may see, or answers as if it does not exist. */
async function readableEntry(
  id: string,
  companyId: string
): Promise<{ row: DiaryEntryRow; access: ProjectAccess }> {
  const row = await findDiaryEntry(id);
  if (!row) throw new AppError('NOT_FOUND', 'Diary entry not found');
  const access = await projectAccess(row.project_id, companyId);
  await assertDiaryFeature(access);
  // A provider sees only its own diary; the owner sees every company's (§2).
  if (!access.isOwner && row.company_id !== companyId) {
    throw new AppError('NOT_FOUND', 'Diary entry not found');
  }
  await assertCounterpartyRead(companyId, row.company_id);
  return { row, access };
}

async function assertLocations(projectId: string, ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  const rows = await query<{ id: string }>(
    `select id from project_locations
      where project_id = $1 and id = any($2::uuid[]) and deleted_at is null`,
    [projectId, [...new Set(ids)]]
  );
  if (rows.length !== new Set(ids).size) {
    throw new AppError('VALIDATION', 'One of those locations is not on this project');
  }
}

/**
 * The documents a day may cite.
 *
 * Scoped by the same rule `documents/repo.ts` reads with — project-wide, your
 * own, or filed against you — rather than by project alone. Citing a document in
 * a diary entry the hiring company will read is a way to *show* it, and a scope
 * check that stopped at the project would make the diary a way around the
 * document scope: file a rival's insurance certificate into your Tuesday and it
 * becomes readable from there.
 */
async function assertDocuments(
  projectId: string,
  companyId: string,
  isOwner: boolean,
  ids: readonly string[]
): Promise<void> {
  if (ids.length === 0) return;
  const unique = [...new Set(ids)];
  const scope = isOwner
    ? ''
    : ` and (d.provider_company_id is null or d.provider_company_id = $3 or d.company_id = $3)`;
  const params: unknown[] = [projectId, unique];
  if (!isOwner) params.push(companyId);
  const rows = await query<{ id: string }>(
    `select d.id from project_documents d
      where d.project_id = $1 and d.id = any($2::uuid[]) and d.deleted_at is null${scope}`,
    params
  );
  if (rows.length !== unique.length) {
    throw new AppError('VALIDATION', 'One of those documents is not available on this project');
  }
}

/**
 * A crew line naming a company has to name one that is actually on this job.
 *
 * `provider_company_id` is a foreign key to `companies`, so any real id passes the
 * database — and §23 does not say more than that. But a diary entry is read by the
 * hiring company, so "Redstone Scaffolding were on site" is an assertion about a
 * named business, in a record that business cannot see and cannot contest. Bounded
 * to the project's own companies: the authoring company itself, the project owner,
 * and anybody assigned to it.
 *
 * **A genuine off-platform sub is unaffected**, which is what makes this cheap.
 * They have no `companies` row to name, so they are recorded by `name` as free
 * text — the column that exists for exactly that case.
 */
async function assertAttendanceCompany(
  row: DiaryEntryRow,
  providerCompanyId: string | null
): Promise<void> {
  if (providerCompanyId === null) return;
  if (providerCompanyId === row.company_id || providerCompanyId === row.owner_company_id) return;
  const assigned = await queryOne<{ ok: boolean }>(
    `select true as ok from project_assignments
      where project_id = $1 and provider_company_id = $2 limit 1`,
    [row.project_id, providerCompanyId]
  );
  if (!assigned) {
    throw new AppError(
      'VALIDATION',
      'That company is not on this project. Record an off-site crew by name instead.'
    );
  }
}

/** The supervisor named on a day has to be a member of the company writing it. */
async function assertSupervisor(companyId: string, userId: string | null): Promise<void> {
  if (userId === null) return;
  const row = await queryOne<{ ok: boolean }>(
    `select true as ok from memberships where company_id = $1 and user_id = $2 limit 1`,
    [companyId, userId]
  );
  if (!row) throw new AppError('VALIDATION', 'That person is not a member of this company');
}

/** The facts Close Day's prompts are computed from, for one entry. */
async function closePromptFacts(
  view: DiaryEntryView,
  row: DiaryEntryRow,
  runner?: Queryable
): Promise<ReturnType<typeof closeDayPrompts>> {
  const drafts = await countDraftTimeLogs(
    { projectId: row.project_id, companyId: row.company_id, entryDate: row.entry_date },
    runner
  );
  return closeDayPrompts({
    attendanceRows: view.attendance.length,
    narrativeFieldsFilled: narrativeFieldsFilled(view),
    evidenceCount: view.evidenceCount,
    unsubmittedTimeLogs: drafts,
    startTime: view.startTime,
    finishTime: view.finishTime,
  });
}

// ── Mounted under /v1/projects ───────────────────────────────────────────────

export const projectDiaryRouter = Router();

projectDiaryRouter.get(
  '/:projectId/diary',
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    const access = await projectAccess(uuidParam(req, 'projectId'), ctx.companyId);
    await assertDiaryFeature(access);
    await assertCapability(ctx, 'project.read');

    const raw = req.query as Record<string, unknown>;
    const filter = diaryFilterSchema.parse({
      from: raw.from,
      to: raw.to,
      companyId: raw.companyId,
      status: raw.status,
      limit: raw.limit === undefined ? undefined : Number(raw.limit),
      offset: raw.offset === undefined ? undefined : Number(raw.offset),
    });
    if (filter.from && filter.to && filter.from > filter.to) {
      throw new AppError('VALIDATION', 'That date range starts after it ends');
    }

    const rows = await listDiaryEntries(access.projectId, scopeFor(access, ctx.companyId), filter);
    /*
     * The counterparty-read key is checked once for the page rather than per row.
     * The owner is the only caller who can see somebody else's entries at all, so
     * the question is a single "does this reader's plan include the diary" — and a
     * per-row check would answer it identically thirty times or, worse, return a
     * page with holes in it that nothing explains.
     */
    if (rows.some((row) => row.company_id !== ctx.companyId)) {
      await assertCounterpartyRead(ctx.companyId, '');
    }
    const children = await loadDiaryChildren(rows.map((r) => r.id));
    res.json({ entries: rows.map((row) => toDiaryEntryView(row, children)) });
  })
);

/**
 * POST /v1/projects/:projectId/diary — open a day, or return the day already
 * open.
 *
 * **Idempotent on the natural key, not merely on the client id.** §23's unique
 * key is `(project_id, company_id, entry_date)`, so "create Friday" asked twice
 * is one Friday. A 409 would be technically correct and useless: the caller wants
 * Friday's entry and there is exactly one, so it gets it — 201 the first time,
 * 200 after.
 */
projectDiaryRouter.post(
  '/:projectId/diary',
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    const access = await projectAccess(uuidParam(req, 'projectId'), ctx.companyId);
    await assertDiaryFeature(access);
    await assertCapability(ctx, 'diary.write');

    const input = createDiaryEntrySchema.parse(req.body);
    const timeRefusal = refuseDiaryTimes(input);
    if (timeRefusal) throw new AppError('VALIDATION', timeRefusal);

    const clock = await projectClock(access.projectId);
    if (!clock) throw new AppError('NOT_FOUND', 'Project not found');
    const futureRefusal = refuseFutureEntryDate(input.entryDate, clock.today);
    if (futureRefusal) throw new AppError('VALIDATION', futureRefusal);

    const existing = await findDiaryEntryForDay({
      projectId: access.projectId,
      companyId: ctx.companyId,
      entryDate: input.entryDate,
    });
    if (existing) {
      res.status(200).json({ entry: await viewOf(existing) });
      return;
    }

    await assertSupervisor(ctx.companyId, input.supervisorUserId ?? null);
    await assertLocations(access.projectId, input.locationIds ?? []);
    await assertDocuments(access.projectId, ctx.companyId, access.isOwner, input.documentIds ?? []);

    await withIdempotency(
      {
        res,
        companyId: ctx.companyId,
        clientId: input.clientId,
        route: 'POST /v1/projects/:projectId/diary',
        body: req.body,
        successStatus: 201,
      },
      async () => {
        const narrative: Partial<Record<DiaryNarrativeField, string | null>> = {};
        for (const field of DIARY_NARRATIVE_FIELDS) {
          if (field in input) narrative[field] = input[field] ?? null;
        }

        const entry = await withTransaction(async (client) => {
          const row = await insertDiaryEntry(
            {
              projectId: access.projectId,
              companyId: ctx.companyId,
              entryDate: input.entryDate,
              createdByUserId: ctx.userId,
              startTime: input.startTime ?? null,
              finishTime: input.finishTime ?? null,
              supervisorUserId: input.supervisorUserId ?? null,
              narrative,
            },
            client
          );
          if (!row) {
            /*
             * Two devices opened today at once and this one lost the natural key.
             * Not an error: the day the caller asked for exists, so it is read
             * back and returned. The winner's row is committed — it is a different
             * transaction — which is why this read happens outside the CTE.
             */
            return null;
          }
          if (input.locationIds?.length) {
            await replaceDiaryLocations(row.id, input.locationIds, client);
          }
          if (input.documentIds?.length) {
            await replaceDiaryDocuments(row.id, input.documentIds, client);
          }
          await recordAudit(
            {
              companyId: ctx.companyId,
              actorUserId: ctx.userId,
              action: 'diary.opened',
              entityType: 'SITE_DIARY_ENTRY',
              entityId: row.id,
              changes: { entryDate: row.entry_date, projectId: row.project_id },
              description: `Diary opened for ${row.entry_date}`,
            },
            client
          );
          return row;
        });

        if (!entry) {
          const winner = await findDiaryEntryForDay({
            projectId: access.projectId,
            companyId: ctx.companyId,
            entryDate: input.entryDate,
          });
          if (!winner) throw new AppError('CONFLICT', 'That day could not be opened.');
          return { entry: await viewOf(winner) };
        }
        return { entry: await viewOf(entry) };
      }
    );
  })
);

/**
 * GET /v1/projects/:projectId/diary/prefill?date=YYYY-MM-DD — §23's prefill.
 *
 * **Suggestions, never rows.** The supervisor confirms what the timesheets say
 * rather than retyping it, and the difference is the entire value of the feature:
 * a diary that wrote itself from the timesheets would agree with them by
 * construction and prove nothing. What a confirmed line gives a hiring company is
 * a second, independent assertion that the person was there.
 *
 * §31's schedule is the plan's other source and it is **Phase 11**; the response
 * labels every suggestion with where it came from, so the schedule joins the list
 * later without changing what a caller has to understand.
 */
projectDiaryRouter.get(
  '/:projectId/diary/prefill',
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    const access = await projectAccess(uuidParam(req, 'projectId'), ctx.companyId);
    await assertDiaryFeature(access);
    await assertCapability(ctx, 'diary.write');

    const date = String((req.query as Record<string, unknown>).date ?? '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw new AppError('VALIDATION', 'A prefill needs a date, as YYYY-MM-DD');
    }

    const entry = await findDiaryEntryForDay({
      projectId: access.projectId,
      companyId: ctx.companyId,
      entryDate: date,
    });
    const [logs, already, drafts] = await Promise.all([
      findPrefillTimeLogs({
        projectId: access.projectId,
        companyId: ctx.companyId,
        entryDate: date,
      }),
      entry ? existingTimeLogIds(entry.id) : Promise.resolve([]),
      countDraftTimeLogs({
        projectId: access.projectId,
        companyId: ctx.companyId,
        entryDate: date,
      }),
    ]);

    const body: DiaryPrefillResponse = {
      entryDate: date,
      entryId: entry?.id ?? null,
      attendance: suggestAttendance({
        timeLogs: logs.map((log) => ({
          id: log.id,
          userId: log.user_id,
          userName: log.user_name,
          providerCompanyId: log.provider_company_id,
          roleId: log.role_id,
          roleName: log.role_name,
          hours: Number(log.hours),
        })),
        existingTimeLogIds: already,
        authoringCompanyId: ctx.companyId,
      }),
      // Named rather than counted silently: a supervisor deciding whether to close
      // the day needs to know four timesheets are still drafts, and the number is
      // the same one Close Day will prompt about.
      unsubmittedTimeLogs: drafts,
      /**
       * §31's schedule, said out loud rather than left as an empty array somebody
       * has to guess the meaning of.
       */
      sources: { timeLogs: true, schedule: false },
    };
    res.json(body);
  })
);

// ── Mounted under /v1/diary ──────────────────────────────────────────────────

export const diaryRouter = Router();

diaryRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    const { row } = await readableEntry(uuidParam(req, 'id'), ctx.companyId);
    await assertCapability(ctx, 'project.read');

    const view = await viewOf(row);
    res.json({
      entry: view,
      amendedLabel: describeAmendments(view.amendedTimes),
      closePrompts: view.status === 'OPEN' ? await closePromptFacts(view, row) : [],
    });
  })
);

/**
 * PATCH /v1/diary/:id — the edit, and the amendment, and they are one route on
 * purpose.
 *
 * A separate `/amend` endpoint would put the decision in the client's hands:
 * whichever screen forgot to switch would write to a closed day through the
 * ordinary path and lose the reason. Here the *record's* state decides — closed
 * demands a reason, `diary.close`, and a `record_revisions` row — and no caller
 * can opt out of that by choosing a different URL.
 */
diaryRouter.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    const id = uuidParam(req, 'id');
    const { row, access } = await readableEntry(id, ctx.companyId);
    assertAuthoring(row, ctx.companyId);

    const patch = updateDiaryEntrySchema.parse(req.body);
    const { expectedRevision, base, reason, locationIds, documentIds, ...fields } = patch;

    const amending = row.status === 'CLOSED';
    if (amending) await assertCapability(ctx, 'diary.close');
    else await assertCapability(ctx, 'diary.write');

    const refusal = refuseDiaryEdit({ status: row.status, reason });
    if (refusal) throw new AppError('VALIDATION', refusal.message, { reason: refusal.code });

    const timeRefusal = refuseDiaryTimes({
      startTime: 'startTime' in fields ? fields.startTime : row.start_time,
      finishTime: 'finishTime' in fields ? fields.finishTime : row.finish_time,
    });
    if (timeRefusal) throw new AppError('VALIDATION', timeRefusal);

    if ('supervisorUserId' in fields) {
      await assertSupervisor(ctx.companyId, fields.supervisorUserId ?? null);
    }
    if (locationIds) await assertLocations(row.project_id, locationIds);
    if (documentIds) {
      await assertDocuments(row.project_id, ctx.companyId, access.isOwner, documentIds);
    }

    /*
     * The per-field merge, and it runs only where §8 allows it: an OPEN day, a
     * stale expected revision, and a `base` the client actually held. Everything
     * else takes the ordinary contract — a matching revision applies, a stale one
     * without a base refuses.
     */
    let applied: Record<string, unknown> = fields;
    let mergedRevision = expectedRevision;
    if (
      !amending &&
      base !== undefined &&
      expectedRevision !== undefined &&
      expectedRevision !== row.revision
    ) {
      const merge = mergeDiaryEdit({
        base: base as Partial<Record<DiaryNarrativeField, string | null>>,
        incoming: fields as Partial<Record<DiaryNarrativeField, string | null>>,
        current: narrativeOf(row),
      });
      if (merge.conflicted.length > 0) {
        /*
         * All or nothing. Applying the clean fields behind a 409 is a status code
         * that lies, and a 200 carrying a `conflicted` array is a silent discard
         * waiting for the first client that does not read it. Nothing is lost:
         * §8's queued item stays on the device with its reason, so this costs one
         * round trip and keeps the answer honest.
         */
        throw new AppError(
          'CONFLICT',
          'Somebody else wrote in the same part of this day. Keep yours or theirs?',
          {
            reason: 'FIELD_CONFLICT',
            currentRevision: row.revision,
            conflicts: merge.conflicted,
            wouldApply: merge.applied,
          }
        );
      }
      // Non-narrative fields are not merged — a start time has one right answer —
      // so they ride along under the caller's own claim, which is now known stale.
      applied = { ...fields, ...merge.merged };
      mergedRevision = undefined;
    }

    const before = amending ? snapshot(row) : null;
    const updated = await withTransaction(async (client) => {
      const next = Object.keys(applied).length
        ? await updateDiaryEntry(
            id,
            applied,
            { actorUserId: ctx.userId, expectedRevision: mergedRevision },
            client
          )
        : await touchDiaryEntry(id, ctx.userId, client);
      if (!next) {
        const now = await findDiaryEntry(id, client);
        if (!now) throw new AppError('NOT_FOUND', 'Diary entry not found');
        throw new AppError('CONFLICT', 'Somebody else changed this while you were away.', {
          reason: 'STALE_REVISION',
          currentRevision: now.revision,
        });
      }
      if (locationIds) await replaceDiaryLocations(id, locationIds, client);
      if (documentIds) await replaceDiaryDocuments(id, documentIds, client);

      await recordAudit(
        {
          companyId: ctx.companyId,
          actorUserId: ctx.userId,
          action: amending ? 'diary.amended' : 'diary.updated',
          entityType: 'SITE_DIARY_ENTRY',
          entityId: id,
          changes: { entryDate: next.entry_date, fields: Object.keys(applied) },
          description: amending
            ? `Diary amended for ${next.entry_date}`
            : `Diary updated for ${next.entry_date}`,
        },
        client
      );

      if (amending && before) {
        /*
         * §36's before/after row, and the whole reason the amendment path exists.
         * `changedFields` is computed inside `recordRevision` from the two
         * snapshots rather than declared here, so a caller cannot over- or
         * under-report what it changed.
         */
        await recordRevision(
          {
            companyId: row.company_id,
            entityType: DIARY_REVISION_ENTITY,
            entityId: id,
            action: 'UPDATE',
            before,
            after: snapshot(next),
            reason: reason ?? null,
            changedByUserId: ctx.userId,
          },
          client
        );

        /*
         * The event goes out **in the same transaction as the change** (§36,
         * decision #25). Its key is `(entry, revision)`, and the revision is read
         * back from the row `recordRevision` just wrote rather than counted here —
         * so a revision write that failed (which §36 requires to be non-fatal)
         * cannot leave an event pointing at a history entry that does not exist.
         */
        await enqueueAmendment(
          {
            actorUserId: ctx.userId,
            entryId: id,
            row,
            ownerCompanyId: access.ownerCompanyId,
            reason: reason ?? '',
            changedFields: changedBetween(before, snapshot(next)),
          },
          client
        );
      }
      return next;
    });

    const view = await viewOf(updated);
    res.json({ entry: view, amendedLabel: describeAmendments(view.amendedTimes) });
  })
);

/**
 * POST /v1/diary/:id/close — Close Day.
 *
 * The prompts come back with the result rather than gating it. A close that
 * refuses until a photograph exists is a close that teaches somebody to
 * photograph the floor twice, and the day ended at 17:00 whether or not the
 * product approves of how it was written up.
 */
diaryRouter.post(
  '/:id/close',
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    const id = uuidParam(req, 'id');
    const { row, access } = await readableEntry(id, ctx.companyId);
    assertAuthoring(row, ctx.companyId);
    await assertCapability(ctx, 'diary.close');

    const input = closeDiaryEntrySchema.parse(req.body ?? {});
    const timeRefusal = refuseDiaryTimes({
      startTime: input.startTime !== undefined ? input.startTime : row.start_time,
      finishTime: input.finishTime !== undefined ? input.finishTime : row.finish_time,
    });
    if (timeRefusal) throw new AppError('VALIDATION', timeRefusal);

    await withIdempotency(
      {
        res,
        companyId: ctx.companyId,
        clientId: input.clientId,
        route: 'POST /v1/diary/:id/close',
        body: req.body ?? {},
        successStatus: 200,
      },
      async () => {
        const closed = await withTransaction(async (client) => {
          const next = await closeDiaryEntry(
            {
              id,
              actorUserId: ctx.userId,
              startTime: input.startTime,
              finishTime: input.finishTime,
              expectedRevision: input.expectedRevision,
            },
            client
          );
          if (!next) return null;

          await recordAudit(
            {
              companyId: ctx.companyId,
              actorUserId: ctx.userId,
              action: 'diary.closed',
              entityType: 'SITE_DIARY_ENTRY',
              entityId: id,
              changes: { entryDate: next.entry_date, closedAt: next.closed_at },
              description: `Diary closed for ${next.entry_date}`,
            },
            client
          );

          /*
           * In the same transaction as the state change (§36, decision #25), and
           * the totals are read through the same client so the event carries the
           * attendance that was on the day at the moment it closed — not whatever
           * it holds by the time a worker gets to it.
           */
          const closedView = await viewOf(next, client);
          await enqueueOutboxEvent(
            {
              topic: 'diary.closed',
              aggregateType: 'SITE_DIARY_ENTRY',
              aggregateId: id,
              companyId: access.ownerCompanyId,
              payload: diaryClosedEventPayload({
                diaryEntryId: id,
                projectId: row.project_id,
                ownerCompanyId: access.ownerCompanyId,
                authorCompanyId: row.company_id,
                entryDate: row.entry_date,
                actorUserId: ctx.userId,
                supervisorUserId: next.supervisor_user_id,
                workersPresentCount: closedView.workersPresentCount,
                subcontractorsPresentCount: closedView.subcontractorsPresentCount,
              }),
              // One close per day, for ever: there is no reopen, so the entry id
              // alone is the key §5 asks for.
              idempotencyKey: `diary.closed:${id}`,
            },
            client
          );
          return next;
        });

        if (!closed) {
          /*
           * `where status = 'OPEN'` matched nothing. Either somebody else closed
           * it — the packet's §9 row, and the loser is told who and when — or the
           * caller's expected revision was stale, which is an ordinary conflict.
           */
          const now = await findDiaryEntry(id);
          if (!now) throw new AppError('NOT_FOUND', 'Diary entry not found');
          if (now.status === 'CLOSED') {
            throw new AppError(
              'CONFLICT',
              describeCloseRace({
                closedByName: now.closed_by_name,
                closedAt: now.closed_at?.toISOString() ?? new Date().toISOString(),
                zone: now.owner_time_zone,
              }),
              {
                reason: 'ALREADY_CLOSED',
                closedByUserId: now.closed_by_user_id,
                closedAt: now.closed_at?.toISOString() ?? null,
                currentRevision: now.revision,
              }
            );
          }
          throw new AppError('CONFLICT', 'Somebody else changed this while you were away.', {
            reason: 'STALE_REVISION',
            currentRevision: now.revision,
          });
        }

        const view = await viewOf(closed);
        return {
          entry: view,
          // The same list the screen was already showing, returned again so a
          // client that closed without reading it can still say what was missing.
          closePrompts: await closePromptFacts(view, closed),
        };
      }
    );
  })
);

/**
 * GET /v1/diary/:id/history — "amended N times — view history".
 *
 * Scoped to the **authoring** company's revisions, which is what `listRevisions`
 * asks for, and readable by the project owner too: an amendment they were
 * notified about that they cannot then read is a notification that wastes
 * somebody's afternoon.
 */
diaryRouter.get(
  '/:id/history',
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    const { row } = await readableEntry(uuidParam(req, 'id'), ctx.companyId);
    await assertCapability(ctx, 'project.read');

    const revisions = await listRevisions({
      companyId: row.company_id,
      entityType: DIARY_REVISION_ENTITY,
      entityId: row.id,
    });
    res.json({
      revisions,
      amendedTimes: revisions.length === 0 ? 0 : (revisions[0]?.revision ?? 0),
      amendedLabel: describeAmendments(revisions[0]?.revision ?? 0),
    });
  })
);

// ── Attendance ───────────────────────────────────────────────────────────────

diaryRouter.post(
  '/:id/attendance',
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    const id = uuidParam(req, 'id');
    const { row } = await readableEntry(id, ctx.companyId);
    assertAuthoring(row, ctx.companyId);

    const input = createDiaryAttendanceSchema.parse(req.body);
    await assertAttendanceWritable(ctx, row, input.reason);
    if (input.userId) await assertSupervisor(ctx.companyId, input.userId);
    if (input.timeLogId) await assertTimeLog(row, input.timeLogId);
    await assertAttendanceCompany(row, input.providerCompanyId ?? null);

    await withIdempotency(
      {
        res,
        companyId: ctx.companyId,
        clientId: input.clientId,
        route: 'POST /v1/diary/:id/attendance',
        body: req.body,
        successStatus: 201,
      },
      async () => {
        const created = await withTransaction(async (client) => {
          const before =
            row.status === 'CLOSED' ? await attendanceSnapshot(id, client) : null;
          const line = await insertAttendance(
            {
              diaryEntryId: id,
              userId: input.userId ?? null,
              providerCompanyId: input.providerCompanyId ?? null,
              name: input.name ?? null,
              roleId: input.roleId ?? null,
              headcount: input.headcount ?? 1,
              hours: input.hours ?? null,
              timeLogId: input.timeLogId ?? null,
            },
            client
          );
          // A null line means the one-per-time-log index refused it: the prefill
          // was confirmed twice and the second press is a no-op rather than a
          // fabricated person. The entry is still touched, because a client that
          // retried deserves a revision it can reconcile against.
          await touchDiaryEntry(id, ctx.userId, client);
          if (!line) return null;

          await recordAudit(
            {
              companyId: ctx.companyId,
              actorUserId: ctx.userId,
              action: 'diary.attendance_added',
              entityType: 'SITE_DIARY_ENTRY',
              entityId: id,
              changes: { attendanceId: line.id, timeLogId: line.time_log_id },
              description: `Attendance recorded on ${row.entry_date}`,
            },
            client
          );
          if (row.status === 'CLOSED' && input.reason) {
            await amendAttendance(
              { ctx, row, entryId: id, before, reason: input.reason },
              client
            );
          }
          return line;
        });
        return { entry: await viewOf(await requireEntry(id)), added: created !== null };
      }
    );
  })
);

diaryRouter.patch(
  '/:id/attendance/:attendanceId',
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    const id = uuidParam(req, 'id');
    const attendanceId = uuidParam(req, 'attendanceId');
    const { row } = await readableEntry(id, ctx.companyId);
    assertAuthoring(row, ctx.companyId);

    const input = updateDiaryAttendanceSchema.parse(req.body);
    await assertAttendanceWritable(ctx, row, input.reason);

    const line = await findAttendance(attendanceId, id);
    if (!line) throw new AppError('NOT_FOUND', 'That attendance line is not on this day');

    const { reason, ...fields } = input;
    await withTransaction(async (client) => {
      const before = row.status === 'CLOSED' ? await attendanceSnapshot(id, client) : null;
      await updateAttendance(attendanceId, fields, client);
      await touchDiaryEntry(id, ctx.userId, client);
      await recordAudit(
        {
          companyId: ctx.companyId,
          actorUserId: ctx.userId,
          action: 'diary.attendance_updated',
          entityType: 'SITE_DIARY_ENTRY',
          entityId: id,
          changes: { attendanceId, fields: Object.keys(fields) },
          description: `Attendance corrected on ${row.entry_date}`,
        },
        client
      );
      if (row.status === 'CLOSED' && reason) {
        await amendAttendance({ ctx, row, entryId: id, before, reason }, client);
      }
    });
    res.json({ entry: await viewOf(await requireEntry(id)) });
  })
);

diaryRouter.delete(
  '/:id/attendance/:attendanceId',
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    const id = uuidParam(req, 'id');
    const attendanceId = uuidParam(req, 'attendanceId');
    const { row } = await readableEntry(id, ctx.companyId);
    assertAuthoring(row, ctx.companyId);

    /*
     * The reason travels as a query parameter here because a DELETE has no body a
     * client library reliably sends. It is still required on a closed day, and the
     * refusal is the same 422 the PATCH gives.
     */
    const reason = String((req.query as Record<string, unknown>).reason ?? '').trim() || undefined;
    await assertAttendanceWritable(ctx, row, reason);

    const removed = await withTransaction(async (client) => {
      const before = row.status === 'CLOSED' ? await attendanceSnapshot(id, client) : null;
      const line = await deleteAttendance(attendanceId, id, client);
      if (!line) return null;
      await touchDiaryEntry(id, ctx.userId, client);
      await recordAudit(
        {
          companyId: ctx.companyId,
          actorUserId: ctx.userId,
          action: 'diary.attendance_removed',
          entityType: 'SITE_DIARY_ENTRY',
          entityId: id,
          changes: { attendanceId, headcount: line.headcount, timeLogId: line.time_log_id },
          description: `Attendance removed from ${row.entry_date}`,
        },
        client
      );
      if (row.status === 'CLOSED' && reason) {
        await amendAttendance({ ctx, row, entryId: id, before, reason }, client);
      }
      return line;
    });
    if (!removed) throw new AppError('NOT_FOUND', 'That attendance line is not on this day');
    res.status(204).end();
  })
);

// ── Shared helpers ───────────────────────────────────────────────────────────

/**
 * Attendance on a closed day is an amendment like any other change to it.
 *
 * A route that let the narrative be frozen while the list of who was on site
 * stayed editable would be a freeze in name only — attendance is the part of a
 * closed day a dispute is most likely to be about.
 */
async function assertAttendanceWritable(
  ctx: Ctx & { companyId: string },
  row: DiaryEntryRow,
  reason: string | undefined
): Promise<void> {
  if (row.status === 'CLOSED') {
    await assertCapability(ctx, 'diary.close');
    const refusal = refuseDiaryEdit({ status: row.status, reason });
    if (refusal) throw new AppError('VALIDATION', refusal.message, { reason: refusal.code });
    return;
  }
  await assertCapability(ctx, 'diary.write');
}

/** A time log may only be cited by the diary of the company that logged it. */
async function assertTimeLog(row: DiaryEntryRow, timeLogId: string): Promise<void> {
  const log = await queryOne<{ ok: boolean }>(
    `select true as ok from time_logs
      where id = $1 and project_id = $2 and provider_company_id = $3 and work_date = $4::date`,
    [timeLogId, row.project_id, row.company_id, row.entry_date]
  );
  if (!log) {
    throw new AppError('VALIDATION', 'That time log is not this company’s, on this day');
  }
}

async function requireEntry(id: string): Promise<DiaryEntryRow> {
  const row = await findDiaryEntry(id);
  if (!row) throw new AppError('NOT_FOUND', 'Diary entry not found');
  return row;
}

/**
 * What a revision row records, and it is the fields rather than the projection.
 *
 * `toDiaryEntryView` would carry the derived counts and the amendment number into
 * every `before`, so a history panel would show "amendedTimes changed from 1 to
 * 2" on every row — a diff of the diff. The snapshot is the writable state only.
 */
function snapshot(row: DiaryEntryRow): Record<string, unknown> {
  const out: Record<string, unknown> = {
    startTime: row.start_time,
    finishTime: row.finish_time,
    supervisorUserId: row.supervisor_user_id,
    status: row.status,
  };
  const narrative = narrativeOf(row);
  for (const field of DIARY_NARRATIVE_FIELDS) out[field] = narrative[field];
  return out;
}

function changedBetween(
  before: Record<string, unknown>,
  after: Record<string, unknown>
): string[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys].filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k])).sort();
}

/**
 * The attendance list as the revision trail sees it: counts and links, no names.
 *
 * §11 excludes attendance names from every *payload*, and this is not a payload —
 * a revision row is the record itself, behind the same authorization as the entry.
 * The names are still left out, because the trail's job is to answer *what
 * changed about who was here*, and an id plus a headcount answers it without
 * copying somebody's name into a second table that no closure step scrubs.
 */
async function attendanceSnapshot(entryId: string, runner?: Queryable): Promise<unknown[]> {
  const rows = await query<{
    id: string;
    user_id: string | null;
    provider_company_id: string | null;
    role_id: string | null;
    headcount: string;
    hours: string | null;
    time_log_id: string | null;
  }>(
    `select id, user_id, provider_company_id, role_id, headcount, hours, time_log_id
       from site_diary_attendance where diary_entry_id = $1 order by id asc`,
    [entryId],
    runner
  );
  return rows.map((r) => ({
    id: r.id,
    userId: r.user_id,
    providerCompanyId: r.provider_company_id,
    roleId: r.role_id,
    headcount: Number(r.headcount),
    hours: r.hours === null ? null : Number(r.hours),
    timeLogId: r.time_log_id,
  }));
}

/**
 * A change to a closed day's attendance, recorded and announced the same way a
 * change to its narrative is.
 *
 * A route that froze the prose and left the list of who was on site editable would
 * be a freeze in name only — attendance is the part of a closed day a dispute is
 * most likely to be about.
 */
async function amendAttendance(
  args: {
    ctx: Ctx & { companyId: string };
    row: DiaryEntryRow;
    entryId: string;
    before: unknown[] | null;
    reason: string;
  },
  client: Queryable
): Promise<void> {
  await recordRevision(
    {
      companyId: args.row.company_id,
      entityType: DIARY_REVISION_ENTITY,
      entityId: args.entryId,
      action: 'UPDATE',
      before: { attendance: args.before },
      after: { attendance: await attendanceSnapshot(args.entryId, client) },
      reason: args.reason,
      changedByUserId: args.ctx.userId,
    },
    client
  );
  await enqueueAmendment(
    {
      actorUserId: args.ctx.userId,
      entryId: args.entryId,
      row: args.row,
      ownerCompanyId: args.row.owner_company_id,
      reason: args.reason,
      changedFields: ['attendance'],
    },
    client
  );
}

/**
 * The `diary.amended` event, enqueued in the same transaction as the revision it
 * points at.
 *
 * **The revision number is read back rather than counted here**, and that is the
 * detail worth the extra query. §36 requires a revision write to be non-fatal —
 * *"a broken trail must not fail an approval"* — so `recordRevision` swallows its
 * own failures. Deriving the key from a counter maintained here would produce an
 * event announcing amendment 3 with no amendment 3 in the history, and the
 * notification would send somebody to a panel that disagrees with it.
 *
 * A revision of 0 means the write did not land, and no event goes out: an
 * amendment notice with nothing behind it is worse than a missing one.
 */
async function enqueueAmendment(
  args: {
    actorUserId: string;
    entryId: string;
    row: DiaryEntryRow;
    ownerCompanyId: string;
    reason: string;
    changedFields: readonly string[];
  },
  client: Queryable
): Promise<void> {
  const latest = await queryOne<{ n: number | null }>(
    `select max(revision)::int as n from record_revisions
      where entity_type = $1 and entity_id = $2`,
    [DIARY_REVISION_ENTITY, args.entryId],
    client
  );
  const revision = latest?.n ?? 0;
  if (revision === 0 || !args.reason) return;

  await enqueueOutboxEvent(
    {
      topic: 'diary.amended',
      aggregateType: 'SITE_DIARY_ENTRY',
      aggregateId: args.entryId,
      companyId: args.ownerCompanyId,
      payload: diaryAmendedEventPayload({
        diaryEntryId: args.entryId,
        projectId: args.row.project_id,
        ownerCompanyId: args.ownerCompanyId,
        authorCompanyId: args.row.company_id,
        entryDate: args.row.entry_date,
        actorUserId: args.actorUserId,
        revision,
        changedFields: args.changedFields,
        reason: args.reason,
      }),
      // §5's key is (entry, revision): one amendment, one event, however many
      // times a retry delivers it — and the next amendment is a different key.
      idempotencyKey: `diary.amended:${args.entryId}:${revision}`,
    },
    client
  );
}
