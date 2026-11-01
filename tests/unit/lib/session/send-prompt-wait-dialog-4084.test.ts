/**
 * Issue #4084, at the send service: what a request is told when opencode's or
 * vibe-local's prompt wait confirms a dialog — read from the request's own
 * outcome (`onAttempt`, which the send route turns into `sendOutcome`), not
 * only from the shared `lastSend`, which #4065 may keep at another request's.
 *
 * The tools are the real ones; tmux is mocked. The prompt guard is the real one
 * too, so the out-of-scope controls show it still refuses on the hooks'
 * structured record alone, before any capture by the tool.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  return { ...actual, execFile: vi.fn() };
});

vi.mock('@/lib/logger', () => ({
  createLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    withContext: vi.fn().mockReturnThis(),
  })),
  generateRequestId: vi.fn(() => 'test-request-id'),
}));

vi.mock('@/lib/tmux/tmux', () => ({
  hasSession: vi.fn().mockResolvedValue(true),
  createSession: vi.fn().mockResolvedValue(undefined),
  sendKeys: vi.fn(),
  sendSpecialKey: vi.fn().mockResolvedValue(undefined),
  sendSpecialKeys: vi.fn(),
  clearInputLine: vi.fn().mockResolvedValue(undefined),
  clearComposerLine: vi.fn().mockResolvedValue(undefined),
  killSession: vi.fn().mockResolvedValue(true),
  capturePane: vi.fn(),
  reconcileSessionGeometry: vi.fn().mockResolvedValue(false),
  exactTarget: (name: string) => `=${name}:`,
}));

vi.mock('@/lib/tmux/tmux-capture-cache', () => ({ invalidateCache: vi.fn() }));

vi.mock('@/lib/cli-tools/worktree-session-ownership', () => ({
  checkWorktreeSessionOwnership: vi.fn(async () => ({ verdict: 'owned', sessionPath: null })),
}));

vi.mock('@/lib/db', () => ({
  createMessage: vi.fn((_db: unknown, msg: Record<string, unknown>) => ({ id: 'row-1', ...msg })),
  updateLastUserMessage: vi.fn(),
  clearInProgressMessageId: vi.fn(),
  getMessages: vi.fn(() => []),
  deleteMessageById: vi.fn(() => true),
}));

const mockGetTool = vi.fn();
vi.mock('@/lib/cli-tools/manager', () => ({
  CLIToolManager: {
    getInstance: vi.fn(() => ({ getTool: (...args: unknown[]) => mockGetTool(...args) })),
  },
}));

vi.mock('@/lib/polling/response-poller', () => ({ startPolling: vi.fn(), getActivePollers: () => [] }));
vi.mock('@/lib/assistant-response-saver', () => ({
  savePendingAssistantResponse: vi.fn().mockResolvedValue(null),
}));
vi.mock('@/lib/ws-server', () => ({ broadcastMessage: vi.fn() }));
vi.mock('@/lib/session/cli-session', () => ({
  captureSessionOutputFresh: vi.fn().mockResolvedValue(''),
  captureSessionOutput: vi.fn(),
}));

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { sendUserMessage, type SendUserMessageParams } from '@/lib/session/send-user-message';
import { captureSessionOutput } from '@/lib/session/cli-session';
import { clearSendAttempts, getLastSendAttempt } from '@/lib/session/send-attempt-state';
import { resetInstanceInputLocks } from '@/lib/session/instance-input-lock';
import { clearAgentStopEvents, recordAgentEvent } from '@/lib/session/agent-event-state';
import { STRUCTURED_SEND_GUARD_ENV } from '@/lib/session/prompt-waiting-composition';
import { PROMPT_WAIT_DIALOG_CONFIRM_MS } from '@/lib/cli-tools/prompt-wait-dialog';
import { OpenCodeTool } from '@/lib/cli-tools/opencode';
import { VibeLocalTool } from '@/lib/cli-tools/vibe-local';
import type { CLIToolType } from '@/lib/cli-tools/types';
import { capturePane, sendKeys, sendSpecialKeys } from '@/lib/tmux/tmux';
import { buildOpencodeClearedFrame } from '@tests/fixtures/opencode-launch-boot-11821';

const FIXTURES = path.resolve(__dirname, '../../../fixtures');
const readFixture = (rel: string): string => readFileSync(path.join(FIXTURES, rel), 'utf8');

const WT = 'wt-4084-svc';
const mockDb = {} as never;

const VL_LOADING = readFixture('vibe-local-readiness-4040/boot-loading.txt');
/** A y/n dialog under vibe-local's loading screen (synthetic row; an active prompt to the detector). */
const VL_DIALOG = `${VL_LOADING.trimEnd()}\n\nAllow this command? (y/n)\n`;
const OC_PERMISSION = readFixture('opencode-live-2047/w80/permission-bash.txt');
const OC_LOADING = buildOpencodeClearedFrame();

let keys: string[] = [];

function framesInTurn(...frames: string[]): void {
  let call = 0;
  vi.mocked(capturePane).mockImplementation((async () => frames[Math.min(call++, frames.length - 1)]) as never);
}

function useTool<T extends object>(tool: T, dispatch?: string): T {
  const record = tool as unknown as Record<string, unknown>;
  record.requireSession = vi.fn(async () => undefined);
  record.isRunning = vi.fn(async () => true);
  if (dispatch !== undefined) record.dispatchViaServer = vi.fn(async () => dispatch);
  mockGetTool.mockReturnValue(tool);
  return tool;
}

