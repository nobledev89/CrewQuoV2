import { evidenceGrantsFileAccess, fileDisclosedToClient } from '../evidence/repo';
import { documentDisclosedToClient, documentGrantsFileAccess } from '../documents/repo';
import {
  brandingGrantsFileAccess,
  reportFileDisclosedToClient,
  reportGrantsFileAccess,
} from '../reports/repo';
import { signoffGrantsFileAccess } from '../reports/signoff';
import {
  variationFileDisclosedToClient,
  variationGrantsFileAccess,
} from '../variations/repo';
import { complianceFileGrantsAccess } from '../compliance/repo';

/**
 * Which records may grant a company access to a file, as a **registry**.
 *
 * The storage layer's own floor — the uploading company and the project owner —
 * is in `storage/routes.ts` and is unchanged. This is the layer above it: the
 * packet's §4 rule that a download is governed by *"whichever hop the referencing
 * record allows"*.
 *
 * **A registry rather than a chain of `if`s, and it is the same argument
 * `LOCATION_REFERENCE_TABLES` makes.** Every later phase adds a record type that
 * points at `stored_files` — the diary's attachments in 7.5, asset weight
 * documents in Phase 8, sign-off signatures in §34 — and a condition written
 * inline in the download route is one each of those authors has to remember to
 * extend. The one who forgets either leaks a file or, more likely and more
 * quietly, hides one that should be readable and produces a broken image nobody
 * can explain.
 *
 * Two kinds of grant, deliberately separate:
 *
 *  - **`grants`** widen to a company already inside the project's own two hops —
 *    the uploader's company, the provider a document is filed against.
 *  - **`disclosures`** widen to the *client*, who is outside them entirely, and
 *    only because somebody deliberately published. This is the half that
 *    contradicts the note 7.0 shipped with (*"nothing will ever widen it"*), and
 *    keeping it in its own list is what stops the contradiction being accidental
 *    the next time somebody adds a record type.
 *
 * Every entry resolves derivatives through their original's record, so a
 * thumbnail is never a way around a rule its full-size file obeys.
 */

export type FileAccessCheck = (fileId: string, companyId: string) => Promise<boolean>;

/** Grants inside the project's own two hops. */
export const FILE_ACCESS_GRANTS: readonly FileAccessCheck[] = [
  evidenceGrantsFileAccess,
  documentGrantsFileAccess,
  /*
   * Phase 10. `reportGrantsFileAccess` covers the rendered PDF and everything a
   * frozen document cites; `signoffGrantsFileAccess` covers a captured signature;
   * `brandingGrantsFileAccess` is decision #30's one-hop read — a contractor
   * renders its client's own logo, and the asset therefore has to cross the edge.
   */
  reportGrantsFileAccess,
  signoffGrantsFileAccess,
  brandingGrantsFileAccess,
  /*
   * Phase 11. §30.1's `approval_evidence_file_id` is the photograph of the signed
   * docket, and it takes `on delete restrict` for the reason a signature does — it
   * is the one file whose loss makes the record worthless. This grant is the
   * ordinary two-hop one: the company that raised the variation and the company
   * that owns the project.
   */
  variationGrantsFileAccess,
  // Phase 12: self-filed company compliance crosses only a direct hiring edge.
  complianceFileGrantsAccess,
];

/** Deliberate disclosures to the client on the project's engagement. */
export const FILE_CLIENT_DISCLOSURES: readonly FileAccessCheck[] = [
  fileDisclosedToClient,
  documentDisclosedToClient,
  /*
   * **The live caller that made the Phase 10 hold worth building now** rather than
   * alongside a retention sweep that does not exist yet
   * (`reporting-signoff.md` §0 finding 6).
   *
   * Without it, a photograph inside a signed completion report that was never
   * individually published returns 403 to the very client holding the signed
   * document. The grant is narrower than publishing the photograph: it says *"a
   * document you were given cites this"*, so it covers exactly the images in that
   * document and nothing else on the project — and it expires with nothing,
   * because the document does not expire.
   */
  reportFileDisclosedToClient,
  /*
   * And Phase 11's, on the same narrow shape: *"a variation you approved cites
   * this."* `APPROVED` and later only, and only on a project whose client is this
   * company — so a client may open the docket they signed without that photograph
   * being published to them generally. `DRAFT` and `SUBMITTED` never cross, because
   * a price the contractor is still thinking about is not a disclosure.
   */
  variationFileDisclosedToClient,
];

/**
 * Does any record let this company read this file?
 *
 * Sequential rather than `Promise.all`, because the common answer is the first
 * one: a gallery asking for a signed URL per visible tile would otherwise run
 * every check in the registry for every tile, and the list only grows.
 */
export async function referencedFileIsReadable(
  fileId: string,
  companyId: string
): Promise<boolean> {
  for (const check of [...FILE_ACCESS_GRANTS, ...FILE_CLIENT_DISCLOSURES]) {
    if (await check(fileId, companyId)) return true;
  }
  return false;
}
