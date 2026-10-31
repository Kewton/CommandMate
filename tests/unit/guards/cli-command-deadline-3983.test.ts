/**
 * `--timeout` reaches every read of `wait` / `ask` / `verify`, and no catch on
 * the way turns a deadline into a degraded answer (Issue #3983, recurrence
 * prevention stage 1).
 *
 * ## What happened
 *
 * `--timeout` was opt-in per request: the poll's reads were bounded (#3974),
 * the reads before it were not, and the helpers in between caught every error
 * as "could not read X; carrying on". A server that stopped answering held
 * `wait --timeout 60 --verify` for undici's ~300 s, and a deadline that did
 * fire came out as a Note and a wait past the deadline. Each fix added the
 * next missing site by hand, so the next helper was the next leak.
 *
 * ## What is checked
 *
 * (a) Dynamic: each command runs with `--timeout` over its main option
 *     combinations against a faked server, and every request it makes carries
 *     a signal, except the ones named below with the decision that keeps them
 *     unbounded. A new helper that reads with a plain client fails here.
 * (b) Static: every `catch` in the CLI modules those commands import (the ones
 *     that name `ApiClient`) either throws, rethrows a deadline, or hands the
 *     error to `handleCommandError` — or is on the allowlist with a reason.
 *
 * Widening either list is allowed; each entry states why the request or the
 * catch is outside the deadline.
 */

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import ts from 'typescript';
import { restoreFetch } from '../../helpers/mock-api';
import {
  RELAY_CREATED,
  frame,
  mockServer,
  requestsMade,
  start,
  verifyRun,
} from '../cli/commands/command-deadline-server';

const REPO_ROOT = process.cwd();

// ---------------------------------------------------------------------------
// (a) Every request carries the deadline's signal
// ---------------------------------------------------------------------------

/** Requests that are deliberately not cut by `--timeout`. */
const UNBOUNDED_BY_DESIGN: readonly { request: RegExp; commands: readonly string[]; why: string }[] = [
  {
    request: /^POST \/api\/worktrees\/[^/]+\/send$/,
    commands: ['ask'],
    why: 'Issue #3983 decision 5: aborting the send would leave "was it sent?" unanswered; past the deadline ask exits 124 saying it was sent.',
  },
  {
    request: /^POST \/api\/relays$/,
    commands: ['ask'],
    why: 'ask --async opens the relay before the send; it creates state like the send does, so it is not cut either (review P2-2).',
  },
  {
    request: /^POST \/api\/worktrees\/[^/]+\/verify$|^GET \/api\/worktrees\/[^/]+\/verify\/runs\/\d+$/,
    commands: ['wait'],
    why: 'Issue #3983 decision 3: the verification after a detected completion (wait --verify / --require-work) is not part of --timeout.',
  },
];

const SERVER = {
  '/tasks': { tasks: [{ id: 'task-1', status: 'running' }] },
  '/current-output': frame,
  '/messages': [],
  'POST /capture': { output: 'the pane reply' },
  'POST /send': { id: 'm1', timestamp: '2026-10-30T00:00:00.000Z' },
  'POST /api/relays': RELAY_CREATED,
  'POST /verify': { status: 202, data: { runId: 7 } },
  '/verify/runs/7': verifyRun('passed'),
};

const COMBINATIONS: readonly { command: 'wait' | 'ask' | 'verify'; args: string[] }[] = [
  { command: 'wait', args: ['wt1', '--timeout', '30'] },
  { command: 'wait', args: ['wt1', '--timeout', '30', '--instance', 'Reviewer'] },
  { command: 'wait', args: ['wt1', '--timeout', '30', '--verify'] },
  { command: 'wait', args: ['wt1', '--timeout', '30', '--require-work'] },
  { command: 'ask', args: ['wt1', 'hello', '--timeout', '30', '--instance', 'Reviewer'] },
  { command: 'ask', args: ['wt1', 'hello', '--timeout', '30', '--agent', 'codex'] },
  { command: 'ask', args: ['wt1', 'hello', '--timeout', '30', '--instance', 'Reviewer', '--async', '--reply-to', 'wt0@claude'] },
  { command: 'verify', args: ['wt1', '--timeout', '30'] },
];

/** The requests of one run that carried no signal and are not exempt for `command`. */
async function unboundedRequests(command: 'wait' | 'ask' | 'verify', args: string[]): Promise<string[]> {
  mockServer(SERVER);
  const run = await start(command, args);
  await vi.advanceTimersByTimeAsync(60_000);
  await run.pending;
  return requestsMade()
    .filter(r => !r.signal)
    .map(r => r.request.replace(/\?.*$/, ''))
    .filter(request => !UNBOUNDED_BY_DESIGN.some(e => e.commands.includes(command) && e.request.test(request)));
}

