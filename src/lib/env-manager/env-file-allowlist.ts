/**
 * Env Manager — server-side file-name allow-list (Issue #1968).
 *
 * The Env Manager is the ONLY surface in the app that reads `.env` files, and
 * the name of the file it acts on arrives from the browser. Requirement 2 of
 * the issue is that this name is never free-form client input: the set of
 * acceptable names is decided here, on the server, and anything outside it is
 * refused before a path is ever built.
 *
 * The allow-list is deliberately a *name* allow-list rather than a path one:
 *
 *   - Every accepted name is a single path component made of `[A-Za-z0-9_-]`
 *     segments, so `../`, `/etc/passwd`, `foo/.env` and a NUL byte are all
 *     rejected by the shape check before `path.join` sees them. Traversal is
 *     structurally impossible rather than filtered out.
 *   - Env files are read from the worktree ROOT only. A nested `.env` is out of
 *     scope for this UI (documented in docs/features/env-manager.md), which
 *     removes the whole "which directory" question from the attack surface.
 *
 * This is layer 1 of 3. The service layer still runs `isPathSafe` (lexical) and
 * `resolveAndValidateRealPath` (symlink) on top — see `env-file-service.ts`.
 * The layers are independent on purpose: dropping any one of them must leave a
 * test red, which `tests/unit/lib/env-manager/env-path-safety.test.ts` and
 * `tests/integration/api-env-manager.test.ts` pin.
 */

/** Canonical env file every worktree is offered, even when it does not exist yet. */
export const DEFAULT_ENV_FILE_NAME = '.env';

/**
 * Template files the "missing key" suggestions are sourced from.
 *
 * Order matters: the first existing file wins as the *primary* template shown
 * in the UI, and keys from later files are appended.
 */
export const ENV_EXAMPLE_FILE_NAMES: readonly string[] = [
  '.env.example',
  '.env.sample',
] as const;

/**
 * Names offered in the file picker even when absent from disk, so a worktree
 * with no env file at all still has something to create.
 */
export const OFFERED_ENV_FILE_NAMES: readonly string[] = [
  DEFAULT_ENV_FILE_NAME,
  '.env.local',
] as const;

/** Every accepted name is `.env` plus at most two of these segments. */
const ENV_SEGMENT_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

/** Hard ceiling on the whole name, independent of the segment rules. */
export const MAX_ENV_FILE_NAME_LENGTH = 64;

/** The only suffix accepted as the SECOND segment (`.env.development.local`). */
const LOCAL_SUFFIX = 'local';

/**
 * Decide whether `name` is an env file this feature is allowed to touch.
 *
 * Accepted shapes — and nothing else:
 *   `.env`                      the canonical file
 *   `.env.<segment>`            `.env.local`, `.env.production`, `.env.example`
 *   `.env.<segment>.local`      `.env.development.local`
 *
 * where `<segment>` is 1–32 chars of `[A-Za-z0-9_-]`. The charset is what makes
 * traversal impossible: it contains neither `/` nor `\` nor `.` nor NUL, so an
 * accepted name can never be more than one path component.
 *
 * Case-sensitive on purpose. `.ENV` is refused rather than normalised — on a
 * case-insensitive filesystem normalising would let a name the list never
 * approved resolve to a file it did.
 *
 * @param name - Candidate file name, exactly as it arrived from the client.
 * @returns true when the name may be read/written by the Env Manager.
 */
export function isAllowedEnvFileName(name: unknown): name is string {
  if (typeof name !== 'string') return false;
  if (name.length === 0 || name.length > MAX_ENV_FILE_NAME_LENGTH) return false;

  // Split on '.' — a leading dot yields an empty first part.
  const parts = name.split('.');
  if (parts[0] !== '' || parts[1] !== 'env') return false;

  const rest = parts.slice(2);
  if (rest.length > 2) return false;
  if (!rest.every((segment) => ENV_SEGMENT_PATTERN.test(segment))) return false;
  // A two-segment name is only ever `<env>.<segment>.local`.
  if (rest.length === 2 && rest[1] !== LOCAL_SUFFIX) return false;

  return true;
}

/**
 * Whether a name is one of the template files used for key suggestions.
 *
 * Templates are still readable and writable like any other allow-listed name —
 * this flag only drives the UI badge and the suggestion source.
 */
export function isEnvExampleFileName(name: string): boolean {
  return ENV_EXAMPLE_FILE_NAMES.includes(name);
}

/**
 * Sort key for the file picker: `.env` first, then templates last, then
 * alphabetical. Keeps the picker order stable no matter what `readdir` returns.
 */
export function compareEnvFileNames(a: string, b: string): number {
  const rank = (name: string): number => {
    if (name === DEFAULT_ENV_FILE_NAME) return 0;
    if (isEnvExampleFileName(name)) return 2;
    return 1;
  };
  const diff = rank(a) - rank(b);
  return diff !== 0 ? diff : a.localeCompare(b);
}
