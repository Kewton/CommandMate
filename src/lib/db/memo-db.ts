/**
 * Memo database operations
 * CRUD operations for worktree_memos table
 *
 * Issue #479: Extracted from db.ts for single-responsibility separation
 */

import { randomUUID } from 'crypto';
import Database from 'better-sqlite3';
import type { WorktreeMemo } from '@/types/models';

/**
 * Database row type for worktree memos
 */
type WorktreeMemoRow = {
  id: string;
  worktree_id: string;
  title: string;
  content: string;
  position: number;
  created_at: number;
  updated_at: number;
};

/**
 * Map database row to WorktreeMemo model
 */
function mapMemoRow(row: WorktreeMemoRow): WorktreeMemo {
  return {
    id: row.id,
    worktreeId: row.worktree_id,
    title: row.title,
    content: row.content,
    position: row.position,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

/**
 * Get all memos for a worktree, sorted by position
 */
export function getMemosByWorktreeId(
  db: Database.Database,
  worktreeId: string
): WorktreeMemo[] {
  const stmt = db.prepare(`
    SELECT id, worktree_id, title, content, position, created_at, updated_at
    FROM worktree_memos
    WHERE worktree_id = ?
    ORDER BY position ASC
  `);

  const rows = stmt.all(worktreeId) as WorktreeMemoRow[];
  return rows.map(mapMemoRow);
}

/**
 * Get a memo by ID
 *
 * @param db - Database instance
 * @param memoId - ID of the memo
 * @returns Memo or null if not found
 */
export function getMemoById(
  db: Database.Database,
  memoId: string
): WorktreeMemo | null {
  const stmt = db.prepare(`
    SELECT id, worktree_id, title, content, position, created_at, updated_at
    FROM worktree_memos
    WHERE id = ?
  `);

  const row = stmt.get(memoId) as WorktreeMemoRow | undefined;
  return row ? mapMemoRow(row) : null;
}

/**
 * Create a new memo for a worktree
 *
 * @param db - Database instance
 * @param worktreeId - ID of the worktree
 * @param options - Memo options (title, content, position)
 * @returns Created memo
 */
export function createMemo(
  db: Database.Database,
  worktreeId: string,
  options: {
    title?: string;
    content?: string;
    position: number;
  }
): WorktreeMemo {
  const id = randomUUID();
  const now = Date.now();
  const title = options.title ?? 'Memo';
  const content = options.content ?? '';

  const stmt = db.prepare(`
    INSERT INTO worktree_memos (id, worktree_id, title, content, position, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(id, worktreeId, title, content, options.position, now, now);

  return {
    id,
    worktreeId,
    title,
    content,
    position: options.position,
    createdAt: new Date(now),
    updatedAt: new Date(now),
  };
}

/**
 * Update an existing memo
 *
 * @param db - Database instance
 * @param memoId - ID of the memo to update
 * @param updates - Fields to update (title and/or content)
 */
export function updateMemo(
  db: Database.Database,
  memoId: string,
  updates: {
    title?: string;
    content?: string;
  }
): void {
  const now = Date.now();
  const assignments: string[] = ['updated_at = ?'];
  const params: (string | number)[] = [now];

  if (updates.title !== undefined) {
    assignments.push('title = ?');
    params.push(updates.title);
  }

  if (updates.content !== undefined) {
    assignments.push('content = ?');
    params.push(updates.content);
  }

  params.push(memoId);

  const stmt = db.prepare(`
    UPDATE worktree_memos
    SET ${assignments.join(', ')}
    WHERE id = ?
  `);

  stmt.run(...params);
}

/**
 * Delete a memo by ID
 *
 * @param db - Database instance
 * @param memoId - ID of the memo to delete
 */
export function deleteMemo(
  db: Database.Database,
  memoId: string
): void {
  const stmt = db.prepare(`
    DELETE FROM worktree_memos
    WHERE id = ?
  `);

  stmt.run(memoId);
}

/**
 * Reorder memos for a worktree
 *
 * Uses a two-step approach to handle UNIQUE constraint on (worktree_id, position):
 * 1. Set all positions to negative values (temporary)
 * 2. Set new positions from the provided order
 *
 * @param db - Database instance
 * @param worktreeId - ID of the worktree
 * @param memoIds - Array of memo IDs in the desired order
 */
export function reorderMemos(
  db: Database.Database,
  worktreeId: string,
  memoIds: string[]
): void {
  if (memoIds.length === 0) {
    return;
  }

  const now = Date.now();

  db.transaction(() => {
    // Step 1: Set all positions to negative values (to avoid UNIQUE constraint violations)
    const resetStmt = db.prepare(`
      UPDATE worktree_memos
      SET position = -1 - position
      WHERE id = ?
    `);

    for (const memoId of memoIds) {
      resetStmt.run(memoId);
    }

    // Step 2: Set new positions based on array order
    const updateStmt = db.prepare(`
      UPDATE worktree_memos
      SET position = ?, updated_at = ?
      WHERE id = ?
    `);

    memoIds.forEach((memoId, index) => {
      updateStmt.run(index, now, memoId);
    });
  })();
}