describe('[#3983] (a) every request of wait / ask / verify --timeout carries the deadline', () => {
  const mockExit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubEnv('CM_PORT', '3999');
  });

  afterEach(() => {
    restoreFetch();
    mockExit.mockClear();
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it.each(COMBINATIONS)('$command $args', async ({ command, args }) => {
    expect(await unboundedRequests(command, args)).toEqual([]);
    // The run got as far as it should: a run that made no request passes vacuously.
    expect(requestsMade().length).toBeGreaterThan(0);
    expect(mockExit.mock.calls[0]?.[0]).toBe(0);
  });

  it('positive control: without --timeout the same run is reported', async () => {
    expect(await unboundedRequests('verify', ['wt1'])).toEqual([
      'POST /api/worktrees/wt1/verify',
      'GET /api/worktrees/wt1/verify/runs/7',
    ]);
  });

  it.each(UNBOUNDED_BY_DESIGN)('exemption $request states its reason', ({ why }) => {
    expect(why.length).toBeGreaterThan(60);
  });
});

// ---------------------------------------------------------------------------
// (b) No catch on the way swallows a deadline
// ---------------------------------------------------------------------------

const COMMAND_FILES = ['src/cli/commands/wait.ts', 'src/cli/commands/ask.ts', 'src/cli/commands/verify.ts'];

/** Catches that may end in a degraded answer, by `file` and enclosing function. */
const ALLOWED_CATCHES: readonly { file: string; fn: string; why: string }[] = [
  {
    file: 'src/cli/commands/capture.ts',
    fn: 'readSqueezedPaneTail',
    why: 'ask reads the pane after completion with the reply-grace client; a pane it cannot read is the fallback working as designed, not a lost --timeout.',
  },
  {
    file: 'src/cli/commands/message-dispatch.ts',
    fn: 'resolveBoundSendOutcome',
    why: 'Runs after a failed send with the plain client (the send is outside the deadline); an unanswerable relay lookup leaves the relay as it is.',
  },
  {
    file: 'src/cli/commands/relays.ts',
    fn: 'cancelRelayQuietly',
    why: 'Best-effort withdrawal after a failed send, with the plain client; the relay then expires on its own.',
  },
  {
    file: 'src/cli/commands/wait-verify.ts',
    fn: 'verifyAfterWait',
    why: 'The verification after a detected completion is not part of --timeout (decision 3) and runs with the plain client.',
  },
  {
    file: 'src/cli/commands/wait-turn-boundary.ts',
    fn: 'readNewestPromptAt',
    why: 'A poll read bounded by its own signal (readWithinDeadlines, #3974); the poll checks --timeout itself right after the tick.',
  },
  {
    file: 'src/cli/commands/instances.ts',
    fn: 'deriveInstanceSession',
    why: 'Parses a session name; no request. Only `instances` listing uses it, not wait / ask / verify.',
  },
  {
    file: 'src/cli/commands/instances.ts',
    fn: 'fetchOpencodeSessions',
    why: 'Only the `instances` listing reads it, with a client that has no deadline; wait / ask / verify import the module for resolveInstanceTarget.',
  },
  {
    file: 'src/cli/commands/instances.ts',
    fn: 'fetchArmedAutoYes',
    why: 'Only the `instances` listing reads it, with a client that has no deadline; wait / ask / verify import the module for resolveInstanceTarget.',
  },
  {
    file: 'src/cli/commands/instances.ts',
    fn: 'removeInstance',
    why: '`instances remove` only: killing the session is best effort before the roster row goes. Not reached from wait / ask / verify.',
  },
  {
    file: 'src/cli/commands/instances.ts',
    fn: 'recordSessionKill',
    why: 'Issue #3993: the catch wraps process.cwd() only, after the kill response is already in hand; no request, so no deadline can reach it. Only `instances kill` / `remove --kill` call it.',
  },
  {
    file: 'src/cli/commands/whoami.ts',
    fn: 'describeServerMismatch',
    why: 'A hint for the `instances` 404 message, with that command\'s plain client. Not reached from wait / ask / verify.',
  },
  {
    file: 'src/cli/commands/whoami.ts',
    fn: 'readOwnRosterEntry',
    why: 'The `whoami` command\'s own roster line, with its plain client. ask --async reaches whoami only for resolveSessionIdentity.',
  },
  {
    file: 'src/cli/utils/api-client.ts',
    fn: 'rawGet',
    why: 'The deadline itself: deadline.classify turns the abort it caused into DeadlineExceededError and passes any other error through unchanged.',
  },
  {
    file: 'src/cli/utils/api-client.ts',
    fn: 'read',
    why: 'boundBodyReads, the body-read half of the deadline: deadline.classify marks the abort it caused and passes any other error through unchanged.',
  },
  {
    file: 'src/cli/utils/api-client.ts',
    fn: 'isLocalhost',
    why: 'Parses the base URL; no request, so no deadline can reach it.',
  },
  {
    file: 'src/cli/utils/api-client.ts',
    fn: 'readErrorPayload',
    why: 'Reads an error body inside the request\'s own bounded region: a body that stalls is ended by that request\'s deadline race, which rejects first.',
  },
  {
    file: 'src/cli/utils/api-client.ts',
    fn: 'run',
    why: 'The no-op handler on a promise that has already lost the deadline race, so its later rejection is not unhandled; the race itself rejects with the deadline.',
  },
  {
    file: 'src/cli/utils/api-client.ts',
    fn: 'fetchDaemonVersion',
    why: 'Advisory version check (warnIfVersionSkew), not called by wait / ask / verify.',
  },
  {
    file: 'src/cli/utils/server-capabilities.ts',
    fn: 'serverReportsPromptAnswerReason',
    why: 'Issue #3982: only `respond` calls it, after a failed answer, with its plain client (respond has no --timeout), so no deadline can reach it; false keeps the pre-#3982 reading.',
  },
  {
    file: 'src/cli/utils/server-capabilities.ts',
    fn: 'isRealNotFoundBody',
    why: 'JSON.parse of a body already read; no request, so no deadline can reach it.',
  },
];