type OnAttempt = NonNullable<SendUserMessageParams['onAttempt']>;
const attemptSpy = () => vi.fn<OnAttempt>();

async function send(cliToolId: CLIToolType, onAttempt: OnAttempt) {
  const startedAt = Date.now();
  const pending = sendUserMessage(mockDb, { worktreeId: WT, content: 'hello', cliToolId, onAttempt });
  await vi.runAllTimersAsync();
  const result = await pending;
  return { result, elapsed: Date.now() - startedAt };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  clearSendAttempts();
  clearAgentStopEvents();
  resetInstanceInputLocks();
  delete process.env[STRUCTURED_SEND_GUARD_ENV];
  keys = [];
  vi.mocked(sendKeys).mockImplementation((async (_s: string, text: string) => {
    keys.push(`type:${text}`);
  }) as never);
  vi.mocked(sendSpecialKeys).mockImplementation((async (_s: string, k: string[]) => {
    keys.push(k.join('+'));
  }) as never);
});

afterEach(() => {
  vi.useRealTimers();
  clearSendAttempts();
  clearAgentStopEvents();
  resetInstanceInputLocks();
});

describe('the request\'s own outcome when the prompt wait confirms a dialog (Issue #4084)', () => {
  it('vibe-local: a dialog that stays up — onAttempt not-sent / prompt-waiting, stage prompt_waiting, after the confirmation time', async () => {
    vi.mocked(captureSessionOutput).mockResolvedValue(VL_LOADING);
    useTool(new VibeLocalTool());
    framesInTurn(VL_DIALOG);
    const onAttempt = attemptSpy();
    const { result, elapsed } = await send('vibe-local', onAttempt);
    expect(keys).toEqual([]);
    expect(result).toMatchObject({ ok: false, stage: 'prompt_waiting' });
    expect(onAttempt).toHaveBeenCalledTimes(1);
    expect(onAttempt).toHaveBeenCalledWith({ state: 'not-sent', reason: 'prompt-waiting' });
    expect(elapsed).toBe(PROMPT_WAIT_DIALOG_CONFIRM_MS);
    expect(getLastSendAttempt({ worktreeId: WT, cliToolId: 'vibe-local', instanceId: 'vibe-local' })).toMatchObject({
      state: 'not-sent',
      reason: 'prompt-waiting',
    });
  });

  it('opencode: the HTTP dispatch skipped, the permission strip stays up — onAttempt not-sent / prompt-not-ready', async () => {
    vi.mocked(captureSessionOutput).mockResolvedValue(OC_LOADING);
    useTool(new OpenCodeTool(), 'skipped');
    framesInTurn(OC_PERMISSION);
    const onAttempt = attemptSpy();
    const { result } = await send('opencode', onAttempt);
    expect(keys).toEqual([]);
    expect(result).toMatchObject({ ok: false, stage: 'send' });
    expect(onAttempt).toHaveBeenCalledWith({ state: 'not-sent', reason: 'prompt-not-ready' });
  });

  it('opencode: the HTTP dispatch ended unknown, then the strip is confirmed — onAttempt stays indeterminate (not not-sent)', async () => {
    vi.mocked(captureSessionOutput).mockResolvedValue(OC_LOADING);
    useTool(new OpenCodeTool(), 'unknown');
    framesInTurn(OC_PERMISSION);
    const onAttempt = attemptSpy();
    const { result } = await send('opencode', onAttempt);
    expect(keys).toEqual([]);
    expect(result).toMatchObject({ ok: false, stage: 'send' });
    expect(onAttempt).toHaveBeenCalledTimes(1);
    expect(onAttempt.mock.calls[0][0].state).toBe('indeterminate');
  });
});

describe('out of scope, unchanged (Issue #4084)', () => {
  it('the entry guard still refuses on the hooks\' structured record alone — before the tool reads the pane', async () => {
    vi.mocked(captureSessionOutput).mockResolvedValue(VL_LOADING);
    useTool(new VibeLocalTool());
    framesInTurn(VL_LOADING);
    recordAgentEvent(WT, 'vibe-local', 'vibe-local', {
      event: 'notification',
      at: Date.now() - 1_000,
      detail: 'permission_prompt',
      sessionId: 'sess-4084',
      message: 'needs your permission',
    });
    const onAttempt = attemptSpy();
    const { result } = await send('vibe-local', onAttempt);
    expect(result).toMatchObject({ ok: false, stage: 'prompt_waiting' });
    expect(onAttempt).toHaveBeenCalledWith({ state: 'not-sent', reason: 'prompt-waiting' });
    expect(capturePane).not.toHaveBeenCalled();
  });

  it('control: without the record the same frame is not refused by the guard', async () => {
    vi.mocked(captureSessionOutput).mockResolvedValue(VL_LOADING);
    useTool(new VibeLocalTool());
    framesInTurn(VL_LOADING);
    const onAttempt = attemptSpy();
    await send('vibe-local', onAttempt);
    expect(capturePane).toHaveBeenCalled();
    expect(onAttempt).toHaveBeenCalledWith({ state: 'not-sent', reason: 'prompt-not-ready' });
  });
});
