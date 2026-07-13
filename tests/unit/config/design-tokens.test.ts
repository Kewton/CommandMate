/**
 * Tests for the semantic design token foundation (Issue #1041).
 *
 * Verifies that:
 *  - globals.css defines every token in both `:root` (light) and `.dark`,
 *    using RGB channel values that mirror the current effective shades.
 *  - tailwind.config.js registers each token as a `rgb(var(--token) / <alpha-value>)`
 *    color and no longer exposes the removed `primary` / `cmd-bg-dark` colors.
 *  - the body background was migrated to the `bg-background` token.
 *  - no source references the removed `bg-primary-*` / `bg-cmd-bg-dark` classes.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import resolveConfig from 'tailwindcss/resolveConfig';

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

    it('uses RGB channel triplets (not hex) so <alpha-value> composition works', () => {
      expect(root).not.toMatch(/--[a-z0-9-]+\s*:\s*#/i);
      expect(dark).not.toMatch(/--[a-z0-9-]+\s*:\s*#/i);
    });
  });

  describe('tailwind.config.js color registration', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const config = require(path.join(ROOT, 'tailwind.config.js'));
    const colors = resolveConfig(config).theme.colors as Record<string, unknown>;

    it('registers scalar semantic colors as rgb(var(--token) / <alpha-value>)', () => {
      expect(colors.background).toBe('rgb(var(--background) / <alpha-value>)');
      expect(colors.foreground).toBe('rgb(var(--foreground) / <alpha-value>)');
      expect(colors.border).toBe('rgb(var(--border) / <alpha-value>)');
      expect(colors.input).toBe('rgb(var(--input) / <alpha-value>)');
      expect(colors.ring).toBe('rgb(var(--ring) / <alpha-value>)');
      // [Issue #1112] status colors became nested scales (DEFAULT + tint roles);
      // the DEFAULT keeps `text-success` etc. working unchanged.
      for (const status of ['success', 'warning', 'danger', 'info']) {
        const scale = colors[status] as Record<string, string>;
        expect(scale.DEFAULT).toBe(`rgb(var(--${status}) / <alpha-value>)`);
      }
    });

    it('registers nested surface/muted/accent scales', () => {
      const surface = colors.surface as Record<string, string>;
      expect(surface.DEFAULT).toBe('rgb(var(--surface) / <alpha-value>)');
      expect(surface.foreground).toBe('rgb(var(--surface-foreground) / <alpha-value>)');
      expect(surface['2']).toBe('rgb(var(--surface-2) / <alpha-value>)');

      const muted = colors.muted as Record<string, string>;
      expect(muted.DEFAULT).toBe('rgb(var(--muted) / <alpha-value>)');
      expect(muted.foreground).toBe('rgb(var(--muted-foreground) / <alpha-value>)');

      const accent = colors.accent as Record<string, string>;
      for (const shade of [50, 100, 200, 300, 400, 500, 600, 700]) {
        expect(accent[String(shade)]).toBe(`rgb(var(--accent-${shade}) / <alpha-value>)`);
      }
    });

    // [Issue #1073] Round-trip guard: globals.css defines --sidebar-* (checked in
    // the MODE_VARYING block above) AND tailwind.config.js must register the
    // matching `sidebar` scale. Without this, `bg-sidebar` would be an unknown
    // utility and the sidebar could silently render transparent while every
    // other gate still passes (Must Fix S3-003).
    it('registers the sidebar color scale (Issue #1073)', () => {
      const sidebar = colors.sidebar as Record<string, string>;
      expect(sidebar.DEFAULT).toBe('rgb(var(--sidebar) / <alpha-value>)');
      expect(sidebar.foreground).toBe('rgb(var(--sidebar-foreground) / <alpha-value>)');
      expect(sidebar.border).toBe('rgb(var(--sidebar-border) / <alpha-value>)');
      expect(sidebar.hover).toBe('rgb(var(--sidebar-hover) / <alpha-value>)');
      expect(sidebar.muted).toBe('rgb(var(--sidebar-muted) / <alpha-value>)');
    });

    it('no longer exposes the removed primary / cmd-bg-dark colors', () => {
      expect(colors.primary).toBeUndefined();
      expect(colors['cmd-bg-dark']).toBeUndefined();
    });

    // [Issue #1074] The light page went gray + white cards, so shadow-sm must
    // read as a real 2-layer elevation (was the flat Tailwind default
    // `0 1px 2px 0 rgb(0 0 0 / 0.05)`). boxShadow is mode-independent; the
    // slate tint is near-invisible on the dark #0a0c12 base so dark is unchanged.
    it('defines a custom 2-layer boxShadow.sm (Issue #1074)', () => {
      const boxShadow = resolveConfig(config).theme.boxShadow as Record<string, string>;
      const sm = boxShadow.sm;
      expect(sm).toBeDefined();
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
