/**
 * Issue #2310 — a codex dialog is a dialog whatever its footer says.
 *
 * The defect: `detect.ts` recognised a codex dialog by the words in its footer
 * (`press enter to confirm` / `press enter to select`). Every dialog closing
 * with any other sentence fell through to the branches that read `^›` as the
 * idle composer, and those publish `ready` — so a session blocked on a keypress
 * reported itself finished, Auto-Yes saw nothing to answer and `commandmate
 * wait` closed on `scraper_ready` mid-task.
 *
 * The suite is built around two LIVE captures of exactly that (codex-cli
 * 0.153.2, 200x1000 — see `fixtures/codex-live-2310/README.md`), and around the
 * frames a fix must not disturb: the idle composer, the composer holding
 * hand-typed text that looks like an option, a generating turn, and the dialogs
 * that already resolved.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { detectSessionStatus } from '@/lib/detection/status-detector';
import { stripAnsi, CODEX_SELECTION_LIST_PATTERN } from '@/lib/detection/cli-patterns';
import { STATUS_REASON } from '@/lib/detection/status-reason';
import {
  CODEX_DIALOG_FOOTER_PATTERN,
  CODEX_DIALOG_RULES_VERIFIED_AGAINST,
  findCodexBottomGlyphRow,
  readCodexDialogFrame,
  readCodexGlyphRowKind,
  resetCodexDialogFooterDriftForTests,
} from '@/lib/detection/tools/codex/cli-patterns';

const FIXTURES = join(__dirname, 'fixtures');
const LIVE_1628 = join(FIXTURES, 'codex-live-1628');
const LIVE_1890 = join(FIXTURES, 'codex-live-1890');
/**
 * #2310's own captures live under `tests/fixtures/`, not beside the older
 * detection frames. `tests/unit/polling/auto-yes-dialog-gate.test.ts` walks
 * `tests/unit/lib/detection/fixtures/` whole and pins the answerable dialogs it
 * finds there by name, so adding two more numbered dialogs to that tree would
 * have edited that suite's control list as a side effect of capturing a frame.
 * `tests/fixtures/` is where the other live corpora already sit
 * (`command-code-live-2250/`, `canary/`, `chat-dialog-card-2254/`).
 */
const LIVE_2310 = join(__dirname, '../../../fixtures/codex-live-2310');

const read = (dir: string, name: string): string => readFileSync(join(dir, `${name}.txt`), 'utf-8');

/** The row of `frame` whose first rendered glyph is `›`, searched from the bottom. */
function bottomGlyphRow(frame: string): string {
  const index = findCodexBottomGlyphRow(frame)?.row;
  if (index === undefined) throw new Error('no › row in this frame');
  return frame.split('\n')[index];
}

beforeEach(() => {
  resetCodexDialogFooterDriftForTests();
});

// ---------------------------------------------------------------------------
// The fixtures are raw. If this fails, nothing else in the file means anything.
// ---------------------------------------------------------------------------

describe('[#2310] the live captures still carry their attributes', () => {
  const raw = [
    'dialog-experimental-toggles',
    'dialog-keymap-editor',
    'dialog-permissions-picker',
    'dialog-trust-directory',
    'idle-composer',
    'turn-running',
  ];

  it.each(raw)('%s is stored with ANSI intact', name => {
    const frame = read(LIVE_2310, name);
    expect(frame).toContain('\x1b[');
    // 200x1000: the pane the production capture uses. A re-capture at the
    // default geometry would not reproduce the leak this suite pins.
    // 1000 rows plus the trailing newline's empty tail.
    expect(frame.split('\n').length).toBe(1001);
  });
});

// ---------------------------------------------------------------------------
// The defect.
// ---------------------------------------------------------------------------

