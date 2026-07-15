/**
 * Tests for Geist Font Foundation (Issue #1043)
 *
 * Verifies the Tailwind theme (globals.css, CSS-first since Issue #1178),
 * layout.tsx, Terminal.tsx and package.json are correctly configured to
 * self-host Geist Sans / Geist Mono via next/font (geist package), with
 * Japanese-capable fallbacks preserved.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(__dirname, '../../..');

describe('Geist Font Foundation (Issue #1043)', () => {
  describe('package.json', () => {
    it('should declare geist as a runtime dependency', () => {
      const pkg = JSON.parse(
        fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8')
      );
      expect(pkg.dependencies?.geist).toBeDefined();
    });
  });

  /*
   * [Issue #1178] Tailwind 4 is CSS-first: fontFamily moved from
   * tailwind.config.js `theme.extend.fontFamily` to the `--font-sans` /
   * `--font-mono` keys of the `@theme` block in globals.css.
   */
  describe('@theme fontFamily', () => {
    let sans: string;
    let mono: string;

    beforeAll(() => {
      const css = fs.readFileSync(path.join(ROOT, 'src/app/globals.css'), 'utf-8');
      const grab = (name: string): string => {
        const match = css.match(new RegExp(`--font-${name}:\\s*([^;]+);`));
        expect(match, `--font-${name} must be defined in @theme`).not.toBeNull();
        return match![1].replace(/\s+/g, ' ').trim();
      };
      sans = grab('sans');
      mono = grab('mono');
    });

    const stack = (value: string): string[] => value.split(',').map((f) => f.trim());

    it('should resolve font-sans to Geist Sans first', () => {
      expect(stack(sans)[0]).toBe('var(--font-geist-sans)');
    });

    it('should resolve font-mono to Geist Mono first', () => {
      expect(stack(mono)[0]).toBe('var(--font-geist-mono)');
    });

    it('should keep Japanese fallback fonts in the sans stack', () => {
      expect(sans).toContain('Hiragino Kaku Gothic ProN');
      expect(sans).toContain('Noto Sans JP');
    });

    it('should end the sans stack with a generic sans-serif fallback', () => {
      expect(stack(sans).at(-1)).toBe('sans-serif');
    });

    it('should preserve the previous monospace stack as mono fallback', () => {
      expect(mono).toContain('ui-monospace');
      expect(mono).toContain('Menlo');
      expect(stack(mono).at(-1)).toBe('monospace');
    });
  });

  describe('layout.tsx', () => {
    let content: string;
    beforeAll(() => {
      content = fs.readFileSync(path.join(ROOT, 'src/app/layout.tsx'), 'utf-8');
    });

    it('should import GeistSans from geist/font/sans', () => {
      expect(content).toContain("import { GeistSans } from 'geist/font/sans'");
    });

    it('should import GeistMono from geist/font/mono', () => {
      expect(content).toContain("import { GeistMono } from 'geist/font/mono'");
    });

    it('should apply both Geist font variable classes to the html element', () => {
      expect(content).toContain('${GeistSans.variable}');
      expect(content).toContain('${GeistMono.variable}');
    });

    it('should keep suppressHydrationWarning on the html tag', () => {
      expect(content).toContain('suppressHydrationWarning');
    });
  });

  describe('globals.css', () => {
    let content: string;
    beforeAll(() => {
      content = fs.readFileSync(
        path.join(ROOT, 'src/app/globals.css'),
        'utf-8'
      );
    });

    it('should reference the mono token for inline assistant code', () => {
      // [Issue #1178] Tailwind 4 replaces the v3 `theme()` function with a direct
      // reference to the theme variable the @theme block generates.
      expect(content).toContain('font-family: var(--font-mono)');
    });

    it('should no longer hardcode the SFMono monospace stack', () => {
      expect(content).not.toContain(
        'ui-monospace, SFMono-Regular, Menlo, monospace'
      );
    });
  });

  describe('Terminal.tsx (xterm)', () => {
    it('should put Geist Mono first in the xterm fontFamily with a fallback', () => {
      const content = fs.readFileSync(
        path.join(ROOT, 'src/components/Terminal.tsx'),
        'utf-8'
      );
      expect(content).toContain(
        "fontFamily: 'var(--font-geist-mono), Menlo, Monaco, \"Courier New\", monospace'"
      );
    });
  });
});
