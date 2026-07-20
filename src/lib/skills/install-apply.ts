/**
 * Atomic commit of a planned Skill install into one worktree (Issue #1235)
 *
 * The write half of the plan/apply pair. #1233 fixed *what* would be written —
 * the exact payload bytes, the exact receipt bytes and the tree hash they add up
 * to — and this module is the only place those bytes reach a repository.
 *
 * Four properties carry the safety argument:
 *
 * - **The destination is derived, never received.** The install root comes from
 *   a server-resolved worktree path plus a Skill ID re-checked against
 *   {@link SKILL_ID_PATTERN}. Re-checking the grammar rather than only the
 *   joined result is deliberate: `path.join` normalizes `..` away, so
 *   `.agents/skills/../x` and `.agents/x` compare equal and a containment check
 *   alone would accept an ID that walked out of the Skills directory.
 * - **Every write is exclusive and does not follow links.** Files are created
 *   with `O_CREAT|O_EXCL|O_NOFOLLOW`, so a symlink or a file planted between the
 *   directory scan and the write cannot be written *through*; mode and digest
 *   are re-read afterwards, so a file that changed underneath us never reaches
 *   the receipt.
 * - **The commit point is one rename.** Staging lives in the reserved
 *   `.agents/skills/.commandmate-staging/` namespace, on the same filesystem as
 *   the destination, so `rename(2)` is atomic. Before it lands the destination
 *   is proven absent: an existing directory — managed or hand-made — is refused,
 *   never merged into and never implicitly overwritten.
 * - **Nothing is executed.** No script, hook, install step or archive-carried
 *   mode is ever run or honoured. Modes are assigned from the manifest's
 *   declared executable bit and nothing else.
 *
 * A failure *after* the rename is not a rollback. The payload exists, and the
 * caller must report it as committed and hand the remainder to #1234
 * reconciliation rather than claiming the worktree is unchanged.
 *
 * @module lib/skills/install-apply
 */

import {
  closeSync,
  constants as fsConstants,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  rmdirSync,
  writeSync,
} from 'fs';
import path from 'path';
import {
  SKILL_ID_MAX_LENGTH,
  SKILL_ID_PATTERN,
  SKILL_INSTALL_ROOT_PREFIX,
} from '@/lib/skills/constants';
import { computeSha256Hex, digestMatches } from '@/lib/skills/integrity';
import { getSkillInstallStagingRoot } from '@/lib/skills/operation-store';
import {
  computeSkillTreeHash,
  resolveSkillInstallRoot,
  skillInstallRoot,
} from '@/lib/skills/preview-diff';
import { SKILL_RECEIPT_FILENAME, parseInstalledReceipt } from '@/lib/skills/install-plan';
import type { SkillPackageSnapshot } from '@/lib/skills/package-validator';
import type { SkillAgentSupport, SkillInstallReceipt, SkillInstalledFile } from '@/types/skills';

// =============================================================================
// Modes and layout
// =============================================================================

/** Payload directories are owner-only, like the staging that produced them. */
export const SKILL_INSTALL_DIR_MODE = 0o700;

/** Ordinary payload files. */
export const SKILL_INSTALL_FILE_MODE = 0o600;

/** Files the manifest declared executable. Only the owner execute bit is added. */
export const SKILL_INSTALL_EXECUTABLE_MODE = 0o700;

/**
 * Grammar of the staging directory name.
 *
 * The name is a server-generated operation ID and never a client string, but it
 * becomes a path segment, so it is checked rather than trusted.
 */
export const SKILL_INSTALL_OPERATION_ID_PATTERN = /^[0-9a-zA-Z-]{8,64}$/;

/** `O_NOFOLLOW` is POSIX-only; on platforms without it the flag is a no-op. */
const O_NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0;

// =============================================================================
// Errors
// =============================================================================

