/**
 * `ask --agent <tool>` without `--instance` (Issue #2479).
 *
 * ## The measurement this suite is built from
 *
 * UAT 2026-09-11, isolated server, a worktree whose default tool is claude and
 * whose claude was never started:
 *
 * ```
 * $ commandmate ask uat-body "Reply with exactly: OK short" --agent command-code --json --timeout 300
 * Message sent. Waiting for the reply...
 * Not started: uat-body has no running claude session (resolvedBy=worktree-default).
 * (exit 21, 3 s)
 * ```
 *
 * The message HAD reached command-code, which ran the turn to the end ("Worked
 * for 15s"). The send carried `cliToolId: command-code`; the wait carried no
 * instance at all, so `current-output` resolved it to the worktree default. The
 * same request with `--instance command-code` returned `OK short`, exit 0.
 *
 * ## How the server is faked
 *
 * `resolve-target` and `current-output` are answered by the REAL
 * `resolveSessionTarget`, over a stubbed worktree row and roster, so the two
 * roster cases below run two different branches of the real precedence chain
 * (`roster`, and `explicit` for an id the roster does not know) rather than two
 * canned replies that would pass whatever the CLI sent.
 *
 * Sessions are scripted by time, not by poll count: a turn is `running` until
 * its `doneAt` and `ready` after, and its reply row only lands in the ledger at
 * `doneAt`. That is what makes "the wait watched the wrong session" observable —
 * a wait on the idle default completes at once, before the asked tool's reply
 * exists.
 */

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { resolveSessionTarget } from '@/lib/session/resolve-session-target';
import type { CLIToolType } from '@/lib/cli-tools/types';
import { restoreFetch } from '../../../helpers/mock-api';
import { ExitCode } from '../../../../src/cli/types';

const store = vi.hoisted(() => ({
  /** The worktree's own CLI tool — what an instance-less request falls to. */
  worktreeCliTool: 'claude',
  /** Registered roster rows: instance id -> CLI tool. */
  roster: new Map<string, string>(),
}));

vi.mock('@/lib/db/worktree-db', () => ({
  getWorktreeById: () => ({ id: 'wt1', cliToolId: store.worktreeCliTool }),
}));

vi.mock('@/lib/db/agent-instances-db', () => ({
  getAgentInstance: (_db: unknown, _worktreeId: string, instanceId: string) => {
    const cliTool = store.roster.get(instanceId);
    return cliTool ? { id: instanceId, cliTool, alias: instanceId, order: 0 } : null;
  },
}));

const mockExit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
const mockConsoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
const mockConsoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

/** Fixed clock the fake timers start from; `ask` takes `askedAt` here. */
const NOW = 1_787_500_000_000;

/** Long enough to drain every poll sleep and the 15 s reply grace. */
const DRAIN_MS = 90_000;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  store.worktreeCliTool = 'claude';
  store.roster.clear();
});

afterEach(() => {
  restoreFetch();
  mockExit.mockClear();
  mockConsoleLog.mockClear();
  mockConsoleError.mockClear();
  vi.useRealTimers();
});

interface ScriptedSession {
  /** Epoch ms the turn ends at: `running` before it, `ready` from it on. */
  doneAt: number;
  /** The row the transcript reader writes at `doneAt`, if it writes one. */
  reply?: string;
  /** What `/capture` shows for this instance. */
  pane?: string;
}

/** One request the fake server saw, and — for `resolve-target` — its answer. */
interface Seen {
  path: string;
  params: URLSearchParams;
  body: Record<string, unknown> | null;
  resolvedBy?: string;
}

let seen: Seen[] = [];

const json = (data: unknown, status = 200): Response =>
  ({
    ok: status >= 200 && status < 300,
    status,
    redirected: false,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(JSON.stringify(data)),
  }) as unknown as Response;

/** The server's own resolution, over the stubbed worktree row and roster. */
function resolve(instance: string | null, cliTool: string | null) {
  return resolveSessionTarget({} as Database.Database, 'wt1', {
    instanceId: instance ?? undefined,
    requestedCliTool: (cliTool ?? undefined) as CLIToolType | undefined,
  });
}

