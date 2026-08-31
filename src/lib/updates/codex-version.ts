/**
 * `~/.codex/version.json` — what codex itself already knows about its updates
 * (Issue #2069).
 *
 * ## Why a file rather than a request
 *
 * codex runs its own release check and writes the answer next to its config:
 *
 * ```json
 * {"latest_version":"0.151.0","last_checked_at":"2026-08-30T15:12:18.082219Z","dismissed_version":null}
 * ```
 *
 * So "is there a newer codex?" is answerable with a `readFileSync` and no
 * network at all. That is the whole reason this module exists rather than a
 * registry query: `GET /api/agents/versions` is rendered on a settings screen
 * and inside the agent pane, and #1913's rule — do not put a network round trip
 * on a surface that renders a list — applies to a fetch exactly as it applies to
 * a child process. The trade is that the answer is only as fresh as the last
 * time codex itself looked, which is the correct freshness: it is codex's own
 * notion of "you are behind", the same one its TUI banner uses.
 *
 * ## Fail-open, in every direction
 *
 * The file is written by another program, on its own schedule, in a format it
 * owns. It is legitimately **absent** (a fresh install, a codex that has never
 * run), legitimately **null-valued** (`dismissed_version` is null until the user
 * dismisses a banner), and it can be a half-written temp file caught mid-rename.
 * None of those is an error here: every failure resolves to
 * {@link EMPTY_CODEX_VERSION_FILE} and the caller reports "no update known",
 * which is exactly what the surfaces render when codex is not installed either.
 * The acceptance criterion for this Issue names that behaviour directly —
 * 「`version.json` が無い / 壊れている環境で落ちない」— and
 * `tests/unit/updates/codex-version-2069.test.ts` pins it case by case.
 *
 * ## Why `$CODEX_HOME` is resolved here rather than imported
 *
 * `lib/hooks/sources/codex/hooks-config.getCodexHome()` answers the same
 * question, and this module deliberately does not call it: that function reaches
 * `@/lib/logger` through `config/safe-directory`, and `tsconfig.cli.json` resets
 * `"paths"` to `{}` — so a single alias import anywhere in this module's
 * transitive closure breaks `npm run build:cli`, and `commandmate agents update`
 * is a CLI command. The guard the two share is the one that matters for a path
 * that came out of the environment ({@link isVirtualFilesystemPath}); the mkdir
 * hang #1774 defends against cannot arise here because this module only ever
 * reads.
 *
 * @module lib/updates/codex-version
 */

import { readFileSync, statSync } from 'fs';
import { homedir } from 'os';
import { isAbsolute, join } from 'path';
import { isVirtualFilesystemPath } from '../../config/system-directories';
import { compareCliVersions, parseCliVersion } from '../detection/version-probes';

/**
 * The one thing this module reads out of the environment.
 *
 * Narrower than `NodeJS.ProcessEnv` on purpose: vitest's type augmentation
 * makes `NODE_ENV` REQUIRED on that interface, so a test could not hand these
 * functions a two-key literal without also declaring a `NODE_ENV` that has
 * nothing to do with what is being tested.
 */
export type CodexVersionEnv = Readonly<Record<string, string | undefined>>;

/** codex's own config-directory override. Same variable `hooks-config` honours. */
export const CODEX_HOME_ENV_VAR = 'CODEX_HOME';

/** The file codex writes its release check into, inside `$CODEX_HOME`. */
export const CODEX_VERSION_FILENAME = 'version.json';

/**
 * Largest `version.json` this module will parse.
 *
 * Three short fields; anything past this is not the file we mean. A cap rather
 * than trust because the read happens on a request path and the file is written
 * by another process — an oversized file is discarded, not truncated and parsed.
 */
export const CODEX_VERSION_FILE_MAX_BYTES = 64 * 1024;

/** What {@link readCodexVersionFile} could recover from the file. */
export interface CodexVersionFile {
  /** `latest_version`, normalized to `major.minor.patch`, or null. */
  latestVersion: string | null;
  /** `dismissed_version`, normalized, or null (the ordinary value). */
  dismissedVersion: string | null;
  /** `last_checked_at` verbatim — an opaque timestamp string, or null. */
  lastCheckedAt: string | null;
  /** Absolute path that was read. Reported so an operator can go look. */
  path: string;
  /** False when the file was missing, oversized, unreadable or malformed. */
  readable: boolean;
}

/** The answer for every failure: "codex has told us nothing". */
export const EMPTY_CODEX_VERSION_FILE: Omit<CodexVersionFile, 'path'> = {
  latestVersion: null,
  dismissedVersion: null,
  lastCheckedAt: null,
  readable: false,
};

