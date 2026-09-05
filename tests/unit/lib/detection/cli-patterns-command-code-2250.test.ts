/**
 * Issue #2250 — Command Code's pattern constants, read off its own frames.
 *
 * Epic #2249 決定 5 is the rule this file enforces from the pattern side:
 * Command Code's layout is claude-SHAPED, so it is tempting to hand it claude's
 * constants, and that would import claude's history along with them — including
 * the startup-banner reading #2247 had to take back, which fires on any short
 * reply that mentions a version. So every `COMMAND_CODE_*` constant is its own,
 * and this suite pins both halves of what "its own" has to mean:
 *
 *  1. each pattern answers correctly on the six live frames in
 *     `tests/fixtures/command-code-live-2250/` (see its README for provenance);
 *  2. the patterns that IDENTIFY Command Code do not fire on claude's live
 *     frames (`tests/fixtures/claude-live-2247/`), and the ones that describe
 *     the shared bottom-pinned-composer SHAPE are named as such rather than
 *     pretending to discriminate.
 *
 * @vitest-environment node
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  COMMAND_CODE_BANNER_PATTERNS,
  COMMAND_CODE_COMPLETION_PATTERN,
  COMMAND_CODE_HOOK_NOTICE_PATTERN,
  COMMAND_CODE_INTERRUPT_HINT_PATTERN,
  COMMAND_CODE_MODE_INDICATOR_PATTERN,
  COMMAND_CODE_PROMPT_PATTERN,
  COMMAND_CODE_RESPONSE_MARKER_PATTERN,
  COMMAND_CODE_SEPARATOR_PATTERN,
  COMMAND_CODE_SKIP_PATTERNS,
  COMMAND_CODE_SPINNER_CHARS,
  COMMAND_CODE_THINKING_PATTERN,
  CLAUDE_SPINNER_CHARS,
  detectThinking,
  findCommandCodeChromeStart,
  getCliToolPatterns,
  stripAnsi,
} from '@/lib/detection/cli-patterns';

const CC_DIR = path.resolve(__dirname, '../../../fixtures/command-code-live-2250');
const CLAUDE_DIR = path.resolve(__dirname, '../../../fixtures/claude-live-2247');

const CC_FRAMES = [
  'boot-idle',
  'turn-thinking',
  'turn-version',
  'dialog-create-file',
  'turn-tool-write',
  'dialog-shell-command',
] as const;

const CLAUDE_FRAMES = [
  'boot-banner',
  'turn-github-release',
  'turn-version-v12',
  'turn-table',
  'turn-tip',
] as const;

const raw = (dir: string, name: string): string =>
  fs.readFileSync(path.join(dir, `${name}.txt`), 'utf-8');

const cc = (name: string): string => raw(CC_DIR, name);
const clean = (name: string): string => stripAnsi(cc(name));

/** How many lines of a frame one per-line pattern matches. */
const lineHits = (pattern: RegExp, text: string): number =>
  text.split('\n').filter((line) => pattern.test(line)).length;

describe('Issue #2250: the fixtures stay raw and at production geometry', () => {
  it.each(CC_FRAMES)('%s is a 1000-row capture with its escapes intact', (name) => {
    const frame = cc(name);
    expect(frame).toContain('\x1b[');
    expect(frame.split('\n').length).toBeGreaterThan(1000);
  });

  it('captures the 200-column rules the default pane size would not produce', () => {
    // The composer's fences are drawn at the FULL pane width, so a fixture taken
    // at the default 80 columns would still satisfy `─{10,}` while testing a
    // layout production never sees.
    const rules = clean('boot-idle')
      .split('\n')
      .filter((line) => /^─{10,}$/.test(line));
    expect(rules).toHaveLength(2);
    expect(rules[0]).toHaveLength(200);
  });
});

