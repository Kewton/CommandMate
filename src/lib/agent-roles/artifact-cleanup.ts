/**
 * Removing the Antigravity definitions a deleted role leaves behind (Issue #4419).
 *
 * agy lists every definition under `~/.gemini/config/agents/`, so one generated
 * for a role that no longer exists stays in `agy agent` with nothing pointing at
 * it. This removes those, and only those, at the role's deletion:
 *
 * - **Ours by record.** Candidates come from this server's launch records
 *   (`agent_role_launch_records`), never from a directory listing. A path counts
 *   only when the record says the deleted role, the Antigravity adapter, one
 *   artifact fingerprint, and a name of the form
 *   `cm-role-<this server's namespace>-<role id>-<12 hex>`.
 * - **Ours by content.** {@link removeRoleArtifact} then reads the file: every
 *   byte must hash to the recorded fingerprint, behind directories we could have
 *   written, with nothing else in its directory. Anything else is left.
 * - **Not in use.** A path is left while a session whose latest launch record
 *   names it is present, or when tmux cannot say (`unknown`: a timeout, a busy
 *   socket, a failed spawn). Only `absent` lets it go.
 * - **Not being launched.** The invariant: a definition a launch record names is
 *   not removed until that launch's pane exists and is confirmed alive, or the
 *   launch has failed. A launch prepares its file before it records anything,
 *   and records `requested` before its pane is created; {@link removeRoleArtifact}
 *   leaves a file a launch in this process claims (`holdRoleArtifact`: until the
 *   launch ends, or until this cleanup finds the owner's session `present` after
 *   its `requested`, {@link confirmRoleArtifactSession}), and one a probe or
 *   Schedule prepared within `ROLE_ARTIFACT_PREPARED_HOLD_MS`, whatever else
 *   claims it.
 * - **Never in the way.** Nothing here throws; the role is already deleted, and
 *   what was left is reported for a warning.
 *
 * Copilot, Codex and the data-root adapters are not touched: see
 * `docs/user-guide/cli-operations-guide.md` (roles) for why and how to remove them.
 *
 * @module lib/agent-roles/artifact-cleanup
 */
import type Database from 'better-sqlite3';
import { basename, dirname } from 'path';
import { getLatestRoleLaunchRecords } from '@/lib/db/agent-roles-db';
import {
  confirmRoleArtifactSession,
  deriveServerNamespace,
  removeRoleArtifact,
  type ArtifactOptions,
  type RoleArtifactRemoval,
  type RoleArtifactRemovalHooks,
} from './artifacts';

export interface RoleArtifactCleanupTarget {
  worktreeId: string;
  instanceId: string;
  cliToolId: string;
}

/** What tmux says of a session: the shape of `getSessionPresence` (`@/lib/session/cli-session`, Issue #3329). */
export type RoleArtifactSessionPresence = 'present' | 'absent' | 'unknown';

export interface RoleArtifactCleanupDeps {
  /** Whether the session of this instance exists now. Only `absent` frees a file; a throw counts as `unknown`. */
  probeSession: (target: RoleArtifactCleanupTarget) => Promise<RoleArtifactSessionPresence>;
  /** Where the files were written. Defaults to where a launch writes them. */
  artifacts?: ArtifactOptions;
  /** Tests only. See {@link RoleArtifactRemovalHooks}. */
  removalHooks?: RoleArtifactRemovalHooks;
}

/** Why a recorded definition was not even looked at. */
export type RoleArtifactSkipReason =
  /** The role still exists: nothing of it is removed. */
  | 'role-exists'
  /** The recorded name is not one this server generates for this role. */
  | 'not-this-role'
  /** The records disagree on what the file holds. */
  | 'ambiguous-record'
  /** A present session's latest launch runs on it. */
  | 'in-use'
  /** Whether a session runs on it could not be told (tmux answered `unknown`, or the probe threw). */
  | 'liveness-unknown';

export type RoleArtifactCleanupEntry =
  | RoleArtifactRemoval
  | { kind: 'skipped'; path: string; reason: RoleArtifactSkipReason };

