/**
 * Issue #4476: a starting message that could not be confirmed (exit 99) may sit
 * unsent in the composer — drawn late, its Enter lost — and every contract `send`
 * after it then refused `composer-not-empty` (#1880). Before the contract goes
 * out the launch now reads the composer (`capture --json`'s `composerState`):
 *
 *   - `empty` / `ghost`: the contract, as before;
 *   - the starting message (or a piece of it): one clear through the server's
 *     existing clear-composer route, then the contract only after two clean
 *     reads in a row — else the session is stopped and nothing is sent (1, or 42);
 *   - other text: not cleared, not sent, the session left running (1);
 *   - unreadable (`no_composer`, unknown state, wrong type): read again, clean
 *     twice in a row or stopped;
 *   - a process replaced since the model check: no clear, the role stop (44);
 *   - no `composerState` key (an older server): as before, with one log line.
 *
 * The starting message is never submitted again (I2). Exit 0 of the starting
 * message keeps the path it had. The CLI and the HTTP are fakes; everything on
 * disk is under os.tmpdir().
 *
 * @vitest-environment node
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import { execFile } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  COMPOSER_CLEAN_STREAK,
  COMPOSER_SETTLE_INTERVAL_SEC,
  COMPOSER_SETTLE_READS,
  CLEAR_COMPOSER_SCRIPT,
  EXIT_ROLE_CHANGED,
  EXIT_STOP_UNCONFIRMED,
  INIT_MESSAGE,
  composerReading,
  defaultClearComposer,
  isStartingMessageText,
  main,
} from '../../../../scripts/orchestrate/launch-worker.mjs';
import { defaultRun } from '../../../../scripts/orchestrate/wait-verify.mjs';

let tmp: string;
let worktree: string;
let runDir: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-launch-worker-4476-'));
  worktree = path.join(tmp, 'wt');
  runDir = path.join(tmp, 'run');
  fs.mkdirSync(worktree, { recursive: true });
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

const CONTENT = { composerState: 'content', composerText: INIT_MESSAGE };
const GHOST = { composerState: 'ghost', composerText: null };
const EMPTY = { composerState: 'empty', composerText: null };
const NO_COMPOSER = { composerState: 'no_composer', composerText: null };
/** A `capture --json` that fails (exit 1). */
const FAIL = { __fail: true };

type Answer = Record<string, unknown>;
type ClearInput = { run: unknown; cli: string; wt: string; instance: string; cliToolId: string };

/**
 * A CLI whose `capture --json` answers come from a list (the last repeating),
 * and whose clear (the fake HTTP) turns the answers to `afterClear` when given.
 */
function fakeCli({
  initExit = 99,
  captures = [GHOST] as Answer[],
  afterClear = null as Answer[] | null,
  stopFails = false,
  clearResult = { attempted: true, ok: true, detail: 'POST ok' },
} = {}) {
  const calls: string[][] = [];
  const clears: ClearInput[] = [];
  const sleeps: number[] = [];
  let answers = captures;
  let read = 0;
  let running = true;
  let initSent = false;
  const run = (command: string, args: string[]) => {
    calls.push([command, ...args]);
    const ok = (stdout = '') => ({ status: 0, stdout, stderr: '' });
    if (command === 'git') return ok();
    const verb = args[0];
    if (verb === 'reply') return ok(JSON.stringify({ instanceId: args[args.indexOf('--instance') + 1], cliToolId: 'claude', reply: null }));
    // Outside a CommandMate session: the clear must not depend on it.
    if (verb === 'whoami') return { status: 3, stdout: '', stderr: 'Error: not inside a CommandMate agent session.' };
    if (verb === 'capture') {
      const answer = answers[Math.min(read, answers.length - 1)];
      read += 1;
      if (answer === FAIL) return { status: 1, stdout: '', stderr: 'ECONNREFUSED' };
      return ok(JSON.stringify({ model: 'claude-opus-5-5', sessionStatus: 'ready', ...answer }));
    }
    if (verb === 'instances' && args[2] === '--json') {
      return ok(JSON.stringify([{ instanceId: 'claude', running, autoYes: false }]));
    }
    if (verb === 'instances' && args[2] === 'kill') {
      // `stopFails`: only the stops after the starting message fail.
      if (!(stopFails && initSent)) running = false;
      return ok();
    }
    if (verb === 'auto-yes') return ok();
    if (verb === 'send') {
      running = true;
      if (args.includes('--contract')) return ok('task-1\n');
      initSent = true;
      return initExit === 0 ? ok('sent\n') : { status: initExit, stdout: '', stderr: 'Message submit could not be confirmed (Issue #4035)' };
    }
    throw new Error(`unexpected ${command} ${args.join(' ')}`);
  };
  const clearComposer = (input: ClearInput) => {
    clears.push(input);
    if (afterClear !== null) {
      answers = afterClear;
      read = 0;
    }
    return clearResult;
  };
  return { run, calls, clears, sleeps, clearComposer, sleep: (ms: number) => sleeps.push(ms) };
}

