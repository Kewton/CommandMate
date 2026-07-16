/**
 * Unit-level i18n parity test for the `externalApps` namespace (Issue #1273).
 *
 * `src/i18n.ts` has no onError / getMessageFallback, so a missing key in one
 * locale surfaces the raw key string in production. The global next-intl mock
 * (tests/setup.ts) echoes the full key back, so a component test would stay
 * green against a dictionary that never had the entry — mirroring
 * common-keys / home-keys, this guard reads the real dictionary instead.
 *
 * Why a namespace of its own rather than a `common.externalApps.*` section:
 * external apps are a feature domain (Issue #42 — own route, API, types and
 * DB table), so their copy is owned by that domain the same way schedule /
 * autoYes / commandPalette own theirs. `common` is reserved for strings with
 * no single owning domain.
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const LOCALES_DIR = path.resolve(__dirname, '../../../locales');

function loadNamespace(locale: string): Record<string, unknown> {
  const filePath = path.join(LOCALES_DIR, locale, 'externalApps.json');
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

/**
 * The byte-exact pre-migration English, lifted from `git show HEAD:<file>` of
 * the four external-apps components rather than retyped. English must stay
 * display-neutral across this migration, so any drift here is a user-visible
 * regression that the component tests' mocked t() could never catch.
 */
const EN_LABELS: Record<string, string> = {
  'status.checking': 'Checking...',
  'status.running': 'Running',
  'status.stopped': 'Stopped',
  'card.status': 'Status',
  'card.port': 'Port',
  'card.path': 'Path',
  'card.websocket': 'WebSocket',
  'card.enabled': 'Enabled',
  'card.disabledNotice': 'This app is disabled',
  'card.deleteConfirm': 'Delete "{name}"?',
  'card.delete': 'Delete',
  'card.open': 'Open',
  'card.settings': 'Settings',
  'manager.addApp': '+ Add App',
  'manager.loading': 'Loading apps...',
  'manager.loadError': 'Failed to load external apps',
  'manager.empty': 'No external apps registered yet.',
  'manager.emptyHelp':
    'Add an external app to proxy requests to other frontend applications.',
  'manager.addFirst': 'Add Your First App',
  'form.editTitle': 'Edit External App',
  'form.addTitle': 'Add External App',
  'form.securityWarning':
    'Proxied apps run under the CommandMate origin and can access CommandMate APIs. Only register trusted applications.',
  'form.displayName': 'Display Name',
  'form.displayNamePlaceholder': 'My App',
  'form.identifierName': 'Identifier Name',
  'form.identifierNamePlaceholder': 'my-app',
  'form.identifierNameHelp': 'Alphanumeric and hyphens only. Cannot be changed later.',
  'form.pathPrefix': 'Path Prefix',
  'form.pathPrefixPlaceholder': 'app-name',
  'form.pathPrefixHelp': 'URL path for accessing this app. Cannot be changed later.',
  'form.portNumber': 'Port Number',
  'form.portNumberPlaceholder': '5173',
  'form.portNumberHelp': 'Target port ({min}-{max})',
  'form.appType': 'App Type',
  'form.appTypePlaceholder': 'Select app type...',
  'form.description': 'Description',
  'form.descriptionPlaceholder': 'Optional description...',
  'form.websocketLabel': 'Enable WebSocket support',
  'form.enabledLabel': 'App is enabled',
  'form.save': 'Save Changes',
  'form.add': 'Add App',
  'form.updateFailed': 'Failed to update app',
  'form.createFailed': 'Failed to create app',
  'form.genericError': 'An error occurred',
};

const ALL_KEYS = Object.keys(EN_LABELS);

/**
 * Sample inputs the user copies or types back. Translating a placeholder would
 * make the example wrong rather than localized (`my-app` must stay a legal
 * identifier, `5173` a port), so these are exempt from the "ja must differ
 * from en" rule rather than being an oversight.
 */
const LOCALE_INVARIANT_KEYS = new Set([
  'form.displayNamePlaceholder',
  'form.identifierNamePlaceholder',
  'form.pathPrefixPlaceholder',
  'form.portNumberPlaceholder',
]);

describe('externalApps i18n keys (Issue #1273)', () => {
  it.each(['en', 'ja'])('%s/externalApps.json has non-empty values for every leaf', (locale) => {
    const dict = loadNamespace(locale);
    const keys = leafKeys(dict);
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      expect(resolve(dict, key), `${locale}: ${key}`).toBeTruthy();
    }
  });

  it('en and ja expose the identical set of keys (parity)', () => {
    const en = leafKeys(loadNamespace('en')).sort();
    const ja = leafKeys(loadNamespace('ja')).sort();
    expect(en).toEqual(ja);
  });

  it('resolves every key the components request at runtime, in both locales', () => {
    for (const locale of ['en', 'ja']) {
      const dict = loadNamespace(locale);
      for (const key of ALL_KEYS) {
        const value = resolve(dict, key);
        expect(value, `${locale} missing ${key}`).toBeTruthy();
        expect(typeof value, `${locale}: ${key} must be a string`).toBe('string');
      }
    }
  });

  it('never uses a raw key path as a label', () => {
    for (const locale of ['en', 'ja']) {
      const dict = loadNamespace(locale);
      for (const key of ALL_KEYS) {
        expect(
          resolve(dict, key) as string,
          `${locale}: ${key} looks like a key passthrough`
        ).not.toMatch(/^(externalApps\.)?(status|card|manager|form)\./);
      }
    }
  });

  it('translates labels rather than leaving them in English', () => {
    const en = loadNamespace('en');
    const ja = loadNamespace('ja');
    for (const key of ALL_KEYS) {
      if (LOCALE_INVARIANT_KEYS.has(key)) continue;
      expect(resolve(ja, key), `ja: ${key} is still the English string`).not.toBe(
        resolve(en, key)
      );
    }
  });

  it('keeps every English label byte-identical to the pre-i18n markup', () => {
    const en = loadNamespace('en');
    for (const [key, expected] of Object.entries(EN_LABELS)) {
      expect(resolve(en, key), `en: ${key} changed the rendered label`).toBe(expected);
    }
  });

  it('keeps sample placeholders verbatim in both locales', () => {
    for (const locale of ['en', 'ja']) {
      const dict = loadNamespace(locale);
      for (const key of LOCALE_INVARIANT_KEYS) {
        expect(resolve(dict, key), `${locale}: ${key} must stay verbatim`).toBe(EN_LABELS[key]);
      }
    }
  });

  /**
   * The two interpolated strings must keep their ICU placeholders in every
   * locale: a translator dropping `{name}` / `{min}` silently renders a delete
   * prompt with no app name, or a port hint with no range.
   */
  it('preserves ICU placeholders in both locales', () => {
    for (const locale of ['en', 'ja']) {
      const dict = loadNamespace(locale);
      expect(resolve(dict, 'card.deleteConfirm'), `${locale}: lost {name}`).toContain('{name}');
      const portHelp = resolve(dict, 'form.portNumberHelp') as string;
      expect(portHelp, `${locale}: lost {min}`).toContain('{min}');
      expect(portHelp, `${locale}: lost {max}`).toContain('{max}');
    }
  });
});
