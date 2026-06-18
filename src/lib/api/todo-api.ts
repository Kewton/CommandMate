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
