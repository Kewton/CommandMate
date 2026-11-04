/**
 * The role pane's restart when neither the kill nor the read after it could tell what
 * happened (Issue #4145): it says so, instead of saying the kill failed.
 *
 * Positive control: the read-failed cases fail on the code before this Issue.
 * Negative control: the read that answers still decides, as in #4133's own test file.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
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

function answerKill(status: number): void {
  const passOn = global.fetch;
  global.fetch = vi.fn(async (input: string, init?: RequestInit): Promise<Response> => {
    if (!input.split('?')[0].endsWith('/kill-session')) return (passOn as unknown as typeof server.fetch)(input, init);
    server.refuseWorktreeRead = refuseReadAfterKill;
    return new Response(JSON.stringify({}), { status });
  }) as unknown as typeof fetch;
}
let refuseReadAfterKill = false;

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

beforeEach(() => {
  seq += 1;
  worktreeId = `w-4145-${seq}`;
  server = new FakeRoleServer(INITIAL);
  server.running.claude = true;
  server.application.claude = { launched: launched({ roleName: 'PM' }), restartPending: 'yes' };
  global.fetch = server.fetch as unknown as typeof fetch;
  refuseReadAfterKill = false;
});
afterEach(() => vi.restoreAllMocks());

const errorText = async () => (await screen.findByTestId('instance-role-error-claude')).textContent;

describe('[#4145] the role pane when the outcome cannot be told', () => {
  it('a 500, and the read after it fails: it says it could not tell', async () => {
    refuseReadAfterKill = true;
    answerKill(500);
    await restart();
    await waitFor(async () => expect(await errorText()).toBe(ja.agentRoles.instances.restartUnknown));
  });

  it('a 500, and the session still running: the read answered, so it says it could not (negative control)', async () => {
    answerKill(500);
    await restart();
    await waitFor(async () => expect(await errorText()).toBe(ja.agentRoles.instances.restartError));
  });

  it('a refusal with the read failing: a refusal is an answer, not an unknown (negative control)', async () => {
    refuseReadAfterKill = true;
    answerKill(403);
    await restart();
    await waitFor(async () => expect(await errorText()).toBe(ja.agentRoles.instances.restartError));
  });
});
