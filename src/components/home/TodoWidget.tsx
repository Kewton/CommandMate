/**
 * TodoWidget Component
 *
 * Home page lightweight ToDo widget. A single global widget that lists ToDo /
 * memo items across all repositories (Issue #907). The dropdown selects only
 * the *target* repository for newly added items; the displayed list is always
 * the cross-repository set and is not filtered by the selection.
 *
 * Repository list is fetched from GET /api/worktrees (the same `repositories`
 * array used by the Home Assistant chat). The cross-repo list is loaded via
 * GET /api/todos; creation/toggle/delete go through /api/repositories/:id/todos
 * keyed by each todo's own repository id.
 */

'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, Card, Input } from '@/components/ui';
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

  // Load the cross-repository todo list (Issue #907): not scoped to the
  // selected repository, so the dropdown never filters the displayed list.
  const loadTodos = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const items = await todoApi.listAll();
      setTodos(items);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load todos');
      setTodos([]);
    } finally {
      setLoading(false);
    }
  }, []);

  // Load all todos once on mount; the list is repository-agnostic.
  useEffect(() => {
    void loadTodos();
  }, [loadTodos]);

  // Persist the selected target repository (used for new todos only). Changing
  // it must NOT reload/filter the list — only the add target changes.
  useEffect(() => {
    if (!selectedRepoId) {
      return;
    }
    if (typeof window !== 'undefined') {
      localStorage.setItem(SELECTED_REPO_KEY, selectedRepoId);
    }
  }, [selectedRepoId]);

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
      await loadTodos();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add todo');
    } finally {
      setBusy(false);
    }
  }, [input, selectedRepoId, busy, loadTodos]);

  const handleToggle = useCallback(
    async (todo: TodoItem) => {
      // Optimistic update for snappy checkbox feedback.
      setTodos((prev) =>
        prev.map((t) => (t.id === todo.id ? { ...t, done: !t.done } : t)),
      );
      setError(null);
      try {
        // Operate on the todo's own repository, not the dropdown selection,
        // so cross-repo todos toggle correctly (Issue #907).
        await todoApi.update(todo.repositoryId, todo.id, { done: !todo.done });
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to update todo');
        void loadTodos();
      }
    },
    [loadTodos],
  );

  const handleDelete = useCallback(async (todo: TodoItem) => {
    setError(null);
    try {
      // Use the todo's own repository id so cross-repo deletes don't 404.
      await todoApi.remove(todo.repositoryId, todo.id);
      setTodos((prev) => prev.filter((t) => t.id !== todo.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete todo');
    }
  }, []);

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
    <Card className="h-full" data-testid="home-todo-widget">
      {/* Tile heading — parity with the Session Overview tile (Issue #1052). */}
      <h2 className="mb-3 text-lg font-semibold text-gray-900 dark:text-gray-100">
        ToDo
      </h2>

      {/* Repository selector + remaining count.
          Mobile: stack vertically so the select can use the full width; the
          `N open` count drops to its own line. Desktop (>= sm): unchanged
          single-row layout with the select capped at 16rem (Issue #909). */}
      <div
        className="flex flex-col gap-2 mb-3 sm:flex-row sm:items-center sm:justify-between sm:gap-3"
        data-testid="todo-selector-row"
      >
        <label className="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-400 min-w-0">
          <span className="shrink-0">Repository</span>
          <select
            value={selectedRepoId}
            onChange={(e) => setSelectedRepoId(e.target.value)}
            disabled={!hasRepositories}
            data-testid="todo-repo-select"
            className="min-w-0 flex-1 truncate rounded-md border border-input bg-surface dark:bg-surface-2 px-2 py-1 text-sm text-surface-foreground disabled:opacity-50 sm:flex-initial sm:max-w-[16rem]"
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
            <Input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleInputKeyDown}
              maxLength={MAX_TODO_CONTENT_LENGTH}
              placeholder="Add a todo…"
              data-testid="todo-input"
              className="w-auto flex-1 min-w-0"
            />
            <Button
              type="button"
              variant="primary"
              size="sm"
              onClick={handleAdd}
              disabled={busy || input.trim().length === 0}
              data-testid="todo-add-button"
              className="shrink-0"
            >
              Add
            </Button>
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
                  className="flex flex-col gap-1 rounded-md px-1 py-1 hover:bg-gray-50 dark:hover:bg-gray-700/40 group sm:flex-row sm:items-center sm:gap-2"
                  data-testid="todo-item"
                >
                  {/* Top row (mobile) / left section (desktop): checkbox + content.
                      The checkbox is wrapped in a label that provides a ~44px
                      touch target on mobile while the box itself stays small
                      (Issue #909). */}
                  <div className="flex min-w-0 flex-1 items-center gap-2">
                    <label className="shrink-0 inline-flex min-h-[44px] min-w-[44px] cursor-pointer items-center justify-center sm:min-h-0 sm:min-w-0">
                      <input
                        type="checkbox"
                        checked={todo.done}
                        onChange={() => handleToggle(todo)}
                        data-testid="todo-checkbox"
                        aria-label={todo.done ? 'Mark as not done' : 'Mark as done'}
                        className="h-4 w-4 rounded border-gray-300 text-accent-600 focus:ring-ring"
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
                  </div>
                  {/* Bottom row (mobile) / right section (desktop): repo badge +
                      delete. On mobile the delete button is always visible with
                      a ~44px touch target; on desktop the original hover-reveal
                      (sm:opacity-0 → sm:group-hover) is restored (Issue #909). */}
                  <div className="flex shrink-0 items-center justify-end gap-2">
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
                      className="inline-flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center text-gray-300 opacity-100 transition-opacity hover:text-red-500 dark:text-gray-600 dark:hover:text-red-400 sm:min-h-0 sm:min-w-0 sm:opacity-0 sm:group-hover:opacity-100"
                    >
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </Card>
  );
}
