/**
 * Command Code's detection fixtures (Issue #2304, 方針書 §11 / §4 D2).
 *
 * #2250 read the rules off six live 1.40.1 frames. What this Issue adds is the
 * §11 sweep over them — the full verdict INCLUDING `evidence`, a geometry pin
 * and the mutation case — plus seven frames captured live on **1.49.0**, nine
 * minor versions later, so the sweep says whether the rules still answer for
 * the build a reader can install today rather than only for the one they were
 * written against.
 *
 * ## Why this is a hand-written sweep and not `runToolFixtureSuite`
 *
 * The shared machinery mutates the **bottom row** (`rewordBottomRow`), because
 * claude, copilot and opencode all pin their busy affordance there. Command
 * Code does not: it renders inline (`#{alternate_on}` is 0), so its status row
 * sits *above* a composer that is drawn all turn, and the bottom non-empty row
 * of every frame here is the footer. Measured: on `turn-thinking.txt` the last
 * non-empty row is `  ? for shortcuts · taste on` and the busy row is row 15,
 * so `rewordBottomRow(raw, 'interrupt', …)` returns the frame **unchanged** —
 * which `runToolFixtureSuite` correctly refuses to accept as a mutation. The
 * mutation below finds the busy row wherever it is instead, and it does so on
 * the *cleaned* text, which is the second half of the same trap: Command Code
 * colours `esc` and `to interrupt` in separate SGR runs and splits `Planning…`
 * as `Plannin`/`g`/`…`, so a `raw.replace('esc to interrupt', …)` is a silent
 * no-op too.
 *
 * ## What the mutation case measures, and why it is not a green `evidence:
 * 'none'`
 *
 * §4 D1 forbids declaring a turn finished on the *absence* of a busy marker.
 * Command Code does exactly that today, and the mutation is what says so out
 * loud: take the busy affordance off a running frame and the reading is
 * `ready` / `input_prompt` / `evidence: 'positive'`, because the composer row
 * is on screen in both states and `afterThinking`'s idle branch answers on it.
 * That is the reason `detection-evidence-config` ships `legacy` for this tool
 * and the reason its module declares no `readIdleEvidence` — and it is pinned
 * here as the measurement it is, so a rule added later has a red test to turn
 * green rather than a gap nobody wrote down.
 *
 * #2250's module docblock named the missing precondition for that rule: frames
 * of "the awkward idle states (after a `/clear`, after an Esc interrupt)".
 * Both are now captured, and the first one turned out not to need a file —
 * see `boot-idle-1490` in the table below.
 *
 * @vitest-environment node
 */

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IDLE_EVIDENCE_ENV_VAR } from '@/config/detection-evidence-config';
import { stripAnsi } from '@/lib/detection/cli-patterns';
import { detectSessionStatus, STATUS_REASON } from '@/lib/detection/status-detector';
import { extractCommandCodeSelectionListFrame } from '@/lib/detection/selection-shape';
import { commandCodeStatusDetector } from '@/lib/detection/tools/command-code/detect';
import type { StatusEvidence } from '@/lib/session/status-evidence';

const LIVE_DIR = path.resolve(__dirname, '../../../../fixtures/command-code-live-2250');
/** The picker captures stay where #2254 / #2297 put them; see the table below. */
const CARD_DIR = path.resolve(__dirname, '../../../../fixtures/chat-dialog-card-2254');

const frame = (dir: string, name: string): string =>
  readFileSync(path.join(dir, `${name}.txt`), 'utf8');

/** Rows as the tool drew them: a single trailing newline is not a row. */
function rowsOf(raw: string): string[] {
  const rows = raw.split('\n');
  if (rows.length > 0 && rows[rows.length - 1] === '') rows.pop();
  return rows;
}

/** The pane's width, in columns, read the way a rule reads the frame. */
function columnsOf(raw: string): number {
  let widest = 0;
  for (const row of rowsOf(raw)) {
    widest = Math.max(widest, stripAnsi(row).replace(/\r$/, '').length);
  }
  return widest;
}

