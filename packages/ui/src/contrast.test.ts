import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  AA_NON_TEXT,
  AA_TEXT,
  ALLOWED_LITERALS,
  PAIRINGS,
  contrastRatio,
  driftedRatio,
  parseHex,
  relativeLuminance,
} from './contrast';

/**
 * The stylesheet is read, never restated.
 *
 * A second copy of the token values in this file would be the drifting duplicate the
 * repo has removed three times now (rate-card currency, the portal payload, `todayIso`).
 * The whole point of this test is to fail when `styles.css` changes, so it has to be
 * looking at `styles.css`.
 */
const CSS = readFileSync(fileURLToPath(new URL('./styles.css', import.meta.url)), 'utf8');

/**
 * The `:root` block only — a token is a declaration there, not any `--cq-*` mention.
 *
 * Comments are stripped for the same reason the literal scan strips them: `:root` is now
 * commented, those comments name tokens, and a parser that cannot tell an explanation
 * from a declaration is one prose edit away from inventing a token or missing one.
 */
function rootTokens(css: string): Map<string, string> {
  const root = /:root\s*\{([\s\S]*?)\}/.exec(css.replace(/\/\*[\s\S]*?\*\//g, ''));
  if (!root?.[1]) throw new Error('no :root block in styles.css');
  const tokens = new Map<string, string>();
  for (const m of root[1].matchAll(/(--cq-[\w-]+)\s*:\s*([^;]+);/g)) {
    const [, name, value] = m;
    if (name && value) tokens.set(name, value.trim());
  }
  return tokens;
}

const TOKENS = rootTokens(CSS);

function colour(token: string): string {
  const v = TOKENS.get(token);
  if (!v) throw new Error(`token not declared in styles.css: ${token}`);
  return v;
}

describe('WCAG contrast arithmetic', () => {
  it('matches the specification’s own worked values', () => {
    // Black on white is the definitional maximum; a formula error moves this off 21.
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 4);
    expect(contrastRatio('#ffffff', '#ffffff')).toBeCloseTo(1, 6);
    // Order must not matter — the ratio is defined on the lighter/darker pair.
    expect(contrastRatio('#777777', '#ffffff')).toBeCloseTo(contrastRatio('#ffffff', '#777777'), 9);
    // #767676 on white is the canonical "just passes 4.5" grey quoted by WCAG's own
    // guidance; a gamma of 2.2 instead of 2.4 pushes it under and would silently
    // relax every threshold in this file.
    expect(contrastRatio('#767676', '#ffffff')).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio('#777777', '#ffffff')).toBeLessThan(4.5);
  });

  it('reads both hex forms and refuses anything else', () => {
    expect(parseHex('#fff')).toEqual([255, 255, 255]);
    expect(parseHex('#FFFFFF')).toEqual([255, 255, 255]);
    expect(parseHex('#1f5eff')).toEqual([31, 94, 255]);
    // A token switched to rgb()/hsl()/color-mix() must fail loudly rather than be
    // skipped: a silently unchecked token is worse than an unchecked one, because
    // the suite still reports green.
    expect(() => parseHex('rgb(0,0,0)')).toThrow(/not a hex colour/);
    expect(() => parseHex('#12345')).toThrow(/not a hex colour/);
    expect(relativeLuminance('#000000')).toBe(0);
    expect(relativeLuminance('#ffffff')).toBeCloseTo(1, 6);
  });

  it('drifts a background toward the foreground, never away from it', () => {
    // Dark text on white: the hostile edit darkens the background.
    expect(driftedRatio('#000000', '#ffffff')).toBeLessThan(contrastRatio('#000000', '#ffffff'));
    // Light text on black: the hostile edit lightens it. Same direction of harm.
    expect(driftedRatio('#ffffff', '#000000')).toBeLessThan(contrastRatio('#ffffff', '#000000'));
    expect(driftedRatio('#000000', '#ffffff', 0)).toBeCloseTo(21, 4);
  });
});

