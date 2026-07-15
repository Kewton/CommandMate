/**
 * Unit tests for schedules/route.ts
 * Regression test for: GET should return both enabled and disabled schedules
 * so the UI (introduced in #824) can edit/toggle/delete disabled rows.
 * @vitest-environment node
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

interface Row {
  id: string;
  worktree_id: string;
  name: string;
  enabled: 0 | 1;
}

const allMock = vi.fn<(...args: unknown[]) => Row[]>();
const prepareMock = vi.fn((_sql: string) => ({ all: allMock }));

vi.mock('@/lib/db/db-instance', () => ({
  getDbInstance: vi.fn(() => ({ prepare: prepareMock })),
}));

vi.mock('@/lib/db', () => ({
  getWorktreeById: vi.fn(),
}));

vi.mock('@/lib/logger', () => ({
  createLogger: vi.fn(() => ({
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  })),
}));

import { GET } from '@/app/api/worktrees/[id]/schedules/route';
import { getWorktreeById } from '@/lib/db';

function makeReq(): NextRequest {
  return new NextRequest('http://localhost:3000/api/worktrees/wt-1/schedules', { method: 'GET' });
}

describe('GET /api/worktrees/[id]/schedules', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getWorktreeById).mockReturnValue({ id: 'wt-1', path: '/wt-1' } as never);
  });

  it('returns both enabled (1) and disabled (0) rows so the UI can manage every CMATE.md entry', async () => {
    allMock.mockReturnValue([
      { id: 'a', worktree_id: 'wt-1', name: 'enabled-one', enabled: 1 },
      { id: 'b', worktree_id: 'wt-1', name: 'disabled-one', enabled: 0 },
      { id: 'c', worktree_id: 'wt-1', name: 'disabled-two', enabled: 0 },
    ]);

    const res = await GET(makeReq(), { params: Promise.resolve({ id: 'wt-1' }) });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.schedules).toHaveLength(3);
    expect(body.schedules.map((s: Row) => s.name)).toEqual([
      'enabled-one',
      'disabled-one',
      'disabled-two',
    ]);
  });

  it('SQL must not filter by enabled (regression: pre-fix query was AND enabled = 1)', async () => {
    allMock.mockReturnValue([]);
    await GET(makeReq(), { params: Promise.resolve({ id: 'wt-1' }) });

    expect(prepareMock).toHaveBeenCalled();
    const sql = prepareMock.mock.calls[0][0];
    expect(sql).not.toMatch(/enabled\s*=\s*1/);
    expect(sql).toMatch(/WHERE\s+worktree_id\s*=\s*\?/);
  });
});
