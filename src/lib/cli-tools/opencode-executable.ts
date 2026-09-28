/**
 * Which `opencode` is OpenCode 1.x and which is OpenCode V2 (Issue #2939).
 *
 * ## Why the name is not enough
 *
 * OpenCode V2's npm package `@opencode/cli` (2.0.18) registers **both**
 * `opencode` and `opencode2` in its `bin`. So on a machine that has it,
 * `opencode` may be OpenCode 1.x (its own installer, `~/.opencode/bin`) or
 * OpenCode V2 (`/opt/homebrew/bin/opencode`), decided by nothing but the order
 * of `PATH`. Asking `which opencode` then answers "OpenCode is installed" for a
 * V2 binary, and the v1 launch line (`opencode --port N --hostname …`) reaches
 * a program that has neither flag.
 *
 * The answer here is the version each candidate prints about itself:
 *
 *  - OpenCode 1.x prints a bare `1.18.33`;
 *  - OpenCode V2 prints `opencode v2.0.18`.
 *
 * Every `opencode` / `opencode2` on `PATH` is a candidate, not just the first,
 * so a V2 `opencode` earlier on `PATH` no longer hides a 1.x one behind it.
 *
 * ## Probe and launch are one measurement
 *
 * The path that answered is the path the launch line runs — the rule
 * `./copilot-executable` set for copilot (#1907). The server resolves names on
 * its own `PATH`, the pane on its login shell's; typing a bare `opencode` would
 * let the two disagree.
 *
 * ## Cost
 *
 * `opencode --version` takes ~0.4 s and both tools probe `opencode`, so one
 * probe per path is shared for {@link OPENCODE_EXECUTABLE_CACHE_TTL_MS}, and a
 * concurrent caller gets the probe already in flight.
 *
 * @module lib/cli-tools/opencode-executable
 */

import { execFile } from 'child_process';
import { findExecutablesOnPath } from './copilot-executable';
import { sanitizeEnvForChildProcess } from '../security/env-sanitizer';

/** OpenCode 1.x's executable name (tool id `opencode`). */
export const OPENCODE_V1_BINARY_NAME = 'opencode';

/** OpenCode V2's own executable name (tool id `opencode-v2`). */
export const OPENCODE_V2_BINARY_NAME = 'opencode2';

/** Budget for one `--version`. */
export const OPENCODE_VERSION_PROBE_TIMEOUT_MS = 5000;

/** `--version` prints one short line; anything bigger is not an answer. */
const OPENCODE_VERSION_PROBE_MAX_BUFFER = 64 * 1024;

/** How long one probe result is reused (same TTL as the installed-agents cache). */
export const OPENCODE_EXECUTABLE_CACHE_TTL_MS = 30_000;

/** Candidates probed per name. A PATH with more copies than this is not a setup to guess about. */
const MAX_CANDIDATES_PER_NAME = 4;

/** Which OpenCode a binary is. */
export type OpencodeGeneration = 'v1' | 'v2';

/** What `--version` said, when it said something recognisable. */
export interface OpencodeVersionInfo {
  readonly generation: OpencodeGeneration;
  /** `major.minor.patch` (plus any pre-release suffix). */
  readonly version: string;
}

/** `opencode v2.0.18` — OpenCode V2's form. */
const PREFIXED_VERSION_LINE = /^opencode v(\d+)\.(\d+)\.(\d+)((?:[-+][0-9A-Za-z.-]+)?)$/;

/** `1.18.33` — OpenCode 1.x's form: the version and nothing else. */
const BARE_VERSION_LINE = /^v?(\d+)\.(\d+)\.(\d+)((?:[-+][0-9A-Za-z.-]+)?)$/;

/**
 * Classify `opencode --version` / `opencode2 --version` output.
 *
 * A line has to be a version in one of the two forms and nothing else, so a
 * different program that happens to print a number is not taken for either.
 * The major version decides: 1 is OpenCode 1.x, 2 or later is OpenCode V2.
 * `0.x` (the pre-1.0 `opencode`) and anything unreadable are null.
 *
 * @returns The generation and version, or null when the output is not OpenCode's
 */
export function parseOpencodeVersionOutput(output: string): OpencodeVersionInfo | null {
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = PREFIXED_VERSION_LINE.exec(line) ?? BARE_VERSION_LINE.exec(line);
    if (!match) continue;
    const major = Number(match[1]);
    const version = `${match[1]}.${match[2]}.${match[3]}${match[4] ?? ''}`;
    if (major === 1) return { generation: 'v1', version };
    if (major >= 2) return { generation: 'v2', version };
    return null;
  }
  return null;
}

