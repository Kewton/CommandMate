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
 * ## `$CODEX_HOME`: why it is resolved here, and where the two rules diverge
 *
 * `lib/hooks/sources/codex/hooks-config.getCodexHome()` answers the same
 * question, and this module cannot call it: that function reaches `@/lib/logger`
 * through `config/safe-directory`, and `tsconfig.cli.json` resets `"paths"` to
 * `{}` — so one alias import anywhere in this module's transitive closure breaks
 * `npm run build:cli` with TS2307 (the #1933 defect PR #1991 fixed), and
 * `commandmate agents update` puts this file in the CLI's closure. The variable
 * NAME therefore exists in two files, and
 * `tests/unit/updates/codex-home-parity-2069.test.ts` is the join: it imports
 * both and fails if the spellings or the shared rules ever drift.
 *
 * The rules are deliberately identical except for one case, and that case is a
 * correctness fix rather than a divergence for its own sake:
 *
 * | `$CODEX_HOME`            | hooks-config                        | here                |
 * |--------------------------|-------------------------------------|---------------------|
 * | unset                    | `~/.codex`                          | `~/.codex`          |
 * | absolute                 | that path                           | that path           |
 * | inside `/proc`/`/sys`/`/dev` | `~/.codex` (#1774)              | `~/.codex`          |
 * | **relative**             | passed through **verbatim**         | **null = unknown**  |
 *
 * `resolveSafeDirectory` returns a relative candidate unchanged, and
 * `hooks-config` puts that value on codex's own launch line — so codex resolves
 * it against **the agent's worktree cwd**, and `CODEX_HOME=.codex-shared` means
 * codex writes `<worktree>/.codex-shared/version.json`. This process is not in
 * that worktree and, with several worktrees open, cannot say which one was
 * meant. Falling back to `~/.codex` there is the one genuinely bad answer: it
 * is not "no data", it is an unrelated install's version, reported with the
 * same confidence as a real reading. So a relative value resolves to null and
 * every surface renders "no update information", which is what they already
 * render when codex has never run.
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

/**
 * codex's own config-directory override.
 *
 * NOT exported: `lib/hooks/sources/codex/hooks-config` already exports this name
 * and that one is the repository's single public spelling. A second exported
 * `CODEX_HOME_ENV_VAR` is how two modules end up disagreeing about it, and the
 * `@/`-import rule above is the only reason the literal exists twice at all.
 * `tests/unit/updates/codex-home-parity-2069.test.ts` pins the two together.
 */
const CODEX_HOME_ENV_VAR = 'CODEX_HOME';

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
  /**
   * Absolute path that was read, or null when `$CODEX_HOME` is relative and the
   * file's location therefore depends on a worktree this process cannot name.
   */
  path: string | null;
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
 * The directory codex keeps its state in, as seen from THIS process.
 *
 * See the table in the module header for the four cases. The one that returns
 * null is a relative `$CODEX_HOME`: `hooks-config` forwards such a value to
 * codex verbatim, codex resolves it against the agent's worktree cwd, and this
 * process has no worktree — so the honest answer is "cannot tell", not
 * `~/.codex`.
 *
 * @param env - Environment to read. Injectable so tests need no `process.env`
 *   mutation.
 * @returns An absolute directory path, or null when it cannot be determined.
 */
export function getCodexHomeForVersionRead(env: CodexVersionEnv = process.env): string | null {
  const fallback = join(homedir(), '.codex');
  const configured = env[CODEX_HOME_ENV_VAR];
  if (!configured) return fallback;
  // Matches `resolveSafeDirectory`: a /proc, /sys or /dev path is refused and
  // the built-in default is used, on both sides of the join.
  if (isVirtualFilesystemPath(configured)) return fallback;
  if (!isAbsolute(configured)) return null;
  return configured;
}

/**
 * Absolute path of the file codex writes its release check into, or null when
 * {@link getCodexHomeForVersionRead} cannot determine the directory.
 */
export function getCodexVersionFilePath(env: CodexVersionEnv = process.env): string | null {
  const home = getCodexHomeForVersionRead(env);
  return home === null ? null : join(home, CODEX_VERSION_FILENAME);
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

  // Unknown directory (a relative `$CODEX_HOME`): read nothing rather than read
  // the wrong install's file. See the table in the module header.
  if (path === null) return empty;

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
   * True when `dismissed_version` names the update that is available — i.e.
   * **something** answered codex's update banner with "not this version".
   *
   * **Not necessarily the user.** The digit that writes `dismissed_version` is
   * the same one CommandMate can be configured to send for codex's in-pane
   * update dialog (#2068, `CM_CODEX_UPDATE_DIALOG`), and on the default policy
   * CommandMate sends it on every codex launch. So on a stock install this flag
   * goes true without anybody having decided anything, and wording that says
   * "you dismissed this" would be blaming the user for the server's own
   * automatic answer.
   *
   * That is why it is reported and never acted on: it does not hide the update,
   * it does not disable the button, and the copy beside it
   * (`common.agentUpdates.dismissed`) says only that the version was dismissed
   * in codex — without naming who did it.
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