function go(fake: ReturnType<typeof fakeCli>) {
  const log: string[] = [];
  const out: string[] = [];
  const code = main(
    [
      'send', '--run-dir', runDir, '--issue', '4476', '--wt', 'wt-1', '--worktree', worktree,
      '--instance', 'claude', '--contract', '.commandmate/tasks/issue-4476.yaml', '--model', 'opus',
    ],
    {
      run: fake.run,
      sleep: fake.sleep,
      clearComposer: fake.clearComposer,
      out: (line: string) => out.push(line),
      log: (line: string) => log.push(line),
      error: (line: string) => log.push(line),
    }
  );
  return { code, out, log };
}

const contractSends = (fake: ReturnType<typeof fakeCli>) => fake.calls.filter((c) => c[1] === 'send' && c.includes('--contract'));
const initSends = (fake: ReturnType<typeof fakeCli>) => fake.calls.filter((c) => c[1] === 'send' && !c.includes('--contract'));
const kills = (fake: ReturnType<typeof fakeCli>) => fake.calls.filter((c) => c[1] === 'instances' && c[3] === 'kill');
const captures = (fake: ReturnType<typeof fakeCli>) => fake.calls.filter((c) => c[1] === 'capture').length;
const initErr = () => fs.readFileSync(path.join(runDir, 'send-init-4476.err'), 'utf8');