/** Client-safe reasons an apply refused to write or could not finish. */
export const SkillInstallErrorCode = {
  /** The install root could not be derived safely from the worktree and Skill ID. */
  TARGET_UNSAFE: 'SKILL_INSTALL_TARGET_UNSAFE',
  /** An ancestor of the install root is a symlink or is not a directory. */
  ANCESTOR_UNSAFE: 'SKILL_INSTALL_ANCESTOR_UNSAFE',
  /** A CommandMate-managed install is already present. Updating is out of scope. */
  DESTINATION_EXISTS: 'SKILL_INSTALL_DESTINATION_EXISTS',
  /** Something CommandMate does not manage occupies the install root. */
  DESTINATION_UNMANAGED: 'SKILL_INSTALL_DESTINATION_UNMANAGED',
  /** Staging and destination are on different filesystems, so rename is not atomic. */
  CROSS_DEVICE: 'SKILL_INSTALL_CROSS_DEVICE',
  /** Staging could not be created or written. */
  STAGING_IO: 'SKILL_INSTALL_STAGING_IO',
  /** What landed in staging is not what the plan fixed. */
  PAYLOAD_MISMATCH: 'SKILL_INSTALL_PAYLOAD_MISMATCH',
  /** The atomic rename itself failed. Nothing was published. */
  COMMIT_FAILED: 'SKILL_INSTALL_COMMIT_FAILED',
} as const;

export type SkillInstallErrorCodeType =
  (typeof SkillInstallErrorCode)[keyof typeof SkillInstallErrorCode];

/** HTTP status each reason maps to, so every caller answers alike. */
export const SKILL_INSTALL_ERROR_STATUS: Record<SkillInstallErrorCodeType, number> = {
  [SkillInstallErrorCode.TARGET_UNSAFE]: 400,
  [SkillInstallErrorCode.ANCESTOR_UNSAFE]: 409,
  [SkillInstallErrorCode.DESTINATION_EXISTS]: 409,
  [SkillInstallErrorCode.DESTINATION_UNMANAGED]: 409,
  [SkillInstallErrorCode.CROSS_DEVICE]: 500,
  [SkillInstallErrorCode.STAGING_IO]: 500,
  [SkillInstallErrorCode.PAYLOAD_MISMATCH]: 500,
  [SkillInstallErrorCode.COMMIT_FAILED]: 500,
};

/** An apply rejection. The message is built from the code — never from a path. */
export class SkillInstallError extends Error {
  constructor(
    readonly code: SkillInstallErrorCodeType,
    readonly detail?: Record<string, string | number | boolean>
  ) {
    super(`Skill install rejected: ${code}`);
    this.name = 'SkillInstallError';
  }

  get status(): number {
    return SKILL_INSTALL_ERROR_STATUS[this.code];
  }
}

export function isSkillInstallError(value: unknown): value is SkillInstallError {
  return value instanceof SkillInstallError;
}

function fail(
  code: SkillInstallErrorCodeType,
  detail?: Record<string, string | number | boolean>
): never {
  throw new SkillInstallError(code, detail);
}

// =============================================================================
// Reload guidance
// =============================================================================

/** i18n key per agent support level, so UI and CLI say the same thing (UX-01). */
export const SKILL_INSTALL_RELOAD_MESSAGE_KEYS: Record<SkillAgentSupport, string> = {
  native: 'skills.install.reload.native',
  commandmate_runtime: 'skills.install.reload.commandmateRuntime',
  unsupported: 'skills.install.reload.unsupported',
  unknown: 'skills.install.reload.unknown',
};

/** i18n key for what the user should do next, per outcome (UX-07). */
export const SKILL_INSTALL_NEXT_ACTION_KEYS = {
  succeeded: 'skills.install.nextAction.succeeded',
  committedReconciling: 'skills.install.nextAction.committedReconciling',
  failed: 'skills.install.nextAction.failed',
} as const;

/** One agent's reload instruction for the version that was just installed. */
export interface SkillReloadAgentGuidance {
  agent: string;
  support: SkillAgentSupport;
  messageKey: string;
}

/** How to start using the Skill that was just installed. */
export interface SkillReloadGuidance {
  skillId: string;
  version: string;
  installRoot: string;
  agents: SkillReloadAgentGuidance[];
}

