import { z } from 'zod';

/**
 * The storage layer's policy, as pure functions (CREWQUO_V2_PLAN.md §22.1, and
 * step 3 of `docs/operating-model/project-evidence.md` §14).
 *
 * Everything here decides *whether* and *where*, never *how* — no S3 client, no
 * filesystem, no database. The API loads rows and calls these, the way it does
 * with the rate engine, so every branch below is a unit test rather than a
 * fixture and a live bucket.
 */

// ── Kinds, types and sizes ───────────────────────────────────────────────────

export const FILE_KINDS = ['IMAGE', 'DOCUMENT', 'SIGNATURE', 'EXPORT'] as const;
export const fileKindSchema = z.enum(FILE_KINDS);
export type FileKind = z.infer<typeof fileKindSchema>;

export const FILE_VARIANTS = ['ORIGINAL', 'WEB', 'THUMB'] as const;
export const fileVariantSchema = z.enum(FILE_VARIANTS);
export type FileVariant = z.infer<typeof fileVariantSchema>;

/**
 * `SCANNING` is a fifth state §22.1's `check` constraint does not list, and
 * `EXPIRED` is a sixth. Both earn their place in
 * `project-evidence.md` §3 and §13.5:
 *
 * `SCANNING` exists because the API cannot sniff a content type it never
 * receives. §22.1 says bytes never pass through the API *and* that type is
 * sniffed on complete; the derivative worker downloads the original anyway, so
 * validation goes there and `READY` is the worker's to set.
 *
 * `EXPIRED` exists because a presign that is never completed is otherwise a row
 * claiming bytes that do not exist — and it is counted by the storage meter for
 * ever, which is a slow leak that reads as a customer using more than they are.
 */
export const FILE_STATUSES = ['PENDING', 'SCANNING', 'READY', 'FAILED', 'EXPIRED', 'DELETED'] as const;
export const fileStatusSchema = z.enum(FILE_STATUSES);
export type FileStatus = z.infer<typeof fileStatusSchema>;

/** Statuses whose bytes are, or may still become, real. These are what the meter counts. */
export const METERED_STATUSES: readonly FileStatus[] = ['PENDING', 'SCANNING', 'READY'];

/**
 * An unfinished upload is swept after this long.
 *
 * Long enough that a genuine slow upload over a bad connection is never cut off
 * mid-flight — Ade's stairwell is the case this number exists for — and short
 * enough that an abandoned batch stops being charged the same day.
 */
export const PENDING_UPLOAD_TTL_HOURS = 24;

export interface FileTypeRule {
  kind: FileKind;
  contentTypes: readonly string[];
  maxBytes: number;
}

const MB = 1024 * 1024;

/**
 * What each kind may hold, and how big.
 *
 * An allowlist, not a denylist, and the reason is the same one the Sentry
 * scrubber records: a denylist has to be extended by whoever adds the next case,
 * who is exactly the person who has not read the rule. A type absent from here
 * is refused, which is the safe direction.
 *
 * `image/svg+xml` is deliberately **not** an image. An SVG is a document that can
 * execute script, and the one thing this store must never do is serve executable
 * markup that a browser will run — see `isRenderableInline`.
 */
export const FILE_TYPE_RULES: Record<FileKind, FileTypeRule> = {
  IMAGE: {
    kind: 'IMAGE',
    contentTypes: ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'image/gif'],
    // A modern phone camera produces 5–12 MB; 40 MB leaves room for a raw-ish
    // capture without leaving room for somebody's video renamed to .jpg.
    maxBytes: 40 * MB,
  },
  DOCUMENT: {
    kind: 'DOCUMENT',
    contentTypes: [
      'application/pdf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'text/csv',
      'text/plain',
      'video/mp4',
      'video/quicktime',
    ],
    // §22.3 accepts a short video as evidence and explicitly does not transcode
    // it, so the document ceiling is the one that has to hold a phone clip.
    maxBytes: 200 * MB,
  },
  SIGNATURE: {
    kind: 'SIGNATURE',
    contentTypes: ['image/png', 'image/svg+xml'],
    // A signature is strokes. Anything approaching a megabyte is not one.
    maxBytes: 2 * MB,
  },
  EXPORT: {
    kind: 'EXPORT',
    contentTypes: ['application/zip', 'application/pdf', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
    maxBytes: 500 * MB,
  },
};

