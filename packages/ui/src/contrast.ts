/**
 * WCAG 2.2 contrast, and the pairings this design system actually renders.
 *
 * Why this lives here rather than in a linter or a scanner run: `@axe-core/playwright`
 * can only measure the pairings a page happened to put on screen while it was looking.
 * The exploratory inventory on 2026-08-20 proved that limit twice over — it reported one
 * rule from one token across 8 screens, and it missed a placeholder at 2.87:1 (no screen
 * in the sample had a placeholder rendered) and an input border at 1.59:1 (axe has no
 * border-contrast rule at all). A token table checked arithmetically has no sample.
 *
 * So the two halves are deliberately different in kind and both are kept:
 *   - this file and its test prove the *tokens* are sound, exhaustively, offline;
 *   - the axe spec proves the *pages* use them the way this file assumes.
 * Neither subsumes the other. A token can be correct and applied to the wrong surface,
 * and a page can pass axe on the one screen that renders it.
 */

/** SC 1.4.3, normal text — anything under 18.66px bold or 24px regular. */
export const AA_TEXT = 4.5;
/** SC 1.4.3, large text — 18.66px bold or 24px regular and up. */
export const AA_TEXT_LARGE = 3;
/**
 * SC 1.4.11, non-text — the visual information required to identify a UI component
 * or its state. Not decoration: a panel edge or a table rule is exempt, a control's
 * only boundary is not.
 */
export const AA_NON_TEXT = 3;

