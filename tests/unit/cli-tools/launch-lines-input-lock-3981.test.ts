/**
 * Issue #3981: every tool's launch line — and claude's `unset CLAUDECODE` —
 * is typed in one `exclusive` turn of the instance input lock
 * (`typeLaunchLines`).
 *
 * Positive control: before #3981 seven tools typed their launch line with no
 * lock, and claude's `unset CLAUDECODE` went out before its locked line, so a
 * send holding the composer had them land inside its body. Here a send holds
 * the lock while each tool's real `startSession` runs: nothing is typed until it
 * lets go, and every launch key is typed with a ticket for the session.
 * Negative control: with no send in the way, the launch keys are the same ones,
 * in the same order and number, as before.
 *
 * tmux, the hooks plan, the executables and the readiness waits are stubbed;
 * the launch path down to the keys is each tool's own.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const events = vi.hoisted(() => ({ list: [] as string[], ticketAtKey: [] as boolean[] }));

vi.mock('@/lib/tmux/tmux', async () => {
  const lock = await import('@/lib/session/instance-input-lock');
  return {
    hasSession: vi.fn().mockResolvedValue(false),
    createSession: vi.fn().mockResolvedValue(undefined),
    sendKeys: vi.fn(async (session: string, keys: string, enter?: boolean) => {
      events.ticketAtKey.push(lock.currentInstanceInputTicket(session) !== null);
      if (keys === 'unset CLAUDECODE') events.list.push('unset');
      else if (keys === '' && enter === true) events.list.push('enter');
      else events.list.push(keys.includes('LAUNCH-LINE') || keys.includes('vibe-local') ? 'launch-line' : `keys:${keys}`);
    }),
    sendSpecialKey: vi.fn(async (_s: string, key: string) => {
      events.list.push(`special:${key}`);
    }),
    sendSpecialKeys: vi.fn(async () => undefined),
    capturePane: vi.fn().mockResolvedValue('❯ '),
    killSession: vi.fn().mockResolvedValue(true),
    reconcileSessionGeometry: vi.fn().mockResolvedValue(false),
    getPaneCurrentCommand: vi.fn().mockResolvedValue('claude'),
    getSessionWorkingDirectory: vi.fn().mockResolvedValue('/path/to/wt'),
    exactTarget: (name: string) => `=${name}:`,
  };
});

vi.mock('@/lib/tmux/tmux-capture-cache', () => ({ invalidateCache: vi.fn() }));
vi.mock('@/lib/tmux/session-ownership', () => ({
  assertSessionNotForeign: vi.fn(async () => ({ verdict: 'owned', sessionPath: null })),
}));

vi.mock('@/lib/session/agent-session-lifecycle', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/session/agent-session-lifecycle')>()),
  beginAgentSession: vi.fn(),
  buildAgentLaunchCommandLine: vi.fn(() => 'LAUNCH-LINE'),
}));

vi.mock('@/lib/cli-tools/copilot-executable', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/cli-tools/copilot-executable')>()),
  resolveCopilotExecutable: vi.fn(async () => ({ path: '/fake/copilot', version: '1.0.80', source: 'path' })),
}));

vi.mock('@/lib/cli-tools/opencode-executable', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/cli-tools/opencode-executable')>()),
  resolveOpencodeV1Executable: vi.fn(async () => ({
    executable: { path: '/fake/opencode', version: '1.0.0', generation: 'v1' },
    probed: [],
  })),
  resolveOpencodeV2Executable: vi.fn(async () => ({
    executable: { path: '/fake/opencode2', version: '2.0.18', generation: 'v2' },
    probed: [],
  })),
}));

vi.mock('@/lib/cli-tools/opencode-config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/cli-tools/opencode-config')>()),
  ensureOpencodeConfig: vi.fn(async () => undefined),
}));

vi.mock('@/lib/hooks/sources/opencode/runtime', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/hooks/sources/opencode/runtime')>()),
  reserveOpencodeServerPort: vi.fn(async () => null),
  attachOpencodeEventStream: vi.fn(async () => true),
  resumeOpencodeEventStream: vi.fn(async () => true),
  releaseOpencodeEventStream: vi.fn(async () => undefined),
}));

vi.mock('@/lib/hooks/sources/opencode-v2/runtime', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/hooks/sources/opencode-v2/runtime')>()),
  reserveOpencodeV2Server: vi.fn(async () => null),
  attachOpencodeV2EventStream: vi.fn(async () => true),
  resumeOpencodeV2EventStream: vi.fn(async () => true),
  releaseOpencodeV2Server: vi.fn(async () => undefined),
}));

vi.mock('@/lib/session/opencode-session-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/session/opencode-session-store')>()),
  recoverOpencodeSessionId: vi.fn(() => null),
}));

vi.mock('@/lib/db/db-instance', () => ({
  getDbInstance: () => {
    throw new Error('no database in this suite');
  },
}));

vi.mock('fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('fs/promises')>()),
  access: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  const succeed = (...args: unknown[]) => {
    const callback = args.find((a) => typeof a === 'function') as
      | ((err: Error | null, stdout: unknown, stderr?: string) => void)
      | undefined;
    const cmd = String(args[0]);
    const stdout = cmd.includes('which claude') ? '/usr/local/bin/claude' : '';
    queueMicrotask(() => callback?.(null, { stdout, stderr: '' } as unknown as string, ''));
    return {};
  };
  return { ...actual, exec: vi.fn(succeed), execFile: vi.fn(succeed) };
});

import { BaseCLITool } from '@/lib/cli-tools/base';
import { CodexTool } from '@/lib/cli-tools/codex';
import { CopilotTool } from '@/lib/cli-tools/copilot';
import { AntigravityTool } from '@/lib/cli-tools/antigravity';
import { OpenCodeTool } from '@/lib/cli-tools/opencode';
import { OpenCodeV2Tool } from '@/lib/cli-tools/opencode-v2';
import { CommandCodeTool } from '@/lib/cli-tools/command-code';
import { VibeLocalTool } from '@/lib/cli-tools/vibe-local';
import { GeminiTool } from '@/lib/cli-tools/gemini';
import { ClaudeTool } from '@/lib/cli-tools/claude';
import { clearCachedClaudePath } from '@/lib/session/claude-session';
import { resetInstanceInputLocks, withInstanceInputLock } from '@/lib/session/instance-input-lock';
import { resetSessionLaunchFlightsForTest } from '@/lib/session/session-launch-flight';
import { registerIsolatedAgentHooksDir } from '@tests/helpers/agent-hooks-dir';

registerIsolatedAgentHooksDir('launch-lines-3981');

const WT = 'wt3981';
const WT_PATH = '/path/to/wt';

/** The seven tools whose launch line had no lock, and gemini (#3975). */
const TOOLS: ReadonlyArray<{ name: string; make: () => BaseCLITool; keys: string[] }> = [
  { name: 'codex', make: () => new CodexTool(), keys: ['launch-line'] },
  { name: 'copilot', make: () => new CopilotTool(), keys: ['launch-line'] },
  { name: 'antigravity', make: () => new AntigravityTool(), keys: ['launch-line'] },
  { name: 'opencode', make: () => new OpenCodeTool(), keys: ['launch-line'] },
  { name: 'opencode-v2', make: () => new OpenCodeV2Tool(), keys: ['launch-line'] },
  { name: 'command-code', make: () => new CommandCodeTool(), keys: ['launch-line'] },
  { name: 'vibe-local', make: () => new VibeLocalTool(), keys: ['launch-line'] },
  { name: 'gemini', make: () => new GeminiTool(), keys: ['launch-line'] },
  { name: 'claude', make: () => new ClaudeTool(), keys: ['unset', 'launch-line'] },
];

