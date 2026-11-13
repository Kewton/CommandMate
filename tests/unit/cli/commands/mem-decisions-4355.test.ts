/**
 * `commandmate mem decisions` as a command (Issue #4355, design §3.4・§4.3): the target it
 * reads, its refusals and exit codes, GET only, the terminal's controls escaped, and the
 * person's decision that the CLI reads only (no way to approve).
 *
 * The server is a fetch fake; what the routes really answer is fixed by
 * `tests/unit/app/api/mem/mem-decisions-read-4355.test.ts`.
 *
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { restoreFetch } from '../../../helpers/mock-api';
import { createMemCommand } from '../../../../src/cli/commands/mem';
import { escapeTerminal, operationNeedsReconcile } from '../../../../src/cli/commands/mem-decisions';
import { PROMOTE_REFERENCE_NOTICE } from '../../../../src/lib/promote/model';

const SESSION_ENV = ['TMUX', 'TMUX_PANE', 'CM_WORKTREE_ID', 'CM_AGENT_WORKTREE_ID', 'CM_INSTANCE_ID', 'CM_AGENT_INSTANCE_ID', 'CM_CLI_TOOL', 'CM_AGENT_TOOL'];
let saved: Record<string, string | undefined>;
let exitCode: number | undefined;
let stderr: string[];
let stdout: string[];
let requests: Array<{ url: string; method: string }>;

beforeEach(() => {
  saved = {};
  for (const name of [...SESSION_ENV, 'CM_PORT']) {
    saved[name] = process.env[name];
    delete process.env[name];
  }
  process.env.CM_PORT = '39421';
  exitCode = undefined;
  stderr = [];
  stdout = [];
  requests = [];
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    exitCode = code;
    throw new Error('process.exit');
  }) as never);
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => void stderr.push(args.join(' ')));
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => void stdout.push(args.join(' ')));
});

afterEach(() => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  restoreFetch();
  vi.restoreAllMocks();
});

/** A fake server: the first route whose pattern matches the path answers. */
function serve(routes: Array<[RegExp, number, unknown]>): void {
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    requests.push({ url, method: init?.method ?? 'GET' });
    const route = routes.find(([pattern]) => pattern.test(new URL(url).pathname));
    const [, status, body] = route ?? [/./, 404, { ok: false, code: 'not_found', message: 'Not found' }];
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
}

async function run(...argv: string[]): Promise<number | undefined> {
  try {
    await createMemCommand().parseAsync(['node', 'mem', ...argv]);
  } catch (error) {
    if ((error as Error).message !== 'process.exit') throw error;
  }
  return exitCode;
}

const owner = { repositoryId: 'r', branch: 'feature/x', worktreeId: 'w', worktreeIncarnation: 'i', instanceId: 'claude', cliToolId: 'claude', incarnation: 'n', sessionGeneration: null };
const item = (extra: Record<string, unknown> = {}) => ({
  id: 'd1',
  kind: 'decision',
  state: 'open',
  text: 'A にする',
  promoteTo: 'issue:#4355',
  quote: null,
  quoteAt: null,
  owner,
  createdBy: 'agent',
  updatedBy: 'agent',
  version: 1,
  createdAt: '2026-11-13T00:00:00.000Z',
  updatedAt: '2026-11-13T00:00:00.000Z',
  closedAt: null,
  closeReason: null,
  stale: false,
  frozen: false,
  ...extra,
});
const LIST = { ok: true, mode: 'on', branch: 'feature/x', counts: { mode: 'on', approvable: true, open: 1, recorded: 0 }, decisions: [{ item: item(), unreflected: false, operations: [] }], unresolved: [], worktrees: [] };
const MODE = { ok: true, mode: 'on', source: { level: 'repository' }, target: { via: 'worktree', worktreeId: 'w' }, branch: 'feature/x', detached: false, features: {}, repositoryIds: ['r'] };

