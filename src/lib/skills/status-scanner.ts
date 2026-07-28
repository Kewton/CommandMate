/**
 * Cross-worktree applied-state scan (Issue #1248)
 *
 * Answers "what is actually installed where, and does it still match what was
 * installed" for every registered worktree at once. The index (#1235) says what
 * *should* be there; the receipt and payload on disk say what *is*. This module
 * compares the two and names the difference.
 *
 * **Every recorded root is scanned, not just the primary.** Since #1460 a
 * package is placed into `.agents/skills/<id>` *and* `.claude/skills/<id>`, and
 * the receipt records the set in `install_roots`. A scan that looked only at the
 * primary root would report a healthy install while the Claude-side copy was
 * deleted or edited — the exact drift this screen exists to surface. The roots
 * come from the receipt/index record, so a pre-#1460 single-root install is read
 * as the one root it names and is not reported as half-missing.
 *
 * **Two directions of drift.** An indexed Skill whose payload is gone or edited
 * is `missing`/`modified`; a payload sitting under an install root with no index
 * row is `unmanaged`. The second is what a rebuilt or deleted database looks
 * like, and it is the cue to re-index rather than to re-install.
 *
 * **Bounds, not a worker pool.** The underlying walk ({@link readExistingSkillTree})
 * is synchronous filesystem I/O, so dispatching it through a promise pool would
 * add scheduling without adding parallelism. What actually protects the server
 * is a hard ceiling on how much one scan reads, an event-loop yield between
 * worktrees so a large scan cannot starve request handling, and a short TTL
 * cache so a dashboard refresh does not re-walk the disk. Whatever the bounds
 * cut off is reported in {@link SkillStatusScanResult.truncated}, never dropped
 * silently.
 *
 * @module lib/skills/status-scanner
 */

import { existsSync, readdirSync } from 'fs';
import path from 'path';
import type Database from 'better-sqlite3';
import { getWorktrees } from '@/lib/db/worktree-db';
import {
  SKILL_ID_MAX_LENGTH,
  SKILL_ID_PATTERN,
  SKILL_INSTALL_ROOT_PREFIXES,
} from '@/lib/skills/constants';
import { listSkillInstallations } from '@/lib/skills/installed-state';
import type { SkillInstallationRecord } from '@/lib/skills/installed-state';
import { resolveSkillInstallRootFor, skillInstallRootFor } from '@/lib/skills/preview-diff';
import { SkillUninstallReason, assessSkillUninstall } from '@/lib/skills/uninstall-plan';
import { compareSemVer } from '@/lib/skills/semver';
import type { SkillRiskLevel } from '@/types/skills';

// =============================================================================
// Bounds
// =============================================================================

/** Worktrees read by one scan. Beyond this the result is marked truncated. */
export const SKILL_STATUS_SCAN_MAX_WORKTREES = 200;

/** Skill directories read per worktree, counting indexed and unmanaged alike. */
export const SKILL_STATUS_SCAN_MAX_SKILLS_PER_WORKTREE = 100;

/** How long a scan result is served before the disk is walked again. */
export const SKILL_STATUS_CACHE_TTL_MS = 5_000;

// =============================================================================
// Vocabulary
// =============================================================================

/**
 * Applied state of one Skill in one worktree.
 *
 * `update_available` is only reachable from an otherwise clean install: a
 * drifting payload is a problem to resolve before a version is the story.
 */
export type SkillInstallationStatus =
  | 'installed'
  | 'modified'
  | 'missing'
  | 'unmanaged'
  | 'update_available';

/** What one install root looks like on disk right now. */
export interface SkillInstallRootStatus {
  /** Repository-relative root, e.g. `.agents/skills/demo-skill`. */
  root: string;
  /** Prefix the root lives under, e.g. `.agents/skills`. */
  rootPrefix: string;
  present: boolean;
  /** Digest of the receipt bytes found here; null when there is no readable receipt. */
  receiptSha256: string | null;
  /** Version the receipt at this root names, or null. */
  version: string | null;
  /** Recorded files whose bytes or mode changed. */
  modifiedFiles: number;
  /** Recorded files that are no longer on disk. */
  missingFiles: number;
  /** Files present under the root that no receipt accounts for. */
  unmanagedFiles: number;
  /** Symlinks and other non-regular entries, which are never followed. */
  irregularPaths: number;
  /** The walk hit a scan bound, so the counts above are a lower bound. */
  truncated: boolean;
}

/** One Skill in one worktree, as the dashboard shows it. */
export interface SkillInstallationStatusEntry {
  worktreeId: string;
  worktreeName: string;
  repositoryName: string;
  skillId: string;
  /** Indexed version, or the receipt's version for an unmanaged install. */
  version: string | null;
  status: SkillInstallationStatus;
  /** Newest catalog version, when a catalog was supplied. */
  latestVersion: string | null;
  installRoots: SkillInstallRootStatus[];
  effectiveRisk: SkillRiskLevel | null;
  source: { repository: string; ref: string; commit: string } | null;
  artifactSha256: string | null;
  /** Epoch millis, from the index; null for an unmanaged install. */
  installedAt: number | null;
  updatedAt: number | null;
}

