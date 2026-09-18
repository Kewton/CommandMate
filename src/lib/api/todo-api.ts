/**
 * Branch (worktree)-scoped ToDo API client (Issue #1015).
 */

async function parseError(res: Response, fallback: string): Promise<never> {
  const data = await res.json().catch(() => ({}));
  throw new Error(data.error || `${fallback} (${res.status})`);
}

/**
 * Progress state of a worktree ToDo (Issue #1032).
 * `todo` = not started, `doing` = in progress, `done` = completed.
 */
export type WorktreeTodoStatus = 'todo' | 'doing' | 'done';

/** All valid ToDo statuses, in cycle order (todo -> doing -> done). */
export const WORKTREE_TODO_STATUSES: readonly WorktreeTodoStatus[] = [
  'todo',
  'doing',
  'done',
];

/** A worktree(branch)-scoped ToDo item as consumed by the UI (Issue #1015). */
export interface WorktreeTodoItem {
  id: string;
  worktreeId: string;
  content: string;
  /** Free-text supplementary notes (Issue #1034); '' when unset. */
  detail: string;
  /** Progress state (Issue #1032). */
  status: WorktreeTodoStatus;
  /** Derived convenience flag (`status === 'done'`), kept for compatibility. */
  done: boolean;
  position: number;
}

/**
 * Client for the branch-scoped ToDo list (Issue #1015), keyed by `worktreeId`.
 * Item updates use PATCH.
 */
export const worktreeTodoApi = {
  async list(worktreeId: string): Promise<WorktreeTodoItem[]> {
    const res = await fetch(
      `/api/worktrees/${encodeURIComponent(worktreeId)}/todos`,
    );
    if (!res.ok) {
      return parseError(res, 'Failed to load todos');
    }
    const data = (await res.json()) as { todos: WorktreeTodoItem[] };
    return data.todos ?? [];
  },

  async create(
    worktreeId: string,
    content: string,
    detail?: string,
  ): Promise<WorktreeTodoItem> {
    const res = await fetch(
      `/api/worktrees/${encodeURIComponent(worktreeId)}/todos`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(detail !== undefined ? { content, detail } : { content }),
      },
    );
    if (!res.ok) {
      return parseError(res, 'Failed to create todo');
    }
    const data = (await res.json()) as { todo: WorktreeTodoItem };
    return data.todo;
  },

  async update(
    worktreeId: string,
    todoId: string,
    updates: { content?: string; detail?: string; done?: boolean; status?: WorktreeTodoStatus },
  ): Promise<WorktreeTodoItem> {
    const res = await fetch(
      `/api/worktrees/${encodeURIComponent(worktreeId)}/todos/${encodeURIComponent(todoId)}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates),
      },
    );
    if (!res.ok) {
      return parseError(res, 'Failed to update todo');
    }
    const data = (await res.json()) as { todo: WorktreeTodoItem };
    return data.todo;
  },

  async remove(worktreeId: string, todoId: string): Promise<void> {
    const res = await fetch(
      `/api/worktrees/${encodeURIComponent(worktreeId)}/todos/${encodeURIComponent(todoId)}`,
      { method: 'DELETE' },
    );
    if (!res.ok) {
      await parseError(res, 'Failed to delete todo');
    }
  },

  async reorder(worktreeId: string, todoIds: string[]): Promise<void> {
    const res = await fetch(
      `/api/worktrees/${encodeURIComponent(worktreeId)}/todos`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ todoIds }),
      },
    );
    if (!res.ok) {
      await parseError(res, 'Failed to reorder todos');
    }
  },
};
