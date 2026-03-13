/**
 * Worktree database operations
 * CRUD operations for worktrees table
 *
 * Issue #479: Extracted from db.ts for single-responsibility separation
 */

import Database from 'better-sqlite3';
import type { Worktree } from '@/types/models';
import type { CLIToolType } from '@/lib/cli-tools/types';
import { parseSelectedAgents } from '@/lib/selected-agents-validator';

/**
 * Get latest user message per CLI tool for multiple worktrees (batch query)
 * Optimized to avoid N+1 query problem
 *
 * R4-001: SQL IN clause for cli_tool_id removed to eliminate SQL injection risk.
 * All cli_tool_id values are fetched; filtering happens at application layer.
 * Tool count is at most 4-5, so the performance impact is negligible.
 *
 * R2-002: Return type changed to Partial<Record<CLIToolType, string>>
 */
function getLastMessagesByCliBatch(
  db: Database.Database,
  worktreeIds: string[]
): Map<string, Partial<Record<CLIToolType, string>>> {
  if (worktreeIds.length === 0) {
    return new Map();
  }

  // Single query to get latest user message for each worktree/cli_tool combination
  // Uses window function to rank messages and filter to only the latest per group
  const placeholders = worktreeIds.map(() => '?').join(',');
  const stmt = db.prepare(`
    WITH ranked_messages AS (
      SELECT
        worktree_id,
        cli_tool_id,
        content,
        ROW_NUMBER() OVER (
          PARTITION BY worktree_id, cli_tool_id
          ORDER BY timestamp DESC
        ) as rn
      FROM chat_messages
      WHERE worktree_id IN (${placeholders})
        AND role = 'user'
    )
    SELECT worktree_id, cli_tool_id, content
    FROM ranked_messages
    WHERE rn = 1
  `);

  const rows = stmt.all(...worktreeIds) as Array<{
    worktree_id: string;
    cli_tool_id: string;
    content: string;
  }>;

  // Build result map
  const result = new Map<string, Partial<Record<CLIToolType, string>>>();

  // Initialize all worktree IDs with empty objects
  for (const id of worktreeIds) {
    result.set(id, {});
  }

  // Populate with query results
  for (const row of rows) {
    const existing = result.get(row.worktree_id) || {};
    existing[row.cli_tool_id as CLIToolType] = row.content.substring(0, 50);
    result.set(row.worktree_id, existing);
  }

  return result;
}


/**
 * Get all worktrees sorted by updated_at (desc)
 * Optionally filter by repository path
 * Includes lastViewedAt and lastAssistantMessageAt for unread tracking
 */
export function getWorktrees(
  db: Database.Database,
  repositoryPath?: string
): Worktree[] {
  let query = `
    SELECT
      w.id, w.name, w.path, w.repository_path, w.repository_name, w.description,
      w.last_user_message, w.last_user_message_at, w.last_message_summary,
      w.updated_at, w.favorite, w.status, w.link, w.cli_tool_id, w.last_viewed_at,
      w.selected_agents, w.vibe_local_model, w.vibe_local_context_window,
      (SELECT MAX(timestamp) FROM chat_messages
       WHERE worktree_id = w.id AND role = 'assistant') as last_assistant_message_at
    FROM worktrees w
  `;

  const params: string[] = [];

  if (repositoryPath) {
    query += ` WHERE w.repository_path = ?`;
    params.push(repositoryPath);
  }

  query += ` ORDER BY w.updated_at DESC NULLS LAST`;

  const stmt = db.prepare(query);
  const rows = stmt.all(...params) as Array<{
    id: string;
    name: string;
    path: string;
    repository_path: string | null;
    repository_name: string | null;
    description: string | null;
    last_user_message: string | null;
    last_user_message_at: number | null;
    last_message_summary: string | null;
    updated_at: number | null;
    favorite: number | null;
    status: string | null;
    link: string | null;
    cli_tool_id: string | null;
    last_viewed_at: string | null;
    selected_agents: string | null;
    vibe_local_model: string | null;
    vibe_local_context_window: number | null;
    last_assistant_message_at: number | null;
  }>;

  // Batch fetch last messages for all worktrees (N+1 optimization)
  const worktreeIds = rows.map(row => row.id);
  const lastMessagesByCliMap = getLastMessagesByCliBatch(db, worktreeIds);

  return rows.map((row) => {
    const lastMessagesByCli = lastMessagesByCliMap.get(row.id) || {};

    return {
      id: row.id,
      name: row.name,
      path: row.path,
      repositoryPath: row.repository_path || '',
      repositoryName: row.repository_name || '',
      description: row.description || undefined,
      lastUserMessage: row.last_user_message || undefined,
      lastUserMessageAt: row.last_user_message_at ? new Date(row.last_user_message_at) : undefined,
      lastMessageSummary: row.last_message_summary || undefined,
      lastMessagesByCli,
      updatedAt: row.updated_at ? new Date(row.updated_at) : undefined,
      lastViewedAt: row.last_viewed_at ? new Date(row.last_viewed_at) : undefined,
      lastAssistantMessageAt: row.last_assistant_message_at ? new Date(row.last_assistant_message_at) : undefined,
      favorite: row.favorite === 1,
      status: (row.status as 'todo' | 'doing' | 'done' | null) || null,
      link: row.link || undefined,
      cliToolId: (row.cli_tool_id as CLIToolType | null) ?? 'claude',
      selectedAgents: parseSelectedAgents(row.selected_agents),
      vibeLocalModel: row.vibe_local_model ?? null,
      vibeLocalContextWindow: row.vibe_local_context_window ?? null,
    };
  });
}