/** Result of one cross-worktree scan. */
export interface SkillStatusScanResult {
  scannedAt: number;
  /** Worktrees actually read. */
  worktreeCount: number;
  entries: SkillInstallationStatusEntry[];
  /** Registered worktrees whose directory is gone, so nothing could be assessed. */
  unreadableWorktreeIds: string[];
  /** A scan bound stopped the walk, so entries are incomplete. */
  truncated: boolean;
}

/** Inputs that change what a scan reports. */
export interface SkillStatusScanOptions {
  /** Newest catalog version per Skill ID. Omit to skip update detection. */
  latestVersions?: ReadonlyMap<string, string>;
  /** Read the disk even if a cached scan is still fresh. */
  refresh?: boolean;
  /** Injected clock, for tests. */
  now?: number;
}

// =============================================================================
// Discovery
// =============================================================================

function isScannableSkillId(name: string): boolean {
  return name.length <= SKILL_ID_MAX_LENGTH && SKILL_ID_PATTERN.test(name);
}

/**
 * Skill directory names sitting under one install root prefix.
 *
 * `SKILL_ID_PATTERN` excludes every dot-prefixed name, so the reserved
 * `.commandmate-staging` directory is filtered out by the same rule that
 * validates an ID rather than by a special case that could drift from it.
 */
function listSkillDirectories(worktreePath: string, rootPrefix: string): string[] | null {
  try {
    return readdirSync(path.join(worktreePath, rootPrefix), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && isScannableSkillId(entry.name))
      .map((entry) => entry.name);
  } catch {
    // A worktree with no Skills has no such directory; that is not an error.
    return null;
  }
}

// =============================================================================
// Assessment
// =============================================================================

/**
 * Read one install root.
 *
 * The absolute path goes through {@link resolveSkillInstallRootFor} rather than
 * a plain join: the prefix here comes out of a database row, and that resolver
 * is what rejects a recorded root which would walk outside the worktree. A root
 * that fails the check is reported absent instead of read — fail closed, and
 * without taking the rest of the scan down with it.
 */
function scanRoot(
  worktreePath: string,
  rootPrefix: string,
  skillId: string
): SkillInstallRootStatus {
  const root = skillInstallRootFor(rootPrefix, skillId);
  const absent: SkillInstallRootStatus = {
    root,
    rootPrefix,
    present: false,
    receiptSha256: null,
    version: null,
    modifiedFiles: 0,
    missingFiles: 0,
    unmanagedFiles: 0,
    irregularPaths: 0,
    truncated: false,
  };

  let rootAbs: string;
  try {
    rootAbs = resolveSkillInstallRootFor(worktreePath, rootPrefix, skillId);
  } catch {
    return absent;
  }

  const assessment = assessSkillUninstall(rootAbs, skillId, { rootPrefix });
  return {
    ...absent,
    present: assessment.present,
    receiptSha256: assessment.receiptDigest,
    version: assessment.receipt?.version ?? null,
    modifiedFiles: assessment.stats.modified,
    missingFiles: assessment.stats.missing,
    // A root whose receipt is missing, unreadable or written for another Skill
    // has no trusted ownership record, so every file there counts as unmanaged.
    unmanagedFiles: assessment.stats.unknown,
    irregularPaths: assessment.stats.irregular,
    truncated: assessment.blockers.some(
      (blocker) => blocker.code === SkillUninstallReason.TREE_SCAN_TRUNCATED
    ),
  };
}

function rootHasDrift(root: SkillInstallRootStatus): boolean {
  return (
    root.modifiedFiles > 0 ||
    root.missingFiles > 0 ||
    root.unmanagedFiles > 0 ||
    root.irregularPaths > 0
  );
}

/**
 * Fold per-root findings into the one status the dashboard shows.
 *
 * Order matters and is severity-first: a root that is gone outranks a root that
 * changed, and both outrank "a newer version exists". Reporting an available
 * update on a broken install would put the least useful action first.
 */
function aggregateStatus(
  roots: readonly SkillInstallRootStatus[],
  version: string | null,
  latestVersion: string | null
): SkillInstallationStatus {
  if (roots.some((root) => !root.present)) return 'missing';
  if (roots.some(rootHasDrift)) return 'modified';

  if (version !== null && latestVersion !== null) {
    const order = compareSemVer(latestVersion, version);
    if (order !== null && order > 0) return 'update_available';
  }
  return 'installed';
}

