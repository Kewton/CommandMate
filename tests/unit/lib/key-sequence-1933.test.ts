/**
 * `KeySequence` is a key-or-text union and text always leaves through
 * `send-keys -l --` (Issue #1933, 受入条件 S9).
 *
 * ## The defect this pins, and how it was established
 *
 * `grep -n "'-l'" src/lib/tmux/*.ts` returned **zero** hits on develop
 * `b982fb88`, and `sendMessageWithSubmitVerification` types the user's message
 * body with `sendKeys(sessionName, message, false)` — a bare positional
 * argument to `tmux send-keys`, which resolves it against the key table before
 * sending anything.
 *
 * Measured on tmux 3.5a against a private socket (`tmux -L cm1933probe`), with
 * the pane running `stty raw -echo; cat > file` so the file receives exactly the
 * bytes the TUI would:
 *
 * ```
 * send-keys -t X    'Escape'      -> 1b                  (ESC key)
 * send-keys -t X -l 'Escape'      -> 45 73 63 61 70 65   ("Escape")
 * send-keys -t X    'Enter'       -> 0d                  (CR)
 * send-keys -t X -l 'Enter'       -> 45 6e 74 65 72      ("Enter")
 * send-keys -t X    '-l'          -> rc 0, NOTHING sent
 * send-keys -t X    '-N hello'    -> rc 1, "repeat count invalid"
 * send-keys -t X -l -- '-l'       -> 2d 6c               ("-l")
 * ```
 *
 * So a message body of exactly `Escape` interrupted the agent, `Enter`
 * submitted an empty composer, `C-c` sent SIGINT, and a body beginning with `-`
 * was discarded while the send returned success. None of the four produced an
 * error or a differing log line.
 *
 * ## Two levels of pin, on purpose
 *
 * `keySequenceArgs` is checked directly, because the property is about an argv
 * and an argv is a value. Then `sendMessageWithSubmitVerification` is driven
 * end to end with **only `child_process.execFile` stubbed** — the real tmux
 * module, the real sender, a fake transport — so the assertion is about what
 * would reach the tmux binary rather than about what a spy on a wrapper saw.
 *
 * @vitest-environment node
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { execFile } from 'child_process';

vi.mock('child_process', () => ({ execFile: vi.fn() }));

import {
  keySequenceArgs,
  runKeySequence,
  describeKeySequence,
  type KeySequenceTransport,
} from '@/lib/tmux/key-sequence';
import { sendKeys, sendKeySequence, SPECIAL_KEY_VALUES, exactTarget } from '@/lib/tmux/tmux';
import {
  KEY_SEQUENCE_KEY_NAMES,
  isKeySequenceKeyName,
  keyStep,
  literalStep,
  isKeyStep,
  isLiteralStep,
  type KeySequence,
} from '@/types/cli-tool-contracts';
import { sendMessageWithSubmitVerification } from '@/lib/cli-tools/submit-verified-sender';

const SESSION = 'mcbd-gemini-wt-1933';
const TARGET = '=mcbd-gemini-wt-1933:';

/**
 * A composer with nothing in it, as gemini paints one. `classifySubmit` reads
 * this as `submitted`, so the sender's read-back loop stops after one pass and
 * the recorded argv are exactly the send.
 */
const EMPTY_COMPOSER_FRAME = 'some earlier output\n\n> \n';

/** Every `execFile('tmux', args)` this test's stub was asked to run. */
let invocations: string[][];

/**
 * Stub the transport, not the tmux wrapper.
 *
 * `capture-pane` answers with an empty composer; everything else succeeds
 * silently. `execFile` is called with a node-style callback by `promisify`.
 */
function stubTmux(): void {
  vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
    const argv = args[1] as string[];
    invocations.push(argv);
    const callback = args[args.length - 1] as (
      err: Error | null,
      result: { stdout: string; stderr: string }
    ) => void;
    const stdout = argv[0] === 'capture-pane' ? EMPTY_COMPOSER_FRAME : '';
    callback(null, { stdout, stderr: '' });
    return {} as ReturnType<typeof execFile>;
  });
}

/** The argv of every `send-keys` invocation, in order. */
function sendKeysInvocations(): string[][] {
  return invocations.filter((argv) => argv[0] === 'send-keys');
}

