/**
 * Issue #3981: one launch per session, taken outside the instance input lock.
 *
 * - The cycle (decision 1): A's launch waits for the lock to type its line; B
 *   holds the lock and tries to (re)start the same session. With the real
 *   `withInstanceInputLock` and the real single-flight, B is refused at once
 *   (`SESSION_STARTING`, nothing typed) and A types its line once, after B lets
 *   go. A naive map that has B wait for A (the mutation) deadlocks until A's
 *   lock wait runs out (`InstanceInputLockTimeoutError`).
 * - Negative: with no launch in progress, a send's relaunch under the lock
 *   (codex after its self-update) launches once and sends, as before.
 * - claude's two branches: a B that arrives while A is launching neither types
 *   its body into the shell nor kills A's pane, whether the pane passes claude's
 *   health check (`❯ `) or fails it (empty, `%`).
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AsyncResource } from 'node:async_hooks';

const pane = vi.hoisted(() => ({
  exists: false,
  screen: '',
  events: [] as string[],
  createGate: null as Promise<void> | null,
}));

vi.mock('@/lib/tmux/tmux', async () => {
  const lock = await import('@/lib/session/instance-input-lock');
  return {
    hasSession: vi.fn(async () => pane.exists),
    createSession: vi.fn(async () => {
      pane.exists = true;
      pane.events.push('create');
      if (pane.createGate) await pane.createGate;
    }),
    sendKeys: vi.fn(async (session: string, keys: string) => {
      const owned = lock.currentInstanceInputTicket(session) !== null;
      if (keys === 'unset CLAUDECODE') pane.events.push(`unset${owned ? '' : '(no-lock)'}`);
      else if (keys.includes('LAUNCH-LINE')) pane.events.push(`launch-line${owned ? '' : '(no-lock)'}`);
      else pane.events.push(`keys:${keys}`);
    }),
    sendSpecialKey: vi.fn(async (_s: string, key: string) => {
      pane.events.push(`special:${key}`);
    }),
    sendSpecialKeys: vi.fn(async () => undefined),
    capturePane: vi.fn(async () => pane.screen),
    killSession: vi.fn(async () => {
      pane.events.push('kill');
      pane.exists = false;
      return true;
    }),
    reconcileSessionGeometry: vi.fn().mockResolvedValue(false),
    getPaneCurrentCommand: vi.fn(async () => 'zsh'),
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

vi.mock('@/lib/cli-tools/submit-verified-sender', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/cli-tools/submit-verified-sender')>()),
  sendMessageWithSubmitVerification: vi.fn(async (params: { message: string }) => {
    pane.events.push(`body:${params.message}`);
  }),
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
    const stdout = String(args[0]).includes('which claude') ? '/usr/local/bin/claude' : '';
    queueMicrotask(() => callback?.(null, { stdout, stderr: '' } as unknown as string, ''));
    return {};
  };
  return { ...actual, exec: vi.fn(succeed), execFile: vi.fn(succeed) };
});

import { BaseCLITool } from '@/lib/cli-tools/base';
import { CodexTool } from '@/lib/cli-tools/codex';
import { ClaudeTool } from '@/lib/cli-tools/claude';
import { typeLaunchLines } from '@/lib/cli-tools/launch-keys';
import { clearCachedClaudePath, sendMessageToClaude } from '@/lib/session/claude-session';
import {
  INSTANCE_INPUT_LOCK_TIMEOUT_CODE,
  resetInstanceInputLocks,
  withInstanceInputLock,
} from '@/lib/session/instance-input-lock';
import {
  isSessionLaunchInFlight,
  resetSessionLaunchFlightsForTest,
  runSessionLaunch,
  settleSessionLaunch,
} from '@/lib/session/session-launch-flight';
import { SESSION_STARTING_CODE } from '@/lib/session/session-start-error';
import { registerIsolatedAgentHooksDir } from '@tests/helpers/agent-hooks-dir';

registerIsolatedAgentHooksDir('launch-flight-3981');

const WT = 'wt3981';
const WT_PATH = '/path/to/wt';

/**
 * A holder of `session`'s lock (request B) until `release`. `inside` runs a
 * function in B's async context — as B — while the rest of the test (request
 * A) stays outside it.
 */
