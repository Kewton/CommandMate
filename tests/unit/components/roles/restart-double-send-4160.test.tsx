/**
 * The role pane's restart while one is under way (Issue #4160): the card disabled its
 * button in #4145, this one could still be pressed for up to 15 seconds.
 *
 * Positive control: disabled-while-sending fails on the code before this Issue, where a
 * press during the kill opened the dialog again. Negative controls: a double press
 * before the dialog, a cancel, and the button working again once it has settled.
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

vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock('ja');
});

beforeAll(() => installRadixJsdomPolyfills());

const INITIAL: AgentInstance[] = [{ id: 'claude', cliTool: 'claude', alias: 'Claude', order: 0 }];

let server: FakeRoleServer;
let seq = 0;
let worktreeId: string;
let kills: string[];
let answers: Array<(reply: Response) => void>;

beforeEach(() => {
  seq += 1;
  worktreeId = `w-4160-${seq}`;
  server = new FakeRoleServer(INITIAL);
  server.running.claude = true;
  server.application.claude = { launched: launched({ roleName: 'PM' }), restartPending: 'yes' };
  kills = [];
  answers = [];
  global.fetch = vi.fn(async (input: string, init?: RequestInit): Promise<Response> => {
    if (!input.split('?')[0].endsWith('/kill-session')) return server.fetch(input, init);
    kills.push(input);
    return new Promise<Response>((resolve) => answers.push(resolve));
  }) as unknown as typeof fetch;
});
afterEach(() => vi.restoreAllMocks());

const restartButton = () => screen.findByTestId('instance-role-restart-claude');
const dialogGone = () => waitFor(() => expect(screen.queryByTestId('confirm-dialog-confirm')).toBeNull());

async function opened(): Promise<HTMLElement> {
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
  return restartButton();
}

describe('[#4160] the role pane restart while one is under way', () => {
  it('while the kill is out the button is disabled, and pressing it opens nothing and sends nothing', async () => {
    const button = await opened();
    fireEvent.click(button);
    fireEvent.click(await screen.findByTestId('confirm-dialog-confirm'));
    await waitFor(() => expect(kills).toHaveLength(1));
    await waitFor(async () => expect(await restartButton()).toBeDisabled());
    await dialogGone();
    fireEvent.click(await restartButton());
    await act(async () => {});
    expect(screen.queryByTestId('confirm-dialog-confirm')).toBeNull();
    expect(kills).toHaveLength(1);
    await act(async () => answers[0](new Response('{}', { status: 200 })));
  });

  it('a double press before the dialog: one dialog, and one request after confirming', async () => {
    const button = await opened();
    fireEvent.click(button);
    fireEvent.click(button);
    fireEvent.click(await screen.findByTestId('confirm-dialog-confirm'));
    await waitFor(() => expect(kills).toHaveLength(1));
    await dialogGone();
    expect(kills).toHaveLength(1);
    await act(async () => answers[0](new Response('{}', { status: 200 })));
  });

  it('settled: pressable again and a second kill goes out (negative control)', async () => {
    const button = await opened();
    fireEvent.click(button);
    fireEvent.click(await screen.findByTestId('confirm-dialog-confirm'));
    await waitFor(() => expect(kills).toHaveLength(1));
    await act(async () => answers[0](new Response('{}', { status: 403 })));
    await waitFor(async () => expect(await restartButton()).toBeEnabled());
    await dialogGone();
    fireEvent.click(await restartButton());
    fireEvent.click(await screen.findByTestId('confirm-dialog-confirm'));
    await waitFor(() => expect(kills).toHaveLength(2));
    await act(async () => answers[1](new Response('{}', { status: 200 })));
  });

  it('cancelling the dialog sends nothing and leaves the button pressable (negative control)', async () => {
    const button = await opened();
    fireEvent.click(button);
    fireEvent.click(await screen.findByTestId('confirm-dialog-cancel'));
    await waitFor(() => expect(screen.queryByTestId('confirm-dialog-cancel')).toBeNull());
    expect(kills).toEqual([]);
    expect(await restartButton()).toBeEnabled();
  });
});
