/**
 * Issue #3514 (review): roster writes from the header "+" (AgentAddMenu) and
 * the Agents pane (AgentInstancesPane) are serialized, and each one is built
 * from the roster the previous one saved.
 *
 * `PATCH /api/worktrees/[id]` replaces the whole roster, so before this fix a
 * write issued while the other's was in flight started from a roster without
 * the other's change: the later PATCH erased the earlier one, and two adds of
 * the same tool allocated the same id.
 *
 * The harness owns the roster like WorktreeDetailRefactored does and feeds it
 * to both components. PATCH responses are held until the test releases them.
 *
 * @vitest-environment jsdom
 */

import React, { useState } from 'react';
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { AgentInstancesPane } from '@/components/worktree/AgentInstancesPane';
import { AgentAddMenu } from '@/components/worktree/AgentAddMenu';
import { ConfirmProvider } from '@/components/ui/ConfirmDialog';
import type { AgentInstance } from '@/lib/cli-tools/types';
import { installRadixJsdomPolyfills } from '@tests/helpers/radix-jsdom';

beforeAll(() => installRadixJsdomPolyfills());

const INITIAL: AgentInstance[] = [
  { id: 'claude', cliTool: 'claude', alias: 'Claude', order: 0 },
  { id: 'codex', cliTool: 'codex', alias: 'Codex', order: 1 },
];

let patches: AgentInstance[][] = [];
let releases: Array<() => void> = [];
let holdPatches = true;
let worktreeSeq = 0;

function installFetch(): void {
  patches = [];
  releases = [];
  global.fetch = vi.fn((url: string, init?: RequestInit) => {
    if (init?.method === 'PATCH') {
      patches.push(JSON.parse(String(init.body)).agentInstances);
      const response = { ok: true, json: async () => ({}) };
      if (!holdPatches) return Promise.resolve(response);
      return new Promise((resolve) => releases.push(() => resolve(response)));
    }
    if (String(url).startsWith('/api/settings/default-agents')) {
      return Promise.resolve({ ok: true, json: async () => ({ installed: ['claude', 'codex'] }) });
    }
    return Promise.resolve({ ok: true, json: async () => ({}) });
  }) as unknown as typeof fetch;
}

function Harness({ worktreeId }: { worktreeId: string }) {
  const [instances, setInstances] = useState<AgentInstance[]>(INITIAL);
  return (
    <ConfirmProvider>
      <AgentAddMenu
        worktreeId={worktreeId}
        instances={instances}
        splitCount={1}
        onInstancesChange={setInstances}
      />
      <AgentInstancesPane
        worktreeId={worktreeId}
        instances={instances}
        onInstancesChange={setInstances}
        vibeLocalModel={null}
        onVibeLocalModelChange={vi.fn()}
      />
      <output data-testid="roster">{instances.map((i) => `${i.id}:${i.alias}`).join(',')}</output>
    </ConfirmProvider>
  );
}

function renderHarness() {
  worktreeSeq += 1;
  return render(<Harness worktreeId={`w-3514-roster-${worktreeSeq}`} />);
}

async function releaseNext(): Promise<void> {
  await waitFor(() => expect(releases.length).toBeGreaterThan(0));
  const release = releases.shift()!;
  await act(async () => {
    release();
  });
}

async function addFromPlus(tool: string): Promise<void> {
  fireEvent.click(screen.getByTestId('agent-add-button'));
  await waitFor(() => expect(screen.getByTestId('agent-add-tool')).not.toBeDisabled());
  fireEvent.change(screen.getByTestId('agent-add-tool'), { target: { value: tool } });
  fireEvent.click(screen.getByTestId('agent-add-submit'));
}

function addFromPane(tool: string): void {
  fireEvent.change(screen.getByTestId('agent-instance-add-tool'), { target: { value: tool } });
  fireEvent.click(screen.getByTestId('agent-instance-add'));
}

function ids(roster: AgentInstance[]): string[] {
  return roster.map((i) => i.id);
}

