/**
 * The `send` guard sees what the payload sees (Issue #1737).
 *
 * #1708 put a guard in front of `send`; #1725 taught `buildCurrentOutput` that a
 * dialog reported by the agent's own hooks is a dialog even when the terminal
 * scraper cannot see one. The guard never went through that composition, so the
 * server published `isPromptWaiting: true` and accepted the send anyway — the
 * #1708 hazard, still open on the one path #1708 existed to close.
 *
 * Closing it is the easy half. The hard half is that a structured record is
 * released by events that may never arrive (hooks are fail-open; the scraper
 * that never saw the dialog cannot report it gone), and a stuck record that
 * refuses sends is a session nobody — including the operator trying to unstick
 * it — can talk to. That is a worse failure than the one being fixed, and it is
 * why #1725's author left this alone. So the tests below pin the bounds as hard
 * as they pin the guard:
 *
 *   (a) structured-only waiting refuses the send;
 *   (b) a release event lets it through;
 *   (c) so does time, with no release event at all;
 *   (d) a capture that throws fails open, exactly as before.
 *
 * Every case states the scraper's verdict for its frame, because an OR is the
 * kind of rule that passes a careless suite while wired as an AND.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join, relative } from 'path';
import { fileURLToPath } from 'url';

const { mockLogger } = vi.hoisted(() => ({
  mockLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    withContext: vi.fn().mockReturnThis(),
  },
}));
vi.mock('@/lib/logger', () => ({
  createLogger: vi.fn(() => mockLogger),
  generateRequestId: vi.fn(() => 'test-request-id'),
}));

const isRunning = vi.fn().mockResolvedValue(true);
vi.mock('@/lib/cli-tools/manager', () => ({
  CLIToolManager: {
    getInstance: () => ({ getTool: () => ({ isRunning: (...a: unknown[]) => isRunning(...a) }) }),
  },
}));
vi.mock('@/lib/session/cli-session', () => ({ captureSessionOutput: vi.fn() }));

import { captureSessionOutput } from '@/lib/session/cli-session';
import {
  isPromptWaiting,
  promptWaitingMessage,
} from '@/lib/session/prompt-waiting-guard';
import {
  STRUCTURED_SEND_BLOCK_MAX_AGE_MS,
  STRUCTURED_SEND_GUARD_ENV,
} from '@/lib/session/prompt-waiting-composition';
import {
  clearAgentStopEvents,
  getStructuredPromptWaiting,
  recordAgentEvent,
  reportPermissionRequestPending,
} from '@/lib/session/agent-event-state';
import { buildClaude1000RowPermissionFrame } from '../../fixtures/claude-1000-row-prompt';

const WORKTREE_ID = 'wt-1737';

/** A frame the scraper reads as `running`/`default` — no prompt in it at all. */
const BUSY_FRAME = 'writing files\nediting src/app/page.tsx\n';

/** A frame the scraper reads as a `multiple_choice` prompt. */
const PROMPT_FRAME = buildClaude1000RowPermissionFrame();

const NOTIFICATION_MESSAGE = 'Claude needs your permission to use Bash';

/** The hook the agent posts when it draws a permission dialog. */
function openDialogEvent(at: number = Date.now() - 1_000): void {
  recordAgentEvent(WORKTREE_ID, 'claude', 'claude', {
    event: 'notification',
    at,
    detail: 'permission_prompt',
    sessionId: 'sess-1737',
    message: NOTIFICATION_MESSAGE,
  });
}

function guard(options?: { ignoreStructured?: boolean }) {
  return isPromptWaiting(WORKTREE_ID, 'claude', 'claude', options);
}

beforeEach(() => {
  vi.clearAllMocks();
  clearAgentStopEvents();
  delete process.env[STRUCTURED_SEND_GUARD_ENV];
  isRunning.mockResolvedValue(true);
  vi.mocked(captureSessionOutput).mockResolvedValue(BUSY_FRAME);
});

afterEach(() => {
  delete process.env[STRUCTURED_SEND_GUARD_ENV];
});

