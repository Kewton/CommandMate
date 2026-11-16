/**
 * Issue #4344 (PR3 review, P2 1・2・3): what `ask` says when it does not collect
 * a reply. The behaviour (reply null, exit 0, no screen read) is the human
 * decision and is not changed; only the words and one optional `--json` key.
 *
 * Positive (red before the fix):
 *  - antigravity, a tool whose reply the old `ask` did read, is
 *    `unavailable/tool_unsupported` by name, and stderr points at the ways that
 *    still bring its reply back (`ask --async`, `reply`);
 *  - claude older than the minimum: stderr says the version and the minimum,
 *    not "this tool has no ask attribution"; `--json` adds `attribution.toolVersion`;
 *  - claude whose version could not be read: says so, with the minimum;
 *  - the same when the server (no tool named on the command line) turns the ask down;
 *  - an older server: stderr says to restart or update the server.
 * Negative: copilot's `--json` is exactly what it was (no `toolVersion`), and a
 * PR1/PR2 server without `versions` still reads as plain tool_unsupported.
 *
 * @vitest-environment node
 */

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { restoreFetch } from '../../../helpers/mock-api';
import { ExitCode } from '../../../../src/cli/types';
import { frame, mockServer, start, type Route } from './command-deadline-server';

const mockExit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
const mockConsoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
const mockConsoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv('CM_PORT', '3999');
});

