/**
 * Issue #1895: copilot 1.0.80's pickers were invisible, and its prose was not.
 *
 * `COPILOT_SELECTION_LIST_PATTERN` looked for `Search \w+...`, `Select Model`,
 * and `to navigate … Enter to select|confirm`. Against the eleven pickers 1.0.80
 * opens it matched **none** — `/model` renders `❯  Search models…` with U+2026,
 * no picker prints the words `Select Model`, and every footer spells its verbs
 * in lower case. So `/model` fell through to the `running`/`default` floor: no
 * NavigationButtons, a sidebar glow on a screen that was waiting for a human,
 * and `cmate wait` polling to its timeout against an open picker.
 *
 * The same pattern matched copilot's own answer text. The 30-row window it ran
 * against is 30 rows of a frame whose ~950 blank padding rows
 * `normalizeTuiFrameForDetection` collapses to one, so the transcript is inside
 * it, and a reply that merely mentioned "Select Model" published the finished
 * turn as `waiting`/`copilot_selection_list`.
 *
 * The fix is positional, and it is the same measurement Issue #1885 rests on: a
 * picker is what copilot draws **instead of** its bottom chrome. Idle or
 * generating, the bottom row is a status bar; while a picker is up, that row is
 * the picker's key-hint footer and the composer is gone. So
 * {@link isCopilotSelectionFrame} reads the bottom of the pane and never the
 * transcript, and it declines any frame `readCopilotStatusBar` can still speak
 * about — which is what settles the order between the two branches.
 *
 * Every frame is a live `tmux capture-pane -p -e` of copilot 1.0.80 at the
 * production 200x1000 geometry; see
 * `lib/detection/fixtures/copilot-picker-1895/README.md` for provenance. They
 * are raw on purpose and the first test guards that.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { detectPrompt, resetDetectPromptCache } from '@/lib/detection/prompt-detector';
import { detectSessionStatus, STATUS_REASON } from '@/lib/detection/status-detector';
import {
  buildDetectPromptOptions,
  isCopilotSelectionFrame,
  readCopilotStatusBar,
  stripAnsi,
  stripBoxDrawing,
  COPILOT_SELECTION_FOOTER_PATTERN,
} from '@/lib/detection/cli-patterns';
import {
  buildCopilotFolderTrustFrame,
  buildCopilotReadyFrame,
} from '../fixtures/copilot-folder-trust-1080';

const PICKER_DIR = path.resolve(
  __dirname,
  'lib/detection/fixtures/copilot-picker-1895',
);
const LIVE_1885_DIR = path.resolve(
  __dirname,
  'lib/detection/fixtures/copilot-live-1885',
);

function pickerFrame(name: string): string {
  return fs.readFileSync(path.join(PICKER_DIR, `${name}.txt`), 'utf-8');
}

function liveFrame(name: string): string {
  return fs.readFileSync(path.join(LIVE_1885_DIR, `${name}.txt`), 'utf-8');
}

/** Every frame captured for this Issue, plus /model's picture from #1885. */
const ALL_FRAMES: readonly { name: string; read: () => string }[] = [
  { name: 'model-picker (copilot-live-1885)', read: () => liveFrame('model-picker') },
  { name: 'picker-agent', read: () => pickerFrame('picker-agent') },
  { name: 'picker-theme', read: () => pickerFrame('picker-theme') },
  { name: 'picker-permissions', read: () => pickerFrame('picker-permissions') },
  { name: 'picker-skills', read: () => pickerFrame('picker-skills') },
  { name: 'picker-mcp', read: () => pickerFrame('picker-mcp') },
  { name: 'picker-statusline', read: () => pickerFrame('picker-statusline') },
  { name: 'picker-subagents', read: () => pickerFrame('picker-subagents') },
  { name: 'picker-vocabulary-in-response', read: () => pickerFrame('picker-vocabulary-in-response') },
  { name: 'model-arg-immediate', read: () => pickerFrame('model-arg-immediate') },
];

/** The pickers that must surface as a navigable list, not as a prompt. */
const NAVIGABLE_PICKERS = [
  'picker-agent',
  'picker-theme',
  'picker-skills',
  'picker-mcp',
  'picker-statusline',
  'picker-subagents',
] as const;