export interface RoleArtifactCleanupReport {
  entries: RoleArtifactCleanupEntry[];
}

const ADAPTER = 'antigravity';

function isRoleNamed(name: string, namespace: string, roleId: string): boolean {
  const prefix = `cm-role-${namespace}-${roleId}-`;
  return name.startsWith(prefix) && /^[0-9a-f]{12}$/.test(name.slice(prefix.length));
}

/** Whether a session whose latest launch record names this path may still be there. Unknown is in use. */
async function usedBySession(
  db: Database.Database,
  path: string,
  deps: RoleArtifactCleanupDeps
): Promise<RoleArtifactSkipReason | null> {
  const targets = db
    .prepare(
      `SELECT DISTINCT worktree_id, instance_id, cli_tool_id FROM agent_role_launch_records
       WHERE artifact_path = ?`
    )
    .all(path) as Array<{ worktree_id: string; instance_id: string; cli_tool_id: string }>;
  for (const row of targets) {
    const latest = getLatestRoleLaunchRecords(db, row.worktree_id, row.instance_id);
    const current = [latest.requested, latest.launched].some((record) => record?.artifactPath === path);
    if (!current) continue;
    let presence: RoleArtifactSessionPresence;
    try {
      presence = await deps.probeSession({
        worktreeId: row.worktree_id,
        instanceId: row.instance_id,
        cliToolId: row.cli_tool_id,
      });
    } catch {
      return 'liveness-unknown';
    }
    if (presence === 'present') {
      // The pane of a launch on record is there: its claim has done its part.
      confirmRoleArtifactSession(path, { worktreeId: row.worktree_id, instanceId: row.instance_id });
      return 'in-use';
    }
    if (presence !== 'absent') return 'liveness-unknown';
  }
  return null;
}

/**
 * Remove the Antigravity definitions this server generated for a role that has
 * been deleted. Call after the deletion committed. Never throws.
 */
export async function cleanUpDeletedRoleArtifacts(
  db: Database.Database,
  roleId: string,
  deps: RoleArtifactCleanupDeps
): Promise<RoleArtifactCleanupReport> {
  const entries: RoleArtifactCleanupEntry[] = [];
  const rows = db
    .prepare(
      `SELECT artifact_path, artifact_fingerprint FROM agent_role_launch_records
       WHERE role_id = ? AND adapter_id = ? AND artifact_path IS NOT NULL AND artifact_fingerprint IS NOT NULL
       ORDER BY recorded_at, rowid`
    )
    .all(roleId, ADAPTER) as Array<{ artifact_path: string; artifact_fingerprint: string }>;
  const fingerprints = new Map<string, Set<string>>();
  for (const row of rows) {
    const known = fingerprints.get(row.artifact_path) ?? new Set<string>();
    known.add(row.artifact_fingerprint);
    fingerprints.set(row.artifact_path, known);
  }
  if (fingerprints.size === 0) return { entries };

  if (db.prepare('SELECT 1 FROM agent_roles WHERE id = ?').get(roleId)) {
    for (const path of fingerprints.keys()) entries.push({ kind: 'skipped', path, reason: 'role-exists' });
    return { entries };
  }

  const namespace = deriveServerNamespace(db.name);
  for (const [path, known] of fingerprints) {
    const name = basename(dirname(path));
    if (basename(path) !== 'agent.md' || !isRoleNamed(name, namespace, roleId)) {
      entries.push({ kind: 'skipped', path, reason: 'not-this-role' });
      continue;
    }
    if (known.size !== 1) {
      entries.push({ kind: 'skipped', path, reason: 'ambiguous-record' });
      continue;
    }
    const inUse = await usedBySession(db, path, deps);
    if (inUse !== null) {
      entries.push({ kind: 'skipped', path, reason: inUse });
      continue;
    }
    const [expectedFingerprint] = known;
    entries.push(removeRoleArtifact({ adapter: ADAPTER, name, path, expectedFingerprint }, deps.artifacts, deps.removalHooks));
  }
  return { entries };
}
