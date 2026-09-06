/**
 * When a restart keeps the response hash, and when it drops it (Issue #2230).
 *
 * `stopPollingByKey()` used to drop the response hash on every stop, including
 * the one `startPolling()` performs on its way to a fresh chain. The Issue's
 * question was whether that drop can land while the pane is still showing the
 * turn the hash protects. It can, on one production path: `checkForResponse()`
 * records a prompt and stops its own chain (claude and every other non-TUI
 * tool), and the `/respond` that answers it calls `startPolling()` — with the
 * screen back on the previous, already-saved reply.
 *
 * The rule pinned here is the whole fix, stated from the core's point of view
 * (the checker is a stub — the real one is exercised in
 * tests/integration/response-poller-restart-dedup-2230.test.ts):
 *
 * - a chain that stops itself and reports "recorded" on a non-TUI tool has
 *   PAUSED on a prompt — the response hash stays, the prompt hash goes;
 * - a chain that stops itself on a full-screen TUI after "recorded" has saved
 *   its reply — the turn is over, everything goes (as before);
 * - a chain that stops itself and reports nothing has lost its session —
 *   everything goes (as before);
 * - `startPolling()` on a paused key RESUMES: the hash is kept once, and the
 *   mark is consumed;
 * - `startPolling()` on a running chain, or on a key with no pause mark, opens
 *   a NEW cycle: the hash goes (Issue #1268);
 * - an explicit `stopPolling()` / `stopAllPolling()` ends a pause and drops the
 *   hash; a worktree-ID migration carries a paused key's hash and mark.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const stubs = vi.hoisted(() => ({
  checkForResponse: vi.fn(async () => false),
  broadcastTerminalSnapshot: vi.fn(async () => {}),
}));

vi.mock('@/lib/polling/response-checker', () => ({
  checkForResponse: stubs.checkForResponse,
}));
vi.mock('@/lib/realtime/terminal-broadcast', () => ({
  broadcastTerminalSnapshot: stubs.broadcastTerminalSnapshot,
}));

const WT = 'wt-2230';
const KEY = `${WT}:claude`;
const COPILOT_KEY = `${WT}:copilot`;
const POLLING_INTERVAL = 2000;

interface Bundle {
  core: typeof import('@/lib/polling/response-poller-core');
  promptDedup: typeof import('@/lib/polling/prompt-dedup');
  responseDedup: typeof import('@/lib/polling/response-dedup');
  tui: typeof import('@/lib/tui-accumulator');
}

async function loadBundle(): Promise<Bundle> {
  vi.resetModules();
  return {
    core: await import('@/lib/polling/response-poller-core'),
    promptDedup: await import('@/lib/polling/prompt-dedup'),
    responseDedup: await import('@/lib/polling/response-dedup'),
    tui: await import('@/lib/tui-accumulator'),
  };
}

interface CoordinatorShape {
  activePollers: Map<string, NodeJS.Timeout>;
  pollingStartTimes: Map<string, number>;
  owners: Map<string, unknown>;
  running: Map<string, unknown>;
  pendingRestart: Map<string, unknown>;
  pausedOnPrompt: Set<string>;
}

function coordinator(): CoordinatorShape | undefined {
  return (globalThis as { __responsePollerCoordinator?: CoordinatorShape }).__responsePollerCoordinator;
}

function responseHashCache(): Map<string, string> | undefined {
  return (globalThis as { __responseHashCache?: Map<string, string> }).__responseHashCache;
}

function resetProcessState(): void {
  const g = globalThis as {
    __responsePollerCoordinator?: CoordinatorShape;
    __tuiResponseAccumulator?: Map<string, unknown>;
    __promptHashCache?: Map<string, string>;
    __responseHashCache?: Map<string, string>;
  };
  const c = g.__responsePollerCoordinator;
  if (c) {
    for (const timer of c.activePollers.values()) clearTimeout(timer);
    c.activePollers.clear();
    c.pollingStartTimes.clear();
    c.owners.clear();
    c.running.clear();
    c.pendingRestart.clear();
    c.pausedOnPrompt?.clear();
  }
  g.__tuiResponseAccumulator?.clear();
  g.__promptHashCache?.clear();
  g.__responseHashCache?.clear();
}

/** Let every already-resolved continuation run without advancing the clock. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
  await vi.advanceTimersByTimeAsync(0);
}

/**
 * Run one tick whose `checkForResponse` fills the dedup caches the way the real
 * one does on its way to a verdict, then stops its own chain and returns
 * `recorded`. This is the shape of the checker's prompt path (`recorded`
 * true, non-TUI), TUI save path (`recorded` true, TUI) and session-gone path
 * (`recorded` false).
 */
async function tickThatStopsItself(
  bundle: Bundle,
  cliToolId: 'claude' | 'copilot',
  recorded: boolean,
): Promise<void> {
  const key = `${WT}:${cliToolId}`;
  stubs.checkForResponse.mockImplementationOnce(async () => {
    bundle.responseDedup.isDuplicateResponse(key, 'the reply on screen');
    bundle.promptDedup.isDuplicatePrompt(key, 'Proceed?');
    if (cliToolId === 'copilot') bundle.tui.accumulateTuiContent(key, 'a line', 'copilot');
    bundle.core.stopPolling(WT, cliToolId);
    return recorded;
  });
  await vi.advanceTimersByTimeAsync(POLLING_INTERVAL);
  await settle();
}