function holdLock(session: string): {
  ready: Promise<void>;
  inside: <T>(fn: () => Promise<T>) => Promise<T>;
  release: () => void;
  done: Promise<void>;
} {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let runInB!: (fn: () => Promise<unknown>) => Promise<unknown>;
  let done!: Promise<void>;
  const ready = new Promise<void>((resolveReady) => {
    done = withInstanceInputLock(session, async () => {
      pane.events.push('<send>');
      runInB = AsyncResource.bind((fn: () => Promise<unknown>) => fn());
      resolveReady();
      await gate;
      pane.events.push('</send>');
    });
  });
  return {
    ready,
    inside: <T>(fn: () => Promise<T>) => runInB(fn) as Promise<T>,
    release: () => release(),
    done,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  pane.exists = false;
  pane.screen = '';
  pane.events = [];
  pane.createGate = null;
  resetInstanceInputLocks();
  resetSessionLaunchFlightsForTest();
  clearCachedClaudePath();
  vi.spyOn(CodexTool.prototype as unknown as { waitForReady: () => Promise<void> }, 'waitForReady').mockResolvedValue();
  vi.spyOn(CodexTool.prototype as unknown as { waitForPrompt: () => Promise<void> }, 'waitForPrompt').mockResolvedValue();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  resetInstanceInputLocks();
  resetSessionLaunchFlightsForTest();
});

describe('[#3981] decision 1: the launch is outside the lock, and a lock holder does not wait for it', () => {
  it('positive (primitives): B, holding the lock, is refused at once; A types its line once after B lets go', async () => {
    const s = 'mcbd-x-cycle';
    const b = holdLock(s);
    await b.ready;
    // A (another request) starts the launch; its keys queue behind B.
    const launchA = runSessionLaunch(s, 'X', () => typeLaunchLines(s, ['clear; LAUNCH-LINE']));
    await vi.advanceTimersByTimeAsync(0);
    expect(isSessionLaunchInFlight(s)).toBe(true);

    // B's own relaunch attempt, and B's pre-send wait: refused, not queued.
    const second = vi.fn(async () => {
      pane.events.push('second-launch');
    });
    await expect(b.inside(() => runSessionLaunch(s, 'X', second))).rejects.toMatchObject({ code: SESSION_STARTING_CODE });
    await expect(b.inside(() => settleSessionLaunch(s, 'X'))).rejects.toMatchObject({ code: SESSION_STARTING_CODE });
    expect(second).not.toHaveBeenCalled();
    expect(pane.events).toEqual(['<send>']);

    b.release();
    await b.done;
    await launchA;
    expect(pane.events).toEqual(['<send>', '</send>', 'launch-line']);
    expect(isSessionLaunchInFlight(s)).toBe(false);
  });

  it('mutation: a naive map that has the lock holder wait for the launch deadlocks until the lock wait runs out', async () => {
    const s = 'mcbd-x-naive';
    const naive = new Map<string, Promise<void>>();
    const b = holdLock(s);
    await b.ready;
    const launchA = Promise.resolve().then(() => typeLaunchLines(s, ['clear; LAUNCH-LINE']));
    naive.set(s, launchA);
    launchA.catch(() => undefined);
    // B waits for A while holding the lock, and only lets go after.
    const bWaits = b.inside(async () => {
      try {
        await naive.get(s);
      } finally {
        b.release();
      }
    });
    bWaits.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(60_001);

    await expect(launchA).rejects.toMatchObject({ code: INSTANCE_INPUT_LOCK_TIMEOUT_CODE });
    await expect(bWaits).rejects.toMatchObject({ code: INSTANCE_INPUT_LOCK_TIMEOUT_CODE });
    await b.done;
    expect(pane.events).toEqual(['<send>', '</send>']);
  });

  it('positive (codex): a send holding the lock while another request launches codex is not-sent, and the launch types once after it', async () => {
    const codex = new CodexTool();
    const s = codex.getSessionName(WT);
    const b = holdLock(s);
    await b.ready;
    const launchA = codex.startSession(WT, WT_PATH);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(pane.events).toEqual(['<send>', 'create']);

    // B's send: requireSession finds the launch in flight while B holds the lock.
    await expect(b.inside(() => codex.sendMessage(WT, 'hello'))).rejects.toMatchObject({ code: SESSION_STARTING_CODE });
    expect(pane.events).toEqual(['<send>', 'create']);

    b.release();
    await b.done;
    await vi.advanceTimersByTimeAsync(30_000);
    await launchA;
    expect(pane.events).toEqual(['<send>', 'create', '</send>', 'launch-line']);
  });
});

