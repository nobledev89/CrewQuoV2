import { createHash } from 'node:crypto';
import { jsPDF } from 'jspdf';
import { fileIdFromContentHash, pdfCreationDate } from '@crewquo/shared';

/**
 * The one place a PDF is created, and the reason it exists is the Phase 10
 * milestone: *"a client-ready PDF from real data, **regenerable byte-identical** a
 * year later."*
 *
 * ── WHAT THIS FIXES ──────────────────────────────────────────────────────────
 *
 * `new jsPDF(...)` is **not deterministic**, and the two ways it is not are both
 * invisible to anybody comparing the rendered pages. `docs/operating-model/
 * reporting-signoff.md` §0 finding 1 has the measurement; the short version is
 * that jsPDF stamps every document with
 *
 *     /CreationDate (D:20260903072126+08'00')     <- new Date(), local offset
 *     /ID [ <F3A1…> <F3A1…> ]                     <- 32 chars of Math.random()
 *
 * so two renders of byte-identical content differ, the same document rendered on
 * Render and on a laptop differs, and §44's reproducibility test fails for reasons
 * that have nothing to do with the numbers. The failure mode that makes it worth a
 * file of its own is that the obvious conclusion, on seeing two visually identical
 * PDFs fail an equality assertion, is that the assertion is wrong.
 *
 * ── AND WHY THE FIX IS BETTER THAN A PASSING TEST ────────────────────────────
 *
 * The creation date becomes a fact about the **report** — the instant its numbers
 * were true as of — rather than about the machine that happened to render it. And
 * the `/ID` becomes the first half of the content hash of the snapshot, which is
 * what a PDF `/ID` is specified to mean: two files carrying the same one are two
 * renders of the same frozen content. A reader with two copies of a report can
 * compare thirty-two characters instead of trusting a filename.
 *
 * Every renderer in the codebase goes through here. A `new jsPDF()` anywhere else
 * is a document that cannot be reproduced, and `determinism.test.ts` is what keeps
 * that true.
 */

export interface DocumentIdentity {
  /**
   * What the `/ID` is derived from.
   *
   * For a §29.4 report this is the snapshot's `content_hash`, used directly. For a
   * live export — Phase 4's project PDF, which is not a record and has no seal —
   * it is any stable string describing the request; `seedFromParts` hashes it.
   */
  seal: string;
  /** ISO instant. Becomes `/CreationDate`, pinned to UTC. */
  createdAt: string;
}

/** A 64-hex seal from any stable description of a document. */
export function seedFromParts(...parts: string[]): string {
  return createHash('sha256').update(parts.join('\u0000')).digest('hex');
}

/**
 * A4 portrait, compressed, and reproducible.
 *
 * Compression is deterministic — zlib at a fixed level over identical input — so
 * it stays on: an uncompressed report with a hundred photographs is several times
 * the size for no benefit.
 */
export function createDocument(identity: DocumentIdentity): jsPDF {
  const doc = new jsPDF({ unit: 'pt', format: 'a4', compress: true });
  doc.setFileId(fileIdFromContentHash(identity.seal));
  // The string form, not a `Date`: jsPDF's own Date conversion formats in the
  // rendering machine's local zone, which is half of finding 1.
  doc.setCreationDate(pdfCreationDate(identity.createdAt));
  return doc;
}
