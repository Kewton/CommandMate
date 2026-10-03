/**
 * Issue #3078: Claude Code's folder-trust dialog whose cursor starts on
 * `No, exit` (2.1.287 with a permission allow-list) must be neither read as a
 * ready prompt nor answered with a bare Enter.
 * Issue #3089: Enter goes in only once a screen shows the cursor on Yes, and a
 * Claude Code that quit from the dialog fails the start at once.
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
  getPaneCurrentCommand: vi.fn(),
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
  CLAUDE_INIT_TIMEOUT,
  CLAUDE_POST_PROMPT_DELAY,
  CLAUDE_TRUST_DIALOG_CURSOR_STUCK,
  CLAUDE_TRUST_DIALOG_EXITED,
} from '@/lib/session/claude-session';
import {
  hasSession,
  createSession,
  sendKeys,
  sendSpecialKeys,
  capturePane,
  getPaneCurrentCommand,
} from '@/lib/tmux/tmux';
import {
  CLAUDE_PROMPT_PATTERN,
  isClaudeTrustDialogOpen,
  isShellPaneCommand,
  resolveClaudeTrustDialogKeys,
} from '@/lib/detection/cli-patterns';
import { SessionStartFailedError } from '@/lib/session/session-start-error';

const FIXTURES = join(__dirname, '../../fixtures');

/** 2.1.287, allow-list repository: cursor on `No, exit` (the reported screen). */
const DEFAULT_NO_ALLOWLIST = readFileSync(
  join(FIXTURES, 'claude-trust-dialog-3078/allowlist-default-no-2-1-287.txt'),
  'utf-8'
);