/** The frames that must NOT read as a picker. */
const NON_PICKER_FRAMES: readonly { name: string; read: () => string }[] = [
  { name: 'picker-vocabulary-in-response', read: () => pickerFrame('picker-vocabulary-in-response') },
  { name: 'model-arg-immediate', read: () => pickerFrame('model-arg-immediate') },
  { name: 'boot-idle', read: () => liveFrame('boot-idle') },
  { name: 'turn-complete', read: () => liveFrame('turn-complete') },
  { name: 'turn-running-early', read: () => liveFrame('turn-running-early') },
  { name: 'turn-running-thinking', read: () => liveFrame('turn-running-thinking') },
  { name: 'status-vocabulary-in-response', read: () => liveFrame('status-vocabulary-in-response') },
  { name: 'permission-dialog', read: () => liveFrame('permission-dialog') },
];

/**
 * The bottom-most row of each of the eleven pickers copilot 1.0.80 opens,
 * transcribed from the capture session described in the fixture README.
 *
 * Eight of the eleven have their whole frame committed next door. `/settings`,
 * `/resume` and `/session` do not: those screens render the operator's own
 * configuration, session titles and paths from unrelated repositories. Their
 * footer is the half any pattern reads, so it is pinned here instead.
 */
const MEASURED_PICKER_FOOTERS: readonly [string, string][] = [
  ['/model', ' ↑/↓ to navigate · ←/→ reasoning effort · tab context window · shift+tab group: recommended · enter to select · esc to cancel'],
  ['/agent', ' n new agent · ? learn more · esc cancel'],
  ['/theme', ' ↑/↓ to navigate · enter to select · esc to cancel'],
  ['/permissions', '1-2 to select · ↑/↓ to navigate · enter to confirm · esc to cancel'],
  ['/skills', '↑/↓ to navigate · enter to toggle · esc to close'],
  ['/mcp', ' ↑/↓ to select · enter to show · a to add · esc to close'],
  ['/settings', ' / search · ↑/↓ navigate · tab switch scope · enter edit · ctrl+r reset · ctrl+e editor · esc close'],
  ['/statusline', ' ↑/↓ nav · enter toggle · esc close'],
  ['/subagents', ' ↑/↓ to navigate · space on/off · r reset · enter to select · esc to cancel'],
  ['/resume', ' / search · ↑/↓ navigate · enter select · ←/→ switch tabs · r refresh · x delete · s sort:relevance · esc cancel'],
  ['/session', '/ search · ↑/↓ navigate · enter open · n new · tab switch tabs · a filter:all'],
];

/**
 * The pattern this Issue replaced, kept verbatim so the two directions of the
 * bug stay measurable rather than remembered. Nothing in `src/` reads it.
 */
const LEGACY_SELECTION_LIST_PATTERN =
  /Search\s+\w+\.\.\.|Select\s+Model|to (?:navigate|select).*Enter to (?:select|confirm)/m;

/** The Auto-Yes entry point, spelled exactly as `response-checker` spells it. */
function autoYesPromptOf(raw: string) {
  return detectPrompt(
    stripBoxDrawing(stripAnsi(raw)),
    buildDetectPromptOptions('copilot'),
  );
}

/** ANSI-stripped pane rows, the shape both detection helpers take. */
function rowsOf(raw: string): string[] {
  return stripAnsi(raw).split('\n');
}

/**
 * Reword the picker footer in the BOTTOM of the pane only, leaving every other
 * byte — including the same phrase where copilot printed it as body text —
 * untouched.
 *
 * This is the non-vacuity mutation for the whole suite: it is how these tests
 * prove the footer row is load-bearing, and that no other branch quietly
 * re-derives `copilot_selection_list` from the same words further up the pane.
 * `navigate`/`select`/`nav` are left alone on purpose — only the two tokens the
 * pattern actually requires are removed.
 */
function withoutPickerFooter(raw: string): string {
  const rows = raw.split('\n');
  let scanned = 0;
  for (let i = rows.length - 1; i >= 0 && scanned < 3; i--) {
    if (rows[i].trim() === '') continue;
    scanned++;
    rows[i] = rows[i].split('↑').join('UP').split('esc').join('quit');
  }
  return rows.join('\n');
}

describe('Issue #1895: copilot picker fixtures are raw live captures', () => {
  it('keeps the ANSI and the pane geometry every assertion below depends on', () => {
    for (const { name, read } of ALL_FRAMES) {
      const raw = read();
      expect(raw, `${name} lost its escape sequences`).toContain('\x1b[');
      // 200x1000 is the production geometry for copilot (design §4 D2). The
      // whole detector is "the bottom of the pane is not the transcript", which
      // a frame re-captured at a default pane height would not reproduce.
      expect(
        raw.split('\n').length,
        `${name} is not a full-height (200x1000) frame`,
      ).toBeGreaterThanOrEqual(1000);
    }
  });

  it('still carries the trap text the false-positive test needs', () => {
    // Without this, "the response frame is not a picker" could pass because the
    // fixture stopped containing the vocabulary rather than because the detector
    // stopped reading it.
    const clean = stripAnsi(pickerFrame('picker-vocabulary-in-response'));
    expect(clean).toContain('Select Model dialog');
    expect(clean).toContain('Search models... field');
    expect(clean).toContain('↑/↓ to navigate · enter to select · esc to cancel');
  });
});

