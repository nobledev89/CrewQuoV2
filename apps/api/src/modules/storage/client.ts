import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { env } from '../../env';
import { AppError } from '../../http/errors';

/**
 * The S3 client, and the two endpoints that make presigned URLs work.
 *
 * **A presigned URL is signed against a host.** This process reaches the store at
 * `STORAGE_ENDPOINT`; the browser that follows the URL reaches it at
 * `STORAGE_PUBLIC_ENDPOINT`, and locally those differ — the API is in a container
 * where the store is `minio:9000`, the browser is on the host where it is
 * `127.0.0.1:9000`. Sign the internal name and you get a signature that verifies
 * perfectly and resolves nowhere, which is a failure with no error message
 * anywhere in this codebase.
 *
 * So there are two clients. The plain one does server-side work — reading an
 * original back for scanning, writing a derivative, deleting a swept object — and
 * the public one exists **only** to sign URLs that leave the process. In
 * production both point at the same R2 hostname and the distinction costs
 * nothing.
 */

export function storageConfigured(): boolean {
  return Boolean(env.STORAGE_ENDPOINT && env.STORAGE_ACCESS_KEY_ID && env.STORAGE_SECRET_ACCESS_KEY);
}

/**
 * Refuse with a configuration error rather than a provider error.
 *
 * The distinction matters to whoever reads it: "file storage is not configured"
 * sends an operator to the environment, while a raw S3 failure sends them to
 * check whether the bucket is down. Same reasoning as the Paddle helper refusing
 * a missing key permanently rather than retrying it.
 */
function requireConfig(): { endpoint: string; publicEndpoint: string; accessKeyId: string; secretAccessKey: string } {
  if (!storageConfigured()) {
    throw new AppError('CONFLICT', 'File storage is not configured yet, so nothing was uploaded.');
  }
  const endpoint = env.STORAGE_ENDPOINT as string;
  return {
    endpoint,
    publicEndpoint: env.STORAGE_PUBLIC_ENDPOINT ?? endpoint,
    accessKeyId: env.STORAGE_ACCESS_KEY_ID as string,
    secretAccessKey: env.STORAGE_SECRET_ACCESS_KEY as string,
  };
}

let internal: S3Client | null = null;
let publicSigner: S3Client | null = null;

function build(endpoint: string): S3Client {
  const cfg = requireConfig();
  return new S3Client({
    region: env.STORAGE_REGION,
    endpoint,
    // Path style, because MinIO serves buckets as `host/bucket/key` and a
    // virtual-hosted URL would need `bucket.127.0.0.1` to resolve. R2 accepts
    // path style too, so this is one setting rather than two code paths.
    forcePathStyle: true,
    credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
  });
}

/** Server-side operations: this process talking to the store. */
export function s3(): S3Client {
  if (!internal) internal = build(requireConfig().endpoint);
  return internal;
}

/** Signing only. Never used to make a request — its host may not resolve from here. */
function signer(): S3Client {
  if (!publicSigner) publicSigner = build(requireConfig().publicEndpoint);
  return publicSigner;
}

function ttlSeconds(): number {
  return env.STORAGE_URL_TTL_MINUTES * 60;
}

let bucketChecked: Promise<void> | null = null;

/**
 * Make sure the bucket exists, once per process.
 *
 * Local-first convenience with a production-safe shape: a fresh MinIO volume has
 * no bucket and a developer should not have to know that, while R2 buckets are
 * created by whoever owns the account and the API's credentials may well have no
 * permission to create anything. So a failure to create is **swallowed** — if the
 * bucket already exists, nothing was needed; if it genuinely cannot be reached,
 * the very next PUT or GET says so with a real error instead of this one
 * pre-empting it with a misleading permissions message.
 */
export function ensureBucket(): Promise<void> {
  bucketChecked ??= (async () => {
    try {
      await s3().send(new HeadBucketCommand({ Bucket: env.STORAGE_BUCKET }));
    } catch {
      try {
        await s3().send(new CreateBucketCommand({ Bucket: env.STORAGE_BUCKET }));
      } catch {
        // Deliberately silent — see above.
      }
    }
  })();
  return bucketChecked;
}

export interface PresignedPut {
  url: string;
  requiredHeaders: Record<string, string>;
  expiresAt: Date;
}

/**
 * A URL the client may PUT to, once, for a few minutes.
 *
 * `ContentLength` is signed in deliberately. Without it the presign authorises an
 * upload of *any* size, so the `storage_gb` check performed against a declared
 * size becomes a suggestion — a caller could declare one megabyte and put four
 * gigabytes. Signing the length makes the store enforce the number the limit was
 * checked against.
 */
export async function presignPut(args: {
  key: string;
  contentType: string;
  byteSize: number;
}): Promise<PresignedPut> {
  const command = new PutObjectCommand({
    Bucket: env.STORAGE_BUCKET,
    Key: args.key,
    ContentType: args.contentType,
    ContentLength: args.byteSize,
  });
  const url = await getSignedUrl(signer(), command, { expiresIn: ttlSeconds() });
  return {
    url,
    requiredHeaders: {
      'content-type': args.contentType,
      'content-length': String(args.byteSize),
    },
    expiresAt: new Date(Date.now() + ttlSeconds() * 1000),
  };
}

/**
 * A short-lived download URL, minted after the caller's authorization has already
 * been checked against the record that owns the file.
 *
 * `filename` sets `Content-Disposition`. Anything that a browser could execute
 * against the origin serving it is forced to `attachment`; the caller decides
 * that with `inline`, from `isRenderableInline`.
 */
export function presignGet(args: {
  key: string;
  filename: string;
  contentType: string;
  inline: boolean;
}): Promise<string> {
  const disposition = `${args.inline ? 'inline' : 'attachment'}; filename="${args.filename.replace(/["\\]/g, '')}"`;
  const command = new GetObjectCommand({
    Bucket: env.STORAGE_BUCKET,
    Key: args.key,
    ResponseContentDisposition: disposition,
    ResponseContentType: args.contentType,
  });
  return getSignedUrl(signer(), command, { expiresIn: ttlSeconds() });
}

/** What the store says is actually there. The client's claim is not evidence. */
export async function headObject(key: string): Promise<{ byteSize: number } | null> {
  try {
    const res = await s3().send(new HeadObjectCommand({ Bucket: env.STORAGE_BUCKET, Key: key }));
    return { byteSize: Number(res.ContentLength ?? 0) };
  } catch {
    return null;
  }
}

export async function getObjectBytes(key: string): Promise<Buffer> {
  const res = await s3().send(new GetObjectCommand({ Bucket: env.STORAGE_BUCKET, Key: key }));
  const body = res.Body as { transformToByteArray?: () => Promise<Uint8Array> } | undefined;
  if (!body?.transformToByteArray) throw new Error(`object ${key} had no readable body`);
  return Buffer.from(await body.transformToByteArray());
}

export async function putObject(args: { key: string; body: Buffer; contentType: string }): Promise<void> {
  await s3().send(
    new PutObjectCommand({
      Bucket: env.STORAGE_BUCKET,
      Key: args.key,
      Body: args.body,
      ContentType: args.contentType,
    })
  );
}

export async function deleteObject(key: string): Promise<void> {
  await s3().send(new DeleteObjectCommand({ Bucket: env.STORAGE_BUCKET, Key: key }));
}