/**
 * Get list of unique repositories from worktrees
 */
export function getRepositories(db: Database.Database): Array<{
  path: string;
  name: string;
  worktreeCount: number;
}> {
  const stmt = db.prepare(`
    SELECT
      repository_path as path,
      repository_name as name,
      COUNT(*) as worktree_count
    FROM worktrees
    WHERE repository_path IS NOT NULL
    GROUP BY repository_path, repository_name
    ORDER BY repository_name ASC
  `);

  const rows = stmt.all() as Array<{
    path: string;
    name: string;
    worktree_count: number;
  }>;

  return rows.map((row) => ({
    path: row.path,
    name: row.name,
    worktreeCount: row.worktree_count,
  }));
}

/**
 * Get worktree by ID
 * Includes lastViewedAt and lastAssistantMessageAt for unread tracking
 */
export function getWorktreeById(
  db: Database.Database,
  id: string
): Worktree | null {
  const stmt = db.prepare(`
    SELECT
      w.id, w.name, w.path, w.repository_path, w.repository_name, w.description,
      w.last_user_message, w.last_user_message_at, w.last_message_summary,
      w.updated_at, w.favorite, w.status, w.link, w.cli_tool_id, w.last_viewed_at,
      w.selected_agents, w.vibe_local_model, w.vibe_local_context_window,
      (SELECT MAX(timestamp) FROM chat_messages
       WHERE worktree_id = w.id AND role = 'assistant') as last_assistant_message_at
    FROM worktrees w
    WHERE w.id = ?
  `);

  const row = stmt.get(id) as {
    id: string;
    name: string;
    path: string;
    repository_path: string | null;
    repository_name: string | null;
    description: string | null;
    last_user_message: string | null;
    last_user_message_at: number | null;
    last_message_summary: string | null;
    updated_at: number | null;
    favorite: number | null;
    status: string | null;
    link: string | null;
    cli_tool_id: string | null;
    last_viewed_at: string | null;
    selected_agents: string | null;
    vibe_local_model: string | null;
    vibe_local_context_window: number | null;
    last_assistant_message_at: number | null;
  } | undefined;

  if (!row) {
    return null;
  }

  return {
    id: row.id,
    name: row.name,
    path: row.path,
    repositoryPath: row.repository_path || '',
    repositoryName: row.repository_name || '',
    description: row.description || undefined,
    lastUserMessage: row.last_user_message || undefined,
    lastUserMessageAt: row.last_user_message_at ? new Date(row.last_user_message_at) : undefined,
    lastMessageSummary: row.last_message_summary || undefined,
    updatedAt: row.updated_at ? new Date(row.updated_at) : undefined,
    lastViewedAt: row.last_viewed_at ? new Date(row.last_viewed_at) : undefined,
    lastAssistantMessageAt: row.last_assistant_message_at ? new Date(row.last_assistant_message_at) : undefined,
    favorite: row.favorite === 1,
    status: (row.status as 'todo' | 'doing' | 'done' | null) || null,
    link: row.link || undefined,
    cliToolId: (row.cli_tool_id as CLIToolType | null) ?? 'claude',
    selectedAgents: parseSelectedAgents(row.selected_agents),
    vibeLocalModel: row.vibe_local_model ?? null,
    vibeLocalContextWindow: row.vibe_local_context_window ?? null,
  };
}