describe('[#4476] the starting message left in the composer after exit 99 (I5)', () => {
  it('is cleared once through the server, and the contract follows two clean reads', () => {
    const fake = fakeCli({ captures: [CONTENT], afterClear: [GHOST] });
    const r = go(fake);
    expect(r.code).toBe(0);
    expect(r.out).toEqual(['task-1']);
    expect(fake.clears).toHaveLength(1);
    expect(fake.clears[0]).toMatchObject({ cli: 'commandmatedev', wt: 'wt-1', instance: 'claude', cliToolId: 'claude' });
    expect(contractSends(fake)).toHaveLength(1);
    // I2: the starting message is never typed (or submitted) again.
    expect(initSends(fake)).toHaveLength(1);
    expect(r.log.join('\n')).toMatch(/composer CLEARED/);
    // Outside a session too: nothing asks `whoami`.
    expect(fake.calls.some((c) => c[1] === 'whoami')).toBe(false);
  });

  it('is not followed by the contract when it stays: the session is stopped, 1, and the .err says what was left', () => {
    const fake = fakeCli({ captures: [CONTENT] });
    const r = go(fake);
    expect(r.code).toBe(1);
    expect(r.out).toEqual([]);
    expect(fake.clears).toHaveLength(1);
    expect(contractSends(fake)).toEqual([]);
    expect(initSends(fake)).toHaveLength(1);
    // The stop before the model, and the stop for the composer.
    expect(kills(fake)).toHaveLength(2);
    expect(initErr()).toContain('one clear (POST ok)');
    expect(initErr()).toContain(INIT_MESSAGE.slice(0, 20));
    expect(r.log.join('\n')).toMatch(/composer NOT CLEARED .*contract not sent/);
    // Read back at most COMPOSER_SETTLE_READS times, paced.
    expect(fake.sleeps.filter((ms) => ms === COMPOSER_SETTLE_INTERVAL_SEC * 1000)).toHaveLength(COMPOSER_SETTLE_READS);
  });

  it('a stop that cannot be confirmed then is 42, still with nothing sent', () => {
    const fake = fakeCli({ captures: [CONTENT], stopFails: true });
    const r = go(fake);
    expect(r.code).toBe(EXIT_STOP_UNCONFIRMED);
    expect(fake.clears).toHaveLength(1);
    expect(contractSends(fake)).toEqual([]);
  });

  it('needs the clean reads in a row: clean, text, clean is not cleared', () => {
    const fake = fakeCli({ captures: [CONTENT], afterClear: [GHOST, CONTENT, EMPTY, CONTENT] });
    const r = go(fake);
    expect(COMPOSER_CLEAN_STREAK).toBe(2);
    expect(r.code).toBe(1);
    expect(contractSends(fake)).toEqual([]);
    // One clear at most, even when the text comes back.
    expect(fake.clears).toHaveLength(1);
  });

  it('a piece of the starting message drawn late (wrapped) is cleared like the whole', () => {
    const piece = { composerState: 'content', composerText: `${INIT_MESSAGE.slice(30, 50)}\n  ${INIT_MESSAGE.slice(50, 70)}` };
    const fake = fakeCli({ captures: [piece], afterClear: [EMPTY] });
    expect(go(fake).code).toBe(0);
    expect(fake.clears).toHaveLength(1);
    expect(contractSends(fake)).toHaveLength(1);
  });

  it('a clear that failed, and a composer that reads clean after all: the contract goes, the log says so', () => {
    let reads = 0;
    const fake = fakeCli({ captures: [CONTENT], clearResult: { attempted: false, ok: false, detail: 'clear not done: x' } });
    const run = fake.run;
    // The text goes away by itself (a late key) two reads after the failed clear.
    fake.run = (command: string, args: string[]) => {
      if (args[0] === 'capture' && fake.clears.length > 0) {
        reads += 1;
        fake.calls.push([command, ...args]);
        return { status: 0, stdout: JSON.stringify({ model: 'claude-opus-5-5', sessionStatus: 'ready', ...(reads >= 2 ? GHOST : CONTENT) }), stderr: '' };
      }
      return run(command, args);
    };
    const r = go(fake);
    expect(r.code).toBe(0);
    expect(fake.clears).toHaveLength(1);
    expect(contractSends(fake)).toHaveLength(1);
    expect(initErr()).toContain('clear not done (clear not done: x)');
  });

  it('the clear that cannot reach the server says it was not done, and the session is stopped', () => {
    const fake = fakeCli({ captures: [CONTENT], clearResult: { attempted: false, ok: false, detail: 'the CLI\'s server could not be resolved' } });
    const r = go(fake);
    expect(r.code).toBe(1);
    expect(contractSends(fake)).toEqual([]);
    expect(r.log.join('\n')).toMatch(/composer NOT CLEARED .*clear not done/);
  });
});

describe('[#4476] text that is not the starting message is not this script\'s (opus P2-1)', () => {
  it('is neither cleared nor sent over, and the session is left running', () => {
    const typed = { composerState: 'content', composerText: 'please also check the CHANGELOG before you start' };
    const fake = fakeCli({ captures: [typed] });
    const r = go(fake);
    expect(r.code).toBe(1);
    expect(fake.clears).toEqual([]);
    expect(contractSends(fake)).toEqual([]);
    // Only the stop before the model: a stop now would lose the text as well.
    expect(kills(fake)).toHaveLength(1);
    expect(initErr()).toContain('please also check the CHANGELOG');
    expect(r.log.join('\n')).toMatch(/composer FOREIGN .*not cleared.*contract not sent/);
  });

  it('isStartingMessageText: the message, its pieces (ANSI and whitespace aside) — not other text, not empty', () => {
    expect(isStartingMessageText(INIT_MESSAGE)).toBe(true);
    expect(isStartingMessageText(INIT_MESSAGE.slice(0, 10))).toBe(true);
    expect(isStartingMessageText(`\x1b[1m${INIT_MESSAGE.slice(40, 60)}\x1b[0m \n  `)).toBe(true);
    expect(isStartingMessageText(`${INIT_MESSAGE}追加`)).toBe(false);
    expect(isStartingMessageText('echo hi')).toBe(false);
    expect(isStartingMessageText('  \n ')).toBe(false);
  });
});

