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
import { getRepoDefaultSelectedAgents } from '@/lib/repo-config/agents-config';
import { getDefaultSelectedAgents } from './app-settings-db';
import { ACTIVE_FILTER } from './chat-db';
import {
  deleteWorktreeChildRows,
  renameWorktreeIdPreservingChildren,
} from './migrations/worktree-id-rename';

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
        ${ACTIVE_FILTER}
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


/** Shared empty set, so the common "no repository declares anything" path allocates nothing. */
const EMPTY_ID_SET: ReadonlySet<string> = new Set<string>();

/**
 * IDs of every worktree that already owns an `agent_instances` roster.
 *
 * One query for the whole list rather than one per row (Issue #2066): the
 * sidebar poll must not grow N point queries. `agent_instances` holds a handful
 * of rows per registered worktree, and only the distinct worktree ids are read.
 */
function worktreeIdsWithAgentInstances(db: Database.Database): ReadonlySet<string> {
  const rows = db
    .prepare('SELECT DISTINCT worktree_id FROM agent_instances')
    .all() as Array<{ worktree_id: string }>;
  return new Set(rows.map((row) => row.worktree_id));
}

/** Whether one worktree already owns an `agent_instances` roster (Issue #2066). */
function hasAgentInstances(db: Database.Database, worktreeId: string): boolean {
  return (
    db.prepare('SELECT 1 FROM agent_instances WHERE worktree_id = ? LIMIT 1').get(worktreeId) !==
    undefined
  );
}

/**
 * The repository layer for ONE worktree, withheld when that worktree already
 * owns a roster (Issue #2066). The single-row twin of the batch logic in
 * `getWorktrees()`; see the long comment there for why the withholding exists
 * and why it is narrowed to this layer.
 */
function repoDefaultWithheldFromRoster(
  db: Database.Database,
  worktreeId: string,
  repositoryPath: string | null
): CLIToolType[] | null {
  const declared = getRepoDefaultSelectedAgents(repositoryPath);
  if (declared === null) return null;
  return hasAgentInstances(db, worktreeId) ? null : declared;
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
      w.selected_agents, w.vibe_local_model, w.vibe_local_context_window, w.branch,
      r.display_name as repository_display_name,
      (SELECT MAX(timestamp) FROM chat_messages
       WHERE worktree_id = w.id AND role = 'assistant' ${ACTIVE_FILTER}) as last_assistant_message_at
    FROM worktrees w
    LEFT JOIN repositories r ON w.repository_path = r.path
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
    branch: string | null;
    repository_display_name: string | null;
    last_assistant_message_at: number | null;
  }>;

  // Batch fetch last messages for all worktrees (N+1 optimization)
  const worktreeIds = rows.map(row => row.id);
  const lastMessagesByCliMap = getLastMessagesByCliBatch(db, worktreeIds);

  // Issue #2065: read the server-wide default ONCE. `upsertWorktree` never
  // writes `selected_agents`, so on a scan/sync-populated install every row
  // below takes the fallback path — resolving it per row would turn one point
  // query into one per worktree on the sidebar's poll.
  const appSettingsDefault = getDefaultSelectedAgents(db);

  // Issue #2066: the repository layer, resolved ONCE per distinct
  // `repository_path` rather than per row. `getRepoDefaultSelectedAgents()` is
  // itself served from a process-wide cache filled at sync — see its module
  // header for why the read does not belong on this (polled) path.
  const repoDefaults = new Map<string, CLIToolType[] | null>();
  for (const repositoryPath of new Set(rows.map((row) => row.repository_path))) {
    if (!repositoryPath) continue;
    repoDefaults.set(repositoryPath, getRepoDefaultSelectedAgents(repositoryPath));
  }

  // Issue #2066: a worktree that ALREADY has an `agent_instances` roster is not
  // offered the repository declaration.
  //
  // `resolveAgentInstances()` protects the roster itself with an early return,
  // but `selectedAgents` is a SECOND channel: `/sessions` and the Review tab
  // render `wt.selectedAgents ?? clientDefault` and never look at
  // `agentInstances`. Without this, committing an `agents.yaml` would repaint
  // the chips of a branch whose tabs it cannot and must not change — and the
  // running agent would drop out of "active agents" because it is not in the
  // declared list. `PATCH /api/worktrees/[id]` writes `agentInstances` and
  // `selectedAgents` from independent branches, so "has a roster, column still
  // NULL" is a state the product produces routinely, not an edge case.
  //
  // Deliberately narrowed to the repository layer. The `app_settings` layer has
  // the same shape (#2065) and the same gap, but changing it is a change to
  // #2065's behaviour; what #2066 has to answer for is that it widened the gap
  // from "an admin who can reach server settings" to "anyone who can commit to
  // the repository". See docs/design/repo-agents-config.md §2.
  //
  // The roster query runs only when some repository actually declares
  // something, so an install with no `agents.yaml` anywhere issues exactly the
  // queries it issued before this Issue.
  const anyRepoDeclares = [...repoDefaults.values()].some((value) => value !== null);
  const withRoster = anyRepoDeclares ? worktreeIdsWithAgentInstances(db) : EMPTY_ID_SET;

  const repoDefaultFor = (row: { id: string; repository_path: string | null }): CLIToolType[] | null => {
    if (!row.repository_path) return null;
    if (withRoster.has(row.id)) return null;
    return repoDefaults.get(row.repository_path) ?? null;
  };

  return rows.map((row) => {
    const lastMessagesByCli = lastMessagesByCliMap.get(row.id) || {};

    return {
      id: row.id,
      name: row.name,
      path: row.path,
      branch: row.branch ?? undefined,
      repositoryPath: row.repository_path || '',
      repositoryName: row.repository_name || '',
      repositoryDisplayName: row.repository_display_name || undefined,
      description: row.description || undefined,
      lastUserMessage: row.last_user_message || undefined,
      lastUserMessageAt: row.last_user_message_at ? new Date(row.last_user_message_at) : undefined,
      lastMessageSummary: row.last_message_summary || undefined,
      lastMessagesByCli,
      updatedAt: row.updated_at ? new Date(row.updated_at) : undefined,
      lastViewedAt: row.last_viewed_at ? new Date(row.last_viewed_at) : undefined,
      lastAssistantMessageAt: row.last_assistant_message_at ? new Date(row.last_assistant_message_at) : undefined,
      favorite: row.favorite === 1,
      status: (row.status as 'ready' | 'in_progress' | 'in_review' | 'done' | null) || null,
      link: row.link || undefined,
      cliToolId: (row.cli_tool_id as CLIToolType | null) ?? 'claude',
      selectedAgents: parseSelectedAgents(
        row.selected_agents,
        appSettingsDefault,
        repoDefaultFor(row)
      ),
      vibeLocalModel: row.vibe_local_model ?? null,
      vibeLocalContextWindow: row.vibe_local_context_window ?? null,
    };
  });
}

