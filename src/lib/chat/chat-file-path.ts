/**
 * What a link in a chat body points at, and where that is on disk (Issue #2345).
 *
 * ## The defect this exists for
 *
 * Codex writes Markdown links whose destination is an ABSOLUTE filesystem path:
 *
 * ```markdown
 * [整理文書](/Users/…/CommandAgent-develop/workspace/tmp/0905/notes.md)
 * ```
 *
 * Two things were wrong with that on the chat surface. The renderer had no `a`
 * override, so react-markdown emitted a plain `<a href="/Users/…">` and clicking
 * it navigated the CommandMate tab to `http://localhost:3000/Users/…` (Next's
 * 404). And even the affordance that DID exist — the bare-path button
 * ({@link splitFilePathParts}) — could not open such a path either: the file API
 * is requested as `files/<encodePathForUrl(path)>`, an absolute path makes that
 * `files//Users/…`, and Next 308-normalizes the doubled slash away to
 * `files/Users/…`, which the route then reads as the RELATIVE path `Users/…` and
 * answers 404. Measured 2026-09-05 against the running server; the same file
 * requested as `files/workspace/tmp/0905/notes.md` answers 200.
 *
 * So one function turns whatever a body claims into the path the file API can
 * actually serve, and BOTH click paths — the Markdown link and the bare-path
 * button — go through it. Keeping it pure (no React, no fetch) is what lets the
 * absolute/relative/`file://`/percent-encoded/`:12` cases be pinned as a table
 * rather than as a rendered screen.
 *
 * ## What is deliberately NOT here
 *
 * - **No security decision.** Whether a path may be read is
 *   `lib/security/path-validator` server-side; this is a UX-level rewrite of one
 *   string, exactly as `lib/link-utils` documents for its own helpers.
 * - **No line jump.** `:12` / `#L12` are stripped and dropped. Issue #2345 opens
 *   the file; jumping to the line is named as out of scope.
 * - **No base directory.** `resolveRelativePath` resolves a link against the
 *   file that CONTAINS it; a chat body is not a file, so a relative destination
 *   is read against the worktree root instead.
 *
 * @module lib/chat/chat-file-path
 */

import { classifyLink, sanitizeHref } from '@/lib/link-utils';

// ============================================================================
// Classification
// ============================================================================

/**
 * What a chat body's link destination is.
 *
 * `'file'` is the only one this module rewrites; the other two exist so the
 * renderer can decide between "leave it to the browser" (`'anchor'`), "open it
 * away from CommandMate's tab" (`'external'`) and "open it in the file panel".
 */
export type ChatLinkTarget = 'anchor' | 'external' | 'file';

/** Schemes a chat link may carry and still be meaningful to a browser. */
const KNOWN_SCHEME_REGEX = /^(https?|mailto|tel|file):/i;

/** Anything of the shape `scheme:` — used to reject the ones not listed above. */
const ANY_SCHEME_REGEX = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

/** `file://`, with the optional empty / `localhost` authority a file URL may carry. */
const FILE_SCHEME_REGEX = /^file:\/\/(localhost)?/i;

/** A trailing `:12` or `:12:34` — an editor's line (and column) reference. */
const LINE_SUFFIX_REGEX = /:\d+(?::\d+)?$/;

/**
 * Classify one link destination, or `null` when it is not usable at all.
 *
 * Built on {@link classifyLink} rather than beside it, with two differences that
 * matter here and would be regressions there:
 *
 *  - `file:` is a FILE, not a relative path. `classifyLink` predates `file:` and
 *    calls everything that is not http/https/mailto/tel `'relative'`, which for
 *    `file:///Users/x.md` would hand `resolveRelativePath` a string starting
 *    with a scheme. Changing it would change `MarkdownPreview`'s behaviour, so
 *    the knowledge lives here instead.
 *  - an UNKNOWN scheme (`vscode:`, `data:`, `javascript:`) is `null`, not a
 *    path. `rehypeSanitize`'s default schema already strips those hrefs before
 *    a renderer can see them — measured, along with the fact that it also drops
 *    `file:` and `tel:` — so this is the belt to that braces: nothing that is
 *    not one of the four known schemes is ever handed to `window.open` or to
 *    the file panel.
 */