describe('[#4476] a process replaced since the model check gets no clear (codex P2-1)', () => {
  it('G1 at the model check, G2 at ready: no clear, no contract, the role stop (44)', () => {
    const G1 = { sessionGeneration: 'g1', injectionFingerprint: null };
    const G2 = { sessionGeneration: 'g2', injectionFingerprint: null };
    const fake = fakeCli({ captures: [{ ...CONTENT, roleLaunch: G1 }, { ...CONTENT, roleLaunch: G2 }] });
    const r = go(fake);
    expect(r.code).toBe(EXIT_ROLE_CHANGED);
    expect(fake.clears).toEqual([]);
    expect(contractSends(fake)).toEqual([]);
  });

  it('the same generation throughout: cleared as usual (control)', () => {
    const G1 = { sessionGeneration: 'g1', injectionFingerprint: null };
    const fake = fakeCli({ captures: [{ ...CONTENT, roleLaunch: G1 }], afterClear: [{ ...GHOST, roleLaunch: G1 }] });
    expect(go(fake).code).toBe(0);
    expect(fake.clears).toHaveLength(1);
    expect(contractSends(fake)).toHaveLength(1);
  });
});

describe('[#4476] a composer that cannot be read is not taken for an empty one (codex P2-2)', () => {
  it('no_composer first, then clean twice: read again, no clear, the contract', () => {
    const fake = fakeCli({ captures: [{}, NO_COMPOSER, NO_COMPOSER, GHOST, GHOST] });
    // capture #1 (model) carries no key; #2,#3 are the ready reads.
    const r = go(fake);
    expect(r.code).toBe(0);
    expect(fake.clears).toEqual([]);
    expect(contractSends(fake)).toHaveLength(1);
    expect(r.log.join('\n')).toMatch(/composer SETTLED/);
  });

  it.each([
    ['no_composer', NO_COMPOSER],
    ['an unknown state', { composerState: 'shimmering', composerText: null }],
    ['a value of the wrong type', { composerState: 7 }],
    ['a null state', { composerState: null }],
  ])('%s throughout: stopped after the reads, no clear, no contract', (_label, answer) => {
    const fake = fakeCli({ captures: [answer] });
    const r = go(fake);
    expect(r.code).toBe(1);
    expect(fake.clears).toEqual([]);
    expect(contractSends(fake)).toEqual([]);
    expect(r.log.join('\n')).toMatch(/composer NOT CLEARED .*no clear/);
  });

  it('a capture that fails inside the reads breaks the clean streak', () => {
    const fake = fakeCli({ captures: [CONTENT], afterClear: [GHOST, FAIL, GHOST, FAIL, GHOST, FAIL] });
    const r = go(fake);
    expect(r.code).toBe(1);
    expect(contractSends(fake)).toEqual([]);
  });

  it('a no_composer read inside the reads breaks the clean streak too', () => {
    const fake = fakeCli({ captures: [CONTENT], afterClear: [GHOST, NO_COMPOSER, GHOST, NO_COMPOSER, GHOST, NO_COMPOSER] });
    expect(go(fake).code).toBe(1);
    expect(contractSends(fake)).toEqual([]);
  });

  it('composerReading: only empty/ghost are clean, a missing key is legacy, the rest unreadable', () => {
    expect(composerReading(EMPTY).kind).toBe('clean');
    expect(composerReading(GHOST).kind).toBe('clean');
    expect(composerReading(CONTENT)).toEqual({ kind: 'content', state: 'content', text: INIT_MESSAGE });
    expect(composerReading({ sessionStatus: 'ready' }).kind).toBe('legacy');
    for (const answer of [NO_COMPOSER, { composerState: 'unsupported_tool' }, { composerState: 'x' }, { composerState: 1 }, { composerState: null }, null]) {
      expect(composerReading(answer).kind).toBe('unreadable');
    }
  });
});

