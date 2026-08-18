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
