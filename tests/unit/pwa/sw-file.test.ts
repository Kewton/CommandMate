/**
 * Guard tests for the shipped Service Worker file (Issue #1124).
 *
 * `public/sw.js` is a hand-written vanilla worker that cannot import from the
 * bundled source, so these tests assert it stays in sync with the tested
 * policy in src/lib/pwa/cache-policy.ts and preserves the safety invariants
 * (only same-origin GET, denylist for API/auth/proxy, explicit update flow,
 * Web Push extension point).
 *
 * Issue #2504 added the last two blocks, which check the mirror by EVALUATING
 * the shipped file instead of searching it for strings. See the comment above
 * them for why a string search is not sufficient for this particular decision.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import {
  EXCLUDED_PATH_PREFIXES,
  STATIC_CACHE_PREFIXES,
  STATIC_CACHE_EXACT,
  OFFLINE_URL,
  isExcludedPath,
  isStaticAsset,
} from '@/lib/pwa/cache-policy';
import {
  collectApiRoutePaths,
  MIN_EXPECTED_API_ROUTES,
  NON_API_UNCACHEABLE_PATHS,
  NOT_EXCLUDED_PATHS,
} from './api-route-corpus';

const swSource = readFileSync(resolve(__dirname, '../../../public/sw.js'), 'utf8');

/** Any origin works: the policy decides on path shape, not on host. */
const ORIGIN = 'https://app.example.com';

describe('public/sw.js integrity', () => {
  it('mirrors every excluded (never-cached) prefix from the policy', () => {
    for (const prefix of EXCLUDED_PATH_PREFIXES) {
      expect(swSource).toContain(`'${prefix}'`);
    }
  });

  it('mirrors every static cache-first prefix from the policy', () => {
    for (const prefix of STATIC_CACHE_PREFIXES) {
      expect(swSource).toContain(`'${prefix}'`);
    }
  });

  it('mirrors the exact static cache entries from the policy', () => {
    for (const path of STATIC_CACHE_EXACT) {
      expect(swSource).toContain(`'${path}'`);
    }
  });

  it('precaches the offline fallback route', () => {
    expect(swSource).toContain(`'${OFFLINE_URL}'`);
  });
});

describe('public/sw.js safety invariants', () => {
  it('only handles GET requests', () => {
    expect(swSource).toMatch(/request\.method\s*!==\s*'GET'/);
  });

  it('restricts caching to same-origin requests', () => {
    expect(swSource).toContain('self.location.origin');
  });

  it('short-circuits excluded paths before any cache read/write', () => {
    expect(swSource).toContain('isExcludedPath');
  });

  it('does not skipWaiting on install (waits for user confirmation)', () => {
    // skipWaiting must only appear inside the message handler, never at install.
    const installBlock = swSource.slice(
      swSource.indexOf("addEventListener('install'"),
      swSource.indexOf("addEventListener('activate'")
    );
    expect(installBlock).not.toContain('skipWaiting');
  });

  it('applies updates via a SKIP_WAITING message', () => {
    expect(swSource).toContain('SKIP_WAITING');
    expect(swSource).toContain('self.skipWaiting()');
  });

  it('keeps a Web Push extension point for the follow-up issue', () => {
    expect(swSource).toContain('#1125');
  });
});

describe('public/sw.js userVisibleOnly contract (Issue #2001)', () => {
  /**
   * The resolution helper, sliced out of the file. Placed above the `push`
   * listener in sw.js on purpose so this slice is well defined.
   */
  const helper = swSource.slice(
    swSource.indexOf('function replaceStaleNotifications'),
    swSource.indexOf("addEventListener('push'")
  );

  it('ships the cross-device clear at all', () => {
    expect(helper).toContain('getNotifications');
    expect(helper).toContain('.close()');
  });

  it('never ends a push event without a displayed notification', () => {
    // Every subscription is created with `userVisibleOnly: true`
    // (NotificationsSettings). Each engine checks what is *displayed* when the
    // waitUntil promise settles, so closing after showing — or not showing at
    // all — is a contract violation: Chrome substitutes its own generic card,
    // Firefox spends a silent-push quota, WebKit revokes the subscription.
    // docs/design/cross-device-notification-dismissal.md carries the citations.
    expect(helper).toContain('showNotification');
    expect(helper.indexOf('.close()')).toBeLessThan(helper.indexOf('showNotification'));
  });

  it('keeps the resolution silent and non-renotifying', () => {
    const pushBlock = swSource.slice(
      swSource.indexOf("addEventListener('push'"),
      swSource.indexOf("addEventListener('notificationclick'")
    );
    expect(pushBlock).toContain('renotify: !resolved');
    expect(pushBlock).toContain('options.silent = true');
  });
});