/**
 * Get list of unique repositories from worktrees
 *
 * Issue #690: Includes `visible` and `enabled` flags so the sidebar can
 * filter out hidden repositories (visible=false). When the worktree row
 * has no matching repositories row (LEFT JOIN miss), default to
 * visible=true and enabled=true so legacy rows behave like before.
 */
export function getRepositories(db: Database.Database): Array<{
  id?: string;
  path: string;
  name: string;
  displayName?: string;
  worktreeCount: number;
  visible: boolean;
  enabled: boolean;
}> {
  const stmt = db.prepare(`
    SELECT
      r.id as id,
      w.repository_path as path,
      w.repository_name as name,
      r.display_name as display_name,
      r.visible as visible,
      r.enabled as enabled,
      COUNT(*) as worktree_count
    FROM worktrees w
    LEFT JOIN repositories r ON w.repository_path = r.path
    WHERE w.repository_path IS NOT NULL
    GROUP BY w.repository_path, w.repository_name
    ORDER BY w.repository_name ASC
  `);

  const rows = stmt.all() as Array<{
    id: string | null;
    path: string;
    name: string;
    display_name: string | null;
    visible: number | null;
    enabled: number | null;
    worktree_count: number;
  }>;

  return rows.map((row) => ({
    id: row.id || undefined,
    path: row.path,
    name: row.name,
    displayName: row.display_name || undefined,
    worktreeCount: row.worktree_count,
    // LEFT JOIN miss => default to visible/enabled to preserve legacy behavior
    visible: row.visible === null ? true : row.visible === 1,
    enabled: row.enabled === null ? true : row.enabled === 1,
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
      w.selected_agents, w.vibe_local_model, w.vibe_local_context_window, w.branch,
      r.display_name as repository_display_name,
      (SELECT MAX(timestamp) FROM chat_messages
       WHERE worktree_id = w.id AND role = 'assistant' ${ACTIVE_FILTER}) as last_assistant_message_at
    FROM worktrees w
    LEFT JOIN repositories r ON w.repository_path = r.path
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
    branch: string | null;
    repository_display_name: string | null;
    last_assistant_message_at: number | null;
  } | undefined;

  if (!row) {
    return null;
  }

  return {
    id: row.id,
    name: row.name,
    path: row.path,
    branch: row.branch ?? undefined,
    repositoryPath: row.repository_path || '',
    repositoryName: row.repository_name || '',
    repositoryDisplayName: row.repository_display_name || undefined,
    description: row.description || undefined,
    lastUserMessage: row.last_user_message || undefined,
    lastUserMessageAt: row.last_user_message_at ? new Date(row.last_user_message_at) : undefined,
    lastMessageSummary: row.last_message_summary || undefined,
    updatedAt: row.updated_at ? new Date(row.updated_at) : undefined,
    lastViewedAt: row.last_viewed_at ? new Date(row.last_viewed_at) : undefined,
    lastAssistantMessageAt: row.last_assistant_message_at ? new Date(row.last_assistant_message_at) : undefined,
    favorite: row.favorite === 1,
    status: (row.status as 'ready' | 'in_progress' | 'in_review' | 'done' | null) || null,
    link: row.link || undefined,
    cliToolId: (row.cli_tool_id as CLIToolType | null) ?? 'claude',
    // Issue #2066: same layers, and the same withholding, as getWorktrees().
    // The roster probe runs only when this repository actually declares
    // something, so a tree with no `agents.yaml` issues no extra query.
    selectedAgents: parseSelectedAgents(
      row.selected_agents,
      getDefaultSelectedAgents(db),
      repoDefaultWithheldFromRoster(db, row.id, row.repository_path)
    ),
    vibeLocalModel: row.vibe_local_model ?? null,
    vibeLocalContextWindow: row.vibe_local_context_window ?? null,
  };
}

/**
 * Insert or update worktree.
 *
 * Issue #1151: A worktree ID is derived from its branch name
 * (`generateWorktreeId`), so checking out a different branch in the *same*
 * directory changes the ID even though the worktree (path) is unchanged. The
 * previous implementation hard-deleted the existing same-path row before
 * inserting the new ID, which CASCADE-deleted every child row (chat history,
 * memos, todos, timers, schedules, execution logs, agent instances). To avoid
 * that data loss we instead RENAME the existing same-path row to the new ID,
 * carrying its child rows along, so history follows the directory across branch
 * switches. The whole operation runs in a single transaction so the rename and
 * the upsert are atomic.
 */
export function upsertWorktree(
  db: Database.Database,
  worktree: Worktree
): void {
  const run = db.transaction(() => {
    // A branch switch (or a change to the ID scheme) yields a different ID for
    // the same on-disk path. `path` is UNIQUE, so we must reconcile the stale
    // row before inserting the new ID. Migrate it (id + child FK rows) instead
    // of deleting so no history is lost.
    const staleRows = db
      .prepare('SELECT id FROM worktrees WHERE path = ? AND id != ?')
      .all(worktree.path, worktree.id) as Array<{ id: string }>;

    for (const { id: staleId } of staleRows) {
      migrateWorktreeIdPreservingChildren(db, staleId, worktree.id);
    }

    const stmt = db.prepare(`
      INSERT INTO worktrees (
        id, name, path, repository_path, repository_name, description,
        last_user_message, last_user_message_at, last_message_summary, updated_at, cli_tool_id, branch
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        cli_tool_id = COALESCE(excluded.cli_tool_id, worktrees.cli_tool_id),
        -- Issue #1003: keep the last known branch when a non-sync writer omits it.
        branch = COALESCE(excluded.branch, worktrees.branch)
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
      worktree.cliToolId || 'claude',
      worktree.branch || null
    );
  });

  run();
}

/**
 * Rename a worktree row's primary key from `oldId` to `newId`, re-pointing every
 * child table's foreign key so no CASCADE deletion occurs (Issue #1151, #1621).
 *
 * The implementation lives in `migrations/worktree-id-rename.ts` because the
 * Phase 4 renumbering (#1645) needs it from inside a migration, and a migration
 * that imports THIS module inherits every `vi.mock('@/lib/db/worktree-db')` in
 * the suite (measured — see that module's header). This wrapper keeps the
 * public API and its import path unchanged.
 *
 * Must be called inside a transaction.
 */
export function migrateWorktreeIdPreservingChildren(
  db: Database.Database,
  oldId: string,
  newId: string
): void {
  renameWorktreeIdPreservingChildren(db, oldId, newId);
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
  status: 'ready' | 'in_progress' | 'in_review' | 'done' | null
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
 * @param selectedAgents - Array of 2-6 CLIToolType values (MIN/MAX_SELECTED_AGENTS)
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
 * Every worktree ID currently stored, across all repositories.
 *
 * Issue #1621: `deriveWorktreeId` mints an ID from a directory's basename, and
 * two repositories can easily hold same-named directories (`.../a/main`,
 * `.../b/main`). The ID is the global primary key of `worktrees`, so the
 * "already taken" set the derivation consults has to be global too;
 * {@link getWorktreeIdsByRepository} would silently allow a cross-repository
 * collision, which then surfaces as a UNIQUE(path) failure on upsert.
 *
 * @param db - Database instance
 * @returns Every `worktrees.id` value
 */
export function getAllWorktreeIds(db: Database.Database): string[] {
  const rows = db.prepare('SELECT id FROM worktrees').all() as Array<{ id: string }>;
  return rows.map(row => row.id);
}

/**
 * Every worktree row's `(id, path)` pair, across all repositories.
 *
 * The global counterpart of {@link getWorktreesByRepository}, and the difference
 * matters (Issue #1658): `path` is the identity of a worktree — the column is
 * `NOT NULL UNIQUE` — whereas `repository_path` merely records which scan root
 * last upserted the row. When the *same* git repository is registered under two
 * scan roots (a repo and one of its own linked worktrees, both in
 * `WORKTREE_REPOS`), `git worktree list` returns the identical path set from
 * either one, and `repository_path` ping-pongs between them on every sync.
 * Looking an existing ID up per repository then misses the row half the time and
 * re-derives its ID, which appends another 8 hex digits — forever.
 *
 * Resolving "which ID does this path already own?" must therefore be global.
 * Pruning stays per-repository ({@link getWorktreesByRepository}): that question
 * really is scoped to one scan root.
 *
 * @param db - Database instance
 * @returns `{ id, path }` for every worktree row
 */
export function getAllWorktreePathIds(
  db: Database.Database
): Array<{ id: string; path: string }> {
  return db.prepare('SELECT id, path FROM worktrees').all() as Array<{
    id: string;
    path: string;
  }>;
}

/**
 * Get all worktree rows (id + path) for a given repository path.
 *
 * Issue #1151: sync decides which DB rows to prune. It must key that decision on
 * the on-disk path, not the branch-derived ID, otherwise a branch switch in the
 * same directory looks like a "removed" worktree and gets CASCADE-deleted.
 *
 * @param db - Database instance
 * @param repositoryPath - Path of the repository
 * @returns Array of `{ id, path }` for every worktree of the repository
 */
export function getWorktreesByRepository(
  db: Database.Database,
  repositoryPath: string
): Array<{ id: string; path: string }> {
  const stmt = db.prepare(`
    SELECT id, path FROM worktrees WHERE repository_path = ?
  `);

  return stmt.all(repositoryPath) as Array<{ id: string; path: string }>;
}

/**
 * Delete all worktrees for a given repository path
 * Child rows are deleted explicitly before the parent, for every table
 * getWorktreeChildTables reports. ON DELETE CASCADE covers only the tables that
 * declare a foreign key; `tasks`, `verification_runs` and `skill_operations`
 * hold a `worktree_id` with no constraint and would otherwise survive their
 * worktree as orphans (#1621). Deleting `verification_runs` still cascades to
 * `verification_gate_results`, which does declare its foreign key.
 *
 * @param db - Database instance
 * @param repositoryPath - Path of the repository to delete
 * @returns Object containing the count of deleted worktrees
 */
export function deleteRepositoryWorktrees(
  db: Database.Database,
  repositoryPath: string
): { deletedCount: number } {
  const run = db.transaction((): number => {
    const ids = (
      db
        .prepare('SELECT id FROM worktrees WHERE repository_path = ?')
        .all(repositoryPath) as Array<{ id: string | null }>
    )
      .map((row) => row.id)
      .filter((id): id is string => id !== null);

    deleteWorktreeChildRows(db, ids);

    return db
      .prepare('DELETE FROM worktrees WHERE repository_path = ?')
      .run(repositoryPath).changes;
  });

  return { deletedCount: run() };
}

/**
 * Delete worktrees by their IDs
 * Child rows are deleted explicitly before the parent, for every table
 * getWorktreeChildTables reports — including skill_installations, whose rows
 * used to survive the worktree and make a re-created worktree at the same path
 * un-installable (#1430), and the constraint-less `tasks` / `verification_runs`
 * / `skill_operations`, which no CASCADE can reach (#1621).
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
  const run = db.transaction((): number => {
    deleteWorktreeChildRows(db, worktreeIds);

    return db
      .prepare(`DELETE FROM worktrees WHERE id IN (${placeholders})`)
      .run(...worktreeIds).changes;
  });

  return { deletedCount: run() };
}
