/**
 * `CodexTool.startSession`'s end of the structured-event pipeline (Issue #1760).
 *
 * Three things are asserted here that no other suite can see, and each of them
 * is silent when it breaks:
 *
 *  - **the generation fence.** Without `beginAgentSession` the state keyed by
 *    (worktree, tool, instance) survives the process that produced it, so a
 *    session created a second later inherits the previous one's
 *    `user_prompt_submit` and publishes `running` before anybody has typed into
 *    it (#1723). Nothing fails; the status is merely wrong. It is asserted
 *    against `agent-event-state` rather than against a spy, so removing the
 *    call cannot be compensated for by some other code path.
 *  - **the injected launch line.** The correlation keys are the only thing that
 *    tells `codex` from `codex-2`, and they reach the hooks solely through the
 *    environment of the process this method starts.
 *  - **the hooks review dialog.** Writing codex's config puts a dialog in front
 *    of the first launch that `getCodexActiveDialog` classifies as `null` and
 *    `isCodexPromptReady` rejects, so an unhandled one costs the whole 30-poll
 *    window and hands `sendMessage` a session sitting on a menu.
 *
 * Separate file so `vi.mock` does not affect codex.test.ts (the precedent set
 * by codex-startup-dialog.test.ts).
 *
 * @vitest-environment node
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

vi.mock('@/lib/tmux/tmux', () => ({
  hasSession: vi.fn(),
  createSession: vi.fn(),
  sendKeys: vi.fn(),
  capturePane: vi.fn(),
  killSession: vi.fn(),
  sendSpecialKey: vi.fn(),
  sendSpecialKeys: vi.fn(),
  reconcileSessionGeometry: vi.fn().mockResolvedValue(false),
}));

vi.mock('@/lib/cli-tools/validation', () => ({ validateSessionName: vi.fn() }));

// BaseCLITool.isInstalled() uses promisify(exec); resolve it so isInstalled() === true
vi.mock('child_process', () => ({ exec: vi.fn() }));
vi.mock('util', async (importOriginal) => {
  const actual = await importOriginal<typeof import('util')>();
  return { ...actual, promisify: () => vi.fn().mockResolvedValue(undefined) };
});

import { CodexTool, isCodexHooksReviewDialog } from '@/lib/cli-tools/codex';
import { capturePane, createSession, hasSession, sendKeys } from '@/lib/tmux/tmux';
import { getAgentEventGenerationStartedAt, recordAgentEvent } from '@/lib/session/agent-event-state';
import { getCodexHooksPath } from '@/lib/hooks/sources/codex/hooks-config';
import {
  CODEX_HOOKS_REVIEW_PANE,
  CODEX_READY_PANE,
} from '../../fixtures/codex-hooks-review-0148';

const WORKTREE_ID = 'wt-codex-1760';
const WORKTREE_PATH = '/tmp/wt-codex-1760';

// Issue #1829: re-pinned against the codex-cli 0.148.0 capture. The wording that
// changed is the hook COUNT ("5 hooks are new or changed." -> "4"), which is
// data and which neither anchor reads; the screen is otherwise the same one.
const READY_PANE = CODEX_READY_PANE;
const HOOKS_REVIEW_PANE = CODEX_HOOKS_REVIEW_PANE;

const MANAGED_ENV = ['CM_AGENT_HOOKS_INJECT', 'CODEX_HOME', 'CM_PORT', 'MCBD_PORT'] as const;
let saved: Record<string, string | undefined>;
let home: string;

beforeEach(() => {
  vi.clearAllMocks();
  saved = Object.fromEntries(MANAGED_ENV.map((key) => [key, process.env[key]]));
  for (const key of MANAGED_ENV) delete process.env[key];
  home = mkdtempSync(join(tmpdir(), 'codex-session-home-'));
  process.env.CODEX_HOME = home;
  process.env.CM_PORT = '4321';
  vi.mocked(hasSession).mockResolvedValue(false);
  vi.mocked(capturePane).mockResolvedValue(READY_PANE);
});

afterEach(() => {
  for (const key of MANAGED_ENV) {
    const value = saved[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

/** The command the tool typed into the pane to start codex. */
function launchCommand(): string {
  const call = vi.mocked(sendKeys).mock.calls.find(([, keys]) => String(keys).includes('codex'));
  return call ? String(call[1]) : '';
}

