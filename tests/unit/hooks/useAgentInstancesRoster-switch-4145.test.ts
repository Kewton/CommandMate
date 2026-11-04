/**
 * Issue #4145: a roster write outlives a worktree switch, and the hook reads the latest
 * `onInstancesChange` through a ref, so after the switch that callback is the one for the
 * new worktree. The saved roster belongs to the worktree it was written to.
 *
 * Negative control: no switch, the callback hears it as before.
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { AgentInstance } from '@/lib/cli-tools/types';
import { useAgentInstanceCreate, useAgentInstancesRoster } from '@/hooks/useAgentInstancesRoster';
import { clearRosterSnapshot } from '@/hooks/useInstanceRoleSettings';
import { FakeRoleServer } from '../components/roles/fake-role-server';

const A = 'wt-4145-roster-a';
const B = 'wt-4145-roster-b';
const CLAUDE: AgentInstance = { id: 'claude', cliTool: 'claude', alias: 'Claude', order: 0 };
const TWO: AgentInstance = { id: 'claude-2', cliTool: 'claude', alias: 'Claude 2', order: 1 };
const add = (base: AgentInstance[]) => [...base, { ...TWO, order: base.length }];

describe('[#4145] a roster write answered after the worktree switched', () => {
  let release: () => void;
  let sent: Promise<void>;

  beforeEach(() => {
    const server = new FakeRoleServer([CLAUDE]);
    const passOn = server.fetch as unknown as typeof fetch;
    let markSent: () => void = () => {};
    sent = new Promise((resolve) => { markSent = resolve; });
    const held = new Promise<void>((resolve) => { release = resolve; });
    global.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'PATCH' || init?.method === 'POST') {
        markSent();
        await held;
      }
      return passOn(url, init);
    }) as unknown as typeof fetch;
    clearRosterSnapshot(A);
    clearRosterSnapshot(B);
  });
  afterEach(() => {
    clearRosterSnapshot(A);
    clearRosterSnapshot(B);
  });

  it('write: neither the callback of the new worktree nor the old one hears it', async () => {
    const forA = vi.fn();
    const forB = vi.fn();
    const hook = renderHook(
      ({ id, callback }) => useAgentInstancesRoster(id, callback),
      { initialProps: { id: A, callback: forA } },
    );
    const writing = hook.result.current(add);
    await sent;
    hook.rerender({ id: B, callback: forB });
    await act(async () => {
      release();
      await writing;
    });
    expect(forA).not.toHaveBeenCalled();
    expect(forB).not.toHaveBeenCalled();
  });

  it('create: the same', async () => {
    const forA = vi.fn();
    const forB = vi.fn();
    const hook = renderHook(
      ({ id, callback }) => useAgentInstanceCreate(id, callback),
      { initialProps: { id: A, callback: forA } },
    );
    const creating = hook.result.current(
      () => ({ id: TWO.id, cliTool: TWO.cliTool, alias: TWO.alias }),
      { state: 'inherit' },
    );
    await sent;
    hook.rerender({ id: B, callback: forB });
    await act(async () => {
      release();
      await creating;
    });
    expect(forA).not.toHaveBeenCalled();
    expect(forB).not.toHaveBeenCalled();
  });

  it('no switch: the latest callback hears the saved roster (negative control)', async () => {
    const first = vi.fn();
    const latest = vi.fn();
    const hook = renderHook(
      ({ id, callback }) => useAgentInstancesRoster(id, callback),
      { initialProps: { id: A, callback: first } },
    );
    const writing = hook.result.current(add);
    await sent;
    hook.rerender({ id: A, callback: latest });
    await act(async () => {
      release();
      await writing;
    });
    expect(first).not.toHaveBeenCalled();
    expect(latest).toHaveBeenCalledTimes(1);
    expect(latest.mock.calls[0][0].map((row: AgentInstance) => row.id)).toEqual(['claude', 'claude-2']);
  });
});