/**
 * Insert or update worktree
 */
export function upsertWorktree(
  db: Database.Database,
  worktree: Worktree
): void {
  // First, remove any existing worktree with the same path but different ID
  // This handles cases where the ID generation scheme has changed
  db.prepare('DELETE FROM worktrees WHERE path = ? AND id != ?').run(worktree.path, worktree.id);

  const stmt = db.prepare(`
    INSERT INTO worktrees (
      id, name, path, repository_path, repository_name, description,
      last_user_message, last_user_message_at, last_message_summary, updated_at, cli_tool_id
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      path = excluded.path,
      repository_path = excluded.repository_path,
      repository_name = excluded.repository_name,
      description = COALESCE(excluded.description, worktrees.description),
      last_user_message = COALESCE(excluded.last_user_message, worktrees.last_user_message),
      last_user_message_at = COALESCE(excluded.last_user_message_at, worktrees.last_user_message_at),
      last_message_summary = COALESCE(excluded.last_message_summary, worktrees.last_message_summary),
      updated_at = COALESCE(excluded.updated_at, worktrees.updated_at),
      cli_tool_id = COALESCE(excluded.cli_tool_id, worktrees.cli_tool_id)
  `);

  stmt.run(
    worktree.id,
    worktree.name,
    worktree.path,
    worktree.repositoryPath || null,
    worktree.repositoryName || null,
    worktree.description || null,
    worktree.lastUserMessage || null,
    worktree.lastUserMessageAt?.getTime() || null,
    worktree.lastMessageSummary || null,
    worktree.updatedAt?.getTime() || null,
    worktree.cliToolId || 'claude'
  );
}

/**
 * Update worktree description
 */
export function updateWorktreeDescription(
  db: Database.Database,
  worktreeId: string,
  description: string
): void {
  const stmt = db.prepare(`
    UPDATE worktrees
    SET description = ?
    WHERE id = ?
  `);

  stmt.run(description || null, worktreeId);
}

/**
 * Update worktree link
 */
export function updateWorktreeLink(
  db: Database.Database,
  worktreeId: string,
  link: string
): void {
  const stmt = db.prepare(`
    UPDATE worktrees
    SET link = ?
    WHERE id = ?
  `);

  stmt.run(link || null, worktreeId);
}

/**
 * Update worktree's last_viewed_at timestamp
 * Used for unread tracking (Issue #31)
 */
export function updateLastViewedAt(
  db: Database.Database,
  worktreeId: string,
  viewedAt: Date
): void {
  const stmt = db.prepare(`
    UPDATE worktrees
    SET last_viewed_at = ?
    WHERE id = ?
  `);

  stmt.run(viewedAt.toISOString(), worktreeId);
}

/**
 * Update favorite status for a worktree
 */
export function updateFavorite(
  db: Database.Database,
  id: string,
  favorite: boolean
): void {
  const stmt = db.prepare(`
    UPDATE worktrees
    SET favorite = ?
    WHERE id = ?
  `);

  stmt.run(favorite ? 1 : 0, id);
}

/**
 * Update status for a worktree
 */
export function updateStatus(
  db: Database.Database,
  id: string,
  status: 'todo' | 'doing' | 'done' | null
): void {
  const stmt = db.prepare(`
    UPDATE worktrees
    SET status = ?
    WHERE id = ?
  `);

  stmt.run(status, id);
}

/**
 * Update CLI tool ID for a worktree
 */
export function updateCliToolId(
  db: Database.Database,
  id: string,
  cliToolId: CLIToolType
): void {
  const stmt = db.prepare(`
    UPDATE worktrees
    SET cli_tool_id = ?
    WHERE id = ?
  `);

  stmt.run(cliToolId, id);
}

/**
 * Update selected_agents for a worktree
 * Issue #368: Persists the user's choice of 2 display agents
 *
 * @param db - Database instance
 * @param id - Worktree ID
 * @param selectedAgents - Array of 2-4 CLIToolType values
 */
export function updateSelectedAgents(
  db: Database.Database,
  id: string,
  selectedAgents: CLIToolType[]
): void {
  const stmt = db.prepare(`
    UPDATE worktrees
    SET selected_agents = ?
    WHERE id = ?
  `);

  stmt.run(JSON.stringify(selectedAgents), id);
}