describe('[#4476] everything else keeps the path it had (negative)', () => {
  it('a ghost or empty composer after exit 99 goes straight to the contract: no clear, no extra read', () => {
    for (const answer of [GHOST, EMPTY]) {
      const fake = fakeCli({ captures: [answer] });
      const r = go(fake);
      expect(r.code).toBe(0);
      expect(fake.clears).toEqual([]);
      expect(contractSends(fake)).toHaveLength(1);
      // One model read, READY_STREAK (2) ready reads.
      expect(captures(fake)).toBe(3);
    }
  });

  it('exit 0 on the starting message is not checked, whatever the composer says', () => {
    const fake = fakeCli({ initExit: 0, captures: [CONTENT] });
    const r = go(fake);
    expect(r.code).toBe(0);
    expect(fake.clears).toEqual([]);
    expect(contractSends(fake)).toHaveLength(1);
    expect(captures(fake)).toBe(3);
  });

  it('a server that reports no composerState: the contract as before, and one log line', () => {
    const fake = fakeCli({ captures: [{}] });
    const r = go(fake);
    expect(r.code).toBe(0);
    expect(fake.clears).toEqual([]);
    expect(contractSends(fake)).toHaveLength(1);
    expect(captures(fake)).toBe(3);
    expect(r.log.filter((line) => line.includes('composer UNKNOWN'))).toHaveLength(1);
  });
});

/**
 * A stand-in for the CLI's package: `bin/commandmate.js` (linked from `<tmp>/bin/<name>`),
 * `package.json` named `commandmate`, and `dist/cli/utils/api-client.js` whose `ApiClient`
 * resolves its server from `CM_PORT` (as the real one does, through `loadClientEnv`) and
 * posts to it — or, without a server, writes what it was asked to a file.
 */
