/**
 * Issue #3078: Claude Code's folder-trust dialog whose cursor starts on
 * `No, exit` (2.1.287 with a permission allow-list) must be neither read as a
 * ready prompt nor answered with a bare Enter.
 * @vitest-environment node
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { registerIsolatedAgentHooksDir } from '@tests/helpers/agent-hooks-dir';

vi.mock('@/lib/tmux/session-ownership', () => ({
  assertSessionNotForeign: vi.fn(async () => ({ verdict: 'owned', sessionPath: null })),
}));

registerIsolatedAgentHooksDir('claude-trust-3078');

vi.mock('@/lib/tmux/tmux', () => ({
  hasSession: vi.fn(),
  createSession: vi.fn(),
  sendKeys: vi.fn(),
  sendSpecialKeys: vi.fn(),
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
    if (typeof opts === 'function') {
      cb = opts;
    }
    const callback = cb as (err: Error | null, result: { stdout: string; stderr: string }) => void;
    callback(null, { stdout: cmd.includes('which claude') ? '/usr/local/bin/claude' : '', stderr: '' });
    return {};
  }),
}));

import {
  startClaudeSession,
  CLAUDE_INIT_POLL_INTERVAL,
  CLAUDE_POST_PROMPT_DELAY,
} from '@/lib/session/claude-session';
import { hasSession, createSession, sendKeys, sendSpecialKeys, capturePane } from '@/lib/tmux/tmux';
import {
  CLAUDE_PROMPT_PATTERN,
  isClaudeTrustDialogOpen,
  resolveClaudeTrustDialogKeys,
} from '@/lib/detection/cli-patterns';

const FIXTURES = join(__dirname, '../../fixtures');

/** 2.1.287, allow-list repository: cursor on `No, exit` (the reported screen). */
const DEFAULT_NO_ALLOWLIST = readFileSync(
  join(FIXTURES, 'claude-trust-dialog-3078/allowlist-default-no-2-1-287.txt'),
  'utf-8'
);

/** 2.1.259, no allow-list: also cursor on `No, exit`. */
const DEFAULT_NO_2_1_259 = readFileSync(
  join(FIXTURES, 'chat-dialog-card-2254/claude-trust-2-1-259.txt'),
  'utf-8'
  // eslint-disable-next-line no-control-regex
).replace(/\x1b\[[0-9;]*m|\x1b\]8;[^\x1b]*\x1b\\/g, '');

/** Issue #201 layout: numbered options, cursor on Yes (tests/unit/lib/claude-session.test.ts). */
const DEFAULT_YES =
  'Quick safety check: Is this a project you created or one you trust?\n\n' +
  ' ❯ 1. Yes, I trust this folder\n   2. No, exit\n\n Enter to confirm · Esc to cancel';

/** The same dialog once the cursor has moved onto Yes. */
const CURSOR_MOVED_TO_YES = DEFAULT_NO_ALLOWLIST.replace(' ❯ No, exit', '   No, exit').replace(
  '   Yes, I trust this folder',
  ' ❯ Yes, I trust this folder'
);

/** Claude's ready screen with the answered dialog still in the scrollback above it. */
const READY_WITH_DIALOG_IN_SCROLLBACK =
  CURSOR_MOVED_TO_YES + '\n\n' + '─'.repeat(40) + '\n❯ \n' + '─'.repeat(40) + '\n  ? for shortcuts';

describe('resolveClaudeTrustDialogKeys / isClaudeTrustDialogOpen (Issue #3078)', () => {
  it('moves Down onto Yes before Enter when the cursor starts on `No, exit` (2.1.287 allow-list)', () => {
    expect(isClaudeTrustDialogOpen(DEFAULT_NO_ALLOWLIST)).toBe(true);
    expect(resolveClaudeTrustDialogKeys(DEFAULT_NO_ALLOWLIST)).toEqual(['Down', 'Enter']);
  });

  it('moves Down onto Yes for the 2.1.259 default-No layout as well', () => {
    expect(resolveClaudeTrustDialogKeys(DEFAULT_NO_2_1_259)).toEqual(['Down', 'Enter']);
  });

  it('answers the default-Yes layout with Enter alone', () => {
    expect(resolveClaudeTrustDialogKeys(DEFAULT_YES)).toEqual(['Enter']);
    expect(resolveClaudeTrustDialogKeys(CURSOR_MOVED_TO_YES)).toEqual(['Enter']);
  });

  it('moves Up when the cursor is below Yes', () => {
    const cursorOnNo = ' Quick safety check\n   1. Yes, I trust this folder\n ❯ 2. No, exit';
    expect(resolveClaudeTrustDialogKeys(cursorOnNo)).toEqual(['Up', 'Enter']);
  });

  it('a dialog with the input box drawn below it is scrollback, not an open dialog', () => {
    expect(isClaudeTrustDialogOpen(READY_WITH_DIALOG_IN_SCROLLBACK)).toBe(false);
    expect(resolveClaudeTrustDialogKeys(READY_WITH_DIALOG_IN_SCROLLBACK)).toBeNull();
  });

  it('no dialog, or no readable cursor row, gives no keys', () => {
    expect(resolveClaudeTrustDialogKeys('❯ \n? for shortcuts')).toBeNull();
    expect(isClaudeTrustDialogOpen('❯ \n? for shortcuts')).toBe(false);
    const noCursor = '   No, exit\n   Yes, I trust this folder';
    expect(isClaudeTrustDialogOpen(noCursor)).toBe(true);
    expect(resolveClaudeTrustDialogKeys(noCursor)).toBeNull();
  });

  it('the dialog cursor row matches CLAUDE_PROMPT_PATTERN once the padding is gone', () => {
    // Why the start wait must ask about the dialog first: at column 0 the
    // dialog's cursor row is indistinguishable from a prompt.
    const unpadded = DEFAULT_NO_ALLOWLIST.replace(/^ /gm, '');
    expect(CLAUDE_PROMPT_PATTERN.test(unpadded)).toBe(true);
    expect(isClaudeTrustDialogOpen(unpadded)).toBe(true);
    expect(resolveClaudeTrustDialogKeys(unpadded)).toEqual(['Down', 'Enter']);
  });
});