/**
 * `$CODEX_HOME`, or `~/.codex`.
 *
 * A relative `$CODEX_HOME` is refused: codex resolves it against its own cwd,
 * which is the agent's worktree and not this process's, so honouring it here
 * would read a different machine's idea of the file. A virtual-filesystem path
 * is refused for the reason `config/safe-directory` gives.
 *
 * @param env - Environment to read. Injectable so tests need no `process.env`
 *   mutation.
 * @returns An absolute directory path.
 */
export function getCodexHomeForVersionRead(env: CodexVersionEnv = process.env): string {
  const fallback = join(homedir(), '.codex');
  const configured = env[CODEX_HOME_ENV_VAR];
  if (!configured) return fallback;
  if (!isAbsolute(configured)) return fallback;
  if (isVirtualFilesystemPath(configured)) return fallback;
  return configured;
}

/** Absolute path of the file codex writes its release check into. */
export function getCodexVersionFilePath(env: CodexVersionEnv = process.env): string {
  return join(getCodexHomeForVersionRead(env), CODEX_VERSION_FILENAME);
}

/** Read one field as a normalized version, tolerating null / wrong types. */
function readVersionField(raw: Record<string, unknown>, key: string): string | null {
  const value = raw[key];
  if (typeof value !== 'string') return null;
  return parseCliVersion(value);
}

/**
 * Read `$CODEX_HOME/version.json`.
 *
 * Never throws and never rejects: see the module header. A file that parses but
 * carries junk in a field yields null for **that field only**, so a codex build
 * that adds or renames a key still gives up whatever the rest of it says.
 *
 * @param options.path - Read this file instead of the resolved default (tests,
 *   and an isolated-HOME verification run).
 * @param options.env - Environment used to resolve the default path.
 */
export function readCodexVersionFile(
  options: { path?: string; env?: CodexVersionEnv } = {}
): CodexVersionFile {
  const path = options.path ?? getCodexVersionFilePath(options.env);
  const empty: CodexVersionFile = { ...EMPTY_CODEX_VERSION_FILE, path };

  try {
    const stat = statSync(path);
    if (!stat.isFile()) return empty;
    if (stat.size > CODEX_VERSION_FILE_MAX_BYTES) return empty;

    const parsed: unknown = JSON.parse(readFileSync(path, 'utf-8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return empty;

    const raw = parsed as Record<string, unknown>;
    return {
      latestVersion: readVersionField(raw, 'latest_version'),
      dismissedVersion: readVersionField(raw, 'dismissed_version'),
      lastCheckedAt: typeof raw.last_checked_at === 'string' ? raw.last_checked_at : null,
      path,
      readable: true,
    };
  } catch {
    return empty;
  }
}

/** What the two update surfaces render for codex. */
export interface CodexUpdateStatus {
  /** What `codex --version` reported, or null when it is not installed. */
  installed: string | null;
  /** codex's own `latest_version`, or null when it has not looked. */
  latestVersion: string | null;
  /** codex's own `dismissed_version`, or null. */
  dismissedVersion: string | null;
  /** True only when BOTH versions are known AND latest is strictly newer. */
  updateAvailable: boolean;
  /**
   * True when the available update is the one the user already dismissed inside
   * codex's own banner.
   *
   * Reported rather than acted on. A dismissal is a statement about codex's
   * nag, not a statement that the update is unwanted, and hiding the button
   * here would make CommandMate's answer disagree with `codex --version` for a
   * reason the screen never showed. The UI annotates; it does not disable.
   */
  dismissedInCodex: boolean;
  /** Where the "latest" half came from, or null when nothing was readable. */
  source: 'version.json' | null;
}

/**
 * Combine the installed version with codex's own release check.
 *
 * Both halves are "no answer"-tolerant, and every kind of no-answer resolves to
 * `updateAvailable: false` — not installed, never checked, unparseable. That is
 * the same posture `DetectorFreshnessRow.stale` takes, and for the same reason:
 * an update prompt the user cannot act on is worse than no prompt.
 *
 * @param installed - Output of the `codex --version` probe, or null.
 * @param file - What {@link readCodexVersionFile} recovered.
 */
export function evaluateCodexUpdate(
  installed: string | null,
  file: CodexVersionFile
): CodexUpdateStatus {
  const updateAvailable =
    installed !== null &&
    file.latestVersion !== null &&
    compareCliVersions(file.latestVersion, installed) > 0;

  return {
    installed,
    latestVersion: file.latestVersion,
    dismissedVersion: file.dismissedVersion,
    updateAvailable,
    dismissedInCodex:
      updateAvailable &&
      file.dismissedVersion !== null &&
      file.dismissedVersion === file.latestVersion,
    source: file.readable ? 'version.json' : null,
  };
}