function fakeCliPackage(name = 'cm-fake') {
  const root = path.join(tmp, 'pkg');
  fs.mkdirSync(path.join(root, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(root, 'dist', 'cli', 'utils'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'commandmate', version: '0.0.0-test' }));
  fs.writeFileSync(path.join(root, 'bin', 'commandmate.js'), '#!/usr/bin/env node\n');
  fs.chmodSync(path.join(root, 'bin', 'commandmate.js'), 0o755);
  fs.writeFileSync(
    path.join(root, 'dist', 'cli', 'utils', 'api-client.js'),
    [
      'class ApiClient {',
      "  constructor() { this.serverUrl = 'http://127.0.0.1:' + (process.env.CM_PORT || '3000'); }",
      '  async post(route, body) {',
      "    require('fs').writeFileSync(process.env.FAKE_CLIENT_LOG, JSON.stringify({ serverUrl: this.serverUrl, route, body }));",
      "    if (process.env.FAKE_CLIENT_FAIL) throw new Error('HTTP 409: busy');",
      '    return { success: true };',
      '  }',
      '}',
      'module.exports = { ApiClient };',
    ].join('\n')
  );
  const binDir = path.join(tmp, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  fs.symlinkSync(path.join(root, 'bin', 'commandmate.js'), path.join(binDir, name));
  return { root, binDir, link: path.join(binDir, name), logFile: path.join(tmp, 'client.json') };
}

/** Run with these variables set in this process (the child inherits them), then put them back. */
function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const saved: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(vars)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/** No CommandMate session in the environment: what a plain terminal has. */
const OUTSIDE_SESSION = { CM_WORKTREE_ID: undefined, CM_INSTANCE_ID: undefined, CM_CLI_TOOL: undefined, TMUX: undefined };

describe('[#4476] defaultClearComposer: the existing clear-composer route, through the CLI\'s own client (codex P2-3, opus P2-2)', () => {
  it('posts {cliToolId, instanceId} to /api/worktrees/<wt>/clear-composer with the CLI package found on PATH, outside a session', () => {
    const pkg = fakeCliPackage();
    const result = withEnv(
      { ...OUTSIDE_SESSION, PATH: `${pkg.binDir}${path.delimiter}${process.env.PATH ?? ''}`, CM_PORT: '3999', FAKE_CLIENT_LOG: pkg.logFile, FAKE_CLIENT_FAIL: undefined },
      () => defaultClearComposer({ run: defaultRun, cli: 'cm-fake', wt: 'wt 1', instance: 'claude', cliToolId: 'claude' })
    );
    expect(result).toMatchObject({ attempted: true, ok: true });
    expect(result.detail).toContain('http://127.0.0.1:3999/api/worktrees/wt%201/clear-composer');
    expect(JSON.parse(fs.readFileSync(pkg.logFile, 'utf8'))).toEqual({
      serverUrl: 'http://127.0.0.1:3999',
      route: '/api/worktrees/wt%201/clear-composer',
      body: { cliToolId: 'claude', instanceId: 'claude' },
    });
  });

  it('takes a --cli given as a path as well', () => {
    const pkg = fakeCliPackage();
    const result = withEnv({ ...OUTSIDE_SESSION, CM_PORT: '3998', FAKE_CLIENT_LOG: pkg.logFile, FAKE_CLIENT_FAIL: undefined }, () =>
      defaultClearComposer({ run: defaultRun, cli: pkg.link, wt: 'wt-1', instance: 'claude-2', cliToolId: 'claude' })
    );
    expect(result.ok).toBe(true);
    expect(JSON.parse(fs.readFileSync(pkg.logFile, 'utf8')).body).toEqual({ cliToolId: 'claude', instanceId: 'claude-2' });
  });

  it('a refused POST is not ok', () => {
    const pkg = fakeCliPackage();
    const result = withEnv({ ...OUTSIDE_SESSION, FAKE_CLIENT_LOG: pkg.logFile, FAKE_CLIENT_FAIL: '1' }, () =>
      defaultClearComposer({ run: defaultRun, cli: pkg.link, wt: 'wt-1', instance: 'claude', cliToolId: 'claude' })
    );
    expect(result).toMatchObject({ attempted: true, ok: false });
    expect(result.detail).toContain('HTTP 409: busy');
  });

  it('a server URL it cannot learn is not guessed: nothing is posted, and it says the clear was not done', () => {
    // A CLI that is not on PATH, and one that is not a commandmate package.
    const stray = path.join(tmp, 'stray');
    fs.writeFileSync(stray, '#!/bin/sh\n');
    fs.chmodSync(stray, 0o755);
    for (const cli of ['cm-not-installed-4476', stray]) {
      const result = withEnv({ PATH: path.join(tmp, 'empty-path') }, () =>
        defaultClearComposer({ run: defaultRun, cli, wt: 'wt-1', instance: 'claude', cliToolId: 'claude' })
      );
      expect(result.attempted).toBe(false);
      expect(result.ok).toBe(false);
      expect(result.detail).toMatch(/^clear not done/);
    }
  });

  it('passes the route and body on argv, never a token; no whoami', () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const run = (command: string, args: string[]) => {
      calls.push({ command, args });
      return { status: 0, stdout: JSON.stringify({ stage: 'post', serverUrl: 'http://127.0.0.1:3999', ok: true }), stderr: '' };
    };
    const result = withEnv({ CM_AUTH_TOKEN: 'secret-token-4476' }, () =>
      defaultClearComposer({ run, cli: 'commandmatedev', wt: 'wt-1', instance: 'claude', cliToolId: 'claude' })
    );
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe(process.execPath);
    expect(calls[0].args).toEqual(['-e', CLEAR_COMPOSER_SCRIPT, 'commandmatedev', '/api/worktrees/wt-1/clear-composer', JSON.stringify({ cliToolId: 'claude', instanceId: 'claude' })]);
    expect(calls[0].args.join(' ')).not.toContain('secret-token-4476');
  });
});

