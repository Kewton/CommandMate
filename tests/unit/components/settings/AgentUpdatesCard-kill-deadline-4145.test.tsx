/**
 * The card's restart gets the deadline the role pane's has (Issue #4145, after #4133):
 * a kill with no answer ends, and a deadline, a 5xx or no answer say nothing about
 * whether the session ended, so what is running now decides.
 *
 * Positive controls: the deadline and every "says nothing" test fail on the code before
 * this Issue. Negative controls: an answered kill, a 404 and a refusal behave as they did.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import en from '../../../../locales/en/common.json';
import ja from '../../../../locales/ja/common.json';

vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock('en');
});

import { AgentUpdatesCard } from '@/components/settings/AgentUpdatesCard';

const VERSIONS = {
  status: 'success',
  updatable: ['codex'],
  tools: [{
    tool: 'codex',
    installed: '0.149.1',
    latestVersion: '0.151.0',
    dismissedVersion: null,
    updateAvailable: true,
    dismissedInCodex: false,
    updatable: true,
    source: 'version.json',
  }],
};
const INSTANCES = [{ id: 'codex-2', cliTool: 'codex', alias: 'Codex 2' }];

type KillBehaviour = 'stall' | 'reject' | number;

interface Server {
  kill: KillBehaviour;
  /** `sessionStatusByInstance` the next worktree read answers; null answers 500. */
  running: Record<string, { isRunning: boolean }> | null;
  killCalls: Array<{ url: string; signal: AbortSignal | undefined }>;
  worktreeReads: () => number;
}

function installServer(kill: KillBehaviour): Server {
  let reads = 0;
  const server: Server = {
    kill,
    running: { 'codex-2': { isRunning: true } },
    killCalls: [],
    worktreeReads: () => reads,
  };
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith('/api/agents/versions')) return new Response(JSON.stringify(VERSIONS), { status: 200 });
    if (url.startsWith('/api/agents/update')) {
      const done = { type: 'done', ok: true, exitCode: 0, previousVersion: '0.149.1', installed: '0.151.0' };
      return new Response(`${JSON.stringify(done)}\n`, { status: 200 });
    }
    if (url.includes('/kill-session')) {
      server.killCalls.push({ url, signal: init?.signal ?? undefined });
      if (server.kill === 'reject') throw new TypeError('Failed to fetch');
      if (server.kill === 'stall') {
        return new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
        });
      }
      return new Response(JSON.stringify({}), { status: server.kill });
    }
    reads += 1;
    if (server.running === null) return new Response('{}', { status: 500 });
    return new Response(JSON.stringify({ sessionStatusByInstance: server.running }), { status: 200 });
  }));
  return server;
}

/** `beforePress`: what the server says from here on, with the button already drawn. */
async function pressRestart(beforePress?: () => void): Promise<void> {
  render(<AgentUpdatesCard worktreeId="wt-1" instances={INSTANCES} />);
  fireEvent.click(await screen.findByTestId('agent-updates-update-codex'));
  const button = await screen.findByTestId('agent-updates-restart-codex-2');
  beforePress?.();
  fireEvent.click(button);
}

