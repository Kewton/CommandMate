/**
 * Unit tests for the root layout viewport export.
 * Issue #1131: viewportFit: 'cover' must be set so iOS exposes non-zero
 * env(safe-area-inset-*) values — without it every pt-safe/pb-safe utility
 * (mobile headers, bottom navs, message composer offsets) is a no-op.
 */

import { describe, it, expect, vi } from 'vitest';

// Mock the layout module's runtime dependencies — we only assert on the
// static `viewport` / `metadata` exports, not on rendering.
vi.mock('next-intl/server', () => ({
  getLocale: vi.fn(),
  getMessages: vi.fn(),
  getTimeZone: vi.fn(),
}));
vi.mock('geist/font/sans', () => ({ GeistSans: { variable: 'font-sans' } }));
vi.mock('geist/font/mono', () => ({ GeistMono: { variable: 'font-mono' } }));
vi.mock('@/components/providers/AppProviders', () => ({ AppProviders: () => null }));

import { viewport } from '@/app/layout';

describe('root layout viewport (Issue #1131)', () => {
  it('sets viewportFit to "cover" so iOS safe-area insets are non-zero', () => {
    expect(viewport.viewportFit).toBe('cover');
  });

  it('keeps the theme-following themeColor entries (Issue #1082)', () => {
    expect(viewport.themeColor).toEqual([
      { media: '(prefers-color-scheme: light)', color: '#fafafb' },
      { media: '(prefers-color-scheme: dark)', color: '#0a0c12' },
    ]);
  });
});
