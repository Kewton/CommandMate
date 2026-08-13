// Vitest setup file
import { beforeAll, afterAll, afterEach, vi } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import '@testing-library/jest-dom/vitest';

// Issue #1760: keep agent config generation out of the developer's home.
//
// `CodexTool.startSession` writes codex's hooks file, and codex reads exactly
// one location — `$CODEX_HOME/hooks.json`, defaulting to `~/.codex/hooks.json`.
// So any test that starts a codex session, including ones written long after
// this line, would edit the real file on whatever machine ran the suite. Pinned
// here rather than per file because the default is what makes it dangerous.
// A test that cares about the path sets its own value; this only fills a gap.
process.env.CODEX_HOME ??= join(tmpdir(), 'commandmate-test-codex-home');

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

  // Polyfill ResizeObserver for jsdom (Issue #1080). Radix primitives such as
  // ui/Switch measure their thumb via `useSize` (ResizeObserver) in a layout
  // effect. AutoYesToggle now renders a Radix Switch, so any tree that mounts it
  // (worktree detail, composer meta row) would otherwise throw
  // "ResizeObserver is not defined". Global + benign (jsdom has no native impl).
  if (typeof window !== 'undefined' && !('ResizeObserver' in window)) {
    class ResizeObserverStub {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
    (window as unknown as { ResizeObserver: unknown }).ResizeObserver = ResizeObserverStub;
  }

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
      // Issue #1519: orientation queries (useIsPortrait) resolve from the
      // viewport aspect ratio, mirroring how browsers answer them.
      const orientationMatch = query.match(/orientation:\s*(portrait|landscape)/);
      if (orientationMatch) {
        const portrait = window.innerHeight >= window.innerWidth;
        return orientationMatch[1] === 'portrait' ? portrait : !portrait;
      }
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