export interface UploadRefusal {
  code: 'UNSUPPORTED_TYPE' | 'TOO_LARGE' | 'EMPTY';
  message: string;
}

/** Is this declared upload allowed at all? Checked at presign, before any bytes move. */
export function refuseUpload(args: {
  kind: FileKind;
  contentType: string;
  byteSize: number;
}): UploadRefusal | null {
  const rule = FILE_TYPE_RULES[args.kind];
  const declared = normalizeContentType(args.contentType);
  if (!rule.contentTypes.includes(declared)) {
    return {
      code: 'UNSUPPORTED_TYPE',
      message: `${args.contentType} cannot be stored as ${args.kind}`,
    };
  }
  if (args.byteSize <= 0) {
    return { code: 'EMPTY', message: 'A file must have a size' };
  }
  if (args.byteSize > rule.maxBytes) {
    return {
      code: 'TOO_LARGE',
      message: `${args.kind} files are limited to ${Math.floor(rule.maxBytes / MB)} MB`,
    };
  }
  return null;
}

/** `image/JPEG; charset=x` and `image/jpeg` are the same claim. */
export function normalizeContentType(raw: string): string {
  return raw.split(';')[0]?.trim().toLowerCase() ?? '';
}

// ── Key layout ───────────────────────────────────────────────────────────────

/**
 * §22.1's key layout: `co/{companyId}/proj/{projectId}/{kind}/{fileId}/{variant}.{ext}`.
 *
 * Company-scoped prefixes make per-tenant deletion and usage metering a prefix
 * operation rather than a table scan. The key is **derived here and never
 * accepted from the client**: a caller who chooses their own key chooses a
 * prefix, and a prefix is a tenant.
 */
export function buildBucketKey(args: {
  companyId: string;
  projectId: string | null;
  kind: FileKind;
  fileId: string;
  variant: FileVariant;
  contentType: string;
}): string {
  const scope = args.projectId ? `proj/${args.projectId}` : 'company';
  const ext = extensionFor(args.contentType, args.variant);
  return `co/${args.companyId}/${scope}/${args.kind}/${args.fileId}/${args.variant.toLowerCase()}.${ext}`;
}

const EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'image/heif': 'heif',
  'image/gif': 'gif',
  'image/svg+xml': 'svg',
  'application/pdf': 'pdf',
  'application/zip': 'zip',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'text/csv': 'csv',
  'text/plain': 'txt',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
};

export function extensionFor(contentType: string, variant: FileVariant = 'ORIGINAL'): string {
  // Derivatives are always WebP whatever the original was — that is what makes
  // them small, and the original is retained beside them regardless.
  if (variant !== 'ORIGINAL') return 'webp';
  return EXTENSIONS[normalizeContentType(contentType)] ?? 'bin';
}

// ── Content sniffing ─────────────────────────────────────────────────────────

interface Signature {
  contentType: string;
  offset: number;
  bytes: readonly number[];
}

/**
 * Magic numbers, checked against the object's own leading bytes by the worker
 * that downloads it (§13.5). The client's declared type is a claim; this is the
 * only evidence of what the file actually is.
 */