beforeEach(() => {
  vi.useFakeTimers();
  resetProcessState();
  stubs.checkForResponse.mockReset();
  stubs.checkForResponse.mockImplementation(async () => false);
  stubs.broadcastTerminalSnapshot.mockReset();
  stubs.broadcastTerminalSnapshot.mockImplementation(async () => {});
});

afterEach(() => {
  resetProcessState();
  vi.useRealTimers();
});

describe('a chain that stops itself', () => {
  it('after recording on a non-TUI tool is PAUSED: response hash kept, prompt hash and timer gone', async () => {
    const b = await loadBundle();
    b.core.startPolling(WT, 'claude');

    await tickThatStopsItself(b, 'claude', true);

    expect(b.core.getActivePollers()).toEqual([]);
    expect(coordinator()?.pausedOnPrompt.has(KEY)).toBe(true);
    // The reply hash is still there: the same screen must not be saved again.
    expect(b.responseDedup.isDuplicateResponse(KEY, 'the reply on screen')).toBe(true);
    // The prompt hash is not: if the dialog is still up after the answer, the
    // operator gets a new card rather than silence.
    expect(b.promptDedup.isDuplicatePrompt(KEY, 'Proceed?')).toBe(false);
  });

  it('after recording on a full-screen TUI has saved its reply: everything gone (as before)', async () => {
    const b = await loadBundle();
    b.core.startPolling(WT, 'copilot');

    await tickThatStopsItself(b, 'copilot', true);

    expect(b.core.getActivePollers()).toEqual([]);
    expect(coordinator()?.pausedOnPrompt.has(COPILOT_KEY)).toBe(false);
    expect(b.responseDedup.isDuplicateResponse(COPILOT_KEY, 'the reply on screen')).toBe(false);
    expect(b.promptDedup.isDuplicatePrompt(COPILOT_KEY, 'Proceed?')).toBe(false);
    expect(b.tui.getAccumulatedContent(COPILOT_KEY)).toBe('');
  });

  it('without recording anything has lost its session: everything gone (as before)', async () => {
    const b = await loadBundle();
    b.core.startPolling(WT, 'claude');

    await tickThatStopsItself(b, 'claude', false);

    expect(coordinator()?.pausedOnPrompt.has(KEY)).toBe(false);
    expect(b.responseDedup.isDuplicateResponse(KEY, 'the reply on screen')).toBe(false);
  });

  it('whose checkForResponse throws after the stop is treated as nothing recorded', async () => {
    const b = await loadBundle();
    b.core.startPolling(WT, 'claude');

    stubs.checkForResponse.mockImplementationOnce(async () => {
      b.responseDedup.isDuplicateResponse(KEY, 'the reply on screen');
      b.core.stopPolling(WT, 'claude');
      throw new Error('capture failed');
    });
    await vi.advanceTimersByTimeAsync(POLLING_INTERVAL);
    await settle();

    expect(coordinator()?.pausedOnPrompt.has(KEY)).toBe(false);
    expect(b.responseDedup.isDuplicateResponse(KEY, 'the reply on screen')).toBe(false);
  });
});

describe('startPolling() on a paused key', () => {
  it('resumes: the response hash survives the restart and the pause mark is consumed', async () => {
    const b = await loadBundle();
    b.core.startPolling(WT, 'claude');
    await tickThatStopsItself(b, 'claude', true);

    b.core.startPolling(WT, 'claude'); // what /respond does

    expect(b.core.getActivePollers()).toEqual([KEY]);
    expect(coordinator()?.pausedOnPrompt.has(KEY)).toBe(false);
    expect(b.responseDedup.isDuplicateResponse(KEY, 'the reply on screen')).toBe(true);
  });

  it('resumes from another module instance too — the mark is process-wide', async () => {
    const a = await loadBundle();
    const b = await loadBundle();
    expect(a.core).not.toBe(b.core);

    a.core.startPolling(WT, 'claude');
    await tickThatStopsItself(a, 'claude', true);

    // The route bundle that serves /respond is a different evaluation from the
    // server graph whose tick paused.
    b.core.startPolling(WT, 'claude');

    expect(a.responseDedup.isDuplicateResponse(KEY, 'the reply on screen')).toBe(true);
  });

  it('a second restart after the resume — the running chain — is a new cycle (Issue #1268)', async () => {
    const b = await loadBundle();
    b.core.startPolling(WT, 'claude');
    await tickThatStopsItself(b, 'claude', true);
    b.core.startPolling(WT, 'claude'); // /respond: resume
    expect(b.responseDedup.isDuplicateResponse(KEY, 'the reply on screen')).toBe(true);

    b.core.startPolling(WT, 'claude'); // /send: the next turn

    expect(b.responseDedup.isDuplicateResponse(KEY, 'the reply on screen')).toBe(false);
  });

  it('a pause can be resumed again after a second prompt in the same turn', async () => {
    const b = await loadBundle();
    b.core.startPolling(WT, 'claude');
    await tickThatStopsItself(b, 'claude', true);
    b.core.startPolling(WT, 'claude');

    await tickThatStopsItself(b, 'claude', true);
    expect(coordinator()?.pausedOnPrompt.has(KEY)).toBe(true);
    b.core.startPolling(WT, 'claude');

    expect(b.core.getActivePollers()).toEqual([KEY]);
    expect(b.responseDedup.isDuplicateResponse(KEY, 'the reply on screen')).toBe(true);
  });
});