/**
 * Derive reload guidance from the receipt.
 *
 * The receipt is used rather than the Catalog because it is the record of what
 * actually landed: guidance for a version other than the installed one would be
 * worse than none.
 */
export function buildSkillReloadGuidance(receipt: SkillInstallReceipt): SkillReloadGuidance {
  return {
    skillId: receipt.skill_id,
    version: receipt.version,
    installRoot: receipt.install_root,
    agents: receipt.agent_compatibility.map((entry) => ({
      agent: entry.agent,
      support: entry.support,
      messageKey: SKILL_INSTALL_RELOAD_MESSAGE_KEYS[entry.support],
    })),
  };
}

// =============================================================================
// Path safety
// =============================================================================

/**
 * Absolute install root for a validated Skill ID inside a server-resolved worktree.
 *
 * Delegates to #1233's resolver so plan and apply cannot disagree about where a
 * Skill lives, and re-checks the ID here as well: this module must be safe to
 * call without a plan, for instance from reconciliation.
 */
export function resolveSkillInstallTarget(worktreePath: string, skillId: string): string {
  if (!SKILL_ID_PATTERN.test(skillId) || skillId.length > SKILL_ID_MAX_LENGTH) {
    fail(SkillInstallErrorCode.TARGET_UNSAFE, { reason: 'skill-id' });
  }
  try {
    return resolveSkillInstallRoot(worktreePath, skillId);
  } catch {
    return fail(SkillInstallErrorCode.TARGET_UNSAFE, { reason: 'install-root' });
  }
}

/**
 * Prove no ancestor of the install root was swapped for a link.
 *
 * `lstat` at every level from the worktree down: a symlink anywhere on the chain
 * would let the rename publish the payload outside the registered worktree, and
 * `realpath` alone would silently *follow* it instead of refusing.
 */
function assertAncestorsAreRealDirectories(worktreeRealPath: string, worktreePath: string): void {
  let resolved: string;
  try {
    resolved = realpathSync(worktreePath);
  } catch {
    return fail(SkillInstallErrorCode.ANCESTOR_UNSAFE, { reason: 'worktree-unresolvable' });
  }
  if (resolved !== worktreeRealPath) {
    fail(SkillInstallErrorCode.ANCESTOR_UNSAFE, { reason: 'worktree-identity' });
  }

  let walked = worktreeRealPath;
  for (const segment of SKILL_INSTALL_ROOT_PREFIX.split('/')) {
    walked = path.join(walked, segment);
    let stats;
    try {
      stats = lstatSync(walked);
    } catch {
      // Not yet created is fine; it is created below with a plain mkdir.
      return;
    }
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      fail(SkillInstallErrorCode.ANCESTOR_UNSAFE, { reason: 'not-a-directory' });
    }
  }
}

// =============================================================================
// Destination inspection
// =============================================================================

/** What currently occupies the install root, if anything. */
export interface SkillDestinationState {
  present: boolean;
  /** A parseable CommandMate receipt is present, so the directory is managed. */
  managed: boolean;
  /** Version recorded by that receipt. */
  version: string | null;
}

/**
 * Describe the install root without following anything.
 *
 * A non-directory at the install root (a file, a symlink) counts as present and
 * unmanaged: it is not something an install may quietly replace.
 */
export function inspectSkillDestination(installRootAbs: string): SkillDestinationState {
  let stats;
  try {
    stats = lstatSync(installRootAbs);
  } catch {
    return { present: false, managed: false, version: null };
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    return { present: true, managed: false, version: null };
  }

  try {
    const receipt = parseInstalledReceipt(
      readFileSync(path.join(installRootAbs, SKILL_RECEIPT_FILENAME))
    );
    if (receipt) return { present: true, managed: true, version: receipt.version };
  } catch {
    // No readable receipt: the directory exists but CommandMate did not write it.
  }
  return { present: true, managed: false, version: null };
}

/**
 * Whether the payload a committed operation wrote is still on disk.
 *
 * The port #1234's reconciler needs: it decides between "converge forward" and
 * "genuinely rolled back", and only the receipt digest can distinguish the
 * install that committed from a different one that happens to share the path.
 */
