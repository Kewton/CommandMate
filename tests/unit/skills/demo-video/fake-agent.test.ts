/**
 * fake-agent.sh replay behaviour (Issue #1553).
 *
 * The load-bearing assertion is the last describe: the committed cassette is fed
 * to the *real* status detector, so a fixture that no longer drives
 * running -> ready fails here instead of during a recording session. Timing is
 * asserted from the --dry-run schedule rather than the wall clock; the one
 * wall-clock assertion is a lower bound, which cannot flake upward.
 *
 * @vitest-environment node
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { detectSessionStatus } from '@/lib/detection/status-detector';
import { CACHE_TTL_MS } from '@/lib/tmux/tmux-capture-cache';

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const SKILL = path.join(REPO_ROOT, '.claude/skills/demo-video');
const SCRIPT = path.join(SKILL, 'scripts/fake-agent.sh');
const CASSETTE = path.join(SKILL, 'fixtures/claude-session-sample.cast');

const ESC = String.fromCharCode(27);
const CLEAR = `${ESC}[2J${ESC}[3J${ESC}[H`;

const tmpFiles: string[] = [];
function tmpCassette(contents: string): string {
  const file = path.join(os.tmpdir(), `demo-video-cassette-${tmpFiles.length}-${process.pid}.cast`);
  fs.writeFileSync(file, contents);
  tmpFiles.push(file);
  return file;
}

afterAll(() => {
  for (const file of tmpFiles) fs.rmSync(file, { force: true });
});

/**
 * Draining is off by default here (Issue #1810).
 *
 * Every fixture below queues its submissions on one pipe, where they are all
 * readable at once — the shape of two messages seconds apart in production, but
 * indistinguishable from one multi-line message to a reader. `--input-settle 0`
 * makes each line its own submission, which is what these cases model; the
 * multi-line case turns it back on and is tested on its own.
 */
function run(args: string[], input = '') {
  const settled = args.includes('--input-settle') ? args : [...args, '--input-settle', '0'];
  return spawnSync('bash', [SCRIPT, ...settled], { input, encoding: 'utf8' });
}