describe('startClaudeSession() - trust dialog layouts (Issue #3078)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.mocked(hasSession).mockResolvedValue(false);
    vi.mocked(createSession).mockResolvedValue();
    vi.mocked(sendKeys).mockResolvedValue();
    vi.mocked(sendSpecialKeys).mockResolvedValue();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function enterOnlyCalls(): number {
    return vi.mocked(sendKeys).mock.calls.filter((call) => call[1] === '' && call[2] === true).length;
  }

  /** Pane shows `screens[i]` on poll i, and the last one from then on. */
  function paneSequence(screens: string[]): void {
    let poll = 0;
    vi.mocked(capturePane).mockImplementation(async () => screens[Math.min(poll++, screens.length - 1)]);
  }

  it('selects `Yes, I trust this folder` before confirming the default-No dialog', async () => {
    paneSequence([DEFAULT_NO_ALLOWLIST.replace(/^ /gm, ''), DEFAULT_NO_ALLOWLIST, '❯ ']);

    const promise = startClaudeSession({ worktreeId: 'wt', worktreePath: '/path/to/wt' });
    await vi.advanceTimersByTimeAsync(100 + CLAUDE_INIT_POLL_INTERVAL * 4 + CLAUDE_POST_PROMPT_DELAY);
    await expect(promise).resolves.toBeUndefined();

    // Not a bare Enter (which would confirm `No, exit`), and only once.
    expect(enterOnlyCalls()).toBe(0);
    expect(vi.mocked(sendSpecialKeys).mock.calls).toEqual([['mcbd-claude-wt', ['Down', 'Enter']]]);
  });

  it('does not take the open dialog for a ready prompt', async () => {
    // Unpadded: the cursor row matches CLAUDE_PROMPT_PATTERN, yet the wait goes on.
    vi.mocked(capturePane).mockResolvedValue(DEFAULT_NO_ALLOWLIST.replace(/^ /gm, ''));

    const promise = startClaudeSession({ worktreeId: 'wt', worktreePath: '/path/to/wt' });
    const settled = vi.fn();
    promise.then(settled, settled);
    await vi.advanceTimersByTimeAsync(100 + CLAUDE_INIT_POLL_INTERVAL * 5 + CLAUDE_POST_PROMPT_DELAY);

    expect(settled).not.toHaveBeenCalled();
    expect(sendSpecialKeys).toHaveBeenCalledTimes(1);

    vi.mocked(capturePane).mockResolvedValue('❯ ');
    await vi.advanceTimersByTimeAsync(CLAUDE_INIT_POLL_INTERVAL * 2 + CLAUDE_POST_PROMPT_DELAY);
    await expect(promise).resolves.toBeUndefined();
  });

  it('confirms the default-Yes dialog with the Issue #201 Enter, unchanged', async () => {
    paneSequence([DEFAULT_YES, '❯ ']);

    const promise = startClaudeSession({ worktreeId: 'wt', worktreePath: '/path/to/wt' });
    await vi.advanceTimersByTimeAsync(100 + CLAUDE_INIT_POLL_INTERVAL * 3 + CLAUDE_POST_PROMPT_DELAY);
    await expect(promise).resolves.toBeUndefined();

    expect(enterOnlyCalls()).toBe(1);
    expect(sendSpecialKeys).not.toHaveBeenCalled();
  });

  it('answers again, from the current screen, when the dialog outlives its answer', async () => {
    // First answer swallowed; the dialog is still at its default position.
    vi.mocked(capturePane).mockResolvedValue(DEFAULT_NO_ALLOWLIST);

    const promise = startClaudeSession({ worktreeId: 'wt', worktreePath: '/path/to/wt' });
    await vi.advanceTimersByTimeAsync(100 + CLAUDE_INIT_POLL_INTERVAL * 5);
    expect(sendSpecialKeys).toHaveBeenCalledTimes(1);

    // The Down landed but the Enter did not.
    vi.mocked(capturePane).mockResolvedValue(CURSOR_MOVED_TO_YES);
    await vi.advanceTimersByTimeAsync(CLAUDE_INIT_POLL_INTERVAL * 10);
    expect(sendSpecialKeys).toHaveBeenCalledTimes(1);
    expect(enterOnlyCalls()).toBe(1);

    vi.mocked(capturePane).mockResolvedValue('❯ ');
    await vi.advanceTimersByTimeAsync(CLAUDE_INIT_POLL_INTERVAL * 2 + CLAUDE_POST_PROMPT_DELAY);
    await expect(promise).resolves.toBeUndefined();
  });

  it('starts normally when the answered dialog is left in the scrollback', async () => {
    vi.mocked(capturePane).mockResolvedValue(READY_WITH_DIALOG_IN_SCROLLBACK);

    const promise = startClaudeSession({ worktreeId: 'wt', worktreePath: '/path/to/wt' });
    await vi.advanceTimersByTimeAsync(100 + CLAUDE_INIT_POLL_INTERVAL * 2 + CLAUDE_POST_PROMPT_DELAY);
    await expect(promise).resolves.toBeUndefined();

    expect(enterOnlyCalls()).toBe(0);
    expect(sendSpecialKeys).not.toHaveBeenCalled();
  });
});