describe('startPolling() on a running chain', () => {
  it('drops the response hash — the previous chain did not pause, so this is the next turn (Issue #1268)', async () => {
    const b = await loadBundle();
    b.core.startPolling(WT, 'claude');
    stubs.checkForResponse.mockImplementationOnce(async () => {
      b.responseDedup.isDuplicateResponse(KEY, 'the reply on screen');
      return true; // saved, chain keeps ticking (claude is not a full-screen TUI)
    });
    await vi.advanceTimersByTimeAsync(POLLING_INTERVAL);
    await settle();
    expect(b.core.getActivePollers()).toEqual([KEY]);
    expect(b.responseDedup.isDuplicateResponse(KEY, 'the reply on screen')).toBe(true);

    b.core.startPolling(WT, 'claude');

    expect(b.responseDedup.isDuplicateResponse(KEY, 'the reply on screen')).toBe(false);
  });

  it('queued behind an in-flight tick whose own stop is stale: the queued restart opens a new cycle', async () => {
    const b = await loadBundle();
    b.core.startPolling(WT, 'claude');

    // The tick is inside checkForResponse when the restart arrives. Note that the
    // restart supersedes the tick, so the tick's own stopPolling() is stale and
    // ignored — the chain does NOT pause; the queued restart opens a new cycle.
    // Pinned so the two #2223 rules and the #2230 rule are seen to agree.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    stubs.checkForResponse.mockImplementationOnce(async () => {
      b.responseDedup.isDuplicateResponse(KEY, 'the reply on screen');
      await gate;
      b.core.stopPolling(WT, 'claude');
      return true;
    });
    await vi.advanceTimersByTimeAsync(POLLING_INTERVAL);

    b.core.startPolling(WT, 'claude');
    release();
    await settle();

    expect(b.core.getActivePollers()).toEqual([KEY]);
    expect(coordinator()?.pausedOnPrompt.has(KEY)).toBe(false);
    expect(b.responseDedup.isDuplicateResponse(KEY, 'the reply on screen')).toBe(false);
  });
});

describe('ending a pause', () => {
  it('an explicit stopPolling() on a paused key drops the hash and the mark', async () => {
    const b = await loadBundle();
    b.core.startPolling(WT, 'claude');
    await tickThatStopsItself(b, 'claude', true);

    b.core.stopPolling(WT, 'claude'); // kill-session / session-cleanup

    expect(coordinator()?.pausedOnPrompt.has(KEY)).toBe(false);
    expect(b.responseDedup.isDuplicateResponse(KEY, 'the reply on screen')).toBe(false);
    // And the start that follows is a fresh cycle, not a resume.
    b.responseDedup.isDuplicateResponse(KEY, 'the reply on screen');
    b.core.startPolling(WT, 'claude');
    expect(b.responseDedup.isDuplicateResponse(KEY, 'the reply on screen')).toBe(false);
  });

  it('stopAllPolling() reaches paused keys, which hold no timer', async () => {
    const b = await loadBundle();
    b.core.startPolling(WT, 'claude');
    await tickThatStopsItself(b, 'claude', true);
    expect(b.core.getActivePollers()).toEqual([]);

    b.core.stopAllPolling();

    expect(coordinator()?.pausedOnPrompt.size).toBe(0);
    expect(responseHashCache()?.has(KEY)).toBe(false);
  });

  it('a worktree-ID migration carries a paused key’s hash and mark to the new ID', async () => {
    const b = await loadBundle();
    b.core.startPolling(WT, 'claude');
    await tickThatStopsItself(b, 'claude', true);

    const moved = b.core.migrateResponsePollerWorktreeIds(
      [{ oldId: WT, newId: 'wt-2230-renamed' }],
      () => 'claude'
    );

    // Nothing was running, so nothing was restarted…
    expect(moved).toEqual([]);
    expect(b.core.getActivePollers()).toEqual([]);
    // …but the pause followed the rename, so the /respond under the new ID
    // resumes rather than re-saving the screen.
    const newKey = 'wt-2230-renamed:claude';
    expect(coordinator()?.pausedOnPrompt.has(KEY)).toBe(false);
    expect(coordinator()?.pausedOnPrompt.has(newKey)).toBe(true);
    expect(b.responseDedup.isDuplicateResponse(newKey, 'the reply on screen')).toBe(true);

    b.core.startPolling('wt-2230-renamed', 'claude');
    expect(b.responseDedup.isDuplicateResponse(newKey, 'the reply on screen')).toBe(true);
  });
});
