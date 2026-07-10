/**
 * Unit tests for the branch-scoped worktreeTodoApi client (Issue #1015).
 *
 * Exercises the fetch wrappers (list/create/update/remove/reorder) including
 * URL/verb correctness (item update uses PATCH; reorder PATCHes the collection)
 * and error propagation from the API error payload.
 *
 * @vitest-environment node
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { worktreeTodoApi, type WorktreeTodoItem } from '@/lib/api/todo-api';

const TODO: WorktreeTodoItem = {
  id: 't1',
  worktreeId: 'wt-1',
  content: 'task',
  detail: '',
  status: 'todo',
  done: false,
  position: 0,
};

function mockFetchOnce(body: unknown, ok = true, status = 200) {
  global.fetch = vi.fn(async () => ({
    ok,
    status,
    json: async () => body,
  })) as unknown as typeof fetch;
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('worktreeTodoApi', () => {
  it('list() GETs the worktree todos and returns the array', async () => {
    mockFetchOnce({ todos: [TODO] });
    const result = await worktreeTodoApi.list('wt-1');
    expect(result).toEqual([TODO]);
    expect(global.fetch).toHaveBeenCalledWith('/api/worktrees/wt-1/todos');
  });

  it('list() returns [] when todos is absent', async () => {
    mockFetchOnce({});
    expect(await worktreeTodoApi.list('wt-1')).toEqual([]);
  });

  it('create() POSTs content and returns the created todo', async () => {
    mockFetchOnce({ todo: TODO }, true, 201);
    const result = await worktreeTodoApi.create('wt-1', 'task');
    expect(result).toEqual(TODO);
    const [url, init] = (global.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe('/api/worktrees/wt-1/todos');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ content: 'task' });
  });

  it('create() includes detail when provided (Issue #1034)', async () => {
    mockFetchOnce({ todo: { ...TODO, detail: 'notes' } }, true, 201);
    const result = await worktreeTodoApi.create('wt-1', 'task', 'notes');
    expect(result.detail).toBe('notes');
    const [, init] = (global.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(JSON.parse(init.body)).toEqual({ content: 'task', detail: 'notes' });
  });

  it('create() omits detail from the body when not provided', async () => {
    mockFetchOnce({ todo: TODO }, true, 201);
    await worktreeTodoApi.create('wt-1', 'task');
    const [, init] = (global.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(JSON.parse(init.body)).toEqual({ content: 'task' });
  });

  it('update() sends a detail change (Issue #1034)', async () => {
    mockFetchOnce({ todo: { ...TODO, detail: 'edited' } });
    const result = await worktreeTodoApi.update('wt-1', 't1', { detail: 'edited' });
    expect(result.detail).toBe('edited');
    const [, init] = (global.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(JSON.parse(init.body)).toEqual({ detail: 'edited' });
  });

  it('update() sends content and detail together', async () => {
    mockFetchOnce({ todo: { ...TODO, content: 'new', detail: 'edited' } });
    await worktreeTodoApi.update('wt-1', 't1', { content: 'new', detail: 'edited' });
    const [, init] = (global.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(JSON.parse(init.body)).toEqual({ content: 'new', detail: 'edited' });
  });

  it('update() uses PATCH on the item route', async () => {
    mockFetchOnce({ todo: { ...TODO, done: true } });
    const result = await worktreeTodoApi.update('wt-1', 't1', { done: true });
    expect(result.done).toBe(true);
    const [url, init] = (global.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe('/api/worktrees/wt-1/todos/t1');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body)).toEqual({ done: true });
  });

  it('update() sends a status change', async () => {
    mockFetchOnce({ todo: { ...TODO, status: 'doing' } });
    const result = await worktreeTodoApi.update('wt-1', 't1', { status: 'doing' });
    expect(result.status).toBe('doing');
    const [, init] = (global.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(JSON.parse(init.body)).toEqual({ status: 'doing' });
  });

  it('remove() uses DELETE on the item route', async () => {
    mockFetchOnce({ success: true });
    await worktreeTodoApi.remove('wt-1', 't1');
    const [url, init] = (global.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe('/api/worktrees/wt-1/todos/t1');
    expect(init.method).toBe('DELETE');
  });

  it('reorder() PATCHes the collection route with todoIds', async () => {
    mockFetchOnce({ success: true });
    await worktreeTodoApi.reorder('wt-1', ['t2', 't1']);
    const [url, init] = (global.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe('/api/worktrees/wt-1/todos');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body)).toEqual({ todoIds: ['t2', 't1'] });
  });

  it('propagates the API error message on a non-ok response', async () => {
    mockFetchOnce({ error: 'Maximum todo limit (50) reached' }, false, 400);
    await expect(worktreeTodoApi.create('wt-1', 'x')).rejects.toThrow('Maximum todo limit (50) reached');
  });

  it('falls back to a generic error when no error payload is present', async () => {
    mockFetchOnce({}, false, 500);
    await expect(worktreeTodoApi.list('wt-1')).rejects.toThrow('Failed to load todos');
  });

  it('encodes the worktree id in the URL', async () => {
    mockFetchOnce({ todos: [] });
    await worktreeTodoApi.list('repo/feature x');
    expect(global.fetch).toHaveBeenCalledWith('/api/worktrees/repo%2Ffeature%20x/todos');
  });
});
