/**
 * Issue #4437 PR2: who is sending, as the CLI reads it (design §1.2), and where it
 * goes on the request.
 *
 * I4: a person typing in a terminal is `terminal` — and only that combination is.
 * I5: a CommandMate session, a Schedule run, an agent, or a caller without a
 *     terminal is never `terminal`; what cannot be read is `unknown`.
 * No file is read (no credentials) and tmux is asked only inside tmux.
 *
 * @vitest-environment node
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  AGENT_ENV_MARKERS,
  SESSION_ENV_VARS,
  isSendOriginPath,
  resolveSendOrigin,
  withSendOrigin,
  type CliSendOrigin,
} from '../../../../src/cli/utils/send-origin';
import { RUN_ORIGIN_ENV, TOOL_POLICY_TABLE } from '../../../../src/lib/tool-policy/policy';

afterEach(() => {
  vi.restoreAllMocks();
});

const SESSION_NAME = 'mcbd-e7375aa6-claude-mycodebranchdesk-5';
const LEGACY_SESSION_NAME = 'mcbd-codex-commandmate-issue-4437-pr2';

function resolve(env: Record<string, string | undefined>, stdinIsTTY: boolean | undefined, tmuxName: string | null = null) {
  const readTmuxSessionName = vi.fn(() => tmuxName);
  const result = resolveSendOrigin({ env, stdinIsTTY, readTmuxSessionName });
  return { ...result, readTmuxSessionName };
}

describe('resolveSendOrigin: the order of design §1.2 (Issue #4437)', () => {
  it('1. CM_RUN_ORIGIN=schedule is schedule, before any session marker', () => {
    const r = resolve({ [RUN_ORIGIN_ENV]: 'schedule', CM_AGENT_TOOL: 'codex', TMUX: '/tmp/t' }, true, SESSION_NAME);
    expect(r).toMatchObject({ origin: 'schedule', evidence: `env:${RUN_ORIGIN_ENV}` });
    expect(r.readTmuxSessionName).not.toHaveBeenCalled();
  });

  it('1. any other CM_RUN_ORIGIN is a launcher this CLI does not know: unknown, even on a terminal', () => {
    expect(resolve({ [RUN_ORIGIN_ENV]: 'cron' }, true).origin).toBe('unknown');
  });

  it.each(SESSION_ENV_VARS.map((name) => [name]))('2. %s set is session, even on a terminal, without asking tmux', (name) => {
    const r = resolve({ [name]: 'x', TMUX: '/tmp/t' }, true, 'main');
    expect(r).toMatchObject({ origin: 'session', evidence: `env:${name}` });
    expect(r.readTmuxSessionName).not.toHaveBeenCalled();
  });

  it('2. a session variable of blanks is not set', () => {
    expect(resolve({ CM_WORKTREE_ID: '  ' }, true).origin).toBe('terminal');
  });

  it.each([[SESSION_NAME], [LEGACY_SESSION_NAME]])('3. inside tmux session %s (a name CommandMate gave): session', (name) => {
    const r = resolve({ TMUX: '/tmp/t' }, true, name);
    expect(r).toMatchObject({ origin: 'session', evidence: `tmux:${name}` });
    expect(r.readTmuxSessionName).toHaveBeenCalledTimes(1);
  });

  it('4. inside tmux whose name cannot be read: unknown, even on a terminal', () => {
    expect(resolve({ TMUX: '/tmp/t' }, true, null)).toMatchObject({ origin: 'unknown', evidence: 'tmux:unreadable' });
  });

  it('a person\'s own tmux (a name of their own) reads on: terminal on a terminal, unknown without one', () => {
    expect(resolve({ TMUX: '/tmp/t' }, true, 'main').origin).toBe('terminal');
    expect(resolve({ TMUX: '/tmp/t' }, false, 'main').origin).toBe('unknown');
  });

  it.each(AGENT_ENV_MARKERS.map((name) => [name]))('5. %s set is agent, even on a terminal', (name) => {
    expect(resolve({ [name]: '1' }, true)).toMatchObject({ origin: 'agent', evidence: `env:${name}` });
  });

  it.each([[false], [undefined]])('6. stdin.isTTY=%s is unknown (cron, a pipe, an agent\'s shell)', (tty) => {
    expect(resolve({}, tty)).toMatchObject({ origin: 'unknown', evidence: 'no-tty' });
  });

  it('7. a terminal with nothing else is terminal (I4)', () => {
    const r = resolve({}, true);
    expect(r).toMatchObject({ origin: 'terminal', evidence: 'tty' });
    expect(r.readTmuxSessionName).not.toHaveBeenCalled();
  });

  it('evidence is cut to 128 characters', () => {
    const long = `mcbd-claude-${'w'.repeat(200)}`;
    expect(resolve({ TMUX: '/tmp/t' }, true, long).evidence.length).toBe(128);
  });
});

describe('I4 / I5: terminal is exactly "a person in a terminal" (every combination)', () => {
  const runOrigins = [undefined, 'schedule', 'other'] as const;
  const sessionVars = [undefined, 'CM_AGENT_INSTANCE_ID'] as const;
  const tmuxStates = ['none', 'commandmate', 'own', 'unreadable'] as const;
  const agentMarkers = [false, true] as const;
  const ttys = [true, false, undefined] as const;

  /** The table of §1.2, written out independently of the implementation. */
  function expected(c: {
    runOrigin: (typeof runOrigins)[number];
    sessionVar: (typeof sessionVars)[number];
    tmux: (typeof tmuxStates)[number];
    agent: boolean;
    tty: boolean | undefined;
  }): CliSendOrigin {
    if (c.runOrigin === 'schedule') return 'schedule';
    if (c.runOrigin !== undefined) return 'unknown';
    if (c.sessionVar) return 'session';
    if (c.tmux === 'commandmate') return 'session';
    if (c.tmux === 'unreadable') return 'unknown';
    if (c.agent) return 'agent';
    if (c.tty !== true) return 'unknown';
    return 'terminal';
  }

  const cases = runOrigins.flatMap((runOrigin) =>
    sessionVars.flatMap((sessionVar) =>
      tmuxStates.flatMap((tmux) =>
        agentMarkers.flatMap((agent) => ttys.map((tty) => ({ runOrigin, sessionVar, tmux, agent, tty }))),
      ),
    ),
  );

  it(`all ${cases.length} combinations match the table, and only one is terminal`, () => {
    let terminals = 0;
    for (const c of cases) {
      const env: Record<string, string | undefined> = {};
      if (c.runOrigin) env[RUN_ORIGIN_ENV] = c.runOrigin;
      if (c.sessionVar) env[c.sessionVar] = 'wt';
      if (c.tmux !== 'none') env.TMUX = '/tmp/tmux-501/default,1,0';
      if (c.agent) env.CLAUDECODE = '1';
      const name = c.tmux === 'commandmate' ? SESSION_NAME : c.tmux === 'own' ? 'work' : null;
      const got = resolve(env, c.tty, name).origin;
      expect({ ...c, got }).toEqual({ ...c, got: expected(c) });
      if (got === 'terminal') terminals += 1;
    }
    // runOrigin none × no session var × (no tmux | own tmux) × no agent × tty=true
    expect(terminals).toBe(2);
  });
});