/** A send holding `session`'s composer until `release`. */
function holdSend(session: string): { release: () => void; done: Promise<void> } {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const done = withInstanceInputLock(session, async () => {
    events.list.push('<send>');
    await gate;
    events.list.push('</send>');
  });
  return { release: () => release(), done };
}

/** Readiness waits are not what this suite is about: each returns at once. */
function stubReadiness(): void {
  for (const Tool of [CodexTool, CopilotTool, AntigravityTool, OpenCodeTool, OpenCodeV2Tool, CommandCodeTool, GeminiTool]) {
    vi.spyOn(Tool.prototype as unknown as { waitForReady: () => Promise<unknown> }, 'waitForReady').mockResolvedValue(true);
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  events.list = [];
  events.ticketAtKey = [];
  resetInstanceInputLocks();
  resetSessionLaunchFlightsForTest();
  clearCachedClaudePath();
  stubReadiness();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  resetInstanceInputLocks();
  resetSessionLaunchFlightsForTest();
});

describe('[#3981] launch keys wait for a send holding the composer, per tool', () => {
  it.each(TOOLS)('positive: $name types nothing while the send holds it, and its keys with a ticket after', async ({ make, keys }) => {
    const tool = make();
    const session = tool.getSessionName(WT);
    const held = holdSend(session);
    const started = tool.startSession(WT, WT_PATH);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(events.list).toEqual(['<send>']);

    held.release();
    await held.done;
    await vi.advanceTimersByTimeAsync(120_000);
    await started;

    expect(events.list).toEqual(['<send>', '</send>', ...keys]);
    expect(events.ticketAtKey).toEqual(keys.map(() => true));
  });

  it.each(TOOLS)('negative: with no send in the way, $name types the same keys in the same order', async ({ make, keys }) => {
    const tool = make();
    const started = tool.startSession(WT, WT_PATH);
    await vi.advanceTimersByTimeAsync(120_000);
    await started;

    expect(events.list).toEqual(keys);
  });
});
