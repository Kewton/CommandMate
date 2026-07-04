/**
 * TodoPane Component (Issue #1015)
 *
 * Branch (worktree)-scoped ToDo list. Shared by both surfaces:
 *   - PC: Activity Bar `ToDo` activity (WorktreeDetailDesktop.activityContent).
 *   - Mobile: `Tools` tab sub-tab (NotesAndLogsPane).
 *
 * Receives only `worktreeId` and manages its own state via `worktreeTodoApi`.
 * Checkbox-style add / toggle / delete / reorder (up/down). Modeled on the
 * Home TodoWidget and MemoPane conventions.
 */

'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { worktreeTodoApi, type WorktreeTodoItem } from '@/lib/api/todo-api';
import { MAX_TODO_CONTENT_LENGTH } from '@/config/todo-config';

export interface TodoPaneProps {
  /** Worktree ID to scope the todo list to. */
  worktreeId: string;
  /** Additional CSS classes for the root container. */
  className?: string;
}

export const TodoPane = React.memo(function TodoPane({
  worktreeId,
  className = '',
}: TodoPaneProps) {
  const [todos, setTodos] = useState<WorktreeTodoItem[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadTodos = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const items = await worktreeTodoApi.list(worktreeId);
      setTodos(items);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load todos');
      setTodos([]);
    } finally {
      setLoading(false);
    }
  }, [worktreeId]);

  useEffect(() => {
    void loadTodos();
  }, [loadTodos]);

  const handleAdd = useCallback(async () => {
    const content = input.trim();
    if (!content || busy) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const todo = await worktreeTodoApi.create(worktreeId, content);
      setTodos((prev) => [...prev, todo]);
      setInput('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add todo');
    } finally {
      setBusy(false);
    }
  }, [input, busy, worktreeId]);

  const handleToggle = useCallback(
    async (todo: WorktreeTodoItem) => {
      // Optimistic update for snappy checkbox feedback.
      setTodos((prev) =>
        prev.map((t) => (t.id === todo.id ? { ...t, done: !t.done } : t)),
      );
      setError(null);
      try {
        await worktreeTodoApi.update(worktreeId, todo.id, { done: !todo.done });
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to update todo');
        void loadTodos();
      }
    },
    [worktreeId, loadTodos],
  );

  const handleDelete = useCallback(
    async (todo: WorktreeTodoItem) => {
      setError(null);
      try {
        await worktreeTodoApi.remove(worktreeId, todo.id);
        setTodos((prev) => prev.filter((t) => t.id !== todo.id));
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to delete todo');
      }
    },
    [worktreeId],
  );

  const handleMove = useCallback(
    async (index: number, direction: -1 | 1) => {
      const target = index + direction;
      if (target < 0 || target >= todos.length) {
        return;
      }
      const next = [...todos];
      [next[index], next[target]] = [next[target], next[index]];
      setTodos(next);
      setError(null);
      try {
        await worktreeTodoApi.reorder(worktreeId, next.map((t) => t.id));
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to reorder todos');
        void loadTodos();
      }
    },
    [todos, worktreeId, loadTodos],
  );

  const handleInputKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      // Guard against IME composition (Enter confirms candidate, not submit).
      if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
        e.preventDefault();
        void handleAdd();
      }
    },
    [handleAdd],
  );

  const remainingCount = todos.filter((t) => !t.done).length;

  return (
    <div
      data-testid="todo-pane"
      className={`flex flex-col h-full overflow-y-auto p-4 ${className}`.trim()}
    >
      {/* Add form */}
      <div className="flex items-center gap-2 mb-3">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleInputKeyDown}
          maxLength={MAX_TODO_CONTENT_LENGTH}
          placeholder="Add a todo…"
          data-testid="todo-input"
          className="flex-1 min-w-0 rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 px-3 py-1.5 text-sm text-gray-900 dark:text-gray-100 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-cyan-400"
        />
        <button
          type="button"
          onClick={handleAdd}
          disabled={busy || input.trim().length === 0}
          data-testid="todo-add-button"
          className="shrink-0 rounded-md bg-cyan-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-cyan-700 disabled:opacity-50"
        >
          Add
        </button>
      </div>

      <div className="mb-2 flex justify-end">
        <span className="text-xs text-gray-400 dark:text-gray-500" data-testid="todo-remaining">
          {remainingCount} open
        </span>
      </div>

      {error && (
        <p className="mb-2 text-xs text-red-600 dark:text-red-400" data-testid="todo-error">
          {error}
        </p>
      )}

      {/* Todo list */}
      {loading ? (
        <p className="text-sm text-gray-400 dark:text-gray-500" data-testid="todo-loading">
          Loading…
        </p>
      ) : todos.length === 0 ? (
        <p className="text-sm text-gray-500 dark:text-gray-400" data-testid="todo-empty">
          No todos yet.
        </p>
      ) : (
        <ul className="space-y-1" data-testid="todo-list">
          {todos.map((todo, index) => (
            <li
              key={todo.id}
              className="flex items-center gap-2 rounded-md px-1 py-1 hover:bg-gray-50 dark:hover:bg-gray-700/40 group"
              data-testid="todo-item"
            >
              <label className="shrink-0 inline-flex min-h-[44px] min-w-[44px] cursor-pointer items-center justify-center sm:min-h-0 sm:min-w-0">
                <input
                  type="checkbox"
                  checked={todo.done}
                  onChange={() => handleToggle(todo)}
                  data-testid="todo-checkbox"
                  aria-label={todo.done ? 'Mark as not done' : 'Mark as done'}
                  className="h-4 w-4 rounded border-gray-300 text-cyan-600 focus:ring-cyan-400"
                />
              </label>
              <span
                className={`min-w-0 flex-1 break-words text-sm ${
                  todo.done
                    ? 'line-through text-gray-400 dark:text-gray-500'
                    : 'text-gray-800 dark:text-gray-200'
                }`}
              >
                {todo.content}
              </span>
              <div className="flex shrink-0 items-center gap-1">
                <button
                  type="button"
                  onClick={() => handleMove(index, -1)}
                  disabled={index === 0}
                  aria-label="Move up"
                  data-testid="todo-move-up"
                  className="p-1 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 disabled:opacity-30"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
                  </svg>
                </button>
                <button
                  type="button"
                  onClick={() => handleMove(index, 1)}
                  disabled={index === todos.length - 1}
                  aria-label="Move down"
                  data-testid="todo-move-down"
                  className="p-1 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 disabled:opacity-30"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                  </svg>
                </button>
                <button
                  type="button"
                  onClick={() => handleDelete(todo)}
                  aria-label="Delete todo"
                  data-testid="todo-delete"
                  className="inline-flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center text-gray-300 opacity-100 transition-opacity hover:text-red-500 dark:text-gray-600 dark:hover:text-red-400 sm:min-h-0 sm:min-w-0 sm:opacity-0 sm:group-hover:opacity-100"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
});

export default TodoPane;
