/**
 * Loader for `.commandmate/agents.yaml` — a repository's own declaration of
 * which agents its worktrees start with (Issue #2066).
 *
 * ## Why a file, and why not a key in `CMATE.md`
 *
 * `CMATE.md` already carries per-worktree schedule rows, so it was the obvious
 * alternative. It is the wrong home for this one:
 *
 *  - **Scope.** `CMATE.md` is read from a *worktree* root (`cmate-parser.ts`
 *    resolves it under the worktree directory and refuses paths outside it).
 *    This declaration is a property of the **repository**, and it has to be
 *    readable *before* a worktree's roster exists — that is the whole point.
 *  - **Grammar.** `CMATE.md` is a Markdown *table* parser: every value is a
 *    cell, and an ordered list with an optional primary would have to be
 *    encoded into one. `.commandmate/verify.yaml` and `.commandmate/tasks/*.yaml`
 *    already establish YAML as the shape for machine-read declarations, and
 *    `validateAgentsPair()` wants a real list.
 *  - **Blast radius.** `parseCmateConfig()` is on the schedule execution path.
 *    Adding a key there means every schedule read re-validates agent ids, and a
 *    malformed agents key becomes a way to disturb scheduling.
 *
 * So: a new file, next to the two declarations that already live in
 * `.commandmate/`, following `verify.yaml`'s closed-key-set conventions.
 *
 * ## Shape
 *
 * ```yaml
 * version: 1        # optional; must be 1 when present
 * agents: [codex, claude]
 * primary: claude   # optional; must be one of `agents`
 * ```
 *
 * ## Fail-open
 *
 * Nothing here throws. A file that does not parse, declares an unknown key, or
 * carries a list `validateAgentsPair()` rejects produces a WARNING and `null`,
 * and `resolveSelectedAgents()` then falls through to `app_settings` and finally
 * to the compiled-in constant. A repository must not be able to blank every
 * sidebar tab strip by committing a typo.
 *
 * ## Why the read is cached, and why the cache is not optional
 *
 * `getWorktrees()` runs on every sidebar poll. Issue #1913 made "no filesystem
 * probe on a hot path" a rule, restated by #2065 in
 * `src/config/installed-agents-cache.ts` as "getWorktrees() must not grow a
 * filesystem probe". This layer is inherently file-backed, so the rule is
 * honoured the way the Issue asks for — **read at sync** — plus a TTL so the
 * answer is still self-healing:
 *
 *  - {@link refreshRepoAgentsConfig} is called from `scanWorktrees()`, i.e. once
 *    per repository per sync. That is the read the Issue specifies.
 *  - {@link getRepoDefaultSelectedAgents} serves memory. It touches the disk
 *    only on a cold miss (a server restarted since the last sync — the rows in
 *    SQLite outlive the process, so "scanned at least once in this process" is
 *    not a fact one may assume) or after {@link REPO_AGENTS_CACHE_TTL_MS}.
 *
 * The resulting worst case is one small `readFileSync` per repository per
 * minute, bounded by the number of configured repositories — not per worktree,
 * and not per poll.
 *
 * Server-only: reads from disk, so import this from API routes / CLI / DB
 * helpers, never from a client component.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { parse as parseYaml } from 'yaml';
import { createLogger } from '@/lib/logger';
import { validateAgentsPair } from '@/lib/selected-agents-validator';
import type { CLIToolType } from '@/lib/cli-tools/types';

const logger = createLogger('repo-agents-config');

/** Path of the declaration, relative to the repository root. */
export const REPO_AGENTS_CONFIG_RELATIVE_PATH = '.commandmate/agents.yaml';

/**
 * Top-level keys v1 accepts. Closed, like `verify.yaml`'s: a key nobody reads is
 * indistinguishable from a misspelled key that was meant to be read, and the
 * misspelling is the case worth catching.
 */
export const REPO_AGENTS_CONFIG_KEYS = ['version', 'agents', 'primary'] as const;

/**
 * How long one parsed declaration is reused before the disk is consulted again.
 *
 * 60s is chosen against the user's loop: edit `agents.yaml`, switch back to the
 * browser, look at a worktree that has no roster yet. Pressing the sync button
 * (which calls {@link refreshRepoAgentsConfig}) makes it immediate; this is the
 * floor for someone who does not.
 */
export const REPO_AGENTS_CACHE_TTL_MS = 60_000;

/** Largest declaration read into memory. A declaration is a few hundred bytes. */
export const MAX_REPO_AGENTS_CONFIG_BYTES = 64 * 1024;

