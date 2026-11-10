/**
 * Issue #4300 (PR1): a send into a pane whose agent exited — its shell is back
 * in the foreground — types nothing, for every CLI tool.
 *
 * Table-driven over `CLI_TOOL_IDS` (a `Record` keyed by the tool type, so a new
 * tool fails to compile until it has a row). Each row drives the tool's real
 * `sendMessage` into the real shared sender with tmux mocked at two levels:
 * the screen-and-keys functions of `@/lib/tmux/tmux` (capture, send-keys, the
 * clear keys) and `child_process.execFile` (what the real `readPaneForeground`
 * runs — `display-message` and `ps` — and what the paste runs — `load-buffer`
 * / `paste-buffer`). Every row sees the same screen, one on which the tool's
 * readiness holds (the steps before the shared sender are stubbed on the
 * instance, as in #4031; the under-lock readiness of copilot / opencode /
 * vibe-local is made to hold); only the foreground changes.
 *
 * - shell (zsh, tpgid == pane_pid): no send-keys, no paste, no load-buffer,
 *   no clear keys; not-sent / agent-not-in-foreground. Short and long bodies.
 * - positive control: the same shell pane with the check bypassed sends the
 *   body on EVERY row (no row merely stuck before the body).
 * - negative: node (ps is not asked), a non-exec wrapper `bash` with
 *   tpgid != pane_pid, and an unreadable foreground all send as before.
 *
 * @vitest-environment node
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface Foreground {
  /** `display-message` answer, or null for a failing tmux call. */
  display: string | null;
  /** `ps -o tpgid=` answer, or null for a failing ps. */
  tpgid: string | null;
}

const h = vi.hoisted(() => ({
  frame: '',
  foreground: { display: null, tpgid: null } as { display: string | null; tpgid: string | null },
  bypassCheck: false,
  execCalls: [] as Array<{ file: string; args: string[] }>,
}));

/** Thrown by the mocked body keys / load-buffer, so a send that got that far ends at once. */
const BODY_REACHED = 'body-reached-the-pane (test sentinel)';

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  const execFile = vi.fn((file: string, args: string[], ...rest: unknown[]) => {
    const callback = rest[rest.length - 1] as (e: Error | null, r?: { stdout: string; stderr: string }) => void;
    h.execCalls.push({ file, args });
    const answer = (stdout: string | null): void => {
      if (stdout === null) callback(new Error(`Command failed: ${file} ${args.join(' ')}`));
      else callback(null, { stdout, stderr: '' });
    };
    if (file === 'tmux' && args[0] === 'display-message') answer(h.foreground.display);
    else if (file === 'ps') answer(h.foreground.tpgid);
    else if (file === 'tmux' && args[0] === 'load-buffer') answer(null);
    else answer('');
    return { stdin: { end: () => undefined } };
  });
  return { ...actual, execFile, default: { ...actual, execFile } };
});

vi.mock('@/lib/tmux/tmux', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/tmux/tmux')>();
  const sentinel = (): Promise<never> =>
    Promise.reject(Object.assign(new Error(BODY_REACHED), { delivery: 'not-started' }));
  return {
    ...actual,
    hasSession: vi.fn(async () => true),
    capturePane: vi.fn(async () => h.frame),
    sendKeys: vi.fn(sentinel),
    sendSpecialKeys: vi.fn(async () => undefined),
    sendSpecialKey: vi.fn(async () => undefined),
    clearInputLine: vi.fn(async () => undefined),
    clearComposerLine: vi.fn(async () => undefined),
    clearComposerPasteToken: vi.fn(async () => undefined),
    getPaneCurrentCommand: vi.fn(async () => null),
    // The real reader (it runs the mocked execFile above); bypassed only for the positive control.
    readPaneForeground: vi.fn((sessionName: string) =>
      h.bypassCheck ? Promise.resolve('other' as const) : actual.readPaneForeground(sessionName)
    ),
  };
});

vi.mock('@/lib/tmux/tmux-capture-cache', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/tmux/tmux-capture-cache')>()),
  invalidateCache: vi.fn(),
}));
vi.mock('@/lib/detection/tools/opencode/readiness', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/detection/tools/opencode/readiness')>()),
  isOpenCodeComposerReady: () => true,
}));
vi.mock('@/lib/detection/tools/vibe-local/readiness', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/detection/tools/vibe-local/readiness')>()),
  isVibeLocalComposerReady: () => true,
}));