describe('(a) a dialog only the structured layer can see refuses the send', () => {
  it('refuses on a frame the scraper reads as busy', async () => {
    openDialogEvent();

    const verdict = await guard();

    expect(verdict.waiting).toBe(true);
    expect(verdict.blockedBy).toBe('structured');
    // The same reason string the payload publishes for this state, so the two
    // surfaces name it identically.
    expect(verdict.reason).toBe('hook_permission_prompt');
  });

  it('does not refuse that same frame when no event arrived', async () => {
    // The control the OR needs: without this, a guard hard-wired to `true`
    // passes the case above.
    const verdict = await guard();

    expect(verdict.waiting).toBe(false);
    expect(verdict.blockedBy).toBeUndefined();
  });

  it('still refuses a prompt the scraper can see, with the detector reason', async () => {
    vi.mocked(captureSessionOutput).mockResolvedValue(PROMPT_FRAME);

    const verdict = await guard();

    expect(verdict.waiting).toBe(true);
    expect(verdict.blockedBy).toBe('scraper');
    expect(verdict.reason).toBe('prompt_detected');
  });

  it('refuses on the provisional PermissionRequest record too, while it lasts', async () => {
    reportPermissionRequestPending(WORKTREE_ID, 'claude', 'claude', 'Bash', Date.now());

    const verdict = await guard();

    expect(verdict.waiting).toBe(true);
    expect(verdict.reason).toBe('hook_permission_request');
  });

  it('leaves a session that is not running alone', async () => {
    openDialogEvent();
    isRunning.mockResolvedValue(false);

    expect((await guard()).waiting).toBe(false);
  });
});

describe('(b) a release event lets the send through', () => {
  it('passes after the Stop that ends the turn', async () => {
    openDialogEvent();
    expect((await guard()).waiting).toBe(true);

    recordAgentEvent(WORKTREE_ID, 'claude', 'claude', {
      event: 'stop',
      at: Date.now(),
      detail: null,
      sessionId: 'sess-1737',
    });

    expect((await guard()).waiting).toBe(false);
  });

  it('passes after the PostToolUse that means a human answered', async () => {
    openDialogEvent();
    recordAgentEvent(WORKTREE_ID, 'claude', 'claude', {
      event: 'post_tool_use',
      at: Date.now(),
      detail: 'Bash',
      sessionId: 'sess-1737',
    });

    expect((await guard()).waiting).toBe(false);
  });

  it('passes once the scraper has seen the dialog and then seen it gone', async () => {
    // The guard runs the same release rule as the poller, so a send is one of
    // the observations that can retire a record — not a reader that watches a
    // state only somebody else is allowed to clear.
    openDialogEvent();
    vi.mocked(captureSessionOutput).mockResolvedValue(PROMPT_FRAME);
    expect((await guard()).blockedBy).toBe('scraper');

    vi.mocked(captureSessionOutput).mockResolvedValue(BUSY_FRAME);

    expect((await guard()).waiting).toBe(false);
    expect(getStructuredPromptWaiting(WORKTREE_ID, 'claude', 'claude')).toBeNull();
  });
});

describe('(c) time lets the send through even when no release ever arrives', () => {
  it('stops refusing once the record is older than the send-block bound', async () => {
    openDialogEvent(Date.now() - STRUCTURED_SEND_BLOCK_MAX_AGE_MS - 1_000);

    const verdict = await guard();

    expect(verdict.waiting).toBe(false);
    // The record itself is still there — it has outlived its veto over sends,
    // not its published fact. `wait` and the UI go on reporting the dialog.
    expect(getStructuredPromptWaiting(WORKTREE_ID, 'claude', 'claude')).not.toBeNull();
    expect(mockLogger.info).toHaveBeenCalledWith(
      'structured-send-guard-not-applied',
      expect.objectContaining({ suppressed: 'expired' }),
    );
  });

  it('still refuses just inside the bound', async () => {
    // Without this the case above passes on a guard that expires everything.
    openDialogEvent(Date.now() - STRUCTURED_SEND_BLOCK_MAX_AGE_MS + 60_000);

    expect((await guard()).waiting).toBe(true);
  });

  it('never expires a prompt the scraper can see', async () => {
    // The scraper re-reads the live frame every time, so its verdict needs no
    // bound — and must not inherit one. An hour-old dialog that is still on
    // screen is still a dialog.
    vi.mocked(captureSessionOutput).mockResolvedValue(PROMPT_FRAME);
    openDialogEvent(Date.now() - 60 * 60 * 1000);

    expect((await guard()).waiting).toBe(true);
  });
});

