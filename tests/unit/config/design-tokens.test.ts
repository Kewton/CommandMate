/**
 * Tests for the semantic design token foundation (Issue #1041).
 *
 * Verifies that:
 *  - globals.css defines every token in both `:root` (light) and `.dark`,
 *    using RGB channel values that mirror the current effective shades.
 *  - the `@theme` block registers each token as a `rgb(var(--token))` color and
 *    no longer exposes the removed `primary` / `cmd-bg-dark` colors.
 *  - the body background was migrated to the `bg-background` token.
 *  - no source references the removed `bg-primary-*` / `bg-cmd-bg-dark` classes.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import postcss from 'postcss';
import tailwindcss from '@tailwindcss/postcss';

const ROOT = path.resolve(__dirname, '../../..');

/**
 * Tokens whose value differs between light and dark modes.
 * background/surface/surface-2/border were revised in Issue #1049 to form a
 * deliberate depth ladder (the first intentional visual change).
 * Issue #1074 inverted the LIGHT ladder: the page is now a near-white gray
 * (--background), cards are pure white (--surface, brightest), and the
 * secondary surface is a recessed well (--surface-2, darkest). Dark unchanged.
 */
const MODE_VARYING: Record<string, { light: string; dark: string }> = {
  '--background': { light: '250 250 251', dark: '10 12 18' },
  '--foreground': { light: '17 24 39', dark: '243 244 246' },
  '--surface': { light: '255 255 255', dark: '20 24 33' },
  '--surface-foreground': { light: '17 24 39', dark: '243 244 246' },
  '--surface-2': { light: '244 246 250', dark: '15 18 26' },
  '--muted': { light: '243 244 246', dark: '31 41 55' },
  '--muted-foreground': { light: '107 114 128', dark: '156 163 175' },
  '--border': { light: '226 232 240', dark: '42 48 62' },
  '--input': { light: '209 213 219', dark: '75 85 99' },
  // [Issue #1073] Sidebar theme-following tokens. Standalone literal RGB values
  // (NOT var() references) so #1074's --surface ladder revision cannot bleed in.
  '--sidebar': { light: '248 250 252', dark: '20 24 33' },
  '--sidebar-foreground': { light: '17 24 39', dark: '243 244 246' },
  '--sidebar-border': { light: '226 232 240', dark: '42 48 62' },
  '--sidebar-hover': { light: '241 245 249', dark: '31 41 55' },
  '--sidebar-muted': { light: '107 114 128', dark: '156 163 175' },
};

/** Tokens with identical values in both modes (defined in both blocks). */
const MODE_INVARIANT: Record<string, string> = {
  '--ring': '6 182 212',
  '--accent-50': '236 254 255',
  '--accent-100': '207 250 254',
  '--accent-200': '165 243 252',
  '--accent-300': '103 232 249',
  '--accent-400': '34 211 238',
  '--accent-500': '6 182 212',
  '--accent-600': '8 145 178',
  '--accent-700': '14 116 144',
  '--success': '34 197 94',
  '--warning': '245 158 11',
  '--danger': '239 68 68',
  '--info': '59 130 246',
};

function extractBlock(css: string, selector: string): string {
  // Tokens contain no nested braces, so a non-greedy `{ ... }` match is safe.
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
  expect(match, `Expected a "${selector}" block in globals.css`).not.toBeNull();
  return match![1];
}

function hasToken(block: string, name: string, value: string): boolean {
  return new RegExp(`${name}\\s*:\\s*${value}\\s*;`).test(block);
}