describe('Issue #2250: the constants answer on Command Code frames', () => {
  it('reads the composer row as a prompt on every settled frame', () => {
    for (const name of ['boot-idle', 'turn-version', 'turn-tool-write'] as const) {
      expect(COMMAND_CODE_PROMPT_PATTERN.test(clean(name)), name).toBe(true);
    }
  });

  it('finds two full-width rules around the composer', () => {
    expect(COMMAND_CODE_SEPARATOR_PATTERN.test(clean('turn-version'))).toBe(true);
  });

  it('reads the status row as thinking, and only while a turn is in flight', () => {
    expect(detectThinking('command-code', clean('turn-thinking'))).toBe(true);
    for (const name of ['boot-idle', 'turn-version', 'turn-tool-write'] as const) {
      expect(detectThinking('command-code', clean(name)), name).toBe(false);
    }
  });

  it('does not mistake a CLOSED reasoning block for an open one', () => {
    // `✻ Thinking…` while it streams becomes `✻ Thought for 1 second [ctrl+o to
    // expand]` when it closes, and the past-tense row sits in the transcript of
    // every finished turn — matching it would report every completed pane as
    // still generating.
    expect(clean('turn-version')).toContain('✻ Thought for 1 second');
    expect(COMMAND_CODE_THINKING_PATTERN.test('✻ Thought for 1 second [ctrl+o to expand]')).toBe(
      false,
    );
    expect(COMMAND_CODE_THINKING_PATTERN.test('✻ Thinking… (1 line) [ctrl+o to expand]')).toBe(true);
  });

  it('finds the assistant-message marker once per reply', () => {
    expect(lineHits(COMMAND_CODE_RESPONSE_MARKER_PATTERN, clean('boot-idle'))).toBe(0);
    expect(lineHits(COMMAND_CODE_RESPONSE_MARKER_PATTERN, clean('turn-version'))).toBe(1);
    // Two turns on the pane, two replies.
    expect(lineHits(COMMAND_CODE_RESPONSE_MARKER_PATTERN, clean('turn-tool-write'))).toBe(2);
  });

  it('finds all three banner rows and the block-art logo on the launch screen', () => {
    const boot = clean('boot-idle');
    expect(COMMAND_CODE_BANNER_PATTERNS.map((p) => lineHits(p, boot))).toEqual([1, 1, 1, 5]);
  });

  it('reads the footer mode indicator when the composer is drawn, and not while a dialog is up', () => {
    expect(COMMAND_CODE_MODE_INDICATOR_PATTERN.test(clean('boot-idle'))).toBe(true);
    // A permission dialog takes the whole composer block away, footer included.
    expect(COMMAND_CODE_MODE_INDICATOR_PATTERN.test(clean('dialog-create-file'))).toBe(false);
  });

  it("recognises every permission mode footer, not just the default one", () => {
    // `? for shortcuts` is what DEFAULT mode draws. `ModeIndicator` swaps it out
    // in the other four, so keying an idle rule on that one string would stop
    // recognising an idle pane the moment the operator pressed shift+tab.
    for (const footer of [
      '  ? for shortcuts · taste on',
      '  plan mode [shift+tab]',
      '  » accept edits on [shift+tab]',
      '  » permission bypass on [shift+tab]',
      "  » don't-ask on [shift+tab]",
    ]) {
      expect(COMMAND_CODE_MODE_INDICATOR_PATTERN.test(footer), footer).toBe(true);
    }
  });

  it('treats the turn-completion marker as advisory, because the tool does', () => {
    // Present on the finished turn...
    expect(COMMAND_CODE_COMPLETION_PATTERN.test(clean('turn-version'))).toBe(true);
    // ...and GONE from the same pane one prompt later. It belongs to the live
    // turn's UI, not to the transcript, and `WorkedDurationNote` omits it
    // entirely for a turn under 1000 ms. Nothing may require it.
    expect(clean('dialog-create-file')).toContain('⠶ released v1.40.1');
    expect(COMMAND_CODE_COMPLETION_PATTERN.test(clean('dialog-create-file'))).toBe(false);
  });

  it('matches the hooks notice row, which lands above the first echo', () => {
    // Measured on a hooks-enabled 1.40.1 pane while capturing #2249's evidence;
    // the frames in this directory were captured without hooks, so the row is
    // pinned as the literal the bundle builds
    // (`Ran ${hooksRun} session start hook${plural}`).
    expect(COMMAND_CODE_HOOK_NOTICE_PATTERN.test('◼ Ran 1 session start hook')).toBe(true);
    expect(COMMAND_CODE_HOOK_NOTICE_PATTERN.test('◼ Ran 3 session start hooks')).toBe(true);
    expect(COMMAND_CODE_HOOK_NOTICE_PATTERN.test('⠶ I ran 1 session start hook for you')).toBe(
      false,
    );
  });
});

