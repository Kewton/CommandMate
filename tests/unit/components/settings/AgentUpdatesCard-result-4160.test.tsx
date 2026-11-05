/**
 * The card's "ended" stays when the read after it drops the session from the running
 * list (Issue #4160): the line used to be drawn only for running instances, so the
 * result went away with the button.
 *
 * Positive controls: the "stays" tests fail on the code before this Issue.
 * Negative controls: a running session keeps its button, and an instance nobody
 * restarted does not gain a line.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import en from '../../../../locales/en/common.json';

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
const INSTANCES = [
  { id: 'codex-2', cliTool: 'codex', alias: 'Codex 2' },
  { id: 'codex-3', cliTool: 'codex', alias: 'Codex 3' },
];

interface Server {
  running: Record<string, { isRunning: boolean }>;
  kill: () => Promise<Response>;
  updates: number;
}

function installServer(): Server {
  const server: Server = {
    running: { 'codex-2': { isRunning: true } },
    kill: async () => {
      delete server.running['codex-2'];
      return new Response('{}', { status: 200 });
    },
    updates: 0,
  };
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith('/api/agents/versions')) return new Response(JSON.stringify(VERSIONS), { status: 200 });
    if (url.startsWith('/api/agents/update')) {
      server.updates += 1;
      const done = { type: 'done', ok: true, exitCode: 0, previousVersion: '0.149.1', installed: '0.151.0' };
      return new Response(`${JSON.stringify(done)}\n`, { status: 200 });
    }
    if (url.includes('/kill-session')) return server.kill();
    return new Response(JSON.stringify({ sessionStatusByInstance: server.running }), { status: 200 });
  }));
  return server;
}

async function updated(worktreeId = 'wt-1') {
  const view = render(<AgentUpdatesCard worktreeId={worktreeId} instances={INSTANCES} />);
  fireEvent.click(await screen.findByTestId('agent-updates-update-codex'));
  return view;
}
const button = (id = 'codex-2') => screen.queryByTestId(`agent-updates-restart-${id}`);
const result = () => screen.queryByText(en.agentUpdates.restarted);

afterEach(() => vi.unstubAllGlobals());

describe('[#4160] AgentUpdatesCard — the result of a restart', () => {
  it('the read drops the session from the running list: the result stays, without a button', async () => {
    installServer();
    await updated();
    fireEvent.click(await screen.findByTestId('agent-updates-restart-codex-2'));
    await waitFor(() => expect(button()).toBeNull());
    expect(result()).toBeInTheDocument();
  });

  it('a 500 whose read shows it ended: the result stays too', async () => {
    const server = installServer();
    server.kill = async () => {
      delete server.running['codex-2'];
      return new Response('{}', { status: 500 });
    };
    await updated();
    fireEvent.click(await screen.findByTestId('agent-updates-restart-codex-2'));
    await waitFor(() => expect(result()).toBeInTheDocument());
    await waitFor(() => expect(button()).toBeNull());
    expect(result()).toBeInTheDocument();
  });

  it('a later update starts over: the old result does not stand for the new version', async () => {
    installServer();
    await updated();
    fireEvent.click(await screen.findByTestId('agent-updates-restart-codex-2'));
    await waitFor(() => expect(button()).toBeNull());
    fireEvent.click(screen.getByTestId('agent-updates-update-codex'));
    await waitFor(() => expect(result()).toBeNull());
  });

  it('another worktree under the same instance id: not its result', async () => {
    const server = installServer();
    const view = await updated();
    fireEvent.click(await screen.findByTestId('agent-updates-restart-codex-2'));
    await waitFor(() => expect(button()).toBeNull());
    expect(result()).toBeInTheDocument();
    server.running['codex-2'] = { isRunning: true };
    view.rerender(<AgentUpdatesCard worktreeId="wt-2" instances={INSTANCES} />);
    await waitFor(() => expect(button()).toBeEnabled());
    expect(result()).toBeNull();
  });

  it("a restart answered after the switch: B's row does not take A's result", async () => {
    const server = installServer();
    let answer: (reply: Response) => void = () => {};
    server.kill = () => new Promise<Response>((resolve) => { answer = resolve; });
    const view = await updated();
    fireEvent.click(await screen.findByTestId('agent-updates-restart-codex-2'));
    await waitFor(() => expect(button()).toBeDisabled());
    view.rerender(<AgentUpdatesCard worktreeId="wt-2" instances={INSTANCES} />);
    await waitFor(() => expect(button()).toBeEnabled());
    answer(new Response('{}', { status: 200 }));
    await new Promise((done) => setTimeout(done, 0));
    await waitFor(() => expect(button()).toBeEnabled());
    expect(result()).toBeNull();
  });

  it('still running after the kill: the button stays, disabled, beside the result (negative control)', async () => {
    const server = installServer();
    server.kill = async () => new Response('{}', { status: 200 });
    await updated();
    fireEvent.click(await screen.findByTestId('agent-updates-restart-codex-2'));
    await waitFor(() => expect(result()).toBeInTheDocument());
    expect(button()).toBeDisabled();
  });

  it('an instance of the tool nobody restarted and not running gets no line (negative control)', async () => {
    installServer();
    await updated();
    await screen.findByTestId('agent-updates-restart-codex-2');
    expect(button('codex-3')).toBeNull();
    expect(result()).toBeNull();
  });
});