/** A `current-output` frame, shaped the way `wait`'s own tests spell one. */
function frame(
  cliToolId: string,
  resolvedBy: string,
  state: 'absent' | 'running' | 'ready',
) {
  return {
    isRunning: state !== 'absent',
    isComplete: state === 'ready',
    isPromptWaiting: false,
    isGenerating: state === 'running',
    content: state,
    fullOutput: state,
    realtimeSnippet: '',
    lineCount: 1,
    lastCapturedLine: 1,
    promptData: null,
    autoYes: { enabled: false, expiresAt: null },
    thinking: false,
    thinkingMessage: null,
    cliToolId,
    resolvedBy,
    isSelectionListActive: false,
    lastServerResponseTimestamp: null,
    serverPollerActive: false,
    sessionStatus: state === 'absent' ? 'idle' : state,
  };
}

/**
 * Answer every request `ask` makes from the scripted sessions, keyed by
 * instance id. An instance with no script has no tmux session.
 */
function startServer(sessions: Record<string, ScriptedSession>): void {
  seen = [];
  global.fetch = vi.fn((input: unknown, init?: { body?: string }) => {
    const url = new URL(String(input), 'http://localhost');
    const record: Seen = {
      path: url.pathname,
      params: url.searchParams,
      body: init?.body ? JSON.parse(init.body) : null,
    };
    seen.push(record);

    if (url.pathname === '/api/capabilities') {
      return Promise.resolve(
        json({ serverVersion: '0.0.0-test', capabilities: ['resolve-session-target'] }),
      );
    }
    if (url.pathname.endsWith('/resolve-target')) {
      const target = resolve(url.searchParams.get('instance'), url.searchParams.get('cliTool'));
      record.resolvedBy = target.resolvedBy;
      return Promise.resolve(json({ ...target, conflict: target.conflict ?? null }));
    }
    if (url.pathname.endsWith('/send')) {
      return Promise.resolve(json({ id: 1 }, 201));
    }
    if (url.pathname.endsWith('/current-output')) {
      // `wait` sends no `?cliTool`, so this is the route's own resolution.
      const target = resolve(url.searchParams.get('instance'), null);
      const session = sessions[target.instanceId];
      const state = !session ? 'absent' : Date.now() < session.doneAt ? 'running' : 'ready';
      return Promise.resolve(json(frame(target.cliToolId, target.resolvedBy, state)));
    }
    if (url.pathname.endsWith('/messages')) {
      const instance = url.searchParams.get('instance');
      const rows = Object.entries(sessions)
        .filter(([id, s]) => (instance === null || id === instance)
          && s.reply !== undefined && Date.now() >= s.doneAt)
        .map(([id, s]) => ({
          id: `m-${id}`,
          worktreeId: 'wt1',
          role: 'assistant',
          content: s.reply,
          timestamp: new Date(s.doneAt).toISOString(),
          messageType: 'normal',
          requestId: `${resolve(id, null).cliToolId}-turn:01`,
          archived: false,
        }));
      return Promise.resolve(json(rows));
    }
    if (url.pathname.endsWith('/capture')) {
      const instanceId = record.body?.instanceId;
      const pane = typeof instanceId === 'string' ? sessions[instanceId]?.pane : undefined;
      return Promise.resolve(json({ output: pane ?? '' }));
    }
    return Promise.resolve(json({ error: `unexpected ${url.pathname}` }, 404));
  }) as unknown as typeof fetch;
}

const requestsTo = (suffix: string): Seen[] => seen.filter((r) => r.path.endsWith(suffix));

const stderr = (): string => mockConsoleError.mock.calls.flat().join('\n');

async function runAsk(argv: string[]): Promise<void> {
  const { createAskCommand } = await import('../../../../src/cli/commands/ask');
  const pending = createAskCommand().parseAsync(['node', 'ask', 'wt1', ...argv]);
  await vi.advanceTimersByTimeAsync(DRAIN_MS);
  await pending;
}

