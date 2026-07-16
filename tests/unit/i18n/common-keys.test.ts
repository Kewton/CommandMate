/**
 * Unit-level i18n parity test for the `common` namespace (Issue #1197).
 *
 * `src/i18n.ts` has no onError / getMessageFallback, so a missing key in one
 * locale would surface the raw key string in production and go undetected.
 * The global next-intl mock (tests/setup.ts) echoes the full key, which means
 * component tests stay green even when the real dictionary has no entry — so
 * the nav labels shared by CommandPalette and HomeQuickActions need a
 * real-dictionary guard here, mirroring command-palette-keys / home-keys.
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const LOCALES_DIR = path.resolve(__dirname, '../../../locales');

function loadCommon(locale: string): Record<string, unknown> {
  const filePath = path.join(LOCALES_DIR, locale, 'common.json');
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

/** Collect all dot-joined leaf key paths from a nested object. */
function leafKeys(obj: Record<string, unknown>, prefix = ''): string[] {
  return Object.entries(obj).flatMap(([key, value]) => {
    const full = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return leafKeys(value as Record<string, unknown>, full);
    }
    return [full];
  });
}

function resolve(dict: Record<string, unknown>, key: string): unknown {
  return key
    .split('.')
    .reduce<unknown>((acc, part) => (acc as Record<string, unknown>)?.[part], dict);
}

/** Every nav key the palette and Home's quick actions request at runtime. */
const NAV_KEYS = [
  'home',
  'chat',
  'sessions',
  'repositories',
  'review',
  'more',
  // Issue #1206: Header renders abbreviated variants that must stay distinct
  // from the full labels above — `repositories` ("Repositories") is ~2.4x too
  // wide for the header's space-x-6 row, and `review` ("Review") would drop the
  // "/Report" that tells users the page also covers reports.
  'repositoriesShort',
  'reviewReport',
];

/**
 * Issue #1206 migrated Header / GlobalMobileNav from hardcoded English labels
 * to `common.nav.*`. The migration must be display-neutral in English, so pin
 * the exact pre-migration strings: any drift here is a user-visible regression
 * that the component tests' mocked `t()` could never catch on its own.
 */
const EN_NAV_LABELS: Record<string, string> = {
  home: 'Home',
  chat: 'Chat',
  sessions: 'Sessions',
  repositories: 'Repositories',
  review: 'Review',
  more: 'More',
  repositoriesShort: 'Repos',
  reviewReport: 'Review/Report',
};

/**
 * Issue #1219 migrated RepositoryManager from hardcoded English to
 * `common.repositories.*`. Same contract as the nav labels above: English must
 * stay byte-identical to the pre-migration markup, so a drift here is a
 * user-visible regression rather than an intended copy change.
 *
 * `empty` predates this Issue (#1197, RepositoryList) and is pinned alongside
 * the rest because it shares the section.
 */
const EN_REPOSITORY_LABELS: Record<string, string> = {
  empty: 'No repositories registered yet.',
  add: 'Add Repository',
  syncAll: 'Sync All',
  syncing: 'Syncing...',
  addNewTitle: 'Add New Repository',
  localPathTab: 'Local Path',
  cloneUrlTab: 'Clone URL',
  localPathDescription: 'Enter the absolute path to a git repository containing worktrees.',
  localPathLabel: 'Repository Path',
  localPathExample: 'Example: /Users/username/projects/my-repo',
  scan: 'Scan & Add',
  scanning: 'Scanning...',
  cloneUrlDescription: 'Enter a git clone URL to clone a remote repository.',
  cloneUrlLabel: 'Clone URL',
  cloneUrlHelp: 'Supports HTTPS and SSH URLs',
  clone: 'Clone',
  cloning: 'Cloning...',
  cloneSuccess: 'Repository cloned successfully',
  cloneFailed: 'Clone failed',
  pathRequired: 'Repository path is required',
  urlRequired: 'Clone URL is required',
  urlInvalid: 'Invalid URL format',
};

const REPOSITORY_KEYS = Object.keys(EN_REPOSITORY_LABELS);

