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

    it('should have dark:text-gray-100 in body base layer', () => {
      expect(cssContent).toContain('dark:text-gray-100');
    });

    it('should maintain text-gray-900 for light mode body', () => {
      expect(cssContent).toContain('text-gray-900');
    });

    it('should NOT modify .prose pre styles (dark fixed)', () => {
      // .prose pre should still have the original dark background
      expect(cssContent).toContain('bg-[#0d1117]');
    });

    it('should have dark: variants for .card component', () => {
      expect(cssContent).toContain('dark:bg-gray-900');
      expect(cssContent).toContain('dark:border-gray-700');
    });

    it('should have cyan colors for .btn-primary', () => {
      expect(cssContent).toContain('bg-cyan-600');
      expect(cssContent).toContain('dark:bg-cyan-500');
    });

    it('should have dark: variants for .btn-secondary', () => {
      expect(cssContent).toContain('dark:bg-gray-700');
      expect(cssContent).toContain('dark:text-gray-100');
    });

    it('should have cyan colors for .badge-info', () => {
      expect(cssContent).toContain('bg-cyan-100');
      expect(cssContent).toContain('dark:bg-cyan-900');
      expect(cssContent).toContain('text-cyan-800');
      expect(cssContent).toContain('dark:text-cyan-300');
    });

    it('should have dark: variants for .badge-success', () => {
      expect(cssContent).toContain('dark:bg-green-900');
      expect(cssContent).toContain('dark:text-green-300');
    });

    it('should have dark: variants for .badge-warning', () => {
      expect(cssContent).toContain('dark:bg-yellow-900');
      expect(cssContent).toContain('dark:text-yellow-300');
    });

    it('should have dark: variants for .badge-error', () => {
      expect(cssContent).toContain('dark:bg-red-900');
      expect(cssContent).toContain('dark:text-red-300');
    });

    it('should have dark: variants for .badge-gray', () => {
      expect(cssContent).toContain('dark:bg-gray-800');
      expect(cssContent).toContain('dark:text-gray-300');
    });

    it('should have dark: variants for inline code in .prose', () => {
      expect(cssContent).toContain('dark:bg-gray-800');
      expect(cssContent).toContain('dark:text-gray-200');
    });

    it('should have cyan colors for .input focus ring', () => {
      expect(cssContent).toContain('focus:ring-cyan-500');
      expect(cssContent).toContain('focus:border-cyan-500');
    });

    it('should have dark: variants for .input', () => {
      expect(cssContent).toContain('dark:border-gray-600');
      expect(cssContent).toContain('dark:bg-gray-800');
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

    it('should configure ThemeProvider with defaultTheme="dark"', () => {
      const content = fs.readFileSync(providersPath, 'utf-8');
      expect(content).toContain('defaultTheme="dark"');
    });

    it('should configure ThemeProvider with enableSystem={false}', () => {
      const content = fs.readFileSync(providersPath, 'utf-8');
      expect(content).toContain('enableSystem={false}');
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

    it('should preserve border-blue-500 in STATUS_COLORS (NOT migrated to cyan)', () => {
      const content = fs.readFileSync(statusColorsPath, 'utf-8');
      expect(content).toContain('border-blue-500');
    });
  });
});