describe('argument handling', () => {
  it('rejects an unknown option', () => {
    const result = run([CASSETTE, '--nope']);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('unknown option');
  });

  it('rejects a missing cassette', () => {
    const result = run([path.join(os.tmpdir(), 'does-not-exist.cast')]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('cassette not found');
  });

  it.each(['0', '-1', 'fast', ''])('rejects --speed %s', (speed) => {
    const result = run([CASSETTE, `--speed=${speed}`]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('--speed');
  });

  it('rejects a cassette with no playable rows', () => {
    // A comment-only file used to be indistinguishable from a working one: the
    // loop simply produced nothing.
    const file = tmpCassette('# only comments\n\n   \n');
    const result = run([file, '--once']);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('no playable rows');
  });

  it('rejects a non-numeric delay', () => {
    const file = tmpCassette('later\tboom\n');
    const result = run([file, '--once']);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('must be @input or an integer ms');
  });
});

describe('schedule', () => {
  function trace(args: string[], input = 'hello\ny\n'): string[] {
    const result = run([CASSETTE, '--once', '--dry-run', ...args], input);
    expect(result.status).toBe(0);
    return result.stderr.trim().split('\n');
  }

  it('replays rows in cassette order and blocks for input at the composer', () => {
    const lines = trace([]);
    expect(lines[0]).toMatch(/^trace step=1 kind=sleep ms=0$/);
    expect(lines[1]).toBe('trace step=2 kind=input');
    // Two barriers: the instruction, then the answer to the approval prompt.
    expect(lines.filter((l) => l.includes('kind=input'))).toHaveLength(2);
  });

  it('divides every delay by --speed', () => {
    const baseline = trace([]).filter((l) => l.includes('kind=sleep'));
    const doubled = trace(['--speed', '2']).filter((l) => l.includes('kind=sleep'));
    expect(doubled).toHaveLength(baseline.length);

    const ms = (line: string) => Number(/ms=(\d+)$/.exec(line)![1]);
    expect(baseline.map(ms)).toEqual([0, 600, 2200, 2200, 2200, 2200, 2200, 6000]);
    expect(doubled.map(ms)).toEqual([0, 300, 1100, 1100, 1100, 1100, 1100, 3000]);
  });

  it('actually sleeps when --dry-run is not given', () => {
    // Lower bound only. The scaled schedule below sums to 1000ms; a run that
    // returns faster than that has stopped honouring delays altogether.
    const file = tmpCassette('500\tfirst\n500\tsecond\n');
    const started = Date.now();
    const result = run([file, '--once'], '');
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('firstsecond');
    expect(Date.now() - started).toBeGreaterThanOrEqual(950);
  });
});

describe('composer echo', () => {
  it('substitutes the received line into {{INPUT}}', () => {
    const file = tmpCassette('@input\tgot:{{INPUT}}\\n');
    const result = run([file, '--once'], 'Add a dark mode toggle\n');
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('got:Add a dark mode toggle\n');
  });

  it('treats the received line as data, never as a printf format string', () => {
    const file = tmpCassette('@input\t[{{INPUT}}]\\n');
    const result = run([file, '--once'], '%s %d \\e[31m 100%\n');
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('[%s %d \\e[31m 100%]\n');
  });

  it('stops cleanly when stdin closes before a message arrives', () => {
    const result = run([CASSETTE, '--once'], '');
    expect(result.status).toBe(0);
  });
});

describe('the committed cassette drives the real status detector', () => {
  const result = run(
    [CASSETTE, '--once', '--dry-run'],
    'Add a dark mode toggle to the header\ny\n',
  );
  const frames = result.stdout.split(CLEAR).filter((frame) => frame.trim() !== '');
  const statuses = frames.map((frame) => detectSessionStatus(frame, 'claude'));

  it('emits every frame', () => {
    expect(result.status).toBe(0);
    expect(frames).toHaveLength(10);
  });

  it('opens ready, so the session survives isSessionHealthy and is not killed', () => {
    // An empty or prompt-less pane is treated as a dead CLI and the session is
    // killed (src/lib/session/claude-session.ts ensureHealthySession).
    expect(statuses[0].status).toBe('ready');
    expect(statuses[0].reason).toBe('input_prompt');
  });

  it('walks ready -> running -> waiting -> running -> ready', () => {
    // Exactly the arc the storyboard films: sessions-overview and
    // send-and-generate need `running`, respond-from-mobile needs `waiting`,
    // and complete needs the return to `ready`.
    expect(statuses.map((s) => s.status)).toEqual([
      'ready',
      'ready',
      'running',
      'running',
      'running',
      'waiting',
      'running',
      'running',
      'ready',
      'ready',
    ]);
    expect(statuses.every((s) => s.confidence === 'high')).toBe(true);
  });

  it('returns to ready once the reply lands', () => {
    expect(statuses.at(-1)!.status).toBe('ready');
    expect(statuses.at(-1)!.reason).toBe('input_prompt');
  });

  it('parks on the approval prompt with an active prompt the mobile sheet can render', () => {
    // MobilePromptSheet is driven by isPromptWaiting, which
    // current-output-builder.ts takes verbatim from hasActivePrompt. Without a
    // prompt payload the respond-from-mobile scene would have nothing to tap.
    const waiting = statuses.find((s) => s.status === 'waiting')!;
    expect(waiting.reason).toBe('prompt_detected');
    expect(waiting.hasActivePrompt).toBe(true);
    expect(waiting.promptDetection.promptData?.type).toBe('multiple_choice');
    expect(waiting.promptDetection.promptData?.question).toContain('Do you want to proceed?');
  });

  it('keeps the rendered question short enough to read on a phone', () => {
    // detectMultipleChoicePrompt walks upward through continuation lines and
    // folds them into the question. With the transcript left above the prompt
    // it produced a 100-character run-on that MobilePromptSheet would show
    // verbatim; the frame keeps the live capture's shape (tool call, blank
    // line, question) precisely so that stays short.
    const waiting = statuses.find((s) => s.status === 'waiting')!;
    expect(waiting.promptDetection.promptData!.question.length).toBeLessThan(60);
  });

  it('pre-selects the affirmative option, so approving really is one tap', () => {
    // MobilePromptSheet seeds its radio group from `isDefault`. Without the
    // U+276F marker on option 1 the submit button starts disabled and the
    // storyboard's "one tap" telop would be a lie.
    const waiting = statuses.find((s) => s.status === 'waiting')!;
    const options = waiting.promptDetection.promptData!.options as Array<{
      number: number;
      label: string;
      isDefault: boolean;
    }>;
    expect(options.map((option) => option.label)).toEqual([
      'Yes',
      'No, and tell Claude what to do differently',
    ]);
    expect(options.find((option) => option.isDefault)).toMatchObject({ number: 1, label: 'Yes' });
  });

  it('blocks on input at the approval prompt rather than timing it', () => {
    // The recorder needs however long a browser launch and a mobile navigation
    // take. A numeric delay here would make the take a race against Playwright.
    const rows = fs
      .readFileSync(CASSETTE, 'utf8')
      .split('\n')
      .filter((line) => line.trim() !== '' && !line.startsWith('#'));
    const waitingIndex = statuses.findIndex((s) => s.status === 'waiting');
    expect(waitingIndex).toBeGreaterThan(0);
    expect(rows[waitingIndex + 1].split('\t')[0]).toBe('@input');
  });

  it('holds the running frames on screen for longer than the capture cache', () => {
    // `/api/worktrees` serves status from a 5s TTL cache of `capture-pane`
    // (src/lib/tmux/tmux-capture-cache.ts), so a generation shorter than that
    // can start and finish entirely inside one cache window: the sidebar dot
    // never turns green and the demo shows nothing. A frame is on screen until
    // the *next* row's delay elapses, so the running window is the sum of the
    // delays that follow each running frame.
    const delays = fs
      .readFileSync(CASSETTE, 'utf8')
      .split('\n')
      .filter((line) => line.trim() !== '' && !line.startsWith('#'))
      .map((line) => line.split('\t')[0]);
    expect(delays).toHaveLength(statuses.length);

    let runningWindowMs = 0;
    statuses.forEach((status, index) => {
      const nextDelay = delays[index + 1];
      if (status.status === 'running' && nextDelay !== undefined && nextDelay !== '@input') {
        runningWindowMs += Number(nextDelay);
      }
    });
    expect(runningWindowMs).toBeGreaterThan(CACHE_TTL_MS * 1.5);
  });

  it('keeps the anchors the detector actually matches', () => {
    const raw = fs.readFileSync(CASSETTE, 'utf8');
    // Stripping the ANSI or trimming the separator is exactly how a "tidied"
    // fixture stops describing anything the product emits (cf. Issue #1522).
    expect(raw).toMatch(/\\e\[38;5;\d+m/);
    expect(raw).toContain('esc to interrupt');
    expect(raw).toContain('? for shortcuts');
    expect(raw).toMatch(/─{10,}/);
  });
});

describe('mutating the cassette breaks the run/ready/waiting contract', () => {
  // Without these, every assertion above is also satisfied by a detector that
  // simply never returns the status in question.
  function statusesOf(contents: string): string[] {
    const file = tmpCassette(contents);
    const result = run([file, '--once', '--dry-run'], 'hi\ny\n');
    return result.stdout
      .split(CLEAR)
      .filter((frame) => frame.trim() !== '')
      .map((frame) => detectSessionStatus(frame, 'claude').status);
  }

  it('loses the running frames when "esc to interrupt" and the spinner go away', () => {
    const raw = fs.readFileSync(CASSETTE, 'utf8');
    expect(
      statusesOf(raw.replace(/esc to interrupt/g, '? for shortcuts').replace(/\\u2026|…/g, '')),
    ).not.toContain('running');
  });

  it('loses the ready frames when the prompt marker goes away', () => {
    const raw = fs.readFileSync(CASSETTE, 'utf8');
    expect(statusesOf(raw.replace(/❯/g, '|'))).not.toContain('ready');
  });

  it('loses the waiting frame when the numbered options go away', () => {
    // Proves the approval beat is detected because of the option block the live
    // capture recorded, not because some unrelated bytes happen to trip the
    // detector.
    const raw = fs.readFileSync(CASSETTE, 'utf8');
    const flattened = raw
      .replace(/1\. Yes/g, 'yes')
      .replace(/2\. No, and tell Claude what to do differently/g, 'no');
    expect(statusesOf(flattened)).not.toContain('waiting');
  });

  // Issue #1676 changed the detector's semantics: a frame with a collected ❯
  // indicator is exempt from the Layer 5 question-line requirement, and an
  // indicator-less frame is still rescued by a question line (#193). Either
  // signal alone therefore sustains `waiting`; the mutation kill needs both
  // removed. The two `keeps` cases pin each rescue path individually so the
  // combined kill cannot pass vacuously.
  it('keeps the waiting frame when only the question line goes away (Issue #1676)', () => {
    const raw = fs.readFileSync(CASSETTE, 'utf8');
    expect(statusesOf(raw.replace(/Do you want to proceed\?/g, 'Proceeding'))).toContain('waiting');
  });

  it('keeps the waiting frame when only the option ❯ goes away (#193 artifact tolerance)', () => {
    const raw = fs.readFileSync(CASSETTE, 'utf8');
    expect(statusesOf(raw.replace(/❯\\e\[39m 1\. Yes/g, '\\e[39m  1. Yes'))).toContain('waiting');
  });

  it('loses the waiting frame when the question line and the option ❯ both go away', () => {
    const raw = fs.readFileSync(CASSETTE, 'utf8');
    const mutated = raw
      .replace(/Do you want to proceed\?/g, 'Proceeding')
      .replace(/❯\\e\[39m 1\. Yes/g, '\\e[39m  1. Yes');
    expect(statusesOf(mutated)).not.toContain('waiting');
  });
});

describe('{{TASK}} substitution', () => {
  it('keeps echoing the original instruction after a second input arrives', () => {
    // {{INPUT}} is the answer by then. Echoing "y" as the instruction would put
    // a claim on screen the product never made.
    const file = tmpCassette(
      ['@input\ta:{{INPUT}}/{{TASK}}\\n', '@input\tb:{{INPUT}}/{{TASK}}\\n', ''].join('\n'),
    );
    const result = run([file, '--once'], 'do the thing\ny\n');
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('a:do the thing/do the thing\nb:y/do the thing\n');
  });

  it('resets the task between passes so a looping cassette does not leak the old one', () => {
    const file = tmpCassette('@input\t[{{TASK}}]\\n');
    const result = run([file], 'first\nsecond\n');
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('[first]\n[second]\n');
  });

  it('the committed cassette echoes the task, not the answer, after the approval', () => {
    const result = run([CASSETTE, '--once', '--dry-run'], 'Add a dark mode toggle to the header\ny\n');
    const frames = result.stdout.split(CLEAR).filter((frame) => frame.trim() !== '');
    expect(frames.at(-1)).toContain('Add a dark mode toggle to the header');
    expect(frames.at(-1)).not.toMatch(/❯\s+y\s*$/m);
  });
});


/**
 * A multi-line message is one submission (Issue #1810).
 *
 * `commandmate send --contract` prepends a preamble dozens of lines long, and
 * CommandMate types the whole thing into the pane before pressing Enter — so it
 * arrives as many lines on stdin. Read as one `@input` each, the cassette raced
 * through a full pass per line: the approval frame was painted and immediately
 * answered by the next line of the *same* message, and `commandmate wait`
 * reported `Completed` about work that had not happened (measured on the
 * contract-verify take before this landed).
 */
describe('a multi-line submission', () => {
  const CASSETTE_TWO_INPUTS = tmpCassette(
    ['@input\tA:{{INPUT}}\n', '0\tmid\n', '@input\tB:{{INPUT}}\n', '0\tend\n'].join(''),
  );

  it('advances one @input row, not one per line', () => {
    const result = run(
      [CASSETTE_TWO_INPUTS, '--once', '--input-settle', '1'],
      '## contract\nline two\nline three\n',
    );
    expect(result.status).toBe(0);
    // The first line is what the pane echoes, the way a TUI shows a pasted
    // block; the rest are consumed so they cannot answer a later prompt.
    expect(result.stdout).toContain('A:## contract');
    expect(result.stdout).not.toContain('B:');
    expect(result.stdout).not.toContain('line two');
  });

  it('still takes two separate submissions as two, when they are separate', () => {
    // The production case: the answer to an approval arrives seconds after the
    // message that caused it, so the drain has long since timed out. A closed
    // pipe ends the drain at once, which is why this fixture models the gap by
    // running with draining disabled.
    const result = run([CASSETTE_TWO_INPUTS, '--once'], 'first\nsecond\n');
    expect(result.stdout).toContain('A:first');
    expect(result.stdout).toContain('B:second');
  });

  it('rejects a settle value that is not whole seconds', () => {
    // bash 3.2's `read -t` takes no fraction, so `0.05` would abort the replay
    // at the first @input row rather than at startup.
    const result = run([CASSETTE_TWO_INPUTS, '--input-settle', '0.5']);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('--input-settle must be a whole number of seconds');
  });
});

// ---------------------------------------------------------------------------
// Issue #2380: one pane per tool, `@exec` rows, `@transcript` rows, --idle-only
// ---------------------------------------------------------------------------

import { CLI_TOOL_IDS } from '@/lib/cli-tools/types';
import { resolveSessionName } from '@/lib/cli-tools/session-name';
import {
  OPENCODE_PANE_HEIGHT,
  OPENCODE_PANE_WIDTH,
  TUI_PANE_HEIGHT,
  TUI_PANE_WIDTH,
} from '@/config/tmux-pane-config';
import {
  buildClaudeTurns,
  isClaudeOperatorPromptRecord,
  isClaudeTurnWritable,
  parseClaudeTranscript,
  renderClaudeTurn,
} from '@/lib/hooks/sources/claude/transcript';
import {
  buildCodexTurns,
  parseCodexRollout,
  renderCodexTurn,
} from '@/lib/hooks/sources/codex/transcript';
import { claudeTurnRequestId, codexTurnRequestId } from '@/types/agent-transcript';

const FIXTURES = path.join(SKILL, 'fixtures');
const CODEX_CASSETTE = path.join(FIXTURES, 'codex-review.cast');
const CLAUDE_DELEGATE_CASSETTE = path.join(FIXTURES, 'claude-delegate.cast');
const IDLE_CASSETTES: Array<[string, string]> = [
  ['antigravity', 'antigravity-idle.cast'],
  ['opencode', 'opencode-idle.cast'],
  ['command-code', 'command-code-idle.cast'],
];

/** A scratch tree with a stub `tmux` and a stub `commandmate` on it. */
const STUB_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'demo-video-fake-agent-2380-'));
const STUB_BIN = path.join(STUB_ROOT, 'bin');
const TMUX_LOG = path.join(STUB_ROOT, 'tmux.log');
const COMMANDMATE_LOG = path.join(STUB_ROOT, 'commandmate.log');
const CLAUDE_SID = '11111111-2222-4333-8444-555555555555';
const CODEX_SID = '66666666-7777-4888-9999-aaaaaaaaaaaa';

fs.mkdirSync(STUB_BIN, { recursive: true });
fs.writeFileSync(
  path.join(STUB_BIN, 'tmux'),
  [
    '#!/usr/bin/env bash',
    // Every invocation on one line, arguments joined by a unit separator, so
    // the command string tmux would hand to `sh -c` is readable back verbatim.
    'line=""',
    'for a in "$@"; do line="$line$a$(printf \'\\037\')"; done',
    'printf \'%s\\n\' "$line" >>"$TMUX_STUB_LOG"',
    'case "$1" in has-session) exit 1 ;; esac',
    'exit 0',
    '',
  ].join('\n'),
  { mode: 0o755 },
);
fs.writeFileSync(
  path.join(STUB_BIN, 'commandmate'),
  [
    '#!/usr/bin/env bash',
    // argv as one line per element between markers, so a value spliced into
    // one element cannot be confused with two.
    'printf \'stub-commandmate\\n\'',
    'for a in "$@"; do printf \'[%s]\\n\' "$a"; done',
    'printf \'CM_PORT=%s\\n\' "${CM_PORT:-unset}"',
    'printf \'HOME=%s\\n\' "$HOME"',
    'printf \'%s\\n\' "$*" >>"${COMMANDMATE_STUB_LOG:-/dev/null}"',
    'exit "${COMMANDMATE_STUB_EXIT:-0}"',
    '',
  ].join('\n'),
  { mode: 0o755 },
);
// A second executable, to prove --commandmate really redirects the word.
fs.writeFileSync(
  path.join(STUB_BIN, 'cm-alt'),
  ['#!/usr/bin/env bash', 'printf \'alt:%s\\n\' "$*"', ''].join('\n'),
  { mode: 0o755 },
);

afterAll(() => {
  fs.rmSync(STUB_ROOT, { recursive: true, force: true });
});

function runWithStubs(args: string[], input = '', env: Record<string, string> = {}) {
  const settled = args.includes('--input-settle') ? args : [...args, '--input-settle', '0'];
  return spawnSync('bash', [SCRIPT, ...settled], {
    input,
    encoding: 'utf8',
    cwd: STUB_ROOT,
    env: {
      ...process.env,
      PATH: `${STUB_BIN}:${process.env.PATH ?? ''}`,
      TMUX_STUB_LOG: TMUX_LOG,
      COMMANDMATE_STUB_LOG: COMMANDMATE_LOG,
      ...env,
    },
  });
}

/** The arguments of the last `tmux new-session` the stub saw. */
function lastNewSession(): string[] {
  const call = fs.readFileSync(TMUX_LOG, 'utf8').split('\n')
    .map((line) => line.split('\u001f').filter((_, i, all) => i < all.length - 1))
    .reverse()
    .find((argv) => argv[0] === 'new-session');
  if (!call) throw new Error(`no new-session in ${TMUX_LOG}`);
  return call;
}

function flag(argv: string[], name: string): string {
  const index = argv.indexOf(name);
  if (index < 0) throw new Error(`${name} not in ${argv.join(' ')}`);
  return argv[index + 1];
}

describe('--tool derives the session name and pane geometry (Issue #2380)', () => {
  it('knows exactly the tool ids the product knows', () => {
    // KNOWN_TOOLS in the script is a copy of CLI_TOOL_IDS; a ninth tool added to
    // the product fails here rather than silently getting claude's geometry.
    const source = fs.readFileSync(SCRIPT, 'utf8');
    const match = /^KNOWN_TOOLS="([^"]+)"$/m.exec(source);
    expect(match).not.toBeNull();
    expect(match![1].split(' ')).toEqual([...CLI_TOOL_IDS]);
  });

  it.each([...CLI_TOOL_IDS])('names the %s pane the way getSessionName does', (tool) => {
    fs.rmSync(TMUX_LOG, { force: true });
    const result = runWithStubs([CASSETTE, '--tool', tool, '--worktree', 'wt-dark-mode']);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(resolveSessionName(tool, 'wt-dark-mode'));
    const argv = lastNewSession();
    expect(flag(argv, '-s')).toBe(`mcbd-${tool}-wt-dark-mode`);
  });

  it('sizes every pane like TUI_PANE_WIDTH x TUI_PANE_HEIGHT, except opencode', () => {
    fs.rmSync(TMUX_LOG, { force: true });
    expect(runWithStubs([CASSETTE, '--tool', 'codex', '--worktree', 'wt']).status).toBe(0);
    let argv = lastNewSession();
    expect(Number(flag(argv, '-x'))).toBe(TUI_PANE_WIDTH);
    expect(Number(flag(argv, '-y'))).toBe(TUI_PANE_HEIGHT);

    fs.rmSync(TMUX_LOG, { force: true });
    expect(runWithStubs([CASSETTE, '--tool', 'opencode', '--worktree', 'wt']).status).toBe(0);
    argv = lastNewSession();
    // 80 columns: wider than 120 paints opencode's sidebar into every captured
    // row (#2047), which is why the product sizes it differently.
    expect(Number(flag(argv, '-x'))).toBe(OPENCODE_PANE_WIDTH);
    expect(Number(flag(argv, '-y'))).toBe(OPENCODE_PANE_HEIGHT);
  });

  it('reads the tool off an explicit --session name when --tool is absent', () => {
    fs.rmSync(TMUX_LOG, { force: true });
    expect(runWithStubs([CASSETTE, '--session', 'mcbd-opencode-wt-dark-mode']).status).toBe(0);
    const argv = lastNewSession();
    expect(Number(flag(argv, '-x'))).toBe(OPENCODE_PANE_WIDTH);
    // `command-code` has a hyphen of its own; the longest known id wins, not
    // the first `-`.
    fs.rmSync(TMUX_LOG, { force: true });
    expect(runWithStubs([CASSETTE, '--session', 'mcbd-command-code-wt-dark-mode']).status).toBe(0);
    expect(lastNewSession().join(' ')).toContain("--tool 'command-code'");
  });

  it('refuses a --session that belongs to another tool', () => {
    const result = runWithStubs([CASSETTE, '--tool', 'codex', '--session', 'mcbd-claude-wt-dark-mode']);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('is not a codex session');
  });

  it('refuses an unknown tool, and --tool without a worktree to name', () => {
    expect(runWithStubs([CASSETTE, '--tool', 'cursor', '--worktree', 'wt']).stderr).toContain(
      '--tool must be one of',
    );
    const result = runWithStubs([CASSETTE, '--tool', 'codex', '--record-to', path.join(STUB_ROOT, 's')]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('--tool needs --worktree');
  });

  it('refuses a worktree id outside the session-name alphabet', () => {
    const result = runWithStubs([CASSETTE, '--tool', 'codex', '--worktree', 'wt;rm']);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('--worktree must match');
  });

  it('spells the isolated HOME, PATH and the demo port into the pane command', () => {
    // The pane inherits the tmux SERVER's environment — the developer's real
    // HOME — so the launcher must say what the replay and its `@exec` children
    // see. A `commandmate` run from the pane would otherwise read the
    // developer's ~/.commandmate/.env and dial their live instance.
    fs.rmSync(TMUX_LOG, { force: true });
    const home = path.join(STUB_ROOT, 'iso home');
    fs.mkdirSync(home, { recursive: true });
    const result = runWithStubs(
      [CASSETTE, '--tool', 'codex', '--worktree', 'wt', '--port', '3399', '--idle-only',
        '--transcript', path.join(STUB_ROOT, `rollout-x-${CODEX_SID}.jsonl`)],
      '',
      { HOME: home },
    );
    expect(result.status).toBe(0);
    const command = lastNewSession().at(-1)!;
    expect(command.startsWith(`env HOME='${home}' PATH='`)).toBe(true);
    expect(command).toContain('--inner --tool \'codex\'');
    expect(command).toContain('--worktree \'wt\'');
    expect(command).toContain('--port \'3399\'');
    expect(command).toContain('--idle-only');
    expect(command).toContain(`--transcript '${path.join(STUB_ROOT, `rollout-x-${CODEX_SID}.jsonl`)}'`);
    // --once is the default's opposite: not forwarded unless given.
    expect(command).not.toContain('--once');
  });

  it('refuses port 3000 for @exec, like every other demo script', () => {
    const result = runWithStubs([CASSETTE, '--port', '3000', '--once', '--dry-run']);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('must not be 3000');
  });
});

describe('@exec rows (Issue #2380)', () => {
  it.each([
    'ls -la',
    'commandmate-ish ask wt',
    'commandmate ask wt; rm -rf /',
    'commandmate ask wt && echo pwned',
    'commandmate ask wt | tee out',
    'commandmate ask $(whoami)',
    'commandmate ask `whoami`',
    'commandmate ask wt > /tmp/out',
    'commandmate ask wt < /etc/passwd',
    'commandmate ask (wt)',
    '',
  ])('refuses the cassette before the first row plays: %j', (command) => {
    const file = tmpCassette(`0\tidle\\n\n@exec\t${command}\n0\tdone\\n\n`);
    const result = runWithStubs([file, '--once']);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("@exec may only run 'commandmate …'");
    // Nothing played: the idle frame is not on stdout and the stub never ran.
    expect(result.stdout).toBe('');
  });

  it('runs a commandmate command in the replay, streaming its output to the pane', () => {
    fs.rmSync(COMMANDMATE_LOG, { force: true });
    const file = tmpCassette(
      '0\tidle\\n\n@input\techo:{{INPUT}}\\n\n@exec\tcommandmate ask {{WORKTREE}} --instance codex "Review {{TASK}}" --json\n0\tdone\\n\n',
    );
    const result = runWithStubs([file, '--once', '--worktree', 'wt-dark-mode', '--port', '3399'], 'the "toggle" \\ header\n');
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(
      [
        'idle',
        'echo:the "toggle" \\ header',
        'stub-commandmate',
        '[ask]',
        '[wt-dark-mode]',
        '[--instance]',
        '[codex]',
        // One argv element: the placeholder was spliced after word splitting,
        // so the quotes in the message did not break the row's own quoting.
        '[Review the "toggle" \\ header]',
        '[--json]',
        'CM_PORT=3399',
        `HOME=${process.env.HOME}`,
        'done',
        '',
      ].join('\n'),
    );
  });

  it('leaves CM_PORT alone when --port is not given', () => {
    const file = tmpCassette('@exec\tcommandmate ls\n');
    const result = runWithStubs([file, '--once'], '', { CM_PORT: '' });
    expect(result.stdout).toContain('CM_PORT=unset');
  });

  it('reports a failing command on the pane and keeps replaying', () => {
    const file = tmpCassette('@exec\tcommandmate ask wt\n0\tafter\\n\n');
    const result = runWithStubs([file, '--once'], '', { COMMANDMATE_STUB_EXIT: '3' });
    expect(result.status).toBe(0);
    expect(result.stderr).toContain('@exec exited 3');
    expect(result.stdout.endsWith('after\n')).toBe(true);
  });

  it('runs whatever --commandmate names in place of the word', () => {
    // demo-video.sh points this at `node_modules/.bin/tsx src/cli/index.ts`,
    // two words, so the value is split on whitespace.
    const file = tmpCassette('@exec\tcommandmate ls --json\n');
    const result = runWithStubs([file, '--once', '--commandmate', `${path.join(STUB_BIN, 'cm-alt')} first`]);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('alt:first ls --json\n');
  });

  it('traces and does not run under --dry-run', () => {
    fs.rmSync(COMMANDMATE_LOG, { force: true });
    const file = tmpCassette('@exec\tcommandmate ask {{WORKTREE}} --json\n');
    const result = runWithStubs([file, '--once', '--dry-run', '--worktree', 'wt']);
    expect(result.status).toBe(0);
    expect(result.stderr).toContain('kind=exec command=commandmate ask wt --json');
    expect(result.stdout).not.toContain('stub-commandmate');
    expect(fs.existsSync(COMMANDMATE_LOG)).toBe(false);
  });

  it('does not let the command read the pane\'s stdin', () => {
    // The next @input row owns stdin; a CLI that read from it would eat the
    // message CommandMate sends next.
    const file = tmpCassette('@exec\tcommandmate ask wt\n@input\tgot:{{INPUT}}\\n\n');
    const result = runWithStubs([file, '--once'], 'second\n');
    expect(result.stdout).toContain('got:second');
  });
});

describe('@transcript rows (Issue #2380)', () => {
  const dir = path.join(STUB_ROOT, 'transcripts');
  fs.mkdirSync(dir, { recursive: true });
  const template = path.join(dir, 'turn.jsonl');
  fs.writeFileSync(
    template,
    [
      '# comment lines are skipped',
      '{"uuid":"{{TURN}}","sessionId":"{{SESSION_ID}}","cwd":"{{CWD}}","timestamp":"{{NOW}}","wt":"{{WORKTREE}}"}',
      '{"message":"{{MESSAGE}}","input":"{{INPUT}}","task":"{{TASK}}","exec":"{{EXEC_OUTPUT}}"}',
      '',
    ].join('\n'),
  );
  const cassette = path.join(dir, 'turn.cast');
  fs.writeFileSync(
    cassette,
    '@input\techo\\n\n@exec\tcommandmate ask wt\n@transcript\tturn.jsonl\n0\tdone\\n\n',
  );

  /**
   * Every character that is special to *something* on the way from stdin to
   * the JSON line: a backslash and a double quote (JSON), a tab (JSON, and a
   * field separator to `read`), `&` and `\&` (bash 5.2's `patsub_replacement`
   * treats an unquoted `&` in a `${var//pat/$rep}` replacement as the matched
   * text and a backslash as its quote — which is exactly how CI on ubuntu
   * collapsed `\\` to `\` and produced an unparseable line while macOS bash
   * 3.2 stayed green), and a second line (sed works per line; the joiner has
   * to be written as `\n`).
   */
  const TRICKY_FIRST_LINE = 'Fix "Header" \\ now & \\& tab\there';
  const TRICKY_MESSAGE = `${TRICKY_FIRST_LINE}\nline two`;

  it('appends the template with the row\'s values spliced in, JSON-escaped', () => {
    const target = path.join(STUB_ROOT, 'out', 'nested', `${CLAUDE_SID}.jsonl`);
    fs.rmSync(path.dirname(target), { recursive: true, force: true });
    const result = runWithStubs(
      [cassette, '--once', '--input-settle', '1', '--worktree', 'wt-dark-mode', '--transcript', target],
      `${TRICKY_MESSAGE}\n`,
    );
    expect(result.status).toBe(0);
    const lines = fs.readFileSync(target, 'utf8').trim().split('\n');
    // Two template rows, two lines: the message's own newline was written as
    // `\n`, not as a line break.
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0]);
    const second = JSON.parse(lines[1]);
    expect(first.uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    // The session id is read off the file name, so the two cannot disagree.
    expect(first.sessionId).toBe(CLAUDE_SID);
    expect(first.cwd).toBe(fs.realpathSync(STUB_ROOT));
    expect(first.wt).toBe('wt-dark-mode');
    expect(Date.parse(first.timestamp)).toBeGreaterThan(Date.now() - 60_000);
    // The whole submission, newline-joined — what the reader matches against
    // the `/send` row — byte for byte once the JSON is decoded.
    expect(second.message).toBe(TRICKY_MESSAGE);
    expect(second.input).toBe(TRICKY_FIRST_LINE);
    expect(second.task).toBe(TRICKY_FIRST_LINE);
    expect(second.exec).toContain('stub-commandmate\n[ask]\n[wt]');
    // And the raw bytes carry exactly the JSON escapes, so a reader that does
    // not tolerate a stray `\ ` sees none.
    expect(lines[1]).toContain('"message":"Fix \\"Header\\" \\\\ now & \\\\& tab\\there\\nline two"');
    // The same values reach the pane echo unescaped: `&` is not the matched
    // text and `\\` is not a quote.
    expect(result.stdout.startsWith(`echo\n`)).toBe(true);
  });

  it('echoes a message with & and backslashes verbatim into the pane', () => {
    // The composer echo goes through the same `${var//pat/$rep}` as the
    // transcript, and bash 5.2 mangled it the same way: `&` became `{{INPUT}}`.
    const file = tmpCassette('@input\techo:{{INPUT}}|{{TASK}}\\n\n');
    const result = runWithStubs([file, '--once'], `${TRICKY_FIRST_LINE}\n`);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(`echo:${TRICKY_FIRST_LINE}|${TRICKY_FIRST_LINE}\n`);
  });

  it('splices & and backslashes into an @exec argv element verbatim', () => {
    const file = tmpCassette('@input\tx\\n\n@exec\tcommandmate ask "{{TASK}}"\n');
    const result = runWithStubs([file, '--once'], `${TRICKY_FIRST_LINE}\n`);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`[${TRICKY_FIRST_LINE}]\n`);
  });

  it('turns patsub_replacement off, so a bash 5.2 replacement is literal', () => {
    // The guard the three cases above depend on; a future tidy-up that drops
    // it would only be caught on a bash 5.2 runner.
    const source = fs.readFileSync(SCRIPT, 'utf8');
    expect(source).toMatch(/^shopt -u patsub_replacement 2>\/dev\/null \|\| true$/m);
  });

  it('mints a fresh turn id per row', () => {
    const target = path.join(STUB_ROOT, `two-${CLAUDE_SID}.jsonl`);
    fs.rmSync(target, { force: true });
    const twice = path.join(dir, 'twice.cast');
    fs.writeFileSync(twice, '@transcript\tturn.jsonl\n@transcript\tturn.jsonl\n');
    expect(runWithStubs([twice, '--once', '--transcript', target]).status).toBe(0);
    const ids = fs.readFileSync(target, 'utf8').trim().split('\n')
      .map((line) => JSON.parse(line)).filter((row) => row.uuid).map((row) => row.uuid);
    expect(ids).toHaveLength(2);
    expect(ids[0]).not.toBe(ids[1]);
  });

  it('reads the codex session id off a rollout file name too', () => {
    const target = path.join(STUB_ROOT, `rollout-2026-09-07T10-00-00-${CODEX_SID}.jsonl`);
    fs.rmSync(target, { force: true });
    expect(runWithStubs([cassette, '--once', '--transcript', target], 'x\n').status).toBe(0);
    expect(JSON.parse(fs.readFileSync(target, 'utf8').split('\n')[0]).sessionId).toBe(CODEX_SID);
  });

  it('refuses a cassette with @transcript rows when --transcript is not given', () => {
    const result = runWithStubs([cassette, '--once'], 'x\n');
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('--transcript was not given');
    expect(result.stdout).toBe('');
  });

  it('refuses a missing template before the first row plays', () => {
    const missing = path.join(dir, 'missing.cast');
    fs.writeFileSync(missing, '0\tidle\\n\n@transcript\tnope.jsonl\n');
    const result = runWithStubs([missing, '--once', '--transcript', path.join(STUB_ROOT, `m-${CLAUDE_SID}.jsonl`)]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('@transcript template not found');
    expect(result.stdout).toBe('');
  });
});

describe('@hook rows (Issue #2380)', () => {
  it('refuses an event outside the lifecycle vocabulary before the first row plays', () => {
    const file = tmpCassette('0\tidle\\n\n@hook\tPreToolUse\n');
    const result = runWithStubs([file, '--once', '--port', '3399']);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('@hook must be one of');
    expect(result.stdout).toBe('');
  });

  it('is skipped, with a note, when there is no --port to post to', () => {
    const file = tmpCassette('@hook\tStop\n0\tdone\\n\n');
    const result = runWithStubs([file, '--once']);
    expect(result.status).toBe(0);
    expect(result.stderr).toContain('@hook Stop skipped (no --port)');
    expect(result.stdout).toBe('done\n');
  });

  it('traces and does not post under --dry-run', () => {
    const file = tmpCassette('@hook\tUserPromptSubmit\n');
    const result = runWithStubs([file, '--once', '--dry-run', '--port', '1']);
    expect(result.status).toBe(0);
    expect(result.stderr).toContain('kind=hook event=UserPromptSubmit');
  });

  /**
   * A receiver in its own process: `spawnSync` blocks this one, so an
   * in-process `http.createServer` could never answer the replay's curl.
   * Requests are written down as `URL BODY` lines.
   */
  const HOOK_LOG = path.join(STUB_ROOT, 'hooks.log');
  const HOOK_SERVER = path.join(STUB_ROOT, 'hook-server.js');
  fs.writeFileSync(
    HOOK_SERVER,
    `const fs = require('fs');
     const server = require('http').createServer((q, s) => {
       let body = '';
       q.on('data', (c) => { body += c; });
       q.on('end', () => {
         fs.appendFileSync(process.argv[3], q.url + ' ' + body + '\\n');
         s.writeHead(202, { 'content-type': 'application/json' }); s.end('{"accepted":true}');
       });
     });
     server.listen(Number(process.argv[2]), '127.0.0.1', () => process.stdout.write('listening\\n'));
     setInterval(() => {}, 1 << 30);\n`,
  );

  async function withHookServer<T>(work: (port: number) => T): Promise<T> {
    const { spawn } = await import('node:child_process');
    const net = await import('node:net');
    const port = await new Promise<number>((resolve) => {
      const probe = net.createServer();
      probe.listen(0, '127.0.0.1', () => {
        const { port: free } = probe.address() as { port: number };
        probe.close(() => resolve(free));
      });
    });
    fs.rmSync(HOOK_LOG, { force: true });
    const child = spawn(process.execPath, [HOOK_SERVER, String(port), HOOK_LOG], { stdio: ['ignore', 'pipe', 'inherit'] });
    await new Promise<void>((resolve) => child.stdout!.once('data', () => resolve()));
    try {
      return work(port);
    } finally {
      child.kill('SIGKILL');
    }
  }

  function hookRequests(): Array<{ url: string; body: Record<string, unknown> }> {
    if (!fs.existsSync(HOOK_LOG)) return [];
    return fs.readFileSync(HOOK_LOG, 'utf8').split('\n').filter(Boolean).map((line) => {
      const space = line.indexOf(' ');
      return { url: line.slice(0, space), body: JSON.parse(line.slice(space + 1)) };
    });
  }

  it("posts the agent's own payload shape to the demo server, fail-open", async () => {
    // What the fake pane sends has to be what /api/hooks/agent-event reads —
    // `hook_event_name` + `session_id` + `cwd` in the body, `worktreeId` /
    // `instanceId` as the injected URL would carry.
    const port = await withHookServer((p) => {
      const file = tmpCassette(
        '@input\techo\\n\n@hook\tUserPromptSubmit\n@hook\tStop\n@hook\tSessionStart\n0\tdone\\n\n',
      );
      const transcript = path.join(STUB_ROOT, `hook-${CLAUDE_SID}.jsonl`);
      const result = runWithStubs(
        [file, '--once', '--input-settle', '1', '--port', String(p), '--worktree', 'wt-dark-mode',
          '--transcript', transcript],
        'Review "it"\nline two\n',
      );
      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
      return p;
    });
    const received = hookRequests();
    expect(received.map((r) => r.url)).toEqual(Array(3).fill('/api/hooks/agent-event'));
    const cwd = fs.realpathSync(STUB_ROOT);
    expect(received[0].body).toEqual({
      tool: 'claude',
      hook_event_name: 'UserPromptSubmit',
      session_id: CLAUDE_SID,
      cwd,
      worktreeId: 'wt-dark-mode',
      instanceId: 'claude',
      prompt: 'Review "it"\nline two',
    });
    expect(received[1].body).toEqual({
      tool: 'claude',
      hook_event_name: 'Stop',
      session_id: CLAUDE_SID,
      cwd,
      worktreeId: 'wt-dark-mode',
      instanceId: 'claude',
      stop_hook_active: false,
    });
    expect(received[2].body).toMatchObject({ hook_event_name: 'SessionStart', source: 'startup' });

    // Fail-open: the server is gone, the replay is not.
    const file = tmpCassette('@hook\tStop\n0\tstill here\\n\n');
    const result = runWithStubs([file, '--once', '--port', String(port)]);
    expect(result.status).toBe(0);
    expect(result.stderr).toContain('@hook Stop was not accepted');
    expect(result.stdout).toBe('still here\n');
  });

  it('names the tool of the pane, not claude, when --tool says otherwise', async () => {
    await withHookServer((port) => {
      const file = tmpCassette('@hook\tStop\n');
      // --inner is what the launcher passes: the replay runs here, and --tool
      // names the pane's tool without asking for a session to be created.
      const result = runWithStubs([file, '--once', '--inner', '--tool', 'codex', '--worktree', 'wt', '--port', String(port)]);
      expect(result.status).toBe(0);
    });
    const [first] = hookRequests();
    expect(first.body).toMatchObject({ tool: 'codex', instanceId: 'codex', worktreeId: 'wt' });
    expect(first.body).not.toHaveProperty('session_id');
  });
});

describe('--idle-only (Issue #2380)', () => {
  it('plays the rows before the first @input, then swallows input and repaints', () => {
    const file = tmpCassette('0\tboot\\n\n@input\tnever:{{INPUT}}\\n\n0\tnever2\\n\n');
    const result = runWithStubs([file, '--idle-only', '--dry-run'], 'stray\nanother\n');
    expect(result.status).toBe(0);
    // One paint at start, one per swallowed line, and nothing past the @input.
    expect(result.stdout).toBe('boot\nboot\nboot\n');
    expect(result.stdout).not.toContain('never');
    expect(result.stderr.match(/kind=idle-hold/g)).toHaveLength(2);
  });

  it('plays every row of a cassette that has no @input at all', () => {
    const file = tmpCassette('0\ta\\n\n0\tb\\n\n');
    const result = runWithStubs([file, '--idle-only'], '');
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('a\nb\n');
  });
});

/**
 * The committed cassettes, through the real detectors — the same guarantee the
 * claude sample gets above, for the four new tools.
 */
describe('the committed tool cassettes drive the real status detectors (Issue #2380)', () => {
  function framesOf(result: ReturnType<typeof spawnSync>): string[] {
    return String(result.stdout).split(CLEAR).filter((frame) => frame.trim() !== '');
  }

  it.each(IDLE_CASSETTES)('%s idle cassette opens ready and holds it', (tool, cassette) => {
    const result = runWithStubs(
      [path.join(FIXTURES, cassette), '--idle-only', '--dry-run', '--tool', tool],
      'stray\n',
    );
    expect(result.status).toBe(0);
    const frames = framesOf(result);
    // Painted at boot and once more for the swallowed line: both frames ready.
    expect(frames).toHaveLength(2);
    for (const frame of frames) {
      const status = detectSessionStatus(frame, tool as never);
      expect(status.status).toBe('ready');
      expect(status.confidence).toBe('high');
    }
  });

  it('opencode idle cassette is a whole 200-row frame', () => {
    // The composer's row position is part of the capture: opencode is an
    // alternate-screen tool and the frame IS the 80x200 pane.
    const result = runWithStubs(
      [path.join(FIXTURES, 'opencode-idle.cast'), '--idle-only', '--dry-run', '--tool', 'opencode'],
      '',
    );
    expect(framesOf(result)[0].split('\n').length).toBeGreaterThanOrEqual(OPENCODE_PANE_HEIGHT - 2);
  });

  describe('codex-review.cast', () => {
    const rollout = path.join(STUB_ROOT, `rollout-2026-09-07T09-00-00-${CODEX_SID}.jsonl`);
    fs.rmSync(rollout, { force: true });
    // No --tool here: with --worktree that would name a pane to create, and
    // this is a replay. The tool only decides the session name and geometry.
    const result = runWithStubs(
      [CODEX_CASSETTE, '--once', '--dry-run', '--worktree', 'wt-dark-mode', '--transcript', rollout],
      'Review the dark mode toggle in the header. Reply in Markdown and link the file.\n',
    );
    const frames = framesOf(result);
    const statuses = frames.map((frame) => detectSessionStatus(frame, 'codex'));

    it('walks ready -> running -> ready under the codex detector', () => {
      expect(result.status).toBe(0);
      expect(statuses.map((s) => s.status)).toEqual([
        'ready', 'running', 'running', 'running', 'running', 'running', 'ready', 'ready',
      ]);
      expect(statuses.every((s) => s.confidence === 'high')).toBe(true);
      expect(statuses[0].reason).toBe('input_prompt');
      expect(statuses.at(-1)!.reason).toBe('input_prompt');
    });

    it('holds running for longer than the capture cache', () => {
      const delays = fs.readFileSync(CODEX_CASSETTE, 'utf8').split('\n')
        .filter((line) => line.trim() !== '' && !line.startsWith('#'))
        .map((line) => line.split('\t')[0])
        .filter((delay) => delay !== '@transcript' && delay !== '@hook');
      expect(delays).toHaveLength(statuses.length);
      let runningWindowMs = 0;
      statuses.forEach((status, index) => {
        const next = delays[index + 1];
        if (status.status === 'running' && next !== undefined && next !== '@input') {
          runningWindowMs += Number(next);
        }
      });
      expect(runningWindowMs).toBeGreaterThan(CACHE_TTL_MS * 1.5);
    });

    it('appends the transcript before the ready frame and Stop, so the reader finds a closed turn', () => {
      const kinds = fs.readFileSync(CODEX_CASSETTE, 'utf8').split('\n')
        .filter((line) => line.trim() !== '' && !line.startsWith('#'))
        .map((line) => line.split('\t')[0]);
      // @transcript, the reply frame, Stop, then the held reply frame.
      expect(kinds.slice(-4)).toEqual(['@transcript', '1500', '@hook', '8000']);
      expect(kinds[2]).toBe('@hook');
      const parsed = parseCodexRollout(fs.readFileSync(rollout, 'utf8'));
      expect(parsed.malformedLines).toBe(0);
      const built = buildCodexTurns(parsed.records, CODEX_SID);
      expect(built.turns).toHaveLength(1);
      const turn = built.turns[0];
      expect(turn.closed).toBe(true);
      expect(turn.sessionId).toBe(CODEX_SID);
      expect(turn.prompts.map((p) => p.text)).toEqual([
        'Review the dark mode toggle in the header. Reply in Markdown and link the file.',
      ]);
      const rendered = renderCodexTurn(turn);
      expect(rendered.body).toContain('[Header.tsx](src/components/layout/Header.tsx)');
      expect(rendered.unknownBlockTypes).toEqual([]);
      expect(codexTurnRequestId(turn.turnId)).toBe(`codex-turn:${turn.turnId}`);
    });

    it('loses the running frames when the Working line goes away', () => {
      const raw = fs.readFileSync(CODEX_CASSETTE, 'utf8');
      const mutated = tmpCassette(raw.replace(/Working/g, 'Waiting').replace(/esc to interrupt/g, ''));
      const alt = runWithStubs([mutated, '--once', '--dry-run', '--transcript', rollout], 'x\n');
      expect(framesOf(alt).map((f) => detectSessionStatus(f, 'codex').status)).not.toContain('running');
    });

    it('loses the ready frames when the composer glyph goes away', () => {
      const raw = fs.readFileSync(CODEX_CASSETTE, 'utf8');
      const mutated = tmpCassette(raw.replace(/›/g, '|'));
      const alt = runWithStubs([mutated, '--once', '--dry-run', '--transcript', rollout], 'x\n');
      expect(framesOf(alt).map((f) => detectSessionStatus(f, 'codex').status)).not.toContain('ready');
    });
  });

  describe('claude-delegate.cast', () => {
    const transcript = path.join(STUB_ROOT, 'claude', `${CLAUDE_SID}.jsonl`);
    fs.rmSync(transcript, { force: true });
    const result = runWithStubs(
      [CLAUDE_DELEGATE_CASSETTE, '--once', '--worktree', 'wt-dark-mode',
        '--port', '3399', '--speed', '1000', '--transcript', transcript],
      'Ask Codex to review the dark mode toggle\n',
    );
    const frames = framesOf(result);
    const statuses = frames.map((frame) => detectSessionStatus(frame, 'claude'));

    it('walks ready -> running -> ready under the claude detector, with the ask really run', () => {
      expect(result.status).toBe(0);
      // No `ready` between the idle frame and the running ones: the frame
      // painted when the message lands already carries the spinner, so a poll
      // cannot mistake the composer echo for a finished turn.
      expect(statuses.map((s) => s.status)).toEqual([
        'ready', 'running', 'running', 'running', 'running', 'ready', 'ready',
      ]);
      // The @exec ran between the delegating frames: its output is on the pane.
      expect(result.stdout).toContain('[ask]\n[wt-dark-mode]\n[--instance]\n[codex]\n');
      expect(result.stdout).toContain('CM_PORT=3399');
    });

    it('records the turn the reader will write as Markdown, keyed claude-turn:', () => {
      const parsed = parseClaudeTranscript(fs.readFileSync(transcript, 'utf8'));
      expect(parsed.malformedLines).toBe(0);
      expect(parsed.records.filter(isClaudeOperatorPromptRecord)).toHaveLength(1);
      const built = buildClaudeTurns(parsed.records, CLAUDE_SID);
      expect(built.turns).toHaveLength(1);
      expect(built.orphanedAssistantRecords).toBe(0);
      const turn = built.turns[0];
      expect(isClaudeTurnWritable(turn)).toBe(true);
      expect(turn.sessionId).toBe(CLAUDE_SID);
      const rendered = renderClaudeTurn(turn);
      expect(rendered.body).toContain('[Header.tsx](src/components/layout/Header.tsx)');
      expect(rendered.body).toContain('commandmate ask wt-dark-mode --instance codex');
      expect(claudeTurnRequestId(turn.promptUuid)).toBe(`claude-turn:${turn.promptUuid}`);
      // The prompt row carries the message as sent, byte for byte.
      const prompt = parsed.records.find(isClaudeOperatorPromptRecord)!;
      expect(prompt.text).toBe('Ask Codex to review the dark mode toggle');
      // The tool_result carries what the command really printed.
      expect(fs.readFileSync(transcript, 'utf8')).toContain('stub-commandmate\\n[ask]');
    });
  });

  it('carries no personal path in any fixture', () => {
    for (const name of fs.readdirSync(FIXTURES)) {
      const full = path.join(FIXTURES, name);
      const files = fs.statSync(full).isDirectory()
        ? fs.readdirSync(full).map((f) => path.join(full, f))
        : [full];
      for (const file of files) {
        const text = fs.readFileSync(file, 'utf8');
        expect(text, file).not.toMatch(/\/Users\/(?!Shared\b)[a-z]/);
        expect(text, file).not.toMatch(/claude-501|MyCodeBranchDesk|agyprobe|cc2304/);
      }
    }
  });
});