import { CLI_TOOL_IDS, type CLIToolType } from '@/lib/cli-tools/types';
import { ClaudeTool } from '@/lib/cli-tools/claude';
import { CodexTool } from '@/lib/cli-tools/codex';
import { GeminiTool } from '@/lib/cli-tools/gemini';
import { VibeLocalTool } from '@/lib/cli-tools/vibe-local';
import { OpenCodeTool } from '@/lib/cli-tools/opencode';
import { CopilotTool } from '@/lib/cli-tools/copilot';
import { AntigravityTool } from '@/lib/cli-tools/antigravity';
import { answerClaudeAutoDefaultNudgeBeforeSend } from '@/lib/cli-tools/claude-auto-default-nudge';
import { CommandCodeTool } from '@/lib/cli-tools/command-code';
import { OpenCodeV2Tool } from '@/lib/cli-tools/opencode-v2';
import {
  sendKeys,
  sendSpecialKeys,
  sendSpecialKey,
  clearInputLine,
  clearComposerLine,
  clearComposerPasteToken,
} from '@/lib/tmux/tmux';
import { classifySendFailure } from '@/lib/session/send-attempt-state';
import { buildClaudeIdleComposerFrame } from '../../fixtures/claude-idle-composer';

interface SendingTool {
  sendMessage(worktreeId: string, message: string, instanceId?: string): Promise<void>;
}

/** The steps before the shared sender, made to pass (as in #4031); claude's path runs as is. */
function stubPreSend(tool: object): void {
  const t = tool as Record<string, unknown>;
  t.requireSession = vi.fn(async () => undefined);
  t.waitForPrompt = vi.fn(async () => ({ ready: true, output: '' }));
  t.waitForComposer = vi.fn(async () => undefined);
  t.trySendViaServer = vi.fn(async () => false);
  if ('inputReadiness' in t) t.inputReadiness = { label: 'copilot', isReady: () => true };
}

const FACTORIES: Record<CLIToolType, () => SendingTool> = {
  claude: () => new ClaudeTool(),
  codex: () => new CodexTool(),
  gemini: () => new GeminiTool(),
  'vibe-local': () => new VibeLocalTool(),
  opencode: () => new OpenCodeTool(),
  copilot: () => new CopilotTool(),
  antigravity: () => new AntigravityTool(),
  'command-code': () => new CommandCodeTool(),
  'opencode-v2': () => new OpenCodeV2Tool(),
};

/**
 * The screen of claude after it exited (Issue #4300 UAT): its last input box is
 * left on screen and the shell prompt follows. Claude's own prompt test passes
 * on it — that is the bug — and every other tool's readiness is made to hold.
 */
const EXITED_SCREEN = [
  buildClaudeIdleComposerFrame(),
  '',
  'Resume this session with:',
  'claude --resume 15477564-0000-4000-8000-000000000000',
  'user@host wt-4300 % ',
].join('\n');

const PANE_PID = '48213';
const SHELL: Foreground = { display: `zsh\t${PANE_PID}\n`, tpgid: `${PANE_PID}\n` };
const LOGIN_SHELL: Foreground = { display: `-zsh\t${PANE_PID}\n`, tpgid: ` ${PANE_PID}\n` };
const NODE: Foreground = { display: `node\t${PANE_PID}\n`, tpgid: null };
const WRAPPER_BASH: Foreground = { display: `bash\t${PANE_PID}\n`, tpgid: '48299\n' };
const UNREADABLE: Foreground = { display: null, tpgid: null };

const SHORT_BODY = 'rm -rf build && echo done';
const LONG_BODY = 'x'.repeat(4000);

const ROWS = CLI_TOOL_IDS.map((id) => [id] as const);

async function send(id: CLIToolType, body: string): Promise<unknown> {
  const tool = FACTORIES[id]();
  if (id !== 'claude') stubPreSend(tool);
  return tool.sendMessage(`wt-4300-${id}`, body).then(
    () => null,
    (error: unknown) => error
  );
}

