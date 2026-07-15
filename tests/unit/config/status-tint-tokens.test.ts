/**
 * Tests for the status tint token scale (Issue #1112).
 *
 * Verifies that:
 *  - globals.css defines subtle/border/foreground tint tokens for each status
 *    color (success/warning/danger/info) in both `:root` (light) and `.dark`.
 *  - the `@theme` block registers each status color as a scale
 *    (DEFAULT/subtle/border/foreground) backed by the CSS variables.
 *  - the migrated feedback surfaces (Toast / DefaultErrorFallback /
 *    History-Prompt-ConnectionErrorFallback / ErrorDisplay / PromptPanel) no
 *    longer carry raw status-palette classes or status `dark:` pairs.
 *    TerminalErrorFallback (always-dark island) and accent-* dark: pairs are
 *    intentionally exempt — see docs/design-system.md.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(__dirname, '../../..');

/**
 * Tint tokens are mode-varying by design: light pairs a *-50 wash with a *-800
 * foreground (>=4.5:1), dark pairs a *-950 low-luminance surface (sits inside
 * the #0a0c12 -> #141821 elevation ladder) with a *-300 foreground (>=8:1).
 */
const TINT_TOKENS: Record<string, { light: string; dark: string }> = {
  '--success-subtle': { light: '240 253 244', dark: '5 46 22' },
  '--success-border': { light: '187 247 208', dark: '22 101 52' },
  '--success-foreground': { light: '22 101 52', dark: '134 239 172' },
  '--warning-subtle': { light: '255 251 235', dark: '69 26 3' },
  '--warning-border': { light: '253 230 138', dark: '146 64 14' },
  '--warning-foreground': { light: '146 64 14', dark: '252 211 77' },
  '--danger-subtle': { light: '254 242 242', dark: '69 10 10' },
  '--danger-border': { light: '254 202 202', dark: '153 27 27' },
  '--danger-foreground': { light: '153 27 27', dark: '252 165 165' },
  '--info-subtle': { light: '239 246 255', dark: '23 37 84' },
  '--info-border': { light: '191 219 254', dark: '30 64 175' },
  '--info-foreground': { light: '30 64 175', dark: '147 197 253' },
};

const STATUSES = ['success', 'warning', 'danger', 'info'] as const;

function extractBlock(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
  expect(match, `Expected a "${selector}" block in globals.css`).not.toBeNull();
  return match![1];
}

function hasToken(block: string, name: string, value: string): boolean {
  return new RegExp(`${name}\\s*:\\s*${value}\\s*;`).test(block);
}

describe('Status tint tokens (Issue #1112)', () => {
  describe('globals.css token definitions', () => {
    let root: string;
    let dark: string;

    beforeAll(() => {
      const css = fs.readFileSync(path.join(ROOT, 'src/app/globals.css'), 'utf-8');
      root = extractBlock(css, ':root');
      dark = extractBlock(css, '.dark');
    });

    it('defines all tint tokens with the correct light values in :root', () => {
      for (const [name, { light }] of Object.entries(TINT_TOKENS)) {
        expect(hasToken(root, name, light), `${name} (light) = ${light}`).toBe(true);
      }
    });

    it('defines all tint tokens with the correct dark values in .dark', () => {
      for (const [name, { dark: value }] of Object.entries(TINT_TOKENS)) {
        expect(hasToken(dark, name, value), `${name} (dark) = ${value}`).toBe(true);
      }
    });
  });

  /*
   * [Issue #1178] Tailwind 4 registers colors via `@theme` in globals.css rather
   * than tailwind.config.js. The `<alpha-value>` placeholder is gone — Tailwind 4
   * composes opacity modifiers with color-mix() from a plain rgb() value — so the
   * expected registration is `rgb(var(--token))`. See docs/design-system.md.
   */
  describe('@theme color registration', () => {
    let css: string;

    beforeAll(() => {
      css = fs.readFileSync(path.join(ROOT, 'src/app/globals.css'), 'utf-8');
    });

    it('registers each status color as a DEFAULT/subtle/border/foreground scale', () => {
      for (const status of STATUSES) {
        for (const suffix of ['', '-subtle', '-border', '-foreground']) {
          const decl = `--color-${status}${suffix}: rgb(var(--${status}${suffix}));`;
          expect(css.includes(decl), decl).toBe(true);
        }
      }
    });

    it('registers the scale inside @theme inline so .dark re-declaration resolves', () => {
      // Non-inline @theme would freeze var(--success) at :root and break theming.
      expect(css).toContain('@theme inline');
    });
  });

  describe('feedback-surface migration (no raw status palette / status dark: pairs)', () => {
    // Raw chromatic status utilities (numbered shades). accent-* is a semantic
    // token scale and is NOT matched — its dark: pairs are out of scope here.
    const RAW_STATUS = /(?:bg|text|border|ring)-(?:gray|green|red|amber|yellow|orange)-\d/;
    const DARK_STATUS = /dark:[a-z:-]*(?:gray|green|red|amber|yellow|orange)-\d/;

    function read(rel: string): string {
      return fs.readFileSync(path.join(ROOT, rel), 'utf-8');
    }

    function expectClean(label: string, source: string) {
      expect(source.match(RAW_STATUS)?.[0], `${label}: raw status palette class`).toBeUndefined();
      expect(source.match(DARK_STATUS)?.[0], `${label}: status dark: pair`).toBeUndefined();
    }

    it('Toast.tsx uses tint tokens only', () => {
      expectClean('Toast.tsx', read('src/components/common/Toast.tsx'));
    });

    it('ErrorBoundary.tsx uses tint tokens only', () => {
      expectClean('ErrorBoundary.tsx', read('src/components/error/ErrorBoundary.tsx'));
    });

    it('PromptPanel.tsx uses tint tokens only', () => {
      expectClean('PromptPanel.tsx', read('src/components/worktree/PromptPanel.tsx'));
    });

    it('fallbacks.tsx (excluding the always-dark TerminalErrorFallback) uses tokens only', () => {
      const content = read('src/components/error/fallbacks.tsx');
      const start = content.indexOf('export function HistoryErrorFallback');
      expect(start, 'HistoryErrorFallback must exist after TerminalErrorFallback').toBeGreaterThan(
        content.indexOf('export function TerminalErrorFallback')
      );
      expectClean('fallbacks.tsx (non-terminal)', content.slice(start));
    });

    it('ErrorDisplay in WorktreeDetailSubComponents.tsx uses tint tokens only', () => {
      const content = read('src/components/worktree/WorktreeDetailSubComponents.tsx');
      const start = content.indexOf('export const ErrorDisplay');
      expect(start, 'ErrorDisplay must exist').toBeGreaterThanOrEqual(0);
      const end = content.indexOf('// ====', start);
      expectClean(
        'ErrorDisplay',
        content.slice(start, end === -1 ? undefined : end)
      );
    });
  });
});