interface CacheEntry {
  /** Resolved agent order, or null when there is no usable declaration. */
  value: CLIToolType[] | null;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

/**
 * Render an untrusted value for a log line (R4-005, the same concern
 * `parseSelectedAgents()` documents).
 *
 * A repository file is attacker-adjacent input on a shared machine: ANSI escapes
 * and newlines in it would otherwise reach a terminal that is tailing the server
 * log and forge log lines there.
 */
function forLog(value: unknown, limit = 120): string {
  const text =
    typeof value === 'string'
      ? value
      : Array.isArray(value)
        ? 'a list'
        : value === null
          ? 'null'
          : typeof value === 'object'
            ? 'a mapping'
            : String(value);
  const stripped = text.replace(/[\u0000-\u001F\u007F-\u009F]/g, ' ');
  return stripped.length > limit ? `${stripped.slice(0, limit)}...` : stripped;
}

function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Parse a declaration's text into an ordered agent list.
 *
 * Exported so the rules can be tested without a filesystem, and so a future
 * surface that already holds the text (a repository settings screen previewing
 * an upload) can validate it the same way.
 *
 * @param raw - File contents
 * @param source - Path used in warning messages
 * @returns Ordered agents (`[0]` is the primary), or null when unusable
 */
export function parseRepoAgentsConfig(raw: string, source: string): CLIToolType[] | null {
  let document: unknown;
  try {
    document = parseYaml(raw);
  } catch (error) {
    logger.warn('repo-agents:yaml-parse-failed', {
      source,
      error: forLog((error as Error).message),
    });
    return null;
  }

  // An empty file parses to null. Treat it as "this repository declares
  // nothing", which is the same answer as having no file at all — and say so at
  // debug level rather than warn, because it is not a mistake worth shouting at.
  if (document === null || document === undefined) {
    logger.debug('repo-agents:empty', { source });
    return null;
  }

  if (!isMapping(document)) {
    logger.warn('repo-agents:not-a-mapping', { source, got: forLog(document) });
    return null;
  }

  const unknownKeys = Object.keys(document).filter(
    (key) => !(REPO_AGENTS_CONFIG_KEYS as readonly string[]).includes(key)
  );
  if (unknownKeys.length > 0) {
    logger.warn('repo-agents:unknown-keys', {
      source,
      keys: unknownKeys.map((key) => forLog(key, 40)),
    });
    return null;
  }

  if (document.version !== undefined && document.version !== null) {
    const version =
      typeof document.version === 'number'
        ? document.version
        : typeof document.version === 'string' && /^\d+$/.test(document.version)
          ? Number(document.version)
          : null;
    if (version !== 1) {
      logger.warn('repo-agents:unsupported-version', {
        source,
        got: forLog(document.version),
      });
      return null;
    }
  }

  if (!Array.isArray(document.agents)) {
    logger.warn('repo-agents:agents-not-a-list', {
      source,
      got: forLog(document.agents),
    });
    return null;
  }

  // The shared validator (Issue #2066 requirement 3): 2-6 unique ids drawn from
  // CLI_TOOL_IDS, exactly what `app_settings` and the API input are held to.
  const validated = validateAgentsPair(document.agents);
  if (!validated.valid) {
    logger.warn('repo-agents:invalid-agents', {
      source,
      error: validated.error,
      got: document.agents.map((entry) => forLog(entry, 40)),
    });
    return null;
  }

  const agents = validated.value!;

  if (document.primary === undefined || document.primary === null) {
    return agents;
  }

  if (typeof document.primary !== 'string' || !agents.includes(document.primary as CLIToolType)) {
    // Deliberately falls through rather than ignoring the key: `primary` exists
    // to say which tab opens first, and quietly opening a different one is worse
    // than falling back to a default the user can see is a default.
    logger.warn('repo-agents:primary-not-in-agents', {
      source,
      got: forLog(document.primary, 40),
      agents,
    });
    return null;
  }

  const primary = document.primary as CLIToolType;
  return [primary, ...agents.filter((id) => id !== primary)];
}

/**
 * Read and parse `<repoPath>/.commandmate/agents.yaml`, bypassing the cache.
 *
 * @param repoPath - Repository root
 * @returns Ordered agents, or null when the file is absent, unreadable or unusable
 */
export function loadRepoAgentsConfig(repoPath: string): CLIToolType[] | null {
  const configPath = join(repoPath, REPO_AGENTS_CONFIG_RELATIVE_PATH);

  let raw: string;
  try {
    raw = readFileSync(configPath, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // The overwhelmingly common case: the repository has no declaration.
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    logger.warn('repo-agents:read-failed', {
      source: configPath,
      code,
      error: forLog((error as Error).message),
    });
    return null;
  }

  const bytes = Buffer.byteLength(raw, 'utf8');
  if (bytes > MAX_REPO_AGENTS_CONFIG_BYTES) {
    logger.warn('repo-agents:too-large', {
      source: configPath,
      bytes,
      limit: MAX_REPO_AGENTS_CONFIG_BYTES,
    });
    return null;
  }

  return parseRepoAgentsConfig(raw, configPath);
}

/**
 * Read the declaration from disk and store the answer, replacing whatever the
 * cache held.
 *
 * This is the "read it at sync" the Issue asks for: `scanWorktrees()` calls it
 * once per repository, so a broken file warns once per sync rather than once per
 * sidebar poll (the negative answer is cached too, which is what keeps the
 * warning from repeating).
 *
 * @param repoPath - Repository root
 * @param now - Injectable clock (tests)
 * @returns Ordered agents, or null when there is no usable declaration
 */
export function refreshRepoAgentsConfig(
  repoPath: string,
  now: number = Date.now()
): CLIToolType[] | null {
  const value = loadRepoAgentsConfig(repoPath);
  cache.set(repoPath, { value, expiresAt: now + REPO_AGENTS_CACHE_TTL_MS });
  return value;
}

/**
 * The `repo` layer of `resolveSelectedAgents()` for one repository.
 *
 * Serves memory; see the module header for why, and for the two cases that do
 * reach the disk. Never throws.
 *
 * @param repoPath - Repository root; a falsy path (a worktree row with no
 *   `repository_path`) has no repository to ask and answers null
 * @param now - Injectable clock (tests)
 * @returns Ordered agents (`[0]` is the primary), or null when unset/invalid
 */
export function getRepoDefaultSelectedAgents(
  repoPath: string | null | undefined,
  now: number = Date.now()
): CLIToolType[] | null {
  if (!repoPath) return null;
  const entry = cache.get(repoPath);
  if (entry && entry.expiresAt > now) return entry.value;
  return refreshRepoAgentsConfig(repoPath, now);
}

/**
 * Drop cached declarations. Tests, and any surface that just rewrote one.
 *
 * @param repoPath - Only this repository when given; the whole cache otherwise
 */
export function clearRepoAgentsConfigCache(repoPath?: string): void {
  if (repoPath === undefined) {
    cache.clear();
    return;
  }
  cache.delete(repoPath);
}