export function hasCommittedSkillPayload(
  worktreePath: string,
  skillId: string,
  receiptDigest: string | null
): boolean {
  let installRootAbs: string;
  try {
    installRootAbs = resolveSkillInstallTarget(worktreePath, skillId);
  } catch {
    return false;
  }
  let bytes: Buffer;
  try {
    bytes = readFileSync(path.join(installRootAbs, SKILL_RECEIPT_FILENAME));
  } catch {
    return false;
  }
  if (parseInstalledReceipt(bytes) === null) return false;
  return receiptDigest === null || digestMatches(computeSha256Hex(bytes), receiptDigest);
}

// =============================================================================
// Staging
// =============================================================================

function makeDirectory(target: string, mode: number, recursive: boolean): void {
  try {
    mkdirSync(target, { mode, recursive });
  } catch {
    fail(SkillInstallErrorCode.STAGING_IO, { reason: 'mkdir' });
  }
  let stats;
  try {
    stats = lstatSync(target);
  } catch {
    return fail(SkillInstallErrorCode.STAGING_IO, { reason: 'mkdir-verify' });
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    fail(SkillInstallErrorCode.STAGING_IO, { reason: 'not-a-directory' });
  }
}

/**
 * Write one file and prove afterwards that it is the file we meant to write.
 *
 * `O_EXCL` means an existing path is never written to, and `O_NOFOLLOW` means a
 * symlink planted at that path is refused rather than followed — together they
 * make "the write landed somewhere else" unrepresentable. The post-write checks
 * are not belt-and-braces either: `nlink !== 1` would mean the path was
 * hard-linked elsewhere, and a digest read back through the same path is the
 * only evidence that what a later reader sees matches the plan.
 *
 * @internal Exported for the guard tests; callers use {@link applySkillInstall}.
 */
export function writeSkillPayloadFile(
  target: string,
  bytes: Uint8Array,
  executable: boolean
): void {
  const mode = executable ? SKILL_INSTALL_EXECUTABLE_MODE : SKILL_INSTALL_FILE_MODE;

  let fd: number;
  try {
    fd = openSync(
      target,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | O_NOFOLLOW,
      mode
    );
  } catch {
    return fail(SkillInstallErrorCode.STAGING_IO, { reason: 'open' });
  }
  try {
    let written = 0;
    while (written < bytes.byteLength) {
      written += writeSync(fd, bytes, written, bytes.byteLength - written);
    }
  } catch {
    closeSync(fd);
    return fail(SkillInstallErrorCode.STAGING_IO, { reason: 'write' });
  }
  closeSync(fd);

  const stats = lstatSync(target);
  if (!stats.isFile() || stats.nlink !== 1 || stats.size !== bytes.byteLength) {
    fail(SkillInstallErrorCode.STAGING_IO, { reason: 'verify-stat' });
  }
  if (((stats.mode & 0o111) !== 0) !== executable) {
    fail(SkillInstallErrorCode.STAGING_IO, { reason: 'verify-mode' });
  }
  if (!digestMatches(computeSha256Hex(readFileSync(target)), computeSha256Hex(bytes))) {
    fail(SkillInstallErrorCode.PAYLOAD_MISMATCH, { reason: 'readback' });
  }
}

/** Re-read a staged tree from disk, so verification never trusts its own inputs. */
function readStagedTree(
  stagingDir: string
): Array<{ path: string; sha256: string; executable: boolean }> {
  const files: Array<{ path: string; sha256: string; executable: boolean }> = [];

  const walk = (dirAbs: string, relPrefix: string): void => {
    for (const entry of readdirSync(dirAbs, { withFileTypes: true })) {
      const relative = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
      const absolute = path.join(dirAbs, entry.name);
      const stats = lstatSync(absolute);
      if (stats.isDirectory()) {
        walk(absolute, relative);
        continue;
      }
      if (!stats.isFile()) {
        fail(SkillInstallErrorCode.PAYLOAD_MISMATCH, { reason: 'irregular-staged-entry' });
      }
      files.push({
        path: relative,
        sha256: computeSha256Hex(readFileSync(absolute)),
        executable: (stats.mode & 0o111) !== 0,
      });
    }
  };

  walk(stagingDir, '');
  return files;
}

