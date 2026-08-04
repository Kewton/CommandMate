/**
 * Turning `/worktrees/<historical id>` into a **real** HTTP redirect
 * (Issue #1621 Phase 2 follow-up, owned by #1645).
 *
 * ## Why this exists rather than the layout redirect #1644 shipped
 *
 * `src/app/worktrees/[id]/layout.tsx` calls `permanentRedirect`, and measured
 * against a real server that returns
 *
 *     HTTP/1.1 200 OK
 *     <meta id="__next-page-redirect" http-equiv="refresh" content="0;url=…">
 *
 * — not a 301. That is App Router behaviour, not a bug in that layout: an
 * unconditional `permanentRedirect` as the layout's very first statement
 * produces the same 200 + meta tag. A redirect thrown while a page's HTML is
 * already streaming can no longer set a status line, so it ships inside the
 * document. Only Route Handlers, Server Actions and middleware emit a real 3xx.
 *
 * `middleware.ts` is not an option either: it runs on the edge runtime, where
 * the SQLite lookup this needs is impossible. That leaves the custom
 * `server.ts`, which sees the request before Next does — hence this module,
 * which `server.ts` loads lazily and asks about each `/worktrees/…` URL.
 *
 * The layout redirect stays as a fallback for anything serving the app without
 * `server.ts`; when `server.ts` is in front it never sees a historical ID.
 *
 * ## Two things the layout could not do, and this does
 *
 * 1. **A status code.** A meta refresh is followed by browsers and by nothing
 *    else — no bookmark rewrite, no non-browser client, no `curl -I`.
 * 2. **Sub-paths.** A layout cannot see the path below it, so
 *    `/worktrees/<old>/terminal` landed on the worktree's detail page. Here the
 *    tail of the path and the query string are carried across verbatim.
 */

import { getDbInstance } from '@/lib/db/db-instance';
import { resolveWorktreeIdWithAlias } from '@/lib/db/worktree-alias-db';
import { isValidWorktreeId } from '@/lib/security/path-validator';

/**
 * Status code used for the redirect.
 *
 * 308 rather than 301 because it is the method-preserving permanent redirect:
 * `/worktrees/<id>` is a page route today, but a Server Action POSTs to the URL
 * of the page it is on, and 301 historically licenses clients to turn that into
 * a GET.
 *
 * Paired with `Cache-Control: no-store` at the call site — see
 * {@link WORKTREE_REDIRECT_CACHE_CONTROL}.
 */
export const WORKTREE_REDIRECT_STATUS = 308;

/**
 * Cache directive sent with the redirect.
 *
 * A permanent redirect is cacheable by default, and here that would be wrong:
 * "old ID → this worktree" is durable but not eternal. Delete the worktree and
 * its aliases cascade away; a later directory with the same basename can then
 * be minted that ID as a **live** one, and live rows beat aliases. A client
 * holding a cached permanent redirect would never ask again and would keep
 * landing on the wrong worktree. The status code still says "moved" to anything
 * reading it; only the caching of that answer is refused.
 */
export const WORKTREE_REDIRECT_CACHE_CONTROL = 'no-store';

/** A redirect `server.ts` should write instead of handing the URL to Next. */
export interface WorktreeRedirect {
  statusCode: typeof WORKTREE_REDIRECT_STATUS;
  location: string;
}

/** The `/worktrees/<id>` prefix, split into its ID segment and everything after. */
export interface ParsedWorktreeUrl {
  /** The `<id>` segment, percent-decoded */
  id: string;
  /** Everything after the ID segment, starting with `/` (empty when there is none) */
  subPath: string;
  /** Query string including `?` (empty when there is none) */
  search: string;
}

/**
 * `/worktrees/<id>` optionally followed by more path.
 *
 * Anchored at the start so nothing else can match, and the ID segment excludes
 * `/`, `?` and `#` so the split is unambiguous. `/worktrees` on its own does not
 * match — there is no such page, and there is no ID to resolve.
 */
const WORKTREE_URL_PATTERN = /^\/worktrees\/([^/?#]+)(\/[^?#]*)?/;

/**
 * Split a request URL into the parts a redirect has to rebuild.
 *
 * Pure and total: returns null for anything that is not a `/worktrees/<id>` URL.
 *
 * @param requestUrl - `req.url`, i.e. an origin-form path with optional query
 */
export function parseWorktreeUrl(requestUrl: string): ParsedWorktreeUrl | null {
  if (!requestUrl) return null;

  // Fragments never reach a server, but a malformed client could send one.
  const hashIndex = requestUrl.indexOf('#');
  const withoutHash = hashIndex === -1 ? requestUrl : requestUrl.slice(0, hashIndex);

  const queryIndex = withoutHash.indexOf('?');
  const pathname = queryIndex === -1 ? withoutHash : withoutHash.slice(0, queryIndex);
  const search = queryIndex === -1 ? '' : withoutHash.slice(queryIndex);

  const match = WORKTREE_URL_PATTERN.exec(pathname);
  if (!match) return null;

  let id: string;
  try {
    id = decodeURIComponent(match[1]);
  } catch {
    // Malformed percent-encoding: not a URL we can reason about. Hand it to
    // Next, which will 404 it as it does today.
    return null;
  }

  return { id, subPath: match[2] ?? '', search };
}

/**
 * Map a worktree ID that may be historical onto the ID that is current.
 *
 * Total by construction: any failure — an unmigrated database, an unreadable
 * one, no alias table — degrades to "no redirect", which is exactly today's
 * behaviour.
 */
function canonicalWorktreeIdFromDb(id: string): string {
  try {
    const db = getDbInstance();
    return resolveWorktreeIdWithAlias(db, id) ?? id;
  } catch {
    return id;
  }
}

/**
 * Decide whether a URL names a worktree by a historical ID, and where it should
 * go instead.
 *
 * @param requestUrl - `req.url` verbatim
 * @param canonicalize - ID resolver; defaults to the alias table. Injectable so
 *   the unit tests can state the mapping instead of building a database.
 * @returns The redirect to write, or null to let Next handle the request
 */
export function resolveWorktreeRedirect(
  requestUrl: string,
  canonicalize: (id: string) => string = canonicalWorktreeIdFromDb
): WorktreeRedirect | null {
  const parsed = parseWorktreeUrl(requestUrl);
  if (!parsed) return null;

  // An ID that cannot be valid is not a historical ID either; let the route
  // report what the caller actually sent (Issue #1644's `canonicalWorktreeId`
  // makes the same choice for the same reason).
  if (!isValidWorktreeId(parsed.id)) return null;

  let canonicalId: string;
  try {
    canonicalId = canonicalize(parsed.id);
  } catch {
    return null;
  }
  if (!canonicalId || canonicalId === parsed.id) return null;

  return {
    statusCode: WORKTREE_REDIRECT_STATUS,
    // The ID is re-encoded (it is a single segment we just decoded); `subPath`
    // and `search` are carried across byte-for-byte, because they arrived
    // already encoded and re-encoding would corrupt them.
    location: `/worktrees/${encodeURIComponent(canonicalId)}${parsed.subPath}${parsed.search}`,
  };
}