describe('startSession fences the previous session’s events', () => {
  it('opens a new generation before the pane exists', async () => {
    // A verdict from the process that used to own this key…
    recordAgentEvent(WORKTREE_ID, 'codex', 'codex', {
      event: 'user_prompt_submit',
      at: 1_000,
      detail: null,
      sessionId: null,
    });

    await new CodexTool().startSession(WORKTREE_ID, WORKTREE_PATH);

    // …is now behind the fence, so the new session is not "running" because of it.
    const startedAt = getAgentEventGenerationStartedAt(WORKTREE_ID, 'codex', 'codex');
    expect(startedAt).not.toBeNull();
    expect(startedAt!).toBeGreaterThan(1_000);
    // And the fence went up before the pane, never after it.
    expect(vi.mocked(createSession)).toHaveBeenCalledTimes(1);
  });

  it('fences the instance that is starting, not the primary', async () => {
    await new CodexTool().startSession(WORKTREE_ID, WORKTREE_PATH, 'codex-2');
    expect(getAgentEventGenerationStartedAt(WORKTREE_ID, 'codex', 'codex-2')).not.toBeNull();
  });

  it('fences even when the launch then fails', async () => {
    // Falling back to the screen scraper is always safe; trusting a dead
    // session's events is not.
    vi.mocked(createSession).mockRejectedValueOnce(new Error('tmux is not installed'));
    await expect(
      new CodexTool().startSession('wt-codex-fail', WORKTREE_PATH)
    ).rejects.toThrow(/Failed to start Codex session/);
    expect(getAgentEventGenerationStartedAt('wt-codex-fail', 'codex', 'codex')).not.toBeNull();
  });

  it('does not fence a session it merely reused', async () => {
    // The same generation: fencing here would discard a still-valid verdict on
    // every reconnect.
    vi.mocked(hasSession).mockResolvedValue(true);
    await new CodexTool().startSession('wt-codex-reuse', WORKTREE_PATH);
    expect(getAgentEventGenerationStartedAt('wt-codex-reuse', 'codex', 'codex')).toBeNull();
    expect(vi.mocked(createSession)).not.toHaveBeenCalled();
  });
});

describe('startSession injects the correlation keys', () => {
  it('starts codex with the worktree, the instance and both receiver URLs', async () => {
    await new CodexTool().startSession(WORKTREE_ID, WORKTREE_PATH, 'codex-2');
    const command = launchCommand();
    expect(command).toContain(`CM_AGENT_WORKTREE_ID='${WORKTREE_ID}'`);
    expect(command).toContain("CM_AGENT_INSTANCE_ID='codex-2'");
    expect(command).toContain("CM_HOOK_URL='http://127.0.0.1:4321/api/hooks/agent-event'");
    expect(command).toContain('instanceId=codex-2');
    expect(command.endsWith("'codex'")).toBe(true);
  });

  it('writes the hooks file codex will read', async () => {
    await new CodexTool().startSession(WORKTREE_ID, WORKTREE_PATH);
    const written = JSON.parse(readFileSync(getCodexHooksPath(), 'utf8'));
    expect(Object.keys(written.hooks).sort()).toEqual([
      'PermissionRequest',
      'SessionEnd',
      'SessionStart',
      'Stop',
      'UserPromptSubmit',
    ]);
  });

  it('starts exactly the pre-#1760 command when injection is switched off', async () => {
    process.env.CM_AGENT_HOOKS_INJECT = '0';
    await new CodexTool().startSession(WORKTREE_ID, WORKTREE_PATH);
    expect(launchCommand()).toBe('codex');
    expect(vi.mocked(sendKeys)).toHaveBeenCalledWith('mcbd-codex-wt-codex-1760', 'codex', true);
  });
});

describe('the hooks review dialog', () => {
  it('is what a pane capture of it looks like, and a ready prompt is not', () => {
    expect(isCodexHooksReviewDialog(HOOKS_REVIEW_PANE)).toBe(true);
    expect(isCodexHooksReviewDialog(READY_PANE)).toBe(false);
    // Both anchors are required: the word "hooks" alone must not select an
    // option on a live prompt.
    expect(isCodexHooksReviewDialog('  Hooks need review')).toBe(false);
  });

  it('is declined, so the session reaches its prompt without trusting anything', async () => {
    // Trusting would write `[hooks.state…]` into the operator's own
    // ~/.codex/config.toml — the file that also carries their `notify` command.
    vi.mocked(capturePane)
      .mockResolvedValueOnce(HOOKS_REVIEW_PANE)
      .mockResolvedValue(READY_PANE);

    await new CodexTool().startSession(WORKTREE_ID, WORKTREE_PATH);

    const keys = vi.mocked(sendKeys).mock.calls.map(([, sent, enter]) => [sent, enter]);
    // Sent alone: codex confirms a numbered selection instantly, and a trailing
    // Enter would land on the next screen (Issue #890).
    expect(keys).toContainEqual(['3', false]);
    expect(keys).not.toContainEqual(['2', false]);
  });

  it('is answered once, however long it stays on screen', async () => {
    // capturePane(50) keeps a dismissed dialog in scrollback; without the
    // one-shot guard the live prompt would collect "333…".
    vi.mocked(capturePane)
      .mockResolvedValueOnce(HOOKS_REVIEW_PANE)
      .mockResolvedValueOnce(HOOKS_REVIEW_PANE)
      .mockResolvedValue(READY_PANE);

    await new CodexTool().startSession(WORKTREE_ID, WORKTREE_PATH);

    const threes = vi.mocked(sendKeys).mock.calls.filter(([, sent]) => sent === '3');
    expect(threes).toHaveLength(1);
  });
});
