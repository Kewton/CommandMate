/**
 * Reading a permission mode off a live frame (Issue #2592, Phase 2).
 *
 * The fixtures are whole panes with their ANSI intact — see
 * `tests/fixtures/agent-mode-2592/README.md` for where each row came from. Two
 * defects this suite exists to catch, both of which a hand-trimmed fixture would
 * hide:
 *
 *  1. **forgetting `stripAnsi`.** Every measured indicator arrives wrapped in
 *     SGR (`\x1b[38;5;220m⏵⏵ auto mode on\x1b[38;5;246m (shift+tab to cycle)`),
 *     so a pattern run against raw bytes matches nothing;
 *  2. **scanning the whole frame.** Command Code renders inline, so a 1000-row
 *     capture keeps every footer the session ever drew and a whole-frame test
 *     answers with the oldest one forever.
 *
 * @vitest-environment node
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  detectAgentMode,
  isReadableAgentMode,
  readAgentModeFromSpec,
} from '@/lib/detection/agent-mode';
import { resolveAgentModeSpec } from '@/lib/cli-tools/agent-mode-spec';
import { SUPPORTED_COMPOSER_TOOLS } from '@/lib/detection/composer-text';
import { stripAnsi } from '@/lib/detection/ansi';
import { AGENT_MODE_UNKNOWN, type AgentMode } from '@/types/cli-tool-contracts';
import type { CLIToolType } from '@/lib/cli-tools/types';

const FIXTURES = path.join(process.cwd(), 'tests/fixtures/agent-mode-2592');

function frame(name: string): string {
  return fs.readFileSync(path.join(FIXTURES, name), 'utf8');
}

/** One fixture, the tool it was captured from, and the mode it must read as. */
const CASES: ReadonlyArray<[CLIToolType, string, AgentMode]> = [
  // claude prints a row for every one of its four modes, so all four are
  // readable and none of them is inferred.
  ['claude', 'claude-auto.txt', 'auto'],
  ['claude', 'claude-manual.txt', 'manual'],
  ['claude', 'claude-accept-edits.txt', 'accept-edits'],
  ['claude', 'claude-plan.txt', 'plan'],

  // Command Code is the one tool whose base mode is a POSITIVE row
  // (`? for shortcuts`), plus two modes its own cycle cannot reach.
  ['command-code', 'command-code-default.txt', 'default'],
  ['command-code', 'command-code-accept-edits.txt', 'accept-edits'],
  ['command-code', 'command-code-plan.txt', 'plan'],
  ['command-code', 'command-code-bypass-1490.txt', 'bypass'],

  ['codex', 'codex-plan.txt', 'plan'],
  ['copilot', 'copilot-plan.txt', 'plan'],
  ['copilot', 'copilot-autopilot.txt', 'autopilot'],
  ['antigravity', 'antigravity-accept-edits.txt', 'accept-edits'],
  ['antigravity', 'antigravity-plan.txt', 'plan'],
];

/**
 * The frames where the tool is in its base mode and draws NOTHING for it.
 *
 * Issue #2592 §「設計に効く事実」3. These are verbatim live captures, not
 * constructions: a reader that answered `default` here would be answering from
 * the absence of evidence, and would answer `default` just as confidently for a
 * frame captured mid-repaint or one whose footer scrolled out of the window.
 */
const SILENT_DEFAULT_FRAMES: ReadonlyArray<[CLIToolType, string]> = [
  ['codex', 'codex-default.txt'],
  ['copilot', 'copilot-default.txt'],
  ['antigravity', 'antigravity-default.txt'],
];

describe('[#2592] each declaring tool reads its own modes off a real frame', () => {
  it.each(CASES)('%s / %s -> %s', (tool, file, expected) => {
    expect(detectAgentMode(tool, frame(file))).toBe(expected);
  });

  it('reads the same answer from a frame somebody already stripped', () => {
    // Both call sites hand this function a raw capture, but the CLI's
    // `capture --json` path and a future consumer may not. Matching after a
    // strip that has already happened must be a no-op, not a miss.
    const raw = frame('claude-plan.txt');
    const stripped = stripAnsi(raw);
    expect(detectAgentMode('claude', stripped)).toBe('plan');
  });
});

describe('[#2592] a frame that names no mode answers `unknown`, never `default`', () => {
  it.each(SILENT_DEFAULT_FRAMES)('%s / %s', (tool, file) => {
    expect(detectAgentMode(tool, frame(file))).toBe(AGENT_MODE_UNKNOWN);
  });

  it('answers `unknown` for an empty frame and for a frame of nothing but padding', () => {
    expect(detectAgentMode('claude', '')).toBe(AGENT_MODE_UNKNOWN);
    expect(detectAgentMode('claude', null)).toBe(AGENT_MODE_UNKNOWN);
    expect(detectAgentMode('claude', '\n'.repeat(1000))).toBe(AGENT_MODE_UNKNOWN);
  });

  it('answers `unknown` for the three tools that declare no cycle', () => {
    // Not "there is no frame to read" — these tools have panes. The declaration
    // is what is absent, and a caller must not have to know which tools those
    // are before it can ask.
    for (const tool of ['opencode', 'vibe-local', 'gemini'] as const) {
      expect(resolveAgentModeSpec(tool)).toBeNull();
      expect(detectAgentMode(tool, frame('claude-plan.txt'))).toBe(AGENT_MODE_UNKNOWN);
    }
  });
});

