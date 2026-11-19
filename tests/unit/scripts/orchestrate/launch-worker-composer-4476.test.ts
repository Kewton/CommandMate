/**
 * Issue #4476: a starting message that could not be confirmed (exit 99) may sit
 * unsent in the composer — drawn late, its Enter lost — and every contract `send`
 * after it then refused `composer-not-empty` (#1880). Before the contract goes
 * out the launch now reads the composer (`capture --json`'s `composerState`) and
 * never clears it (PM decision s8/pm-reply-4476-redesign):
 *
 *   - `empty` / `ghost` two reads in a row: the contract;
 *   - anything else at the end of the reads — text (the starting message's rest or
 *     anyone's), `no_composer`, an unknown state, a wrong type, a capture that
 *     fails: no contract, no clear, no kill (a person looks at the composer), and
 *     the reason, the composer's head and the next step in the `.err` and the log;
 *   - a process replaced since the model check: the existing role stop (44);
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
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as launchWorker from '../../../../scripts/orchestrate/launch-worker.mjs';
import {
  COMPOSER_CLEAN_STREAK,
  COMPOSER_SETTLE_INTERVAL_SEC,
  COMPOSER_SETTLE_READS,
  EXIT_ROLE_CHANGED,
  INIT_MESSAGE,
  composerReading,
  isStartingMessageText,
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
const NO_COMPOSER = { composerState: 'no_composer', composerText: null };
/** A `capture --json` that fails (exit 1). */
const FAIL = { __fail: true };
/** The next step the stop names (PM decision). */
const NEXT_STEP = '人が入力欄を確かめて消し、launch-worker を起動し直す';

type Answer = Record<string, unknown>;

/**
 * A CLI whose `capture --json` answers come from a list. `captures[0]` is the
 * model check, `[1]` and `[2]` the two ready reads, the rest the composer's
 * re-reads; the last answer repeats.
 */
function fakeCli({ initExit = 99, captures = [GHOST] as Answer[] } = {}) {
  const calls: string[][] = [];
  const sleeps: number[] = [];
  /** Every call to the clear a previous version had (`deps.clearComposer`): must stay 0. */
  const clears: unknown[] = [];
  let read = 0;
  let running = true;
  const run = (command: string, args: string[]) => {
    calls.push([command, ...args]);
    const ok = (stdout = '') => ({ status: 0, stdout, stderr: '' });
    if (command === 'git') return ok();
    // Nothing but the CLI and git: no `node -e` child, no curl, no other HTTP client.
    if (command !== 'commandmatedev') return { status: 1, stdout: '', stderr: `unexpected command ${command}` };
    const verb = args[0];
    if (verb === 'reply') return ok(JSON.stringify({ instanceId: args[args.indexOf('--instance') + 1], cliToolId: 'claude', reply: null }));
    if (verb === 'capture') {
      const answer = captures[Math.min(read, captures.length - 1)];
      read += 1;
      if (answer === FAIL) return { status: 1, stdout: '', stderr: 'ECONNREFUSED' };
      return ok(JSON.stringify({ model: 'claude-opus-5-5', sessionStatus: 'ready', ...answer }));
    }
    if (verb === 'instances' && args[2] === '--json') return ok(JSON.stringify([{ instanceId: 'claude', running, autoYes: false }]));
    if (verb === 'instances' && args[2] === 'kill') {
      running = false;
      return ok();
    }
    if (verb === 'auto-yes') return ok();
    if (verb === 'send') {
      running = true;
      if (args.includes('--contract')) return ok('task-1\n');
      return initExit === 0 ? ok('sent\n') : { status: initExit, stdout: '', stderr: 'Message submit could not be confirmed (Issue #4035)' };
    }
    return { status: 1, stdout: '', stderr: `unexpected ${verb}` };
  };
  const clearComposer = (input: unknown) => {
    clears.push(input);
    return { attempted: true, ok: true, detail: 'POST ok' };
  };
  return { run, calls, sleeps, clears, clearComposer, sleep: (ms: number) => sleeps.push(ms) };
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
      // A clear handed in is never used (the redesign has none).
      clearComposer: fake.clearComposer,
      out: (line: string) => out.push(line),
      log: (line: string) => log.push(line),
      error: (line: string) => log.push(line),
    } as Parameters<typeof main>[1]
  );
  return { code, out, log };
}

const contractSends = (fake: ReturnType<typeof fakeCli>) => fake.calls.filter((c) => c[1] === 'send' && c.includes('--contract'));
const initSends = (fake: ReturnType<typeof fakeCli>) => fake.calls.filter((c) => c[1] === 'send' && !c.includes('--contract'));
/** Kills after the starting message (the one before the model is written is the launch's own). */
const killsAfterInit = (fake: ReturnType<typeof fakeCli>) => {
  const init = fake.calls.findIndex((c) => c[1] === 'send' && !c.includes('--contract'));
  return fake.calls.slice(init + 1).filter((c) => c[1] === 'instances' && c[3] === 'kill');
};
const captures = (fake: ReturnType<typeof fakeCli>) => fake.calls.filter((c) => c[1] === 'capture').length;
const nonCliCommands = (fake: ReturnType<typeof fakeCli>) => fake.calls.filter((c) => c[0] !== 'commandmatedev' && c[0] !== 'git');
const initErr = () => fs.readFileSync(path.join(runDir, 'send-init-4476.err'), 'utf8');