/** Parse `#rgb` or `#rrggbb` into 0–255 channels. Throws rather than guessing. */
export function parseHex(hex: string): [number, number, number] {
  const h = hex.trim().toLowerCase();
  // Expanding #rgb to #rrggbb first keeps one parse path instead of two.
  const expanded = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(h);
  const normalised = expanded ? `#${expanded[1]!.repeat(2)}${expanded[2]!.repeat(2)}${expanded[3]!.repeat(2)}` : h;
  const long = /^#([0-9a-f]{6})$/.exec(normalised);
  if (!long) throw new Error(`not a hex colour: ${hex}`);
  const n = parseInt(long[1]!, 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

/** The sRGB→linear transfer function, applied per channel. */
function linearise(channel255: number): number {
  const s = channel255 / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

/**
 * WCAG relative luminance. The 0.03928 threshold and the 2.4 exponent are the
 * specification's own numbers; do not "simplify" them to a gamma of 2.2, which
 * shifts results either side of the 4.5 boundary for mid greys — precisely the
 * range every one of these tokens sits in.
 */
export function relativeLuminance(hex: string): number {
  const [r, g, b] = parseHex(hex);
  return 0.2126 * linearise(r) + 0.7152 * linearise(g) + 0.0722 * linearise(b);
}

/** Contrast ratio, 1–21. Order-independent. */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/**
 * A pairing that the stylesheet genuinely produces, with the floor it has to clear.
 *
 * `on` is every surface the foreground can land on — enumerated by reading the rules
 * that use it, not by listing every surface token. A foreground that never renders on
 * `--cq-accent-soft` should not be held to it, and holding it there is not free: it
 * forces the muted tier darker than it needs to be, which compresses the grey ramp
 * for no accessible gain.
 */
export interface Pairing {
  readonly what: string;
  readonly fg: string;
  readonly on: readonly string[];
  readonly floor: number;
}

/**
 * How far a surface may be nudged before the gate is allowed to care: three steps per
 * channel, one shade.
 *
 * A pairing has to clear its floor *after* that nudge, not just as written. The first
 * version of this rule was a flat `REQUIRED_MARGIN = 0.35` over the floor, which is a
 * number with no argument behind it — and it mattered, because that arbitrary margin
 * condemned `--cq-accent` and `--cq-success`, both of which survive the rule below. A
 * margin invented to be safe had been about to restyle the brand blue.
 *
 * What contrast actually drifts from is *authoring*, not rendering: axe and this file
 * both read declared colours, so anti-aliasing never moves the ratio. What moves it is
 * somebody deepening `--cq-success-soft` a shade next quarter. So the rule states that
 * directly — one shade of edit to a background may not break a foreground on it — and
 * the threshold is a claim that can be argued with instead of a constant that cannot.
 */
export const SURFACE_DRIFT_STEPS = 3;

/**
 * The lowest ratio `fg` on `bg` can fall to if `bg` is edited by one shade in the
 * least helpful direction — each channel moved `SURFACE_DRIFT_STEPS` toward `fg`.
 */
export function driftedRatio(fg: string, bg: string, steps = SURFACE_DRIFT_STEPS): number {
  const [fr, fg_, fb] = parseHex(fg);
  const [br, bg_, bb] = parseHex(bg);
  const toward = (from: number, to: number): number =>
    Math.max(0, Math.min(255, from + Math.sign(to - from) * steps));
  const nudged: [number, number, number] = [toward(br, fr), toward(bg_, fg_), toward(bb, fb)];
  const hex = '#' + nudged.map((c) => c.toString(16).padStart(2, '0')).join('');
  return contrastRatio(fg, hex);
}

/**
 * Every pairing the stylesheet renders, as read off the rules in `styles.css`.
 *
 * The grey ramp is three steps and each is ~15 L* from the next: #20242c (L*14),
 * #414957 (L*31), #616a79 (L*45). It has to be spread that deliberately, because AA's
 * 4.5 floor on a light background puts the *lightest* usable grey at about L*45 — so a
 * ramp that keeps its top two tiers where they were and only fixes the bottom one ends
 * up with the bottom two 3 L* apart and visually identical. Fixing the failing token
 * alone would have passed this file and quietly collapsed the hierarchy to two tiers.
 */
export const PAIRINGS: readonly Pairing[] = [
  // ── Text: SC 1.4.3 ──────────────────────────────────────────────────────────
  // The three text tokens render on the page, on panels, and on the subtle fill used
  // by table headers, notices and badges. Nothing paints them onto a *-soft surface.
  {
    what: '--cq-text (body copy)',
    fg: '--cq-text',
    on: ['--cq-canvas', '--cq-surface', '--cq-surface-subtle', '--cq-surface-hover', '--cq-surface-selected'],
    floor: AA_TEXT,
  },
  {
    what: '--cq-text-secondary (labels, table headers, nav, badges, notices)',
    fg: '--cq-text-secondary',
    // --cq-surface-selected because `.cq-rail__link[aria-current] .cq-rail__count`
    // promotes the count from muted to secondary exactly when the row is selected.
    on: ['--cq-canvas', '--cq-surface', '--cq-surface-subtle', '--cq-surface-hover', '--cq-surface-selected'],
    floor: AA_TEXT,
  },
  {
    // 23 usages and every one of them small — 10px nav labels through 13px hints.
    // Small is not "large text": SC 1.4.3's relaxed 3:1 starts at 18.66px bold, so
    // none of these get it, and the placeholder inherits this token for the same reason.
    what: '--cq-text-muted (hints, meta, eyebrows, counts, placeholders)',
    fg: '--cq-text-muted',
    on: ['--cq-canvas', '--cq-surface', '--cq-surface-subtle', '--cq-surface-hover', '--cq-surface-selected'],
    floor: AA_TEXT,
  },
  // Status text only ever appears on its own soft fill (.cq-badge--*) or on a surface
  // (.cq-btn--danger's label). Both are listed; neither is assumed from the other.
  {
    what: '--cq-danger (danger badge label, .cq-btn--danger label)',
    fg: '--cq-danger',
    on: ['--cq-danger-soft', '--cq-surface', '--cq-canvas'],
    floor: AA_TEXT,
  },
  {
    what: '--cq-success (success badge label)',
    fg: '--cq-success',
    on: ['--cq-success-soft', '--cq-surface'],
    floor: AA_TEXT,
  },
  {
    what: '--cq-warning (warning badge label)',
    fg: '--cq-warning',
    on: ['--cq-warning-soft', '--cq-surface'],
    floor: AA_TEXT,
  },
  {
    what: '--cq-accent (links)',
    fg: '--cq-accent',
    // Not --cq-surface-selected: both rules that use it set `color: var(--cq-text)`,
    // so no accent link ever lands there. Listing it anyway would demand 4.85:1 from
    // a pairing that does not exist and force the brand blue darker for nothing —
    // which is the mistake the arbitrary-margin version of this file nearly made.
    on: ['--cq-canvas', '--cq-surface', '--cq-surface-subtle', '--cq-surface-hover'],
    floor: AA_TEXT,
  },
  {
    what: '--cq-accent-fg (primary button label on --cq-accent)',
    fg: '--cq-accent-fg',
    on: ['--cq-accent', '--cq-accent-hover', '--cq-accent-active'],
    floor: AA_TEXT,
  },

  // ── Component identity: SC 1.4.11 ───────────────────────────────────────────
  // An input's fill is --cq-surface and the panel behind it is usually --cq-surface
  // too, so the border is the whole of what says "this is a field". It is checked
  // against the page as well: a filter input can sit directly on --cq-canvas.
  {
    what: '--cq-border-strong (input/select/icon-button/secondary-button boundary)',
    fg: '--cq-border-strong',
    on: ['--cq-surface', '--cq-canvas', '--cq-surface-subtle', '--cq-surface-hover'],
    floor: AA_NON_TEXT,
  },
  {
    // The focus ring is the state indicator for every control in the product, and
    // :focus-visible is the only thing a keyboard-only user has to navigate by.
    what: '--cq-accent (focus ring)',
    fg: '--cq-accent',
    on: ['--cq-surface', '--cq-canvas', '--cq-surface-subtle', '--cq-surface-hover', '--cq-surface-selected'],
    floor: AA_NON_TEXT,
  },
];

/**
 * Literal colours in `styles.css` that are deliberately not tokens, with the reason.
 *
 * The test asserts this list is exhaustive, so a new hardcoded colour fails the build
 * until somebody writes down why it is allowed. That is the mechanism the placeholder
 * needed: `#9299a5` was a literal at 2.87:1, invisible to the token table because it
 * was not in the token table, and invisible to axe because no sampled screen rendered
 * an empty field. It was found by reading the file, which is not a strategy.
 */
export const ALLOWED_LITERALS: readonly { readonly value: string; readonly why: string }[] = [
  { value: '#fff', why: '.cq-skip-link and .cq-brand__mark labels on --cq-text: 15.55:1' },
  { value: '#6d7583', why: '.cq-nav-link__icon — decorative glyph beside its own text label; 4.64:1 regardless' },
  { value: '#e8edf8', why: '.cq-account__avatar fill, carries the initials below' },
  { value: '#294266', why: '.cq-account__avatar initials on #e8edf8: 8.67:1' },
  { value: '#adb3bd', why: '.cq-breadcrumbs__separator — aria-hidden="true", so pure decoration and exempt from 1.4.3' },
  { value: '#1849ba', why: '.cq-badge--accent label on --cq-accent-soft: 7.00:1' },
  { value: '#cbd8ff', why: '.cq-badge--accent border — badge is identified by its label, not its edge' },
  { value: '#bde5c8', why: '.cq-badge--success border — decorative' },
  { value: '#edd3a5', why: '.cq-badge--warning border — decorative' },
  { value: '#e4a39d', why: '.cq-badge--danger border and .cq-btn--danger:hover — decorative' },
  { value: '#e19b27', why: '.cq-badge--warning dot — decorative, label carries the state' },
  { value: '#6b7280', why: '.cq-input:hover and .cq-btn--secondary:hover borders — darker than the resting border, not lighter' },
  { value: '#dce7ff', why: '::selection background — user-agent-style selection tint' },
];