describe('Issue #1895: the pattern that was there matched the wrong frames', () => {
  it('missed every one of the eleven live pickers', () => {
    // The `Enter`/`...`/`Select Model` spellings it required are not on any
    // 1.0.80 picker. Independently measured three times (#1885 / #1886 / #1913).
    for (const [command, footer] of MEASURED_PICKER_FOOTERS) {
      expect(
        LEGACY_SELECTION_LIST_PATTERN.test(footer),
        `${command} footer unexpectedly matched the legacy pattern`,
      ).toBe(false);
    }
    for (const name of NAVIGABLE_PICKERS) {
      const clean = stripAnsi(pickerFrame(name));
      expect(
        LEGACY_SELECTION_LIST_PATTERN.test(clean),
        `${name} unexpectedly matched the legacy pattern`,
      ).toBe(false);
    }
  });

  it('matched copilot answering a question about the picker', () => {
    // The other direction, live: this is a finished turn, and the legacy pattern
    // is why it was published as `waiting`/`copilot_selection_list`.
    const clean = stripAnsi(pickerFrame('picker-vocabulary-in-response'));
    expect(LEGACY_SELECTION_LIST_PATTERN.test(clean)).toBe(true);
  });
});

describe('COPILOT_SELECTION_FOOTER_PATTERN', () => {
  it('matches all eleven measured picker footers', () => {
    for (const [command, footer] of MEASURED_PICKER_FOOTERS) {
      expect(
        COPILOT_SELECTION_FOOTER_PATTERN.test(footer),
        `${command} footer was not recognised`,
      ).toBe(true);
    }
  });

  it('does not match either rendering of copilot\'s own status bar', () => {
    // These are the two states `readCopilotStatusBar` names, and they occupy the
    // same row as a picker footer. Overlap here would make the ordering in
    // `isCopilotSelectionFrame` load-bearing instead of merely tidy.
    expect(COPILOT_SELECTION_FOOTER_PATTERN.test(
      ' ← open sidebar · / commands · ? help · tab next tab                    GPT-5.6 Terra',
    )).toBe(false);
    expect(COPILOT_SELECTION_FOOTER_PATTERN.test(
      ' ◉ Working · 1.5 KiB esc interrupt                                      GPT-5.6 Terra',
    )).toBe(false);
  });

  it('does not match the capitalised progress row copilot draws mid-tool', () => {
    // `COPILOT_THINKING_PATTERN` matches `(Esc to cancel`, and that row carries a
    // `·` too. Lower case is the only thing separating the two, which is why the
    // pattern is case-sensitive.
    expect(COPILOT_SELECTION_FOOTER_PATTERN.test('◉ Mapping structure (Esc to cancel · 8.4 KiB)')).toBe(false);
  });

  it('does not match prose that merely mentions the keys', () => {
    expect(COPILOT_SELECTION_FOOTER_PATTERN.test('Press esc to cancel the operation.')).toBe(false);
    expect(COPILOT_SELECTION_FOOTER_PATTERN.test('Use the arrow keys, then press enter to select a model.')).toBe(false);
    expect(COPILOT_SELECTION_FOOTER_PATTERN.test('Here is your code: · list · of · things')).toBe(false);
  });

  it('does not use the global flag (no /g)', () => {
    expect(COPILOT_SELECTION_FOOTER_PATTERN.global).toBe(false);
  });
});

