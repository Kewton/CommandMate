/**
 * Tests for the surface/depth revision (Issue #1049 — first intentional visual change).
 *
 * Rather than re-pinning exact RGB triplets (design-tokens.test.ts already does
 * that), these assertions codify the *intent*: background/surface/surface-2/border
 * must form a deliberate elevation ladder in each mode, and heading typography
 * must express a weight hierarchy. This keeps future token tweaks honest without
 * freezing specific shades.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(__dirname, '../../..');

function extractBlock(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
  expect(match, `Expected a "${selector}" block in globals.css`).not.toBeNull();
  return match![1];
}

/** Parse an `--token: r g b;` triplet and return its channel sum (a luminance proxy). */
function channelSum(block: string, token: string): number {
  const m = block.match(new RegExp(`${token}\\s*:\\s*(\\d+)\\s+(\\d+)\\s+(\\d+)\\s*;`));
  expect(m, `Expected ${token} in the block`).not.toBeNull();
  return Number(m![1]) + Number(m![2]) + Number(m![3]);
}

/** Parse an `--token: r g b;` triplet into [r, g, b] (0-255). */
function channels(block: string, token: string): [number, number, number] {
  const m = block.match(new RegExp(`${token}\\s*:\\s*(\\d+)\\s+(\\d+)\\s+(\\d+)\\s*;`));
  expect(m, `Expected ${token} in the block`).not.toBeNull();
  return [Number(m![1]), Number(m![2]), Number(m![3])];
}

/** WCAG 2.1 relative luminance for an sRGB triplet (0-255). */
function relativeLuminance([r, g, b]: [number, number, number]): number {
  const lin = (c: number): number => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG contrast ratio between two sRGB triplets (>= 1). */
function contrastRatio(a: [number, number, number], b: [number, number, number]): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

describe('Surface depth ladder (Issue #1049)', () => {
  let css: string;
  let root: string;
  let dark: string;

  beforeAll(() => {
    css = fs.readFileSync(path.join(ROOT, 'src/app/globals.css'), 'utf-8');
    root = extractBlock(css, ':root');
    dark = extractBlock(css, '.dark');
  });

  describe('dark mode (elevation = brighter)', () => {
    it('layers background < surface-2 < surface (deep base rises to lifted card)', () => {
      const bg = channelSum(dark, '--background');
      const s2 = channelSum(dark, '--surface-2');
      const surface = channelSum(dark, '--surface');
      expect(bg).toBeLessThan(s2);
      expect(s2).toBeLessThan(surface);
    });

    it('draws the border as a hairline lighter than the surface it delineates', () => {
      expect(channelSum(dark, '--surface')).toBeLessThan(channelSum(dark, '--border'));
    });
  });

  // [Issue #1074] The light ladder was INVERTED: instead of a pure-white page
  // with recessed gray panels, the page is a near-white gray, cards are pure
  // white (the brightest, top-lit layer), and the secondary surface is a
  // recessed well (the darkest). This is NOT a monotone mirror of dark
  // (dark: bg < surface-2 < surface); light reads as "white card floats above a
  // gray page, wells sink below it": surface-2 < background < surface.
  describe('light mode (gray page, white cards float, wells recess) — Issue #1074', () => {
    it('uses a near-white gray page background (no longer pure white)', () => {
      expect(channelSum(root, '--background')).toBeLessThan(765);
    });

    it('makes the card surface the brightest, top-lit layer (pure white)', () => {
      expect(channelSum(root, '--surface')).toBe(765);
    });

    it('floats the white card above the gray page (background < surface)', () => {
      expect(channelSum(root, '--background')).toBeLessThan(channelSum(root, '--surface'));
    });

    it('recesses the secondary surface below both the card and the page (sunken well)', () => {
      const bg = channelSum(root, '--background');
      const surface = channelSum(root, '--surface');
      const s2 = channelSum(root, '--surface-2');
      expect(s2).toBeLessThan(surface);
      expect(s2).toBeLessThan(bg);
    });
  });

  // [Issue #1074] Contrast contract mirrors the #1049 policy stated in
  // globals.css: body text (foreground) >= 4.5:1 (WCAG AA), auxiliary text
  // (muted-foreground) >= 3:1. muted-foreground additionally clears 4.5:1 on the
  // page and card; on the recessed well it is auxiliary-only (>= 3:1).
  describe('light mode contrast (WCAG) — Issue #1074', () => {
    const AA_BODY = 4.5;
    const AA_AUX = 3;
    let fg: [number, number, number];
    let mfg: [number, number, number];

    beforeAll(() => {
      fg = channels(root, '--foreground');
      mfg = channels(root, '--muted-foreground');
    });

    it('keeps foreground body text >= 4.5:1 on every light surface', () => {
      for (const token of ['--background', '--surface', '--surface-2'] as const) {
        expect(
          contrastRatio(fg, channels(root, token)),
          `foreground on ${token}`,
        ).toBeGreaterThanOrEqual(AA_BODY);
      }
    });

    it('keeps muted-foreground >= 4.5:1 on the page and the white card', () => {
      for (const token of ['--background', '--surface'] as const) {
        expect(
          contrastRatio(mfg, channels(root, token)),
          `muted-foreground on ${token}`,
        ).toBeGreaterThanOrEqual(AA_BODY);
      }
    });

    it('keeps muted-foreground >= 3:1 (auxiliary) on the recessed well surface-2', () => {
      expect(
        contrastRatio(mfg, channels(root, '--surface-2')),
        'muted-foreground on --surface-2',
      ).toBeGreaterThanOrEqual(AA_AUX);
    });
  });

  describe('heading typography hierarchy', () => {
    it('keeps tracking-tight on all headings', () => {
      expect(css).toMatch(/h1,\s*h2,\s*h3,\s*h4,\s*h5,\s*h6\s*\{[^}]*tracking-tight/);
    });

    it('makes h1 and h2 bold display headings', () => {
      expect(css).toMatch(/h1\s*\{[^}]*font-bold/);
      expect(css).toMatch(/h2\s*\{[^}]*font-bold/);
    });
  });
});