function bodyKeysSent(): number {
  return vi.mocked(sendKeys).mock.calls.length;
}

function pasteCalls(): number {
  return h.execCalls.filter((c) => c.file === 'tmux' && (c.args[0] === 'load-buffer' || c.args[0] === 'paste-buffer'))
    .length;
}

function anyKeys(): number {
  return (
    bodyKeysSent() +
    vi.mocked(sendSpecialKeys).mock.calls.length +
    vi.mocked(sendSpecialKey).mock.calls.length +
    vi.mocked(clearInputLine).mock.calls.length +
    vi.mocked(clearComposerLine).mock.calls.length +
    vi.mocked(clearComposerPasteToken).mock.calls.length +
    pasteCalls()
  );
}

beforeEach(() => {
  h.frame = EXITED_SCREEN;
  h.bypassCheck = false;
  h.execCalls.length = 0;
  vi.clearAllMocks();
});

afterEach(() => {
  h.bypassCheck = false;
});

describe('[#4300] a send into a pane whose shell is in the foreground types nothing', () => {
  it('the table has a row for every CLI tool', () => {
    expect(Object.keys(FACTORIES).sort()).toEqual([...CLI_TOOL_IDS].sort());
  });

  it.each(ROWS)('%s — short body: no key, not-sent / agent-not-in-foreground', async (id) => {
    h.foreground = SHELL;
    const error = await send(id, SHORT_BODY);
    expect(error).toBeInstanceOf(Error);
    expect(anyKeys()).toBe(0);
    expect(classifySendFailure(error)).toEqual({ state: 'not-sent', reason: 'agent-not-in-foreground' });
    // The reader asked tmux and ps, and nothing else ran on the pane.
    expect(h.execCalls.some((c) => c.file === 'ps')).toBe(true);
  });

  it.each(ROWS)('%s — long body (paste path): no load-buffer, no paste-buffer', async (id) => {
    h.foreground = LOGIN_SHELL;
    const error = await send(id, LONG_BODY);
    expect(anyKeys()).toBe(0);
    expect(classifySendFailure(error)).toEqual({ state: 'not-sent', reason: 'agent-not-in-foreground' });
  });

  it.each(ROWS)('positive control: %s — with the check bypassed the same pane gets the body', async (id) => {
    h.foreground = SHELL;
    h.bypassCheck = true;
    const error = await send(id, SHORT_BODY);
    expect(bodyKeysSent()).toBeGreaterThan(0);
    expect((error as Error).message).toContain(BODY_REACHED);
  });

  it.each(ROWS)('positive control: %s — long body reaches load-buffer with the check bypassed', async (id) => {
    h.foreground = SHELL;
    h.bypassCheck = true;
    await send(id, LONG_BODY);
    expect(h.execCalls.some((c) => c.file === 'tmux' && c.args[0] === 'load-buffer')).toBe(true);
  });
});

describe('[#4300] negative: a foreground that is not the shell, or is not known, sends as before', () => {
  it.each(ROWS)('%s — node in the foreground: the body is typed, ps is not asked', async (id) => {
    h.foreground = NODE;
    const error = await send(id, SHORT_BODY);
    expect(bodyKeysSent()).toBeGreaterThan(0);
    expect((error as Error).message).toContain(BODY_REACHED);
    expect(h.execCalls.some((c) => c.file === 'ps')).toBe(false);
  });

  it.each(ROWS)('%s — a non-exec wrapper (bash, tpgid != pane_pid): the body is typed', async (id) => {
    h.foreground = WRAPPER_BASH;
    await send(id, SHORT_BODY);
    expect(bodyKeysSent()).toBeGreaterThan(0);
  });

  it.each(ROWS)('%s — foreground unreadable (unknown): the body is typed', async (id) => {
    h.foreground = UNREADABLE;
    await send(id, SHORT_BODY);
    expect(bodyKeysSent()).toBeGreaterThan(0);
  });
});

/**
 * Claude's launch dialog ("Make auto mode your default permission mode?") left on
 * the screen of an exited claude: the answer's Down/Up/Enter would reach the shell.
 * Added with the review of PR1 (P3-3). Also copilot's not-ready paths keep the reason.
 */
