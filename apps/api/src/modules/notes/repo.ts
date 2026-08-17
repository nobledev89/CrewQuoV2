import type {
  CreateLineItemNote,
  LineItemEntityType,
  LineItemNoteView,
  UpdateLineItemNote,
} from '@crewquo/shared';
import { query, queryOne } from '../../db';
import { AppError } from '../../http/errors';

/**
 * Line-item note persistence (CREWQUO_V2_PLAN.md §3.6). Notes hang off an
 * engagement and point at a project / time log / expense / invoice; the route
 * layer decides who may write one.
 */

interface NoteRow {
  id: string;
  engagement_id: string;
  entity_type: LineItemEntityType;
  entity_id: string;
  author_company_id: string;
  author_company_name: string;
  author_user_id: string;
  author_name: string;
  body: string;
  resolved: boolean;
  created_at: Date;
  updated_at: Date;
}

function toNoteView(r: NoteRow): LineItemNoteView {
  return {
    id: r.id,
    engagementId: r.engagement_id,
    entityType: r.entity_type,
    entityId: r.entity_id,
    authorCompanyId: r.author_company_id,
    authorCompanyName: r.author_company_name,
    authorUserId: r.author_user_id,
    authorName: r.author_name,
    body: r.body,
    resolved: r.resolved,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
}

const NOTE_SELECT = `
  select n.id, n.engagement_id, n.entity_type, n.entity_id,
         n.author_company_id, ac.name as author_company_name,
         n.author_user_id, au.name as author_name,
         n.body, n.resolved, n.created_at, n.updated_at
    from line_item_notes n
    join companies ac on ac.id = n.author_company_id
    join users au on au.id = n.author_user_id`;

/**
 * Notes on one engagement, optionally narrowed to a single entity. The caller
 * must already have established that the active company is on this edge.
 */
export async function listNotes(filter: {
  engagementId: string;
  entityType?: LineItemEntityType;
  entityId?: string;
}): Promise<LineItemNoteView[]> {
  const rows = await query<NoteRow>(
    `${NOTE_SELECT}
      where n.engagement_id = $1
        and ($2::text is null or n.entity_type = $2)
        and ($3::uuid is null or n.entity_id = $3)
      order by n.created_at asc`,
    [filter.engagementId, filter.entityType ?? null, filter.entityId ?? null]
  );
  return rows.map(toNoteView);
}

export function findNote(id: string): Promise<NoteRow | null> {
  return queryOne<NoteRow>(`${NOTE_SELECT} where n.id = $1`, [id]);
}

export async function getNoteView(id: string): Promise<LineItemNoteView | null> {
  const row = await findNote(id);
  return row ? toNoteView(row) : null;
}

export async function insertNote(input: {
  note: CreateLineItemNote;
  authorCompanyId: string;
  authorUserId: string;
}): Promise<LineItemNoteView> {
  const row = await queryOne<{ id: string }>(
    `insert into line_item_notes (engagement_id, entity_type, entity_id,
                                  author_company_id, author_user_id, body)
     values ($1, $2, $3, $4, $5, $6) returning id`,
    [
      input.note.engagementId,
      input.note.entityType,
      input.note.entityId,
      input.authorCompanyId,
      input.authorUserId,
      input.note.body,
    ]
  );
  return (await getNoteView(row!.id))!;
}

export async function updateNote(
  id: string,
  patch: UpdateLineItemNote
): Promise<LineItemNoteView> {
  const row = await queryOne<{ id: string }>(
    `update line_item_notes set
       body = coalesce($2, body),
       resolved = coalesce($3, resolved),
       updated_at = now()
     where id = $1 returning id`,
    [id, patch.body ?? null, patch.resolved ?? null]
  );
  if (!row) throw new AppError('NOT_FOUND', 'Note not found');
  return (await getNoteView(id))!;
}

export async function deleteNote(id: string): Promise<void> {
  const row = await queryOne(`delete from line_item_notes where id = $1 returning id`, [id]);
  if (!row) throw new AppError('NOT_FOUND', 'Note not found');
}

/**
 * Does `entityId` really belong to `engagementId`? Without this a caller on a
 * legitimate edge could anchor a note to another engagement's time log and read
 * it back through that engagement's note list.
 *
 * A work row sits on *two* edges and both are valid places to discuss it:
 * `time_logs.engagement_id` is the owner⇄subcontractor edge the log flowed up for
 * approval, while its project's `engagement_id` is the owner⇄client edge the
 * portal conversation happens on. Matching only the first would reject every
 * note a client writes about a line item on their own portal.
 */
export async function entityBelongsToEngagement(
  entityType: LineItemEntityType,
  entityId: string,
  engagementId: string
): Promise<boolean> {
  if (entityType === 'INVOICE') return false; // invoices arrive in Phase 5
  const sql = {
    PROJECT: `select 1 from projects where id = $1 and engagement_id = $2`,
    TIME_LOG: `select 1 from time_logs t join projects p on p.id = t.project_id
                where t.id = $1 and $2 in (t.engagement_id, p.engagement_id)`,
    EXPENSE: `select 1 from expenses e join projects p on p.id = e.project_id
               where e.id = $1 and $2 in (e.engagement_id, p.engagement_id)`,
  }[entityType];
  return (await queryOne(sql, [entityId, engagementId])) !== null;
}
