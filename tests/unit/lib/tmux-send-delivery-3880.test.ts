/**
 * How far a `tmux send-keys` got, on its error (Issue #3880).
 *
 * The real tmux module. `child_process.execFile` is swapped for a FAKE CHILD:
 * a real `node` process standing in for `tmux`, which appends the argv it got
 * to a log file under its own `os.tmpdir()` directory — the "pane" — and then
 * either exits 0, refuses with exit 1 before writing, or writes and hangs. A
 * hanging child is killed with SIGTERM once its write is in the log, the same
 * kill `execFile`'s `timeout` does, so the order "the key landed, then the call
 * timed out" is fixed by the test rather than by a race. No tmux server is
 * started or reached.
 *
 * @vitest-environment node
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Mode = 'ok' | 'refuse' | 'hang' | 'no-binary';

const fake = vi.hoisted(() => ({
  dir: '',
  script: '',
  log: '',
  /** One mode per tmux call, in order; `ok` once they run out. */
  modes: [] as string[],
  /** The `timeout` each call asked for. */
  timeouts: [] as unknown[],
}));

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  const execFile = vi.fn(
    (
      _cmd: string,
      args: string[],
      opts: { timeout?: number },
      callback: (error: Error | null, stdout?: string, stderr?: string) => void,
    ) => {
      fake.timeouts.push(opts?.timeout);
      const mode = fake.modes.shift() ?? 'ok';
      const binary = mode === 'no-binary' ? path.join(fake.dir, 'no-such-tmux') : process.execPath;
      const child = actual.execFile(binary, [fake.script, fake.log, mode, ...args], opts, callback);
      if (mode === 'hang') {
        // Kill it once its key is in the log: "delivered, then timed out".
        const before = fs.existsSync(fake.log) ? fs.readFileSync(fake.log, 'utf8').length : 0;
        const timer = setInterval(() => {
          const now = fs.existsSync(fake.log) ? fs.readFileSync(fake.log, 'utf8').length : 0;
          if (now > before) {
            clearInterval(timer);
            child.kill('SIGTERM');
          }
        }, 10);
      }
      return child;
    },
  );
  return { ...actual, execFile };
});

import { deliveryOfExecFailure, sendKeys, sendSpecialKeys, TmuxSendError } from '@/lib/tmux/tmux';

const FAKE_TMUX = `
const fs = require('fs');
const [, , log, mode, ...args] = process.argv;
if (mode === 'refuse') {
  process.stderr.write("can't find pane: =gone:\\n");
  process.exit(1);
}
fs.appendFileSync(log, JSON.stringify(args) + '\\n');
if (mode === 'hang') setTimeout(() => {}, 60000);
`;

/** The send-keys argv the fake child logged, one per call that reached it. */
function landed(): string[][] {
  if (!fs.existsSync(fake.log)) return [];
  return fs
    .readFileSync(fake.log, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as string[]);
}

function useModes(...modes: Mode[]): void {
  fake.modes = [...modes];
}

async function thrownBy(send: Promise<void>): Promise<TmuxSendError | null> {
  try {
    await send;
    return null;
  } catch (error: unknown) {
    return error as TmuxSendError;
  }
}

const SESSION = 'cm-wt-3880-claude';

beforeEach(() => {
  fake.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-3880-tmux-'));
  fake.script = path.join(fake.dir, 'fake-tmux.js');
  fake.log = path.join(fake.dir, 'pane.log');
  fs.writeFileSync(fake.script, FAKE_TMUX);
  fake.modes = [];
  fake.timeouts = [];
});

afterEach(() => {
  fs.rmSync(fake.dir, { recursive: true, force: true });
});