afterEach(() => {
  restoreFetch();
  mockExit.mockClear();
  mockConsoleLog.mockClear();
  mockConsoleError.mockClear();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

const DRAIN_MS = 60_000;
const ALL_TOOLS = {
  claude: true, codex: true, copilot: false, gemini: false, 'vibe-local': false,
  opencode: false, antigravity: false, 'command-code': false, 'opencode-v2': false,
};
const CLAUDE_TOO_OLD = { claude: { minimum: '2.1.239', installed: '2.1.200', state: 'too_old' } };
const CLAUDE_UNREADABLE = { claude: { minimum: '2.1.239', installed: null, state: 'unreadable' } };

const stderrText = (): string => mockConsoleError.mock.calls.map((c) => String(c[0])).join('\n');
const stdoutLines = (): string[] => mockConsoleLog.mock.calls.map((c) => String(c[0]));
const payload = (): Record<string, unknown> => JSON.parse(stdoutLines()[0]);
const firstExit = (): unknown => mockExit.mock.calls[0]?.[0];
const sendBodies = (): Record<string, unknown>[] => vi.mocked(global.fetch).mock.calls
  .filter(([input, init]) => (init as RequestInit | undefined)?.method === 'POST' && String(input).endsWith('/send'))
  .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>);
const captures = (): number => vi.mocked(global.fetch).mock.calls.filter(([input]) => String(input).includes('/capture')).length;

const SEND: Route = () => ({ id: 'm1', worktreeId: 'wt1', role: 'user', content: 'x', timestamp: new Date().toISOString() });
const resolveAs = (cliToolId: string): Route => () => ({ cliToolId, instanceId: cliToolId, resolvedBy: 'roster', conflict: null });
const frameOf = (cliToolId: string) => ({ ...frame, cliToolId });

async function runAsk(args: string[]): Promise<void> {
  const run = await start('ask', args);
  await vi.advanceTimersByTimeAsync(DRAIN_MS);
  await run.pending;
}

describe('P2 1: a tool whose reply the old ask read (Issue #4344 PR3 review)', () => {
  it('antigravity is unavailable/tool_unsupported by name, and stderr names the ways back to its reply', async () => {
    mockServer({
      '/resolve-target': resolveAs('antigravity'),
      '/api/asks/capabilities': { protocol: 1, tools: ALL_TOOLS, versions: {} },
      'POST /send': SEND,
      '/current-output': frameOf('antigravity'),
      'POST /capture': { output: 'antigravity said this\n' },
    });

    await runAsk(['wt1', 'hi', '--instance', 'antigravity', '--json']);

    expect(firstExit()).toBe(ExitCode.SUCCESS);
    expect(sendBodies()).toEqual([{ content: 'hi', cliToolId: 'antigravity', instanceId: 'antigravity' }]);
    expect(captures()).toBe(0);
    expect(payload()).toEqual({
      worktreeId: 'wt1',
      instanceId: 'antigravity',
      cliToolId: 'antigravity',
      source: 'none',
      reply: null,
      askId: null,
      attribution: { state: 'unavailable', reason: 'tool_unsupported', notified: false },
    });
    const line = stderrText();
    expect(line).toContain('reply not collected (unavailable/tool_unsupported): antigravity: this tool has no ask attribution');
    expect(line).toContain('ask wt1 "<message>" --instance antigravity --async');
    expect(line).toContain('reply wt1 --instance antigravity');
    expect(line).toContain('capture wt1 --instance antigravity --pane');
  });
});

describe('P2 2: claude off for its version is not "a tool with no ask attribution"', () => {
  it('older than the minimum: the version and the minimum, and attribution.toolVersion', async () => {
    mockServer({
      '/resolve-target': resolveAs('claude'),
      '/api/asks/capabilities': { protocol: 1, tools: { ...ALL_TOOLS, claude: false }, versions: CLAUDE_TOO_OLD },
      'POST /send': SEND,
      '/current-output': frameOf('claude'),
    });

    await runAsk(['wt1', 'hi', '--instance', 'claude', '--json']);

    expect(firstExit()).toBe(ExitCode.SUCCESS);
    expect(sendBodies()[0]).not.toHaveProperty('ask');
    expect(payload()).toMatchObject({
      reply: null,
      askId: null,
      attribution: {
        state: 'unavailable',
        reason: 'tool_unsupported',
        notified: false,
        toolVersion: { state: 'too_old', minimum: '2.1.239', installed: '2.1.200' },
      },
    });
    const line = stderrText();
    expect(line).toContain('reply not collected (unavailable/tool_unsupported): claude: its version 2.1.200 is older than 2.1.239');
    expect(line).not.toContain('this tool has no ask attribution');
  });

  it('a version that could not be read says so, with the minimum', async () => {
    mockServer({
      '/resolve-target': resolveAs('claude'),
      '/api/asks/capabilities': { protocol: 1, tools: { ...ALL_TOOLS, claude: false }, versions: CLAUDE_UNREADABLE },
      'POST /send': SEND,
      '/current-output': frameOf('claude'),
    });

    await runAsk(['wt1', 'hi', '--instance', 'claude', '--json']);

    expect(payload()).toMatchObject({
      attribution: { reason: 'tool_unsupported', toolVersion: { state: 'unreadable', minimum: '2.1.239', installed: null } },
    });
    expect(stderrText()).toContain('claude: its installed version could not be read (ask attribution needs 2.1.239 or newer)');
    expect(stderrText()).not.toContain('this tool has no ask attribution');
  });

  it('the server turning the ask down for the default tool is read the same way (by the send\'s cliToolId)', async () => {
    mockServer({
      '/api/asks/capabilities': { protocol: 1, tools: { ...ALL_TOOLS, claude: false }, versions: CLAUDE_TOO_OLD },
      'POST /send': () => ({ id: 'm1', cliToolId: 'claude', ask: { id: null, state: 'unavailable', reason: 'tool_unsupported' } }),
      '/current-output': frame,
    });

    await runAsk(['wt1', 'hi', '--json']);

    expect(sendBodies()[0]).toHaveProperty('ask');
    expect(payload()).toMatchObject({
      attribution: { reason: 'tool_unsupported', toolVersion: { state: 'too_old', minimum: '2.1.239' } },
    });
    expect(stderrText()).toContain('claude: its version 2.1.200 is older than 2.1.239');
  });

  it('negative: copilot\'s --json carries no toolVersion; a server without `versions` is plain tool_unsupported', async () => {
    mockServer({
      '/resolve-target': resolveAs('claude'),
      '/api/asks/capabilities': { protocol: 1, tools: { ...ALL_TOOLS, claude: false } },
      'POST /send': SEND,
      '/current-output': frameOf('claude'),
    });

    await runAsk(['wt1', 'hi', '--instance', 'claude', '--json']);

    expect((payload().attribution as Record<string, unknown>)).toEqual({ state: 'unavailable', reason: 'tool_unsupported', notified: false });
    expect(stderrText()).toContain('claude: this tool has no ask attribution');
  });
});

describe('P2 3: an older server says to restart or update it', () => {
  it('server_unsupported names the restart and the update', async () => {
    mockServer({
      '/resolve-target': resolveAs('claude'),
      '/api/asks/capabilities': { status: 404, data: { error: 'Not Found' } },
      'POST /send': SEND,
      '/current-output': frameOf('claude'),
    });

    await runAsk(['wt1', 'hi', '--instance', 'claude']);

    expect(firstExit()).toBe(ExitCode.SUCCESS);
    const line = stderrText();
    expect(line).toContain('reply not collected (unavailable/server_unsupported): the server predates ask attribution');
    expect(line).toContain('commandmate stop');
    expect(line).toContain('commandmate start');
  });
});
