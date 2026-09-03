import {
  complianceAlertThreshold,
  complianceDaysUntil,
  deriveComplianceStatus,
  type ComplianceKind,
  type ComplianceStatus,
} from '@crewquo/shared';
import { query, queryOne, withTransaction } from '../../db';
import { enqueueOutboxEvent } from '../delivery/repo';

interface Candidate {
  id: string;
  owner_company_id: string;
  subject_company_id: string;
  kind: ComplianceKind;
  title: string;
  file_id: string | null;
  expires_on: string | null;
  status: ComplianceStatus;
  reject_reason: string | null;
  tracking_company_ids: string[];
  today: string;
}

export interface ComplianceExpiryResult {
  scanned: number;
  statusChanged: number;
  alerted: number;
}

/** Status reconciliation and the §33 90/60/30/14/7 ladder. */
export async function runComplianceExpiryBatch(limit = 500): Promise<ComplianceExpiryResult> {
  const candidates = await query<Candidate>(
    `select d.id, d.owner_company_id, d.subject_company_id, d.kind, d.title,
            d.file_id, to_char(d.expires_on, 'YYYY-MM-DD') as expires_on,
            d.status, d.reject_reason,
            case when d.owner_company_id = d.subject_company_id then array(
              select distinct e.client_company_id
                from engagements e
               where e.provider_company_id = d.subject_company_id
                 and e.status in ('PENDING','ACTIVE','PAUSED')
            ) else array[d.owner_company_id] end as tracking_company_ids,
            to_char(now() at time zone coalesce(c.time_zone, 'UTC'), 'YYYY-MM-DD') as today
       from compliance_documents d
       join companies c on c.id = d.owner_company_id
      where d.deleted_at is null
        and not exists (
          select 1 from compliance_documents n where n.supersedes_id = d.id and n.deleted_at is null
        )
      order by d.updated_at, d.id
      limit $1`,
    [limit]
  );
  const result: ComplianceExpiryResult = { scanned: 0, statusChanged: 0, alerted: 0 };

  for (const row of candidates) {
    result.scanned += 1;
    const nextStatus = deriveComplianceStatus({
      fileId: row.file_id,
      expiresOn: row.expires_on,
      today: row.today,
      rejected: row.reject_reason !== null,
    });
    const threshold = row.expires_on
      ? complianceAlertThreshold(complianceDaysUntil(row.expires_on, row.today))
      : null;

    const changedAndAlerted = await withTransaction(async (client) => {
      let changed = false;
      if (nextStatus !== row.status) {
        await client.query(
          `update compliance_documents set status = $2, updated_at = now()
            where id = $1 and deleted_at is null`,
          [row.id, nextStatus]
        );
        changed = true;
      }

      // A rejected or missing row has no usable certificate to renew and does not
      // enter the date ladder. Its durable task is the rejection/missing status on
      // the register itself.
      if (threshold === null || row.file_id === null || nextStatus === 'REJECTED') {
        return { changed, alerted: false };
      }
      const alert = await queryOne<{ id: string }>(
        `insert into compliance_alerts (document_id, threshold_days)
         values ($1,$2) on conflict do nothing returning id`,
        [row.id, threshold],
        client
      );
      if (!alert) return { changed, alerted: false };

      const daysRemaining = complianceDaysUntil(row.expires_on!, row.today);
      await enqueueOutboxEvent(
        {
          topic: 'compliance.expiring',
          aggregateType: 'COMPLIANCE_DOCUMENT',
          aggregateId: `${row.id}:${threshold}`,
          companyId: row.owner_company_id,
          payload: {
            documentId: row.id,
            ownerCompanyId: row.owner_company_id,
            subjectCompanyId: row.subject_company_id,
            trackingCompanyIds: row.tracking_company_ids,
            kind: row.kind,
            title: row.title,
            expiresOn: row.expires_on,
            threshold,
            daysRemaining,
          },
          idempotencyKey: `compliance.expiring:${row.id}:${row.expires_on}:${threshold}`,
        },
        client
      );
      return { changed, alerted: true };
    });
    if (changedAndAlerted.changed) result.statusChanged += 1;
    if (changedAndAlerted.alerted) result.alerted += 1;
  }
  return result;
}