describe('[#3880] sendKeys: the first (and only) call', () => {
  it('a key that landed and then timed out is indeterminate', async () => {
    useModes('hang');
    const error = await thrownBy(sendKeys(SESSION, 'y', false));

    expect(landed()).toEqual([['send-keys', '-t', `=${SESSION}:`, 'y']]);
    expect(error).toBeInstanceOf(TmuxSendError);
    expect(error?.delivery).toBe('indeterminate');
    expect(error?.keysDelivered).toBe(0);
    // The message callers have always matched on.
    expect(error?.message).toMatch(/^Failed to send keys to tmux session: /);
    // The real call shape: the module's own 5-second timeout.
    expect(fake.timeouts).toEqual([5000]);
  });

  it('negative: tmux refusing with an exit status is not-started, and nothing landed', async () => {
    useModes('refuse');
    const error = await thrownBy(sendKeys(SESSION, 'y', false));

    expect(landed()).toEqual([]);
    expect(error?.delivery).toBe('not-started');
    expect(error?.message).toMatch(/can't find pane/);
  });

  it('negative: a binary that never started is not-started', async () => {
    useModes('no-binary');
    const error = await thrownBy(sendKeys(SESSION, 'y', false));

    expect(landed()).toEqual([]);
    expect(error?.delivery).toBe('not-started');
  });

  it('negative: literal with sendEnter is refused before any call (not-started)', async () => {
    const error = await thrownBy(sendKeys(SESSION, 'y', true, { literal: true }));

    expect(fake.timeouts).toEqual([]);
    expect(error).toBeInstanceOf(TmuxSendError);
    expect(error?.delivery).toBe('not-started');
  });

  it('negative: a call tmux exits 0 on resolves (delivered), as before', async () => {
    await sendKeys(SESSION, 'y', false);
    expect(landed()).toEqual([['send-keys', '-t', `=${SESSION}:`, 'y']]);
  });
});

describe('[#3880] sendSpecialKeys: the keys before the failing one are counted', () => {
  it('the first key landed and timed out: indeterminate, none known delivered', async () => {
    useModes('hang');
    const error = await thrownBy(sendSpecialKeys(SESSION, ['Down', 'Enter']));

    expect(landed().map((args) => args[3])).toEqual(['Down']);
    expect(error?.delivery).toBe('indeterminate');
    expect(error?.keysDelivered).toBe(0);
    expect(error?.message).toMatch(/^Failed to send special keys to tmux session: /);
  });

  it('the second key timed out: indeterminate, one known delivered', async () => {
    useModes('ok', 'hang');
    const error = await thrownBy(sendSpecialKeys(SESSION, ['Down', 'Space', 'Enter']));

    expect(landed().map((args) => args[3])).toEqual(['Down', 'Space']);
    expect(error?.delivery).toBe('indeterminate');
    expect(error?.keysDelivered).toBe(1);
  });

  it('negative: the second key refused: not-started for that call, one delivered', async () => {
    useModes('ok', 'refuse');
    const error = await thrownBy(sendSpecialKeys(SESSION, ['Down', 'Enter']));

    expect(landed().map((args) => args[3])).toEqual(['Down']);
    expect(error?.delivery).toBe('not-started');
    expect(error?.keysDelivered).toBe(1);
  });

  it('negative: an invalid key is refused before any call (not-started, retryable)', async () => {
    const error = await thrownBy(sendSpecialKeys(SESSION, ['Down', 'F13']));

    expect(fake.timeouts).toEqual([]);
    expect(error?.delivery).toBe('not-started');
    expect(error?.keysDelivered).toBe(0);
  });
});

describe('[#3880] deliveryOfExecFailure reads the shape, not the wording', () => {
  it('killed / a signal is indeterminate, whatever the message says', () => {
    expect(deliveryOfExecFailure(Object.assign(new Error("can't find pane"), { killed: true, code: null }))).toBe(
      'indeterminate',
    );
    expect(deliveryOfExecFailure(Object.assign(new Error('x'), { signal: 'SIGKILL', code: null }))).toBe(
      'indeterminate',
    );
  });

  it('an exit status or an errno is not-started, whatever the message says', () => {
    expect(deliveryOfExecFailure(Object.assign(new Error('Command timed out'), { code: 1 }))).toBe('not-started');
    expect(deliveryOfExecFailure(Object.assign(new Error('spawn tmux ENOENT'), { code: 'ENOENT' }))).toBe(
      'not-started',
    );
  });

  it('an error of no known shape is indeterminate (not "not sent")', () => {
    expect(deliveryOfExecFailure(new Error('timeout'))).toBe('indeterminate');
    expect(deliveryOfExecFailure('boom')).toBe('indeterminate');
  });
});