describe('Design tokens (Issue #1041)', () => {
  describe('globals.css token definitions', () => {
    let root: string;
    let dark: string;

    beforeAll(() => {
      const css = fs.readFileSync(path.join(ROOT, 'src/app/globals.css'), 'utf-8');
      root = extractBlock(css, ':root');
      dark = extractBlock(css, '.dark');
    });

    it('defines all mode-varying tokens with the correct light values in :root', () => {
      for (const [name, { light }] of Object.entries(MODE_VARYING)) {
        expect(hasToken(root, name, light), `${name} (light) = ${light}`).toBe(true);
      }
    });

    it('defines all mode-varying tokens with the correct dark values in .dark', () => {
      for (const [name, { dark: value }] of Object.entries(MODE_VARYING)) {
        expect(hasToken(dark, name, value), `${name} (dark) = ${value}`).toBe(true);
      }
    });

    it('defines every mode-invariant token in BOTH :root and .dark', () => {
      for (const [name, value] of Object.entries(MODE_INVARIANT)) {
        expect(hasToken(root, name, value), `${name} (:root) = ${value}`).toBe(true);
        expect(hasToken(dark, name, value), `${name} (.dark) = ${value}`).toBe(true);
      }
    });

    it('uses RGB channel triplets (not hex) so alpha composition works', () => {
      expect(root).not.toMatch(/--[a-z0-9-]+\s*:\s*#/i);
      expect(dark).not.toMatch(/--[a-z0-9-]+\s*:\s*#/i);
    });
  });

  /*
   * [Issue #1178] Tailwind 4 is CSS-first: colors are registered in the `@theme`
   * block of globals.css, not tailwind.config.js. The `<alpha-value>` placeholder
   * no longer exists — Tailwind 4 composes opacity modifiers itself via
   * color-mix() — so the registered form is a plain `rgb(var(--token))`.
   * These assertions are compiled end-to-end (not just string-matched) so an
   * unknown utility cannot slip through. See docs/design-system.md.
   */
  describe('@theme color registration', () => {
    let css: string;
    let compiled: string;

    beforeAll(async () => {
      const cssPath = path.join(ROOT, 'src/app/globals.css');
      css = fs.readFileSync(cssPath, 'utf-8');
      const result = await postcss([tailwindcss({ base: ROOT, optimize: false })]).process(css, {
        from: cssPath,
      });
      compiled = result.css;
    }, 120_000);

    function registers(token: string): boolean {
      return css.includes(`--color-${token}: rgb(var(--${token}));`);
    }

    it('registers scalar semantic colors as rgb(var(--token))', () => {
      for (const token of ['background', 'foreground', 'border', 'input', 'ring']) {
        expect(registers(token), `--color-${token}`).toBe(true);
      }
      // [Issue #1112] status colors carry tint roles; the bare token keeps
      // `text-success` etc. working unchanged.
      for (const status of ['success', 'warning', 'danger', 'info']) {
        expect(registers(status), `--color-${status}`).toBe(true);
      }
    });

    it('registers the surface/muted/accent scales', () => {
      for (const token of ['surface', 'surface-foreground', 'surface-2', 'muted', 'muted-foreground']) {
        expect(registers(token), `--color-${token}`).toBe(true);
      }
      for (const shade of [50, 100, 200, 300, 400, 500, 600, 700]) {
        expect(registers(`accent-${shade}`), `--color-accent-${shade}`).toBe(true);
      }
    });

    // [Issue #1073] Round-trip guard: globals.css defines --sidebar-* (checked in
    // the MODE_VARYING block above) AND the theme must register the matching
    // `sidebar` scale. Without this, `bg-sidebar` would be an unknown utility and
    // the sidebar could silently render transparent while every other gate still
    // passes (Must Fix S3-003).
    it('registers the sidebar color scale (Issue #1073)', () => {
      for (const token of [
        'sidebar',
        'sidebar-foreground',
        'sidebar-border',
        'sidebar-hover',
        'sidebar-muted',
      ]) {
        expect(registers(token), `--color-${token}`).toBe(true);
      }
    });

    it('emits bg-sidebar / bg-surface / text-muted-foreground as real utilities', () => {
      // Compiling the real stylesheet proves the registration actually reaches
      // the utility layer — a string match alone would not.
      expect(compiled).toContain('.bg-sidebar');
      expect(compiled).toContain('.bg-surface');
      expect(compiled).toContain('.text-muted-foreground');
      expect(compiled).toMatch(/\.bg-background\s*\{\s*background-color:\s*rgb\(var\(--background\)\)/);
    });

    it('no longer exposes the removed primary / cmd-bg-dark colors', () => {
      expect(css).not.toContain('--color-primary:');
      expect(css).not.toContain('cmd-bg-dark');
    });

    // [Issue #1074] The light page went gray + white cards, so shadow-sm must
    // read as a real 2-layer elevation (was the flat Tailwind default
    // `0 1px 2px 0 rgb(0 0 0 / 0.05)`). The shadow scale is mode-independent; the
    // slate tint is near-invisible on the dark #0a0c12 base so dark is unchanged.
    it('defines a custom 2-layer --shadow-sm (Issue #1074)', () => {
      const match = css.match(/--shadow-sm:\s*([^;]+);/);
      expect(match, '--shadow-sm must be defined in @theme').not.toBeNull();
      const sm = match![1];
      // No longer the flat single-layer Tailwind default.
      expect(sm).not.toBe('0 1px 2px 0 rgb(0 0 0 / 0.05)');
      // Two comma-separated shadow layers.
      expect(sm.split('),').length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('source migration', () => {
    it('migrates the root layout body to bg-background', () => {
      const content = fs.readFileSync(path.join(ROOT, 'src/app/layout.tsx'), 'utf-8');
      expect(content).toContain('bg-background');
      expect(content).not.toContain('cmd-bg-dark');
    });

    it('has no source references to the removed bg-primary-* / bg-cmd-bg-dark classes', () => {
      const offenders: string[] = [];
      const walk = (dir: string) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            walk(full);
          } else if (/\.(tsx?|css)$/.test(entry.name)) {
            const text = fs.readFileSync(full, 'utf-8');
            if (/bg-cmd-bg-dark/.test(text) || /\bbg-primary-\d/.test(text)) {
              offenders.push(path.relative(ROOT, full));
            }
          }
        }
      };
      walk(path.join(ROOT, 'src'));
      expect(offenders, `Found removed color classes in: ${offenders.join(', ')}`).toEqual([]);
    });
  });
});