describe('[#2310] a dialog whose footer is outside the whitelist is `waiting`', () => {
  const leaking = [
    { name: 'dialog-experimental-toggles', footer: 'Press space to select or enter to save' },
    { name: 'dialog-keymap-editor', footer: 'esc close' },
  ] as const;

  it.each(leaking)('$name does not publish `ready`', ({ name }) => {
    const frame = read(LIVE_2310, name);
    const result = detectSessionStatus(frame, 'codex');

    expect(result.status).toBe('waiting');
    expect(result.reason).toBe(STATUS_REASON.CODEX_SELECTION_LIST);
    expect(result.status).not.toBe('ready');
  });

  it.each(leaking)('$name really is outside the old footer whitelist', ({ name, footer }) => {
    const frame = stripAnsi(read(LIVE_2310, name));
    // Positive control on the assertion below: the footer this frame ends on is
    // on screen, and `CODEX_SELECTION_LIST_PATTERN` does not match it. Without
    // both halves "the whitelist missed it" is an untested claim about a regex.
    expect(frame).toContain(footer);
    expect(CODEX_SELECTION_LIST_PATTERN.test(frame)).toBe(false);
  });

  it('neither leaking list is numbered, so the numbered-block reading cannot save it', () => {
    for (const { name } of leaking) {
      const lines = stripAnsi(read(LIVE_2310, name)).split('\n');
      const byBlock = readCodexDialogFrame('', lines, lines.length);
      expect(byBlock).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// Mutation injection: the verdict is driven by the attributes, not by luck.
// ---------------------------------------------------------------------------

describe('[#2310] taking the dialog attributes away puts the frame back to `ready`', () => {
  /**
   * Redraw the highlighted row as codex draws its COMPOSER — bold glyph, plain
   * label — leaving every other byte, the footer included, untouched.
   *
   * A structure-preserving mutation on purpose: the row keeps its glyph, its
   * text, its position and its siblings, so a `waiting` that survived it would
   * be resting on something other than the rule under test, and the `ready` it
   * produces is the pre-#2310 defect reproduced on demand.
   */
  function unhighlight(frame: string): string {
    const row = bottomGlyphRow(frame);
    const composerShaped = `\x1b[1m›\x1b[0m${stripAnsi(row).slice(1)}`;
    return frame.replace(row, composerShaped);
  }

  it.each(['dialog-experimental-toggles', 'dialog-keymap-editor'])(
    '%s reverts to `ready` once its row looks like the composer',
    name => {
      const frame = read(LIVE_2310, name);
      expect(detectSessionStatus(frame, 'codex').status).toBe('waiting');

      const mutated = unhighlight(frame);
      expect(readCodexGlyphRowKind(bottomGlyphRow(mutated))).toBe('composer');
      expect(detectSessionStatus(mutated, 'codex').status).toBe('ready');
    },
  );

  it('the numbered reading is vetoed by the same attributes', () => {
    // A numbered dialog has a second reader above this one (the shared chain's
    // `detectPrompt` still parses its options), so unhighlighting it does not
    // move the published status and cannot demonstrate anything about THIS
    // rule. The claim is therefore made where it lives: the block reader must
    // withdraw when the attributes say the row is the composer — otherwise it
    // would adopt any numbered list it can see, which is how a composer holding
    // `1. buy milk` becomes a dialog.
    const frame = read(LIVE_2310, 'dialog-permissions-picker');
    const lines = stripAnsi(frame).split('\n');
    let end = lines.length;
    while (end > 0 && lines[end - 1].trim() === '') end--;
    const content = lines.slice(0, end);

    expect(readCodexDialogFrame(frame, content, end)?.by).toBe('glyph');
    // With the glyph rule silenced, the numbered block is what answers…
    expect(readCodexDialogFrame('', content, end)?.by).toBe('numbered-block');
    // …and the attributes take it back.
    const mutated = unhighlight(frame);
    expect(readCodexGlyphRowKind(bottomGlyphRow(mutated))).toBe('composer');
    expect(readCodexDialogFrame(mutated, content, end)).toBeNull();
  });

  it('removing the footer entirely changes nothing — the rule never read it', () => {
    for (const name of ['dialog-experimental-toggles', 'dialog-keymap-editor']) {
      const frame = read(LIVE_2310, name);
      const lines = frame.split('\n');
      const glyphRow = findCodexBottomGlyphRow(frame)!.row;
      // Blank every non-empty row below the highlighted one, i.e. delete the
      // footer without moving anything above it.
      const footerless = lines
        .map((line, i) => (i > glyphRow ? '' : line))
        .join('\n');

      expect(detectSessionStatus(footerless, 'codex').status).toBe('waiting');
    }
  });
});

// ---------------------------------------------------------------------------
// The acceptance criterion's synthetic footers, on a real numbered dialog.
// ---------------------------------------------------------------------------

describe('[#2310] a numbered `› 1. …` block stays `waiting` under any footer', () => {
  const REAL_FOOTER = 'Press enter to confirm or esc to go back';
  const rewordings = [
    { label: 'Press t to …', footer: 'Press t to view details' },
    { label: 'esc to close', footer: 'esc to close' },
    { label: 'esc to dismiss', footer: 'esc to dismiss' },
  ] as const;

  it.each(rewordings)('$label', ({ footer }) => {
    const frame = read(LIVE_2310, 'dialog-permissions-picker').replace(REAL_FOOTER, footer);
    expect(CODEX_SELECTION_LIST_PATTERN.test(stripAnsi(frame))).toBe(false);

    const result = detectSessionStatus(frame, 'codex');
    expect(result.status).toBe('waiting');
  });

  it('no footer at all', () => {
    const frame = read(LIVE_2310, 'dialog-permissions-picker').replace(
      new RegExp(`\\n[^\\n]*${REAL_FOOTER}[^\\n]*`),
      '',
    );
    expect(CODEX_SELECTION_LIST_PATTERN.test(stripAnsi(frame))).toBe(false);
    expect(detectSessionStatus(frame, 'codex').status).toBe('waiting');
  });
});

// ---------------------------------------------------------------------------
// The frames that already resolved must resolve the same way.
// ---------------------------------------------------------------------------

describe('[#2310] the dialogs that already worked are unchanged', () => {
  it.each(['approval-run-command', 'approval-apply-patch'])(
    '%s is still an active prompt (#1628)',
    name => {
      const result = detectSessionStatus(read(LIVE_1628, name), 'codex');
      expect(result.status).toBe('waiting');
      expect(result.reason).toBe(STATUS_REASON.PROMPT_DETECTED);
      expect(result.hasActivePrompt).toBe(true);
    },
  );

  it.each(['model-picker-step1', 'model-picker-step2'])('%s is still a selection list', name => {
    const result = detectSessionStatus(read(LIVE_1628, name), 'codex');
    expect(result.status).toBe('waiting');
    expect(result.reason).toBe(STATUS_REASON.CODEX_SELECTION_LIST);
    expect(result.hasActivePrompt).toBe(false);
  });

  it('the /permissions picker keeps its whitelisted-footer verdict', () => {
    const result = detectSessionStatus(read(LIVE_2310, 'dialog-permissions-picker'), 'codex');
    expect(result.reason).toBe(STATUS_REASON.CODEX_SELECTION_LIST);
  });

  it('the trust dialog keeps `hasActivePrompt` (exit 10 for `wait --on-prompt agent`)', () => {
    const result = detectSessionStatus(read(LIVE_2310, 'dialog-trust-directory'), 'codex');
    expect(result.status).toBe('waiting');
    expect(result.reason).toBe(STATUS_REASON.PROMPT_DETECTED);
    expect(result.hasActivePrompt).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The negative controls. An over-eager `waiting` is the #1883 defect.
// ---------------------------------------------------------------------------

describe('[#2310] a genuine composer is never `waiting`', () => {
  it('the live 0.153.2 idle composer is `ready`', () => {
    const result = detectSessionStatus(read(LIVE_2310, 'idle-composer'), 'codex');
    expect(result.status).toBe('ready');
    expect(result.reason).toBe(STATUS_REASON.INPUT_PROMPT);
  });

  it('a turn in flight is `running`, not `waiting` — its composer is still drawn', () => {
    const result = detectSessionStatus(read(LIVE_2310, 'turn-running'), 'codex');
    expect(result.status).toBe('running');
  });

  it('a composer holding the hand-typed text `1. buy milk` is still `ready`', () => {
    // The frame that rules out "a › followed by a digit and a dot is an option".
    const frame = read(LIVE_1890, 'composer-residual-leading-number');
    expect(stripAnsi(frame)).toContain('1. buy milk');
    expect(detectSessionStatus(frame, 'codex').status).toBe('ready');
  });

  it.each([
    'composer-placeholder-ask',
    'composer-residual-plain',
    'composer-residual-slash',
  ])('%s is still `ready`', name => {
    expect(detectSessionStatus(read(LIVE_1890, name), 'codex').status).toBe('ready');
  });

  it('the 0.148.0 idle frame is still `ready`', () => {
    expect(detectSessionStatus(read(LIVE_1628, 'idle-ready'), 'codex').status).toBe('ready');
  });
});

// ---------------------------------------------------------------------------
// `wait`'s false completion — the reason the `ready` mattered.
// ---------------------------------------------------------------------------

describe('[#2310] `wait` cannot close on `scraper_ready` while a dialog is up', () => {
  /**
   * `src/cli/commands/wait.ts`'s completion gate, restated.
   *
   * The command polls `/api/.../current-output` and completes with
   * `basis=scraper_ready` when `sessionStatus === 'ready'` and the frame was
   * classified. Both fields come from `detectSessionStatus`, so the gate can be
   * asked of a frame directly — which is what makes this a regression test for
   * the false completion rather than for the detector alone.
   */
  const scraperReadyGateOpens = (frame: string): boolean =>
    detectSessionStatus(frame, 'codex').status === 'ready';

  it.each([
    'dialog-experimental-toggles',
    'dialog-keymap-editor',
    'dialog-permissions-picker',
    'dialog-trust-directory',
  ])('%s does not open the gate', name => {
    expect(scraperReadyGateOpens(read(LIVE_2310, name))).toBe(false);
  });

  it('an idle session still opens it — the gate is not simply nailed shut', () => {
    expect(scraperReadyGateOpens(read(LIVE_2310, 'idle-composer'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The row reader itself.
// ---------------------------------------------------------------------------

describe('[#2310] readCodexGlyphRowKind tells codex three `›` uses apart', () => {
  const rows = [
    { kind: 'composer', row: '\x1b[1m›\x1b[0m \x1b[2mAsk Codex to do anything\x1b[0m' },
    { kind: 'composer', row: '\x1b[1m›\x1b[0m echo PREFILLED' },
    { kind: 'composer', row: '\x1b[1m›\x1b[0m 1. buy milk' },
    { kind: 'transcript-echo', row: '\x1b[1;2m› \x1b[0mCreate a file scripts/greet.sh' },
    { kind: 'option', row: '\x1b[1m\x1b[38;5;6m› 1. Yes, proceed (y)\x1b[0m' },
    { kind: 'option', row: '\x1b[1m\x1b[38;5;6m› [ ] Network proxy   Apply network proxy…\x1b[0m' },
    { kind: 'option', row: '\x1b[38;5;6m› 1. Yes, continue\x1b[39m' },
  ] as const;

  it.each(rows)('reads $kind', ({ kind, row }) => {
    expect(readCodexGlyphRowKind(row)).toBe(kind);
  });

  it('a row whose attributes have been stripped answers `null`, not a guess', () => {
    // Auto-Yes hands the layer a capture that has already been through
    // stripAnsi. Answering `option` there would call an idle composer waiting.
    expect(readCodexGlyphRowKind('› 1. Yes, proceed (y)')).toBeNull();
    expect(readCodexGlyphRowKind('› Ask Codex to do anything')).toBeNull();
  });

  it('is not fooled by the `2` inside a 256-colour introducer', () => {
    // ESC[38;5;2m is "foreground = palette colour 2". A scan that read the 2 as
    // SGR 2 would mark the row dim and report every dialog as a transcript echo.
    expect(readCodexGlyphRowKind('\x1b[1m\x1b[38;5;2m› 1. Yes\x1b[0m')).toBe('option');
  });

  it('ignores a row that does not open with the glyph', () => {
    expect(readCodexGlyphRowKind('\x1b[1m  Select Model\x1b[0m')).toBeNull();
  });

  it('reads the BOTTOM-most glyph row, so an answered dialog above a composer loses', () => {
    const frame = [
      '\x1b[1m\x1b[38;5;6m› 1. Yes, proceed (y)\x1b[0m',
      '  2. No',
      '',
      '\x1b[1m›\x1b[0m \x1b[2mAsk Codex to do anything\x1b[0m',
    ].join('\n');
    expect(findCodexBottomGlyphRow(frame)?.kind).toBe('composer');
  });
});

// ---------------------------------------------------------------------------
// The footer vocabulary is a tripwire, not a gate.
// ---------------------------------------------------------------------------

describe('[#2310] CODEX_DIALOG_FOOTER_PATTERN covers every measured footer', () => {
  const footers = [
    'Press enter to confirm or esc to cancel',
    'Press enter to confirm or esc to go back',
    'Press enter to continue',
    'Press t to trust all; enter to review hooks; esc to close',
    'Press t to trust; esc to go back',
    'Press space to select or enter to save for next conversation',
    'left/right group · enter edit shortcut · * custom · - unbound · esc close',
  ];

  it.each(footers)('recognises %s', footer => {
    expect(CODEX_DIALOG_FOOTER_PATTERN.test(footer)).toBe(true);
  });

  it('does not match ordinary transcript prose', () => {
    expect(CODEX_DIALOG_FOOTER_PATTERN.test('Created scripts/greet.sh and staged it.')).toBe(false);
  });

  it('the recognised footers of the live frames are reported as recognised', () => {
    for (const name of ['dialog-experimental-toggles', 'dialog-keymap-editor']) {
      const frame = read(LIVE_2310, name);
      const lines = stripAnsi(frame).split('\n');
      let end = lines.length;
      while (end > 0 && lines[end - 1].trim() === '') end--;
      const dialog = readCodexDialogFrame(frame, lines.slice(0, end), end);
      expect(dialog).not.toBeNull();
      expect(dialog?.footerRecognised).toBe(true);
    }
  });

  it('stamps the build these rules were read off', () => {
    expect(CODEX_DIALOG_RULES_VERIFIED_AGAINST).toEqual({
      version: '0.153.2',
      capturedAt: '2026-09-04',
      paneGeometry: '200x1000',
    });
  });
});

// ---------------------------------------------------------------------------
// What the fix does NOT reach, said out loud.
// ---------------------------------------------------------------------------

describe('[#2310] the limit of the attribute rule is pinned, not discovered', () => {
  it('an ANSI-stripped capture of an UNNUMBERED dialog still reads `ready`', () => {
    // Both readings need something: the attributes, or the numbers. `/keymap`
    // and `/experimental` have neither once ANSI is gone. That path is Auto-Yes's
    // `captureAndCleanOutput`, which publishes no session status — but a future
    // caller that strips first would get the pre-#2310 answer, and should be
    // able to read that here rather than find it out.
    for (const name of ['dialog-experimental-toggles', 'dialog-keymap-editor']) {
      const stripped = stripAnsi(read(LIVE_2310, name));
      expect(detectSessionStatus(stripped, 'codex').status).toBe('ready');
    }
  });

  it('an ANSI-stripped capture of a NUMBERED dialog is still `waiting`', () => {
    for (const name of ['dialog-permissions-picker', 'dialog-trust-directory']) {
      const stripped = stripAnsi(read(LIVE_2310, name));
      expect(detectSessionStatus(stripped, 'codex').status).toBe('waiting');
    }
  });
});