// =============================================================================
// Apply
// =============================================================================

/** Everything the commit needs. All of it server-resolved or plan-fixed. */
export interface SkillInstallApplyInput {
  /** Absolute path from the worktree row. Never client-supplied. */
  worktreePath: string;
  /** Symlink-free form of {@link worktreePath}, resolved before the lock was taken. */
  worktreeRealPath: string;
  skillId: string;
  /** Opaque server-generated ID; names the private staging directory. */
  operationId: string;
  /** Verified package the plan was computed from. Read, never re-downloaded. */
  snapshot: SkillPackageSnapshot;
  /** The exact receipt bytes the plan fixed. Written verbatim, not rebuilt. */
  receiptBytes: Uint8Array;
  /** Tree hash the plan committed the destination to. */
  plannedTreeHash: string;
}

/** What the commit produced. Paths are repository-relative. */
export interface SkillInstallApplyResult {
  installRoot: string;
  receiptPath: string;
  receiptSha256: string;
  receiptSize: number;
  files: SkillInstalledFile[];
  treeHash: string;
}

/**
 * Stage, verify and atomically publish one Skill install.
 *
 * Everything before the `renameSync` is undoable and is undone on any failure:
 * the staging directory is removed and the destination is untouched. Everything
 * after it is not, which is why the rename is the last thing that happens and
 * why the caller records `FS_COMMITTED` the moment this returns.
 *
 * @throws SkillInstallError — the destination was not modified in every case.
 */
export function applySkillInstall(input: SkillInstallApplyInput): SkillInstallApplyResult {
  if (!SKILL_INSTALL_OPERATION_ID_PATTERN.test(input.operationId)) {
    fail(SkillInstallErrorCode.STAGING_IO, { reason: 'operation-id' });
  }

  const installRootAbs = resolveSkillInstallTarget(input.worktreePath, input.skillId);
  assertAncestorsAreRealDirectories(input.worktreeRealPath, input.worktreePath);

  const destinationBefore = inspectSkillDestination(installRootAbs);
  if (destinationBefore.present) {
    fail(
      destinationBefore.managed
        ? SkillInstallErrorCode.DESTINATION_EXISTS
        : SkillInstallErrorCode.DESTINATION_UNMANAGED,
      destinationBefore.version ? { version: destinationBefore.version } : undefined
    );
  }

  const stagingRoot = getSkillInstallStagingRoot(input.worktreePath);
  makeDirectory(path.dirname(stagingRoot), 0o755, true);
  makeDirectory(stagingRoot, SKILL_INSTALL_DIR_MODE, true);

  // Not recursive: a staging directory that already exists means another
  // operation is using this ID, and silently adopting it would merge two writes.
  const stagingDir = path.join(stagingRoot, input.operationId);
  makeDirectory(stagingDir, SKILL_INSTALL_DIR_MODE, false);

  try {
    const directories = new Set<string>(input.snapshot.directories);
    for (const file of input.snapshot.files) {
      const parents = file.path.split('/').slice(0, -1);
      let walked = '';
      for (const segment of parents) {
        walked = walked === '' ? segment : `${walked}/${segment}`;
        directories.add(walked);
      }
    }
    for (const directory of [...directories].sort()) {
      makeDirectory(path.join(stagingDir, directory), SKILL_INSTALL_DIR_MODE, false);
    }

    for (const file of input.snapshot.files) {
      const bytes = input.snapshot.readFile(file.path);
      if (!digestMatches(computeSha256Hex(bytes), file.sha256)) {
        fail(SkillInstallErrorCode.PAYLOAD_MISMATCH, { reason: 'snapshot-digest' });
      }
      // The execute bit comes from the reconciled inventory, which is also what
      // the plan hashed — never from the archive header, which is attacker data.
      writeSkillPayloadFile(path.join(stagingDir, file.path), bytes, file.executable);
    }

    // The receipt is written last and from the plan's own bytes: rebuilding it
    // here would make the file the user previewed and the file on disk two
    // different artifacts that merely ought to agree.
    writeSkillPayloadFile(path.join(stagingDir, SKILL_RECEIPT_FILENAME), input.receiptBytes, false);

    const staged = readStagedTree(stagingDir);
    const treeHash = computeSkillTreeHash(staged);
    if (treeHash !== input.plannedTreeHash) {
      fail(SkillInstallErrorCode.PAYLOAD_MISMATCH, { reason: 'tree-hash' });
    }

    assertSameFilesystem(stagingDir, path.dirname(installRootAbs));

    // Re-checked immediately before the rename rather than only at entry: the
    // exclusive lock keeps CommandMate out, but nothing keeps the user's own
    // editor from creating this directory while the payload was being staged.
    assertAncestorsAreRealDirectories(input.worktreeRealPath, input.worktreePath);
    const destinationNow = inspectSkillDestination(installRootAbs);
    if (destinationNow.present) {
      fail(
        destinationNow.managed
          ? SkillInstallErrorCode.DESTINATION_EXISTS
          : SkillInstallErrorCode.DESTINATION_UNMANAGED
      );
    }

    try {
      renameSync(stagingDir, installRootAbs);
    } catch {
      fail(SkillInstallErrorCode.COMMIT_FAILED, { reason: 'rename' });
    }
  } catch (error) {
    rmSync(stagingDir, { recursive: true, force: true });
    pruneStagingRoot(stagingRoot);
    throw error;
  }

  pruneStagingRoot(stagingRoot);

  const installRootRel = skillInstallRoot(input.skillId);
  const receiptSha256 = computeSha256Hex(input.receiptBytes);
  return {
    installRoot: installRootRel,
    receiptPath: `${installRootRel}/${SKILL_RECEIPT_FILENAME}`,
    receiptSha256,
    receiptSize: input.receiptBytes.byteLength,
    files: input.snapshot.files.map((file) => ({
      path: file.path,
      sha256: file.sha256,
      size: file.size,
      executable: file.executable,
    })),
    treeHash: input.plannedTreeHash,
  };
}

