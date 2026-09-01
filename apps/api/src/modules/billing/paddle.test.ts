import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifyPaddleSignature } from './paddle';

describe('verifyPaddleSignature', () => {
  const rawBody = Buffer.from('{"event_id":"evt_1"}');
  const secret = 'pdl_ntfset_test';
  const timestamp = 1_700_000_000;
  const h1 = createHmac('sha256', secret)
    .update(Buffer.concat([Buffer.from(`${timestamp}:`), rawBody]))
    .digest('hex');

  it('accepts an authentic recent raw body', () => {
    expect(verifyPaddleSignature({
      rawBody,
      signatureHeader: `ts=${timestamp};h1=${h1}`,
      secret,
      nowSeconds: timestamp + 3,
    })).toBe(true);
  });

  it('rejects body changes and stale deliveries', () => {
    expect(verifyPaddleSignature({
      rawBody: Buffer.from('{"event_id":"evt_2"}'),
      signatureHeader: `ts=${timestamp};h1=${h1}`,
      secret,
      nowSeconds: timestamp,
    })).toBe(false);
    expect(verifyPaddleSignature({
      rawBody,
      signatureHeader: `ts=${timestamp};h1=${h1}`,
      secret,
      nowSeconds: timestamp + 6,
    })).toBe(false);
  });

  it('accepts any valid h1 during secret rotation', () => {
    expect(verifyPaddleSignature({
      rawBody,
      signatureHeader: `ts=${timestamp};h1=${'0'.repeat(64)};h1=${h1}`,
      secret,
      nowSeconds: timestamp,
    })).toBe(true);
  });
});