describe('(d) a capture that throws fails open, as it always did', () => {
  it('allows the send even with a structured dialog open', async () => {
    openDialogEvent();
    vi.mocked(captureSessionOutput).mockRejectedValue(new Error('tmux gone'));

    expect((await guard()).waiting).toBe(false);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      'prompt-waiting-check-failed',
      expect.objectContaining({ worktreeId: WORKTREE_ID }),
    );
  });
});

describe('the escape hatches (Issue #1737)', () => {
  it('waives the structured veto for one send', async () => {
    openDialogEvent();
    expect((await guard()).waiting).toBe(true);

    expect((await guard({ ignoreStructured: true })).waiting).toBe(false);

    // One send, not a mode: the next send with no opt-out is refused again.
    expect((await guard()).waiting).toBe(true);
  });

  it('waives it for the whole server when the env switch is off', async () => {
    openDialogEvent();
    process.env[STRUCTURED_SEND_GUARD_ENV] = 'off';

    expect((await guard()).waiting).toBe(false);
    expect(mockLogger.info).toHaveBeenCalledWith(
      'structured-send-guard-not-applied',
      expect.objectContaining({ suppressed: 'disabled' }),
    );
  });

  it('keeps the structured veto for any other env value', async () => {
    openDialogEvent();
    process.env[STRUCTURED_SEND_GUARD_ENV] = 'on';

    expect((await guard()).waiting).toBe(true);
  });

  it('does not waive a prompt the scraper can see', async () => {
    // The narrowness is the point. A dialog on screen is answerable, and typing
    // into it is the #1708 damage; nothing here should hand an operator a way to
    // do that by accident.
    vi.mocked(captureSessionOutput).mockResolvedValue(PROMPT_FRAME);
    openDialogEvent();
    process.env[STRUCTURED_SEND_GUARD_ENV] = 'off';

    expect((await guard({ ignoreStructured: true })).waiting).toBe(true);
  });
});

describe('the refusal says how to get out of it', () => {
  it('names respond for a prompt on screen, and nothing else', async () => {
    const message = promptWaitingMessage(WORKTREE_ID, 'scraper');

    expect(message).toContain(`commandmate respond ${WORKTREE_ID}`);
    expect(message).not.toContain('--ignore-structured-prompt');
  });

  it('names the bypass and the bound for a dialog nobody can see', async () => {
    const message = promptWaitingMessage(WORKTREE_ID, 'structured');

    expect(message).toContain(`commandmate respond ${WORKTREE_ID}`);
    expect(message).toContain('--ignore-structured-prompt');
    expect(message).toContain(STRUCTURED_SEND_GUARD_ENV);
    expect(message).toContain(`${Math.round(STRUCTURED_SEND_BLOCK_MAX_AGE_MS / 60_000)} minutes`);
  });
});

describe('one composition, not two (the defect this Issue is about)', () => {
  // #1737 happened because "is a prompt waiting?" had two implementations. A
  // test that only checked the guard's new behaviour would let a third grow.
  const SRC = fileURLToPath(new URL('../../../src/', import.meta.url));

  function sourcesCalling(fragment: string): string[] {
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.ts') && readFileSync(full, 'utf8').includes(fragment)) {
          hits.push(relative(SRC, full));
        }
      }
    };
    walk(SRC);
    return hits.sort();
  }

  it('resolves the structured record in exactly one module', () => {
    // Whoever calls these runs the release rule, and a caller that runs it
    // alone is a second answer to the same question by construction.
    for (const call of [
      'getStructuredPromptWaiting(',
      'corroborateStructuredPromptWaiting(',
      'clearStructuredPromptWaiting(',
    ]) {
      expect(sourcesCalling(call)).toEqual([
        'lib/session/agent-event-state.ts', // where they are defined
        'lib/session/prompt-waiting-composition.ts',
      ]);
    }
  });

  it('composes the OR in exactly one module', () => {
    expect(sourcesCalling('resolvePromptWaiting(').sort()).toEqual([
      'lib/session/current-output-builder.ts',
      'lib/session/prompt-waiting-composition.ts',
      'lib/session/prompt-waiting-guard.ts',
    ]);
  });
});