interface Expectation {
  /** Fixture basename, without `.txt`. */
  frame: string;
  status: 'idle' | 'ready' | 'running' | 'waiting';
  reason: string;
  evidence: StatusEvidence;
  hasActivePrompt: boolean;
  /** What this capture is here to state. */
  pins: string;
}

/**
 * Every frame in `command-code-live-2250/`, and what it must publish.
 *
 * The 1.40.1 rows are #2250's; the `-1490` rows were captured for this Issue on
 * 2026-09-04 with Command Code 1.49.0 at the same 200x1000 geometry, on a
 * private tmux server over an isolated `HOME` (see the directory's README).
 */
const EXPECTATIONS: readonly Expectation[] = [
  // ---- 1.40.1 (Issue #2250) --------------------------------------------
  {
    frame: 'boot-idle',
    status: 'ready',
    reason: STATUS_REASON.INPUT_PROMPT,
    evidence: 'positive',
    hasActivePrompt: false,
    pins: 'the launch screen: banner + composer, no user echo anywhere',
  },
  {
    frame: 'dialog-create-file',
    status: 'waiting',
    reason: STATUS_REASON.PROMPT_DETECTED,
    evidence: 'positive',
    hasActivePrompt: true,
    pins: 'the file-permission dialog, three options, `❯` on 1',
  },
  {
    frame: 'dialog-shell-command',
    status: 'waiting',
    reason: STATUS_REASON.PROMPT_DETECTED,
    evidence: 'positive',
    hasActivePrompt: true,
    pins: 'the shell-permission dialog under a wrapped two-row reply',
  },
  {
    frame: 'turn-thinking',
    status: 'running',
    reason: STATUS_REASON.THINKING_INDICATOR,
    evidence: 'positive',
    hasActivePrompt: false,
    pins: 'a turn in flight WITH the composer drawn — why the module exists',
  },
  {
    frame: 'turn-tool-write',
    status: 'ready',
    reason: STATUS_REASON.INPUT_PROMPT,
    evidence: 'positive',
    hasActivePrompt: false,
    pins: 'a finished turn whose reply carries a `WRITE` tool block',
  },
  {
    frame: 'turn-version',
    status: 'ready',
    reason: STATUS_REASON.INPUT_PROMPT,
    evidence: 'positive',
    hasActivePrompt: false,
    pins: 'the #2247 case: a short reply carrying a version string',
  },

  // ---- 1.49.0 (this Issue) ---------------------------------------------
  {
    frame: 'boot-idle-1490',
    status: 'ready',
    reason: STATUS_REASON.INPUT_PROMPT,
    evidence: 'positive',
    hasActivePrompt: false,
    // Measured: after `/clear`, Command Code repaints the launch screen and the
    // captured pane is **byte-identical** to this frame. So one of the two
    // awkward idle states #2250 said it had not captured needs no capture of
    // its own — unlike claude, which leaves `new task? /clear to save …` behind
    // and is the reason that rule is still `observe` (#2011).
    pins: 'the launch screen at 1.49.0 — and, byte-identically, the pane after `/clear`',
  },
  {
    frame: 'dialog-kill-task-1490',
    status: 'waiting',
    reason: STATUS_REASON.PROMPT_DETECTED,
    evidence: 'positive',
    hasActivePrompt: true,
    // The other dialog body: a description row (`Stop tracked shell/monitor
    // task s0a8jfqz`) where the shell dialog puts `Press [ctrl+e] to explain
    // this command`, and a footer with one hint fewer.
    pins: 'a permission dialog whose body is a description, not the ctrl+e hint',
  },
  {
    frame: 'dialog-shell-1490',
    status: 'waiting',
    reason: STATUS_REASON.PROMPT_DETECTED,
    evidence: 'positive',
    hasActivePrompt: true,
    pins: 'the shell-permission dialog at 1.49.0, four footer hints',
  },
  {
    frame: 'idle-after-interrupt-1490',
    status: 'ready',
    reason: STATUS_REASON.INPUT_PROMPT,
    evidence: 'positive',
    hasActivePrompt: false,
    // The second awkward idle state, and the one that does need a file: Esc
    // landed before the agent had written anything, so the newest turn is a
    // prompt echo followed straight by `✻ Worked for 4s` with **no `⠶` reply
    // row at all**. Any completion rule built on "the tail carries a reply"
    // would read this pane as unfinished forever.
    pins: 'an Esc-interrupted turn: prompt echo, no `⠶` reply, `✻ Worked for 4s`',
  },
  {
    frame: 'turn-done-1490',
    status: 'ready',
    reason: STATUS_REASON.INPUT_PROMPT,
    evidence: 'positive',
    hasActivePrompt: false,
    pins: 'a finished turn at 1.49.0: `⠶ <reply>` then `✻ Worked for 2s`',
  },
  {
    frame: 'turn-shell-running-1490',
    status: 'running',
    reason: STATUS_REASON.THINKING_INDICATOR,
    evidence: 'positive',
    hasActivePrompt: false,
    // The 1.49.0 finding. `COMMAND_CODE_THINKING_PATTERN`'s first alternative
    // wants `[spinner] <one word>…`; this status row spells the verb as three
    // words with no ellipsis (` ✧ Shell command allowed  esc to interrupt • …`),
    // so only the third alternative — the `esc to interrupt` tail — reads it.
    // That tail is dropped below 42 columns by the tool's own layout ladder, so
    // this row is the measured case where the spinner branch alone would not
    // hold. CommandMate panes are 200 wide, which is why it holds here.
    pins: 'a running frame whose status verb is three words and carries no `…`',
  },
  {
    frame: 'turn-thinking-1490',
    status: 'running',
    reason: STATUS_REASON.THINKING_INDICATOR,
    evidence: 'positive',
    hasActivePrompt: false,
    pins: 'a turn in flight at 1.49.0: ` · Parsing…  esc to interrupt • 2s • ↓ 0`',
  },
];

