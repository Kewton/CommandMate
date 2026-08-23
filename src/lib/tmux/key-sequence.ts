/**
 * The one place a {@link KeySequence} step becomes a `tmux send-keys` argv
 * (Issue #1933, 受入条件 S9).
 *
 * ## What was wrong
 *
 * `tmux send-keys` resolves its positional argument against the key table
 * before sending anything, and it parses its arguments with getopt. Neither
 * fact was accounted for anywhere in this repository: `grep -n "'-l'"
 * src/lib/tmux/*.ts` returned zero hits, and the user's message body is typed
 * with `sendKeys(sessionName, message, false)`.
 *
 * Measured on tmux 3.5a against a private socket (`tmux -L …`), reading the
 * bytes out of a pane running `cat` on a raw pty:
 *
 * | argv                                | bytes delivered              |
 * |-------------------------------------|------------------------------|
 * | `send-keys -t X 'Escape'`           | `1b`              (ESC key)  |
 * | `send-keys -t X -l -- 'Escape'`     | `457363617065` -> `Escape`   |
 * | `send-keys -t X 'Enter'`            | `0d`              (CR)       |
 * | `send-keys -t X -l -- 'Enter'`      | `456e746572`   -> `Enter`    |
 * | `send-keys -t X '-l'`               | **rc 0, nothing sent**       |
 * | `send-keys -t X '-N hello'`         | rc 1, `repeat count invalid` |
 * | `send-keys -t X -l -- '-l'`         | `2d6c`         -> `-l`       |
 *
 * So before this module a message whose body was exactly `Escape` interrupted
 * the agent, `Enter` submitted an empty composer, `C-c` sent SIGINT, and a body
 * beginning with `-` was silently discarded while the send reported success.
 *
 * ## Why `--` is on both branches
 *
 * The key branch takes a name from a five-value whitelist and could not
 * collide, but a fixed argv shape is cheaper to reason about than one that
 * changes with the payload, and the whitelist is re-checked here anyway (a
 * JavaScript caller or an `as` cast can put anything in a typed field).
 *
 * ## Why the builder is separate from the sending
 *
 * {@link keySequenceArgs} is pure, so the property S9 asks for — *literal text
 * always leaves through `-l`* — is pinned by inspecting an array rather than by
 * trusting a spy on a wrapper. {@link runKeySequence} is the executor and takes
 * its transport as a parameter, so a test drives the real sequencing (including
 * the per-step delays) against a stub. `sendKeys(…, { literal: true })` in
 * `./tmux` builds its argv here too, which is what makes the production
 * message-body path and the pinned property the same code.
 *
 * ## Why these take a target rather than a session name
 *
 * `exactTarget()` lives in `./tmux`, and `./tmux` imports this module. Taking
 * the already-resolved target keeps the dependency one-way instead of putting a
 * cycle underneath every tmux caller — including the suites that replace
 * `@/lib/tmux/tmux` with a factory mock, where a cycle would resolve
 * `exactTarget` to whatever the mock happened to declare.
 *
 * @module lib/tmux/key-sequence
 */

import { isKeySequenceKeyName, type KeySequence } from '@/types/cli-tool-contracts';

/**
 * The `tmux` arguments that send one step to a pane.
 *
 * @param target - An exact tmux target, i.e. `exactTarget(sessionName)`
 * @param step - The keystroke or the text
 * @returns Arguments for `execFile('tmux', …)` — never a shell string
 * @throws Error when a key step names a key outside `KEY_SEQUENCE_KEY_NAMES`
 *   (defense in depth against `as` casts and JavaScript callers)
 */
export function keySequenceArgs(target: string, step: KeySequence): string[] {
  if (step.kind === 'literal') {
    // `-l` stops the key-table lookup; `--` stops the getopt parse. Both are
    // required: without `-l` a body of `Escape` is the ESC key, and without
    // `--` a body of `-l` is consumed as a flag and nothing is sent at all.
    return ['send-keys', '-t', target, '-l', '--', step.text];
  }
  if (!isKeySequenceKeyName(step.name)) {
    throw new Error(`Invalid key sequence key name: ${step.name}`);
  }
  return ['send-keys', '-t', target, '--', step.name];
}

/**
 * What {@link runKeySequence} needs from the world.
 *
 * One method, so a caller can supply the real `execFile` wrapper, a control-mode
 * transport, or a recording stub without any of them knowing about the others.
 */
export interface KeySequenceTransport {
  /** Run one `tmux` invocation. Rejects when tmux does. */
  run(args: string[]): Promise<void>;
}

/** How a step's `delayAfterMs` is honoured. Injectable so tests need no timers. */
export type KeySequenceSleep = (ms: number) => Promise<void>;

const defaultSleep: KeySequenceSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Send a whole sequence, one tmux invocation per step.
 *
 * Never batched into a single `send-keys`: a TUI reading several keys out of one
 * write treats them as a paste and can swallow the trailing submit — measured on
 * opencode 1.18.21, where `send-keys '/exit' C-m` leaves the command palette
 * open with `/exit` still in the composer 10.8 s later, 2 runs out of 2 (#1905).
 *
 * A step's `delayAfterMs` is awaited before the next step and is never applied
 * after the last one.
 *
 * @param target - An exact tmux target, i.e. `exactTarget(sessionName)`
 * @param steps - The sequence, in order
 * @param transport - How one tmux invocation is run
 * @param sleep - How a `delayAfterMs` is waited out (defaults to `setTimeout`)
 */
export async function runKeySequence(
  target: string,
  steps: readonly KeySequence[],
  transport: KeySequenceTransport,
  sleep: KeySequenceSleep = defaultSleep
): Promise<void> {
  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index];
    await transport.run(keySequenceArgs(target, step));
    const delay = step.delayAfterMs;
    if (delay !== undefined && delay > 0 && index < steps.length - 1) {
      await sleep(delay);
    }
  }
}

/**
 * A sequence rendered for a log line or a test assertion.
 *
 * `key:Escape` / `text:/exit` — unambiguous because the prefix says which arm of
 * the union the value came from, which is exactly the distinction that was
 * missing from the code this Issue replaces.
 */
export function describeKeySequence(steps: readonly KeySequence[]): string[] {
  return steps.map((step) => (step.kind === 'literal' ? `text:${step.text}` : `key:${step.name}`));
}
