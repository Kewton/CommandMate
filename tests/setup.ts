// Vitest setup file
import { beforeAll, afterAll, afterEach, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';

// Mock next-intl for all component tests
vi.mock('next-intl', () => ({
  useTranslations: (namespace?: string) => {
    return (key: string, params?: Record<string, string | number>) => {
      const fullKey = namespace ? `${namespace}.${key}` : key;
      if (params) {
        return Object.entries(params).reduce(
          (str, [k, v]) => str.replace(`{${k}}`, String(v)),
          fullKey
        );
      }
      return fullKey;
    };
  },
  useLocale: () => 'en',
  NextIntlClientProvider: ({ children }: { children: React.ReactNode }) => children,
}));

// グローバルなテスト設定

beforeAll(() => {
  // テスト開始時の初期化処理

  // Mock Element.scrollTo for jsdom (only in browser-like environments)
  if (typeof Element !== 'undefined' && typeof Element.prototype.scrollTo !== 'function') {
    Element.prototype.scrollTo = function(options?: ScrollToOptions | number) {
      if (typeof options === 'object') {
        this.scrollTop = options.top ?? 0;
        this.scrollLeft = options.left ?? 0;
      }
    };
  }

  // Polyfill window.matchMedia for jsdom (Issue #1069). jsdom does not
  // implement it, so hooks that switched from window.innerWidth to matchMedia
  // (e.g. useIsMobile) would throw. This lightweight stub evaluates the
  // min-/max-width bounds of a query against window.innerWidth and re-evaluates
  // on window `resize`, translating each crossing into a `change` event — so
  // component tests that drive layout by mutating innerWidth + dispatching
  // `resize` keep working without per-file matchMedia mocks.
  if (typeof window !== 'undefined' && typeof window.matchMedia !== 'function') {
    const evaluate = (query: string): boolean => {
      const maxMatch = query.match(/max-width:\s*(\d+(?:\.\d+)?)px/);
      const minMatch = query.match(/min-width:\s*(\d+(?:\.\d+)?)px/);
      const width = window.innerWidth;
      if (maxMatch && width > Number(maxMatch[1])) return false;
      if (minMatch && width < Number(minMatch[1])) return false;
      return Boolean(maxMatch || minMatch);
    };

    window.matchMedia = (query: string): MediaQueryList => {
      const listeners = new Set<(event: MediaQueryListEvent) => void>();
      let matches = evaluate(query);
      const onResize = () => {
        const next = evaluate(query);
        if (next !== matches) {
          matches = next;
          const event = { matches, media: query } as MediaQueryListEvent;
          listeners.forEach((listener) => listener(event));
        }
      };
      window.addEventListener('resize', onResize);

      return {
        media: query,
        get matches() {
          return matches;
        },
        onchange: null,
        addEventListener: (type: string, listener: (event: MediaQueryListEvent) => void) => {
          if (type === 'change') listeners.add(listener);
        },
        removeEventListener: (type: string, listener: (event: MediaQueryListEvent) => void) => {
          if (type === 'change') listeners.delete(listener);
        },
        addListener: (listener: (event: MediaQueryListEvent) => void) => {
          listeners.add(listener);
        },
        removeListener: (listener: (event: MediaQueryListEvent) => void) => {
          listeners.delete(listener);
        },
        dispatchEvent: () => false,
      } as unknown as MediaQueryList;
    };
  }
});

afterEach(() => {
  // 各テスト後のクリーンアップ
});

afterAll(() => {
  // すべてのテスト終了後のクリーンアップ
});
