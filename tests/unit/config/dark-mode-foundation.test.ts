/**
 * Tests for Dark Mode Foundation (Issue #424)
 *
 * Verifies tailwind.config.js, globals.css, and layout.tsx
 * are correctly configured for dark mode support.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(__dirname, '../../..');

describe('Dark Mode Foundation (Issue #424)', () => {
  describe('tailwind.config.js', () => {
    const configPath = path.join(ROOT, 'tailwind.config.js');

    it('should have darkMode set to class', () => {
      const content = fs.readFileSync(configPath, 'utf-8');
      expect(content).toContain("darkMode: 'class'");
    });

    it('should register the accent scale via CSS variables (migrated from primary in Issue #1041)', () => {
      const content = fs.readFileSync(configPath, 'utf-8');
      // The former `primary` cyan palette is now the semantic `accent` scale,
      // backed by CSS variables. Hex values live in globals.css instead.
      expect(content).toContain('rgb(var(--accent-500) / <alpha-value>)');
      expect(content).not.toContain('primary:');
    });

    it('should no longer define the cmd-bg-dark color (absorbed into --background in Issue #1041)', () => {
      const content = fs.readFileSync(configPath, 'utf-8');
      expect(content).not.toContain('cmd-bg-dark');
      expect(content).toContain('rgb(var(--background) / <alpha-value>)');
    });
  });

  describe('layout.tsx', () => {
    const layoutPath = path.join(ROOT, 'src/app/layout.tsx');

    it('should have suppressHydrationWarning on html tag', () => {
      const content = fs.readFileSync(layoutPath, 'utf-8');
      expect(content).toContain('suppressHydrationWarning');
    });

    it('should use the semantic bg-background token on body (Issue #1041)', () => {
      const content = fs.readFileSync(layoutPath, 'utf-8');
      // Replaces the former `bg-gray-50 dark:bg-cmd-bg-dark`; --background carries
      // the same effective values (gray-50 light / #0f1117 dark).
      expect(content).toContain('bg-background');
      expect(content).not.toContain('cmd-bg-dark');
    });
  });

  describe('globals.css', () => {
    const cssPath = path.join(ROOT, 'src/app/globals.css');
    let cssContent: string;

    beforeAll(() => {
      cssContent = fs.readFileSync(cssPath, 'utf-8');
    });

    it('body uses the semantic text-foreground token (Issue #1082)', () => {
      // The body color was `text-gray-900 dark:text-gray-100`; #1082 replaced it
      // with the theme-following `text-foreground` token.
      expect(cssContent).toContain('text-foreground');
    });

    it('body no longer hardcodes raw gray text (Issue #1082)', () => {
      expect(cssContent).not.toContain('@apply text-gray-900 dark:text-gray-100');
    });

    it('should NOT modify .prose pre styles (dark fixed)', () => {
      // .prose pre should still have the original dark background
      expect(cssContent).toContain('bg-[#0d1117]');
    });

    it('inline code in .prose uses semantic tokens (Issue #1082)', () => {
      // Was `bg-gray-100 dark:bg-gray-800 text-gray-800 dark:text-gray-200`;
      // now theme-following tokens (same look as `.assistant-md code`).
      expect(cssContent).toContain('bg-muted text-foreground');
    });

    it('should no longer define the legacy @apply component classes (Issue #1048)', () => {
      // .card/.btn*/.badge*/.input moved into the cva primitives to remove the
      // style-definition double structure. globals.css must not redefine them.
      expect(cssContent).not.toMatch(/\.card\s*\{/);
      expect(cssContent).not.toMatch(/\.btn(-\w+)?\s*\{/);
      expect(cssContent).not.toMatch(/\.badge(-\w+)?\s*\{/);
      expect(cssContent).not.toMatch(/\.input\s*\{/);
    });

    it('should keep the semantic --input / --surface tokens with a dark override', () => {
      // The Input primitive relies on border-input / bg-surface, whose dark
      // values come from the .dark override block.
      expect(cssContent).toContain('--input:');
      expect(cssContent).toContain('--surface:');
      expect(cssContent).toContain('.dark {');
    });

    it('should declare color-scheme on both :root and .dark (Issue #1071: native chrome)', () => {
      // color-scheme tells the UA to theme native controls (select dropdowns,
      // scrollbars, form widgets) so they don't render light-on-dark.
      const rootBlock = cssContent.match(/:root\s*\{([^}]*)\}/);
      const darkBlock = cssContent.match(/\.dark\s*\{([^}]*)\}/);
      expect(rootBlock, 'expected a :root block').not.toBeNull();
      expect(darkBlock, 'expected a .dark block').not.toBeNull();
      expect(rootBlock![1]).toMatch(/color-scheme:\s*light;/);
      expect(darkBlock![1]).toMatch(/color-scheme:\s*dark;/);
    });
  });

  describe('UI primitives dark mode (Issue #1048: @apply → cva)', () => {
    // The dark-mode component styling now lives in the cva primitives rather
    // than in globals.css @apply classes.
    const readPrimitive = (rel: string): string =>
      fs.readFileSync(path.join(ROOT, rel), 'utf-8');

    it('Button primary keeps accent tokens with dark variant', () => {
      const content = readPrimitive('src/components/ui/Button.tsx');
      expect(content).toContain('bg-accent-600');
      expect(content).toContain('dark:bg-accent-500');
    });

    it('Button secondary uses semantic muted/foreground tokens (Issue #1082)', () => {
      const content = readPrimitive('src/components/ui/Button.tsx');
      // Was `bg-gray-200 dark:bg-gray-700 text-gray-900 dark:text-gray-100`.
      expect(content).toContain('bg-muted');
      expect(content).toContain('text-foreground');
      expect(content).not.toContain('dark:bg-gray-700');
    });

    it('Card uses semantic surface/border tokens (migrated in Issue #1049)', () => {
      // The hardcoded dark:bg-gray-900 / dark:border-gray-700 were replaced by
      // bg-surface / border-border so the depth-token revision propagates.
      const content = readPrimitive('src/components/ui/Card.tsx');
      expect(content).toContain('bg-surface');
      expect(content).toContain('border-border');
    });

    it('Badge info keeps accent tokens with dark variants', () => {
      const content = readPrimitive('src/components/ui/Badge.tsx');
      expect(content).toContain('bg-accent-100');
      expect(content).toContain('dark:bg-accent-900');
      expect(content).toContain('text-accent-800');
      expect(content).toContain('dark:text-accent-300');
    });

    it('Badge success/warning/error use tint tokens; gray uses muted token (Issue #1116)', () => {
      const content = readPrimitive('src/components/ui/Badge.tsx');
      // chromatic dark: pairs replaced by status tint tokens (both themes absorbed)
      expect(content).toContain('bg-success-subtle text-success-foreground');
      expect(content).toContain('bg-warning-subtle text-warning-foreground');
      expect(content).toContain('bg-danger-subtle text-danger-foreground');
      expect(content).not.toContain('dark:bg-green-900');
      expect(content).not.toContain('dark:bg-yellow-900');
      expect(content).not.toContain('dark:bg-red-900');
      // gray variant migrated to the muted token (was dark:bg-gray-800/dark:text-gray-300)
      expect(content).toContain('bg-muted text-muted-foreground');
    });

    it('Input uses focus-visible ring/border tokens (Issue #1082)', () => {
      const content = readPrimitive('src/components/ui/Input.tsx');
      // focus: → focus-visible: so the ring is keyboard-only.
      expect(content).toContain('focus-visible:ring-ring');
      expect(content).toContain('focus-visible:border-ring');
    });

    it('Input uses semantic border-input / bg-surface tokens and recedes to surface-2 in dark (Issue #1049)', () => {
      const content = readPrimitive('src/components/ui/Input.tsx');
      expect(content).toContain('border-input');
      expect(content).toContain('bg-surface');
      // dark recede so an Input inside a bg-surface Card is distinguishable
      expect(content).toContain('dark:bg-surface-2');
    });
  });

  describe('AppProviders.tsx', () => {
    const providersPath = path.join(ROOT, 'src/components/providers/AppProviders.tsx');

    it('should import ThemeProvider from next-themes', () => {
      const content = fs.readFileSync(providersPath, 'utf-8');
      expect(content).toContain("import { ThemeProvider } from 'next-themes'");
    });

    it('should configure ThemeProvider with attribute="class"', () => {
      const content = fs.readFileSync(providersPath, 'utf-8');
      expect(content).toContain('attribute="class"');
    });

    it('should configure ThemeProvider with defaultTheme="system" (Issue #1071: follow OS)', () => {
      const content = fs.readFileSync(providersPath, 'utf-8');
      expect(content).toContain('defaultTheme="system"');
      expect(content).not.toContain('defaultTheme="dark"');
    });

    it('should enable system theme detection (Issue #1071)', () => {
      const content = fs.readFileSync(providersPath, 'utf-8');
      expect(content).toContain('enableSystem');
      expect(content).not.toContain('enableSystem={false}');
    });

    it('should place ThemeProvider inside NextIntlClientProvider and outside AuthProvider', () => {
      const content = fs.readFileSync(providersPath, 'utf-8');
      const themeProviderIdx = content.indexOf('<ThemeProvider');
      const nextIntlIdx = content.indexOf('<NextIntlClientProvider');
      const authProviderIdx = content.indexOf('<AuthProvider');
      // ThemeProvider should come after NextIntlClientProvider
      expect(themeProviderIdx).toBeGreaterThan(nextIntlIdx);
      // ThemeProvider should come before AuthProvider
      expect(themeProviderIdx).toBeLessThan(authProviderIdx);
    });
  });

  describe('status-colors.ts constraint', () => {
    const statusColorsPath = path.join(ROOT, 'src/config/status-colors.ts');

    it('should use the info token for the STATUS_COLORS spinner (blue, kept distinct from the cyan accent)', () => {
      const content = fs.readFileSync(statusColorsPath, 'utf-8');
      expect(content).toContain('border-info');
      // The running/generating spinner stays blue (info), not migrated to the cyan accent.
      expect(content).not.toContain('border-blue-500');
      expect(content).not.toContain('border-accent-500');
    });
  });
});
