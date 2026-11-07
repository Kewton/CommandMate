/**
 * Issue #4145: an add begun on worktree A and answered after the switch to B places
 * nothing. The save's own result still comes back, and the placement goes by the id
 * alone, so B's row of the same id would take it.
 *
 * Positive controls: the "after the switch" tests fail without the check in the menu.
 * Negative controls: with no switch, or back on A, the add is placed.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AgentAddMenu } from '@/components/worktree/AgentAddMenu';
import { clearRosterSnapshot } from '@/hooks/useInstanceRoleSettings';
import type { AgentInstance } from '@/lib/cli-tools/types';
import { FakeRoleServer } from '../roles/fake-role-server';

const A = 'wt-4145-add-a';
const B = 'wt-4145-add-b';
const CLAUDE: AgentInstance = { id: 'claude', cliTool: 'claude', alias: 'Claude', order: 0 };
// B already has the id A's add will get: this is what the placement would land on.
const ROSTER_B: AgentInstance[] = [CLAUDE, { id: 'claude-2', cliTool: 'claude', alias: 'B own', order: 1 }];

let server: FakeRoleServer;
let release: () => void;
let saveSent: Promise<void>;
const onInstancesChange = vi.fn();
const onAdded = vi.fn();

beforeEach(() => {
  onInstancesChange.mockClear();
  onAdded.mockClear();
  server = new FakeRoleServer([CLAUDE]);
  const passOn = server.fetch as unknown as typeof fetch;
  let markSent: () => void = () => {};
  saveSent = new Promise((resolve) => { markSent = resolve; });
  const held = new Promise<void>((resolve) => { release = resolve; });
  // Only the save is held; the reads the form opens with are answered.
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

const menu = (worktreeId: string, instances: AgentInstance[]) => (
  <AgentAddMenu
    worktreeId={worktreeId}
    instances={instances}
    splitCount={1}
    onInstancesChange={onInstancesChange}
    onAdded={onAdded}
  />
);

async function openForm(): Promise<void> {
  fireEvent.click(screen.getByTestId('agent-add-button'));
  await waitFor(() => expect(screen.getByTestId('agent-add-submit')).not.toBeDisabled());
}

async function submit(): Promise<void> {
  fireEvent.click(screen.getByTestId('agent-add-submit'));
  await saveSent;
}

const finishSave = () => act(async () => {
  release();
  await new Promise((done) => setTimeout(done, 20));
});

// Both ways the form saves: with the role settings read (POST), and without (PATCH).
describe.each([
  ['the role settings were read (POST)', false],
  ['the role settings could not be read (PATCH)', true],
])('[#4145] the "+" when %s', (_label, refuseSettings) => {
  beforeEach(() => {
    server.refuseSettingsRead = refuseSettings;
  });

  it('answered after the switch: not placed, and not on the roster here', async () => {
    const view = render(menu(A, [CLAUDE]));
    await openForm();
    await submit();
    view.rerender(menu(B, ROSTER_B));
    await finishSave();
    expect(onAdded).not.toHaveBeenCalled();
    expect(onInstancesChange).not.toHaveBeenCalled();
  });

  it('a form opened on B meanwhile stays open when A\'s add is answered', async () => {
    const view = render(menu(A, [CLAUDE]));
    await openForm();
    await submit();
    view.rerender(menu(B, ROSTER_B));
    await waitFor(() => expect(screen.queryByTestId('agent-add-submit')).toBeNull());
    fireEvent.click(screen.getByTestId('agent-add-button'));
    await screen.findByTestId('agent-add-submit');
    await finishSave();
    expect(screen.getByTestId('agent-add-submit')).toBeInTheDocument();
    expect(onAdded).not.toHaveBeenCalled();
  });

  it('no switch: it is placed where it was asked, and the form closes (negative control)', async () => {
    render(menu(A, [CLAUDE]));
    await openForm();
    await submit();
    await finishSave();
    expect(onAdded).toHaveBeenCalledTimes(1);
    expect(onAdded.mock.calls[0][0].id).toBe('claude-2');
    expect(onAdded.mock.calls[0][1]).toBe('new-split');
    expect(onInstancesChange).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByTestId('agent-add-submit')).toBeNull());
  });

  it('back on A before it is answered: it is A\'s, and it is placed (negative control)', async () => {
    const view = render(menu(A, [CLAUDE]));
    await openForm();
    await submit();
    view.rerender(menu(B, ROSTER_B));
    view.rerender(menu(A, [CLAUDE]));
    await finishSave();
    expect(onAdded).toHaveBeenCalledTimes(1);
  });
});

describe('[#4145] the "+" form left open across a switch', () => {
  it('closes: what was typed was for the previous worktree', async () => {
    const view = render(menu(A, [CLAUDE]));
    await openForm();
    view.rerender(menu(B, ROSTER_B));
    await waitFor(() => expect(screen.queryByTestId('agent-add-submit')).toBeNull());
  });

  it('stays open while the worktree does not change (negative control)', async () => {
    const view = render(menu(A, [CLAUDE]));
    await openForm();
    view.rerender(menu(A, [CLAUDE, { ...CLAUDE, id: 'other', alias: 'Other', order: 1 }]));
    expect(screen.getByTestId('agent-add-submit')).toBeInTheDocument();
  });
});
