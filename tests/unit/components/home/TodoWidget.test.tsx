/**
 * Unit tests for the Home TodoWidget (Issue #907).
 *
 * Verifies the cross-repository behavior:
 * - the list is loaded via todoApi.listAll() (not scoped to the dropdown),
 * - changing the dropdown does NOT refetch/filter the list,
 * - toggle/delete operate on each todo's own repositoryId,
 * - add uses the selected dropdown repository and refreshes via listAll().
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { TodoWidget } from '@/components/home/TodoWidget';
import { todoApi, type TodoItem } from '@/lib/api/todo-api';

vi.mock('@/lib/api/todo-api', () => ({
  todoApi: {
    list: vi.fn(),
    listAll: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
  },
}));

const mockedApi = vi.mocked(todoApi);

const REPOS = [
  { id: 'repo-a', path: '/path/a', name: 'Alpha' },
  { id: 'repo-b', path: '/path/b', name: 'Beta' },
];

const TODOS: TodoItem[] = [
  {
    id: 't1',
    repositoryId: 'repo-a',
    repositoryName: 'Alpha',
    content: 'alpha task',
    done: false,
    position: 0,
  },
  {
    id: 't2',
    repositoryId: 'repo-b',
    repositoryName: 'Beta',
    content: 'beta task',
    done: false,
    position: 0,
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/api/worktrees')) {
      return { ok: true, json: async () => ({ repositories: REPOS }) } as Response;
    }
    return { ok: false, json: async () => ({}) } as Response;
  }) as unknown as typeof fetch;
  mockedApi.listAll.mockResolvedValue(TODOS);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('TodoWidget (Issue #907)', () => {
  it('loads all todos via listAll and shows todos from every repository', async () => {
    render(<TodoWidget />);

    await waitFor(() => expect(mockedApi.listAll).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('alpha task')).toBeInTheDocument();
    expect(screen.getByText('beta task')).toBeInTheDocument();
    expect(mockedApi.list).not.toHaveBeenCalled();

    // Each row carries a repository badge for cross-repo disambiguation.
    const badges = screen
      .getAllByTestId('todo-repo-badge')
      .map((b) => b.textContent);
    expect(badges).toContain('Alpha');
    expect(badges).toContain('Beta');
  });

  it('does not refetch/filter the list when the target repository dropdown changes', async () => {
    render(<TodoWidget />);
    await waitFor(() => expect(mockedApi.listAll).toHaveBeenCalledTimes(1));
    await screen.findByText('alpha task');

    const select = screen.getByTestId('todo-repo-select') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'repo-b' } });

    // The list stays fully populated and listAll is not called again.
    expect(mockedApi.listAll).toHaveBeenCalledTimes(1);
    expect(mockedApi.list).not.toHaveBeenCalled();
    expect(screen.getByText('alpha task')).toBeInTheDocument();
    expect(screen.getByText('beta task')).toBeInTheDocument();
  });

  it('toggles a todo using its own repositoryId', async () => {
    mockedApi.update.mockResolvedValue(TODOS[1]);
    render(<TodoWidget />);
    await screen.findByText('beta task');

    // Second checkbox corresponds to the Beta (repo-b) todo.
    const checkboxes = screen.getAllByTestId('todo-checkbox');
    fireEvent.click(checkboxes[1]);

    await waitFor(() =>
      expect(mockedApi.update).toHaveBeenCalledWith('repo-b', 't2', { done: true }),
    );
  });

  it('deletes a todo using its own repositoryId', async () => {
    mockedApi.remove.mockResolvedValue(undefined);
    render(<TodoWidget />);
    await screen.findByText('alpha task');

    // First delete button corresponds to the Alpha (repo-a) todo.
    const deleteButtons = screen.getAllByTestId('todo-delete');
    fireEvent.click(deleteButtons[0]);

    await waitFor(() =>
      expect(mockedApi.remove).toHaveBeenCalledWith('repo-a', 't1'),
    );
  });

  it('creates a todo for the selected dropdown repository and refreshes via listAll', async () => {
    mockedApi.create.mockResolvedValue(TODOS[1]);
    render(<TodoWidget />);
    await waitFor(() => expect(mockedApi.listAll).toHaveBeenCalledTimes(1));
    await screen.findByText('alpha task');

    const select = screen.getByTestId('todo-repo-select') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'repo-b' } });

    const input = screen.getByTestId('todo-input');
    fireEvent.change(input, { target: { value: 'new task' } });
    fireEvent.click(screen.getByTestId('todo-add-button'));

    await waitFor(() =>
      expect(mockedApi.create).toHaveBeenCalledWith('repo-b', 'new task'),
    );
    // The post-add refresh re-uses the cross-repo listAll, never the per-repo list.
    await waitFor(() => expect(mockedApi.listAll).toHaveBeenCalledTimes(2));
    expect(mockedApi.list).not.toHaveBeenCalled();
  });
});