describe('[#3514] roster writes are serialized across the "+" and the Agents pane', () => {
  beforeEach(() => {
    holdPatches = true;
    installFetch();
  });
  afterEach(() => vi.restoreAllMocks());

  it('pane add still saving, then "+" add: both instances survive with distinct ids', async () => {
    renderHarness();
    addFromPane('claude');
    await waitFor(() => expect(patches).toHaveLength(1));
    await addFromPlus('claude');

    // The second write must wait for the first.
    expect(patches).toHaveLength(1);
    await releaseNext();
    await waitFor(() => expect(patches).toHaveLength(2));
    await releaseNext();

    expect(ids(patches[0])).toEqual(['claude', 'codex', 'claude-2']);
    expect(ids(patches[1])).toEqual(['claude', 'codex', 'claude-2', 'claude-3']);
    await waitFor(() =>
      expect(screen.getByTestId('roster').textContent).toBe(
        'claude:Claude,codex:Codex,claude-2:Claude 2,claude-3:Claude 3',
      ),
    );
  });

  it('"+" add still saving, then pane rename: the rename keeps the added instance', async () => {
    renderHarness();
    await addFromPlus('codex');
    await waitFor(() => expect(patches).toHaveLength(1));
    const alias = screen.getByTestId('agent-instance-alias-claude');
    fireEvent.change(alias, { target: { value: 'Lead' } });
    fireEvent.blur(alias);

    await releaseNext();
    await waitFor(() => expect(patches).toHaveLength(2));
    await releaseNext();

    expect(patches[1].map((i) => `${i.id}:${i.alias}`)).toEqual([
      'claude:Lead',
      'codex:Codex',
      'codex-2:Codex 2',
    ]);
  });

  it('"+" add still saving, then pane add: ids do not collide', async () => {
    renderHarness();
    await addFromPlus('codex');
    await waitFor(() => expect(patches).toHaveLength(1));
    // The pane's own add button is not disabled by the "+"'s save.
    addFromPane('codex');

    await releaseNext();
    await waitFor(() => expect(patches).toHaveLength(2));
    await releaseNext();

    expect(ids(patches[1])).toEqual(['claude', 'codex', 'codex-2', 'codex-3']);
  });

  it('"+" add still saving, then pane delete: the delete keeps the added instance', async () => {
    renderHarness();
    await addFromPlus('claude');
    await waitFor(() => expect(patches).toHaveLength(1));
    fireEvent.keyDown(screen.getByTestId('agent-instance-menu-codex'), { key: 'Enter' });
    fireEvent.click(screen.getByTestId('agent-instance-delete-codex'));
    fireEvent.click(await screen.findByTestId('confirm-dialog-confirm'));

    await releaseNext();
    await waitFor(() => expect(patches).toHaveLength(2));
    await releaseNext();

    expect(ids(patches[1])).toEqual(['claude', 'claude-2']);
  });
});

describe('[#3514] single writes are unchanged (negative control)', () => {
  beforeEach(() => {
    holdPatches = false;
    installFetch();
  });
  afterEach(() => vi.restoreAllMocks());

  it('a lone pane add is one PATCH', async () => {
    renderHarness();
    addFromPane('gemini');
    await waitFor(() =>
      expect(screen.getByTestId('roster').textContent).toContain('gemini:'),
    );
    expect(patches).toHaveLength(1);
    expect(ids(patches[0])).toEqual(['claude', 'codex', 'gemini']);
  });

  it('a lone rename is one PATCH', async () => {
    renderHarness();
    const alias = screen.getByTestId('agent-instance-alias-codex');
    fireEvent.change(alias, { target: { value: 'Reviewer' } });
    fireEvent.blur(alias);
    await waitFor(() =>
      expect(screen.getByTestId('roster').textContent).toContain('codex:Reviewer'),
    );
    expect(patches).toHaveLength(1);
  });

  it('a lone "+" add is one PATCH', async () => {
    renderHarness();
    await addFromPlus('codex');
    await waitFor(() => expect(screen.getByTestId('roster').textContent).toContain('codex-2:'));
    expect(patches).toHaveLength(1);
  });
});