describe('[#4476] CLEAR_COMPOSER_SCRIPT with a CLI client that talks HTTP (fake server)', () => {
  let server: http.Server | null = null;
  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
  });

  /** A CLI package whose ApiClient POSTs for real, with the token from the environment like the CLI's. */
  function httpCliPackage() {
    const pkg = fakeCliPackage();
    fs.writeFileSync(
      path.join(pkg.root, 'dist', 'cli', 'utils', 'api-client.js'),
      [
        'class ApiClient {',
        "  constructor() { this.serverUrl = 'http://127.0.0.1:' + (process.env.CM_PORT || '3000'); }",
        '  async post(route, body) {',
        "    const headers = { 'Content-Type': 'application/json' };",
        "    if (process.env.CM_AUTH_TOKEN) headers.Authorization = 'Bearer ' + process.env.CM_AUTH_TOKEN;",
        "    const res = await fetch(this.serverUrl + route, { method: 'POST', headers, body: JSON.stringify(body) });",
        "    if (!res.ok) throw new Error('HTTP ' + res.status);",
        '    return res.json();',
        '  }',
        '}',
        'module.exports = { ApiClient };',
      ].join('\n')
    );
    return pkg;
  }

  /** Run the script in a child (async, so this process can answer it). */
  const post = (cli: string, route: string, body: string, env: NodeJS.ProcessEnv) =>
    new Promise<{ code: number; stdout: string }>((resolve) => {
      execFile(process.execPath, ['-e', CLEAR_COMPOSER_SCRIPT, cli, route, body], { env, timeout: 15_000 }, (err, stdout) => {
        resolve({ code: err ? Number((err as { code?: unknown }).code ?? 1) : 0, stdout: String(stdout) });
      });
    });

  const listen = (status: number) =>
    new Promise<{ port: number; seen: Array<{ method?: string; url?: string; auth?: string; body: string }> }>((resolve) => {
      const seen: Array<{ method?: string; url?: string; auth?: string; body: string }> = [];
      server = http.createServer((req, res) => {
        let body = '';
        req.on('data', (chunk) => (body += chunk));
        req.on('end', () => {
          seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });
          res.writeHead(status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: status === 200, cleared: true }));
        });
      });
      server.listen(0, '127.0.0.1', () => resolve({ port: (server!.address() as AddressInfo).port, seen }));
    });

  it('POSTs the body with the token from the environment, and exits 0 on 200', async () => {
    const pkg = httpCliPackage();
    const fake = await listen(200);
    const body = JSON.stringify({ cliToolId: 'claude', instanceId: 'claude' });
    const r = await post(pkg.link, '/api/worktrees/wt-1/clear-composer', body, { ...process.env, CM_PORT: String(fake.port), CM_AUTH_TOKEN: 'tok-4476' });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ stage: 'post', serverUrl: `http://127.0.0.1:${fake.port}`, ok: true });
    expect(fake.seen).toEqual([{ method: 'POST', url: '/api/worktrees/wt-1/clear-composer', auth: 'Bearer tok-4476', body }]);
  });

  it('exits non-zero on a refusal (409), with no token header when none is set', async () => {
    const pkg = httpCliPackage();
    const fake = await listen(409);
    const env: NodeJS.ProcessEnv = { ...process.env, CM_PORT: String(fake.port) };
    delete env.CM_AUTH_TOKEN;
    const r = await post(pkg.link, '/api/worktrees/wt-1/clear-composer', '{}', env);
    expect(r.code).not.toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ stage: 'post', ok: false, error: 'HTTP 409' });
    expect(fake.seen[0].auth).toBeUndefined();
  });
});