/**
 * A catch passes when it looks at the deadline, hands the error to
 * handleCommandError, or rethrows the caught error itself. Throwing a NEW error
 * does not pass: that is how a deadline turns into "server unreachable".
 */
function passes(body: ts.Node, source: ts.SourceFile, caught: string | undefined): boolean {
  const bodyText = body.getText(source);
  if (/\brethrowIfDeadlineExceeded\s*\(|\bhandleCommandError\s*\(/.test(bodyText)) return true;
  if (caught !== undefined && new RegExp(`\\bthrow\\s+${caught}\\s*;`).test(bodyText)) return true;
  return handlesDeadlineBranch(body, source);
}

/**
 * `if (isDeadlineExceeded(…))` whose branch leaves the catch (return / throw).
 * An empty or falling-through branch is the swallowing the guard is for.
 */
function handlesDeadlineBranch(body: ts.Node, source: ts.SourceFile): boolean {
  let found = false;
  let allLeave = true;
  const visit = (node: ts.Node): void => {
    if (ts.isIfStatement(node) && /\bisDeadlineExceeded\s*\(/.test(node.expression.getText(source))) {
      found = true;
      if (!/\b(return|throw)\b/.test(node.thenStatement.getText(source))) allLeave = false;
    }
    ts.forEachChild(node, visit);
  };
  visit(body);
  return found && allLeave;
}

/** CLI modules the three commands import at runtime (type-only imports left out). */
function reachableModules(): string[] {
  const seen = new Set<string>();
  const queue = [...COMMAND_FILES];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    const source = ts.createSourceFile(file, readFileSync(join(REPO_ROOT, file), 'utf-8'), ts.ScriptTarget.Latest, true);
    source.forEachChild(node => {
      if (!(ts.isImportDeclaration(node) || ts.isExportDeclaration(node))) return;
      if (!node.moduleSpecifier || !ts.isStringLiteral(node.moduleSpecifier)) return;
      if (ts.isImportDeclaration(node) && node.importClause?.isTypeOnly) return;
      if (ts.isExportDeclaration(node) && node.isTypeOnly) return;
      const spec = node.moduleSpecifier.text;
      if (!spec.startsWith('.')) return;
      const base = normalize(join(dirname(file), spec));
      const found = [`${base}.ts`, `${base}/index.ts`].find(c => c.startsWith('src/cli/') && existsSync(join(REPO_ROOT, c)));
      if (found) queue.push(found);
    });
  }
  return [...seen].sort();
}

function enclosingFunction(node: ts.Node): string {
  for (let p: ts.Node | undefined = node.parent; p; p = p.parent) {
    if ((ts.isFunctionDeclaration(p) || ts.isMethodDeclaration(p)) && p.name && ts.isIdentifier(p.name)) return p.name.text;
    if (ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) return p.name.text;
  }
  return '<module>';
}

/** `fn:line` of every catch in `text` that does not pass. Exported shape kept small for the mutation tests. */
function swallowingCatches(file: string, text: string): { fn: string; line: number }[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const found: { fn: string; line: number }[] = [];
  const visit = (node: ts.Node): void => {
    let body: ts.Node | undefined;
    let caught: string | undefined;
    if (ts.isCatchClause(node)) {
      body = node.block;
      const binding = node.variableDeclaration?.name;
      caught = binding && ts.isIdentifier(binding) ? binding.text : undefined;
    } else if (
      ts.isCallExpression(node)
      && ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === 'catch'
      && node.arguments.length > 0
    ) {
      body = node.arguments[0];
      const handler = node.arguments[0];
      const param = (ts.isArrowFunction(handler) || ts.isFunctionExpression(handler)) ? handler.parameters[0]?.name : undefined;
      caught = param && ts.isIdentifier(param) ? param.text : undefined;
    }
    if (body && !passes(body, source, caught)) {
      found.push({ fn: enclosingFunction(node), line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1 });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

const isAllowed = (file: string, fn: string): boolean => ALLOWED_CATCHES.some(a => a.file === file && a.fn === fn);

/** The modules that talk to the server: they name ApiClient. */
function apiModules(): string[] {
  return reachableModules().filter(f => /\bApiClient\b/.test(readFileSync(join(REPO_ROOT, f), 'utf-8')));
}

describe('[#3983] (b) no catch reachable from wait / ask / verify swallows a deadline', () => {
  it('every swallowing catch is on the allowlist', () => {
    const offenders = apiModules().flatMap(file =>
      swallowingCatches(file, readFileSync(join(REPO_ROOT, file), 'utf-8'))
        .filter(c => !isAllowed(file, c.fn))
        .map(c => `${file}:${c.line} (${c.fn})`),
    );
    expect(offenders).toEqual([]);
  });

  it('the scan covers the helpers the issue names', () => {
    expect(apiModules()).toEqual(expect.arrayContaining([
      'src/cli/commands/wait-instance.ts',
      'src/cli/commands/wait-verify.ts',
      'src/cli/commands/relays.ts',
      'src/cli/commands/whoami.ts',
      'src/cli/utils/reply-ledger.ts',
      'src/cli/utils/server-capabilities.ts',
      'src/cli/utils/session-target.ts',
      'src/cli/utils/verify-runner.ts',
    ]));
  });

  it.each(ALLOWED_CATCHES)('$file $fn: still a swallowing catch, with a reason', ({ file, fn, why }) => {
    expect(why.length).toBeGreaterThan(60);
    // A stale entry would quietly allow the next catch written in that function.
    expect(swallowingCatches(file, readFileSync(join(REPO_ROOT, file), 'utf-8')).map(c => c.fn)).toContain(fn);
  });

  // Mutation: dropping any one rethrow must make the scan fail.
  const rethrowSites = (): { file: string; index: number }[] =>
    apiModules().flatMap(file => {
      const count = readFileSync(join(REPO_ROOT, file), 'utf-8').split('rethrowIfDeadlineExceeded(error);').length - 1;
      return Array.from({ length: count }, (_, index) => ({ file, index }));
    });

  it('positive: removing any one rethrowIfDeadlineExceeded makes a new offender', () => {
    const sites = rethrowSites();
    expect(sites.length).toBeGreaterThanOrEqual(9);
    for (const { file, index } of sites) {
      const text = readFileSync(join(REPO_ROOT, file), 'utf-8');
      const parts = text.split('rethrowIfDeadlineExceeded(error);');
      const mutated = parts.slice(0, index + 1).join('rethrowIfDeadlineExceeded(error);') + parts.slice(index + 1).join('rethrowIfDeadlineExceeded(error);');
      const before = swallowingCatches(file, text).filter(c => !isAllowed(file, c.fn)).length;
      const after = swallowingCatches(file, mutated).filter(c => !isAllowed(file, c.fn)).length;
      expect(after, `${file} rethrow #${index + 1}`).toBe(before + 1);
    }
  });

  it('positive: an `if (isDeadlineExceeded(…))` branch that does not leave the catch is an offender', () => {
    const swallow = `async function f(c) {
  try { await c.get('/x'); } catch (error) { if (isDeadlineExceeded(error)) {} return null; }
}`;
    const leave = swallow.replace('{} return null;', '{ return 124; } return null;');
    expect(swallowingCatches('mutant.ts', swallow)).toEqual([{ fn: 'f', line: 2 }]);
    expect(swallowingCatches('mutant.ts', leave)).toEqual([]);
  });

  it('the scanned files are tracked sources', () => {
    const tracked = new Set(
      execFileSync('git', ['ls-files', 'src/cli'], { cwd: REPO_ROOT, encoding: 'utf-8' }).split('\n'),
    );
    for (const file of apiModules()) expect(tracked.has(file), file).toBe(true);
  });
});
