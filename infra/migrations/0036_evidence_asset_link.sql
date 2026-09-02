-- The evidence→asset link's own invariant (assets-materials.md §14 step 4).
--
-- `0035` added `project_evidence.asset_id` and `.asset_movement_id` and `8.4`
-- gave them their writer. This is the rule that writer works to, put where a
-- writer cannot forget it: **a movement link implies its line.**
--
-- A movement belongs to exactly one asset line, so the pair is over-determined.
-- `resolveAssetLink` derives the line from the movement on every write and
-- refuses a pair that disagrees — but the PATCH routes can clear either column
-- independently, and "untag the line, keep the movement" is one request away from
-- a photograph whose more specific claim survives its less specific one. That row
-- is invisible in the asset's gallery and present in the movement's, which is a
-- disagreement between two screens rather than an error anybody sees.

alter table project_evidence
  drop constraint if exists project_evidence_movement_implies_asset;
alter table project_evidence
  add constraint project_evidence_movement_implies_asset
  check (asset_movement_id is null or asset_id is not null);

-- ── The composite foreign key this deliberately is NOT ───────────────────────
--
-- The stronger statement is that the two columns must name the SAME line, and
-- `0028` set the precedent for saying so structurally: a unique key on
-- `asset_movements (id, asset_id)` and a composite reference from here would make
-- a mismatched pair unrepresentable rather than merely refused. It was written
-- out and not taken, because both of its spellings are wrong in this shape:
--
--   · `match full` requires all-or-none null, which rejects the ordinary case —
--     a photograph tagged to 42 chairs with no particular movement in mind. That
--     is the majority of the rows this column exists for.
--   · `match simple` permits any null pair through, so it would add nothing the
--     check above does not already say, while its `on delete set null` would blank
--     BOTH columns when a movement is deleted — losing the line link because a leg
--     of its journey was corrected. Postgres 15's per-column `set null` fixes that
--     and makes the constraint a three-part thing to reason about.
--
-- So the equality stays with `resolveAssetLink`, which has the movement's row in
-- hand and can name the disagreement, and the database keeps the half it can
-- state cleanly. Recorded here rather than discovered again by the next person who
-- notices the missing composite key.
comment on constraint project_evidence_movement_implies_asset on project_evidence is
  'A movement link implies its line: asset_movement_id non-null requires asset_id non-null. Equality of the two is enforced by resolveAssetLink, which can name the disagreement (assets-materials.md §14 step 4).';