/**
 * The picker — the fifth state, and the one whose captures live elsewhere.
 *
 * Copying 200x1000 frames into a second directory would give the repository two
 * answers to "what did Command Code draw", which is the reason the copilot and
 * opencode sweeps read theirs in place as well. There is a second reason here:
 * `tests/unit/lib/chat/dialog-frame-2326.test.ts` walks **every** capture under
 * `tests/fixtures/` and pins, by equality, the exact list that
 * `extractCommandCodeSelectionListFrame` crops — so a picker frame added to
 * another directory is a red test in a suite that has nothing to do with this
 * one. The `picker` column below is asserted for the same reason: it is the
 * statement that these four are that list and the twelve frames above are not.
 */
const PICKER_EXPECTATIONS: readonly { frame: string; picker: boolean; reason: string }[] = [
  { frame: 'command-code-model-1-40-1', picker: true, reason: STATUS_REASON.COMMAND_CODE_SELECTION_LIST },
  { frame: 'command-code-model-1-47-1-open', picker: true, reason: STATUS_REASON.COMMAND_CODE_SELECTION_LIST },
  { frame: 'command-code-model-1-47-1-middle', picker: true, reason: STATUS_REASON.COMMAND_CODE_SELECTION_LIST },
  { frame: 'command-code-model-1-47-1-bottom', picker: true, reason: STATUS_REASON.COMMAND_CODE_SELECTION_LIST },
  // The control: the same pane one keystroke later. A rule that matched the
  // transcript the picker left behind rather than the picker itself would hold
  // this session on `waiting` forever.
  { frame: 'command-code-model-1-47-1-closed', picker: false, reason: STATUS_REASON.INPUT_PROMPT },
];

/** The word Command Code spells its busy affordance with, and its replacement. */
const BUSY_PHRASE = 'esc to interrupt';
const REWORDED_BUSY_PHRASE = 'esc to dismissal';

