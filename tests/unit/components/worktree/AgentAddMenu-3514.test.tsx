/**
 * Issue #3514: the header "+" that adds an agent.
 *
 * Pinned here: uninstalled tools cannot be chosen, the placement defaults
 * (`new-split`, or `replace` at the split ceiling where `new-split` is
 * disabled), and that "add" is a roster PATCH followed by the placement report
 * — no session is started from this control.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AgentAddMenu, defaultAlias, nextInstanceId } from '@/components/worktree/AgentAddMenu';
import { MAX_AGENT_INSTANCES, type AgentInstance } from '@/lib/cli-tools/types';

const ROSTER: AgentInstance[] = [
  { id: 'claude', cliTool: 'claude', alias: 'Claude', order: 0 },
  { id: 'codex', cliTool: 'codex', alias: 'Codex', order: 1 },
];

type FetchCall = { url: string; init?: RequestInit };
let calls: FetchCall[] = [];

function mockFetch({
  installed,
  installedOk = true,
  patchOk = true,
}: { installed?: string[]; installedOk?: boolean; patchOk?: boolean } = {}): void {
  calls = [];
  global.fetch = vi.fn((url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (url.startsWith('/api/settings/default-agents')) {
      return Promise.resolve({
        ok: installedOk,
        json: async () => ({ installed }),
      });
    }
    return Promise.resolve({ ok: patchOk, json: async () => ({}) });
  }) as unknown as typeof fetch;
}

function renderMenu(props: Partial<React.ComponentProps<typeof AgentAddMenu>> = {}) {
  const onInstancesChange = vi.fn();
  const onAdded = vi.fn();
  render(
    <AgentAddMenu
      worktreeId="w-3514"
      instances={ROSTER}
      splitCount={1}
      onInstancesChange={onInstancesChange}
      onAdded={onAdded}
      {...props}
    />,
  );
  return { onInstancesChange, onAdded };
}

async function openMenu(): Promise<void> {
  fireEvent.click(screen.getByTestId('agent-add-button'));
  await waitFor(() => expect(screen.getByTestId('agent-add-tool')).not.toBeDisabled());
}

function option(value: string): HTMLOptionElement {
  return screen
    .getByTestId('agent-add-tool')
    .querySelector(`option[value="${value}"]`) as HTMLOptionElement;
}

describe('[#3514] AgentAddMenu', () => {
  beforeEach(() => mockFetch({ installed: ['claude', 'codex'] }));
  afterEach(() => vi.restoreAllMocks());

  it('lists uninstalled tools as disabled and starts on an installed one', async () => {
    renderMenu();
    await openMenu();
    expect(option('claude').disabled).toBe(false);
    expect(option('codex').disabled).toBe(false);
    expect(option('gemini').disabled).toBe(true);
    expect(option('gemini').textContent).toBe('worktree.agentAdd.notInstalled');
    expect((screen.getByTestId('agent-add-tool') as HTMLSelectElement).value).toBe('claude');
  });

  it('lists every tool when the installed check fails (negative control)', async () => {
    mockFetch({ installedOk: false });
    renderMenu();
    await openMenu();
    expect(option('gemini').disabled).toBe(false);
    expect(screen.getByTestId('agent-add-installed-unknown')).toBeInTheDocument();
  });

  it('treats an empty installed list as "could not check": every tool is selectable', async () => {
    // The server rounds a failed probe to `[]` with a 200 (installed-agents-cache).
    mockFetch({ installed: [] });
    renderMenu();
    await openMenu();
    expect(option('claude').disabled).toBe(false);
    expect(option('gemini').disabled).toBe(false);
    expect(screen.getByTestId('agent-add-installed-unknown')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('agent-add-submit')).not.toBeDisabled());
  });

  it('trusts a non-empty installed list: ["claude"] leaves only claude selectable', async () => {
    mockFetch({ installed: ['claude'] });
    renderMenu();
    await openMenu();
    expect(option('claude').disabled).toBe(false);
    expect(option('codex').disabled).toBe(true);
    expect(option('gemini').disabled).toBe(true);
    expect(screen.queryByTestId('agent-add-installed-unknown')).toBeNull();
  });

  it('defaults to a new split while there is room', async () => {
    renderMenu({ splitCount: 3 });
    await openMenu();
    expect(screen.getByTestId('agent-add-placement-new-split')).toBeChecked();
    expect(screen.getByTestId('agent-add-placement-new-split')).not.toBeDisabled();
  });

  it('at 4 splits, new split is disabled and the default is replace', async () => {
    renderMenu({ splitCount: 4 });
    await openMenu();
    expect(screen.getByTestId('agent-add-placement-new-split')).toBeDisabled();
    expect(screen.getByTestId('agent-add-placement-new-split')).not.toBeChecked();
    expect(screen.getByTestId('agent-add-placement-replace')).toBeChecked();
  });

  it('PATCHes the roster with the new instance and reports the placement', async () => {
    const { onInstancesChange, onAdded } = renderMenu();
    await openMenu();
    fireEvent.change(screen.getByTestId('agent-add-tool'), { target: { value: 'codex' } });
    fireEvent.change(screen.getByTestId('agent-add-name'), { target: { value: '  Reviewer ' } });
    fireEvent.click(screen.getByTestId('agent-add-placement-replace'));
    fireEvent.click(screen.getByTestId('agent-add-submit'));

    await waitFor(() => expect(onAdded).toHaveBeenCalled());
    const patch = calls.find((c) => c.init?.method === 'PATCH');
    expect(patch?.url).toBe('/api/worktrees/w-3514');
    const body = JSON.parse(String(patch?.init?.body));
    expect(body.agentInstances).toEqual([
      { id: 'claude', cliTool: 'claude', alias: 'Claude', order: 0 },
      { id: 'codex', cliTool: 'codex', alias: 'Codex', order: 1 },
      { id: 'codex-2', cliTool: 'codex', alias: 'Reviewer', order: 2 },
    ]);
    expect(onInstancesChange).toHaveBeenCalledWith(body.agentInstances);
    expect(onAdded).toHaveBeenCalledWith(
      { id: 'codex-2', cliTool: 'codex', alias: 'Reviewer', order: 2 },
      'replace',
    );
    // Adding does not start a session: no send / no start request.
    expect(calls.some((c) => c.url.includes('/send'))).toBe(false);
    await waitFor(() => expect(screen.queryByTestId('agent-add-form')).toBeNull());
  });

  it('reports add-only too, with the default alias when no name is given', async () => {
    const { onAdded } = renderMenu();
    await openMenu();
    fireEvent.click(screen.getByTestId('agent-add-placement-roster-only'));
    fireEvent.click(screen.getByTestId('agent-add-submit'));
    await waitFor(() => expect(onAdded).toHaveBeenCalled());
    expect(onAdded.mock.calls[0][0]).toMatchObject({ id: 'claude-2', alias: 'Claude 2' });
    expect(onAdded.mock.calls[0][1]).toBe('roster-only');
  });

  it('keeps the form open and reports nothing when the PATCH fails', async () => {
    mockFetch({ installed: ['claude'], patchOk: false });
    const { onAdded, onInstancesChange } = renderMenu();
    await openMenu();
    fireEvent.click(screen.getByTestId('agent-add-submit'));
    await waitFor(() => expect(screen.getByTestId('agent-add-error')).toBeInTheDocument());
    expect(onAdded).not.toHaveBeenCalled();
    expect(onInstancesChange).not.toHaveBeenCalled();
  });

  it('is disabled at the roster ceiling', () => {
    const full: AgentInstance[] = Array.from({ length: MAX_AGENT_INSTANCES }, (_, i) => ({
      id: i === 0 ? 'claude' : `claude-${i + 1}`,
      cliTool: 'claude',
      alias: `C${i}`,
      order: i,
    }));
    renderMenu({ instances: full });
    expect(screen.getByTestId('agent-add-button')).toBeDisabled();
  });
});

describe('[#3514] roster helpers shared with AgentInstancesPane', () => {
  it('claims the primary id first, then the smallest free suffix', () => {
    expect(nextInstanceId('gemini', ROSTER)).toBe('gemini');
    expect(nextInstanceId('claude', ROSTER)).toBe('claude-2');
    expect(defaultAlias('claude', 'claude')).toBe('Claude');
    expect(defaultAlias('claude', 'claude-3')).toBe('Claude 3');
  });
});