/**
 * Update vibe_local_model for a worktree
 * Issue #368: Persists the user's Ollama model selection for vibe-local
 *
 * @param db - Database instance
 * @param id - Worktree ID
 * @param model - Model name or null for default
 */
export function updateVibeLocalModel(
  db: Database.Database,
  id: string,
  model: string | null
): void {
  const stmt = db.prepare(`
    UPDATE worktrees
    SET vibe_local_model = ?
    WHERE id = ?
  `);

  stmt.run(model, id);
}

/**
 * Update vibe_local_context_window for a worktree
 * Issue #374: Persists the user's Ollama context window size for vibe-local
 *
 * @param db - Database instance
 * @param id - Worktree ID
 * @param contextWindow - Context window size or null for default
 */
export function updateVibeLocalContextWindow(
  db: Database.Database,
  id: string,
  contextWindow: number | null
): void {
  const stmt = db.prepare(`
    UPDATE worktrees
    SET vibe_local_context_window = ?
    WHERE id = ?
  `);

  stmt.run(contextWindow, id);
}

// ============================================================
// Initial Branch Operations (Issue #111)
// ============================================================

/**
 * Save initial branch for a worktree (at session start)
 * Issue #111: Branch visualization feature
 *
 * @param db - Database instance
 * @param worktreeId - ID of the worktree
 * @param branchName - Branch name to save
 *
 * @remarks
 * Uses prepared statement for SQL injection prevention
 * Called from send/route.ts after startSession()
 */
export function saveInitialBranch(
  db: Database.Database,
  worktreeId: string,
  branchName: string
): void {
  const stmt = db.prepare(`
    UPDATE worktrees
    SET initial_branch = ?
    WHERE id = ?
  `);

  stmt.run(branchName, worktreeId);
}

/**
 * Get initial branch for a worktree
 * Issue #111: Branch visualization feature
 *
 * @param db - Database instance
 * @param worktreeId - ID of the worktree
 * @returns Branch name or null if not recorded
 */
export function getInitialBranch(
  db: Database.Database,
  worktreeId: string
): string | null {
  const stmt = db.prepare(`
    SELECT initial_branch
    FROM worktrees
    WHERE id = ?
  `);

  const row = stmt.get(worktreeId) as { initial_branch: string | null } | undefined;

  return row?.initial_branch ?? null;
}

// ============================================================
// Repository Delete Operations (Issue #69)
// ============================================================

/**
 * Get all worktree IDs for a given repository path
 *
 * @param db - Database instance
 * @param repositoryPath - Path of the repository
 * @returns Array of worktree IDs
 */
export function getWorktreeIdsByRepository(
  db: Database.Database,
  repositoryPath: string
): string[] {
  const stmt = db.prepare(`
    SELECT id FROM worktrees WHERE repository_path = ?
  `);

  const rows = stmt.all(repositoryPath) as Array<{ id: string }>;
  return rows.map(r => r.id);
}

/**
 * Delete all worktrees for a given repository path
 * Related data (chat_messages, session_states, worktree_memos) will be
 * automatically deleted via CASCADE foreign key constraints.
 *
 * @param db - Database instance
 * @param repositoryPath - Path of the repository to delete
 * @returns Object containing the count of deleted worktrees
 */
export function deleteRepositoryWorktrees(
  db: Database.Database,
  repositoryPath: string
): { deletedCount: number } {
  const stmt = db.prepare(`
    DELETE FROM worktrees WHERE repository_path = ?
  `);

  const result = stmt.run(repositoryPath);
  return { deletedCount: result.changes };
}

/**
 * Delete worktrees by their IDs
 * Related data (chat_messages, session_states, worktree_memos) will be
 * automatically deleted via CASCADE foreign key constraints.
 *
 * @param db - Database instance
 * @param worktreeIds - Array of worktree IDs to delete
 * @returns Object containing the count of deleted worktrees
 */
export function deleteWorktreesByIds(
  db: Database.Database,
  worktreeIds: string[]
): { deletedCount: number } {
  if (worktreeIds.length === 0) {
    return { deletedCount: 0 };
  }

  const placeholders = worktreeIds.map(() => '?').join(',');
  const stmt = db.prepare(`
    DELETE FROM worktrees WHERE id IN (${placeholders})
  `);

  const result = stmt.run(...worktreeIds);
  return { deletedCount: result.changes };
}