/** Whether a cleaned row carries the status row's spinner + one-word verb. */
const STATUS_VERB = /^\s*[·○◇☆✧⌘]\s+[A-Za-z]+…/;
/** The reasoning block's header WHILE it streams — a second, independent marker. */
const STREAMING_THINKING = /^\s*✻ Thinking…/;

/** Take the busy vocabulary off one cleaned row. */
function defuse(clean: string): string {
  return clean.replace(BUSY_PHRASE, REWORDED_BUSY_PHRASE).replace(/…/g, '.');
}

/**
 * Rewrite the STATUS row — the one Command Code pins its spinner and its
 * `esc to interrupt` tail to — as plain text.
 *
 * Located on the CLEANED row and rewritten as cleaned text, for the two reasons
 * the module docblock gives: the row is not the bottom one, and neither phrase
 * is contiguous in the raw bytes. Both halves of the surgery are asserted to
 * have landed before anything is concluded from the result.
 *
 * @returns The mutated frame and the row index, or `row: -1` when no row carried it
 */
function rewordStatusRow(raw: string): { mutated: string; row: number } {
  const rows = raw.split('\n');
  for (let i = rows.length - 1; i >= 0; i--) {
    const clean = stripAnsi(rows[i]);
    if (!clean.includes(BUSY_PHRASE) && !STATUS_VERB.test(clean)) continue;
    rows[i] = defuse(clean);
    return { mutated: rows.join('\n'), row: i };
  }
  return { mutated: raw, row: -1 };
}

/** Take the busy vocabulary off EVERY row that carries any of it. */
function rewordEveryBusyRow(raw: string): { mutated: string; rows: number[] } {
  const rows = raw.split('\n');
  const touched: number[] = [];
  for (let i = 0; i < rows.length; i++) {
    const clean = stripAnsi(rows[i]);
    if (
      !clean.includes(BUSY_PHRASE) &&
      !STATUS_VERB.test(clean) &&
      !STREAMING_THINKING.test(clean)
    ) {
      continue;
    }
    rows[i] = defuse(clean);
    touched.push(i);
  }
  return { mutated: rows.join('\n'), rows: touched };
}

/** Every running frame in the directory. */
const RUNNING_FRAMES = ['turn-thinking', 'turn-thinking-1490', 'turn-shell-running-1490'] as const;
/**
 * The running frames whose ONLY busy evidence is the status row.
 *
 * `turn-shell-running-1490` is deliberately not here: it carries a second,
 * independent marker (` ✻ Thinking… (72 lines) [ctrl+o to expand]`, the
 * reasoning block's streaming header) and is asserted on its own below. That
 * difference is why §11 wants this list written down rather than derived from
 * "the running frames" — a sweep that mutated all three and expected one answer
 * would have concluded the wrong thing about one of them, and stayed green
 * doing it.
 */
const SINGLE_MARKER_RUNNING_FRAMES = ['turn-thinking', 'turn-thinking-1490'] as const;
const IDLE_FRAMES = [
  'boot-idle',
  'boot-idle-1490',
  'turn-version',
  'turn-tool-write',
  'turn-done-1490',
  'idle-after-interrupt-1490',
] as const;

describe('[#2304] the Command Code fixture directory', () => {
  it('is covered by the table exactly', () => {
    // A capture nobody asserts on proves nothing, and an expectation with no
    // capture is a rule nobody measured. Both are how a sweep like this rots.
    const onDisk = readdirSync(LIVE_DIR)
      .filter((f) => f.endsWith('.txt'))
      .map((f) => f.replace(/\.txt$/, ''))
      .sort();

    expect([...EXPECTATIONS].map((e) => e.frame).sort()).toEqual(onDisk);
    expect(onDisk.length).toBe(13);
  });

  it('holds verbatim captures at the production 200x1000 geometry', () => {
    for (const { frame: name } of EXPECTATIONS) {
      const raw = frame(LIVE_DIR, name);
      expect(raw, `${name} lost its escape sequences`).toContain('\x1b[');
      // Both numbers are load-bearing and neither was pinned before this Issue.
      // The HEIGHT is what keeps the transcript hundreds of rows above the
      // chrome, so a rule that names the tail window is about the rows it says.
      // The WIDTH is what makes the frame carry the chrome at all: Command
      // Code's `Status` component only draws `esc to interrupt • <elapsed> • ↓
      // <tokens>` in its `"all"` layout, i.e. at 72 columns or more, and the
      // full-pane `─` rules the composer sits between are exactly as wide as
      // the pane. A re-capture at a default width would silently drop the first
      // and change the second, and every rule read off them would still pass.
      expect(rowsOf(raw).length, `${name} is not a 1000-row capture`).toBe(1000);
      expect(columnsOf(raw), `${name} is not a 200-column capture`).toBe(200);
    }
  });

  it('has a rule row for every frame, so no capture is a bare regression file', () => {
    for (const { frame: name, pins } of EXPECTATIONS) {
      expect(pins.length, `${name} says nothing about what it pins`).toBeGreaterThan(20);
    }
  });
});