const errorText = () => screen.queryByTestId('agent-updates-restart-error')?.textContent ?? null;
const expire = () => act(async () => void (await vi.advanceTimersByTimeAsync(15000)));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('[#4145] AgentUpdatesCard — the deadline on kill-session', () => {
  it('no answer: the request is aborted at 15 seconds, and not before', async () => {
    const server = installServer('stall');
    await pressRestart();
    await waitFor(() => expect(server.killCalls).toHaveLength(1));
    await act(async () => void (await vi.advanceTimersByTimeAsync(14000)));
    expect(server.killCalls[0].signal?.aborted).toBe(false);
    await act(async () => void (await vi.advanceTimersByTimeAsync(1000)));
    expect(server.killCalls[0].signal?.aborted).toBe(true);
  });

  it('the kill still names the tool and the instance (without them it ends every session)', async () => {
    const server = installServer('stall');
    await pressRestart();
    await waitFor(() => expect(server.killCalls).toHaveLength(1));
    expect(server.killCalls[0].url).toBe('/api/worktrees/wt-1/kill-session?cliTool=codex&instance=codex-2');
    await expire();
  });

  it('while it is in flight the button cannot send a second one; after it, it can', async () => {
    const server = installServer('stall');
    await pressRestart();
    await waitFor(() => expect(server.killCalls).toHaveLength(1));
    const button = screen.getByTestId('agent-updates-restart-codex-2');
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(server.killCalls).toHaveLength(1);
    await expire();
    // Issue #4160: past the deadline the kill may still be working, so this is not "could not".
    await waitFor(() => expect(screen.getByTestId('agent-updates-restart-progress').textContent).toBe(en.agentUpdates.restartInProgress));
    expect(errorText()).toBeNull();
    expect(screen.getByTestId('agent-updates-restart-codex-2')).toBeEnabled();
  });
});

describe('[#4145] AgentUpdatesCard — an outcome the kill did not tell', () => {
  it.each([
    ['the deadline', 'stall'],
    ['a 500', 500],
    ['no answer', 'reject'],
  ] as const)('%s, and the read fails: it says it could not tell', async (_label, kill) => {
    const server = installServer(kill);
    await pressRestart(() => {
      server.running = null;
    });
    await waitFor(() => expect(server.killCalls).toHaveLength(1));
    if (kill === 'stall') await expire();
    await waitFor(() => expect(errorText()).toBe(en.agentUpdates.restartUnknown));
    expect(screen.queryByText(en.agentUpdates.restarted)).toBeNull();
  });

  it('a 500, the session still running: it reads again and says it could not', async () => {
    const server = installServer(500);
    await pressRestart();
    await waitFor(() => expect(errorText()).toBe(en.agentUpdates.restartError));
    expect(server.worktreeReads()).toBeGreaterThan(0);
  });

  it('a 500, the session did end: it reads again and reports no failure', async () => {
    const server = installServer(500);
    let readsBefore = 0;
    await pressRestart(() => {
      server.running = {};
      readsBefore = server.worktreeReads();
    });
    await waitFor(() => expect(server.worktreeReads()).toBeGreaterThan(readsBefore));
    await waitFor(() => expect(screen.queryByTestId('agent-updates-restart-codex-2')).toBeNull());
    expect(errorText()).toBeNull();
  });

  it('an answered kill: no error, no extra judgement (negative control)', async () => {
    const server = installServer(200);
    await pressRestart();
    await waitFor(() => expect(server.killCalls).toHaveLength(1));
    await waitFor(() => expect(screen.getByText(en.agentUpdates.restarted)).toBeInTheDocument());
    expect(errorText()).toBeNull();
    await expire();
    expect(errorText()).toBeNull();
  });

  it('a 404 is already ended, which is the goal (negative control)', async () => {
    installServer(404);
    await pressRestart();
    await waitFor(() => expect(screen.getByText(en.agentUpdates.restarted)).toBeInTheDocument());
    expect(errorText()).toBeNull();
  });

  it('a refusal says it failed, without asking whether the session ended (negative control)', async () => {
    const server = installServer(403);
    await pressRestart();
    await waitFor(() => expect(server.killCalls).toHaveLength(1));
    const readsAtKill = server.worktreeReads();
    await waitFor(() => expect(errorText()).toBe(en.agentUpdates.restartError));
    expect(server.worktreeReads()).toBe(readsAtKill);
  });
});

describe('[#4145] the wording exists in both languages', () => {
  it.each([['en', en], ['ja', ja]] as const)('%s', (_locale, dict) => {
    expect(dict.agentUpdates.restartUnknown).toBeTypeOf('string');
    expect(dict.agentUpdates.restartUnknown.length).toBeGreaterThan(0);
    expect(dict.agentRoles.instances.restartUnknown).toBeTypeOf('string');
    expect(dict.agentRoles.instances.restartUnknown.length).toBeGreaterThan(0);
  });
});
