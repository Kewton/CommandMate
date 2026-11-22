/**
 * A pane that draws late, for Issue #4555 (a resent Enter picking the `/model`
 * picker's rows on a slow codex).
 *
 * It stands in for the three tmux calls the shared sender makes
 * (`sendKeys`, `sendSpecialKeys`, `capturePane` of `@/lib/tmux/tmux`); the
 * sender itself runs unmocked. Every call is recorded as the tmux argv it
 * stands for, so a test counts the keys that went out after the first Enter.
 *
 * The pane, as measured on codex 0.171.0 and in the s10 server log:
 *   - before the body: `idleFrame`;
 *   - the body typed: `typedFrame` (the composer shows it);
 *   - the first Enter opens the command's picker (`openedFrame`), but captures
 *     keep returning `typedFrame` for `drawDelayMs` more — the stale frame
 *     rule D reads as "still typed". `drawDelayMs: null` is an Enter the pane
 *     ate: `typedFrame` to the end;
 *   - every later Enter lands in the picker and picks its highlighted row
 *     (`picks()` counts them), the harm the Issue reports.
 *
 * Driven by fake timers: `Date.now()` is the clock.
 */

/** One recorded tmux call, as the argv it stands for. */
export type FakeTmuxCall = string[];

export interface FakeSlowPaneOptions {
  /** The pane before the body is typed (and what the pre-send reads see). */
  idleFrame: string;
  /** The composer showing the typed body. */
  typedFrame: string;
  /** The picker or dialog the first Enter opened. */
  openedFrame: string;
  /** ms after the first Enter before a capture shows {@link openedFrame}; null: the Enter was eaten. */
  drawDelayMs: number | null;
  /**
   * With `drawDelayMs: null`: the Enter (1-based, the first one included) that
   * does submit — the #3366 shape, an Enter turned into a newline and the next
   * one sending the body. From it on, captures show {@link openedFrame}.
   */
  submitsOnEnter?: number;
}

export interface FakeSlowPane {
  sendKeys: (session: string, keys: string, sendEnter?: boolean, options?: unknown) => Promise<void>;
  sendSpecialKeys: (session: string, keys: string[]) => Promise<void>;
  capturePane: (session: string, arg?: unknown) => Promise<string>;
  /** Every recorded call, in order. */
  calls: () => FakeTmuxCall[];
  /** Enter presses, the first one included. */
  enters: () => number;
  /** `send-keys` calls (any key, or a body) after the first Enter. */
  keysAfterFirstEnter: () => FakeTmuxCall[];
  /** Enters that landed in the open picker and picked a row. */
  picks: () => number;
}

export function createFakeSlowPane(options: FakeSlowPaneOptions): FakeSlowPane {
  const { idleFrame, typedFrame, openedFrame, drawDelayMs } = options;
  const calls: FakeTmuxCall[] = [];
  let typed = false;
  let firstEnterAt: number | null = null;
  let firstEnterIndex = -1;
  let picks = 0;
  let enterCount = 0;
  let submittedLate = false;

  const opened = (): boolean => firstEnterAt !== null && drawDelayMs !== null;
  const drawn = (): boolean => opened() && Date.now() - (firstEnterAt as number) >= (drawDelayMs as number);

  return {
    async sendKeys(session, keys, sendEnter, opts) {
      const literal = (opts as { literal?: boolean } | undefined)?.literal === true;
      calls.push(['send-keys', '-t', session, ...(literal ? ['-l'] : []), keys, ...(sendEnter ? ['C-m'] : [])]);
      if (firstEnterAt === null) typed = true;
    },
    async sendSpecialKeys(session, keys) {
      calls.push(['send-keys', '-t', session, ...keys]);
      for (const key of keys) {
        if (key !== 'Enter') continue;
        enterCount += 1;
        if (options.submitsOnEnter !== undefined && enterCount === options.submitsOnEnter) submittedLate = true;
        if (firstEnterAt === null) {
          firstEnterAt = Date.now();
          firstEnterIndex = calls.length - 1;
        } else if (opened()) {
          // The picker is up whatever the capture shows: this Enter picks a row.
          picks += 1;
        }
      }
    },
    async capturePane(session, arg) {
      calls.push(['capture-pane', '-t', session, JSON.stringify(arg ?? null)]);
      if (!typed) return idleFrame;
      if (firstEnterAt === null) return typedFrame;
      return drawn() || submittedLate ? openedFrame : typedFrame;
    },
    calls: () => calls.slice(),
    enters: () => calls.filter((c) => c[0] === 'send-keys' && c.slice(3).includes('Enter')).length,
    keysAfterFirstEnter: () =>
      firstEnterIndex < 0 ? [] : calls.slice(firstEnterIndex + 1).filter((c) => c[0] === 'send-keys'),
    picks: () => picks,
  };
}