describe('Issue #2250: the composer block is located structurally', () => {
  it('stops the transcript at the opening rule on every settled frame', () => {
    const lines = (name: string) => cc(name).split('\n');
    // Measured: the index of the rule above the composer.
    expect(findCommandCodeChromeStart(lines('boot-idle'))).toBe(13);
    expect(findCommandCodeChromeStart(lines('turn-thinking'))).toBe(16);
    expect(findCommandCodeChromeStart(lines('turn-version'))).toBe(21);
    expect(findCommandCodeChromeStart(lines('turn-tool-write'))).toBe(32);
  });

  it('excludes the composer placeholder, which is shaped exactly like an echo', () => {
    const lines = cc('boot-idle').split('\n');
    const start = findCommandCodeChromeStart(lines);
    // The row the boundary exists for: after ANSI stripping it satisfies the
    // very `/^[>❯]\s+\S/` scan the extractor anchors turns on (#1879 / #1289).
    expect(stripAnsi(lines[start + 1])).toMatch(/^❯\s+\S/);
    expect(stripAnsi(lines[start + 1])).toContain('Ask your question...');
  });

  it('answers -1 while a permission dialog has replaced the composer', () => {
    for (const name of ['dialog-create-file', 'dialog-shell-command'] as const) {
      expect(findCommandCodeChromeStart(cc(name).split('\n')), name).toBe(-1);
    }
  });

  it('refuses a reply that merely happens to be fenced by two rules', () => {
    const fenced = ['⠶ here is a rule:', '─'.repeat(40), 'some text', '─'.repeat(40), '  done'];
    expect(findCommandCodeChromeStart(fenced)).toBe(-1);
  });
});

describe('Issue #2250: the skip patterns are a cleaner, not a shredder', () => {
  it('drops the banner, the hook notice, the summaries and the chrome', () => {
    const { skipPatterns } = getCliToolPatterns('command-code');
    const dropped = (line: string) => skipPatterns.some((p) => p.test(line));

    expect(dropped('# Command Code v1.40.1')).toBe(true);
    expect(dropped('# models: deepseek-v4-flash-(latest) · taste-1')).toBe(true);
    expect(dropped('# ~/cc2250-probe')).toBe(true);
    expect(dropped('◼ Ran 1 session start hook')).toBe(true);
    expect(dropped(' ✻ Worked for 2s')).toBe(true);
    expect(dropped('✻ Thought for 1 second [ctrl+o to expand]')).toBe(true);
    expect(dropped('─'.repeat(200))).toBe(true);
    expect(dropped('❯ Ask your question...')).toBe(true);
    expect(dropped('  ? for shortcuts · taste on')).toBe(true);
  });

  it('keeps the reply body and the tool block', () => {
    const { skipPatterns } = getCliToolPatterns('command-code');
    const dropped = (line: string) => skipPatterns.some((p) => p.test(line));

    expect(dropped('⠶ released v1.40.1')).toBe(false);
    expect(dropped('⠶ Done.')).toBe(false);
    expect(dropped(' WRITE  [probe.txt]')).toBe(false);
    expect(dropped(' └  Created probe.txt (1 line)')).toBe(false);
    // Deliberately no `^\s*│` rule (the one codex carries): Command Code renders
    // file previews with that glyph.
    expect(dropped('     1 │ hello')).toBe(false);
    // The 2-space continuation row of a wrapped reply.
    expect(dropped('  finishes.')).toBe(false);
  });

  it('is the list `getCliToolPatterns` hands out for this tool', () => {
    expect(getCliToolPatterns('command-code').skipPatterns).toEqual([...COMMAND_CODE_SKIP_PATTERNS]);
    expect(getCliToolPatterns('command-code').promptPattern).toBe(COMMAND_CODE_PROMPT_PATTERN);
    expect(getCliToolPatterns('command-code').thinkingPattern).toBe(COMMAND_CODE_THINKING_PATTERN);
  });
});