describe('[#3981] negative: no launch in progress, a relaunch under the lock is unchanged', () => {
  it('codex: the send relaunches once, inside its own lock turn, and sends', async () => {
    const codex = new CodexTool();
    const s = codex.getSessionName(WT);
    pane.exists = true;
    // The pane is back at the shell after codex's self-update.
    vi.spyOn(BaseCLITool.prototype as unknown as { isToolLive: () => Promise<boolean> }, 'isToolLive').mockResolvedValue(false);

    const sent = withInstanceInputLock(s, () => codex.sendMessage(WT, 'hello'));
    await vi.advanceTimersByTimeAsync(30_000);
    await sent;

    expect(pane.events).toEqual(['launch-line', 'body:hello']);
  });
});

describe('[#3981] claude: B during A’s launch does not type into the shell and does not kill A’s pane', () => {
  const SCREENS: ReadonlyArray<{ label: string; screen: string }> = [
    { label: 'passes the health check (❯ )', screen: '❯ ' },
    { label: 'fails it (empty)', screen: '' },
    { label: 'fails it (% prompt)', screen: 'user@host wt3981 %' },
  ];

  /** A is inside createSession (pane exists, nothing typed) until `open()`. */
  function startA(claude: ClaudeTool): { open: () => void; started: Promise<void> } {
    let open!: () => void;
    pane.createGate = new Promise<void>((r) => (open = r));
    const started = claude.startSession(WT, WT_PATH);
    return { open: () => open(), started };
  }

  it.each(SCREENS)('B starting the session too joins A when the pane $label', async ({ screen }) => {
    const claude = new ClaudeTool();
    pane.screen = screen;
    const a = startA(claude);
    await vi.advanceTimersByTimeAsync(100);
    expect(pane.events).toEqual(['create']);

    const b = claude.startSession(WT, WT_PATH);
    await vi.advanceTimersByTimeAsync(100);
    expect(pane.events).toEqual(['create']);

    pane.screen = '❯ ';
    a.open();
    await vi.advanceTimersByTimeAsync(30_000);
    await a.started;
    await b;
    expect(pane.events).toEqual(['create', 'unset', 'launch-line']);
  });

  it.each(SCREENS)('B sending under the lock is not-sent with nothing typed when the pane $label', async ({ screen }) => {
    const claude = new ClaudeTool();
    const s = claude.getSessionName(WT);
    pane.screen = screen;
    const a = startA(claude);
    await vi.advanceTimersByTimeAsync(100);

    const b = withInstanceInputLock(s, () => sendMessageToClaude(WT, 'hello'));
    await expect(b).rejects.toMatchObject({ code: SESSION_STARTING_CODE });
    expect(pane.events).toEqual(['create']);

    pane.screen = '❯ ';
    a.open();
    await vi.advanceTimersByTimeAsync(30_000);
    await a.started;
    expect(pane.events).toEqual(['create', 'unset', 'launch-line']);
  });

  it.each(SCREENS)('B sending with no lock waits for A and types after A’s launch when the pane $label', async ({ screen }) => {
    const claude = new ClaudeTool();
    pane.screen = screen;
    const a = startA(claude);
    await vi.advanceTimersByTimeAsync(100);

    const b = sendMessageToClaude(WT, 'hello');
    await vi.advanceTimersByTimeAsync(100);
    expect(pane.events).toEqual(['create']);

    pane.screen = '❯ ';
    a.open();
    await vi.advanceTimersByTimeAsync(30_000);
    await a.started;
    await b;
    expect(pane.events).toEqual(['create', 'unset', 'launch-line', 'body:hello']);
  });
});
