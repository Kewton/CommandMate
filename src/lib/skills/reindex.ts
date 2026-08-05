/**
 * Rebuild the installed-Skill index from receipts (Issue #1248)
 *
 * The index (#1235) is a cache over what the receipts already say, and this is
 * the operation that makes that claim true: delete the database, run this, and
 * the index is back — including the multi-root set, because the receipt records
 * it in `install_roots` (#1460).
 *
 * The receipt is read from disk, never reconstructed from the row it is meant to
 * rebuild, so a corrupted or hand-edited table cannot launder itself into
 * evidence. A directory whose receipt is missing, unparseable or written for a
 * different Skill is left alone and reported: it is exactly the `unmanaged`
 * state the dashboard shows, and quietly indexing it would assert a provenance
 * nobody can back up.
 *
 * **The primary root wins.** A package placed into both `.agents/skills` and
 * `.claude/skills` is one install with one index row. Roots are visited in
 * {@link SKILL_INSTALL_ROOT_PREFIXES} order, so the primary receipt is the one
 * that is read; a secondary-only copy is still indexed, because a crash between
 * the two renames leaves precisely that, and refusing to index it would hide a
 * real install.
 *
 * Re-indexing never writes to the payload and never touches the append-only
 * operation log: it restores an index, it does not perform an operation.
 *
 * Two entry points, same evidence. {@link reindexSkillInstallations} is the
 * explicit whole-registry repair the dashboard and CLI expose. Since #1709
 * {@link restoreSkillInstallationIndex} is the per-worktree, restore-only entry
 * a read can afford to take: it fills the gaps of one worktree and prunes
 * nothing, which is what turns the list route into a read-through cache instead
 * of a reader that mistakes an empty cache for an empty worktree.
 *
 * @module lib/skills/reindex
 */

import { existsSync, readFileSync, readdirSync } from 'fs';
import path from 'path';
import type Database from 'better-sqlite3';
import { getWorktrees } from '@/lib/db/worktree-db';
import {
  SKILL_ID_MAX_LENGTH,
  SKILL_ID_PATTERN,
  SKILL_INSTALL_ROOT_PREFIXES,
} from '@/lib/skills/constants';
import { SKILL_RECEIPT_FILENAME, parseInstalledReceipt } from '@/lib/skills/install-plan';
import { computeSha256Hex } from '@/lib/skills/integrity';
import {
  deleteSkillInstallation,
  getSkillInstallation,
  listSkillInstallations,
  upsertSkillInstallation,
} from '@/lib/skills/installed-state';
import { resolveSkillInstallRootFor } from '@/lib/skills/preview-diff';
import type { SkillInstallReceipt } from '@/types/skills';

/**
 * Provenance recorded for a row whose originating operation is unknown.
 *
 * A rebuilt row genuinely has no operation behind it — the operation that
 * created the install happened before the database was lost. Naming that
 * explicitly is more honest than minting a UUID that looks like a real
 * operation ID and resolves to nothing in the audit log.
 */
export const SKILL_REINDEX_OPERATION_ID = 'reindex';

/** Why one Skill directory was not indexed. */
export const SkillReindexSkipReason = {
  RECEIPT_MISSING: 'SKILL_REINDEX_RECEIPT_MISSING',
  RECEIPT_UNREADABLE: 'SKILL_REINDEX_RECEIPT_UNREADABLE',
  RECEIPT_FOREIGN: 'SKILL_REINDEX_RECEIPT_FOREIGN',
} as const;

export type SkillReindexSkipReasonCode =
  (typeof SkillReindexSkipReason)[keyof typeof SkillReindexSkipReason];

/** One directory that looked like an install but could not be indexed. */
export interface SkillReindexSkip {
  worktreeId: string;
  skillId: string;
  /** Repository-relative root the directory was found at. */
  root: string;
  reason: SkillReindexSkipReasonCode;
}

/** What one rebuild did. */
export interface SkillReindexResult {
  scannedWorktrees: number;
  /** Rows written from a receipt, whether new or converged. */
  indexed: number;
  /** Rows dropped because no receipt backs them any more. */
  removed: number;
  skipped: SkillReindexSkip[];
  /** Registered worktrees whose directory is gone; their rows were left untouched. */
  unreadableWorktreeIds: string[];
}

interface FoundReceipt {
  skillId: string;
  root: string;
  receipt: SkillInstallReceipt;
  receiptSha256: string;
}

function isScannableSkillId(name: string): boolean {
  return name.length <= SKILL_ID_MAX_LENGTH && SKILL_ID_PATTERN.test(name);
}