describe('commandmate mem decisions', () => {
  it('reads only: decisions is a sub-command of mem, and nothing named approve, promote, confirm or reconcile is', () => {
    const names = createMemCommand().commands.map((command) => command.name());
    expect(names).toContain('decisions');
    expect(names.filter((name) => /^(promote|approve|confirm-reflected|reconcile)/.test(name))).toEqual([]);
  });

  it('lists through --repository --branch with GET only, and prints the counts last', async () => {
    serve([[/\/api\/repositories\/r\/mem\/decisions$/, 200, LIST]]);
    expect(await run('decisions', '--repository', 'r', '--branch', 'feature/x')).toBe(0);
    expect(requests).toEqual([{ url: expect.stringContaining('/api/repositories/r/mem/decisions?branch=feature%2Fx'), method: 'GET' }]);
    expect(stdout[0]).toBe('mode: on  branch: feature/x  repository: r');
    expect(stdout).toContain('d1 open v1 by=agent(claude) to=issue:#4355 quote=- approvals=0');
    expect(stdout.at(-1)).toBe('counts (before --pending): open=1 recorded=0 approvable=yes');
  });

  it('through a worktree, reads its repository and branch from the mode first (GET), then the list', async () => {
    serve([
      [/\/api\/worktrees\/w\/mem\/mode$/, 200, MODE],
      [/\/api\/repositories\/r\/mem\/decisions$/, 200, LIST],
    ]);
    expect(await run('decisions', '--worktree', 'w', '--json')).toBe(0);
    expect(requests.map((request) => `${request.method} ${new URL(request.url).pathname}`)).toEqual(['GET /api/worktrees/w/mem/mode', 'GET /api/repositories/r/mem/decisions']);
    expect(JSON.parse(stdout.join('\n'))).toMatchObject({ schema: 1, repositoryId: 'r', branch: 'feature/x', counts: { open: 1, recorded: 0, approvable: true } });
  });

  it('a detached worktree names no branch → branch_unresolved (52), the list is not asked', async () => {
    serve([[/\/mem\/mode$/, 200, { ...MODE, branch: null, detached: true }]]);
    expect(await run('decisions', '--worktree', 'w')).toBe(52);
    expect(requests).toHaveLength(1);
  });

  it.each([
    [['decisions'], 'target_required'],
    [['decisions', '--repository', 'r'], 'target_required'],
    [['decisions', 'd1', '--pending', '--repository', 'r'], 'invalid_request'],
    [['decisions', '--effect', 'spec', '--repository', 'r', '--branch', 'b'], 'invalid_request'],
  ])('%j → %s (exit 2), nothing sent', async (argv, code) => {
    serve([]);
    expect(await run(...argv)).toBe(2);
    expect(requests).toEqual([]);
    expect(stderr.join('\n')).toContain(code);
  });

  it('the diff says first that it is a reference and cannot be approved; --repository needs no branch', async () => {
    const view = {
      ok: true,
      reference: true,
      approvable: false,
      notice: PROMOTE_REFERENCE_NOTICE,
      repositoryId: 'r',
      item: { id: 'd1', version: 1, state: 'open', branch: 'feature/x' },
      mode: 'on',
      effect: 'spec',
      quoteOrigin: 'none',
      destination: null,
      body: 'line 1\n\u001b]0;title\u0007 \r end',
      bodySha256: 'a'.repeat(64),
      invisibleReplaced: false,
      drawnAt: '2026-11-13T00:00:00.000Z',
    };
    serve([[/\/api\/repositories\/r\/mem\/decisions\/d1\/diff$/, 200, view]]);
    expect(await run('decisions', 'd1', '--repository', 'r', '--effect', 'record_only')).toBe(0);
    expect(requests).toEqual([{ url: expect.stringMatching(/\/api\/repositories\/r\/mem\/decisions\/d1\/diff\?effect=record_only$/), method: 'GET' }]);
    expect(stdout[0]).toBe('REFERENCE ONLY — cannot be approved; approve on the screen');
    const printed = stdout.join('\n');
    expect(printed).toContain('line 1\n\\x1b]0;title\\x07 \\x0d end');
    expect(printed).not.toMatch(/[\u001b\u0007\r]/);
  });

  it.each([
    [404, { ok: false, code: 'not_found', message: 'Not found' }, 52],
    [422, { ok: false, code: 'secret_like', message: 'x', field: 'quote' }, 2],
  ])('the diff answered %i → exit %i, stderr names the code and the field only', async (status, body, exit) => {
    serve([[/\/diff$/, status, body]]);
    expect(await run('decisions', 'd1', '--repository', 'r')).toBe(exit);
    expect(stderr.join('\n')).toContain(String(body.code));
    if ('field' in body) expect(stderr.join('\n')).toContain(`field=${body.field}`);
  });

  it('escapes C0, C1, DEL and the bidi / invisible code points; keeps a newline only when asked', () => {
    expect(escapeTerminal('a\u001b[31mb\u009bc\u007fd\u202ee\u2028f\n')).toBe('a\\x1b[31mb\\x9bc\\x7fd\\u202ee\\u2028f\\x0a');
    expect(escapeTerminal('a\nb\r', true)).toBe('a\nb\\x0d');
    expect(escapeTerminal('普通の文字 ok')).toBe('普通の文字 ok');
  });

  it('I9: an operation in progress, unknown or with its move pending needs a reconcile; failed and settled ones do not', () => {
    expect(operationNeedsReconcile({ state: 'unknown', transitionPending: false })).toBe(true);
    expect(operationNeedsReconcile({ state: 'in_flight', transitionPending: false })).toBe(true);
    expect(operationNeedsReconcile({ state: 'approved', transitionPending: false })).toBe(true);
    expect(operationNeedsReconcile({ state: 'succeeded', transitionPending: true })).toBe(true);
    expect(operationNeedsReconcile({ state: 'succeeded', transitionPending: false })).toBe(false);
    expect(operationNeedsReconcile({ state: 'failed', transitionPending: false })).toBe(false);
    expect(operationNeedsReconcile({ state: 'abandoned', transitionPending: false })).toBe(false);
  });

  it('I1: the reading lives apart from mem.ts, with no write method, no approve sub-command and no mark header', () => {
    const source = readFileSync(path.join(process.cwd(), 'src/cli/commands/mem-decisions.ts'), 'utf8');
    expect(source).toMatch(/mem\/decisions/);
    expect(source).not.toMatch(/\.(put|delete|patch|post)\s*[<(]|method:\s*['"](?:POST|PUT|PATCH|DELETE)/i);
    expect(source).not.toMatch(/x-commandmate-client/i);
    expect(source).not.toMatch(/\.command\(\s*['"](?:promote|approve|confirm-reflected|reconcile)\b/);
    // (positive control) mem.ts has the item writes: the GET of the decisions would not be allowed there.
    const mem = readFileSync(path.join(process.cwd(), 'src/cli/commands/mem.ts'), 'utf8');
    expect(mem).toMatch(/\.post\s*[<(]/);
    expect(mem).not.toMatch(/mem\/decisions/);
  });
});
