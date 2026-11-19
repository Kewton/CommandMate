/**
 * Issue #4476: a starting message that could not be confirmed (exit 99) may sit
 * unsent in the composer — drawn late, its Enter lost — and every contract `send`
 * after it then refused `composer-not-empty` (#1880). Before the contract goes
 * out the launch now reads the composer (`capture --json`'s `composerState`):
 *
 *   - `empty` / `ghost`: the contract, as before;
 *   - `content`: one clear through the server's existing clear-composer route,
 *     then the contract only after two clean reads in a row — else the session
 *     is stopped and nothing is sent (the `not ready` shape: 1, or 42);
 *   - no `composerState` (an older server): as before, with one log line.
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
  EXIT_STOP_UNCONFIRMED,
  INIT_MESSAGE,
  defaultClearComposer,
  main,
} from '../../../../scripts/orchestrate/launch-worker.mjs';

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

/**
 * A CLI whose `capture --json` answers come from a list (the last repeating),
 * and whose clear (the fake HTTP) turns the answers to `afterClear` when given.
 */
function fakeCli({
  initExit = 99,
  captures = [GHOST] as Array<Record<string, unknown>>,
  afterClear = null as Array<Record<string, unknown>> | null,
  stopFails = false,
} = {}) {
  const calls: string[][] = [];
  const clears: Array<Record<string, unknown>> = [];
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
    if (verb === 'capture') {
      const answer = answers[Math.min(read, answers.length - 1)];
      read += 1;
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
  const clearComposer = (input: { run: unknown; cli: string; wt: string; instance: string; cliToolId: string }) => {
    clears.push(input);
    if (afterClear !== null) {
      answers = afterClear;
      read = 0;
    }
    return { ok: true, detail: 'HTTP 200' };
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
    expect(initErr()).toContain('still holds text after one clear');
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
    expect(r.log.filter((line) => line.includes('composer UNKNOWN'))).toHaveLength(1);
  });
});

describe('[#4476] defaultClearComposer: the existing clear-composer route of the server the CLI talks to', () => {
  const runWith = (whoami: { status: number; stdout: string }, post = { status: 0, stdout: '{"status":200}', stderr: '' }) => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const run = (command: string, args: string[]) => {
      calls.push({ command, args });
      if (args[0] === 'whoami') return { ...whoami, stderr: '' };
      return post;
    };
    return { run, calls };
  };

  it('posts {cliToolId, instanceId} to <serverUrl>/api/worktrees/<wt>/clear-composer, the token not on argv', () => {
    const fake = runWith({ status: 0, stdout: JSON.stringify({ serverUrl: 'http://127.0.0.1:3999/' }) });
    const saved = process.env.CM_AUTH_TOKEN;
    process.env.CM_AUTH_TOKEN = 'secret-token-4476';
    let result: { ok: boolean; detail: string };
    try {
      result = defaultClearComposer({ run: fake.run, cli: 'commandmatedev', wt: 'wt 1', instance: 'claude', cliToolId: 'claude' });
    } finally {
      if (saved === undefined) delete process.env.CM_AUTH_TOKEN;
      else process.env.CM_AUTH_TOKEN = saved;
    }
    expect(result.ok).toBe(true);
    expect(fake.calls[0]).toEqual({ command: 'commandmatedev', args: ['whoami', '--json'] });
    const post = fake.calls[1];
    expect(post.command).toBe(process.execPath);
    expect(post.args).toContain('http://127.0.0.1:3999/api/worktrees/wt%201/clear-composer');
    expect(post.args).toContain(JSON.stringify({ cliToolId: 'claude', instanceId: 'claude' }));
    // The token is read from the environment by the child, never put on argv.
    expect(post.args.join(' ')).not.toContain('secret-token-4476');
  });

  it('a server URL it cannot learn is not guessed: nothing is posted', () => {
    const fake = runWith({ status: 3, stdout: '' });
    const result = defaultClearComposer({ run: fake.run, cli: 'commandmatedev', wt: 'wt-1', instance: 'claude', cliToolId: 'claude' });
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/whoami exit=3/);
    expect(fake.calls).toHaveLength(1);
  });

  it('a refused POST is not ok', () => {
    const fake = runWith(
      { status: 0, stdout: JSON.stringify({ serverUrl: 'http://127.0.0.1:3999' }) },
      { status: 1, stdout: '{"status":409}', stderr: '' }
    );
    expect(defaultClearComposer({ run: fake.run, cli: 'commandmatedev', wt: 'wt-1', instance: 'claude', cliToolId: 'claude' }).ok).toBe(false);
  });
});

describe('[#4476] CLEAR_COMPOSER_SCRIPT against a fake HTTP server', () => {
  let server: http.Server | null = null;
  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
  });

  /** Run the script in a child (async, so this process can answer it). */
  const post = (url: string, body: string, env: NodeJS.ProcessEnv) =>
    new Promise<{ code: number; stdout: string }>((resolve) => {
      execFile(process.execPath, ['-e', CLEAR_COMPOSER_SCRIPT, url, body], { env, timeout: 15_000 }, (err, stdout) => {
        resolve({ code: err ? Number((err as { code?: unknown }).code ?? 1) : 0, stdout: String(stdout) });
      });
    });

  const listen = (status: number) =>
    new Promise<{ url: string; seen: Array<{ method?: string; url?: string; auth?: string; body: string }> }>((resolve) => {
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
      server.listen(0, '127.0.0.1', () => {
        const { port } = server!.address() as AddressInfo;
        resolve({ url: `http://127.0.0.1:${port}/api/worktrees/wt-1/clear-composer`, seen });
      });
    });

  it('POSTs the body with the token from the environment, and exits 0 on 200', async () => {
    const fake = await listen(200);
    const body = JSON.stringify({ cliToolId: 'claude', instanceId: 'claude' });
    const r = await post(fake.url, body, { ...process.env, CM_AUTH_TOKEN: 'tok-4476' });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout).status).toBe(200);
    expect(fake.seen).toEqual([{ method: 'POST', url: '/api/worktrees/wt-1/clear-composer', auth: 'Bearer tok-4476', body }]);
  });

  it('exits non-zero on a refusal (409), with no token header when none is set', async () => {
    const fake = await listen(409);
    const env = { ...process.env };
    delete env.CM_AUTH_TOKEN;
    const r = await post(fake.url, '{}', env);
    expect(r.code).not.toBe(0);
    expect(JSON.parse(r.stdout).status).toBe(409);
    expect(fake.seen[0].auth).toBeUndefined();
  });
});