describe('reads no file and no credentials (Issue #4437, #4439)', () => {
  it('resolving touches no fs function', () => {
    const spies = (['readFileSync', 'existsSync', 'readdirSync', 'statSync', 'openSync', 'accessSync'] as const)
      .map((name) => vi.spyOn(fs, name));
    for (const tty of [true, false]) {
      resolve({ TMUX: '/tmp/t', CLAUDECODE: '1' }, tty, 'main');
      resolve({}, tty);
    }
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });

  it('the module imports only child_process (for tmux), the policy constants, the session-name parser and the CLI\'s own client', () => {
    const source = fs.readFileSync(path.join(__dirname, '../../../../src/cli/utils/send-origin.ts'), 'utf-8');
    const imports = [...source.matchAll(/^import .* from '([^']+)';$/gm)].map((m) => m[1]);
    expect(imports).toEqual([
      'child_process',
      '../../lib/tool-policy/policy',
      '../../lib/cli-tools/session-name',
      './api-client',
      './tool-policy-failure',
    ]);
    expect(source).not.toMatch(/readFile|homedir|require\(/);
  });
});

describe('withSendOrigin: the routes that type into a session carry it', () => {
  const fixed = () => ({ origin: 'session' as const, evidence: 'env:CM_AGENT_TOOL' });

  it.each([
    ['/api/worktrees/wt-1/send'],
    ['/api/worktrees/wt-1/respond'],
    ['/api/worktrees/wt-1/prompt-response'],
    ['/api/worktrees/wt-1/prompt-response/strict'],
  ])('%s: origin and originEvidence are added', (p) => {
    expect(isSendOriginPath(p)).toBe(true);
    expect(withSendOrigin(p, { content: 'x' }, fixed)).toEqual({
      content: 'x',
      origin: 'session',
      originEvidence: 'env:CM_AGENT_TOOL',
    });
  });

  it.each([
    ['/api/relays'],
    ['/api/worktrees/wt-1/tasks'],
    ['/api/worktrees/wt-1/auto-yes'],
    ['/api/worktrees/wt-1/sendx'],
    ['/api/worktrees/wt-1/send/more'],
    ['/api/worktrees/wt-1/interrupt'],
  ])('%s: the body is left as it is (negative control)', (p) => {
    const body = { content: 'x' };
    expect(isSendOriginPath(p)).toBe(false);
    expect(withSendOrigin(p, body, fixed)).toBe(body);
  });

  it.each([
    ['cliToolId', 'antigravity'],
    ['cliTool', 'antigravity'],
    ['cliToolId', 'a-tool-this-cli-does-not-know'],
  ])('a body naming %s=%s carries it (the table restricts it, or cannot say)', (key, tool) => {
    expect(withSendOrigin('/api/worktrees/wt/send', { content: 'x', [key]: tool }, fixed)).toMatchObject({
      origin: 'session',
      originEvidence: 'env:CM_AGENT_TOOL',
    });
  });

  it.each(Object.entries(TOOL_POLICY_TABLE).filter(([, r]) => r === null).map(([tool]) => [tool]))(
    'negative control — a body naming %s (never restricted) is byte for byte as it was',
    (tool) => {
      const send = { content: 'x', cliToolId: tool, instanceId: tool };
      const answer = { answer: '1', cliTool: tool };
      expect(withSendOrigin('/api/worktrees/wt/send', send, fixed)).toBe(send);
      expect(withSendOrigin('/api/worktrees/wt/prompt-response/strict', answer, fixed)).toBe(answer);
    },
  );

  it('a body that names its own origin is not overwritten', () => {
    const body = { answer: '1', origin: 'auto-yes-browser' };
    expect(withSendOrigin('/api/worktrees/wt/prompt-response', body, fixed)).toBe(body);
  });

  it('no body, or one that is not an object, is left alone', () => {
    expect(withSendOrigin('/api/worktrees/wt/send', undefined, fixed)).toBeUndefined();
    expect(withSendOrigin('/api/worktrees/wt/send', ['x'], fixed)).toEqual(['x']);
  });
});