/** One candidate and what it answered (null: no recognisable answer). */
export interface OpencodeProbe {
  readonly path: string;
  readonly info: OpencodeVersionInfo | null;
}

/** The binary a tool will run. */
export interface OpencodeExecutable {
  /** Absolute path, as found on `PATH` — the launch line runs exactly this. */
  readonly path: string;
  readonly version: string;
  readonly generation: OpencodeGeneration;
}

/** A resolution: what was chosen, and every candidate asked on the way. */
export interface OpencodeResolution {
  readonly executable: OpencodeExecutable | null;
  readonly probed: readonly OpencodeProbe[];
}

interface CacheEntry {
  readonly expiresAt: number;
  readonly info: Promise<OpencodeVersionInfo | null>;
}

const probeCache = new Map<string, CacheEntry>();

/** Forget every cached probe (tests, and a caller that knows the install changed). */
export function clearOpencodeExecutableCache(): void {
  probeCache.clear();
}

function runVersionProbe(executable: string): Promise<OpencodeVersionInfo | null> {
  return new Promise((resolve) => {
    try {
      execFile(
        executable,
        ['--version'],
        {
          timeout: OPENCODE_VERSION_PROBE_TIMEOUT_MS,
          maxBuffer: OPENCODE_VERSION_PROBE_MAX_BUFFER,
          env: sanitizeEnvForChildProcess(),
        },
        (error, stdout, stderr) => {
          if (error) {
            resolve(null);
            return;
          }
          resolve(parseOpencodeVersionOutput(`${stdout ?? ''}\n${stderr ?? ''}`));
        }
      );
    } catch {
      resolve(null);
    }
  });
}

/** `<path> --version`, classified; cached per path. Never rejects. */
export function probeOpencodeExecutable(path: string): Promise<OpencodeVersionInfo | null> {
  const now = Date.now();
  const cached = probeCache.get(path);
  if (cached && cached.expiresAt > now) return cached.info;
  const info = runVersionProbe(path);
  probeCache.set(path, { expiresAt: now + OPENCODE_EXECUTABLE_CACHE_TTL_MS, info });
  return info;
}

/** Probe `names` in order and return the first candidate of `generation`. */
async function resolveGeneration(
  names: readonly string[],
  generation: OpencodeGeneration
): Promise<OpencodeResolution> {
  const probed: OpencodeProbe[] = [];
  for (const name of names) {
    for (const path of findExecutablesOnPath(name, MAX_CANDIDATES_PER_NAME)) {
      if (probed.some((p) => p.path === path)) continue;
      const info = await probeOpencodeExecutable(path);
      probed.push({ path, info });
      if (info?.generation === generation) {
        return { executable: { path, version: info.version, generation }, probed };
      }
    }
  }
  return { executable: null, probed };
}

/**
 * OpenCode 1.x: the first `opencode` on `PATH` that prints a 1.x version.
 * An `opencode` that answers `opencode v2.x` is skipped, never launched.
 */
export function resolveOpencodeV1Executable(): Promise<OpencodeResolution> {
  return resolveGeneration([OPENCODE_V1_BINARY_NAME], 'v1');
}

/**
 * OpenCode V2: `opencode2` first, then an `opencode` that prints
 * `opencode v2.x` — for an operator who has V2 only under the `opencode` name.
 */
export function resolveOpencodeV2Executable(): Promise<OpencodeResolution> {
  return resolveGeneration([OPENCODE_V2_BINARY_NAME, OPENCODE_V1_BINARY_NAME], 'v2');
}

/**
 * Why OpenCode 1.x counts as not installed, when there is more to say than
 * "no `opencode` on PATH".
 *
 * @returns A sentence naming the `opencode` that is there and what it is, or
 *   null when nothing called `opencode` was found at all
 */
export function describeOpencodeV1Unavailable(resolution: OpencodeResolution): string | null {
  if (resolution.executable) return null;
  const v2 = resolution.probed.find((p) => p.info?.generation === 'v2');
  if (v2?.info) {
    return (
      `\`opencode\` at ${v2.path} is OpenCode V2 ${v2.info.version}, not OpenCode 1.x ` +
      '(npm `@opencode/cli` registers both `opencode` and `opencode2`). ' +
      'Use the OpenCode V2 agent, or put an OpenCode 1.x `opencode` on PATH.'
    );
  }
  const other = resolution.probed[0];
  if (other) {
    return `\`opencode\` at ${other.path} did not report an OpenCode 1.x version (\`opencode --version\`).`;
  }
  return null;
}