describe('every pairing styles.css renders', () => {
  for (const p of PAIRINGS) {
    for (const bg of p.on) {
      it(`${p.what} on ${bg} clears ${p.floor}:1 after a shade of drift`, () => {
        const fg = colour(p.fg);
        const surface = colour(bg);
        const nominal = contrastRatio(fg, surface);
        const drifted = driftedRatio(fg, surface);
        expect(
          nominal,
          `${p.fg} (${fg}) on ${bg} (${surface}) is ${nominal.toFixed(2)}:1, floor ${p.floor}`,
        ).toBeGreaterThanOrEqual(p.floor);
        expect(
          drifted,
          `${p.fg} on ${bg} holds only ${drifted.toFixed(2)}:1 if ${bg} moves one shade — ` +
            `it passes today and breaks on the next edit to ${bg}`,
        ).toBeGreaterThanOrEqual(p.floor);
      });
    }
  }

  it('holds the three-step grey ramp apart', () => {
    // The reason --cq-text-secondary was darkened alongside the token that actually
    // failed: AA's 4.5 floor puts the lightest usable grey near L*45, so fixing only
    // --cq-text-muted would have landed it 3 L* from --cq-text-secondary and collapsed
    // a three-tier hierarchy into two identical-looking ones. This asserts the fix did
    // not trade a contrast failure for a hierarchy failure.
    const lstar = (hex: string) => {
      const y = relativeLuminance(hex);
      return y > 0.008856 ? 116 * Math.cbrt(y) - 16 : 903.3 * y;
    };
    const ramp = ['--cq-text', '--cq-text-secondary', '--cq-text-muted'].map((t) => lstar(colour(t)));
    for (let i = 1; i < ramp.length; i += 1) {
      const prev = ramp[i - 1]!;
      const here = ramp[i]!;
      expect(here, 'the ramp must get lighter, in order').toBeGreaterThan(prev);
      expect(
        here - prev,
        `tiers ${i - 1} and ${i} are ${(here - prev).toFixed(1)} L* apart — under 10 ` +
          'they are the same colour to a reader, and the tier is decoration',
      ).toBeGreaterThan(10);
    }
  });
});

