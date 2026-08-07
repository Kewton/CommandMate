/**
 * Session lifecycle -> structured-state generation (Issue #1723).
 *
 * The state machine is keyed by (worktreeId, cliToolId, instanceId), which a
 * recreated session reuses byte for byte. Without a fence, the last event of
 * the *previous* Claude process is indistinguishable from the current one's:
 * a session restarted while the old process was mid-turn would publish
 * `running`/`hook_prompt_submit` before anybody had typed into it, and
 * `commandmate wait` would sit on a brand-new idle session until `--timeout`.
 *
 * These tests drive the real `startClaudeSession()` / `stopClaudeSession()`, so
 * they fail if the calls are dropped from those paths — which is the only way
 * the unit-level generation tests can be prevented from passing vacuously.
 *
 * @vitest-environment node
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useIsolatedAgentHooksDir } from '@tests/helpers/agent-hooks-dir';

// Issue #1722 writes a hooks settings file on every session start; keep it out
// of the developer's real `~/.commandmate/hooks`.
useIsolatedAgentHooksDir('agent-event-generation-1723');

vi.mock('@/lib/tmux/tmux', () => ({
  hasSession: vi.fn(),
  createSession: vi.fn(),
  sendKeys: vi.fn(),
  capturePane: vi.fn(),
  killSession: vi.fn(),
  sendSpecialKey: vi.fn(),
  reconcileSessionGeometry: vi.fn().mockResolvedValue(false),
}));

vi.mock('fs/promises', () => ({
  access: vi.fn().mockResolvedValue(undefined),
  constants: { X_OK: 1 },
}));

vi.mock('child_process', () => ({
  exec: vi.fn((cmd: string, opts: unknown, cb?: unknown) => {
    const callback = (typeof opts === 'function' ? opts : cb) as (
      err: Error | null,
      result: { stdout: string; stderr: string },
    ) => void;
    callback(null, { stdout: cmd.includes('which claude') ? '/usr/local/bin/claude' : '', stderr: '' });
    return {};
  }),
}));

import {
  startClaudeSession,
  stopClaudeSession,
  CLAUDE_INIT_POLL_INTERVAL,
  CLAUDE_POST_PROMPT_DELAY,
} from '@/lib/session/claude-session';
import { hasSession, createSession, sendKeys, capturePane } from '@/lib/tmux/tmux';
import {
  clearAgentStopEvents,
  getAgentEventGenerationStartedAt,
  getStructuredSessionState,
  recordAgentEvent,
} from '@/lib/session/agent-event-state';

const WORKTREE_ID = 'wt-gen-1723';
const OPTIONS = { worktreeId: WORKTREE_ID, worktreePath: '/path/to/worktree' };

/** An event from the process that used to own this pane. */
function recordStalePromptSubmit(at: number): void {
  recordAgentEvent(WORKTREE_ID, 'claude', undefined, {
    event: 'user_prompt_submit',
    at,
    detail: null,
    sessionId: 'sess-old',
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  clearAgentStopEvents();
  vi.useFakeTimers();
  vi.mocked(hasSession).mockResolvedValue(false);
  vi.mocked(createSession).mockResolvedValue();
  vi.mocked(sendKeys).mockResolvedValue();
  vi.mocked(capturePane).mockResolvedValue('❯ ');
});

afterEach(() => {
  vi.useRealTimers();
  clearAgentStopEvents();
});

describe('startClaudeSession opens a generation (Issue #1723)', () => {
  it('invalidates the previous process events for the pane it reuses', async () => {
    recordStalePromptSubmit(Date.now() - 1_000);
    expect(getStructuredSessionState(WORKTREE_ID, 'claude')?.status).toBe('running');

    const promise = startClaudeSession(OPTIONS);
    await vi.advanceTimersByTimeAsync(100 + CLAUDE_INIT_POLL_INTERVAL * 2 + CLAUDE_POST_PROMPT_DELAY);
    await promise;

    expect(getStructuredSessionState(WORKTREE_ID, 'claude')).toBeNull();
    expect(getAgentEventGenerationStartedAt(WORKTREE_ID, 'claude')).not.toBeNull();
  });

  it('still fences off the old events when the start then fails', async () => {
    // Falling back to the scraper is always safe; trusting a dead session's
    // events is not, so the fence must not depend on the start succeeding.
    recordStalePromptSubmit(Date.now() - 1_000);
    vi.mocked(createSession).mockRejectedValue(new Error('tmux is gone'));

    await expect(startClaudeSession(OPTIONS)).rejects.toThrow();

    expect(getStructuredSessionState(WORKTREE_ID, 'claude')).toBeNull();
  });

  it('leaves the generation alone when it reuses a healthy session', async () => {
    // The pane and the agent process are the same ones the events came from.
    // Bumping here would throw away a live verdict on every reconnect.
    vi.mocked(hasSession).mockResolvedValue(true);
    recordStalePromptSubmit(Date.now() - 1_000);

    const promise = startClaudeSession(OPTIONS);
    await vi.advanceTimersByTimeAsync(CLAUDE_INIT_POLL_INTERVAL * 2 + CLAUDE_POST_PROMPT_DELAY);
    await promise;

    expect(createSession).not.toHaveBeenCalled();
    expect(getStructuredSessionState(WORKTREE_ID, 'claude')?.status).toBe('running');
    expect(getAgentEventGenerationStartedAt(WORKTREE_ID, 'claude')).toBeNull();
  });

  it('fences per instance, not per worktree', async () => {
    recordAgentEvent(WORKTREE_ID, 'claude', 'claude-2', {
      event: 'user_prompt_submit',
      at: Date.now() - 1_000,
      detail: null,
      sessionId: 'sess-other',
    });

    const promise = startClaudeSession(OPTIONS);
    await vi.advanceTimersByTimeAsync(100 + CLAUDE_INIT_POLL_INTERVAL * 2 + CLAUDE_POST_PROMPT_DELAY);
    await promise;

    // `claude-2` is a different agent in the same worktree; restarting the
    // primary instance says nothing about it.
    expect(getStructuredSessionState(WORKTREE_ID, 'claude', 'claude-2')?.status).toBe('running');
  });
});

describe('stopClaudeSession discards the structured state (Issue #1723)', () => {
  it('drops the verdict for the session it stopped', async () => {
    recordStalePromptSubmit(Date.now() - 1_000);

    await stopClaudeSession(WORKTREE_ID);

    expect(getStructuredSessionState(WORKTREE_ID, 'claude')).toBeNull();
  });

  it('leaves other instances alone', async () => {
    recordAgentEvent(WORKTREE_ID, 'claude', 'claude-2', {
      event: 'user_prompt_submit',
      at: Date.now() - 1_000,
      detail: null,
      sessionId: 'sess-other',
    });

    await stopClaudeSession(WORKTREE_ID);

    expect(getStructuredSessionState(WORKTREE_ID, 'claude', 'claude-2')?.status).toBe('running');
  });
});
