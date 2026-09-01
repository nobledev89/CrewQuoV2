import { describe, expect, it } from 'vitest';
import {
  DERIVATIVE_SPECS,
  FILE_TYPE_RULES,
  METERED_STATUSES,
  buildBucketKey,
  bytesToGb,
  extensionFor,
  formatBytes,
  gbToBytes,
  isRenderableInline,
  normalizeContentType,
  presignUploadSchema,
  refuseUpload,
  sniffContentType,
  sniffedTypeAgrees,
  wantsDerivatives,
} from './storage';

const bytes = (...values: number[]): Uint8Array => new Uint8Array(values);
const JPEG = bytes(0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10);
const PNG = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
const PDF = bytes(0x25, 0x50, 0x44, 0x46, 0x2d, 0x31);
const ZIP = bytes(0x50, 0x4b, 0x03, 0x04, 0x14, 0x00);
// MZ — a Windows executable, which is the thing a `.jpg` upload must never be.
const EXE = bytes(0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00);
const HTML = new TextEncoder().encode('<html><script>alert(1)</script>');

describe('refuseUpload', () => {
  it('accepts an ordinary photograph', () => {
    expect(refuseUpload({ kind: 'IMAGE', contentType: 'image/jpeg', byteSize: 3_000_000 })).toBeNull();
  });

  it('refuses a type the kind does not allow', () => {
    const refusal = refuseUpload({ kind: 'IMAGE', contentType: 'application/pdf', byteSize: 1000 });
    expect(refusal?.code).toBe('UNSUPPORTED_TYPE');
  });

  it('refuses an SVG as an image, because an SVG can execute script', () => {
    expect(refuseUpload({ kind: 'IMAGE', contentType: 'image/svg+xml', byteSize: 1000 })?.code).toBe(
      'UNSUPPORTED_TYPE'
    );
    // A signature is drawn by the product itself, so it is the one place an SVG
    // is legitimate — and `isRenderableInline` still refuses to render it.
    expect(refuseUpload({ kind: 'SIGNATURE', contentType: 'image/svg+xml', byteSize: 1000 })).toBeNull();
  });

  it('refuses an oversized file, per kind', () => {
    const big = FILE_TYPE_RULES.IMAGE.maxBytes + 1;
    expect(refuseUpload({ kind: 'IMAGE', contentType: 'image/jpeg', byteSize: big })?.code).toBe('TOO_LARGE');
    // The same size is fine as a document, because a phone video is evidence too.
    expect(refuseUpload({ kind: 'DOCUMENT', contentType: 'video/mp4', byteSize: big })).toBeNull();
  });

  it('refuses an empty file', () => {
    expect(refuseUpload({ kind: 'IMAGE', contentType: 'image/jpeg', byteSize: 0 })?.code).toBe('EMPTY');
  });

  it('reads a charset parameter as the same claim', () => {
    expect(refuseUpload({ kind: 'DOCUMENT', contentType: 'text/csv; charset=utf-8', byteSize: 10 })).toBeNull();
  });

  it('is case-insensitive about the declared type', () => {
    expect(refuseUpload({ kind: 'IMAGE', contentType: 'IMAGE/JPEG', byteSize: 10 })).toBeNull();
  });
});

describe('normalizeContentType', () => {
  it('strips parameters and lowercases', () => {
    expect(normalizeContentType('  Image/JPEG ; charset=x ')).toBe('image/jpeg');
  });
});

describe('buildBucketKey', () => {
  const base = {
    companyId: '11111111-1111-1111-1111-111111111111',
    kind: 'IMAGE' as const,
    fileId: '22222222-2222-2222-2222-222222222222',
    contentType: 'image/jpeg',
  };

  it('scopes a project file under its project', () => {
    expect(
      buildBucketKey({ ...base, projectId: '33333333-3333-3333-3333-333333333333', variant: 'ORIGINAL' })
    ).toBe(
      'co/11111111-1111-1111-1111-111111111111/proj/33333333-3333-3333-3333-333333333333/IMAGE/22222222-2222-2222-2222-222222222222/original.jpg'
    );
  });

  it('scopes a company-level file under the company', () => {
    expect(buildBucketKey({ ...base, projectId: null, variant: 'ORIGINAL' })).toBe(
      'co/11111111-1111-1111-1111-111111111111/company/IMAGE/22222222-2222-2222-2222-222222222222/original.jpg'
    );
  });

  it('puts a derivative under the same prefix as its original', () => {
    const original = buildBucketKey({ ...base, projectId: null, variant: 'ORIGINAL' });
    const thumb = buildBucketKey({ ...base, projectId: null, variant: 'THUMB' });
    // A prefix delete has to take the whole family. Sharing everything up to the
    // filename is what makes that one operation rather than a search.
    expect(thumb.slice(0, thumb.lastIndexOf('/'))).toBe(original.slice(0, original.lastIndexOf('/')));
    expect(thumb.endsWith('/thumb.webp')).toBe(true);
  });

  it('every company prefix begins with that company, so a prefix is a tenant', () => {
    const key = buildBucketKey({ ...base, projectId: null, variant: 'ORIGINAL' });
    expect(key.startsWith(`co/${base.companyId}/`)).toBe(true);
  });
});

