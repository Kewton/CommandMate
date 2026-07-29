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

function run(args: string[], input = '') {
  return spawnSync('bash', [SCRIPT, ...args], { input, encoding: 'utf8' });
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
  function trace(args: string[], input = 'hello\n'): string[] {
    const result = run([CASSETTE, '--once', '--dry-run', ...args], input);
    expect(result.status).toBe(0);
    return result.stderr.trim().split('\n');
  }

  it('replays rows in cassette order and blocks for input at the composer', () => {
    const lines = trace([]);
    expect(lines[0]).toMatch(/^trace step=1 kind=sleep ms=0$/);
    expect(lines[1]).toBe('trace step=2 kind=input');
    expect(lines.filter((l) => l.includes('kind=input'))).toHaveLength(1);
  });

  it('divides every delay by --speed', () => {
    const baseline = trace([]).filter((l) => l.includes('kind=sleep'));
    const doubled = trace(['--speed', '2']).filter((l) => l.includes('kind=sleep'));
    expect(doubled).toHaveLength(baseline.length);

    const ms = (line: string) => Number(/ms=(\d+)$/.exec(line)![1]);
    expect(baseline.map(ms)).toEqual([0, 600, 2200, 2200, 2200, 2200, 6000]);
    expect(doubled.map(ms)).toEqual([0, 300, 1100, 1100, 1100, 1100, 3000]);
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
  const result = run([CASSETTE, '--once', '--dry-run'], 'Add a dark mode toggle to the header\n');
  const frames = result.stdout.split(CLEAR).filter((frame) => frame.trim() !== '');
  const statuses = frames.map((frame) => detectSessionStatus(frame, 'claude'));

  it('emits every frame', () => {
    expect(result.status).toBe(0);
    expect(frames).toHaveLength(8);
  });

  it('opens ready, so the session survives isSessionHealthy and is not killed', () => {
    // An empty or prompt-less pane is treated as a dead CLI and the session is
    // killed (src/lib/session/claude-session.ts ensureHealthySession).
    expect(statuses[0].status).toBe('ready');
    expect(statuses[0].reason).toBe('input_prompt');
  });

  it('reports running for the whole generation stretch', () => {
    const generating = statuses.slice(2, 6);
    expect(generating.map((s) => s.status)).toEqual(['running', 'running', 'running', 'running']);
    expect(generating.every((s) => s.confidence === 'high')).toBe(true);
  });

  it('returns to ready once the reply lands', () => {
    expect(statuses.at(-1)!.status).toBe('ready');
    expect(statuses.at(-1)!.reason).toBe('input_prompt');
  });

  it('never reports waiting, which would park the demo on an approval prompt', () => {
    expect(statuses.map((s) => s.status)).not.toContain('waiting');
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

describe('mutating the cassette breaks the run/ready contract', () => {
  // Without this, every assertion above is also satisfied by a detector that
  // simply never returns `running`.
  it('loses the running frames when "esc to interrupt" and the spinner go away', () => {
    const raw = fs.readFileSync(CASSETTE, 'utf8');
    const broken = raw
      .replace(/esc to interrupt/g, '? for shortcuts')
      .replace(/\\u2026|…/g, '');
    const file = tmpCassette(broken);
    const result = run([file, '--once', '--dry-run'], 'hi\n');
    const statuses = result.stdout
      .split(CLEAR)
      .filter((frame) => frame.trim() !== '')
      .map((frame) => detectSessionStatus(frame, 'claude').status);
    expect(statuses).not.toContain('running');
  });

  it('loses the ready frames when the prompt marker goes away', () => {
    const raw = fs.readFileSync(CASSETTE, 'utf8');
    const file = tmpCassette(raw.replace(/❯/g, '|'));
    const result = run([file, '--once', '--dry-run'], 'hi\n');
    const statuses = result.stdout
      .split(CLEAR)
      .filter((frame) => frame.trim() !== '')
      .map((frame) => detectSessionStatus(frame, 'claude').status);
    expect(statuses).not.toContain('ready');
  });
});
