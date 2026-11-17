/**
 * Issue #4438 G4: where the CLI says the Antigravity usage notice.
 *
 * `instances add --agent antigravity` (--json too), and `send` / `ask` / `respond`
 * (strict too) to an antigravity instance, refused or not: once, on stderr only.
 *
 * G4-a  stdout and --json stay clean (--json's stdout parses)
 * G4-b  a refusal keeps exit 33 and its reason as stderr's first line; the notice follows
 * G4-c  other tools: nothing said, no record
 * G4-d  the second run is silent
 *
 * No server, no tmux, no agy; the record is in a temp dir.
 *
 * @vitest-environment node
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { keepOffTheRealServer, restoreFetch } from '../../../helpers/mock-api';
import { ANTIGRAVITY_FAQ_URL, ANTIGRAVITY_TERMS_URL, TOOL_POLICY_DENIED_MESSAGE } from '../../../../src/lib/tool-policy/policy';
import { ANTIGRAVITY_NOTICE_DIR_ENV, ANTIGRAVITY_NOTICE_FILE_NAME } from '../../../../src/cli/utils/antigravity-notice';

keepOffTheRealServer();

const mockExit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
const mockConsoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
const mockConsoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

const ORIGIN_ENV = [
  'TMUX', 'CLAUDECODE', 'CM_RUN_ORIGIN', 'CM_WORKTREE_ID', 'CM_AGENT_WORKTREE_ID',
  'CM_INSTANCE_ID', 'CM_AGENT_INSTANCE_ID', 'CM_CLI_TOOL', 'CM_AGENT_TOOL',
];
const ttyDescriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-4438-g4cli-'));
  vi.stubEnv('CM_PORT', '3999');
  vi.stubEnv(ANTIGRAVITY_NOTICE_DIR_ENV, dir);
  for (const name of ORIGIN_ENV) vi.stubEnv(name, '');
  Object.defineProperty(process.stdin, 'isTTY', { value: undefined, configurable: true, writable: true });
});

afterEach(() => {
  restoreFetch();
  vi.unstubAllEnvs();
  if (ttyDescriptor) Object.defineProperty(process.stdin, 'isTTY', ttyDescriptor);
  else delete (process.stdin as { isTTY?: boolean }).isTTY;
  mockExit.mockClear();
  mockConsoleLog.mockClear();
  mockConsoleError.mockClear();
  fs.rmSync(dir, { recursive: true, force: true });
});

interface Route {
  match: string;
  method?: string;
  response: { status: number; data: unknown };
}

function resolveTarget(worktreeId: string, instanceId: string, cliToolId: string): Route {
  return {
    match: `/api/worktrees/${worktreeId}/resolve-target`,
    method: 'GET',
    response: { status: 200, data: { cliToolId, instanceId, resolvedBy: 'server', conflict: null } },
  };
}

const BASE: Route[] = [
  { match: '/api/capabilities', method: 'GET', response: { status: 200, data: { serverVersion: '0.0.0-test', capabilities: ['resolve-session-target'] } } },
  resolveTarget('wt-g', 'antigravity', 'antigravity'),
  resolveTarget('wt-c', 'claude', 'claude'),
  { match: '/api/asks/capabilities', method: 'GET', response: { status: 200, data: { protocol: 1, tools: { antigravity: false, claude: false } } } },
  { match: '/current-output', method: 'GET', response: { status: 200, data: {} } },
];

function mockRoutes(routes: Route[]): void {
  const all = [...routes, ...BASE].sort((a, b) => b.match.length - a.match.length);
  global.fetch = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    const route = all.find((c) => url.includes(c.match) && (c.method ?? 'POST').toUpperCase() === method);
    if (!route) return Promise.reject(new Error(`unexpected request: ${method} ${url}`));
    const { status, data } = route.response;
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      redirected: false,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: () => Promise.resolve(data),
      text: () => Promise.resolve(JSON.stringify(data)),
    });
  }) as unknown as typeof fetch;
}

class ExitSignal extends Error {
  constructor(readonly code: number) {
    super(`process.exit(${code})`);
  }
}

async function runUntilExit(run: () => Promise<void>): Promise<number | undefined> {
  let firstCode: number | undefined;
  mockExit.mockImplementation(((code?: number) => {
    const resolved = typeof code === 'number' ? code : 0;
    if (firstCode === undefined) firstCode = resolved;
    throw new ExitSignal(resolved);
  }) as never);
  try {
    await run();
  } catch (error) {
    if (!(error instanceof ExitSignal)) throw error;
  } finally {
    mockExit.mockImplementation((() => {}) as never);
  }
  return firstCode;
}

async function runSend(argv: string[]): Promise<void> {
  const { createSendCommand } = await import('../../../../src/cli/commands/send');
  await createSendCommand().parseAsync(['node', 'send', ...argv]);
}
async function runAsk(argv: string[]): Promise<void> {
  const { createAskCommand } = await import('../../../../src/cli/commands/ask');
  await createAskCommand().parseAsync(['node', 'ask', ...argv]);
}
async function runRespond(argv: string[]): Promise<void> {
  const { createRespondCommand } = await import('../../../../src/cli/commands/respond');
  await createRespondCommand().parseAsync(['node', 'respond', ...argv]);
}
async function runInstances(argv: string[]): Promise<void> {
  const { createInstancesCommand } = await import('../../../../src/cli/commands/instances');
  await createInstancesCommand().parseAsync(['node', 'instances', ...argv]);
}

const stderrLines = (): string[] => mockConsoleError.mock.calls.map((c) => String(c[0]));
const noticeCount = (): number => stderrLines().filter((l) => l.startsWith('Notice [antigravity]')).length;
const recorded = (): boolean => fs.existsSync(path.join(dir, ANTIGRAVITY_NOTICE_FILE_NAME));

const UNLOCK = 'Set CM_ANTIGRAVITY_USAGE=api-key (or CM_ANTIGRAVITY_USAGE=enterprise) on the server and restart it.';
const DENIED = {
  status: 409,
  data: {
    error: TOOL_POLICY_DENIED_MESSAGE,
    code: 'TOOL_POLICY_DENIED',
    policy: {
      tool: 'antigravity', operation: 'send', origin: 'unknown', reason: 'ANTIGRAVITY_CONSUMER_TERMS', declaration: 'personal',
      links: { terms: ANTIGRAVITY_TERMS_URL, faq: ANTIGRAVITY_FAQ_URL }, unlock: UNLOCK,
    },
    sendOutcome: 'not_sent',
  },
};
const SENT = { status: 201, data: { id: 'm1', role: 'user', content: 'x', sendOutcome: 'sent' } };

describe('send / ask / respond to antigravity (#4438 G4)', () => {
  it('G4-b: a refused send keeps exit 33 and the reason as line 1; the notice comes after it, once', async () => {
    mockRoutes([{ match: '/api/worktrees/wt-g/send', response: DENIED }]);
    const code = await runUntilExit(() => runSend(['wt-g', 'hello', '--instance', 'antigravity']));
    expect(code).toBe(33);
    const lines = stderrLines();
    expect(lines[0]).toMatch(/^Error \[TOOL_POLICY_DENIED\]: /);
    expect(noticeCount()).toBe(1);
    expect(lines.findIndex((l) => l.startsWith('Notice [antigravity]'))).toBeGreaterThan(lines.findIndex((l) => l.includes('sent: false')));
    expect(recorded()).toBe(true);
  });

  it('G4-d: a send that is not refused says it the first time; the next run is silent', async () => {
    mockRoutes([{ match: '/api/worktrees/wt-g/send', response: SENT }]);
    await runUntilExit(() => runSend(['wt-g', 'hello', '--instance', 'antigravity']));
    expect(noticeCount()).toBe(1);
    mockConsoleError.mockClear();
    await runUntilExit(() => runSend(['wt-g', 'hello', '--instance', 'antigravity']));
    expect(noticeCount()).toBe(0);
    expect(stderrLines()).toContain('Message sent.');
  });

  it('G4-c: a send to claude says nothing and leaves no record', async () => {
    mockRoutes([{ match: '/api/worktrees/wt-c/send', response: SENT }]);
    await runUntilExit(() => runSend(['wt-c', 'hello', '--instance', 'claude']));
    expect(noticeCount()).toBe(0);
    expect(recorded()).toBe(false);
  });

  it('P1: an unwritable record changes neither the exit nor the reason line', async () => {
    const blocker = path.join(dir, 'blocker');
    fs.writeFileSync(blocker, 'x');
    vi.stubEnv(ANTIGRAVITY_NOTICE_DIR_ENV, blocker);
    mockRoutes([{ match: '/api/worktrees/wt-g/send', response: DENIED }]);
    const code = await runUntilExit(() => runSend(['wt-g', 'hello', '--instance', 'antigravity']));
    expect(code).toBe(33);
    expect(stderrLines()[0]).toMatch(/^Error \[TOOL_POLICY_DENIED\]: /);
  });

  it('ask (--json) to antigravity: stdout is one JSON, the notice is on stderr', async () => {
    mockRoutes([{ match: '/api/worktrees/wt-g/send', response: DENIED }]);
    const code = await runUntilExit(() => runAsk(['wt-g', 'hello', '--instance', 'antigravity', '--json']));
    expect(code).toBe(33);
    expect(stderrLines()[0]).toMatch(/^Error \[TOOL_POLICY_DENIED\]: /);
    expect(noticeCount()).toBe(1);
    expect(() => JSON.parse(String(mockConsoleLog.mock.calls.at(-1)?.[0]))).not.toThrow();
    expect(mockConsoleLog.mock.calls.map((c) => String(c[0])).join('\n')).not.toContain('Notice [antigravity]');
  });

  it('respond to antigravity (refused): exit 33, reason first, the notice once after it', async () => {
    mockRoutes([{ match: '/api/worktrees/wt-g/prompt-response', response: DENIED }]);
    const code = await runUntilExit(() => runRespond(['wt-g', 'yes', '--instance', 'antigravity']));
    expect(code).toBe(33);
    expect(stderrLines()[0]).toMatch(/^Error \[TOOL_POLICY_DENIED\]: /);
    expect(noticeCount()).toBe(1);
  });
});

describe('instances add --agent antigravity (#4438 G4)', () => {
  const ROSTER = { id: 'wt1', name: 'main', agentInstances: [{ id: 'claude', cliTool: 'claude', alias: 'Claude', order: 0 }] };

  it('says the notice on stderr once, and --json stdout still parses (G4-a, G4-d)', async () => {
    mockRoutes([
      { match: '/api/worktrees/wt1', method: 'GET', response: { status: 200, data: ROSTER } },
      { match: '/api/worktrees/wt1', method: 'PATCH', response: { status: 200, data: { id: 'wt1', agentInstances: [] } } },
    ]);
    await runUntilExit(() => runInstances(['wt1', 'add', '--agent', 'antigravity', '--json']));
    expect(noticeCount()).toBe(1);
    expect(stderrLines().join('\n')).toContain(ANTIGRAVITY_TERMS_URL);
    expect(stderrLines().join('\n')).toContain(ANTIGRAVITY_FAQ_URL);
    const stdout = mockConsoleLog.mock.calls.map((c) => String(c[0])).join('\n');
    expect(() => JSON.parse(stdout)).not.toThrow();
    expect(stdout).not.toContain('Notice');
    mockConsoleError.mockClear();
    mockConsoleLog.mockClear();
    await runUntilExit(() => runInstances(['wt1', 'add', '--agent', 'antigravity', '--id', 'antigravity-2']));
    expect(noticeCount()).toBe(0);
  });

  it('G4-c: adding codex says nothing and leaves no record', async () => {
    mockRoutes([
      { match: '/api/worktrees/wt1', method: 'GET', response: { status: 200, data: ROSTER } },
      { match: '/api/worktrees/wt1', method: 'PATCH', response: { status: 200, data: { id: 'wt1', agentInstances: [] } } },
    ]);
    await runUntilExit(() => runInstances(['wt1', 'add', '--agent', 'codex']));
    expect(noticeCount()).toBe(0);
    expect(recorded()).toBe(false);
  });
});