function listSkillDirectories(worktreePath: string, rootPrefix: string): string[] {
  try {
    return readdirSync(path.join(worktreePath, rootPrefix), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && isScannableSkillId(entry.name))
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

type ReadOutcome =
  | { kind: 'found'; found: FoundReceipt }
  | { kind: 'skipped'; reason: SkillReindexSkipReasonCode; root: string };

function readReceiptAt(
  worktreePath: string,
  rootPrefix: string,
  skillId: string
): ReadOutcome | null {
  const root = `${rootPrefix}/${skillId}`;
  let rootAbs: string;
  try {
    rootAbs = resolveSkillInstallRootFor(worktreePath, rootPrefix, skillId);
  } catch {
    return null;
  }

  let bytes: Buffer;
  try {
    bytes = readFileSync(path.join(rootAbs, SKILL_RECEIPT_FILENAME));
  } catch {
    return { kind: 'skipped', reason: SkillReindexSkipReason.RECEIPT_MISSING, root };
  }

  const receipt = parseInstalledReceipt(bytes);
  if (receipt === null) {
    return { kind: 'skipped', reason: SkillReindexSkipReason.RECEIPT_UNREADABLE, root };
  }
  if (receipt.skill_id !== skillId) {
    return { kind: 'skipped', reason: SkillReindexSkipReason.RECEIPT_FOREIGN, root };
  }

  return {
    kind: 'found',
    found: { skillId, root, receipt, receiptSha256: computeSha256Hex(bytes) },
  };
}

/**
 * Collect one receipt per Skill in a worktree, preferring the primary root.
 *
 * A Skill present in several roots is one install: the first readable receipt in
 * root-prefix order is the one indexed, and the roots it is considered to occupy
 * come from that receipt, not from where the walk happened to find directories.
 *
 * `accept` narrows the walk before any receipt is opened, so the read-through
 * restore (#1709) pays for a directory listing but reads no receipt for a Skill
 * the index already has.
 */
function collectReceipts(
  worktreePath: string,
  accept: (skillId: string) => boolean = () => true
): { found: FoundReceipt[]; skips: SkillReindexSkip[] } {
  const found = new Map<string, FoundReceipt>();
  const pendingSkips = new Map<string, SkillReindexSkip>();

  for (const rootPrefix of SKILL_INSTALL_ROOT_PREFIXES) {
    for (const skillId of listSkillDirectories(worktreePath, rootPrefix)) {
      if (found.has(skillId) || !accept(skillId)) continue;
      const outcome = readReceiptAt(worktreePath, rootPrefix, skillId);
      if (outcome === null) continue;
      if (outcome.kind === 'found') {
        found.set(skillId, outcome.found);
        pendingSkips.delete(skillId);
        continue;
      }
      // Keep only the first reason per Skill: a secondary root that also failed
      // adds no information once the primary root has already been reported.
      if (!pendingSkips.has(skillId)) {
        pendingSkips.set(skillId, {
          worktreeId: '',
          skillId,
          root: outcome.root,
          reason: outcome.reason,
        });
      }
    }
  }

  return {
    found: [...found.values()].sort((a, b) => (a.skillId < b.skillId ? -1 : 1)),
    skips: [...pendingSkips.values()].sort((a, b) => (a.skillId < b.skillId ? -1 : 1)),
  };
}

/** A worktree as re-indexing needs to see it: an ID to key rows by, a path to read. */
export interface SkillReindexWorktree {
  id: string;
  path: string;
}

/** What one worktree pass did. */
interface WorktreeIndexPass {
  indexed: number;
  removed: number;
  skipped: SkillReindexSkip[];
}

/**
 * Index one worktree from the receipts on its disk.
 *
 * The caller has already established that the worktree directory exists, because
 * an absent directory means something different to each caller.
 *
 * `gapsOnly` skips Skills the index already has: the full rebuild wants every
 * row converged onto what disk says, while a read-through restore (#1709) only
 * wants the rows that are missing, so that answering a list request never
 * rewrites a row that was already correct.
 *
 * `prune` is what makes this a *rebuild* rather than a repair. Only the explicit
 * whole-index operation drops rows: a read must not delete an index row because
 * the payload happens to be absent right now — that state is the `missing` the
 * dashboard exists to show, and silently deleting it would hide the drift.
 */
function indexWorktreeFromReceipts(
  db: Database.Database,
  worktree: SkillReindexWorktree,
  now: number,
  options: { gapsOnly: boolean; prune: boolean }
): WorktreeIndexPass {
  const indexedBefore = listSkillInstallations(db, worktree.id).map((row) => row.skillId);
  const indexedIds = new Set(indexedBefore);

  const { found, skips } = collectReceipts(
    worktree.path,
    options.gapsOnly ? (skillId) => !indexedIds.has(skillId) : undefined
  );

  for (const entry of found) {
    // `installed_at` is preserved by the upsert, so passing the current time
    // dates the convergence without rewriting when the install first landed.
    const prior = getSkillInstallation(db, worktree.id, entry.skillId);
    upsertSkillInstallation(db, {
      worktreeId: worktree.id,
      receipt: entry.receipt,
      receiptSha256: entry.receiptSha256,
      operationId: prior?.operationId ?? SKILL_REINDEX_OPERATION_ID,
      installedAt: now,
    });
  }

  let removed = 0;
  if (options.prune) {
    const backedBySkillId = new Set(found.map((entry) => entry.skillId));
    for (const skillId of indexedBefore) {
      if (backedBySkillId.has(skillId)) continue;
      if (deleteSkillInstallation(db, worktree.id, skillId)) removed += 1;
    }
  }

  return {
    indexed: found.length,
    removed,
    skipped: skips.map((skip) => ({ ...skip, worktreeId: worktree.id })),
  };
}

/**
 * Rebuild `skill_installations` for every registered worktree from disk.
 *
 * Idempotent, and safe to run against a populated index: `upsertSkillInstallation`
 * preserves `installed_at`, so a rebuild does not rewrite when an install first
 * landed. Rows whose receipt has disappeared are removed, because an index entry
 * with no evidence behind it is the stale claim this operation exists to clear.
 */
export function reindexSkillInstallations(
  db: Database.Database,
  options: { now?: number } = {}
): SkillReindexResult {
  const now = options.now ?? Date.now();
  const worktrees = getWorktrees(db);

  const result: SkillReindexResult = {
    scannedWorktrees: 0,
    indexed: 0,
    removed: 0,
    skipped: [],
    unreadableWorktreeIds: [],
  };

  for (const worktree of worktrees) {
    // An absent worktree directory yields no receipts, which is indistinguishable
    // from "every Skill was uninstalled" — and dropping the rows on that basis
    // would destroy the index for a worktree that is merely unmounted right now.
    if (!existsSync(worktree.path)) {
      result.unreadableWorktreeIds.push(worktree.id);
      continue;
    }

    result.scannedWorktrees += 1;
    const pass = indexWorktreeFromReceipts(db, worktree, now, { gapsOnly: false, prune: true });
    result.indexed += pass.indexed;
    result.removed += pass.removed;
    result.skipped.push(...pass.skipped);
  }

  return result;
}

/** What one read-through restore did (#1709). */
export interface SkillIndexRestoreResult {
  /** Rows written from a receipt for Skills the index did not have. */
  indexed: number;
  /** Directories that looked like an install but carried no usable receipt. */
  skipped: SkillReindexSkip[];
}

/**
 * Restore the index rows one worktree is missing, from the receipts on its disk.
 *
 * The read side of the same claim {@link reindexSkillInstallations} makes: the
 * receipt is the truth and `skill_installations` is a cache over it. The cache
 * is per-database, the receipt is inside the worktree and repository-relative,
 * so a Skill installed by another instance — or by this one before its database
 * was replaced — is present on disk with no row behind it. Reading the index as
 * if it were the truth reports that as "not installed" (#1709); reading through
 * to the receipt reports it as what it is.
 *
 * Restore-only, and deliberately so:
 *
 * - **Nothing is ever deleted.** A row whose payload is gone is drift to report,
 *   not a row for a list request to destroy.
 * - **Only gaps are written.** A Skill the index already has is left untouched,
 *   so a read never rewrites `updated_at` or re-dates a row that was correct.
 * - **A directory is not evidence.** A missing, unparseable or foreign receipt
 *   is reported and skipped, exactly as the full rebuild does, because indexing
 *   it would assert a provenance nobody can back up.
 *
 * Like the full rebuild it reads receipts from disk rather than reconstructing
 * them from the table, writes nothing into the payload, and never appends to the
 * operation log.
 *
 * @param worktree - The resolved worktree: its current ID and its path on disk
 */
export function restoreSkillInstallationIndex(
  db: Database.Database,
  worktree: SkillReindexWorktree,
  options: { now?: number } = {}
): SkillIndexRestoreResult {
  // An absent directory says nothing about what is installed, so there is
  // nothing to restore from and nothing to conclude.
  if (!existsSync(worktree.path)) return { indexed: 0, skipped: [] };

  const pass = indexWorktreeFromReceipts(db, worktree, options.now ?? Date.now(), {
    gapsOnly: true,
    prune: false,
  });
  return { indexed: pass.indexed, skipped: pass.skipped };
}