describe('extensionFor', () => {
  it('maps known types', () => {
    expect(extensionFor('image/jpeg')).toBe('jpg');
    expect(extensionFor('application/pdf')).toBe('pdf');
  });

  it('falls back rather than inventing an extension', () => {
    expect(extensionFor('application/x-unheard-of')).toBe('bin');
  });

  it('always uses webp for a derivative, whatever the original was', () => {
    expect(extensionFor('image/png', 'WEB')).toBe('webp');
    expect(extensionFor('application/pdf', 'THUMB')).toBe('webp');
  });
});

describe('sniffContentType', () => {
  it('recognises the formats evidence actually arrives in', () => {
    expect(sniffContentType(JPEG)).toBe('image/jpeg');
    expect(sniffContentType(PNG)).toBe('image/png');
    expect(sniffContentType(PDF)).toBe('application/pdf');
    expect(sniffContentType(ZIP)).toBe('application/zip');
  });

  it('does not mistake a WAV for a WebP', () => {
    // Both begin RIFF. Only the fourcc at offset 8 separates them, and treating
    // every RIFF as an image would hand a decoder something it cannot read.
    const wav = bytes(0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45);
    const webp = bytes(0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50);
    expect(sniffContentType(wav)).toBeNull();
    expect(sniffContentType(webp)).toBe('image/webp');
  });

  it('treats plain text as text rather than as unknown', () => {
    expect(sniffContentType(new TextEncoder().encode('date,hours\n2026-03-03,8'))).toBe('text/plain');
  });

  it('refuses an executable', () => {
    expect(sniffContentType(EXE)).toBeNull();
  });

  it('returns null for empty input rather than guessing', () => {
    expect(sniffContentType(bytes())).toBeNull();
  });
});

describe('sniffedTypeAgrees', () => {
  it('accepts an exact match', () => {
    expect(sniffedTypeAgrees('image/jpeg', 'image/jpeg')).toBe(true);
  });

  it('accepts a docx whose bytes are a zip, because every OOXML file is one', () => {
    expect(
      sniffedTypeAgrees(
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'application/zip'
      )
    ).toBe(true);
  });

  it('accepts a CSV whose bytes are plain text', () => {
    expect(sniffedTypeAgrees('text/csv', 'text/plain')).toBe(true);
  });

  it('accepts a HEIC and a MOV as the ISO container they share', () => {
    expect(sniffedTypeAgrees('image/heic', 'video/mp4')).toBe(true);
    expect(sniffedTypeAgrees('video/quicktime', 'video/mp4')).toBe(true);
  });

  it('REFUSES an executable declared as a photograph', () => {
    // The case the whole SCANNING state exists for.
    expect(sniffedTypeAgrees('image/jpeg', sniffContentType(EXE))).toBe(false);
  });

  it('refuses markup declared as a photograph', () => {
    // HTML is valid text, so `sniffContentType` returns text/plain — and an image
    // is not text, so the comparison still refuses it.
    expect(sniffedTypeAgrees('image/jpeg', sniffContentType(HTML))).toBe(false);
  });

  it('refuses a PDF whose bytes are a PNG', () => {
    expect(sniffedTypeAgrees('application/pdf', 'image/png')).toBe(false);
  });

  it('refuses when nothing could be sniffed at all', () => {
    // Fail closed. "We could not tell" is not "it is fine".
    expect(sniffedTypeAgrees('image/jpeg', null)).toBe(false);
  });
});