/** Composer answers for the ready reads and every re-read after them. */
const throughout = (answer: Answer): Answer[] =>
  // A failing capture after the ready reads (they have to read ready for the launch to get here).
  answer === FAIL ? [{}, NO_COMPOSER, NO_COMPOSER, FAIL] : [{}, answer];

describe('[#4476] the composer is never cleared, whatever it holds (redesign)', () => {
  const STATES: Array<[string, Answer]> = [
    ['the starting message', CONTENT],
    ['a long beginning of the starting message', { composerState: 'content', composerText: INIT_MESSAGE.slice(0, 40) }],
    ['a short input (OK)', { composerState: 'content', composerText: 'OK' }],
    ['a person\'s text', { composerState: 'content', composerText: 'please also check the CHANGELOG' }],
    ['content with no text', { composerState: 'content', composerText: null }],
    ['no_composer', NO_COMPOSER],
    ['unsupported_tool', { composerState: 'unsupported_tool' }],
    ['an unknown state', { composerState: 'shimmering' }],
    ['a value of the wrong type', { composerState: 7 }],
    ['a null state', { composerState: null }],
    ['a capture that fails (after a no_composer)', FAIL],
  ];

  it.each(STATES)('%s throughout: no clear, no contract, no kill, exit 1, and the next step is written', (_label, answer) => {
    const fake = fakeCli({ captures: throughout(answer) });
    const r = go(fake);
    expect(r.code).toBe(1);
    expect(fake.clears).toEqual([]);
    expect(nonCliCommands(fake)).toEqual([]);
    expect(contractSends(fake)).toEqual([]);
    expect(killsAfterInit(fake)).toEqual([]);
    // I2: the starting message is never typed (or submitted) again.
    expect(initSends(fake)).toHaveLength(1);
    expect(initErr()).toContain(NEXT_STEP);
    expect(r.log.join('\n')).toMatch(/composer NOT CLEAN .*contract not sent/);
    expect(r.log.join('\n')).toContain(NEXT_STEP);
    // Read again COMPOSER_SETTLE_READS times, paced, before giving up.
    expect(fake.sleeps.filter((ms) => ms === COMPOSER_SETTLE_INTERVAL_SEC * 1000)).toHaveLength(COMPOSER_SETTLE_READS);
  });

  it('no request reaches an HTTP server the CLI could be pointed at', async () => {
    const seen: string[] = [];
    let connections = 0;
    const server = http.createServer((req, res) => {
      seen.push(`${req.method} ${req.url}`);
      res.end('{}');
    });
    server.on('connection', () => (connections += 1));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const saved = process.env.CM_PORT;
    process.env.CM_PORT = String((server.address() as AddressInfo).port);
    try {
      for (const [, answer] of STATES) go(fakeCli({ captures: throughout(answer) }));
      await new Promise((resolve) => setTimeout(resolve, 100));
    } finally {
      if (saved === undefined) delete process.env.CM_PORT;
      else process.env.CM_PORT = saved;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    expect(seen).toEqual([]);
    expect(connections).toBe(0);
  });

  it('exports no clear: the clear-composer child and its client are gone', () => {
    const names = Object.keys(launchWorker);
    expect(names).not.toContain('defaultClearComposer');
    expect(names).not.toContain('CLEAR_COMPOSER_SCRIPT');
    expect(names).not.toContain('CLEAR_COMPOSER_TIMEOUT_MS');
  });
});

describe('[#4476] the stop says what the composer held (I6 only describes)', () => {
  it('the rest of the starting message (a beginning of 20 characters or more)', () => {
    const fake = fakeCli({ captures: throughout({ composerState: 'content', composerText: INIT_MESSAGE.slice(0, 30) }) });
    const r = go(fake);
    expect(r.code).toBe(1);
    expect(initErr()).toContain('looks like the rest of the starting message');
    expect(initErr()).toContain(INIT_MESSAGE.slice(0, 20));
  });

  it.each([
    ['OK', 'OK'],
    ['a piece from inside the message', INIT_MESSAGE.slice(30, 60)],
    ['a person\'s text', 'please also check the CHANGELOG'],
  ])('%s: other text', (_label, text) => {
    const fake = fakeCli({ captures: throughout({ composerState: 'content', composerText: text }) });
    go(fake);
    expect(initErr()).toContain('other text');
    expect(initErr()).toContain(text.slice(0, 10));
  });

  it('content whose text is empty or not a string: the text was not reported', () => {
    for (const text of ['', null, 42]) {
      const fake = fakeCli({ captures: throughout({ composerState: 'content', composerText: text }) });
      go(fake);
      expect(initErr()).toContain('its text was not reported');
      fs.rmSync(runDir, { recursive: true, force: true });
    }
  });

  it('a composer that cannot be read: says so, with the last state', () => {
    const fake = fakeCli({ captures: throughout(NO_COMPOSER) });
    go(fake);
    expect(initErr()).toContain('cannot be read (last read no_composer)');
  });
});

describe('[#4476] the contract waits for two clean reads in a row', () => {
  it.each([
    ['ghost', GHOST],
    ['empty', EMPTY],
  ])('%s twice: the contract, one more read than before', (_label, answer) => {
    const fake = fakeCli({ captures: throughout(answer) });
    const r = go(fake);
    expect(COMPOSER_CLEAN_STREAK).toBe(2);
    expect(r.code).toBe(0);
    expect(r.out).toEqual(['task-1']);
    expect(contractSends(fake)).toHaveLength(1);
    expect(fake.clears).toEqual([]);
    expect(killsAfterInit(fake)).toEqual([]);
    // The model read, two ready reads (the last is the first clean one), one re-read.
    expect(captures(fake)).toBe(4);
  });

  it('clean, text, clean, text …: never two in a row, no contract', () => {
    const fake = fakeCli({ captures: [{}, GHOST, GHOST, CONTENT, GHOST, CONTENT, GHOST, CONTENT, GHOST] });
    const r = go(fake);
    expect(r.code).toBe(1);
    expect(contractSends(fake)).toEqual([]);
    expect(killsAfterInit(fake)).toEqual([]);
  });

  it('clean, then a capture that fails, then clean: the failure breaks the streak', () => {
    const fake = fakeCli({ captures: [{}, GHOST, GHOST, FAIL, GHOST, FAIL, GHOST, FAIL, GHOST] });
    expect(go(fake).code).toBe(1);
    expect(contractSends(fake)).toEqual([]);
  });

  it('text that a person clears meanwhile: the contract after two clean reads, and the log says so', () => {
    const fake = fakeCli({ captures: [{}, CONTENT, CONTENT, CONTENT, GHOST, GHOST] });
    const r = go(fake);
    expect(r.code).toBe(0);
    expect(contractSends(fake)).toHaveLength(1);
    expect(fake.clears).toEqual([]);
    expect(r.log.join('\n')).toMatch(/composer CLEAN .*2 clean reads/);
  });
});

describe('[#4476] everything else keeps the path it had (negative)', () => {
  it('exit 0 on the starting message is not checked, whatever the composer says', () => {
    const fake = fakeCli({ initExit: 0, captures: throughout(CONTENT) });
    const r = go(fake);
    expect(r.code).toBe(0);
    expect(contractSends(fake)).toHaveLength(1);
    expect(captures(fake)).toBe(3);
  });

  it('a server that reports no composerState: the contract as before, and one log line', () => {
    const fake = fakeCli({ captures: [{}] });
    const r = go(fake);
    expect(r.code).toBe(0);
    expect(contractSends(fake)).toHaveLength(1);
    expect(captures(fake)).toBe(3);
    expect(r.log.filter((line) => line.includes('composer UNKNOWN'))).toHaveLength(1);
  });

  it('G1 at the model check, G2 at ready: the existing role stop (44), no contract, no clear', () => {
    const G1 = { sessionGeneration: 'g1', injectionFingerprint: null };
    const G2 = { sessionGeneration: 'g2', injectionFingerprint: null };
    const fake = fakeCli({ captures: [{ ...CONTENT, roleLaunch: G1 }, { ...CONTENT, roleLaunch: G2 }] });
    const r = go(fake);
    expect(r.code).toBe(EXIT_ROLE_CHANGED);
    expect(fake.clears).toEqual([]);
    expect(contractSends(fake)).toEqual([]);
  });
});

describe('[#4476] the readers the stop is described with', () => {
  it('isStartingMessageText: a beginning of 20 characters or more (ANSI and whitespace aside) — not short, not inside, not other text', () => {
    expect(isStartingMessageText(INIT_MESSAGE)).toBe(true);
    expect(isStartingMessageText(`\x1b[1m${INIT_MESSAGE.slice(0, 12)}\x1b[0m \n  ${INIT_MESSAGE.slice(12, 20)}`)).toBe(true);
    expect(isStartingMessageText(INIT_MESSAGE.slice(0, 19))).toBe(false);
    expect(isStartingMessageText(INIT_MESSAGE.slice(40, 60))).toBe(false);
    expect(isStartingMessageText('OK')).toBe(false);
    expect(isStartingMessageText(`${INIT_MESSAGE}追加`)).toBe(false);
    expect(isStartingMessageText('  \n ')).toBe(false);
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
