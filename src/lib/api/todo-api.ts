/**
 * Repository ToDo API client for the Home ToDo widget.
 */

/** A ToDo item as consumed by the UI. */
export interface TodoItem {
  id: string;
  repositoryId: string;
  /** Repository name resolved by the API via JOIN (Issue #900). */
  repositoryName: string;
  /** Optional repository display-name override. */
  repositoryDisplayName?: string;
  content: string;
  done: boolean;
  position: number;
}

async function parseError(res: Response, fallback: string): Promise<never> {
  const data = await res.json().catch(() => ({}));
  throw new Error(data.error || `${fallback} (${res.status})`);
}

export const todoApi = {
  async list(repositoryId: string): Promise<TodoItem[]> {
    const res = await fetch(
      `/api/repositories/${encodeURIComponent(repositoryId)}/todos`,
    );
    if (!res.ok) {
      return parseError(res, 'Failed to load todos');
    }
    const data = (await res.json()) as { todos: TodoItem[] };
    return data.todos ?? [];
  },

  /**
   * List todos across all repositories (Issue #907). Used by the Home widget
   * to show a cross-repository list regardless of the selected target repo.
   */
  async listAll(): Promise<TodoItem[]> {
    const res = await fetch('/api/todos');
    if (!res.ok) {
      return parseError(res, 'Failed to load todos');
    }
    const data = (await res.json()) as { todos: TodoItem[] };
    return data.todos ?? [];
  },

  async create(repositoryId: string, content: string): Promise<TodoItem> {
    const res = await fetch(
      `/api/repositories/${encodeURIComponent(repositoryId)}/todos`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
      },
    );
    if (!res.ok) {
      return parseError(res, 'Failed to create todo');
    }
    const data = (await res.json()) as { todo: TodoItem };
    return data.todo;
  },

  async update(
    repositoryId: string,
    todoId: string,
    updates: { content?: string; done?: boolean },
  ): Promise<TodoItem> {
    const res = await fetch(
      `/api/repositories/${encodeURIComponent(repositoryId)}/todos/${encodeURIComponent(todoId)}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates),
      },
    );
    if (!res.ok) {
      return parseError(res, 'Failed to update todo');
    }
    const data = (await res.json()) as { todo: TodoItem };
    return data.todo;
  },

  async remove(repositoryId: string, todoId: string): Promise<void> {
    const res = await fetch(
      `/api/repositories/${encodeURIComponent(repositoryId)}/todos/${encodeURIComponent(todoId)}`,
      { method: 'DELETE' },
    );
    if (!res.ok) {
      await parseError(res, 'Failed to delete todo');
    }
  },
};

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
 * Client for the branch-scoped ToDo list (Issue #1015). URL structure mirrors
 * the repository ToDo client, keyed by `worktreeId`. Item updates use PATCH.
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
