/**
 * Issue #1645: `/worktrees/<historical id>` must answer with a REAL 3xx.
 *
 * #1644 rescued those URLs from the route layout with `permanentRedirect`, and
 * measured against a real server that returns HTTP 200 with a meta refresh —
 * App Router emits a genuine 3xx only from Route Handlers, Server Actions and
 * middleware. Old IDs only start arriving now that #1645 renumbers the existing
 * rows, so `server.ts` intercepts the URL before Next sees it.
 *
 * **These tests cannot prove the status code.** They pin the two things that
 * are decidable from a pure function — *where* the browser is sent, and *when*
 * a redirect is issued at all — and in particular the sub-path preservation the
 * layout implementation could not do (a layout cannot see the path below it, so
 * `/worktrees/<old>/terminal` landed on the detail page). The status code is
 * fixed by measuring a running server; see
 * `docs/design/worktree-id-migration-uat.md`.
 */

import { describe, it, expect } from 'vitest';
import {
  parseWorktreeUrl,
  resolveWorktreeRedirect,
  WORKTREE_REDIRECT_STATUS,
  WORKTREE_REDIRECT_CACHE_CONTROL,
} from '@/lib/git/worktree-redirect';

/** Stand-in for the alias table: `old-id` retired in favour of `new-id`. */
const canonicalize = (id: string): string => (id === 'old-id' ? 'new-id' : id);

describe('parseWorktreeUrl', () => {
  it('splits the ID segment from the rest of the path', () => {
    expect(parseWorktreeUrl('/worktrees/abc/terminal')).toEqual({
      id: 'abc',
      subPath: '/terminal',
      search: '',
    });
  });

  it('keeps the query string separate from the path', () => {
    expect(parseWorktreeUrl('/worktrees/abc/files/src/a.ts?tab=preview')).toEqual({
      id: 'abc',
      subPath: '/files/src/a.ts',
      search: '?tab=preview',
    });
  });

  it('percent-decodes the ID segment', () => {
    expect(parseWorktreeUrl('/worktrees/a%2Db')?.id).toBe('a-b');
  });

  it('ignores a fragment a malformed client might send', () => {
    expect(parseWorktreeUrl('/worktrees/abc#top')).toEqual({
      id: 'abc',
      subPath: '',
      search: '',
    });
  });

  it.each([
    ['/worktrees', 'the list path has no ID to resolve'],
    ['/worktrees/', 'empty ID segment'],
    ['/api/worktrees/abc', 'API routes canonicalise their own ID'],
    ['/', 'root'],
    ['/repositories/abc', 'unrelated route'],
  ])('returns null for %s (%s)', (url) => {
    expect(parseWorktreeUrl(url)).toBeNull();
  });

  it('returns null for malformed percent-encoding rather than throwing', () => {
    expect(parseWorktreeUrl('/worktrees/%E0%A4%A')).toBeNull();
  });
});

describe('resolveWorktreeRedirect', () => {
  it('redirects a historical ID to the current one', () => {
    expect(resolveWorktreeRedirect('/worktrees/old-id', canonicalize)).toEqual({
      statusCode: WORKTREE_REDIRECT_STATUS,
      location: '/worktrees/new-id',
    });
  });

  it('uses a permanent, method-preserving status', () => {
    // 308 rather than 301: a Server Action POSTs to the URL of the page it is
    // on, and 301 historically licenses a client to turn that into a GET.
    expect(WORKTREE_REDIRECT_STATUS).toBe(308);
    // …but not a cacheable one. Delete a worktree and its aliases cascade away;
    // a later directory with the same basename can be minted that ID as a LIVE
    // one, and a cached permanent redirect could never be corrected.
    expect(WORKTREE_REDIRECT_CACHE_CONTROL).toBe('no-store');
  });

  it('preserves /terminal', () => {
    // The #1644 layout could not do this: a layout cannot see the path below
    // it, so every nested URL landed on the worktree detail page.
    expect(resolveWorktreeRedirect('/worktrees/old-id/terminal', canonicalize)?.location).toBe(
      '/worktrees/new-id/terminal'
    );
  });

  it('preserves a deep /files path', () => {
    expect(
      resolveWorktreeRedirect('/worktrees/old-id/files/src/lib/git/worktrees.ts', canonicalize)
        ?.location
    ).toBe('/worktrees/new-id/files/src/lib/git/worktrees.ts');
  });

  it('preserves the query string (this is how an RSC request survives)', () => {
    expect(
      resolveWorktreeRedirect('/worktrees/old-id/terminal?_rsc=1a2b3c', canonicalize)?.location
    ).toBe('/worktrees/new-id/terminal?_rsc=1a2b3c');
  });

  it('carries an encoded sub-path across byte-for-byte', () => {
    // Re-encoding an already-encoded path would double-escape it.
    expect(
      resolveWorktreeRedirect('/worktrees/old-id/files/a%20b/c%2Bd.ts', canonicalize)?.location
    ).toBe('/worktrees/new-id/files/a%20b/c%2Bd.ts');
  });

  it('does not redirect an ID that is already current', () => {
    expect(resolveWorktreeRedirect('/worktrees/new-id/terminal', canonicalize)).toBeNull();
  });

  it('does not redirect an unknown ID', () => {
    expect(resolveWorktreeRedirect('/worktrees/never-existed', canonicalize)).toBeNull();
  });

  it('does not redirect an ID that could not be valid', () => {
    // Let the route report what the caller actually sent, exactly as
    // `canonicalWorktreeId` does for the same reason (#1644).
    expect(resolveWorktreeRedirect('/worktrees/bad%20id', canonicalize)).toBeNull();
    expect(resolveWorktreeRedirect('/worktrees/..', canonicalize)).toBeNull();
  });

  it('does not touch API routes', () => {
    expect(resolveWorktreeRedirect('/api/worktrees/old-id', canonicalize)).toBeNull();
  });

  it('degrades to no redirect when resolution throws', () => {
    const broken = (): string => {
      throw new Error('database is locked');
    };
    expect(resolveWorktreeRedirect('/worktrees/old-id', broken)).toBeNull();
  });

  it('degrades to no redirect when resolution returns nothing usable', () => {
    expect(resolveWorktreeRedirect('/worktrees/old-id', () => '')).toBeNull();
  });
});