const SIGNATURES: readonly Signature[] = [
  { contentType: 'image/jpeg', offset: 0, bytes: [0xff, 0xd8, 0xff] },
  { contentType: 'image/png', offset: 0, bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { contentType: 'image/gif', offset: 0, bytes: [0x47, 0x49, 0x46, 0x38] },
  // RIFF....WEBP — the four size bytes between are why this needs two checks.
  { contentType: 'image/webp', offset: 0, bytes: [0x52, 0x49, 0x46, 0x46] },
  { contentType: 'application/pdf', offset: 0, bytes: [0x25, 0x50, 0x44, 0x46] },
  // Every OOXML file and every ordinary archive is a zip. `PK\x03\x04`.
  { contentType: 'application/zip', offset: 0, bytes: [0x50, 0x4b, 0x03, 0x04] },
  { contentType: 'application/msword', offset: 0, bytes: [0xd0, 0xcf, 0x11, 0xe0] },
  // ISO base media (mp4, mov, heic) — `ftyp` at offset 4, brand decides which.
  { contentType: 'video/mp4', offset: 4, bytes: [0x66, 0x74, 0x79, 0x70] },
];

/**
 * What the bytes say this is, or null when nothing matches.
 *
 * Deliberately coarse. It answers "is this plausibly the family of thing it
 * claims to be", not "which exact MIME type is this", because the question that
 * matters is whether an executable or a script has been dressed as a photograph.
 */
export function sniffContentType(head: Uint8Array): string | null {
  for (const sig of SIGNATURES) {
    if (matches(head, sig)) {
      if (sig.contentType === 'image/webp') {
        // RIFF is also WAV and AVI. Require the WEBP fourcc at offset 8.
        const isWebp = matches(head, { offset: 8, bytes: [0x57, 0x45, 0x42, 0x50] });
        if (!isWebp) continue;
      }
      return sig.contentType;
    }
  }
  // Text has no magic number. A file that is valid UTF-8 with no control bytes is
  // treated as text rather than as unknown, or every CSV would be refused.
  return looksLikeText(head) ? 'text/plain' : null;
}

function matches(head: Uint8Array, sig: { offset: number; bytes: readonly number[] }): boolean {
  if (head.length < sig.offset + sig.bytes.length) return false;
  return sig.bytes.every((b, i) => head[sig.offset + i] === b);
}

function looksLikeText(head: Uint8Array): boolean {
  if (head.length === 0) return false;
  for (const byte of head) {
    // Allow tab, newline, carriage return; refuse the other control codes and NUL.
    if (byte === 0x09 || byte === 0x0a || byte === 0x0d) continue;
    if (byte < 0x20 || byte === 0x7f) return false;
  }
  return true;
}

/**
 * Does what the bytes say agree with what was declared?
 *
 * Families rather than exact equality, because a browser legitimately labels a
 * `.docx` as OOXML while its bytes are a zip, and a `.heic` and an `.mp4` share
 * the ISO base media container. Refusing those would refuse real evidence; what
 * this must catch is a declared image whose bytes are an executable, a script or
 * markup.
 */
export function sniffedTypeAgrees(declared: string, sniffed: string | null): boolean {
  if (sniffed === null) return false;
  const want = normalizeContentType(declared);
  if (want === sniffed) return true;

  const family = (t: string): string => {
    if (t === 'application/zip') return 'zip';
    if (t.startsWith('application/vnd.openxmlformats')) return 'zip';
    if (t === 'video/mp4' || t === 'video/quicktime') return 'iso-bmff';
    if (t === 'image/heic' || t === 'image/heif') return 'iso-bmff';
    if (t === 'text/csv' || t === 'text/plain') return 'text';
    return t;
  };
  return family(want) === family(sniffed);
}

/**
 * May this be served with a content type the browser will render in place?
 *
 * The answer is no for anything that can execute against the origin serving it.
 * Evidence is served from the storage origin rather than the app's, which is the
 * structural half of this; refusing inline rendering for markup is the half that
 * survives somebody later putting a proxy in front.
 */
export function isRenderableInline(contentType: string): boolean {
  const t = normalizeContentType(contentType);
  if (t === 'image/svg+xml') return false;
  if (t === 'text/html' || t === 'application/xhtml+xml') return false;
  return t.startsWith('image/') || t === 'application/pdf' || t.startsWith('video/');
}

// ── Metering ─────────────────────────────────────────────────────────────────

const BYTES_PER_GB = 1024 * 1024 * 1024;

/**
 * Bytes as gigabytes, for the `storage_gb` limit.
 *
 * **This is where `projected` stops meaning "one more of the thing".** Every
 * other call site of `withinLimit` counts objects — one more subcontractor, one
 * more client — and its default of `1` is right for all of them. Storage's unit
 * is a gigabyte, so a caller taking the default would charge a full gigabyte per
 * upload. Named as a function so the conversion happens once, at the boundary,
 * and so the call site reads as the unit change it is.
 */
export function bytesToGb(bytes: number): number {
  return bytes / BYTES_PER_GB;
}

export function gbToBytes(gb: number): number {
  return gb * BYTES_PER_GB;
}

/** Human sizes for a refusal message. Never for a stored value. */
export function formatBytes(bytes: number): string {
  if (bytes >= BYTES_PER_GB) return `${(bytes / BYTES_PER_GB).toFixed(1)} GB`;
  if (bytes >= MB) return `${Math.round(bytes / MB)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

// ── Contracts ────────────────────────────────────────────────────────────────

/**
 * POST /v1/files/presign
 *
 * `clientId` is the offline contract's idempotency key (§8), and it matters more
 * here than anywhere else in the product: a replayed presign without it mints a
 * second bucket key, so the retry that Ade's tablet makes in a stairwell leaves
 * an orphaned charge against somebody's storage allowance for bytes nothing
 * references.
 */
export const presignUploadSchema = z.object({
  kind: fileKindSchema,
  filename: z.string().trim().min(1).max(255),
  contentType: z.string().trim().min(1).max(255),
  byteSize: z.number().int().positive(),
  projectId: z.string().uuid().nullable().optional(),
  clientId: z.string().uuid().optional(),
});
export type PresignUpload = z.infer<typeof presignUploadSchema>;

export const presignedUploadSchema = z.object({
  fileId: z.string().uuid(),
  uploadUrl: z.string().url(),
  /** Headers the client MUST send with the PUT, or the signature will not verify. */
  requiredHeaders: z.record(z.string()),
  expiresAt: z.string(),
  /** True when this presign replayed an existing one rather than creating a row. */
  replayed: z.boolean(),
});
export type PresignedUpload = z.infer<typeof presignedUploadSchema>;

/** POST /v1/files/:id/complete — what the client observed after its PUT. */
export const completeUploadSchema = z.object({
  byteSize: z.number().int().positive().optional(),
  checksumSha256: z
    .string()
    .trim()
    .regex(/^[a-f0-9]{64}$/i)
    .optional(),
});
export type CompleteUpload = z.infer<typeof completeUploadSchema>;

export const storedFileSchema = z.object({
  id: z.string().uuid(),
  companyId: z.string().uuid(),
  projectId: z.string().uuid().nullable(),
  originalFilename: z.string(),
  contentType: z.string(),
  byteSize: z.number().int(),
  checksumSha256: z.string().nullable(),
  kind: fileKindSchema,
  variant: fileVariantSchema,
  status: fileStatusSchema,
  failureReason: z.string().nullable(),
  uploadedByUserId: z.string().uuid(),
  createdAt: z.string(),
});
export type StoredFile = z.infer<typeof storedFileSchema>;

// ── Derivatives ──────────────────────────────────────────────────────────────

/**
 * §22.1's two derivative sizes. **The `ORIGINAL` is always retained** — a
 * compressed-only pipeline destroys the one property that makes a photograph
 * evidence, and no amount of storage saving is worth that.
 */
export const DERIVATIVE_SPECS: Record<'WEB' | 'THUMB', { longEdge: number; quality: number }> = {
  // Tuned for print at report size (§22.1), not for a screen.
  WEB: { longEdge: 2000, quality: 82 },
  THUMB: { longEdge: 400, quality: 70 },
};

/** Only raster images get derivatives. A PDF or a video gets a type badge instead (§22.3). */
export function wantsDerivatives(kind: FileKind, contentType: string): boolean {
  if (kind !== 'IMAGE') return false;
  const t = normalizeContentType(contentType);
  return t !== 'image/gif' && t.startsWith('image/');
}
