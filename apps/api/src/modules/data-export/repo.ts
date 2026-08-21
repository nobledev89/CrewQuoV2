import { pool } from '../../db';
import type { ExportScope } from './queries';

/**
 * Record that a bundle was produced (`0021_data_exports.sql`).
 *
 * Counts and a size, never contents: what was in somebody's export is theirs, and the
 * platform's interest is only that a concentrated disclosure happened, by whom, and how
 * big it was. That is the fact an operator or an owner needs later; the rows themselves
 * are already in the customer's hands.
 */
export async function recordDataExport(args: {
  scope: ExportScope;
  subjectUserId: string | null;
  subjectCompanyId: string | null;
  requestedByUserId: string;
  tableCount: number;
  rowCount: number;
  byteSize: number;
}): Promise<void> {
  await pool.query(
    `insert into data_exports
       (scope, subject_user_id, subject_company_id, requested_by_user_id,
        status, table_count, row_count, byte_size)
     values ($1, $2, $3, $4, 'READY', $5, $6, $7)`,
    [
      args.scope,
      args.subjectUserId,
      args.subjectCompanyId,
      args.requestedByUserId,
      args.tableCount,
      args.rowCount,
      args.byteSize,
    ]
  );
}
