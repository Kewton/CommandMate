/**
 * The set of API paths the Service Worker must never cache (Issue #2504).
 *
 * Built by WALKING `src/app/api/**` rather than by listing paths in a test,
 * for one reason: a hand-written list stops covering the routes added after it
 * was written, and the routes added after it was written are exactly the ones
 * nobody thought about when deciding what may be cached. Issue #2504 counted 36
 * sibling routes under `/api/worktrees/[id]` alone — `current-output`, `files`,
 * `env`, `messages`, `capture`, `terminal`, `logs` among them — and the whole
 * reason that Issue was closed wontfix is that a prefix-matched allowlist would
 * have swallowed all of them. A corpus that grows with the tree is the only
 * version of this test that keeps being true.
 *
 * Consumed by BOTH sides of the mirrored policy:
 *   - tests/unit/pwa/cache-policy.test.ts  (src/lib/pwa/cache-policy.ts)
 *   - tests/unit/pwa/sw-file.test.ts       (public/sw.js, evaluated for real)
 *
 * Not named `*.test.ts` on purpose — vitest collects only those, so this file
 * is a helper and never a suite of its own.
 */
import { readdirSync } from 'fs';
import { resolve } from 'path';

/** Repository root, from this file's location. */
const REPO_ROOT = resolve(__dirname, '../../..');

/** Where Next's App Router keeps the API handlers. */
const API_DIR = resolve(REPO_ROOT, 'src/app/api');

/**
 * Below this, the walk is assumed to have failed rather than to have found a
 * genuinely small tree. An empty or truncated corpus makes every assertion in
 * both suites pass without testing anything — the one failure mode a test built
 * out of a directory walk actually has. 143 routes existed when Issue #2504 was
 * decided; 100 leaves room to delete a few without a false alarm.
 */
export const MIN_EXPECTED_API_ROUTES = 100;

/**
 * Concrete values substituted for Next's dynamic segments. The policy decides
 * on path shape alone, so any URL-safe value does; these are spelled to read
 * like a real request in a failure message.
 */
const DYNAMIC_SEGMENT_SAMPLE = 'sample-id';
const CATCH_ALL_SEGMENT_SAMPLE = 'src/lib/secret.ts';

/** Turn one App Router directory name into the path segment a request carries. */
function resolveSegment(segment: string): string {
  // `[...path]` / `[[...path]]` — a catch-all stands for one or more segments.
  if (/^\[{1,2}\.\.\./.test(segment)) return CATCH_ALL_SEGMENT_SAMPLE;
  // `[id]`, `[taskId]`, … — exactly one segment.
  if (segment.startsWith('[')) return DYNAMIC_SEGMENT_SAMPLE;
  // `(group)` — a route group contributes nothing to the URL.
  if (segment.startsWith('(')) return '';
  return segment;
}

/** Recursively collect the request paths of every `route.ts` under `dir`. */
function walk(dir: string, urlPath: string, out: string[]): void {
  const entries = readdirSync(dir, { withFileTypes: true });

  if (entries.some((entry) => entry.isFile() && entry.name === 'route.ts')) {
    out.push(urlPath);
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const segment = resolveSegment(entry.name);
    walk(
      resolve(dir, entry.name),
      segment === '' ? urlPath : `${urlPath}/${segment}`,
      out
    );
  }
}

/**
 * Every API request path that exists in this tree, as a pathname.
 *
 * Catch-all segments are expanded with a multi-segment sample, so
 * `/api/worktrees/[id]/files/[...path]` arrives as a path with a file inside it
 * — the shape the Issue's "file contents must never be cached" rule is about.
 */
export function collectApiRoutePaths(): string[] {
  const paths: string[] = [];
  walk(API_DIR, '/api', paths);
  return paths.sort();
}

/**
 * Routes named in Issue #2504 as ones that must never be cached, as substrings.
 *
 * Asserted to be PRESENT in the corpus, separately from the count floor above:
 * a walk that silently stopped before descending into `/api/worktrees/[id]`
 * would still clear the floor on the other 100+ routes while dropping precisely
 * the sensitive ones. Substrings rather than full paths so a route that moves
 * one level does not break the guard it is the subject of.
 */
export const MUST_NEVER_CACHE_MARKERS = [
  '/api/worktrees/sample-id/current-output',
  '/api/worktrees/sample-id/files/',
  '/api/worktrees/sample-id/messages',
  '/api/worktrees/sample-id/capture',
  '/api/worktrees/sample-id/terminal',
  '/api/worktrees/sample-id/env',
  '/api/worktrees/sample-id/logs',
  '/api/auth/login',
  '/api/auth/status',
] as const;

/**
 * Paths that are NOT API routes but must stay uncached, with why.
 *
 * `/proxy` and `/login` are the other two denylist entries; the remaining rows
 * are boundary cases the segment matcher has to get right in both files.
 */
export const NON_API_UNCACHEABLE_PATHS = [
  '/login',
  '/login/',
  '/proxy',
  '/proxy/streamlit/',
] as const;

/** Paths that must NOT be treated as excluded — the segment-boundary check. */
export const NOT_EXCLUDED_PATHS = [
  '/',
  '/offline',
  '/sessions',
  '/apix',
  '/api-docs',
  '/loginpage',
  '/proxied',
  '/worktrees/sample-id',
] as const;
