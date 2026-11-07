/**
 * Past the deadline with the session still running, the role pane says it may still be
 * ending rather than that it failed (Issue #4160), and a read showing it gone takes
 * that back. A refusal and a 500 are told apart from it.
 *
 * Positive controls: the "may still be ending" tests fail on the code before this Issue.
 * Negative controls: a refusal and a 500 still read as a failure.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { AgentInstancesPane } from '@/components/worktree/AgentInstancesPane';
import { ConfirmProvider } from '@/components/ui/ConfirmDialog';
import type { AgentInstance } from '@/lib/cli-tools/types';
import { installRadixJsdomPolyfills } from '@tests/helpers/radix-jsdom';
import { FakeRoleServer, launched } from './fake-role-server';
import ja from '../../../../locales/ja/common.json';

vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock('ja');
});

beforeAll(() => installRadixJsdomPolyfills());

const INITIAL: AgentInstance[] = [{ id: 'claude', cliTool: 'claude', alias: 'Claude', order: 0 }];

let server: FakeRoleServer;
let seq = 0;
let worktreeId: string;

function killAnswers(answer: () => Promise<Response>): void {
  global.fetch = vi.fn(async (input: string, init?: RequestInit): Promise<Response> => {
    if (!input.split('?')[0].endsWith('/kill-session')) return server.fetch(input, init);
    return answer();
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  seq += 1;
  worktreeId = `w-4160-p-${seq}`;
  server = new FakeRoleServer(INITIAL);
  server.running.claude = true;
  server.application.claude = { launched: launched({ roleName: 'PM' }), restartPending: 'yes' };
  global.fetch = server.fetch as unknown as typeof fetch;
});
afterEach(() => vi.restoreAllMocks());

async function restart(): Promise<void> {
  render(
    <ConfirmProvider>
      <AgentInstancesPane
        worktreeId={worktreeId}
        instances={INITIAL}
        onInstancesChange={vi.fn()}
        vibeLocalModel={null}
        onVibeLocalModelChange={vi.fn()}
      />
    </ConfirmProvider>,
  );
  fireEvent.click(screen.getByTestId('instance-roles-toggle'));
  fireEvent.click(await screen.findByTestId('instance-role-restart-claude'));
  fireEvent.click(await screen.findByTestId('confirm-dialog-confirm'));
}

const progress = () => screen.queryByTestId('instance-role-progress-claude');
const error = () => screen.queryByTestId('instance-role-error-claude');
const noAnswer = () => Promise.reject(new TypeError('Failed to fetch'));

describe('[#4160] the role pane when the kill said nothing and the session runs on', () => {
  it('no answer: it may still be ending, and nothing says it failed', async () => {
    killAnswers(noAnswer);
    await restart();
    await waitFor(() => expect(progress()?.textContent).toBe(ja.agentRoles.instances.restartInProgress));
    expect(error()).toBeNull();
  });

  it('ending late: a later read that shows it gone takes the notice back', async () => {
    killAnswers(noAnswer);
    await restart();
    await waitFor(() => expect(progress()).not.toBeNull());
    server.running.claude = false;
    // Coming back to the window reads the settings again, and that reads what is running.
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      await new Promise((done) => setTimeout(done, 0));
    });
    await waitFor(() => expect(progress()).toBeNull());
    expect(error()).toBeNull();
  });

  it('pressing again starts over: the notice goes (negative control)', async () => {
    killAnswers(noAnswer);
    await restart();
    await waitFor(() => expect(progress()).not.toBeNull());
    killAnswers(() => Promise.resolve(new Response('{}', { status: 403 })));
    await waitFor(async () => expect(await screen.findByTestId('instance-role-restart-claude')).toBeEnabled());
    await waitFor(() => expect(screen.queryByTestId('confirm-dialog-confirm')).toBeNull());
    fireEvent.click(screen.getByTestId('instance-role-restart-claude'));
    fireEvent.click(await screen.findByTestId('confirm-dialog-confirm'));
    await waitFor(() => expect(error()?.textContent).toBe(ja.agentRoles.instances.restartError));
    expect(progress()).toBeNull();
  });

  it('a 500: the server has finished and it runs on, so that is a failure (negative control)', async () => {
    killAnswers(() => Promise.resolve(new Response('{}', { status: 500 })));
    await restart();
    await waitFor(() => expect(error()?.textContent).toBe(ja.agentRoles.instances.restartError));
    expect(progress()).toBeNull();
  });

  it('a refusal is a failure, whatever is running (negative control)', async () => {
    killAnswers(() => Promise.resolve(new Response('{}', { status: 403 })));
    await restart();
    await waitFor(() => expect(error()?.textContent).toBe(ja.agentRoles.instances.restartError));
    expect(progress()).toBeNull();
  });
});