describe('ask --agent <tool> alone: the send, the wait and the read all address <tool> (Issue #2479)', () => {
  it.each([
    {
      label: 'the roster has no row for it',
      roster: [] as Array<[string, string]>,
      resolvedBy: 'explicit',
    },
    {
      label: 'the roster already has a command-code row',
      roster: [['command-code', 'command-code']] as Array<[string, string]>,
      resolvedBy: 'roster',
    },
  ])('answers from command-code, not "Not started" on the default, when $label', async ({
    roster,
    resolvedBy,
  }) => {
    for (const [id, tool] of roster) store.roster.set(id, tool);
    // The UAT worktree: claude (the default) never started, command-code ran a 15 s turn.
    startServer({ 'command-code': { doneAt: NOW + 15_000, reply: 'OK short' } });

    await runAsk([
      'Reply with exactly: OK short', '--agent', 'command-code', '--json', '--timeout', '300',
    ]);

    // Resolved once, with the tool id as the selector …
    const resolutions = requestsTo('/resolve-target');
    expect(resolutions).toHaveLength(1);
    expect(resolutions[0].params.get('instance')).toBe('command-code');
    expect(resolutions[0].params.get('cliTool')).toBe('command-code');
    expect(resolutions[0].resolvedBy).toBe(resolvedBy);

    // … and every later request addresses that one answer.
    expect(requestsTo('/send').map((r) => r.body)).toEqual([
      {
        content: 'Reply with exactly: OK short',
        cliToolId: 'command-code',
        instanceId: 'command-code',
      },
    ]);
    const polls = requestsTo('/current-output').map((r) => r.params.get('instance'));
    expect(polls.length).toBeGreaterThan(1);
    expect(new Set(polls)).toEqual(new Set(['command-code']));
    const reads = requestsTo('/messages').map((r) => r.params.get('instance'));
    expect(new Set(reads)).toEqual(new Set(['command-code']));

    expect(stderr()).not.toContain('Not started');
    expect(mockExit).toHaveBeenCalledTimes(1);
    expect(mockExit).toHaveBeenCalledWith(ExitCode.SUCCESS);
    expect(JSON.parse(mockConsoleLog.mock.calls[0][0] as string)).toEqual({
      worktreeId: 'wt1',
      instanceId: 'command-code',
      cliToolId: 'command-code',
      source: 'history',
      reply: 'OK short',
    });
  });

  it('waits out command-code\'s turn even while the default sits idle at its composer', async () => {
    // A wait on claude completes on its first poll. command-code's turn outlasts
    // the 15 s reply grace, so only a wait on command-code sees its reply land.
    startServer({
      claude: { doneAt: NOW - 60_000 },
      'command-code': { doneAt: NOW + 40_000, reply: 'OK short' },
    });

    await runAsk(['Reply with exactly: OK short', '--agent', 'command-code']);

    const polls = requestsTo('/current-output').map((r) => r.params.get('instance'));
    expect(polls.length).toBeGreaterThan(1);
    expect(new Set(polls)).toEqual(new Set(['command-code']));
    expect(mockExit).toHaveBeenCalledWith(ExitCode.SUCCESS);
    expect(mockConsoleLog.mock.calls).toEqual([['OK short']]);
  });

  it('falls back to command-code\'s own pane, not the default\'s, when no turn row lands', async () => {
    startServer({
      claude: { doneAt: NOW - 60_000, pane: 'the default claude pane' },
      'command-code': { doneAt: NOW + 5_000, pane: 'OK short' },
    });

    await runAsk(['Reply with exactly: OK short', '--agent', 'command-code', '--json']);

    const captures = requestsTo('/capture').map((r) => r.body);
    expect(captures).toHaveLength(1);
    expect(captures[0]).toMatchObject({ cliToolId: 'command-code', instanceId: 'command-code' });
    const payload = JSON.parse(mockConsoleLog.mock.calls[0][0] as string);
    expect(payload).toMatchObject({
      instanceId: 'command-code',
      cliToolId: 'command-code',
      source: 'pane',
    });
    expect(payload.reply).toContain('OK short');
  });
});

