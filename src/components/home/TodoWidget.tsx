/**
 * TodoWidget Component
 *
 * Home page lightweight ToDo widget. A single global widget where the user
 * picks a target repository and jots down checkbox-style ToDo / memo items
 * scoped to that repository.
 *
 * Repository list is fetched from GET /api/worktrees (the same `repositories`
 * array used by the Home Assistant chat). ToDos are keyed by repository id and
 * persisted via /api/repositories/:id/todos.
 */

'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { todoApi, type TodoItem } from '@/lib/api/todo-api';
import { MAX_TODO_CONTENT_LENGTH } from '@/config/todo-config';

interface RepositoryOption {
  id: string;
  path: string;
  name: string;
  displayName?: string;
}

/** localStorage key remembering the last-selected repository for the widget. */
const SELECTED_REPO_KEY = 'commandmate-home-todo-repo';

function repoLabel(repo: RepositoryOption): string {
  return repo.displayName?.trim() || repo.name;
}

/** Human-readable repository name for a todo (Issue #900). */
function todoRepoLabel(todo: TodoItem): string {
  return todo.repositoryDisplayName?.trim() || todo.repositoryName || '';
}

export function TodoWidget() {
  const [repositories, setRepositories] = useState<RepositoryOption[]>([]);
  const [selectedRepoId, setSelectedRepoId] = useState('');
  const [todos, setTodos] = useState<TodoItem[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reposLoaded = useRef(false);

  const remainingCount = useMemo(
    () => todos.filter((t) => !t.done).length,
    [todos],
  );

  // Load repositories once.
  useEffect(() => {
    async function fetchRepos() {
      try {
        const res = await fetch('/api/worktrees');
        if (!res.ok) {
          return;
        }
        const data = await res.json();
        const repos: RepositoryOption[] = (data.repositories ?? []).map(
          (repo: { id: string; path: string; name: string; displayName?: string }) => ({
            id: repo.id,
            path: repo.path,
            name: repo.name,
            displayName: repo.displayName,
          }),
        );
        setRepositories(repos);

        if (repos.length > 0) {
          const saved =
            typeof window !== 'undefined'
              ? localStorage.getItem(SELECTED_REPO_KEY)
              : null;
          const initial =
            saved && repos.some((r) => r.id === saved) ? saved : repos[0].id;
          setSelectedRepoId(initial);
        }
      } catch {
        // Silent fetch failure on home page
      } finally {
        reposLoaded.current = true;
      }
    }
    void fetchRepos();
  }, []);

  const loadTodos = useCallback(async (repositoryId: string) => {
    if (!repositoryId) {
      setTodos([]);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const items = await todoApi.list(repositoryId);
      setTodos(items);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load todos');
      setTodos([]);
    } finally {
      setLoading(false);
    }
  }, []);

  // Reload todos whenever the selected repository changes.
  useEffect(() => {
    if (!selectedRepoId) {
      return;
    }
    if (typeof window !== 'undefined') {
      localStorage.setItem(SELECTED_REPO_KEY, selectedRepoId);
    }
    void loadTodos(selectedRepoId);
  }, [selectedRepoId, loadTodos]);

  const handleAdd = useCallback(async () => {
    const content = input.trim();
    if (!content || !selectedRepoId || busy) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await todoApi.create(selectedRepoId, content);
      setInput('');
      await loadTodos(selectedRepoId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add todo');
    } finally {
      setBusy(false);
    }
  }, [input, selectedRepoId, busy, loadTodos]);

  const handleToggle = useCallback(
    async (todo: TodoItem) => {
      if (!selectedRepoId) {
        return;
      }
      // Optimistic update for snappy checkbox feedback.
      setTodos((prev) =>
        prev.map((t) => (t.id === todo.id ? { ...t, done: !t.done } : t)),
      );
      setError(null);
      try {
        await todoApi.update(selectedRepoId, todo.id, { done: !todo.done });
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to update todo');
        void loadTodos(selectedRepoId);
      }
    },
    [selectedRepoId, loadTodos],
  );

  const handleDelete = useCallback(
    async (todo: TodoItem) => {
      if (!selectedRepoId) {
        return;
      }
      setError(null);
      try {
        await todoApi.remove(selectedRepoId, todo.id);
        setTodos((prev) => prev.filter((t) => t.id !== todo.id));
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to delete todo');
      }
    },
    [selectedRepoId],
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

  const hasRepositories = repositories.length > 0;

  return (
    <div
      className="bg-white dark:bg-gray-800 rounded-lg p-4 border border-gray-200 dark:border-gray-700"
      data-testid="home-todo-widget"
    >
      {/* Repository selector + remaining count */}
      <div className="flex items-center justify-between gap-3 mb-3">
        <label className="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-400 min-w-0">
          <span className="shrink-0">Repository</span>
          <select
            value={selectedRepoId}
            onChange={(e) => setSelectedRepoId(e.target.value)}
            disabled={!hasRepositories}
            data-testid="todo-repo-select"
            className="min-w-0 max-w-[16rem] truncate rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 px-2 py-1 text-sm text-gray-900 dark:text-gray-100 disabled:opacity-50"
          >
            {repositories.map((repo) => (
              <option key={repo.id} value={repo.id}>
                {repoLabel(repo)}
              </option>
            ))}
          </select>
        </label>
        {hasRepositories && (
          <span className="shrink-0 text-xs text-gray-400 dark:text-gray-500" data-testid="todo-remaining">
            {remainingCount} open
          </span>
        )}
      </div>

      {!hasRepositories ? (
        <p className="text-sm text-gray-500 dark:text-gray-400">
          No repositories yet. Add one from the Repositories screen to start
          adding todos.
        </p>
      ) : (
        <>
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

          {error && (
            <p className="mb-2 text-xs text-red-600 dark:text-red-400" data-testid="todo-error">
              {error}
            </p>
          )}

          {/* Todo list */}
          {loading ? (
            <p className="text-sm text-gray-400 dark:text-gray-500">Loading…</p>
          ) : todos.length === 0 ? (
            <p className="text-sm text-gray-500 dark:text-gray-400" data-testid="todo-empty">
              No todos yet.
            </p>
          ) : (
            <ul className="space-y-1" data-testid="todo-list">
              {todos.map((todo) => (
                <li
                  key={todo.id}
                  className="flex items-center gap-2 rounded-md px-1 py-1 hover:bg-gray-50 dark:hover:bg-gray-700/40 group"
                  data-testid="todo-item"
                >
                  <input
                    type="checkbox"
                    checked={todo.done}
                    onChange={() => handleToggle(todo)}
                    data-testid="todo-checkbox"
                    aria-label={todo.done ? 'Mark as not done' : 'Mark as done'}
                    className="shrink-0 h-4 w-4 rounded border-gray-300 text-cyan-600 focus:ring-cyan-400"
                  />
                  <span
                    className={`flex-1 min-w-0 break-words text-sm ${
                      todo.done
                        ? 'line-through text-gray-400 dark:text-gray-500'
                        : 'text-gray-800 dark:text-gray-200'
                    }`}
                  >
                    {todo.content}
                  </span>
                  {todoRepoLabel(todo) && (
                    <span
                      className="shrink-0 max-w-[8rem] truncate rounded-full bg-gray-100 dark:bg-gray-700 px-2 py-0.5 text-[10px] font-medium text-gray-500 dark:text-gray-400"
                      data-testid="todo-repo-badge"
                      title={todoRepoLabel(todo)}
                    >
                      {todoRepoLabel(todo)}
                    </span>
                  )}
                  <button
                    type="button"
                    onClick={() => handleDelete(todo)}
                    aria-label="Delete todo"
                    data-testid="todo-delete"
                    className="shrink-0 text-gray-300 hover:text-red-500 dark:text-gray-600 dark:hover:text-red-400 opacity-0 group-hover:opacity-100 transition-opacity"
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