function indexedEntry(
  worktree: { id: string; name: string; repositoryName: string; path: string },
  record: SkillInstallationRecord,
  latestVersions: ReadonlyMap<string, string> | undefined
): SkillInstallationStatusEntry {
  // The receipt's root set is authoritative — never the current default set —
  // so an install written before a root was added is not read as half-missing.
  const roots = record.installRoots.map((root) =>
    scanRoot(worktree.path, path.dirname(root), record.skillId)
  );
  const latestVersion = latestVersions?.get(record.skillId) ?? null;

  return {
    worktreeId: worktree.id,
    worktreeName: worktree.name,
    repositoryName: worktree.repositoryName,
    skillId: record.skillId,
    version: record.version,
    status: aggregateStatus(roots, record.version, latestVersion),
    latestVersion,
    installRoots: roots,
    effectiveRisk: record.effectiveRisk,
    source: {
      repository: record.sourceRepository,
      ref: record.sourceRef,
      commit: record.sourceCommit,
    },
    artifactSha256: record.artifactSha256,
    installedAt: record.installedAt,
    updatedAt: record.updatedAt,
  };
}

function unmanagedEntry(
  worktree: { id: string; name: string; repositoryName: string; path: string },
  skillId: string,
  rootPrefixes: readonly string[],
  latestVersions: ReadonlyMap<string, string> | undefined
): SkillInstallationStatusEntry {
  const roots = rootPrefixes.map((prefix) => scanRoot(worktree.path, prefix, skillId));
  const version = roots.find((root) => root.version !== null)?.version ?? null;

  return {
    worktreeId: worktree.id,
    worktreeName: worktree.name,
    repositoryName: worktree.repositoryName,
    skillId,
    version,
    status: 'unmanaged',
    latestVersion: latestVersions?.get(skillId) ?? null,
    installRoots: roots,
    effectiveRisk: null,
    source: null,
    artifactSha256: null,
    installedAt: null,
    updatedAt: null,
  };
}

// =============================================================================
// Scan
// =============================================================================

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

async function runScan(
  db: Database.Database,
  options: SkillStatusScanOptions
): Promise<SkillStatusScanResult> {
  const worktrees = getWorktrees(db);
  const scanned = worktrees.slice(0, SKILL_STATUS_SCAN_MAX_WORKTREES);
  let truncated = scanned.length < worktrees.length;

  const entries: SkillInstallationStatusEntry[] = [];
  const unreadableWorktreeIds: string[] = [];

  for (const worktree of scanned) {
    await yieldToEventLoop();

    // A registered worktree whose directory is gone says nothing about its
    // Skills. Reporting every indexed row as `missing` would blame the Skills
    // for the worktree's absence, so the worktree is named instead.
    if (!existsSync(worktree.path)) {
      unreadableWorktreeIds.push(worktree.id);
      continue;
    }

    const indexed = listSkillInstallations(db, worktree.id);
    const indexedIds = new Set(indexed.map((record) => record.skillId));

    const onDisk = new Map<string, string[]>();
    for (const prefix of SKILL_INSTALL_ROOT_PREFIXES) {
      const names = listSkillDirectories(worktree.path, prefix);
      if (names === null) continue;
      for (const name of names) {
        if (indexedIds.has(name)) continue;
        onDisk.set(name, [...(onDisk.get(name) ?? []), prefix]);
      }
    }

    let budget = SKILL_STATUS_SCAN_MAX_SKILLS_PER_WORKTREE;
    for (const record of indexed) {
      if (budget === 0) {
        truncated = true;
        break;
      }
      budget -= 1;
      entries.push(indexedEntry(worktree, record, options.latestVersions));
    }
    for (const [skillId, prefixes] of [...onDisk].sort(([a], [b]) => (a < b ? -1 : 1))) {
      if (budget === 0) {
        truncated = true;
        break;
      }
      budget -= 1;
      entries.push(unmanagedEntry(worktree, skillId, prefixes, options.latestVersions));
    }
  }

  return {
    scannedAt: options.now ?? Date.now(),
    worktreeCount: scanned.length,
    entries,
    unreadableWorktreeIds,
    truncated,
  };
}

// =============================================================================
// Cache
// =============================================================================

let cached: { result: SkillStatusScanResult; expiresAt: number } | null = null;
let inFlight: Promise<SkillStatusScanResult> | null = null;

/**
 * Drop the cached scan.
 *
 * Called after anything that changes applied state — an install, an uninstall,
 * a re-index — so the next read reflects it instead of waiting out the TTL.
 */
export function invalidateSkillStatusScanCache(): void {
  cached = null;
}

/**
 * Applied state of every registered worktree.
 *
 * Served from a short-lived cache; concurrent callers share one walk rather than
 * each starting their own, so a dashboard that mounts several panels at once
 * reads the disk once.
 */
export async function scanSkillInstallationStatus(
  db: Database.Database,
  options: SkillStatusScanOptions = {}
): Promise<SkillStatusScanResult> {
  const now = options.now ?? Date.now();
  if (!options.refresh && cached !== null && cached.expiresAt > now) {
    return cached.result;
  }
  if (inFlight !== null) return inFlight;

  inFlight = runScan(db, options)
    .then((result) => {
      cached = { result, expiresAt: (options.now ?? Date.now()) + SKILL_STATUS_CACHE_TTL_MS };
      return result;
    })
    .finally(() => {
      inFlight = null;
    });

  return inFlight;
}
