/**
 * Where GitHub Copilot CLI actually is, and whether it is actually there
 * (Issue #1907).
 *
 * ## Why this is not `gh copilot --help`
 *
 * `CopilotTool.isInstalled()` used to answer "is copilot installed?" with
 * `gh --version` followed by `gh copilot --help`. Measured on gh 2.86.0 with an
 * empty `gh extension list`, the second command exits 0 in ~20 ms on a machine
 * where the extension does not exist, because `copilot` is no longer an
 * extension at all -- it is a preview command built into `gh`, and the help text
 * it prints says so itself:
 *
 * > If already installed, `gh` will execute the Copilot CLI found in your
 * > `PATH`. If the Copilot CLI is not installed, it will be downloaded to
 * > ~/.local/share/gh/copilot.
 *
 * So the old check proved that `gh` was installed and nothing more. The
 * consequence was not a wrong badge: `startSession` typed `gh copilot` into the
 * pane, gh started *downloading* copilot there, `waitForReady` spun its whole
 * window against a progress bar, and the launch was logged as a success.
 *
 * This module answers the question with positive evidence instead (方針書 §4
 * D1): an executable file that exists, and a `--version` that exits 0 and prints
 * a version. Nothing here infers presence from the absence of an error.
 *
 * ## Why the path is resolved before it is run
 *
 * `copilot` is a common word and the probe runs with the server's privileges, so
 * the candidate is resolved out of `PATH` to an absolute path first, checked to
 * be an executable *file*, and only then handed to `execFile` with a bounded
 * timeout, a bounded `maxBuffer` and `sanitizeEnvForChildProcess()`. This is the
 * rule 方針書 §10.11 / DR4-010 states for version probes; it applies here for the
 * same reason, since this is the probe that decides what gets launched.
 *
 * @module lib/cli-tools/copilot-executable
 */

import { execFile } from 'child_process';
import { accessSync, constants, statSync } from 'fs';
import { homedir } from 'os';
import { delimiter, join } from 'path';
import { sanitizeEnvForChildProcess } from '../security/env-sanitizer';

/**
 * How a resolved copilot was found.
 *
 * - `path` — a `copilot` executable on the server's `PATH`. The normal case for
 *   `brew install copilot-cli` and `npm i -g @github/copilot`.
 * - `gh-managed` — the copy `gh copilot` downloads for itself when `PATH` has
 *   none. It is not on `PATH` by design, so it is launched back through
 *   `gh copilot`; gh runs exactly this file, because gh prefers `PATH` and we
 *   only get here when `PATH` has nothing.
 */
export type CopilotExecutableSource = 'path' | 'gh-managed';

/** A copilot that was found AND answered `--version`. */
export interface CopilotExecutable {
  /** Absolute path of the file that answered. */
  readonly path: string;
  /** Version it reported, e.g. `1.0.80`. */
  readonly version: string;
  /** Which of the two locations it came from. */
  readonly source: CopilotExecutableSource;
}

/** Executable name on `PATH`. */
const COPILOT_BINARY_NAME = 'copilot';

/** gh's own executable name; the `gh-managed` copy is launched through it. */
const GH_BINARY_NAME = 'gh';

/** Budget for one `--version` call. Matches the old two-stage check's per-stage timeout. */
export const COPILOT_VERSION_PROBE_TIMEOUT_MS = 5000;

/** Bounded output for the probe (DR4-009): `--version` prints two short lines. */
const COPILOT_VERSION_PROBE_MAX_BUFFER = 64 * 1024;

/**
 * The version in `GitHub Copilot CLI 1.0.80.` — required, not optional.
 *
 * An exit code of 0 alone is what made the previous check useless, so a
 * `--version` that succeeds while printing nothing recognisable is treated as no
 * evidence at all.
 */
const COPILOT_VERSION_PATTERN = /(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/;

/** True when `candidate` is a regular file this process may execute. */
function isExecutableFile(candidate: string): boolean {
  try {
    if (!statSync(candidate).isFile()) return false;
    accessSync(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * First executable named `name` on `PATH`, as an absolute path.
 *
 * Exported since Issue #1929: `DETECTOR_VERSION_PROBES` has to resolve every
 * probe command the same way before executing it (DR4-010 (2)), and a second
 * copy of this walk is exactly the "two probe mechanisms with different trust
 * models" DR4-010 exists to prevent. The name stays generic because the walk
 * is; what is copilot-specific is the caller below.
 */
export function findExecutableOnPath(name: string): string | null {
  const rawPath = process.env.PATH;
  if (!rawPath) return null;
  for (const directory of rawPath.split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, name);
    if (isExecutableFile(candidate)) return candidate;
  }
  return null;
}

/**
 * Where `gh copilot` puts the copy it downloads.
 *
 * gh names `~/.local/share/gh/copilot` in its own help output and honours
 * `XDG_DATA_HOME`. Both a bare file at that path and a directory containing the
 * binary are accepted, because which of the two gh writes is gh's business and
 * guessing wrong here would silently report "not installed".
 */
function ghManagedCandidates(): string[] {
  const dataHome = process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share');
  const base = join(dataHome, 'gh', COPILOT_BINARY_NAME);
  return [base, join(base, COPILOT_BINARY_NAME)];
}

/** Run `<executable> --version`; the version string, or null for any failure. */
function probeVersion(executable: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      executable,
      ['--version'],
      {
        timeout: COPILOT_VERSION_PROBE_TIMEOUT_MS,
        maxBuffer: COPILOT_VERSION_PROBE_MAX_BUFFER,
        env: sanitizeEnvForChildProcess(),
      },
      (error, stdout, stderr) => {
        if (error) {
          resolve(null);
          return;
        }
        const match = COPILOT_VERSION_PATTERN.exec(`${stdout ?? ''}\n${stderr ?? ''}`);
        resolve(match ? match[1] : null);
      }
    );
  });
}

/**
 * The copilot this machine would actually run, or null when there is none.
 *
 * `PATH` first, gh's managed copy second — the order the operator experiences,
 * and the order gh itself uses. Never throws: an unreadable directory, a missing
 * `PATH`, a probe that times out are all "no evidence", which is the answer that
 * makes `startSession` refuse instead of starting a download in the pane.
 */
export async function resolveCopilotExecutable(): Promise<CopilotExecutable | null> {
  const onPath = findExecutableOnPath(COPILOT_BINARY_NAME);
  if (onPath) {
    const version = await probeVersion(onPath);
    if (version) return { path: onPath, version, source: 'path' };
  }

  // The managed copy is only reachable through `gh copilot`, so a machine
  // without gh cannot launch it however present the file is.
  if (!findExecutableOnPath(GH_BINARY_NAME)) return null;

  for (const candidate of ghManagedCandidates()) {
    if (!isExecutableFile(candidate)) continue;
    const version = await probeVersion(candidate);
    if (version) return { path: candidate, version, source: 'gh-managed' };
  }
  return null;
}
