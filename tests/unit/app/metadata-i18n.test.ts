/**
 * Real-dictionary i18n tests for the `generateMetadata` exports — Issue #1305.
 *
 * `src/app/layout.tsx` and `src/app/offline/page.tsx` moved from a static
 * `metadata` const to `generateMetadata()` because t() cannot be called at
 * module scope. These tests read the real dictionaries so a missing key fails
 * rather than echoing (Issue #1197/#1273), and pin the two literals that must
 * NOT be translated: "CommandMate" is the product name, not copy.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';

const locale = vi.hoisted(() => ({ current: 'en' }));

vi.mock('next-intl/server', () => ({
  getLocale: vi.fn(),
  getMessages: vi.fn(),
  getTimeZone: vi.fn(),
  getTranslations: async (namespace: string) => {
    const file = path.resolve(__dirname, `../../../locales/${locale.current}/${namespace}.json`);
    const dict = JSON.parse(fs.readFileSync(file, 'utf-8'));
    return (key: string): string => {
      const value = key
        .split('.')
        .reduce<unknown>((acc, part) => (acc as Record<string, unknown>)?.[part], dict);
      if (typeof value !== 'string') {
        throw new Error(`no string at "${namespace}.${key}" for ${locale.current}`);
      }
      return value;
    };
  },
}));

vi.mock('geist/font/sans', () => ({ GeistSans: { variable: 'font-sans' } }));
vi.mock('geist/font/mono', () => ({ GeistMono: { variable: 'font-mono' } }));
vi.mock('@/components/providers/AppProviders', () => ({ AppProviders: () => null }));
vi.mock('@/components/pwa/OfflineReconnectButton', () => ({
  OfflineReconnectButton: () => null,
}));

import { generateMetadata as generateLayoutMetadata } from '@/app/layout';
import { generateMetadata as generateOfflineMetadata } from '@/app/offline/page';

beforeEach(() => {
  locale.current = 'en';
});

describe('root layout metadata (Issue #1305)', () => {
  it('resolves the description from common.meta.description (en byte-match)', async () => {
    const metadata = await generateLayoutMetadata();

    expect(metadata.description).toBe(
      'Git worktree management with Claude CLI and tmux sessions'
    );
  });

  it('translates the description for ja', async () => {
    locale.current = 'ja';
    const metadata = await generateLayoutMetadata();

    expect(metadata.description).toBe('Claude CLI と tmux セッションによる Git worktree 管理');
  });

  it('keeps the product name untranslated in both locales', async () => {
    for (const loc of ['en', 'ja']) {
      locale.current = loc;
      const metadata = await generateLayoutMetadata();

      expect(metadata.title).toEqual({
        default: 'CommandMate',
        template: '%s | CommandMate',
      });
      expect(metadata.appleWebApp).toEqual({
        capable: true,
        title: 'CommandMate',
        statusBarStyle: 'default',
      });
    }
  });
});

describe('offline page metadata (Issue #1305)', () => {
  it('resolves the title from pwa.offline.metaTitle (en byte-match)', async () => {
    const metadata = await generateOfflineMetadata();

    expect(metadata.title).toBe('Offline');
  });

  it('translates the title for ja', async () => {
    locale.current = 'ja';
    const metadata = await generateOfflineMetadata();

    expect(metadata.title).toBe('オフライン');
  });
});