// ---------------------------------------------------------------------------
// Issue #2504 — the mirror, checked by RUNNING it rather than by grepping it.
// ---------------------------------------------------------------------------
//
// Everything above asserts that certain strings appear in public/sw.js. That is
// enough to catch a constant added on one side only, and not enough to catch the
// failure Issue #2504 is about: `matchesPrefix()` is a PREFIX matcher, there are
// 36 sibling routes under `/api/worktrees/[id]` (`current-output`, `files`,
// `env`, `messages`, `terminal`, `logs`, `capture` among them), and an allowlist
// entry for `/api/worktrees` written with that matcher would swallow every one
// of them. A divergence in the matcher's LOGIC — as opposed to its constants —
// passes a string search silently, and its symptom is terminal output and file
// contents written to the device's disk.
//
// So these two blocks evaluate the shipped worker, pull its real decision
// functions out, and require them to agree with the tested policy over every API
// route that exists; then they pin that the file has exactly one cache writer.
//
// The full argument for the wontfix is the design policy filed on Issue #2504;
// src/lib/pwa/cache-policy.ts carries the short version.

/** The decision surface public/sw.js defines, once evaluated. */
interface ShippedPolicy {
  isExcludedPath: (pathname: string) => boolean;
  isStaticAsset: (pathname: string) => boolean;
  EXCLUDED_PATH_PREFIXES: string[];
  STATIC_CACHE_PREFIXES: string[];
  STATIC_CACHE_EXACT: string[];
  OFFLINE_URL: string;
}

/**
 * Evaluate public/sw.js with the Service Worker globals stubbed, and hand back
 * the decision functions it defines plus the event types it registered.
 *
 * The file is a classic script, not a module, so its top-level function
 * declarations are hoisted into the Function body's scope and can simply be
 * returned. `self` / `caches` / `fetch` are parameters, so they shadow the real
 * globals for the whole file. Its only top-level side effects are the
 * `self.addEventListener` calls, which the stub records and never invokes —
 * nothing on the cache or fetch path runs here.
 */
function loadShippedPolicy(): { policy: ShippedPolicy; registered: string[] } {
  const registered: string[] = [];
  const selfStub = {
    addEventListener: (type: string) => {
      registered.push(type);
    },
    location: { origin: ORIGIN },
    registration: {
      showNotification: () => Promise.resolve(),
      getNotifications: () => Promise.resolve([]),
    },
    clients: { claim: () => Promise.resolve(), matchAll: () => Promise.resolve([]) },
    skipWaiting: () => undefined,
  };
  const cachesStub = {
    open: () => Promise.resolve({}),
    keys: () => Promise.resolve([]),
    delete: () => Promise.resolve(true),
    match: () => Promise.resolve(undefined),
  };

  const factory = new Function(
    'self',
    'caches',
    'fetch',
    `${swSource}
return {
  isExcludedPath: isExcludedPath,
  isStaticAsset: isStaticAsset,
  EXCLUDED_PATH_PREFIXES: EXCLUDED_PATH_PREFIXES,
  STATIC_CACHE_PREFIXES: STATIC_CACHE_PREFIXES,
  STATIC_CACHE_EXACT: STATIC_CACHE_EXACT,
  OFFLINE_URL: OFFLINE_URL,
};`
  ) as (selfArg: unknown, cachesArg: unknown, fetchArg: unknown) => ShippedPolicy;

  const policy = factory(selfStub, cachesStub, () =>
    Promise.reject(new Error('no network in this test'))
  );
  return { policy, registered };
}

describe('public/sw.js mirrors the policy behaviourally (Issue #2504)', () => {
  const { policy: shipped, registered } = loadShippedPolicy();
  const apiPaths = collectApiRoutePaths();

  it('evaluates, and installs its handlers', () => {
    // Without this, a sandbox that stopped being able to load the file would
    // leave every differential assertion below comparing nothing to nothing.
    expect(typeof shipped.isExcludedPath).toBe('function');
    expect(typeof shipped.isStaticAsset).toBe('function');
    expect(registered).toEqual(
      expect.arrayContaining(['install', 'activate', 'fetch', 'message', 'push'])
    );
  });

  it('ships the same constants the policy declares', () => {
    expect(shipped.EXCLUDED_PATH_PREFIXES).toEqual([...EXCLUDED_PATH_PREFIXES]);
    expect(shipped.STATIC_CACHE_PREFIXES).toEqual([...STATIC_CACHE_PREFIXES]);
    expect(shipped.STATIC_CACHE_EXACT).toEqual([...STATIC_CACHE_EXACT]);
    expect(shipped.OFFLINE_URL).toBe(OFFLINE_URL);
  });

  it('excludes every API route that exists', () => {
    expect(apiPaths.length).toBeGreaterThanOrEqual(MIN_EXPECTED_API_ROUTES);
    expect(apiPaths.filter((path) => !shipped.isExcludedPath(path))).toEqual([]);
  });

  it('agrees with the policy on every path in the corpus', () => {
    const corpus = [
      ...apiPaths,
      ...NON_API_UNCACHEABLE_PATHS,
      ...NOT_EXCLUDED_PATHS,
      ...STATIC_CACHE_PREFIXES.map((prefix) => `${prefix}chunk.js`),
      ...STATIC_CACHE_EXACT,
      OFFLINE_URL,
    ];
    const disagreements: string[] = [];
    for (const path of corpus) {
      const shippedExcluded = shipped.isExcludedPath(path);
      if (shippedExcluded !== isExcludedPath(path)) {
        disagreements.push(
          `isExcludedPath(${path}): sw.js=${shippedExcluded} policy=${isExcludedPath(path)}`
        );
      }
      const shippedStatic = shipped.isStaticAsset(path);
      if (shippedStatic !== isStaticAsset(path)) {
        disagreements.push(
          `isStaticAsset(${path}): sw.js=${shippedStatic} policy=${isStaticAsset(path)}`
        );
      }
    }
    expect(disagreements).toEqual([]);
  });
});