describe('[#2592] the tail window', () => {
  /**
   * The defect the window exists for: a mode row does not vanish when the mode
   * changes, it scrolls up. Command Code renders inline (#2250 measured
   * `alternate_on` 0), so its 1000-row capture really can hold both.
   */
  it('reads the NEWEST mode row, not an older one further up the pane', () => {
    const rows = frame('command-code-plan.txt').split('\n');
    // A stale `» accept edits on` row up in the scrollback, above the banner and
    // well outside the 4-content-row window. Command Code keeps its scrollback
    // (#2250 measured `alternate_on` 0), so a pane that has been through two
    // modes this session really does hold both rows.
    rows.splice(5, 0, '  » accept edits on [shift+tab]');

    expect(detectAgentMode('command-code', rows.join('\n'))).toBe('plan');
  });

  it('is measured in CONTENT rows, so blank padding does not exhaust it', () => {
    // codex's bar sits at row 15 of a 1000-row capture; rows 16..1000 are blank.
    // A window counted in raw rows would never reach it.
    const padded = `${frame('codex-plan.txt')}${'\n'.repeat(500)}`;
    expect(detectAgentMode('codex', padded)).toBe('plan');
  });

  it('does not reach past its own window, however much frame is offered', () => {
    const spec = resolveAgentModeSpec('claude');
    expect(spec).not.toBeNull();
    const rows = frame('claude-plan.txt').split('\n');
    const footer = rows.findLastIndex((row) => row.trim() !== '');
    // Push the mode row out of claude's 3-content-row window by stacking four
    // content rows under it.
    rows.splice(footer + 1, 0, 'a', 'b', 'c', 'd');
    expect(readAgentModeFromSpec(spec!, rows.join('\n'))).toBe(AGENT_MODE_UNKNOWN);
  });
});

describe('[#2592] indicators do not fire on text that merely quotes them', () => {
  /**
   * The nearest miss in the repository, and the one that would be worst: a
   * permission dialog offering "switch to accept edits … (shift+tab)" is
   * precisely the screen where a mode chip must NOT claim the mode already
   * changed. The glyph requirement in claude's patterns is what separates them.
   */
  it('claude: a permission dialog quoting "accept edits" is not a mode row', () => {
    const dialog = [
      'Do you want to make this edit to route.ts?',
      '  1. Yes',
      '  2. Yes, and switch to accept edits (auto-approve file edits) for this session (shift+tab)',
      '  3. No, and tell Claude what to do differently (esc)',
    ].join('\n');
    expect(detectAgentMode('claude', dialog)).toBe(AGENT_MODE_UNKNOWN);
  });

  it('command-code: its own dialog row about allowing edits is not a mode row', () => {
    const dialog = [
      '  Create File',
      '  1. Yes',
      '  2. Yes, allow all edits this session [shift+tab]',
    ].join('\n');
    expect(detectAgentMode('command-code', dialog)).toBe(AGENT_MODE_UNKNOWN);
  });

  it('copilot: a reply that contains the word "plan" in prose is not a mode', () => {
    // #1885 / #1897 measured copilot repeating its own chrome vocabulary as body
    // text. Position (the last content rows) plus `·` delimiters is what keeps
    // prose out; a bare `\bplan\b` anywhere in the frame would not.
    const reply = [
      ' Here is the plan I would follow to migrate the router.',
      ' I will plan the work in three steps before editing anything.',
    ].join('\n');
    expect(detectAgentMode('copilot', reply)).toBe(AGENT_MODE_UNKNOWN);
  });
});

describe('[#2592] isReadableAgentMode is the one gate the UI gets to use', () => {
  it('is false for unknown, absent, empty and unrecognised values', () => {
    expect(isReadableAgentMode(AGENT_MODE_UNKNOWN)).toBe(false);
    expect(isReadableAgentMode(undefined)).toBe(false);
    expect(isReadableAgentMode(null)).toBe(false);
    expect(isReadableAgentMode('')).toBe(false);
    // A mode id a NEWER server knows and this bundle does not. The wire is not
    // typechecked, so this really can arrive; it must not become a chip with a
    // raw token in it.
    expect(isReadableAgentMode('yolo')).toBe(false);
  });

  it('is true for every id any tool can actually be read as', () => {
    for (const [tool, file, expected] of CASES) {
      expect(isReadableAgentMode(detectAgentMode(tool, frame(file))), `${tool}/${file}`).toBe(true);
      expect(expected).not.toBe(AGENT_MODE_UNKNOWN);
    }
  });
});

describe('[#2592] §「設計に効く事実」5 — agy modes cannot reach UnsentComposerBar', () => {
  /**
   * The Issue asked whether antigravity's in-composer mode banner could be
   * picked up by `extractComposerText` (#1879) and shown as unsent input. It
   * cannot, and the reason is structural rather than incidental: agy is not in
   * `SUPPORTED_COMPOSER_TOOLS`, so the extractor short-circuits before it looks
   * at a single row.
   *
   * Pinned here rather than left as a note so that widening that set — which is
   * a reasonable thing to want — has to face this question at the moment it is
   * widened, instead of shipping a bar that says `accept-edits`.
   */
  it('antigravity is not a composer-readable tool', () => {
    expect(SUPPORTED_COMPOSER_TOOLS.has('antigravity')).toBe(false);
  });
});