describe('KeySequence (Issue #1933 S9)', () => {
  beforeEach(() => {
    invocations = [];
    vi.clearAllMocks();
    stubTmux();
  });

  describe('the union itself', () => {
    it('discriminates a key from text on `kind`, not on the string', () => {
      const key: KeySequence = keyStep('Escape');
      const text: KeySequence = literalStep('Escape');

      expect(isKeyStep(key)).toBe(true);
      expect(isLiteralStep(key)).toBe(false);
      expect(isKeyStep(text)).toBe(false);
      expect(isLiteralStep(text)).toBe(true);
      // The same seven characters mean two different things, which is the whole
      // reason the union exists.
      expect(key).not.toEqual(text);
    });

    it('carries a per-step delay only when one was given', () => {
      expect(keyStep('C-c')).toEqual({ kind: 'key', name: 'C-c' });
      expect(keyStep('C-c', 300)).toEqual({ kind: 'key', name: 'C-c', delayAfterMs: 300 });
      expect(literalStep('/exit')).toEqual({ kind: 'literal', text: '/exit' });
      expect(literalStep('/exit', 100)).toEqual({
        kind: 'literal',
        text: '/exit',
        delayAfterMs: 100,
      });
    });

    /**
     * The vocabulary is duplicated rather than imported, because
     * `src/types/**` must not reach into `src/lib/tmux/**`. This is the join
     * that keeps the duplication from drifting.
     */
    it('names exactly the keys `sendSpecialKey` accepts', () => {
      expect([...KEY_SEQUENCE_KEY_NAMES]).toEqual([...SPECIAL_KEY_VALUES]);
    });

    it('rejects a key name outside the vocabulary', () => {
      expect(isKeySequenceKeyName('Escape')).toBe(true);
      expect(isKeySequenceKeyName('Up')).toBe(false);
      expect(isKeySequenceKeyName('rm -rf /')).toBe(false);
    });
  });

  describe('keySequenceArgs', () => {
    it('sends literal text through -l and past --', () => {
      expect(keySequenceArgs(TARGET, literalStep('hello world'))).toEqual([
        'send-keys',
        '-t',
        TARGET,
        '-l',
        '--',
        'hello world',
      ]);
    });

    it.each(['Escape', 'C-c', 'Enter', 'C-d', 'C-m'])(
      'does not let the body %s be resolved as a key',
      (body) => {
        const args = keySequenceArgs(TARGET, literalStep(body));

        expect(args).toContain('-l');
        // `--` must come before the payload, or getopt still owns it.
        expect(args.indexOf('--')).toBeLessThan(args.indexOf(body));
        expect(args[args.length - 1]).toBe(body);
      }
    );

    it('sends a body that begins with a dash as text rather than as a flag', () => {
      // Measured: `send-keys -t X '-l'` returns 0 and sends nothing at all.
      expect(keySequenceArgs(TARGET, literalStep('-l'))).toEqual([
        'send-keys',
        '-t',
        TARGET,
        '-l',
        '--',
        '-l',
      ]);
      expect(keySequenceArgs(TARGET, literalStep('-N 5'))).toEqual([
        'send-keys',
        '-t',
        TARGET,
        '-l',
        '--',
        '-N 5',
      ]);
    });

    it('sends a key step as a key, without -l', () => {
      expect(keySequenceArgs(TARGET, keyStep('Escape'))).toEqual([
        'send-keys',
        '-t',
        TARGET,
        '--',
        'Escape',
      ]);
    });

    it('refuses a key name that was cast past the type', () => {
      const forged = { kind: 'key', name: 'send-keys ; rm -rf /' } as unknown as KeySequence;
      expect(() => keySequenceArgs(TARGET, forged)).toThrow('Invalid key sequence key name');
    });
  });

  describe('runKeySequence with a transport stub', () => {
    it('runs one tmux invocation per step, in order, never batched', async () => {
      const ran: string[][] = [];
      const transport: KeySequenceTransport = {
        run: async (args) => {
          ran.push(args);
        },
      };

      await runKeySequence(TARGET, [literalStep('/exit'), keyStep('Enter')], transport);

      expect(ran).toEqual([
        ['send-keys', '-t', TARGET, '-l', '--', '/exit'],
        ['send-keys', '-t', TARGET, '--', 'Enter'],
      ]);
    });

    it('waits a step delay before the next step and never after the last', async () => {
      const slept: number[] = [];
      const transport: KeySequenceTransport = { run: async () => {} };

      await runKeySequence(
        TARGET,
        [keyStep('C-c', 300), literalStep('/quit', 100), keyStep('Enter', 999)],
        transport,
        async (ms) => {
          slept.push(ms);
        }
      );

      expect(slept).toEqual([300, 100]);
    });

    it('stops at the first failing step', async () => {
      const ran: string[][] = [];
      const transport: KeySequenceTransport = {
        run: async (args) => {
          ran.push(args);
          throw new Error('tmux is wedged');
        },
      };

      await expect(
        runKeySequence(TARGET, [literalStep('a'), literalStep('b')], transport)
      ).rejects.toThrow('tmux is wedged');
      expect(ran).toHaveLength(1);
    });

    it('renders a sequence unambiguously for a log line', () => {
      expect(describeKeySequence([keyStep('Escape'), literalStep('Escape')])).toEqual([
        'key:Escape',
        'text:Escape',
      ]);
    });
  });

  describe('sendKeys / sendKeySequence against the real tmux wrapper', () => {
    it('builds the literal argv through keySequenceArgs', async () => {
      await sendKeys(SESSION, 'Escape', false, { literal: true });

      expect(sendKeysInvocations()).toEqual([
        keySequenceArgs(exactTarget(SESSION), literalStep('Escape')),
      ]);
    });

    it('leaves the non-literal argv exactly as it was', async () => {
      await sendKeys(SESSION, 'unset CLAUDECODE', true);

      expect(sendKeysInvocations()).toEqual([
        ['send-keys', '-t', TARGET, 'unset CLAUDECODE', 'C-m'],
      ]);
    });

    /**
     * A `C-m` argument after `-l` would be typed as the three characters `C`,
     * `-`, `m`. Refusing is better than sending that, and no caller needs it:
     * body and Enter have been separate tmux commands since #1469.
     */
    it('refuses to batch Enter into a literal send', async () => {
      await expect(sendKeys(SESSION, 'hello', true, { literal: true })).rejects.toThrow(
        'cannot be combined with sendEnter'
      );
      expect(sendKeysInvocations()).toEqual([]);
    });

    it('drives a whole sequence through the execFile transport', async () => {
      await sendKeySequence(SESSION, [literalStep('/exit'), keyStep('Enter')]);

      expect(sendKeysInvocations()).toEqual([
        ['send-keys', '-t', TARGET, '-l', '--', '/exit'],
        ['send-keys', '-t', TARGET, '--', 'Enter'],
      ]);
    });
  });

  /**
   * The end-to-end pin: the production send path, with nothing stubbed but the
   * process spawn. If the body ever stops going out through `-l`, these fail.
   */
  describe('the message body the user typed (end to end)', () => {
    it.each(['Escape', 'C-c', 'Enter'])(
      'does not deliver a message body of %s as a key',
      async (body) => {
        await sendMessageWithSubmitVerification({
          sessionName: SESSION,
          message: body,
          cliToolId: 'gemini',
          textInputWaitMs: 0,
          verifyDelayMs: 0,
        });

        const sends = sendKeysInvocations();

        // The body is the FIRST send-keys of the run, and it is literal.
        expect(sends[0]).toEqual(['send-keys', '-t', TARGET, '-l', '--', body]);

        // The bare-positional shape — the one that made the body a keystroke —
        // appears exactly where it should: the deliberate Enter that submits,
        // and nowhere else. A body of `Enter` is the interesting case, because
        // before this Issue its two invocations were indistinguishable.
        const bare = sends.filter((argv) => !argv.includes('-l'));
        expect(bare).toEqual([['send-keys', '-t', TARGET, 'Enter']]);
      }
    );

    it('does not lose a message body that begins with a dash', async () => {
      await sendMessageWithSubmitVerification({
        sessionName: SESSION,
        message: '-l',
        cliToolId: 'gemini',
        textInputWaitMs: 0,
        verifyDelayMs: 0,
      });

      expect(sendKeysInvocations()).toContainEqual([
        'send-keys',
        '-t',
        TARGET,
        '-l',
        '--',
        '-l',
      ]);
    });

    it('still submits with a separate Enter key, never batched into the body', async () => {
      await sendMessageWithSubmitVerification({
        sessionName: SESSION,
        message: 'hello',
        cliToolId: 'gemini',
        textInputWaitMs: 0,
        verifyDelayMs: 0,
      });

      const sends = sendKeysInvocations();
      expect(sends[0]).toEqual(['send-keys', '-t', TARGET, '-l', '--', 'hello']);
      expect(sends[1]).toEqual(['send-keys', '-t', TARGET, 'Enter']);
      // No invocation carries body and submit together.
      expect(sends.some((argv) => argv.includes('hello') && argv.includes('C-m'))).toBe(false);
    });
  });
});
