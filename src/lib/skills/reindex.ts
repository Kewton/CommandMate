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
 * {@link restoreSkillInstallationIndex} is the per-worktree, converge-only entry
 * a read can afford to take: it converges one worktree's rows onto the receipts
 * and prunes nothing, which is what turns the list route into a read-through
 * cache instead of a reader that mistakes an empty cache for an empty worktree.
 *
 * **A read converges, it does not prune** (#1753). #1709 restored only the rows
 * that were *missing*, on the reasoning that converging a row disk disagrees
 * with is the explicit rebuild's job. That left a row that exists but is stale
 * unfixable by anything a user can reach: the list route served the old version,
 * the update route read the receipt, and the two answers disagreed inside one
 * server until someone found the rebuild endpoint. Writing a row that was
 * already right is what #1709 wanted to avoid, and that is still avoided —
 * a row is rewritten only when the receipt bytes disagree with the digest the
 * row itself recorded. What is *not* extended to a read is pruning: dropping a
 * row hides drift, correcting a version does not.
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
  /** The bytes on disk hash to what the index row already recorded. */
  | { kind: 'current' }
  | { kind: 'skipped'; reason: SkillReindexSkipReasonCode; root: string };

/**
 * Read one receipt and decide whether the index needs to hear about it.
 *
 * `indexedDigest` is the digest the index row already holds for this Skill, or
 * null when there is no row or the caller wants every row rewritten. When the
 * bytes hash to it, the row is provably a copy of this receipt: there is nothing
 * to parse and nothing to write. That digest is what makes a converging read
 * affordable (#1753) — the whole receipt is compared, so drift in the version,
 * the source commit, the artifact digest or the root set (#1460) is all caught
 * by the one check, and a row that matches costs a read and a hash, never a
 * parse and never a write.
 */
function readReceiptAt(
  worktreePath: string,
  rootPrefix: string,
  skillId: string,
  indexedDigest: string | null
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

  const receiptSha256 = computeSha256Hex(bytes);
  if (indexedDigest !== null && indexedDigest === receiptSha256) return { kind: 'current' };

  const receipt = parseInstalledReceipt(bytes);
  if (receipt === null) {
    return { kind: 'skipped', reason: SkillReindexSkipReason.RECEIPT_UNREADABLE, root };
  }
  if (receipt.skill_id !== skillId) {
    return { kind: 'skipped', reason: SkillReindexSkipReason.RECEIPT_FOREIGN, root };
  }

  return { kind: 'found', found: { skillId, root, receipt, receiptSha256 } };
}

/** What one walk of a worktree's install roots saw. */
interface CollectedReceipts {
  /** Receipts the index has to be told about: a gap, or bytes that disagree. */
  found: FoundReceipt[];
  /** Skill IDs whose receipt hashes to what the index row already holds. */
  current: string[];
  skips: SkillReindexSkip[];
}

/**
 * Collect one receipt per Skill in a worktree, preferring the primary root.
 *
 * A Skill present in several roots is one install: the first readable receipt in
 * root-prefix order is the one indexed, and the roots it is considered to occupy
 * come from that receipt, not from where the walk happened to find directories.
 * A Skill settled by an earlier root — indexed *or* confirmed current — is not
 * opened again in a later one.
 *
 * `indexedDigests` maps Skill ID to the receipt digest the index already holds.
 * Pass it to short-circuit the rows that agree with disk; pass null to rewrite
 * every row from its receipt, which is what the explicit rebuild means by
 * rebuild.
 */
function collectReceipts(
  worktreePath: string,
  indexedDigests: ReadonlyMap<string, string> | null
): CollectedReceipts {
  const found = new Map<string, FoundReceipt>();
  const current = new Set<string>();
  const pendingSkips = new Map<string, SkillReindexSkip>();

  for (const rootPrefix of SKILL_INSTALL_ROOT_PREFIXES) {
    for (const skillId of listSkillDirectories(worktreePath, rootPrefix)) {
      if (found.has(skillId) || current.has(skillId)) continue;
      const outcome = readReceiptAt(
        worktreePath,
        rootPrefix,
        skillId,
        indexedDigests?.get(skillId) ?? null
      );
      if (outcome === null) continue;
      if (outcome.kind === 'found') {
        found.set(skillId, outcome.found);
        pendingSkips.delete(skillId);
        continue;
      }
      if (outcome.kind === 'current') {
        current.add(skillId);
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
    current: [...current].sort(),
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
  /** Of {@link indexed}, rows that existed and disagreed with their receipt. */
  converged: number;
  removed: number;
  skipped: SkillReindexSkip[];
}

/**
 * Index one worktree from the receipts on its disk.
 *
 * The caller has already established that the worktree directory exists, because
 * an absent directory means something different to each caller.
 *
 * `converge` says which rows are rewritten. `every-row` is the explicit
 * rebuild: every receipt is parsed and written, because a rebuild that trusted
 * the digest in a table it is rebuilding would be reading its own answer back.
 * `drift-only` is what a read takes (#1753): the receipt is still opened and
 * hashed, but a row whose digest matches costs nothing further — no parse, no
 * write, no re-dating. What it is *not* is #1709's gaps-only, which never
 * opened the receipt and so could not tell a correct row from a stale one.
 *
 * `prune` is what makes this a *rebuild* rather than a repair. Only the explicit
 * whole-index operation drops rows: a read must not delete an index row because
 * the payload happens to be absent right now — that state is the `missing` the
 * dashboard exists to show, and silently deleting it would hide the drift.
 * Correcting a row is the opposite: it hides nothing.
 */
function indexWorktreeFromReceipts(
  db: Database.Database,
  worktree: SkillReindexWorktree,
  now: number,
  options: { converge: 'every-row' | 'drift-only'; prune: boolean }
): WorktreeIndexPass {
  const rowsBefore = listSkillInstallations(db, worktree.id);
  const rowBySkillId = new Map(rowsBefore.map((row) => [row.skillId, row]));

  const { found, current, skips } = collectReceipts(
    worktree.path,
    options.converge === 'drift-only'
      ? new Map(rowsBefore.map((row) => [row.skillId, row.receiptSha256]))
      : null
  );

  let converged = 0;
  for (const entry of found) {
    const prior = rowBySkillId.get(entry.skillId);
    const drifted = prior !== undefined && prior.receiptSha256 !== entry.receiptSha256;
    if (drifted) converged += 1;
    // `installed_at` is preserved by the upsert, so passing the current time
    // dates the convergence without rewriting when the install first landed.
    upsertSkillInstallation(db, {
      worktreeId: worktree.id,
      receipt: entry.receipt,
      receiptSha256: entry.receiptSha256,
      // Bytes the recorded operation did not write are not that operation's
      // claim any more, so a drifted row is re-attributed to the reindex for the
      // same reason a rebuilt row is: nobody can back the old provenance up.
      operationId: prior && !drifted ? prior.operationId : SKILL_REINDEX_OPERATION_ID,
      installedAt: now,
    });
  }

  let removed = 0;
  if (options.prune) {
    const backedBySkillId = new Set([...found.map((entry) => entry.skillId), ...current]);
    for (const row of rowsBefore) {
      if (backedBySkillId.has(row.skillId)) continue;
      if (deleteSkillInstallation(db, worktree.id, row.skillId)) removed += 1;
    }
  }

  return {
    indexed: found.length,
    converged,
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
    const pass = indexWorktreeFromReceipts(db, worktree, now, {
      converge: 'every-row',
      prune: true,
    });
    result.indexed += pass.indexed;
    result.removed += pass.removed;
    result.skipped.push(...pass.skipped);
  }

  return result;
}

/** What one read-through restore did (#1709, #1753). */
export interface SkillIndexRestoreResult {
  /** Rows written from a receipt: the ones missing plus the ones that drifted. */
  indexed: number;
  /** Of {@link indexed}, rows that existed and disagreed with their receipt. */
  converged: number;
  /** Directories that looked like an install but carried no usable receipt. */
  skipped: SkillReindexSkip[];
}

/**
 * Converge one worktree's index rows onto the receipts on its disk.
 *
 * The read side of the same claim {@link reindexSkillInstallations} makes: the
 * receipt is the truth and `skill_installations` is a cache over it. The cache
 * is per-database, the receipt is inside the worktree and repository-relative,
 * so a Skill installed by another instance — or by this one before its database
 * was replaced — is present on disk with no row behind it. Reading the index as
 * if it were the truth reports that as "not installed" (#1709); reading through
 * to the receipt reports it as what it is.
 *
 * The same argument applies to a row that is present but stale, which is why
 * since #1753 this converges as well as restores. A read that inserts what is
 * missing but refuses to correct what is wrong is not a read-through cache; it
 * is a cache that answers one thing while the update route, reading the same
 * receipt, answers another.
 *
 * Restore-only, and deliberately so:
 *
 * - **Nothing is ever deleted.** A row whose payload is gone is drift to report,
 *   not a row for a list request to destroy.
 * - **Only disagreements are written.** The receipt is hashed and compared with
 *   the digest the row recorded; a row that matches is not parsed, not written
 *   and not re-dated, so a read still never touches a row that was correct.
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
  if (!existsSync(worktree.path)) return { indexed: 0, converged: 0, skipped: [] };

  const pass = indexWorktreeFromReceipts(db, worktree, options.now ?? Date.now(), {
    converge: 'drift-only',
    prune: false,
  });
  return { indexed: pass.indexed, converged: pass.converged, skipped: pass.skipped };
}
