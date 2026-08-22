// Vitest setup file
import { beforeAll, afterAll, afterEach, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import '@testing-library/jest-dom/vitest';
import {
  REAL_SHELL_TEST_TIMEOUT_MS,
  startsRealSubprocess,
} from './helpers/real-shell-budget';

// Issue #1950: give tests that start a real subprocess a budget that matches
// what they actually do.
//
// This runs once per test file, before collection, so `vi.setConfig` here is
// the file's default rather than a per-test override: an `it()` that states its
// own timeout still wins, which is how `compose` keeps its 300_000 and how a
// future test can opt back down.
//
// Membership is read off the file's own source instead of a path list, because
// a list is a thing that goes stale the first time somebody writes a new test
// that shells out. The cost is one `readFileSync` per test file — ~974 reads
// spread across the worker pool, against a suite whose baseline is 66s — and
// only the ~7% of files that match go on to change their budget.
//
// Why this cannot be expressed in vitest.config.ts: `testTimeout` there is
// global or per-`projects` entry, and splitting the family into its own project
// changes the pool the files run in. The budget is the fix; the pool is not
// (serializing the family was measured at 3x the wall clock and rejected).
// See tests/helpers/real-shell-budget.ts for the measurements.
const currentTestPath = expect.getState().testPath;
if (currentTestPath !== undefined) {
  let source = '';
  try {
    source = readFileSync(currentTestPath, 'utf8');
  } catch {
    // A file vitest can run but this process cannot read is not a case worth
    // failing the suite over; it simply keeps the default budget.
    source = '';
  }
  if (startsRealSubprocess(source)) {
    vi.setConfig({
      testTimeout: REAL_SHELL_TEST_TIMEOUT_MS,
      hookTimeout: REAL_SHELL_TEST_TIMEOUT_MS,
    });
  }
}

// Issue #1760: keep agent config generation out of the developer's home.
//
// `CodexTool.startSession` writes codex's hooks file, and codex reads exactly
// one location — `$CODEX_HOME/hooks.json`, defaulting to `~/.codex/hooks.json`.
// So any test that starts a codex session, including ones written long after
// this line, would edit the real file on whatever machine ran the suite. Pinned
// here rather than per file because the default is what makes it dangerous.
// A test that cares about the path sets its own value; this only fills a gap.
process.env.CODEX_HOME ??= join(tmpdir(), 'commandmate-test-codex-home');

// Issue #1873: keep worktree-index claims out of the developer's home.
//
// `executeRun` hands every command gate `CM_WORKTREE_INDEX`, and minting that
// number calls `resolveWorktreeIndex(worktreeId)` with no `root`
// (`src/lib/verification/gate-runner.ts`), so it lands in
// `~/.commandmate/worktree-index/` — the *shared, deliberately permanent*
// registry that numbers this machine's real worktrees. Slots are never
// released, so every `wt-*` fixture that ever ran burned one: measured on the
// author's machine, 40 of 45 entries were fixtures that had never been a
// worktree.
//
// Pinned here rather than per file for the same reason as CODEX_HOME above:
// the default is what makes it dangerous, so the fix has to sit where a test
// written next month inherits it without knowing the hazard exists. The three
// files that were leaking (`gate-runner`, `gate-runner-timestamps`,
// `hooks-agent-event`) plus `require-commit-conformance` never mention this
// variable; `gate-mutex` / `gate-flaky` / `worktree-index` already redirect
// themselves and keep doing so — `vi.stubEnv` and an explicit `{ root }`
// argument both still win over this line.
//
// Filled only when absent *or blank*, not unconditionally, because the
// override exists for isolated runners too and an explicitly chosen root must
// survive. Blank counts as absent because `resolveWorktreeIndexRoot` itself
// treats an empty or whitespace value as unset — leaving one in place would
// silently route back to the real registry, which is the exact bug this line
// closes.
//
// One shared path under tmpdir is safe: claims are `O_EXCL` creates keyed by
// worktree id, so concurrent suites in different checkouts either reuse their
// own slot or take the next free one, never each other's.
if ((process.env.CM_VERIFY_WORKTREE_INDEX_ROOT ?? '').trim() === '') {
  process.env.CM_VERIFY_WORKTREE_INDEX_ROOT = join(tmpdir(), 'commandmate-test-worktree-index');
}

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