describe('Issue #2250: both thinking branches are load-bearing on their own', () => {
  // The live `turn-thinking.txt` row carries BOTH signals at once
  // (` ⌘ Planning…  esc to interrupt • 0s • ↓ 0`), so it cannot show either
  // branch to be necessary. The two rows below are the states in which only one
  // of them exists; each is reconstructed from the shipped bundle rather than
  // captured, and the source is quoted so a reader can check it.
  const LIVE_ROW = ' ⌘ Planning…  esc to interrupt • 0s • ↓ 0';

  it('the live row really does carry both, so neither branch is proved by it alone', () => {
    expect(clean('turn-thinking')).toContain(LIVE_ROW);
    expect(COMMAND_CODE_INTERRUPT_HINT_PATTERN.test(LIVE_ROW)).toBe(true);
    expect(/[·○◇☆✧⌘]\s+[A-Za-z]+…/.test(LIVE_ROW)).toBe(true);
  });

  it('the spinner branch answers when the pane is too narrow for the hint', () => {
    // `Status`'s `layoutMode` ladder drops the whole `esc to interrupt • … • ↓ …`
    // tail below 42 columns and renders the icon and the shimmer text alone.
    const narrowRow = ' ⌘ Planning… ';
    expect(COMMAND_CODE_INTERRUPT_HINT_PATTERN.test(narrowRow)).toBe(false);
    expect(COMMAND_CODE_THINKING_PATTERN.test(narrowRow)).toBe(true);
  });

  it('the hint branch answers while a shell tool runs, where there is no ellipsis', () => {
    // The bundle passes `status: r.isExecuting ? `Executing: ${r.currentCommand}`
    // : o` — so during a tool call the row carries no `…` at all and the spinner
    // branch has nothing to match.
    const executingRow = ' ⌘ Executing: npm test  esc to interrupt • 12s • ↓ 480';
    expect(/[·○◇☆✧⌘]\s+[A-Za-z]+…/.test(executingRow)).toBe(false);
    expect(COMMAND_CODE_THINKING_PATTERN.test(executingRow)).toBe(true);
  });
});

describe('Issue #2250: Command Code patterns do not misfire on claude frames', () => {
  const claudeFrames = CLAUDE_FRAMES.map((name) => [name, stripAnsi(raw(CLAUDE_DIR, name))] as const);

  it.each(claudeFrames)('%s is not read as a Command Code turn', (_name, frame) => {
    // The five patterns that IDENTIFY Command Code. Measured 0 / false on all
    // five live claude v2.1.258 frames.
    expect(detectThinking('command-code', frame)).toBe(false);
    expect(COMMAND_CODE_COMPLETION_PATTERN.test(frame)).toBe(false);
    expect(lineHits(COMMAND_CODE_RESPONSE_MARKER_PATTERN, frame)).toBe(0);
    expect(COMMAND_CODE_BANNER_PATTERNS.map((p) => lineHits(p, frame))).toEqual([0, 0, 0, 0]);
    expect(lineHits(COMMAND_CODE_HOOK_NOTICE_PATTERN, frame)).toBe(0);
  });

  it('names the two patterns that describe a SHARED shape rather than an identity', () => {
    // Honesty clause. `❯` composers fenced by `─` rules are what claude v2 and
    // Command Code both draw, so these two DO match claude — and the suite says
    // so rather than asserting a separation that does not exist. Nothing in the
    // detection chain identifies Command Code from either one alone: the tool id
    // is chosen by the session, and these only answer "is the composer drawn?".
    for (const [name, frame] of claudeFrames) {
      expect(COMMAND_CODE_PROMPT_PATTERN.test(frame), name).toBe(true);
      expect(COMMAND_CODE_SEPARATOR_PATTERN.test(frame), name).toBe(true);
    }
  });

  it('keeps the braille reply marker out of every spinner character class', () => {
    // `⠶` is U+2836. Adding it to a spinner class — claude's, or Command Code's
    // own — would make the first row of every reply read as "still generating",
    // which is the trap Issue #2250 names explicitly.
    expect(CLAUDE_SPINNER_CHARS).not.toContain('⠶');
    expect(COMMAND_CODE_SPINNER_CHARS as readonly string[]).not.toContain('⠶');
    expect(COMMAND_CODE_THINKING_PATTERN.test('⠶ ok…')).toBe(false);
    expect(COMMAND_CODE_THINKING_PATTERN.test('⠶ released v1.40.1')).toBe(false);
  });

  it('anchors the spinner branch so mid-line separator dots cannot trip it', () => {
    // Both rows below carry `·`. Neither is a status row.
    expect(COMMAND_CODE_THINKING_PATTERN.test('# models: deepseek-v4-flash-(latest) · taste-1')).toBe(
      false,
    );
    expect(COMMAND_CODE_THINKING_PATTERN.test('  ? for shortcuts · taste on')).toBe(false);
  });
});