describe('[#2304] every frame publishes the verdict it was measured to', () => {
  // The sweep runs the RULE, whatever the rollout table currently says (#2011).
  // Command Code ships `legacy`, under which `resolveIdleEvidence` short-circuits
  // to `'positive'` before a tool rule is consulted — so a sweep that did not
  // force this would be asserting the short-circuit rather than the tool.
  beforeEach(() => {
    process.env[IDLE_EVIDENCE_ENV_VAR] = 'command-code=enforce';
  });
  afterEach(() => {
    delete process.env[IDLE_EVIDENCE_ENV_VAR];
  });

  it.each(EXPECTATIONS)(
    '$frame → $status/$reason ($evidence): $pins',
    ({ frame: name, status, reason, evidence, hasActivePrompt }) => {
      const result = detectSessionStatus(frame(LIVE_DIR, name), 'command-code');
      expect({
        status: result.status,
        reason: result.reason,
        evidence: result.evidence,
        hasActivePrompt: result.hasActivePrompt,
      }).toEqual({ status, reason, evidence, hasActivePrompt });
    }
  );

  it.each(IDLE_FRAMES)('%s carries positive completion evidence', (name) => {
    expect(detectSessionStatus(frame(LIVE_DIR, name), 'command-code').evidence).toBe('positive');
  });

  it('reads the same six 1.40.1 rules on nine-versions-newer frames', () => {
    // The point of the 1.49.0 captures, stated as one assertion rather than
    // left implicit in the table: the build the rules were read off and the
    // build a reader can install today answer identically, state for state.
    const verdictOf = (name: string): string => {
      const r = detectSessionStatus(frame(LIVE_DIR, name), 'command-code');
      return `${r.status}/${r.reason}/${r.evidence}`;
    };

    expect(verdictOf('boot-idle-1490')).toBe(verdictOf('boot-idle'));
    expect(verdictOf('turn-thinking-1490')).toBe(verdictOf('turn-thinking'));
    expect(verdictOf('turn-done-1490')).toBe(verdictOf('turn-version'));
    expect(verdictOf('dialog-shell-1490')).toBe(verdictOf('dialog-shell-command'));
  });
});