const NUDGE_SCREEN = readFileSync(
  join(process.cwd(), 'tests/fixtures/claude-auto-default-nudge-4134', 'cursor-yes.txt'),
  'utf8'
);

describe('[#4300] the nudge answer before a send types nothing into a shell', () => {
  async function nudge(): Promise<unknown> {
    return answerClaudeAutoDefaultNudgeBeforeSend('wt-4300-nudge').then(
      () => null,
      (error: unknown) => error
    );
  }

  it('shell in the foreground: no key, not-sent / agent-not-in-foreground', async () => {
    h.frame = NUDGE_SCREEN;
    h.foreground = SHELL;
    // Fake timers: if the gate were removed the answer loop would keep waiting; advancing
    // the clock lets it type, so the failure shows up as the key-count assert below
    // (not as a test timeout).
    vi.useFakeTimers();
    let error: unknown;
    try {
      const pending = nudge();
      await vi.advanceTimersByTimeAsync(20_000);
      error = await pending;
    } finally {
      vi.useRealTimers();
    }
    expect(anyKeys()).toBe(0);
    expect(error).toBeInstanceOf(Error);
    expect(classifySendFailure(error)).toEqual({ state: 'not-sent', reason: 'agent-not-in-foreground' });
  });

  it('positive control: with the check bypassed the same screen gets a key', async () => {
    h.frame = NUDGE_SCREEN;
    h.foreground = SHELL;
    h.bypassCheck = true;
    vi.useFakeTimers();
    try {
      const pending = nudge();
      await vi.advanceTimersByTimeAsync(20_000);
      await pending;
    } finally {
      vi.useRealTimers();
    }
    expect(vi.mocked(sendSpecialKey).mock.calls.length + vi.mocked(sendSpecialKeys).mock.calls.length + bodyKeysSent()).toBeGreaterThan(0);
  });

  it('negative: node in the foreground answers the dialog as before', async () => {
    h.frame = NUDGE_SCREEN;
    h.foreground = NODE;
    vi.useFakeTimers();
    try {
      const pending = nudge();
      await vi.advanceTimersByTimeAsync(20_000);
      await pending;
    } finally {
      vi.useRealTimers();
    }
    expect(vi.mocked(sendSpecialKey).mock.calls.length + vi.mocked(sendSpecialKeys).mock.calls.length + bodyKeysSent()).toBeGreaterThan(0);
  });
});

describe('[#4300] copilot: an exited agent keeps agent-not-in-foreground on its not-ready paths', () => {
  function notReadyCopilot(): CopilotTool {
    const tool = new CopilotTool();
    stubPreSend(tool);
    (tool as unknown as Record<string, unknown>).waitForPrompt = vi.fn(async () => ({
      ready: false,
      dialog: false,
      output: EXITED_SCREEN,
    }));
    return tool;
  }

  it('the /model switch whose idle wait ends not-ready', async () => {
    h.foreground = SHELL;
    const error = await notReadyCopilot()
      .sendModelCommand('wt-4300-copilot', 'gpt-5')
      .then(() => null, (e: unknown) => e);
    expect(anyKeys()).toBe(0);
    expect(classifySendFailure(error)).toEqual({ state: 'not-sent', reason: 'agent-not-in-foreground' });
  });

  it('the message whose prompt wait ends not-ready', async () => {
    h.foreground = SHELL;
    const error = await notReadyCopilot()
      .sendMessage('wt-4300-copilot', SHORT_BODY)
      .then(() => null, (e: unknown) => e);
    expect(anyKeys()).toBe(0);
    expect(classifySendFailure(error)).toEqual({ state: 'not-sent', reason: 'agent-not-in-foreground' });
  });

  it('negative: with the agent in the foreground the not-ready reasons stay their own', async () => {
    h.foreground = NODE;
    const message = await notReadyCopilot()
      .sendMessage('wt-4300-copilot', SHORT_BODY)
      .then(() => null, (e: unknown) => e);
    expect(classifySendFailure(message).reason).toBe('prompt-not-ready');
    const model = await notReadyCopilot()
      .sendModelCommand('wt-4300-copilot', 'gpt-5')
      .then(() => null, (e: unknown) => e);
    expect(classifySendFailure(model).reason).not.toBe('agent-not-in-foreground');
  });
});
