/**
 * Env Manager — filesystem access (Issue #1968). SERVER ONLY.
 *
 * Imports `fs/promises`, so it must never be pulled into a client bundle. The
 * pane talks to `env-api-client.ts` instead; the pure modules
 * (`env-parser` / `env-validator` / `env-masking` / `env-file-allowlist`) are
 * shared by both sides.
 *
 * PATH SAFETY — THREE INDEPENDENT LAYERS
 * --------------------------------------
 * Every function here funnels through {@link resolveEnvFilePath}, which applies
 * all three in order and refuses on the first failure:
 *
 *   1. `isAllowedEnvFileName` — the name is one the server chose, and by its
 *      charset can only ever be a single path component (`../`, `/abs`, NUL and
 *      `sub/dir/.env` are all structurally impossible).
 *   2. `isPathSafe` — lexical containment inside the worktree, the same check
 *      the general file API runs [SF-002].
 *   3. `resolveAndValidateRealPath` — symlink containment [SEC-394]. This is
 *      the layer that catches `.env -> /etc/passwd`, which the two above
 *      cannot see because the *name* is legal and the *lexical* path is inside.
 *
 * They are not redundant, they cover different attacks, and each one has a test
 * that goes red on its own if it is removed.
 *
 * LOGGING — NO VALUES, EVER (issue requirement 3)
 * -----------------------------------------------
 * Nothing in this module logs file content, a parsed value, or an `fs` error
 * message (which embeds the absolute path). Failures are reported as a code
 * plus the bare file name.
 */

import { readdir, readFile, stat, writeFile, lstat } from 'fs/promises';
import { join } from 'path';
import { isPathSafe, resolveAndValidateRealPath } from '@/lib/security/path-validator';
import { createLogger } from '@/lib/logger';
import {
  ENV_EXAMPLE_FILE_NAMES,
  OFFERED_ENV_FILE_NAMES,
  compareEnvFileNames,
  isAllowedEnvFileName,
  isEnvExampleFileName,
} from './env-file-allowlist';
import { parseEnvContent, type EnvIssue } from './env-parser';
import { validateEnvContent } from './env-validator';
import type { EnvFileDetail, EnvFileSummary, EnvKeySuggestion } from './types';

const logger = createLogger('env-manager');

/** Failure codes this module can produce. Mapped to HTTP status by the route. */
export type EnvServiceErrorCode =
  | 'INVALID_ENV_FILE'
  | 'INVALID_PATH'
  | 'ENV_FILE_NOT_FOUND'
  | 'NOT_A_FILE'
  | 'INVALID_CONTENT'
  | 'INTERNAL_ERROR';

export type EnvServiceResult<T> =
  | { success: true; data: T }
  | { success: false; code: EnvServiceErrorCode };

/**
 * Write outcome. Carries the (value-free) issue list on BOTH branches: a
 * refusal needs the errors that caused it, and an accepted save still reports
 * warnings such as a duplicate key.
 */
export type EnvWriteResult =
  | { success: true; data: EnvFileSummary; issues: EnvIssue[] }
  | { success: false; code: EnvServiceErrorCode; issues?: EnvIssue[] };

/**
 * Turn a client-supplied file name into an absolute path, or refuse.
 *
 * @param worktreePath - Absolute worktree root, from the database (trusted).
 * @param name - File name exactly as the client sent it (untrusted).
 * @returns The absolute path, or the code describing which layer refused.
 */
export function resolveEnvFilePath(
  worktreePath: string,
  name: unknown,
): EnvServiceResult<string> {
  // Layer 1 — server-owned name allow-list.
  if (!isAllowedEnvFileName(name)) {
    return { success: false, code: 'INVALID_ENV_FILE' };
  }

  // Layer 2 — lexical containment [SF-002].
  if (!isPathSafe(name, worktreePath)) {
    return { success: false, code: 'INVALID_PATH' };
  }

  // Layer 3 — symlink containment [SEC-394].
  if (!resolveAndValidateRealPath(name, worktreePath)) {
    return { success: false, code: 'INVALID_PATH' };
  }

  return { success: true, data: join(worktreePath, name) };
}