describe('ask: the targeting that Issue #2479 leaves alone', () => {
  it('with neither --instance nor --agent, resolves nothing and leaves the default to the server', async () => {
    startServer({ claude: { doneAt: NOW + 5_000, reply: 'from the default' } });

    await runAsk(['hello']);

    expect(requestsTo('/resolve-target')).toHaveLength(0);
    expect(requestsTo('/send').map((r) => r.body)).toEqual([{ content: 'hello' }]);
    const polls = requestsTo('/current-output');
    expect(polls.length).toBeGreaterThan(0);
    expect(polls.every((r) => !r.params.has('instance'))).toBe(true);
    expect(requestsTo('/messages').every((r) => !r.params.has('instance'))).toBe(true);
    expect(mockExit).toHaveBeenCalledWith(ExitCode.SUCCESS);
    expect(mockConsoleLog.mock.calls).toEqual([['from the default']]);
  });

  it('with --instance and --agent together, --instance stays the selector', async () => {
    store.roster.set('codex-2', 'codex');
    startServer({ 'codex-2': { doneAt: NOW + 5_000, reply: '2 です' } });

    await runAsk(['1+1は？', '--instance', 'codex-2', '--agent', 'codex', '--json']);

    const resolutions = requestsTo('/resolve-target');
    expect(resolutions).toHaveLength(1);
    expect(resolutions[0].params.get('instance')).toBe('codex-2');
    expect(resolutions[0].params.get('cliTool')).toBe('codex');
    expect(requestsTo('/send').map((r) => r.body)).toEqual([
      { content: '1+1は？', cliToolId: 'codex', instanceId: 'codex-2' },
    ]);
    expect(new Set(requestsTo('/current-output').map((r) => r.params.get('instance'))))
      .toEqual(new Set(['codex-2']));
    expect(JSON.parse(mockConsoleLog.mock.calls[0][0] as string)).toMatchObject({
      instanceId: 'codex-2',
      cliToolId: 'codex',
      reply: '2 です',
    });
  });

  it('with an --agent the roster contradicts for --instance, exits 2 having sent nothing', async () => {
    store.roster.set('codex-2', 'codex');
    startServer({ 'codex-2': { doneAt: NOW + 5_000, reply: 'never asked' } });
    // `ask` resolves in strict mode: the conflict is exit 2, and exiting must
    // stop the command rather than fall through to the send.
    mockExit.mockImplementationOnce((() => {
      throw new Error('process.exit');
    }) as never);

    await runAsk(['hi', '--instance', 'codex-2', '--agent', 'claude']);

    expect(mockExit.mock.calls[0]).toEqual([ExitCode.CONFIG_ERROR]);
    expect(stderr()).toContain('registered as codex');
    const resolutions = requestsTo('/resolve-target');
    expect(resolutions).toHaveLength(1);
    expect(resolutions[0].params.get('instance')).toBe('codex-2');
    expect(resolutions[0].params.get('cliTool')).toBe('claude');
    expect(requestsTo('/send')).toHaveLength(0);
  });
});

/**
 * Issue #2487 (UAT 2026-09-11, TC-79-4B), end to end: a worktree with no
 * roster rows, `--instance` naming a tool's primary instance and `--agent`
 * naming a different tool. Before the fix the resolver took `--agent` as the
 * declaration of an ad-hoc instance, so the message went to a new
 * `mcbd-command-code-<wt>-antigravity` while the wait watched agy. The
 * resolution runs through the REAL server resolver, so this pins both halves:
 * the server reports the contradiction, and `ask` refuses it before the send
 * with a sentence that does not point at a roster entry there is none of.
 */
describe('ask --instance <tool> --agent <another tool> (Issue #2487)', () => {
  it('exits 2 having sent nothing, rather than sending to an ad-hoc session and waiting on the primary', async () => {
    startServer({
      antigravity: { doneAt: NOW + 5_000, reply: 'never asked' },
      'command-code': { doneAt: NOW + 5_000, reply: 'never asked' },
    });
    mockExit.mockImplementationOnce((() => {
      throw new Error('process.exit');
    }) as never);

    await runAsk(['Reply with exactly: OK', '--instance', 'antigravity', '--agent', 'command-code']);

    expect(mockExit.mock.calls[0]).toEqual([ExitCode.CONFIG_ERROR]);
    const resolutions = requestsTo('/resolve-target');
    expect(resolutions).toHaveLength(1);
    expect(resolutions[0].params.get('instance')).toBe('antigravity');
    expect(resolutions[0].params.get('cliTool')).toBe('command-code');
    expect(resolutions[0].resolvedBy).toBe('primary');
    expect(requestsTo('/send')).toHaveLength(0);
    expect(requestsTo('/current-output')).toHaveLength(0);
    expect(stderr()).toContain("instance 'antigravity' is the primary instance of antigravity");
    expect(stderr()).not.toMatch(/regist|roster/i);
  });
});
