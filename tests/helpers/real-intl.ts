/**
 * Real-dictionary next-intl mock (Issue #1206).
 *
 * The global mock in tests/setup.ts echoes `namespace.key` back, so a component
 * test can assert a label while the real dictionary has no such entry — the
 * exact blind spot that let #1197's nav labels ship half-migrated. Components
 * whose *rendered wording* is the thing under test should mock next-intl with
 * this factory instead, so `getByText('Repos')` proves the key resolves through
 * locales/<locale>/<namespace>.json to that literal string.
 *
 * Unknown keys throw rather than falling back: a silent passthrough here would
 * recreate the very blind spot this helper exists to close.
 *
 * @example
 * ```ts
 * vi.mock('next-intl', async () => {
 *   const { createRealIntlMock } = await import('@tests/helpers/real-intl');
 *   return createRealIntlMock('en');
 * });
 * ```
 *
 * @example Switching locale per test (pass a getter — vi.mock factories are hoisted)
 * ```ts
 * const locale = vi.hoisted(() => ({ current: 'en' }));
 * vi.mock('next-intl', async () => {
 *   const { createRealIntlMock } = await import('@tests/helpers/real-intl');
 *   return createRealIntlMock(() => locale.current);
 * });
 * ```
 */

import fs from 'fs';
import path from 'path';

const LOCALES_DIR = path.resolve(__dirname, '../../locales');

function loadNamespace(locale: string, namespace: string): Record<string, unknown> {
  const filePath = path.join(LOCALES_DIR, locale, `${namespace}.json`);
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

function resolve(dict: Record<string, unknown>, key: string): unknown {
  return key
    .split('.')
    .reduce<unknown>((acc, part) => (acc as Record<string, unknown>)?.[part], dict);
}

export interface RealIntlMock {
  useTranslations: (
    namespace?: string
  ) => (key: string, params?: Record<string, string | number>) => string;
  useLocale: () => string;
  NextIntlClientProvider: (props: { children: unknown }) => unknown;
}

type Translate = (key: string, params?: Record<string, string | number>) => string;

export function createRealIntlMock(locale: string | (() => string)): RealIntlMock {
  const currentLocale = typeof locale === 'function' ? locale : () => locale;
  const cache = new Map<string, Record<string, unknown>>();
  const translatorCache = new Map<string, Translate>();

  const dictFor = (loc: string, namespace: string): Record<string, unknown> => {
    const cacheKey = `${loc}/${namespace}`;
    let dict = cache.get(cacheKey);
    if (!dict) {
      dict = loadNamespace(loc, namespace);
      cache.set(cacheKey, dict);
    }
    return dict;
  };

  const translatorFor = (loc: string, namespace: string): Translate => {
    const cacheKey = `${loc}/${namespace}`;
    let translate = translatorCache.get(cacheKey);
    if (!translate) {
      translate = (key, params) => {
        const value = resolve(dictFor(loc, namespace), key);
        if (typeof value !== 'string') {
          throw new Error(`real-intl: ${loc}/${namespace}.json has no string at "${key}"`);
        }
        if (!params) return value;
        return Object.entries(params).reduce(
          (str, [k, v]) => str.replace(`{${k}}`, String(v)),
          value
        );
      };
      translatorCache.set(cacheKey, translate);
    }
    return translate;
  };

  return {
    // Real `useTranslations` memoizes the translator (use-intl wraps
    // createBaseTranslator in useMemo), so `t` keeps a stable identity across
    // renders and is safe to list in useCallback/useEffect deps. Cache per
    // locale+namespace here so this mock upholds that contract too — minting a
    // fresh closure per render turns a `[t]` dep into an infinite refetch loop
    // that only reproduces under the mock.
    useTranslations: (namespace?: string) => {
      if (!namespace) {
        throw new Error('real-intl: useTranslations() requires a namespace');
      }
      return translatorFor(currentLocale(), namespace);
    },
    useLocale: () => currentLocale(),
    NextIntlClientProvider: ({ children }) => children,
  };
}