/**
 * Issue #1273 migrated the shared chrome in components/{ui,common,sidebar} off
 * hardcoded English. Same contract as the sections above: every value is the
 * byte-exact pre-migration literal, lifted from `git show HEAD:<file>` rather
 * than retyped, so a drift here is a user-visible regression.
 *
 * `status.*` is deliberately generic rather than StatusDot-specific: the same
 * six words are still hardcoded in `src/config/status-colors.ts`, so that
 * migration reuses these keys instead of forking a second set of translations.
 */
const EN_SHARED_CHROME: Record<string, string> = {
  'status.idle': 'Idle',
  'status.ready': 'Ready',
  'status.running': 'Running',
  'status.generating': 'Generating',
  'status.waiting': 'Waiting for response',
  'status.error': 'Error',
  'status.unknown': 'Unknown',
  'sort.options': 'Sort options',
  'sort.updatedAt': 'Updated',
  'sort.repositoryName': 'Repository',
  'sort.branchName': 'Branch',
  'sort.status': 'Status',
  'branchItem.cliToolStatus': 'CLI tool status',
  'branchItem.hasUnread': 'Has unread messages',
  language: 'Language',
  loadingPage: 'Loading page',
  closeNotification: 'Close notification',
  // Predates #1273; pinned because Modal / FullScreenModal now resolve their
  // close button through it, so a change here silently retitles both.
  close: 'Close',
};

const SHARED_CHROME_KEYS = Object.keys(EN_SHARED_CHROME);