describe('[#2304] the picker is the fifth state, read in place', () => {
  it.each(PICKER_EXPECTATIONS)('$frame → $reason (cropper: $picker)', ({ frame: name, picker, reason }) => {
    const raw = frame(CARD_DIR, name);
    expect(rowsOf(raw).length, `${name} is not a 1000-row capture`).toBe(1000);
    expect(columnsOf(raw), `${name} is not a 200-column capture`).toBe(200);
    expect(detectSessionStatus(raw, 'command-code').reason).toBe(reason);
    expect(extractCommandCodeSelectionListFrame(raw) !== null).toBe(picker);
  });

  it('is read by the tool`s own rule at both captured builds', () => {
    // #2297 measured the 1.40.1 picker and added `afterPrompt` for it. The three
    // 1.47.1 captures landed with #2254 / #2326 for the chat surface's crop and
    // had no detector verdict pinned anywhere until this Issue — so "the rule
    // still reads the picker one build family later" was an assumption.
    for (const { frame: name, picker } of PICKER_EXPECTATIONS) {
      if (!picker) continue;
      const result = detectSessionStatus(frame(CARD_DIR, name), 'command-code');
      expect(result.status, name).toBe('waiting');
      expect(result.reason, name).toBe(STATUS_REASON.COMMAND_CODE_SELECTION_LIST);
      // No numbers on the picker, so nothing may claim an answerable prompt:
      // `respond <id> N` and Auto-Yes both key off this flag and every one of
      // those characters would land in the `Type to search models...` box.
      expect(result.hasActivePrompt, name).toBe(false);
    }
  });

  it('crops no frame in the live directory', () => {
    // The other half of the equality pin in `dialog-frame-2326.test.ts`, stated
    // where a new capture is actually added: a permission dialog is not a
    // picker, and neither is any idle or running frame.
    for (const { frame: name } of EXPECTATIONS) {
      expect(extractCommandCodeSelectionListFrame(frame(LIVE_DIR, name)), name).toBeNull();
    }
  });
});

