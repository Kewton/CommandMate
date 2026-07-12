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

  describe('light mode (pure-white page, subtly grayed panels)', () => {
    it('uses a pure white background', () => {
      expect(channelSum(root, '--background')).toBe(765);
    });

    it('recesses surface below background and surface-2 below surface', () => {
      const bg = channelSum(root, '--background');
      const surface = channelSum(root, '--surface');
      const s2 = channelSum(root, '--surface-2');
      expect(surface).toBeLessThan(bg);
      expect(s2).toBeLessThan(surface);
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