describe('no colour escapes the table', () => {
  /**
   * Every hex outside `:root`, which is where the two worst failures in this file
   * were hiding — a 2.87:1 placeholder and a hover border lighter than the resting
   * one. Both were literals, so neither the token table nor axe could see them.
   */
  function literalsOutsideRoot(css: string): Set<string> {
    // Comments are stripped first, and the reason is that the first run of this test
    // failed on #9299a5 and #a8aeb9 — two colours that exist nowhere in the stylesheet
    // except in the comments explaining why they were removed. A scanner that reads
    // prose as code makes documenting a fix cost you a failing build, and the way that
    // ends is people stopping documenting fixes.
    const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
    const withoutRoot = withoutComments.replace(/:root\s*\{[\s\S]*?\}/, '');
    return new Set([...withoutRoot.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((m) => m[0].toLowerCase()));
  }

  const found = literalsOutsideRoot(CSS);
  const allowed = new Set(ALLOWED_LITERALS.map((l) => l.value.toLowerCase()));

  it('has a written reason for every hardcoded colour', () => {
    const undocumented = [...found].filter((c) => !allowed.has(c));
    expect(
      undocumented,
      'these hex colours are used outside :root with no entry in ALLOWED_LITERALS. Either ' +
        'make them tokens and add them to PAIRINGS, or add them there with the ratio and ' +
        'the reason they are exempt.',
    ).toEqual([]);
  });

  it('carries no dead exemptions', () => {
    // An allowlist that outlives its colour is the "shape with one possible value" the
    // plan's §0 rule 3 argues against: it reads as a live exemption and protects nothing.
    const stale = [...allowed].filter((c) => !found.has(c));
    expect(stale, 'ALLOWED_LITERALS entries whose colour no longer appears in styles.css').toEqual([]);
  });

  it('states a floor for every entry it exempts', () => {
    for (const l of ALLOWED_LITERALS) {
      expect(l.why.length, `${l.value} needs a reason, not a placeholder`).toBeGreaterThan(20);
    }
  });
});

describe('the regressions this file was written for', () => {
  it('keeps the placeholder on the muted token rather than a literal', () => {
    const rule = /\.cq-input::placeholder\s*\{([^}]*)\}/.exec(CSS);
    expect(rule, '.cq-input::placeholder rule not found').not.toBeNull();
    // Asserting the mechanism, not the value: a literal that happens to pass today is
    // the exact shape that failed at 2.87:1, and it would pass a value-based check.
    expect(rule![1]).toContain('var(--cq-text-muted)');
    expect(rule![1]).not.toMatch(/#[0-9a-fA-F]{3,6}/);
  });

  /**
   * Every control whose resting boundary is --cq-border-strong and which restyles that
   * boundary on hover.
   *
   * Written as a list rather than one case because the defect turned up twice: inputs
   * at #a8aeb9 and secondary buttons at #aeb4bf, both *lighter* than the resting border,
   * so pointing at the control made it harder to see. One was found by reading, the other
   * only because the literal scan flagged an unexplained colour. A third would be found
   * by neither, which is what this list is for.
   */
  const HOVER_RULES = ['.cq-input:hover', '.cq-btn--secondary:hover'] as const;

  for (const selector of HOVER_RULES) {
    it(`never makes ${selector.replace(':hover', '')} fainter on hover than at rest`, () => {
      const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const rule = new RegExp(`${escaped}[^{]*\\{([^}]*)\\}`).exec(CSS);
      expect(rule, `${selector} rule not found`).not.toBeNull();
      const body = rule![1]!;
      const tint = /border-color:\s*(#[0-9a-fA-F]{3,6})/.exec(body);
      expect(tint, `${selector} declares no literal border-color`).not.toBeNull();
      const resting = colour('--cq-border-strong');
      const surface = colour('--cq-surface');
      expect(
        contrastRatio(tint![1]!, surface),
        `${selector} sets ${tint![1]} — fainter against ${surface} than the resting ` +
          `${resting}, so the control recedes exactly when it is pointed at`,
      ).toBeGreaterThanOrEqual(contrastRatio(resting, surface));
    });
  }

  it('keeps --cq-border light and --cq-border-strong accountable', () => {
    // The distinction is load-bearing and easy to lose: --cq-border draws panel edges
    // and table rules (structure, exempt from 1.4.11), --cq-border-strong is the only
    // thing that identifies a control (not exempt). Darkening both to pass the gate
    // would have wrecked §40's density brief for no accessibility gain; darkening
    // neither leaves every input in the product unidentifiable at 1.59:1.
    expect(contrastRatio(colour('--cq-border-strong'), colour('--cq-surface'))).toBeGreaterThanOrEqual(
      AA_NON_TEXT,
    );
    expect(contrastRatio(colour('--cq-border'), colour('--cq-surface'))).toBeLessThan(AA_NON_TEXT);
  });

  it('covers every text and border token declared, so a new one cannot be forgotten', () => {
    // Governed means "appears in the table at all" — as a foreground *or* as a surface
    // something is measured against. --cq-accent-hover and --cq-accent-active are only
    // ever backgrounds, and demanding they also be foregrounds would be asking for a
    // pairing that does not exist.
    const governed = new Set([...PAIRINGS.map((p) => p.fg), ...PAIRINGS.flatMap((p) => p.on)]);
    const needsGoverning = [...TOKENS.keys()].filter(
      (t) => /^--cq-(text|border|accent|danger|success|warning)/.test(t) && !/-soft$/.test(t),
    );
    for (const t of needsGoverning) {
      // --cq-border is the one deliberate exemption, asserted above rather than skipped.
      if (t === '--cq-border') continue;
      expect(
        governed.has(t),
        `${t} is a foreground or boundary token with no entry in PAIRINGS — add it with ` +
          'the surfaces it renders on, or it is unchecked',
      ).toBe(true);
    }
    expect(AA_TEXT).toBe(4.5);
  });
});