describe('[#2304] the busy row is what the running verdict rests on', () => {
  beforeEach(() => {
    process.env[IDLE_EVIDENCE_ENV_VAR] = 'command-code=enforce';
  });
  afterEach(() => {
    delete process.env[IDLE_EVIDENCE_ENV_VAR];
  });

  it.each(RUNNING_FRAMES)('%s: the mutation lands on the row, not on the bottom row', (name) => {
    // The positive control §11 asks for, and it is not a formality here: both
    // obvious spellings of this mutation are silent no-ops on these bytes.
    const raw = frame(LIVE_DIR, name);
    const { mutated, row } = rewordStatusRow(raw);

    expect(row, `${name} carries no busy row`).toBeGreaterThanOrEqual(0);
    expect(mutated, `${name} was not changed by the reword`).not.toBe(raw);
    expect(stripAnsi(mutated)).not.toContain(BUSY_PHRASE);
    expect(stripAnsi(mutated)).toContain(REWORDED_BUSY_PHRASE);

    // The row is NOT the bottom one, which is why the shared helper cannot be
    // used. Asserted rather than asserted-in-a-comment so that a future build
    // that moves the chrome to the bottom is a failing test and an invitation
    // to delete this file in favour of `runToolFixtureSuite`.
    const rows = rowsOf(raw);
    let lastNonEmpty = -1;
    for (let i = rows.length - 1; i >= 0; i--) {
      if (rows[i].trim() !== '') {
        lastNonEmpty = i;
        break;
      }
    }
    expect(row).toBeLessThan(lastNonEmpty);
    expect(stripAnsi(rows[lastNonEmpty])).toContain('? for shortcuts');
  });

  it.each(RUNNING_FRAMES)('%s was a positively-running frame to begin with', (name) => {
    const before = detectSessionStatus(frame(LIVE_DIR, name), 'command-code');
    expect(before.status).toBe('running');
    expect(before.evidence).toBe('positive');
  });

  it.each(SINGLE_MARKER_RUNNING_FRAMES)(
    '%s: with the status row reworded, Command Code declares a confident `ready` — the §4 D1 gap',
    (name) => {
      // **This is a measurement, not an endorsement.** §4 D1 決定 1 says a
      // completion may not be published on the absence of a busy marker, and
      // that is exactly what happens: the composer row (`❯ Ask your
      // question...` between two full-pane rules) is drawn during a turn and
      // after it, so with the status row unreadable `afterThinking`'s idle
      // branch answers `ready` with `evidence: 'positive'` on a pane that is
      // still generating.
      //
      // It costs nothing in production today, because
      // `IDLE_EVIDENCE_DEFAULT_MODE['command-code']` is `legacy` and the module
      // declares no `readIdleEvidence` — the two facts that make this frame's
      // `'positive'` the pre-#1927 reading rather than a claim. What it costs
      // is the rollout: this tool cannot move to `observe` until a rule exists,
      // and the rule needs frames of the idle states a completion marker does
      // not cover. Those frames are now here (`boot-idle-1490`,
      // `idle-after-interrupt-1490`), which is what this Issue could supply;
      // building the rule and measuring its `observe` rate is its own Issue.
      const { mutated } = rewordStatusRow(frame(LIVE_DIR, name));
      const after = detectSessionStatus(mutated, 'command-code');

      expect(after.status).toBe('ready');
      expect(after.reason).toBe(STATUS_REASON.INPUT_PROMPT);
      expect(after.evidence).toBe('positive');
    }
  );

  it('turn-shell-running-1490 survives losing its status row, because it has a second marker', () => {
    // The frame that would have made the sweep above say the wrong thing. Its
    // status row is ` ✧ Shell command allowed  esc to interrupt • 19s • ↓ 1.7k`
    // — and two rows above it sits ` ✻ Thinking… (72 lines) [ctrl+o to expand]`,
    // the reasoning block's streaming header, which is
    // `COMMAND_CODE_THINKING_PATTERN`'s second alternative and an independent
    // statement that the turn is live. Take the status row away and the frame
    // is still, correctly, `running`.
    //
    // Layered evidence is the shape a completion rule wants, so this is worth
    // stating positively rather than only noting as an exclusion: the pane is
    // not relying on one row.
    const { mutated, row } = rewordStatusRow(frame(LIVE_DIR, 'turn-shell-running-1490'));
    expect(row).toBeGreaterThanOrEqual(0);

    const after = detectSessionStatus(mutated, 'command-code');
    expect(after.status).toBe('running');
    expect(after.reason).toBe(STATUS_REASON.THINKING_INDICATOR);
    expect(after.evidence).toBe('positive');
  });

  it('turn-shell-running-1490 reaches the same `ready` once BOTH markers are gone', () => {
    // …and the gap is not confined to the single-marker frames: remove every
    // busy row and this pane joins them. Which is the point — the reading is
    // "no busy vocabulary anywhere" ⇒ "finished", however many rows had to be
    // silenced to get there.
    const raw = frame(LIVE_DIR, 'turn-shell-running-1490');
    const { mutated, rows } = rewordEveryBusyRow(raw);

    // Positive control, twice: more than one row carried something, and the
    // vocabulary really is gone from the cleaned frame.
    expect(rows.length).toBeGreaterThan(1);
    expect(stripAnsi(mutated)).not.toContain(BUSY_PHRASE);
    expect(stripAnsi(mutated)).not.toMatch(STREAMING_THINKING);

    const after = detectSessionStatus(mutated, 'command-code');
    expect(after.status).toBe('ready');
    expect(after.reason).toBe(STATUS_REASON.INPUT_PROMPT);
    expect(after.evidence).toBe('positive');
  });

  it('has no idle rule to consult, which is why the mutation ends there', () => {
    // The structural half of the paragraph above: `runToolDetection` only
    // reaches `readIdleEvidence` for a tool that declares one, and this tool's
    // `afterThinking` answers before the generic composer check anyway. Pinned
    // so that adding the rule without revisiting `afterThinking`'s hardcoded
    // `'positive'` is a failing test rather than a rule that never runs.
    expect(commandCodeStatusDetector.readIdleEvidence).toBeUndefined();
    expect(commandCodeStatusDetector.hasDialogRules).toBe(false);
  });
});

describe('[#2304] what the rules were measured against', () => {
  it('still records 1.40.1, and this suite is the statement about 1.49.0', () => {
    // `verifiedAgainst` is the build the rules were READ OFF, and re-capturing
    // did not change one of them, so the value stays where #2250 put it. The
    // 1.49.0 rows in the table above are the receipt: same rules, same
    // verdicts, frames captured 2026-09-04 on 1.49.0 at 200x1000.
    expect(commandCodeStatusDetector.verifiedAgainst).toEqual({
      version: '1.40.1',
      capturedAt: '2026-09-03',
      paneGeometry: '200x1000',
    });
  });
});
