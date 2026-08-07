/**
 * Blast-radius guards for the detection canary (Issue #1727).
 *
 * The canary starts a real `claude` and opens `/model` — an overlay whose whole
 * purpose is to WRITE the default-model setting. A previous live TUI probe did
 * exactly that to the developer's global config. These guards make the two
 * things the canary must never touch verifiable rather than hoped-for:
 *
 * 1. the real `~/.claude/settings.json` (fingerprinted before/after), and
 * 2. the user's live `mcbd-*` tmux sessions (listed before/after).
 */

import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Marker returned instead of a hash when the file does not exist. */
export const ABSENT_FINGERPRINT = 'absent';

/** sha256 of a file's bytes, or {@link ABSENT_FINGERPRINT}. */
export function fingerprintFile(filePath: string): string {
  if (!existsSync(filePath)) return ABSENT_FINGERPRINT;
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

/**
 * Assert that `isolatedHome` is a usable isolated HOME and is NOT the real one.
 *
 * Pure so the invariant is unit-testable. Rejects: equality with the real HOME,
 * relative paths, and any path that contains the real HOME (which would put the
 * user's config back inside the blast radius).
 */
export function assertIsolatedHome(realHome: string, isolatedHome: string): void {
  if (!path.isAbsolute(isolatedHome)) {
    throw new Error(`canary: isolated HOME must be an absolute path (got ${JSON.stringify(isolatedHome)})`);
  }
  const real = path.resolve(realHome);
  const isolated = path.resolve(isolatedHome);
  if (real === isolated) {
    throw new Error('canary: isolated HOME is the real HOME — refusing to run (the /model scenario writes settings)');
  }
  if (isolated === path.parse(isolated).root) {
    throw new Error('canary: isolated HOME must not be the filesystem root');
  }
  if (real.startsWith(`${isolated}${path.sep}`)) {
    throw new Error(
      `canary: isolated HOME ${isolated} contains the real HOME ${real} — refusing to run`
    );
  }
}

/** Result of comparing two session-name snapshots. */
export interface SessionSnapshotDiff {
  disappeared: string[];
  appeared: string[];
}

/** Pure set diff over session names, sorted for stable reporting. */
export function diffSessionNames(before: readonly string[], after: readonly string[]): SessionSnapshotDiff {
  const beforeSet = new Set(before);
  const afterSet = new Set(after);
  return {
    disappeared: [...beforeSet].filter(name => !afterSet.has(name)).sort(),
    appeared: [...afterSet].filter(name => !beforeSet.has(name)).sort(),
  };
}

/** Keep only the production agent sessions (`mcbd-*`). */
export function filterProductionSessions(names: readonly string[]): string[] {
  return names.filter(name => name.startsWith('mcbd-')).sort();
}

/**
 * List the sessions on the user's DEFAULT tmux server.
 *
 * This is the one and only place the canary invokes `tmux` without `-L`, and it
 * is hard-coded to a single read-only subcommand. Everything that can mutate
 * tmux state goes through `PrivateTmuxServer`, which cannot omit `-L`.
 * Returns `[]` when no server is running.
 */
export async function listUserTmuxSessions(): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync('tmux', ['list-sessions', '-F', '#{session_name}'], {
      timeout: 10_000,
    });
    return stdout.split('\n').map(line => line.trim()).filter(Boolean);
  } catch {
    // "no server running on ..." — nothing of the user's to protect.
    return [];
  }
}

/** Before/after state the run is checked against. */
export interface GuardSnapshot {
  /** Path of the real `~/.claude/settings.json`. */
  realSettingsPath: string;
  /** Fingerprint of that file at snapshot time. */
  realSettingsFingerprint: string;
  /** The user's `mcbd-*` sessions at snapshot time. */
  productionSessions: string[];
}

/** Capture the pre-run state that the post-run assertions compare against. */
export async function captureGuardSnapshot(realHome: string): Promise<GuardSnapshot> {
  const realSettingsPath = path.join(realHome, '.claude', 'settings.json');
  return {
    realSettingsPath,
    realSettingsFingerprint: fingerprintFile(realSettingsPath),
    productionSessions: filterProductionSessions(await listUserTmuxSessions()),
  };
}

/**
 * Re-check the snapshot. Throws with a specific message on the first violation.
 *
 * @param phase - Where the check runs, e.g. `"before /model overlay"`.
 */
export async function assertGuardSnapshotIntact(snapshot: GuardSnapshot, phase: string): Promise<void> {
  const nowFingerprint = fingerprintFile(snapshot.realSettingsPath);
  if (nowFingerprint !== snapshot.realSettingsFingerprint) {
    throw new Error(
      `canary: ${snapshot.realSettingsPath} CHANGED (${phase}). HOME isolation failed — ` +
        `the canary must never write the developer's Claude settings. ` +
        `before=${snapshot.realSettingsFingerprint.slice(0, 12)} after=${nowFingerprint.slice(0, 12)}`
    );
  }

  const diff = diffSessionNames(snapshot.productionSessions, filterProductionSessions(await listUserTmuxSessions()));
  if (diff.disappeared.length > 0) {
    throw new Error(
      `canary: production tmux sessions disappeared (${phase}): ${diff.disappeared.join(', ')}. ` +
        `The canary must only ever touch its own -L socket.`
    );
  }
  if (diff.appeared.length > 0) {
    throw new Error(
      `canary: unexpected mcbd-* sessions appeared on the user's tmux server (${phase}): ${diff.appeared.join(', ')}`
    );
  }
}