describe('common i18n keys (Issue #1197)', () => {
  it.each(['en', 'ja'])('%s/common.json has non-empty values for every leaf', (locale) => {
    const dict = loadCommon(locale);
    const keys = leafKeys(dict);
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      expect(resolve(dict, key), `${locale}: ${key}`).toBeTruthy();
    }
  });

  it('en and ja expose the identical set of keys (parity)', () => {
    const en = leafKeys(loadCommon('en')).sort();
    const ja = leafKeys(loadCommon('ja')).sort();
    expect(en).toEqual(ja);
  });

  it('resolves every shared nav label in both locales', () => {
    for (const locale of ['en', 'ja']) {
      const dict = loadCommon(locale);
      for (const key of NAV_KEYS) {
        const value = resolve(dict, `nav.${key}`);
        expect(value, `${locale} missing nav.${key}`).toBeTruthy();
        expect(typeof value, `${locale}: nav.${key} must be a string`).toBe('string');
      }
    }
  });

  /**
   * Guards the specific regression this Issue's migration could introduce: if
   * a locale silently kept the key path as its value (or a copy/paste left the
   * dotted key in place), the UI would render "nav.chat" and every mocked test
   * would still pass.
   */
  it('never uses a raw key path as a nav label', () => {
    for (const locale of ['en', 'ja']) {
      const dict = loadCommon(locale);
      for (const key of NAV_KEYS) {
        const value = resolve(dict, `nav.${key}`) as string;
        expect(value, `${locale}: nav.${key} looks like a key passthrough`).not.toMatch(
          /^(common\.)?nav\./
        );
      }
    }
  });

  it('translates nav labels rather than leaving them in English', () => {
    const en = loadCommon('en');
    const ja = loadCommon('ja');
    for (const key of NAV_KEYS) {
      expect(
        resolve(ja, `nav.${key}`),
        `ja: nav.${key} is still the English string`
      ).not.toBe(resolve(en, `nav.${key}`));
    }
  });

  it('keeps every English nav label byte-identical to the pre-i18n markup (Issue #1206)', () => {
    const en = loadCommon('en');
    for (const [key, expected] of Object.entries(EN_NAV_LABELS)) {
      expect(resolve(en, `nav.${key}`), `en: nav.${key} changed the rendered label`).toBe(expected);
    }
  });

  /**
   * The header deliberately abbreviates where the mobile bar does not, so the
   * short keys must never collapse onto the full ones - that collapse is
   * exactly what "just reuse nav.repositories" would silently do.
   */
  it('keeps the header abbreviations distinct from the full English labels (Issue #1206)', () => {
    const en = loadCommon('en');
    expect(resolve(en, 'nav.repositoriesShort')).not.toBe(resolve(en, 'nav.repositories'));
    expect(resolve(en, 'nav.reviewReport')).not.toBe(resolve(en, 'nav.review'));
  });

  it('includes the repository list empty-state copy', () => {
    for (const locale of ['en', 'ja']) {
      const value = resolve(loadCommon(locale), 'repositories.empty');
      expect(value, `${locale} missing repositories.empty`).toBeTruthy();
    }
  });

  describe('repository management copy (Issue #1219)', () => {
    it('resolves every repository label in both locales', () => {
      for (const locale of ['en', 'ja']) {
        const dict = loadCommon(locale);
        for (const key of REPOSITORY_KEYS) {
          const value = resolve(dict, `repositories.${key}`);
          expect(value, `${locale} missing repositories.${key}`).toBeTruthy();
          expect(typeof value, `${locale}: repositories.${key} must be a string`).toBe('string');
        }
      }
    });

    it('never uses a raw key path as a repository label', () => {
      for (const locale of ['en', 'ja']) {
        const dict = loadCommon(locale);
        for (const key of REPOSITORY_KEYS) {
          const value = resolve(dict, `repositories.${key}`) as string;
          expect(
            value,
            `${locale}: repositories.${key} looks like a key passthrough`
          ).not.toMatch(/^(common\.)?repositories\./);
        }
      }
    });

    it('translates repository labels rather than leaving them in English', () => {
      const en = loadCommon('en');
      const ja = loadCommon('ja');
      for (const key of REPOSITORY_KEYS) {
        expect(
          resolve(ja, `repositories.${key}`),
          `ja: repositories.${key} is still the English string`
        ).not.toBe(resolve(en, `repositories.${key}`));
      }
    });

    it('keeps every English repository label byte-identical to the pre-i18n markup', () => {
      const en = loadCommon('en');
      for (const [key, expected] of Object.entries(EN_REPOSITORY_LABELS)) {
        expect(
          resolve(en, `repositories.${key}`),
          `en: repositories.${key} changed the rendered label`
        ).toBe(expected);
      }
    });

    /**
     * The sample path is a copy-paste value, not prose: both locales must keep
     * it verbatim, so only the "Example:"/"例:" label may differ.
     */
    it('keeps the sample path verbatim in both locales', () => {
      for (const locale of ['en', 'ja']) {
        expect(
          resolve(loadCommon(locale), 'repositories.localPathExample'),
          `${locale}: sample path must stay copy-pasteable`
        ).toContain('/Users/username/projects/my-repo');
      }
    });
  });

  describe('shared chrome copy (Issue #1273)', () => {
    it('resolves every shared-chrome key in both locales', () => {
      for (const locale of ['en', 'ja']) {
        const dict = loadCommon(locale);
        for (const key of SHARED_CHROME_KEYS) {
          const value = resolve(dict, key);
          expect(value, `${locale} missing ${key}`).toBeTruthy();
          expect(typeof value, `${locale}: ${key} must be a string`).toBe('string');
        }
      }
    });

    it('never uses a raw key path as a shared-chrome label', () => {
      for (const locale of ['en', 'ja']) {
        const dict = loadCommon(locale);
        for (const key of SHARED_CHROME_KEYS) {
          expect(
            resolve(dict, key) as string,
            `${locale}: ${key} looks like a key passthrough`
          ).not.toMatch(/^(common\.)?(status|sort|branchItem)\./);
        }
      }
    });

    it('translates shared-chrome labels rather than leaving them in English', () => {
      const en = loadCommon('en');
      const ja = loadCommon('ja');
      for (const key of SHARED_CHROME_KEYS) {
        expect(resolve(ja, key), `ja: ${key} is still the English string`).not.toBe(
          resolve(en, key)
        );
      }
    });

    it('keeps every English shared-chrome label byte-identical to the pre-i18n markup', () => {
      const en = loadCommon('en');
      for (const [key, expected] of Object.entries(EN_SHARED_CHROME)) {
        expect(resolve(en, key), `en: ${key} changed the rendered label`).toBe(expected);
      }
    });

    /**
     * Every status label must stay distinct: the dot's colour alone does not
     * separate running from ready under prefers-reduced-motion, so the
     * accessible label is the only cue a screen-reader user gets.
     */
    it('gives every status a distinct label in both locales', () => {
      for (const locale of ['en', 'ja']) {
        const dict = loadCommon(locale);
        const labels = SHARED_CHROME_KEYS.filter((k) => k.startsWith('status.')).map((k) =>
          resolve(dict, k)
        );
        expect(new Set(labels).size, `${locale}: two statuses share a label`).toBe(labels.length);
      }
    });
  });
});