export function classifyChatLink(href: string): ChatLinkTarget | null {
  const sanitized = sanitizeHref(href.trim());
  if (!sanitized) return null;
  if (sanitized.startsWith('#')) return 'anchor';
  if (FILE_SCHEME_REGEX.test(sanitized)) return 'file';
  if (ANY_SCHEME_REGEX.test(sanitized) && !KNOWN_SCHEME_REGEX.test(sanitized)) return null;
  return classifyLink(sanitized) === 'external' ? 'external' : 'file';
}

// ============================================================================
// Normalization
// ============================================================================

/** Drop a `#fragment`, whether it is `#L12` or `#heading`. */
function stripFragment(path: string): string {
  const hash = path.indexOf('#');
  return hash === -1 ? path : path.slice(0, hash);
}

/**
 * Percent-decode once, keeping the input when it does not decode.
 *
 * remark percent-encodes any non-ASCII destination, so a Japanese filename
 * arrives as `%E6%97%A5…`. A lone `%` in a filename is not an escape sequence and
 * makes `decodeURIComponent` throw; that path is still openable verbatim, so the
 * throw must not lose it.
 */
function decodeOnce(path: string): string {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

/**
 * Collapse `.` and `..` segments and any empty ones, against no base.
 *
 * Written out rather than routed through `new URL(href, 'file:///')` (which is
 * what `resolveRelativePath` does) because that re-encodes what
 * {@link decodeOnce} has just decoded, and because a `..` that would climb above
 * the worktree root has nowhere to go here: the root IS the base, so it is
 * dropped and the server's path validator never sees a traversal attempt from
 * this surface.
 */
function collapseSegments(path: string): string {
  const segments: string[] = [];
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments.join('/');
}

/** `path` with a trailing `/` removed, so the prefix test below is exact. */
function withoutTrailingSlash(path: string): string {
  return path.length > 1 && path.endsWith('/') ? path.replace(/\/+$/, '') : path;
}

/**
 * The path the file API can serve for a link in a chat body, or `null`.
 *
 * @param href - the link destination, or a bare path the linkifier sliced out
 * @param worktreePath - `Worktree.path`, the absolute root of this worktree.
 *   Omitting it is legal and simply means no absolute path can be recognized as
 *   being inside the worktree — the pre-#2345 behaviour.
 *
 * The four answers it can give:
 *
 *  - `null` — not a file link at all (an anchor, an external URL, an unknown
 *    scheme, or a string that decodes to nothing). The caller opens nothing.
 *  - a path RELATIVE to the worktree root — the only shape the file API serves,
 *    and what an absolute path inside `worktreePath` becomes.
 *  - the absolute path unchanged — it is outside this worktree, so it is left
 *    for `probeChatFilePath` to get a 400 on and for #2274's toast to report.
 *    Rewriting it would only hide which file the body actually named.
 *  - `null` again for `href === worktreePath`: the worktree ROOT is a directory,
 *    and "" would ask the file API for a listing rather than a file.
 */
export function normalizeChatFilePath(
  href: string,
  worktreePath?: string | null,
): string | null {
  if (classifyChatLink(href) !== 'file') return null;

  const sanitized = href.trim();

  // Order is load-bearing: `#` and `:12` are written literally by the author,
  // while everything non-ASCII around them is percent-encoded. Cutting the
  // suffixes off the ENCODED string means a `%23` inside a filename decodes to a
  // `#` that is content rather than a fragment that has already been cut.
  const withoutScheme = sanitized.replace(FILE_SCHEME_REGEX, '');
  const withoutSuffix = stripFragment(withoutScheme).replace(LINE_SUFFIX_REGEX, '');
  const decoded = decodeOnce(withoutSuffix).trim();
  if (!decoded) return null;

  if (!decoded.startsWith('/')) {
    // Relative destination, read against the worktree root — a chat body has no
    // "current file" for `resolveRelativePath` to resolve against.
    return collapseSegments(decoded) || null;
  }

  const root = worktreePath ? withoutTrailingSlash(worktreePath.trim()) : '';
  if (!root || !root.startsWith('/')) return decoded;
  if (decoded === root) return null;
  if (!decoded.startsWith(`${root}/`)) return decoded;

  return collapseSegments(decoded.slice(root.length + 1)) || null;
}
