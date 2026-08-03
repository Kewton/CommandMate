/**
 * Issue #1623 — the two things reading mode is not allowed to change.
 *
 * The feature is only worth having if it is purely additive. Two invariants make
 * that concrete, and both are load-bearing for code far away from this feature:
 *
 * 1. **Pane geometry stays 200x1000 with `window-size manual`.** Issue #1163 put
 *    it there because alternate-screen TUIs have no scrollback (`alternate_on=1`,
 *    `history_size=0`, measured on live sessions), so the visible frame IS the
 *    history. Shrinking the window shrinks what `capture-pane` can ever return.
 * 2. **`capturePane` keeps asking for the same rows.** Auto-Yes, the status
 *    detector and the assistant-response saver all read that frame. A reading
 *    mode that quietly changed the request would trade "I can read it" for
 *    "detection stopped working".
 *
 * The rejected alternatives in the Issue — server-driven auto-pan, and delegating
 * geometry to the human's terminal — both broke one of these. The design that
 * shipped (an on-demand popup and a client-side squeeze) touches neither, and
 * this file is what keeps that true.
 *
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import { TUI_PANE_HEIGHT, TUI_PANE_WIDTH } from '@/config/tmux-pane-config';
import { capturePane, reconcileSessionGeometry } from '@/lib/tmux/tmux';
import { PAGER_SCRIPT } from '@/lib/tmux/read-mode-pager';

vi.mock('child_process', () => ({ execFile: vi.fn() }));

const REPO_ROOT = path.resolve(__dirname, '../../../..');

/** Every tmux argv seen, so a test can assert on what was NOT issued too. */
function captureTmuxCalls(stdoutFor: (argv: string[]) => string = () => ''): string[][] {
  const calls: string[][] = [];
  vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
    const argv = args[1] as string[];
    calls.push(argv);
    const callback = args[args.length - 1] as (
      err: Error | null,
      result?: { stdout: string; stderr: string }
    ) => void;
    callback(null, { stdout: stdoutFor(argv), stderr: '' });
    return {} as ReturnType<typeof execFile>;
  });
  return calls;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('geometry is untouched by Issue #1623', () => {
  it('keeps the #1163 canvas at 200x1000', () => {
    expect(TUI_PANE_WIDTH).toBe(200);
    expect(TUI_PANE_HEIGHT).toBe(1000);
  });

  it('still pins window-size manual and resizes to exactly that canvas', async () => {
    // A stale session reporting the wrong mode/size, so both branches run.
    const calls = captureTmuxCalls((argv) =>
      argv[0] === 'show-window-options' ? 'latest' : '80|24'
    );

    await reconcileSessionGeometry('mcbd-claude-wt');

    expect(calls).toContainEqual([
      'set-window-option',
      '-t',
      '=mcbd-claude-wt:',
      'window-size',
      'manual',
    ]);
    expect(calls).toContainEqual([
      'resize-window',
      '-t',
      '=mcbd-claude-wt:',
      '-x',
      '200',
      '-y',
      '1000',
    ]);
  });

  it('is a no-op when the session already has the canvas', async () => {
    const calls = captureTmuxCalls((argv) =>
      argv[0] === 'show-window-options' ? 'manual' : '200|1000'
    );

    expect(await reconcileSessionGeometry('mcbd-claude-wt')).toBe(false);
    expect(calls.some((argv) => argv[0] === 'resize-window')).toBe(false);
    expect(calls.some((argv) => argv[0] === 'set-window-option')).toBe(false);
  });
});

describe('capture-pane requests are unchanged by Issue #1623', () => {
  it('asks for the same 1000 rows the detection pipeline reads', async () => {
    const calls = captureTmuxCalls();
    await capturePane('mcbd-claude-wt', 1000);

    expect(calls[0]).toEqual([
      'capture-pane',
      '-t',
      '=mcbd-claude-wt:',
      '-p',
      '-e',
      '-S',
      '-1000',
      '-E',
      '-',
    ]);
  });

  it('reads the pane, never writes to it', async () => {
    const calls = captureTmuxCalls();
    await capturePane('mcbd-claude-wt', 1000);

    // `-p` prints to stdout. `-P`/`-b` would divert into a tmux buffer, and
    // anything that is not capture-pane has no business on this path at all.
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe('capture-pane');
    expect(calls[0]).toContain('-p');
    expect(calls[0]).not.toContain('-P');
  });

  it('the CLI viewer asks the capture route for exactly those 1000 rows', () => {
    // `--pane` deliberately exposes no `--lines`: the viewer makes the same
    // request as everything else so the server has no reason to behave
    // differently because a human is reading.
    const source = fs.readFileSync(
      path.join(REPO_ROOT, 'src/cli/commands/capture.ts'),
      'utf-8'
    );
    expect(source).toContain('const PANE_CAPTURE_LINES = 1000;');
    expect(source).toContain('lines: PANE_CAPTURE_LINES');
  });
});

describe('the reading-mode modules issue no state-changing tmux command', () => {
  /** Verbs that would alter the pane, the session, or the server. */
  const FORBIDDEN = [
    'resize-window',
    'resize-pane',
    'set-window-option',
    'window-size',
    'respawn-pane',
    'respawn-window',
    'new-window',
    'kill-',
    'send-keys',
    'set-option',
  ];

  it.each([
    'src/lib/tmux/transcript-squeeze.ts',
    'src/lib/tmux/read-mode-pager.ts',
    'src/lib/tmux/read-mode.ts',
  ])('%s names none of them', (relPath) => {
    const source = fs.readFileSync(path.join(REPO_ROOT, relPath), 'utf-8');
    // Deliberately a plain substring scan, comments included. These modules have
    // no legitimate reason to name a mutating verb even in prose, so "explain it
    // in a comment" is not an escape hatch — adding one fails here and forces the
    // change to be argued for. `bind-key`/`unbind-key` are absent from the list
    // because they ARE the feature; every guard around them lives in read-mode.test.ts.
    const found = FORBIDDEN.filter((verb) => source.includes(verb));
    expect(found).toEqual([]);
  });

  it('the popup script only ever reads the pane', () => {
    expect(PAGER_SCRIPT).toContain('capture-pane -pe');
    for (const verb of FORBIDDEN) {
      expect(PAGER_SCRIPT, verb).not.toContain(verb);
    }
    // display-popup is per-client and disappears on detach, so it leaves no
    // session state behind either.
    expect(PAGER_SCRIPT).not.toContain('resize');
  });

  it('the popup reads the same depth the app does', () => {
    expect(PAGER_SCRIPT).toContain('CM_READ_LINES:-1000');
  });
});