/** Issue #3089: the poll right after `Down` was swallowed — cursor still on `No, exit`. */
const DOWN_SWALLOWED = readFileSync(
  join(FIXTURES, 'claude-trust-dialog-3078/down-swallowed-cursor-still-no-2-1-287.txt'),
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

  function enterCallOrders(): number[] {
    const mock = vi.mocked(sendKeys).mock;
    return mock.calls.flatMap((call, i) => (call[1] === '' && call[2] === true ? [mock.invocationCallOrder[i]] : []));
  }

  function sentSpecialKeys(): string[] {
    return vi.mocked(sendSpecialKeys).mock.calls.flatMap((call) => call[1]);
  }

  /** Pane shows `screens[i]` on poll i, and the last one from then on. */
  function paneSequence(screens: string[]): void {
    let poll = 0;
    vi.mocked(capturePane).mockImplementation(async () => screens[Math.min(poll++, screens.length - 1)]);
  }

  it('selects `Yes, I trust this folder` before confirming the default-No dialog', async () => {
    paneSequence([DEFAULT_NO_ALLOWLIST.replace(/^ /gm, ''), CURSOR_MOVED_TO_YES, '❯ ']);

    const promise = startClaudeSession({ worktreeId: 'wt', worktreePath: '/path/to/wt' });
    await vi.advanceTimersByTimeAsync(100 + CLAUDE_INIT_POLL_INTERVAL * 4 + CLAUDE_POST_PROMPT_DELAY);
    await expect(promise).resolves.toBeUndefined();

    // Issue #3089: the move alone, then Enter once the screen shows Yes — never
    // `Down Enter` in one go (a swallowed Down left Enter on `No, exit`).
    expect(vi.mocked(sendSpecialKeys).mock.calls).toEqual([['mcbd-claude-wt', ['Down']]]);
    expect(enterOnlyCalls()).toBe(1);
    expect(vi.mocked(sendSpecialKeys).mock.invocationCallOrder[0]).toBeLessThan(
      enterCallOrders()[0]
    );
  });

  it('does not take the open dialog for a ready prompt', async () => {
    // Unpadded: the cursor row matches CLAUDE_PROMPT_PATTERN, yet the wait goes on.
    vi.mocked(capturePane).mockResolvedValue(DEFAULT_NO_ALLOWLIST.replace(/^ /gm, ''));

    const promise = startClaudeSession({ worktreeId: 'wt', worktreePath: '/path/to/wt' });
    const settled = vi.fn();
    promise.then(settled, settled);
    await vi.advanceTimersByTimeAsync(100 + CLAUDE_INIT_POLL_INTERVAL * 5 + CLAUDE_POST_PROMPT_DELAY);

    expect(settled).not.toHaveBeenCalled();
    expect(sendSpecialKeys).toHaveBeenCalled();
    expect(sentSpecialKeys().every((key) => key === 'Down')).toBe(true);
    expect(enterOnlyCalls()).toBe(0);

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
    // Issue #3089: moves only, one at a time, ~3 polls apart; no Enter while on No.
    expect(sentSpecialKeys()).toEqual(['Down', 'Down']);
    expect(enterOnlyCalls()).toBe(0);

    // A Down landed.
    vi.mocked(capturePane).mockResolvedValue(CURSOR_MOVED_TO_YES);
    await vi.advanceTimersByTimeAsync(CLAUDE_INIT_POLL_INTERVAL * 10);
    expect(sendSpecialKeys).toHaveBeenCalledTimes(2);
    expect(enterOnlyCalls()).toBe(1);

    // The Enter was swallowed: the dialog, cursor on Yes, outlives it and is answered again.
    await vi.advanceTimersByTimeAsync(CLAUDE_INIT_POLL_INTERVAL * 10);
    expect(enterOnlyCalls()).toBe(2);

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

describe('startClaudeSession() - confirming Yes on screen before Enter (Issue #3089)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.mocked(hasSession).mockResolvedValue(false);
    vi.mocked(createSession).mockResolvedValue();
    vi.mocked(sendKeys).mockResolvedValue();
    vi.mocked(sendSpecialKeys).mockResolvedValue();
    // Claude Code 2.x native build: the pane command is its version string.
    vi.mocked(getPaneCurrentCommand).mockResolvedValue('2.1.287');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function enterOnlyCalls(): number {
    return vi.mocked(sendKeys).mock.calls.filter((call) => call[1] === '' && call[2] === true).length;
  }

  function sentSpecialKeys(): string[] {
    return vi.mocked(sendSpecialKeys).mock.calls.flatMap((call) => call[1]);
  }

  /** Pane shows `screens[i]` on poll i, and the last one from then on. */
  function paneSequence(screens: string[]): void {
    let poll = 0;
    vi.mocked(capturePane).mockImplementation(async () => screens[Math.min(poll++, screens.length - 1)]);
  }

  it('the swallowed-Down screen still has the cursor on `No, exit`', () => {
    expect(isClaudeTrustDialogOpen(DOWN_SWALLOWED)).toBe(true);
    expect(resolveClaudeTrustDialogKeys(DOWN_SWALLOWED)).toEqual(['Down', 'Enter']);
  });

  it('does not send Enter while the screen after Down still shows the cursor on No', async () => {
    paneSequence([DEFAULT_NO_ALLOWLIST, DOWN_SWALLOWED, DOWN_SWALLOWED, DOWN_SWALLOWED]);

    const promise = startClaudeSession({ worktreeId: 'wt', worktreePath: '/path/to/wt' });
    const settled = vi.fn();
    promise.then(settled, settled);
    await vi.advanceTimersByTimeAsync(100 + CLAUDE_INIT_POLL_INTERVAL * 4);

    expect(settled).not.toHaveBeenCalled();
    expect(enterOnlyCalls()).toBe(0);
    expect(sentSpecialKeys()).not.toContain('Enter');
    // Moved again once the swallowed Down had had its time to show.
    expect(sentSpecialKeys()).toEqual(['Down', 'Down']);

    // The second Down lands: now, and only now, Enter.
    paneSequence([CURSOR_MOVED_TO_YES, '❯ ']);
    await vi.advanceTimersByTimeAsync(CLAUDE_INIT_POLL_INTERVAL * 3 + CLAUDE_POST_PROMPT_DELAY);
    await expect(promise).resolves.toBeUndefined();
    expect(enterOnlyCalls()).toBe(1);
    expect(sentSpecialKeys()).toEqual(['Down', 'Down']);
  });

  it('fails without ever sending Enter when the cursor never reaches Yes', async () => {
    vi.mocked(capturePane).mockResolvedValue(DOWN_SWALLOWED);

    const promise = startClaudeSession({ worktreeId: 'wt', worktreePath: '/path/to/wt' });
    const assertion = expect(promise).rejects.toMatchObject({
      name: 'SessionStartFailedError',
      detectedPattern: CLAUDE_TRUST_DIALOG_CURSOR_STUCK,
    });
    await vi.advanceTimersByTimeAsync(CLAUDE_INIT_TIMEOUT);
    await assertion;

    expect(enterOnlyCalls()).toBe(0);
    expect(sentSpecialKeys().length).toBeGreaterThan(1);
    expect(sentSpecialKeys().every((key) => key === 'Down')).toBe(true);
  });

  it('fails fast when Claude Code exited from the dialog back to the shell', async () => {
    paneSequence([DEFAULT_NO_ALLOWLIST, DEFAULT_NO_ALLOWLIST, 'user@host:~/repos/commandmate-tutorial$ ']);
    vi.mocked(getPaneCurrentCommand).mockImplementation(async () =>
      vi.mocked(capturePane).mock.calls.length >= 3 ? 'bash' : '2.1.287'
    );

    const promise = startClaudeSession({ worktreeId: 'wt', worktreePath: '/path/to/wt' });
    const assertion = expect(promise).rejects.toBeInstanceOf(SessionStartFailedError);
    await vi.advanceTimersByTimeAsync(100 + CLAUDE_INIT_POLL_INTERVAL * 4);
    await assertion;
    await expect(promise).rejects.toMatchObject({ detectedPattern: CLAUDE_TRUST_DIALOG_EXITED });

    // Well inside the 60 s budget, and no Enter went to the shell.
    expect(enterOnlyCalls()).toBe(0);
  });

  it('keeps waiting while the dialog has closed and Claude Code is still drawing', async () => {
    paneSequence([CURSOR_MOVED_TO_YES, '', '', '❯ ']);

    const promise = startClaudeSession({ worktreeId: 'wt', worktreePath: '/path/to/wt' });
    await vi.advanceTimersByTimeAsync(100 + CLAUDE_INIT_POLL_INTERVAL * 5 + CLAUDE_POST_PROMPT_DELAY);
    await expect(promise).resolves.toBeUndefined();
    expect(enterOnlyCalls()).toBe(1);
  });

  it('does not call a shell pane an exit when the shell was there while the dialog was open', async () => {
    // A wrapper script that did not `exec` claude: the pane command is a shell throughout.
    vi.mocked(getPaneCurrentCommand).mockResolvedValue('bash');
    paneSequence([CURSOR_MOVED_TO_YES, '', '', '❯ ']);

    const promise = startClaudeSession({ worktreeId: 'wt', worktreePath: '/path/to/wt' });
    await vi.advanceTimersByTimeAsync(100 + CLAUDE_INIT_POLL_INTERVAL * 5 + CLAUDE_POST_PROMPT_DELAY);
    await expect(promise).resolves.toBeUndefined();
  });
});

describe('isShellPaneCommand (Issue #3089)', () => {
  it('names shells, including tmux login-shell names', () => {
    for (const command of ['bash', 'zsh', '-zsh', 'sh', 'fish', 'dash']) {
      expect(isShellPaneCommand(command)).toBe(true);
    }
  });

  it('does not name Claude Code as a shell', () => {
    for (const command of ['claude', 'node', '2.1.287']) {
      expect(isShellPaneCommand(command)).toBe(false);
    }
  });
});