/**
 * Refuse to commit across a filesystem boundary.
 *
 * `rename(2)` is only atomic within one filesystem; across one it fails with
 * EXDEV, and a caller that "helpfully" fell back to copy+delete would give up
 * the single property the whole design rests on. Staging is placed inside the
 * destination's own parent so this holds by construction — the check is here so
 * a future change that moves staging elsewhere fails loudly.
 */
function assertSameFilesystem(stagingDir: string, destinationParent: string): void {
  let stagingDev: number;
  let destinationDev: number;
  try {
    stagingDev = lstatSync(stagingDir).dev;
    destinationDev = lstatSync(destinationParent).dev;
  } catch {
    return fail(SkillInstallErrorCode.STAGING_IO, { reason: 'stat-device' });
  }
  if (stagingDev !== destinationDev) {
    fail(SkillInstallErrorCode.CROSS_DEVICE);
  }
}

/** Remove the staging root once it is empty, so it does not linger in a worktree. */
function pruneStagingRoot(stagingRoot: string): void {
  try {
    rmdirSync(stagingRoot);
  } catch {
    // Still in use by a concurrent operation, or already gone.
  }
}

/**
 * Drop staging directories left behind by a crashed process.
 *
 * Only entries whose name matches the operation-ID grammar are removed, so
 * pointing this at a directory holding anything else cannot destroy content.
 *
 * @returns Number of staging directories removed
 */
export function cleanupSkillInstallStaging(worktreePath: string): number {
  const stagingRoot = getSkillInstallStagingRoot(worktreePath);
  let entries: string[];
  try {
    entries = readdirSync(stagingRoot);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const entry of entries) {
    if (!SKILL_INSTALL_OPERATION_ID_PATTERN.test(entry)) continue;
    rmSync(path.join(stagingRoot, entry), { recursive: true, force: true });
    removed += 1;
  }
  pruneStagingRoot(stagingRoot);
  return removed;
}