/** Read a file, returning null when it simply is not there. */
async function readIfPresent(absolutePath: string): Promise<string | null> {
  try {
    return await readFile(absolutePath, 'utf-8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'EISDIR') return null;
    throw error;
  }
}

/**
 * List every env file this worktree offers.
 *
 * The result is the union of what is on disk (filtered by the allow-list) and
 * {@link OFFERED_ENV_FILE_NAMES}, so a worktree with no env file at all still
 * shows `.env` — with `exists: false` — and can create one.
 *
 * Root only: `readdir` is not recursive and nothing here joins a subdirectory.
 */
export async function listEnvFiles(worktreePath: string): Promise<EnvFileSummary[]> {
  const names = new Set<string>(OFFERED_ENV_FILE_NAMES);

  try {
    for (const entry of await readdir(worktreePath)) {
      if (isAllowedEnvFileName(entry)) names.add(entry);
    }
  } catch (error) {
    // An unreadable worktree root is not a crash: the loop below still runs,
    // and every name it tries fails path validation (the realpath of a root
    // that does not exist cannot be resolved), so the caller gets an empty
    // list rather than an exception. Fail-closed by construction.
    logger.warn('env-list-readdir-failed', { code: (error as NodeJS.ErrnoException).code });
  }

  const summaries: EnvFileSummary[] = [];
  for (const name of Array.from(names).sort(compareEnvFileNames)) {
    const resolved = resolveEnvFilePath(worktreePath, name);
    if (!resolved.success) continue;
    // A name that is present but is not a regular file (a directory called
    // `.env.local`, say) is offered as NOT existing rather than dropped: the
    // picker keeps the entry, and a write against it fails loudly with
    // NOT_A_FILE instead of the name vanishing with no explanation.
    let stats: Awaited<ReturnType<typeof stat>> | null = null;
    try {
      stats = await stat(resolved.data);
    } catch {
      stats = null;
    }
    if (stats?.isFile()) {
      summaries.push({
        name,
        exists: true,
        size: stats.size,
        mtime: stats.mtime.toISOString(),
        isExample: isEnvExampleFileName(name),
      });
    } else {
      summaries.push({
        name,
        exists: false,
        size: 0,
        mtime: null,
        isExample: isEnvExampleFileName(name),
      });
    }
  }
  return summaries;
}

/**
 * Collect keys defined in a template file but missing from `definedKeys`.
 *
 * Both `.env.example` and `.env.sample` are consulted; the first one to define
 * a key owns the suggestion.
 */
export async function collectKeySuggestions(
  worktreePath: string,
  definedKeys: ReadonlySet<string>,
  excludeFileName: string,
): Promise<EnvKeySuggestion[]> {
  const suggestions: EnvKeySuggestion[] = [];
  const seen = new Set<string>();

  for (const templateName of ENV_EXAMPLE_FILE_NAMES) {
    // Editing `.env.example` itself must not suggest its own keys back at it.
    if (templateName === excludeFileName) continue;
    const resolved = resolveEnvFilePath(worktreePath, templateName);
    if (!resolved.success) continue;

    let content: string | null;
    try {
      content = await readIfPresent(resolved.data);
    } catch (error) {
      logger.warn('env-template-read-failed', {
        file: templateName,
        code: (error as NodeJS.ErrnoException).code,
      });
      continue;
    }
    if (content === null) continue;

    for (const entry of parseEnvContent(content).entries) {
      if (definedKeys.has(entry.key) || seen.has(entry.key)) continue;
      seen.add(entry.key);
      suggestions.push({ key: entry.key, source: templateName, value: entry.value });
    }
  }

  return suggestions;
}

/**
 * Read one env file and everything the editor needs about it.
 *
 * A file that does not exist is NOT an error: it comes back with
 * `exists: false` and empty content, so the pane can offer to create it. The
 * 404 case is reserved for a name the allow-list accepts pointing at something
 * that is not a regular file.
 */
export async function readEnvFile(
  worktreePath: string,
  name: unknown,
): Promise<EnvServiceResult<EnvFileDetail>> {
  const resolved = resolveEnvFilePath(worktreePath, name);
  if (!resolved.success) return resolved;
  const fileName = name as string;

  let content: string | null;
  try {
    const stats = await lstat(resolved.data).catch(() => null);
    if (stats && !stats.isFile() && !stats.isSymbolicLink()) {
      return { success: false, code: 'NOT_A_FILE' };
    }
    content = await readIfPresent(resolved.data);
  } catch (error) {
    logger.error('env-read-failed', {
      file: fileName,
      code: (error as NodeJS.ErrnoException).code,
    });
    return { success: false, code: 'INTERNAL_ERROR' };
  }

  const exists = content !== null;
  const raw = content ?? '';
  const validation = validateEnvContent(raw);
  const definedKeys = new Set(validation.entries.map((entry) => entry.key));
  const suggestions = await collectKeySuggestions(worktreePath, definedKeys, fileName);

  return {
    success: true,
    data: {
      name: fileName,
      exists,
      content: raw,
      entries: validation.entries,
      issues: validation.issues,
      suggestions,
    },
  };
}

/**
 * Write one env file.
 *
 * Validation runs here as well as in the browser — the client-side check is a
 * convenience, this one is the control. Anything with an error-severity issue
 * is refused with `INVALID_CONTENT` and the (value-free) issue list.
 */
export async function writeEnvFile(
  worktreePath: string,
  name: unknown,
  content: unknown,
): Promise<EnvWriteResult> {
  const resolved = resolveEnvFilePath(worktreePath, name);
  if (!resolved.success) return resolved;
  const fileName = name as string;

  if (typeof content !== 'string') {
    return { success: false, code: 'INVALID_CONTENT' };
  }

  const validation = validateEnvContent(content);
  if (!validation.valid) {
    return { success: false, code: 'INVALID_CONTENT', issues: validation.issues };
  }

  try {
    const stats = await lstat(resolved.data).catch(() => null);
    if (stats && !stats.isFile() && !stats.isSymbolicLink()) {
      return { success: false, code: 'NOT_A_FILE' };
    }
    // 0o600: an env file holds credentials, so it is created private to the
    // user running the server. `writeFile` only applies the mode when it
    // creates the file, which is the intent — an existing file keeps its own.
    await writeFile(resolved.data, content, { encoding: 'utf-8', mode: 0o600 });
  } catch (error) {
    logger.error('env-write-failed', {
      file: fileName,
      code: (error as NodeJS.ErrnoException).code,
    });
    return { success: false, code: 'INTERNAL_ERROR' };
  }

  let size = 0;
  let mtime: string | null = null;
  try {
    const stats = await stat(resolved.data);
    size = stats.size;
    mtime = stats.mtime.toISOString();
  } catch {
    // The write succeeded; a failed stat only costs the caller its metadata.
    size = content.length;
  }

  return {
    success: true,
    data: {
      name: fileName,
      exists: true,
      size,
      mtime,
      isExample: isEnvExampleFileName(fileName),
    },
    issues: validation.issues,
  };
}