describe('Issue #1895: a copilot picker reads as a selection list', () => {
  beforeEach(() => {
    resetDetectPromptCache();
  });

  it('reports the /model picker as a navigable selection list', () => {
    const raw = liveFrame('model-picker');
    const result = detectSessionStatus(raw, 'copilot');
    expect(result.status).toBe('waiting');
    expect(result.confidence).toBe('high');
    expect(result.reason).toBe(STATUS_REASON.COPILOT_SELECTION_LIST);
    expect(result.hasActivePrompt).toBe(false);
  });

  it.each(NAVIGABLE_PICKERS)('reports %s as a navigable selection list', (name) => {
    const result = detectSessionStatus(pickerFrame(name), 'copilot');
    expect(result.status).toBe('waiting');
    expect(result.confidence).toBe('high');
    expect(result.reason).toBe(STATUS_REASON.COPILOT_SELECTION_LIST);
    expect(result.hasActivePrompt).toBe(false);
  });

  it('finds the footer even when a closing rule sits under it', () => {
    // /agent and /subagents draw their panel with a full-width rule below the
    // footer, so the bottom-most non-blank row is not the footer. They are the
    // only reason the scan looks past the bottom row at all.
    for (const name of ['picker-agent', 'picker-subagents'] as const) {
      const rows = rowsOf(pickerFrame(name)).filter((r) => r.trim() !== '');
      expect(rows[rows.length - 1], `${name} no longer ends in a rule`).toMatch(/^─+$/);
      expect(isCopilotSelectionFrame(rowsOf(pickerFrame(name)))).toBe(true);
    }
  });

  it('is not fooled by the composer copilot paints inside the /statusline preview', () => {
    // The preview box contains `│  ❯ Summarize the footer preview changes`. It
    // is a picture of a composer, not one — nothing may read it as readiness.
    const raw = pickerFrame('picker-statusline');
    expect(stripAnsi(raw)).toContain('❯ Summarize the footer preview changes');
    expect(detectSessionStatus(raw, 'copilot').reason).toBe(STATUS_REASON.COPILOT_SELECTION_LIST);
  });

  it('sends /permissions to PromptPanel because its body is a numbered menu', () => {
    // A picker by footer, a two-option choice by body. The `optionsCount <= 3`
    // branch at step 0 has guarded this since Issue #547 and was dead for as
    // long as the pattern matched nothing; this is the frame that exercises it.
    const result = detectSessionStatus(pickerFrame('picker-permissions'), 'copilot');
    expect(result.status).toBe('waiting');
    expect(result.reason).toBe(STATUS_REASON.PROMPT_DETECTED);
    expect(result.hasActivePrompt).toBe(true);
    expect(result.promptDetection.promptData?.options).toHaveLength(2);
  });
});

describe('Issue #1895: prose about a picker is not a picker', () => {
  beforeEach(() => {
    resetDetectPromptCache();
  });

  it('reads a reply that quotes the picker vocabulary as a finished turn', () => {
    const raw = pickerFrame('picker-vocabulary-in-response');
    expect(isCopilotSelectionFrame(rowsOf(raw))).toBe(false);

    const result = detectSessionStatus(raw, 'copilot');
    expect(result.status).toBe('ready');
    expect(result.reason).toBe(STATUS_REASON.INPUT_PROMPT);
    expect(result.hasActivePrompt).toBe(false);
  });

  it('reads /model <id> as the in-place switch it is', () => {
    // With an argument copilot never opens a picker: it prints
    // `● Model changed from … for this session.` and the chrome is already back.
    const raw = pickerFrame('model-arg-immediate');
    expect(stripAnsi(raw)).toContain('Model changed from');
    expect(isCopilotSelectionFrame(rowsOf(raw))).toBe(false);
    expect(detectSessionStatus(raw, 'copilot').reason).toBe(STATUS_REASON.INPUT_PROMPT);
  });

  it.each(NON_PICKER_FRAMES.map((f) => [f.name, f.read] as const))(
    'never calls %s a picker',
    (_name, read) => {
      expect(isCopilotSelectionFrame(rowsOf(read()))).toBe(false);
    },
  );

  it('leaves copilot\'s boxed dialogs on the prompt branch', () => {
    // The folder-trust and permission dialogs wear the SAME lower-case footer as
    // the pickers. They must stay `hasActivePrompt: true`: they are the agent
    // blocked on the human (exit 10 for `wait`, PromptPanel in the UI), not a
    // list the operator opened.
    for (const raw of [liveFrame('permission-dialog'), buildCopilotFolderTrustFrame()]) {
      expect(stripAnsi(raw)).toContain('enter to select');
      expect(isCopilotSelectionFrame(rowsOf(raw))).toBe(false);

      const result = detectSessionStatus(raw, 'copilot');
      expect(result.status).toBe('waiting');
      expect(result.reason).toBe(STATUS_REASON.PROMPT_DETECTED);
      expect(result.hasActivePrompt).toBe(true);
    }
  });

  it('leaves the plain ready frame alone', () => {
    expect(isCopilotSelectionFrame(rowsOf(buildCopilotReadyFrame()))).toBe(false);
  });

  it('never speaks about a tool that is not copilot', () => {
    const raw = pickerFrame('picker-theme');
    for (const tool of ['claude', 'codex', 'opencode', 'gemini'] as const) {
      expect(
        detectSessionStatus(raw, tool).reason,
        `${tool} reached the copilot branch`,
      ).not.toBe(STATUS_REASON.COPILOT_SELECTION_LIST);
    }
  });
});

