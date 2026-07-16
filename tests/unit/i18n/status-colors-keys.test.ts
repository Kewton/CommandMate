/**
 * Real-dictionary guard for `src/config/status-colors.ts` (Issue #1304).
 *
 * The config is module scope, so it stores dictionary KEYS and the render site
 * resolves them (Issue #1271). The global next-intl mock in tests/setup.ts
 * echoes `namespace.key` back, so a component test would stay green even if the
 * key had no dictionary entry — this suite reads locales/<locale>/*.json off
 * disk instead, so a missing/renamed key fails here (#1197 blind spot).
 *
 * It also pins the EN wording to what shipped BEFORE the migration: the values
 * below were lifted from the pre-#1304 `label:` literals, so a drift in either
 * direction (dictionary edited, or config re-pointed at a different key) fails.
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { SIDEBAR_STATUS_CONFIG, DESKTOP_STATUS_LABEL_KEYS } from '@/config/status-colors';

const LOCALES_DIR = path.resolve(__dirname, '../../../locales');
const LOCALES = ['en', 'ja'] as const;

function load(locale: string, namespace: string): Record<string, unknown> {
  return JSON.parse(
    fs.readFileSync(path.join(LOCALES_DIR, locale, `${namespace}.json`), 'utf-8')
  );
}

function resolve(dict: Record<string, unknown>, key: string): unknown {
  return key
    .split('.')
    .reduce<unknown>((acc, part) => (acc as Record<string, unknown>)?.[part], dict);
}

/**
 * EN wording as it shipped before #1304 (git HEAD's `label:` literals). The
 * acceptance bar is byte-identity, so these are the ORIGINALS, not values
 * copied back out of the dictionary (which would be circular).
 */
const PRE_MIGRATION_EN = {
  sidebar: {
    idle: 'Idle',
    ready: 'Ready',
    running: 'Running',
    waiting: 'Waiting for response',
    generating: 'Generating',
  },
  desktop: {
    idle: 'Idle - No active session',
    ready: 'Ready - Waiting for input',
    running: 'Running - Processing',
    waiting: 'Waiting - User input required',
    // `error` is deliberately not in DESKTOP_STATUS_LABEL_KEYS — see below.
    error: 'Error',
  },
} as const;

describe('status-colors.ts i18n keys (Issue #1304)', () => {
  describe('SIDEBAR_STATUS_CONFIG reuses common.status.* (no new keys)', () => {
    for (const locale of LOCALES) {
      it(`every labelKey resolves to a string in ${locale}/common.json`, () => {
        const common = load(locale, 'common');
        for (const [status, config] of Object.entries(SIDEBAR_STATUS_CONFIG)) {
          expect(
            resolve(common, config.labelKey),
            `${locale}/common.json has no string at "${config.labelKey}" (status: ${status})`
          ).toBeTypeOf('string');
        }
      });
    }

    it('points every status at the generic status.* key, not a bespoke one', () => {
      for (const [status, config] of Object.entries(SIDEBAR_STATUS_CONFIG)) {
        expect(config.labelKey, `status "${status}" should reuse common.status.*`).toBe(
          `status.${status}`
        );
      }
    });

    it('EN wording is byte-identical to the pre-migration labels', () => {
      const common = load('en', 'common');
      for (const [status, expected] of Object.entries(PRE_MIGRATION_EN.sidebar)) {
        const key = SIDEBAR_STATUS_CONFIG[status as keyof typeof SIDEBAR_STATUS_CONFIG].labelKey;
        expect(resolve(common, key)).toBe(expected);
      }
    });
  });

  describe('DESKTOP_STATUS_LABEL_KEYS long-form descriptions', () => {
    for (const locale of LOCALES) {
      it(`every labelKey resolves to a string in ${locale}/worktree.json`, () => {
        const worktree = load(locale, 'worktree');
        for (const [status, key] of Object.entries(DESKTOP_STATUS_LABEL_KEYS)) {
          expect(
            resolve(worktree, key as string),
            `${locale}/worktree.json has no string at "${key}" (status: ${status})`
          ).toBeTypeOf('string');
        }
      });
    }

    it('EN wording is byte-identical to the pre-migration labels', () => {
      const worktree = load('en', 'worktree');
      for (const [status, key] of Object.entries(DESKTOP_STATUS_LABEL_KEYS)) {
        const expected = PRE_MIGRATION_EN.desktop[status as keyof typeof PRE_MIGRATION_EN.desktop];
        expect(resolve(worktree, key as string)).toBe(expected);
      }
    });

    it('JA wording is actually translated (not an English passthrough)', () => {
      const en = load('en', 'worktree');
      const ja = load('ja', 'worktree');
      for (const key of Object.values(DESKTOP_STATUS_LABEL_KEYS)) {
        const jaValue = resolve(ja, key as string) as string;
        expect(jaValue).not.toBe(resolve(en, key as string));
        expect(jaValue, `${key} should contain Japanese`).toMatch(
          /[぀-ゟ゠-ヿ一-鿿]/
        );
      }
    });

    /**
     * The reuse invariant #1273 asked for: the desktop `error` label is exactly
     * the generic word, so it has NO entry here — <StatusDot> falls back to
     * common.status.error when no label is passed. If someone adds an `error`
     * key to this map they have re-duplicated the wording.
     */
    it('omits `error` so the generic common.status.error stays the single source', () => {
      expect(DESKTOP_STATUS_LABEL_KEYS).not.toHaveProperty('error');
      for (const locale of LOCALES) {
        expect(resolve(load(locale, 'common'), 'status.error')).toBeTypeOf('string');
      }
      // ...and that generic word is what the desktop header showed pre-#1304.
      expect(resolve(load('en', 'common'), 'status.error')).toBe(PRE_MIGRATION_EN.desktop.error);
    });
  });
});
