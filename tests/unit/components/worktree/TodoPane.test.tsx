/**
 * Unit tests for the branch-scoped TodoPane (Issue #1015).
 *
 * Verifies the shared component actually renders and drives the worktree ToDo
 * CRUD via `worktreeTodoApi` ([S3-002]: the component must really render, not be
 * silently dropped by the Partial<Record> activityContent map). Covers load,
 * add, toggle, delete, and scope-by-worktreeId.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { TodoPane } from '@/components/worktree/TodoPane';
import { worktreeTodoApi, type WorktreeTodoItem } from '@/lib/api/todo-api';

vi.mock('@/lib/api/todo-api', () => ({
  worktreeTodoApi: {
    list: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
    reorder: vi.fn(),
  },
}));

const mockedApi = vi.mocked(worktreeTodoApi);

const TODOS: WorktreeTodoItem[] = [
  { id: 't1', worktreeId: 'wt-1', content: 'first task', done: false, position: 0 },
  { id: 't2', worktreeId: 'wt-1', content: 'second task', done: true, position: 1 },
];

beforeEach(() => {
  vi.clearAllMocks();
  mockedApi.list.mockResolvedValue(TODOS);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('TodoPane', () => {
  it('renders the todo list loaded for the worktree', async () => {
    render(<TodoPane worktreeId="wt-1" />);

    expect(await screen.findByText('first task')).toBeInTheDocument();
    expect(screen.getByText('second task')).toBeInTheDocument();
    expect(mockedApi.list).toHaveBeenCalledWith('wt-1');
  });

  it('shows the empty state when there are no todos', async () => {
    mockedApi.list.mockResolvedValue([]);
    render(<TodoPane worktreeId="wt-1" />);

    expect(await screen.findByTestId('todo-empty')).toBeInTheDocument();
  });

  it('adds a todo via worktreeTodoApi.create', async () => {
    mockedApi.list.mockResolvedValue([]);
    mockedApi.create.mockResolvedValue({
      id: 't-new',
      worktreeId: 'wt-1',
      content: 'brand new',
      done: false,
      position: 0,
    });

    render(<TodoPane worktreeId="wt-1" />);
    await screen.findByTestId('todo-empty');

    fireEvent.change(screen.getByTestId('todo-input'), { target: { value: 'brand new' } });
    fireEvent.click(screen.getByTestId('todo-add-button'));

    await waitFor(() => {
      expect(mockedApi.create).toHaveBeenCalledWith('wt-1', 'brand new');
    });
    expect(await screen.findByText('brand new')).toBeInTheDocument();
  });

  it('toggles a todo done state via worktreeTodoApi.update', async () => {
    mockedApi.update.mockResolvedValue({ ...TODOS[0], done: true });
    render(<TodoPane worktreeId="wt-1" />);
    await screen.findByText('first task');

    const checkboxes = screen.getAllByTestId('todo-checkbox');
    fireEvent.click(checkboxes[0]);

    await waitFor(() => {
      expect(mockedApi.update).toHaveBeenCalledWith('wt-1', 't1', { done: true });
    });
  });

  it('deletes a todo via worktreeTodoApi.remove', async () => {
    mockedApi.remove.mockResolvedValue(undefined);
    render(<TodoPane worktreeId="wt-1" />);
    await screen.findByText('first task');

    const deleteButtons = screen.getAllByTestId('todo-delete');
    fireEvent.click(deleteButtons[0]);

    await waitFor(() => {
      expect(mockedApi.remove).toHaveBeenCalledWith('wt-1', 't1');
    });
    await waitFor(() => {
      expect(screen.queryByText('first task')).not.toBeInTheDocument();
    });
  });

  it('reorders todos via worktreeTodoApi.reorder when moving down', async () => {
    mockedApi.reorder.mockResolvedValue(undefined);
    render(<TodoPane worktreeId="wt-1" />);
    await screen.findByText('first task');

    // Move the first item down -> new order [t2, t1].
    fireEvent.click(screen.getAllByTestId('todo-move-down')[0]);

    await waitFor(() => {
      expect(mockedApi.reorder).toHaveBeenCalledWith('wt-1', ['t2', 't1']);
    });
  });

  it('reloads the authoritative order when reorder fails', async () => {
    mockedApi.reorder.mockRejectedValue(new Error('reorder boom'));
    render(<TodoPane worktreeId="wt-1" />);
    await screen.findByText('first task');

    fireEvent.click(screen.getAllByTestId('todo-move-down')[0]);

    await waitFor(() => {
      expect(mockedApi.reorder).toHaveBeenCalled();
    });
    // On failure the component re-fetches the authoritative order (rollback).
    await waitFor(() => {
      expect(mockedApi.list).toHaveBeenCalledTimes(2);
    });
  });

  it('shows an error state when the initial load fails', async () => {
    mockedApi.list.mockRejectedValue(new Error('load failed'));
    render(<TodoPane worktreeId="wt-1" />);

    expect(await screen.findByTestId('todo-error')).toHaveTextContent('load failed');
    expect(screen.getByTestId('todo-empty')).toBeInTheDocument();
  });
});
