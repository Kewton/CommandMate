/**
 * Sensitive-file guard for the general worktree file API (Issue #2014).
 *
 * ## Why this module exists
 *
 * `EXCLUDED_PATTERNS` (`src/lib/file-tree.ts`) is a LISTING filter. It keeps a
 * name out of the tree API and out of file search, and that is all it has ever
 * done. The general file route
 * (`/api/worktrees/:id/files/:path*`) never consulted it, so a path typed
 * directly was served in full. Measured on develop @6696c4bb (2026-08-24):
 *
 * ```
 * GET  /api/worktrees/<id>/files/.env             -> 200 {"content":"SECRET=probe-value\n",...}
 * GET  /api/worktrees/<id>/files/.env?download=1  -> 200 SECRET=probe-value      (raw bytes)
 * GET  /api/worktrees/<id>/files/server.pem       -> 200 (private key body)
 * GET  /api/worktrees/<id>/files/.git/config      -> 200 (remote URL incl. token)
 * PUT  /api/worktrees/<id>/files/.env.yml         -> 200 (overwrote the secret)
 * POST /api/worktrees/<id>/files/.env             -> 201 (created one)
 * DELETE /api/worktrees/<id>/files/.env           -> 200 (deleted it)
 * PATCH  /api/worktrees/<id>/files/.env {rename:"leaked.md"} -> 200, then GET leaked.md -> 200 body
 * ```
 *
 * That last line is why this guard is not a GET-only check: a rename moves the
 * bytes to a name no deny list covers, so blocking only the read would have
 * been bypassable in two requests. The guard therefore runs on every method of
 * the route, on the path the handler is about to act on.
 *
 * ## The classification, and why it is not "deny everything excluded"
 *
 * Promoting the whole of `EXCLUDED_PATTERNS` to "unreadable" would also change
 * `node_modules`, which is excluded for volume, not for secrecy. Each pattern
 * is therefore assigned to exactly one tier:
 *
 * | Pattern                | Tier        | Why                                                     |
 * | ---------------------- | ----------- | ------------------------------------------------------- |
 * | `.env`, `.env.*`, `.env.local`, `.env.development`, `.env.production`, `.env.test` | deny | The file's PURPOSE is to hold credentials. Issue #1968 built a masked, allow-listed UI for exactly these; serving them raw from a second route makes that masking decorative. |
 * | `*.pem`, `*.key`       | deny        | Private-key material. Same reasoning, no UI reads them.  |
 * | `.git`                 | deny        | `.git/config` carries the remote URL, which routinely embeds a token (`https://user:TOKEN@host/repo.git`) — measured above. Nothing in the app reads `.git` through this route; git features shell out via `src/lib/git`. |
 * | `node_modules`         | hide only   | Dependency sources. Not secret; excluded from the tree for volume. Denying reads would remove a real capability (opening a dependency's source or README by path) and buy no confidentiality. |
 * | `.DS_Store`            | hide only   | macOS Finder metadata. Noise, not secret.                |
 * | `Thumbs.db`            | hide only   | Windows thumbnail cache. Noise, not secret.              |
 *
 * The two tiers must partition `EXCLUDED_PATTERNS` exactly; a new pattern in
 * that list leaves `tests/unit/lib/security/sensitive-file-guard.test.ts` red
 * until it is classified here. That is deliberate: the bug being fixed is a
 * list whose name promised more than it enforced.
 *
 * ## Matching semantics
 *
 * Pattern matching is shared with the tree filter ({@link matchesNamePattern})
 * so the two subsets cannot drift apart, with ONE intentional difference: the
 * deny tier matches case-INSENSITIVELY. On macOS and Windows the filesystem is
 * case-insensitive, so `.ENV` opens `.env` — measured on this repo's APFS:
 * `readFileSync('.ENV')` returned the contents of `.env`. A case-sensitive deny
 * list is therefore bypassable by shifting one character. (The Env Manager's
 * ALLOW list is case-sensitive for the mirror-image reason — there, normalising
 * would let an unapproved name resolve to an approved file.)
 */

import { matchesNamePattern } from '@/lib/file-tree';

/**
 * Patterns whose matching paths the general file API must refuse to read,
 * write, create, delete, rename or move.
 *
 * Every entry is also in `EXCLUDED_PATTERNS` (`src/lib/file-tree.ts`, pinned by test): a path
 * that may not be read must not be advertised in the tree either.
 */
export const SENSITIVE_PATH_PATTERNS: readonly string[] = [
  '.git',
  '.env',
  '.env.*',
  '.env.local',
  '.env.development',
  '.env.production',
  '.env.test',
  '*.pem',
  '*.key',
] as const;

/**
 * Patterns that stay hidden from the tree but whose read/write behaviour is
 * deliberately UNCHANGED by Issue #2014.
 *
 * Listed explicitly rather than derived, so that adding a pattern to
 * `EXCLUDED_PATTERNS` is a decision someone has to make in this file
 * rather than a default that silently picks a tier.
 */
export const LISTING_ONLY_PATTERNS: readonly string[] = [
  'node_modules',
  '.DS_Store',
  'Thumbs.db',
] as const;

/**
 * Decode a percent-encoded path segment, falling back to the raw value.
 *
 * Next.js already decodes route params, so this is defence in depth against a
 * double-encoded segment (`%252Eenv`) or a caller that hands us raw input.
 */
function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * Does this single path component name a file the API must refuse to touch?
 *
 * Case-insensitive — see the module docblock for the measured `.ENV` bypass.
 *
 * @param name - One path component, encoded or decoded
 * @returns True when the component matches a deny-tier pattern
 */
export function isSensitivePathName(name: string): boolean {
  if (!name) return false;
  const candidates = new Set([name, decodeSegment(name)]);
  for (const candidate of candidates) {
    const lowered = candidate.toLowerCase();
    if (SENSITIVE_PATH_PATTERNS.some((pattern) => matchesNamePattern(lowered, pattern))) {
      return true;
    }
  }
  return false;
}

/**
 * Find the first component of a path that the API must refuse to touch.
 *
 * Checks EVERY component, not just the last one: `.git/config` and
 * `.env.d/prod.key` are as sensitive as `.env`, and a directory in the deny
 * tier takes everything under it with it.
 *
 * Accepts either a segment array (route params) or a `/`-joined path; pass
 * both forms when they can differ (raw params vs. the normalised path actually
 * handed to `fs`), since a component that survives normalisation is the one
 * that reaches disk.
 *
 * @param path - Path segments, or a relative path string
 * @returns The offending component, or null when the path is acceptable
 */
export function findSensitivePathSegment(path: readonly string[] | string): string | null {
  const segments = typeof path === 'string' ? path.split('/') : path;
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') continue;
    if (isSensitivePathName(segment)) {
      return segment;
    }
  }
  return null;
}
