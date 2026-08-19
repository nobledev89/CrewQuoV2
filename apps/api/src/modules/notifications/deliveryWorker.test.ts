import { describe, expect, it } from 'vitest';
import { partitionForDelivery, type DueRow } from './deliveryWorker';

/**
 * The batching decision the digest preference makes.
 *
 * Pinned here rather than end-to-end because the alternative is asserting how
 * many times an email provider was called, which needs a provider. The rule is
 * pure; only the sending is not.
 */

const row = (over: Partial<DueRow> = {}): DueRow => ({
  id: `d-${Math.random().toString(36).slice(2)}`,
  notification_id: 'n1',
  channel: 'EMAIL',
  attempts: 1,
  title: 'Something happened',
  body: 'Details',
  action_url: null,
  recipient_user_id: 'user-a',
  recipient_email: 'a@example.test',
  recipient_name: 'A',
  digest: 'IMMEDIATE',
  ...over,
});

describe('partitionForDelivery', () => {
  it('sends every email of its own when nobody asked for a digest', () => {
    const { individual, digestGroups } = partitionForDelivery([row(), row(), row()]);
    expect(individual).toHaveLength(3);
    expect(digestGroups).toHaveLength(0);
  });

  it('batches one recipient\u2019s digested email into a single group', () => {
    const rows = [
      row({ digest: 'HOURLY' }),
      row({ digest: 'HOURLY' }),
      row({ digest: 'HOURLY' }),
    ];
    const { individual, digestGroups } = partitionForDelivery(rows);
    expect(individual).toHaveLength(0);
    expect(digestGroups).toHaveLength(1);
    expect(digestGroups[0]).toHaveLength(3);
  });

  it('never mixes two people into one message', () => {
    const rows = [
      row({ recipient_user_id: 'user-a', digest: 'DAILY' }),
      row({ recipient_user_id: 'user-b', digest: 'DAILY' }),
      row({ recipient_user_id: 'user-a', digest: 'DAILY' }),
    ];
    const { digestGroups } = partitionForDelivery(rows);
    expect(digestGroups).toHaveLength(2);
    expect(digestGroups.map((g) => g.length).sort()).toEqual([1, 2]);
    for (const group of digestGroups) {
      const recipients = new Set(group.map((r) => r.recipient_user_id));
      expect(recipients.size).toBe(1);
    }
  });

  it('never digests a push, whatever the recipient set', () => {
    // A digest batches messages. Collapsing six device knocks into one is not a
    // summary — it is five notifications that never arrived.
    const rows = [row({ channel: 'PUSH', digest: 'DAILY' }), row({ channel: 'PUSH', digest: 'HOURLY' })];
    const { individual, digestGroups } = partitionForDelivery(rows);
    expect(individual).toHaveLength(2);
    expect(digestGroups).toHaveLength(0);
  });

  it('keeps a deleted recipient out of both paths', () => {
    // Folding this into `individual` would mean asking the email adapter to send
    // to nobody, and recording the refusal as a failure worth retrying.
    const rows = [row({ recipient_user_id: null, digest: 'HOURLY' }), row()];
    const { orphaned, individual, digestGroups } = partitionForDelivery(rows);
    expect(orphaned).toHaveLength(1);
    expect(individual).toHaveLength(1);
    expect(digestGroups).toHaveLength(0);
  });

  it('accounts for every claimed row exactly once', () => {
    // A row that falls through all three buckets is a delivery left PENDING with
    // its attempt count already incremented — an invisible, self-retrying leak.
    const rows = [
      row(),
      row({ digest: 'HOURLY' }),
      row({ channel: 'PUSH', digest: 'DAILY' }),
      row({ recipient_user_id: null }),
      row({ recipient_user_id: 'user-c', digest: 'DAILY' }),
    ];
    const { orphaned, individual, digestGroups } = partitionForDelivery(rows);
    const seen = [...orphaned, ...individual, ...digestGroups.flat()].map((r) => r.id);
    expect(seen).toHaveLength(rows.length);
    expect(new Set(seen).size).toBe(rows.length);
  });
});
