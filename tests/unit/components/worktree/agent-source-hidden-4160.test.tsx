/**
 * The roster pane's read of opencode's event source rests while the tab is hidden
 * (Issue #4160, after #4145 did this for the parent poll) and reads at once on coming
 * back.
 *
 * Positive controls: the hidden tests fail on the code before this Issue.
 * Negative controls: visible ticks, and a roster with nothing to ask about stays silent.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, act } from '@testing-library/react';
import { AgentInstancesPane } from '@/components/worktree/AgentInstancesPane';
import { ConfirmProvider } from '@/components/ui/ConfirmDialog';
import { AGENT_SOURCE_POLL_INTERVAL_MS } from '@/config/agent-source-config';
import type { AgentInstance } from '@/lib/cli-tools/types';
import { installRadixJsdomPolyfills } from '@tests/helpers/radix-jsdom';

vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock('en');
});

beforeAll(() => installRadixJsdomPolyfills());

const OPENCODE: AgentInstance[] = [{ id: 'opencode', cliTool: 'opencode', alias: 'OpenCode', order: 0 }];
const CLAUDE: AgentInstance[] = [{ id: 'claude', cliTool: 'claude', alias: 'Claude', order: 0 }];
const originalVisibility = Object.getOwnPropertyDescriptor(document, 'visibilityState');

function setVisibility(state: DocumentVisibilityState): void {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
}

let fetchSpy: ReturnType<typeof vi.fn>;
const sourceReads = () =>
  fetchSpy.mock.calls.filter(([url]) => /\/api\/worktrees\/wt-1$/.test(String(url))).length;
const tick = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));

function mountPane(instances: AgentInstance[]) {
  return render(
    <ConfirmProvider>
      <AgentInstancesPane
        worktreeId="wt-1"
        instances={instances}
        onInstancesChange={vi.fn()}
        vibeLocalModel={null}
        onVibeLocalModelChange={vi.fn()}
      />
    </ConfirmProvider>,
  );
}

async function comeBack(): Promise<void> {
  setVisibility('visible');
  await act(async () => {
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(0);
  });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  setVisibility('visible');
  fetchSpy = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({}) });
  global.fetch = fetchSpy as unknown as typeof fetch;
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  if (originalVisibility) Object.defineProperty(document, 'visibilityState', originalVisibility);
  else delete (document as unknown as Record<string, unknown>).visibilityState;
});

describe('[#4160] the event-source read while the tab is hidden', () => {
  it('visible: every tick asks (negative control)', async () => {
    mountPane(OPENCODE);
    await tick(0);
    expect(sourceReads()).toBe(1);
    await tick(AGENT_SOURCE_POLL_INTERVAL_MS * 2);
    expect(sourceReads()).toBe(3);
  });

  it('hidden: no tick asks', async () => {
    mountPane(OPENCODE);
    await tick(0);
    setVisibility('hidden');
    await tick(AGENT_SOURCE_POLL_INTERVAL_MS * 3);
    expect(sourceReads()).toBe(1);
  });

  it('back: it reads at once, and the ticks go on', async () => {
    mountPane(OPENCODE);
    await tick(0);
    setVisibility('hidden');
    await tick(AGENT_SOURCE_POLL_INTERVAL_MS);
    await comeBack();
    expect(sourceReads()).toBe(2);
    await tick(AGENT_SOURCE_POLL_INTERVAL_MS);
    expect(sourceReads()).toBe(3);
  });

  it('mounted hidden: nothing until it is shown', async () => {
    setVisibility('hidden');
    mountPane(OPENCODE);
    await tick(AGENT_SOURCE_POLL_INTERVAL_MS);
    expect(sourceReads()).toBe(0);
    await comeBack();
    expect(sourceReads()).toBe(1);
  });

  it('a roster with no opencode asks nothing, coming back included (negative control, #2054)', async () => {
    mountPane(CLAUDE);
    await tick(AGENT_SOURCE_POLL_INTERVAL_MS);
    setVisibility('hidden');
    await comeBack();
    expect(sourceReads()).toBe(0);
  });

  it('unmounted: coming back asks nothing (negative control)', async () => {
    const view = mountPane(OPENCODE);
    await tick(0);
    view.unmount();
    setVisibility('hidden');
    await comeBack();
    expect(sourceReads()).toBe(1);
  });
});