describe('public/sw.js has exactly one cache writer (Issue #2504)', () => {
  /**
   * The shipped worker with its comments blanked out, line by line.
   *
   * The guards in this block are about what the file DOES, so they must not
   * read what it says about itself. Two reasons, and both bit: the file is
   * expected to carry a comment naming the strategy Issue #2504 rejected, which
   * a search of the raw source would report as the strategy being present; and
   * commented-out code must neither trip a guard nor satisfy one.
   *
   * Blanked rather than deleted so every index stays where it was and the
   * ranges below still line up with the real file. `public/sw.js` has no string
   * literal containing `//`, so a line-based filter is exact here.
   */
  const swCode = swSource
    .split('\n')
    .map((line) => {
      const trimmed = line.trimStart();
      const isComment =
        trimmed.startsWith('//') ||
        trimmed.startsWith('/*') ||
        trimmed.startsWith('*/') ||
        trimmed.startsWith('*');
      return isComment ? ' '.repeat(line.length) : line;
    })
    .join('\n');

  /** Every index at which `needle` occurs in the shipped code. */
  function occurrences(needle: string): number[] {
    const found: number[] = [];
    for (let at = swCode.indexOf(needle); at !== -1; at = swCode.indexOf(needle, at + 1)) {
      found.push(at);
    }
    return found;
  }

  /**
   * `[start, end)` of ONE top-level function in the shipped source.
   *
   * The end is that function's own closing brace — the first `}` in column 0
   * after the declaration, since every nested brace in this file is indented —
   * and NOT the next declaration. Ending at the next declaration was the first
   * version of this helper, and it had the defect it exists to catch: a
   * `staleWhileRevalidate` helper inserted between `cacheFirst` and
   * `offlineFallback` landed INSIDE the range and its `cache.put` was counted as
   * one of `cacheFirst`'s own. Measured, not imagined — that mutation was run.
   *
   * Throws rather than asserting: this runs while the suite is being collected,
   * where `expect` is not available.
   */
  function functionRange(declaration: string): [number, number] {
    const start = swCode.indexOf(declaration);
    if (start === -1) {
      throw new Error(
        `public/sw.js no longer declares "${declaration}" — the structural guards ` +
          'below cannot locate the cache helpers. Update the anchors.'
      );
    }
    const close = swCode.indexOf('\n}', start);
    if (close === -1) {
      throw new Error(`Could not find the closing brace of "${declaration}" in public/sw.js.`);
    }
    return [start, close + 2];
  }

  const cacheFirst = functionRange('async function cacheFirst');
  const offlineFallback = functionRange('async function offlineFallback');

  const inside = (at: number, range: [number, number]) => at >= range[0] && at < range[1];

  it('writes to the cache only from cacheFirst', () => {
    // `cacheFirst` is reachable only for STATIC_CACHE_* paths. A `cache.put`
    // anywhere else is a second, unreviewed writer — the shape a
    // stale-while-revalidate patch takes.
    const writes = occurrences('cache.put(');
    expect(writes.length).toBeGreaterThan(0);
    expect(writes.filter((at) => !inside(at, cacheFirst))).toEqual([]);
  });

  it('reads the cache only in cacheFirst (assets) and offlineFallback (the offline page)', () => {
    const reads = occurrences('cache.match(');
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.filter((at) => !inside(at, cacheFirst) && !inside(at, offlineFallback))).toEqual(
      []
    );
  });

  it('carries no stale-while-revalidate strategy', () => {
    // Named strategies rather than a vague pattern, so the failure message says
    // what was added. If one of these becomes legitimate, Issue #2504's
    // conclusion has been reversed — which belongs in a design memo and a
    // deliberate edit here, not in a test that quietly still passes.
    for (const forbidden of ['stale-while-revalidate', 'staleWhileRevalidate', 'networkFirst']) {
      expect(swCode).not.toContain(forbidden);
    }
  });

  it('rules out excluded paths before anything can reach respondWith', () => {
    const fetchHandler = swCode.slice(
      swCode.indexOf("self.addEventListener('fetch'"),
      swCode.indexOf("self.addEventListener('message'")
    );
    expect(fetchHandler).toContain('isExcludedPath');
    expect(fetchHandler.indexOf('isExcludedPath')).toBeLessThan(fetchHandler.indexOf('respondWith'));
  });
});