describe('Issue #1895: the footer row is what carries the verdict', () => {
  beforeEach(() => {
    resetDetectPromptCache();
  });

  it.each(NAVIGABLE_PICKERS)(
    'stops calling %s a picker when only its footer loses the two key tokens',
    (name) => {
      // Non-vacuity, injected into a real capture: the list, the header rows,
      // the SGR and every other byte are identical — only the bottom of the pane
      // changes. A detector reading the picker's CONTENT would still pass here.
      const mutated = withoutPickerFooter(pickerFrame(name));
      expect(mutated, 'the mutation did not change the frame').not.toBe(pickerFrame(name));
      expect(isCopilotSelectionFrame(rowsOf(mutated))).toBe(false);
      expect(detectSessionStatus(mutated, 'copilot').reason).not.toBe(
        STATUS_REASON.COPILOT_SELECTION_LIST,
      );
    },
  );

  it('starts calling a dialog a picker as soon as its footer leaves the box', () => {
    // The mirror image: the permission dialog's footer already matches the
    // pattern, and only `│ … │` keeps it on the prompt branch. Take the box off
    // that one row and the verdict flips — which is what makes the box check
    // load-bearing rather than decorative.
    const rows = rowsOf(liveFrame('permission-dialog'));
    expect(isCopilotSelectionFrame(rows)).toBe(false);

    const unboxed = rows.map((row) =>
      row.includes('enter to select') ? row.replace(/│/g, ' ') : row,
    );
    expect(unboxed.join('\n')).not.toBe(rows.join('\n'));
    expect(isCopilotSelectionFrame(unboxed)).toBe(true);
  });

  it('declines any frame whose bottom row is still a status bar', () => {
    // The ordering rule, stated as a property rather than as a comment: as long
    // as copilot is drawing its own chrome, no row above it can make the frame a
    // picker. Splicing a real footer into a real idle frame proves the guard is
    // the status bar and not the absence of the vocabulary.
    const idle = rowsOf(liveFrame('boot-idle'));
    expect(readCopilotStatusBar(idle)).toBe('idle');

    const spliced = [...idle];
    const statusBarRow = spliced.reduce(
      (found, row, i) => (row.trim() === '' ? found : i),
      -1,
    );
    const footer = MEASURED_PICKER_FOOTERS[0][1];
    spliced.splice(statusBarRow, 0, footer);
    expect(COPILOT_SELECTION_FOOTER_PATTERN.test(footer)).toBe(true);
    expect(readCopilotStatusBar(spliced)).toBe('idle');
    expect(isCopilotSelectionFrame(spliced)).toBe(false);
  });
});

describe('Issue #1895: what Auto-Yes is offered', () => {
  beforeEach(() => {
    resetDetectPromptCache();
  });

  it('never offers a navigable picker to Auto-Yes as an answerable prompt', () => {
    // Auto-Yes bypasses the status detector entirely
    // (`src/lib/polling/response-checker.ts`), so `hasActivePrompt: false` alone
    // would not stop a wrong auto-answer into an open picker's search field.
    for (const name of NAVIGABLE_PICKERS) {
      const detection = autoYesPromptOf(pickerFrame(name));
      expect(detection.isPrompt, `${name} was offered to Auto-Yes`).toBe(false);
      expect(detection.promptData).toBeUndefined();
    }
    for (const { name, read } of NON_PICKER_FRAMES) {
      if (name === 'permission-dialog') continue;
      const detection = autoYesPromptOf(read());
      expect(detection.isPrompt, `${name} was offered to Auto-Yes`).toBe(false);
    }
  });

  it('does offer /permissions, whose only auto-answerable option is the stricter one', () => {
    // Measured and recorded rather than changed: `detectPrompt` reads the
    // two-option numbered body, and this Issue does not touch that path. Auto-Yes
    // answering `1` selects `Manual ✓` — the mode already in force and the more
    // restrictive of the two — so the exposure is a no-op rather than a silent
    // widening of what copilot may run unattended.
    const detection = autoYesPromptOf(pickerFrame('picker-permissions'));
    expect(detection.isPrompt).toBe(true);
    const options = detection.promptData?.options ?? [];
    expect(options).toHaveLength(2);
    const first = options[0];
    expect(typeof first).not.toBe('string');
    if (typeof first === 'string') throw new Error('unreachable');
    expect(first.label).toContain('Manual');
    expect(first.isDefault).toBe(true);
  });
});