describe('isRenderableInline', () => {
  it('renders the things a report needs to show', () => {
    expect(isRenderableInline('image/jpeg')).toBe(true);
    expect(isRenderableInline('application/pdf')).toBe(true);
    expect(isRenderableInline('video/mp4')).toBe(true);
  });

  it('never renders anything that can execute', () => {
    // An SVG is markup with script in it, and a stored file that a browser runs
    // in place is a stored cross-site script.
    expect(isRenderableInline('image/svg+xml')).toBe(false);
    expect(isRenderableInline('text/html')).toBe(false);
    expect(isRenderableInline('application/xhtml+xml')).toBe(false);
  });

  it('downloads anything it does not recognise', () => {
    expect(isRenderableInline('application/octet-stream')).toBe(false);
  });
});

describe('metering', () => {
  it('counts bytes that exist or may still become real', () => {
    expect([...METERED_STATUSES].sort()).toEqual(['PENDING', 'READY', 'SCANNING']);
    // A failed or expired upload must stop being charged, or the meter reports
    // demand that is not there and a customer pays for a mistake.
    expect(METERED_STATUSES).not.toContain('FAILED');
    expect(METERED_STATUSES).not.toContain('EXPIRED');
    expect(METERED_STATUSES).not.toContain('DELETED');
  });

  it('converts bytes to gigabytes as a fraction, not a count', () => {
    // The finding this function exists for: `withinLimit`'s `projected` means
    // "one more of the thing" everywhere else, so a caller taking its default
    // while charging storage would charge a whole gigabyte per upload.
    expect(bytesToGb(1024 ** 3)).toBe(1);
    expect(bytesToGb(512 * 1024 ** 2)).toBe(0.5);
    expect(bytesToGb(3_000_000)).toBeLessThan(0.01);
    expect(bytesToGb(3_000_000)).toBeGreaterThan(0);
  });

  it('round-trips', () => {
    expect(bytesToGb(gbToBytes(25))).toBe(25);
  });

  it('formats a size a person can read', () => {
    expect(formatBytes(1024 ** 3)).toBe('1.0 GB');
    expect(formatBytes(5 * 1024 ** 2)).toBe('5 MB');
    expect(formatBytes(2048)).toBe('2 KB');
    expect(formatBytes(12)).toBe('12 B');
  });
});

describe('wantsDerivatives', () => {
  it('makes them for photographs', () => {
    expect(wantsDerivatives('IMAGE', 'image/jpeg')).toBe(true);
  });

  it('does not make them for documents or video', () => {
    // §22.3: a type badge instead of a thumbnail, and no transcoding.
    expect(wantsDerivatives('DOCUMENT', 'application/pdf')).toBe(false);
    expect(wantsDerivatives('DOCUMENT', 'video/mp4')).toBe(false);
  });

  it('skips GIFs, whose frames a resize would silently discard', () => {
    expect(wantsDerivatives('IMAGE', 'image/gif')).toBe(false);
  });

  it('never derives from a signature', () => {
    expect(wantsDerivatives('SIGNATURE', 'image/png')).toBe(false);
  });

  it('the WEB variant is the larger of the two', () => {
    expect(DERIVATIVE_SPECS.WEB.longEdge).toBeGreaterThan(DERIVATIVE_SPECS.THUMB.longEdge);
  });
});

describe('presignUploadSchema', () => {
  const valid = {
    kind: 'IMAGE',
    filename: 'floor-3-before.jpg',
    contentType: 'image/jpeg',
    byteSize: 2_400_000,
  };

  it('accepts a minimal upload', () => {
    expect(presignUploadSchema.safeParse(valid).success).toBe(true);
  });

  it('refuses a zero or negative size', () => {
    expect(presignUploadSchema.safeParse({ ...valid, byteSize: 0 }).success).toBe(false);
    expect(presignUploadSchema.safeParse({ ...valid, byteSize: -1 }).success).toBe(false);
  });

  it('refuses an unknown kind', () => {
    expect(presignUploadSchema.safeParse({ ...valid, kind: 'ANYTHING' }).success).toBe(false);
  });

  it('accepts a client id, which is what makes a retry idempotent', () => {
    const parsed = presignUploadSchema.safeParse({
      ...valid,
      clientId: '44444444-4444-4444-4444-444444444444',
    });
    expect(parsed.success).toBe(true);
  });

  it('refuses a client id that is not a uuid', () => {
    // A caller-chosen free-text key would let one client collide with another's.
    expect(presignUploadSchema.safeParse({ ...valid, clientId: 'batch-1' }).success).toBe(false);
  });

  it('takes no bucket key from the caller', () => {
    const parsed = presignUploadSchema.parse({ ...valid, bucketKey: 'co/someone-else/x' });
    // A caller who chooses a key chooses a prefix, and a prefix is a tenant.
    expect('bucketKey' in parsed).toBe(false);
  });
});
