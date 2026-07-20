/**
 * Startup wiring for Skill operation crash recovery (Issue #1428)
 *
 * #1234 built {@link reconcileSkillOperations} and left the concrete ports it
 * needs — *is the payload on disk?* and *rebuild the index row* — to the layers
 * that own the filesystem and the DB (#1235/#1236). This module is the assembly
 * point those pieces were missing: it constructs the production ports and runs
 * reconciliation, and it is the single function the server startup path calls so
 * that a restart converges every interrupted install/uninstall on one answer.
 *
 * It is deliberately the *only* place the startup ports are assembled. The
 * Phase 1 gap that shipped a never-invoked reconciler happened because the tests
 * imported the library directly and never crossed the startup seam; this
 * function is what both `server.ts` and its test now go through, so a future
 * regression that unwires it fails a test rather than passing silently.
 *
 * Running here also garbage-collects the journal: terminal entries past their
 * retention window are pruned, so the journal directory tracks the operations of
 * one window rather than growing without bound.
 *
 * @module lib/skills/startup-reconcile
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import type Database from 'better-sqlite3';
import { getWorktreeById } from '@/lib/db';
import { computeSha256Hex } from '@/lib/skills/integrity';
import {
  SKILL_RECEIPT_FILENAME,
  parseInstalledReceipt,
} from '@/lib/skills/install-plan';
import {
  hasCommittedSkillPayload,
  resolveSkillInstallTarget,
} from '@/lib/skills/install-apply';
import { hasRemovedSkillPayload } from '@/lib/skills/uninstall-apply';
import {
  deleteSkillInstallation,
  upsertSkillInstallation,
} from '@/lib/skills/installed-state';
import { recordSkillOperationAudit } from '@/lib/skills/operation-audit';
import {
  pruneExpiredSkillOperationJournal,
  type SkillOperationJournalEntry,
} from '@/lib/skills/operation-journal';
import {
  reconcileSkillOperations,
  type SkillReconcileOptions,
  type SkillReconcileReport,
  type SkillReconcilerPorts,
} from '@/lib/skills/operation-reconciler';

/** Options for the startup assembly. Tests inject the clock, liveness and root. */
export interface SkillStartupReconcileOptions extends SkillReconcileOptions {
  /** Retention window for terminal journal entries; defaults to the module default. */
  retentionMs?: number;
  /**
   * Resolve a worktree's absolute path from its id. Defaults to the DB lookup
   * used in production; injectable so a test need not stand up a repository.
   */
  resolveWorktreePath?: (worktreeId: string) => string | null;
}

/** Reconciliation report plus what retention collected. */
export interface SkillStartupReconcileReport extends SkillReconcileReport {
  /** Idempotency keys whose expired terminal journal entries were pruned. */
  prunedKeys: string[];
  pruned: number;
}

/**
 * Whether an operation's kind removes payload (uninstall) rather than adding it.
 * `update` re-installs, so it shares the install-side probe and index write.
 */
function isRemovalOperation(entry: SkillOperationJournalEntry): boolean {
  return entry.operation === 'uninstall';
}

/**
 * Build the reconciler ports against the real filesystem and database.
 *
 * The reconciler asks one filesystem question and performs one index write per
 * entry; both dispatch on the operation kind because "did it land?" and "rebuild
 * the row" mean opposite things for an install and an uninstall.
 */
export function buildSkillReconcilerPorts(
  db: Database.Database,
  options: SkillStartupReconcileOptions = {}
): SkillReconcilerPorts {
  const resolveWorktreePath =
    options.resolveWorktreePath ??
    ((worktreeId: string): string | null => {
      const worktree = getWorktreeById(db, worktreeId);
      return worktree ? worktree.path : null;
    });

  return {
    hasCommittedPayload: (entry: SkillOperationJournalEntry): boolean => {
      const worktreePath = resolveWorktreePath(entry.target.worktreeId);
      if (worktreePath === null) {
        // The worktree is gone: an install could not have left payload behind,
        // and an uninstall's payload is by definition no longer present.
        return isRemovalOperation(entry);
      }
      return isRemovalOperation(entry)
        ? hasRemovedSkillPayload(worktreePath, entry.target.skillId, entry.receiptDigest)
        : hasCommittedSkillPayload(worktreePath, entry.target.skillId, entry.receiptDigest);
    },

    reindex: (entry: SkillOperationJournalEntry): void => {
      if (isRemovalOperation(entry)) {
        // The row is dropped by (worktree, skill); no path or receipt is needed,
        // and the delete is idempotent so a replay after a partial pass is safe.
        deleteSkillInstallation(db, entry.target.worktreeId, entry.target.skillId);
        return;
      }

      const worktreePath = resolveWorktreePath(entry.target.worktreeId);
      if (worktreePath === null) {
        throw new Error('worktree path is unavailable for reindex');
      }
      // The index row is rebuilt from the receipt that actually landed rather
      // than from the journal, which never carried the full receipt. The receipt
      // on disk is the same artifact the user can see, so the row cannot drift
      // from it.
      const installRootAbs = resolveSkillInstallTarget(worktreePath, entry.target.skillId);
      const bytes = readFileSync(join(installRootAbs, SKILL_RECEIPT_FILENAME));
      const receipt = parseInstalledReceipt(bytes);
      if (receipt === null) {
        throw new Error('receipt on disk is unreadable during reindex');
      }
      upsertSkillInstallation(db, {
        worktreeId: entry.target.worktreeId,
        receipt,
        receiptSha256: computeSha256Hex(bytes),
        operationId: entry.operationId,
        installedAt: entry.fsCommittedAt ?? options.now ?? Date.now(),
      });
    },

    recordAudit: (input) => {
      recordSkillOperationAudit(db, input);
    },
  };
}

/**
 * Converge interrupted Skill operations and collect expired journal entries.
 *
 * Called once at server startup, after migrations (the audit table is
 * migration-owned) and before the server begins accepting requests. Returns the
 * reconciliation report augmented with what retention pruned.
 */
export function runSkillStartupReconciliation(
  db: Database.Database,
  options: SkillStartupReconcileOptions = {}
): SkillStartupReconcileReport {
  const ports = buildSkillReconcilerPorts(db, options);
  const report = reconcileSkillOperations(ports, options);
  // Pruning runs after convergence: an entry that just converged to SUCCEEDED
  // has a fresh `updatedAt` and is well inside its window, so this pass only
  // collects entries that were already terminal in an earlier one.
  const prunedKeys = pruneExpiredSkillOperationJournal({
    root: options.root,
    now: options.now,
    retentionMs: options.retentionMs,
  });
  return { ...report, prunedKeys, pruned: prunedKeys.length };
}
