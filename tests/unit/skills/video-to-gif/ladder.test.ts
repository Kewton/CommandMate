/**
 * The retry ladder and the argument gate, exercised for real.
 *
 * Both run before `to-gif.sh` looks for ffmpeg, which is the point: CI runners
 * have no ffmpeg, so a test that needed one would skip and this arithmetic
 * would never be checked anywhere. The same split exists in compose.sh
 * (`--compare` vs `--verify`) for the same reason.
 *
 * @vitest-environment node
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const SCRIPT = path.join(REPO_ROOT, '.claude/skills/video-to-gif/scripts/to-gif.sh');

type Run = { status: number; stdout: string; stderr: string };

function run(...args: string[]): Run {
  const r = spawnSync('bash', [SCRIPT, ...args], { encoding: 'utf8' });
  return { status: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

type Rung = { width: number; fps: number; colors: number };

function ladder(...args: string[]): Rung[] {
  const r = run('--ladder', ...args);
  expect(r.status, `--ladder ${args.join(' ')} failed: ${r.stderr}`).toBe(0);
  return r.stdout
    .split('\n')
    .map((line) => /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*$/.exec(line))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => ({ width: Number(m[2]), fps: Number(m[3]), colors: Number(m[4]) }));
}

describe('to-gif.sh --ladder', () => {
  it('walks the documented default ladder', () => {
    // Spelled out rather than recomputed, so a change to the descent has to be
    // an intentional edit to this list and to SKILL.md's example.
    expect(ladder()).toEqual([
      { width: 600, fps: 10, colors: 256 },
      { width: 600, fps: 8, colors: 256 },
      { width: 480, fps: 8, colors: 256 },
      { width: 480, fps: 8, colors: 128 },
      { width: 480, fps: 6, colors: 128 },
      { width: 384, fps: 6, colors: 128 },
      { width: 384, fps: 6, colors: 64 },
      { width: 360, fps: 6, colors: 64 },
      { width: 360, fps: 6, colors: 32 },
    ]);
  });

  it('starts at the requested settings', () => {
    const rungs = ladder('--width', '900', '--fps', '15', '--colors', '128');
    expect(rungs[0]).toEqual({ width: 900, fps: 15, colors: 128 });
  });

  it('never steps back up, and every rung is a real reduction', () => {
    const rungs = ladder('--width', '900', '--fps', '15', '--max-bytes', '100k');
    expect(rungs.length).toBeGreaterThan(5);
    for (let i = 1; i < rungs.length; i++) {
      const prev = rungs[i - 1];
      const cur = rungs[i];
      expect(cur.width, `rung ${i + 1} width grew`).toBeLessThanOrEqual(prev.width);
      expect(cur.fps, `rung ${i + 1} fps grew`).toBeLessThanOrEqual(prev.fps);
      expect(cur.colors, `rung ${i + 1} colors grew`).toBeLessThanOrEqual(prev.colors);
      // A repeated rung would re-encode the identical GIF and compare it against
      // the same budget again — a wasted ffmpeg pass that can never change the
      // outcome.
      expect(cur, `rung ${i + 1} repeats rung ${i}`).not.toEqual(prev);
    }
  });

  it('respects every floor', () => {
    const rungs = ladder('--max-bytes', '1', '--min-width', '400', '--min-fps', '8', '--min-colors', '64');
    for (const rung of rungs) {
      expect(rung.width).toBeGreaterThanOrEqual(400);
      expect(rung.fps).toBeGreaterThanOrEqual(8);
      expect(rung.colors).toBeGreaterThanOrEqual(64);
    }
    // ...and actually reaches them, otherwise "respects the floor" would also
    // be satisfied by a ladder that gave up early.
    const last = rungs[rungs.length - 1];
    expect(last).toEqual({ width: 400, fps: 8, colors: 64 });
  });

  it('collapses to a single attempt when the floors are the start values', () => {
    // Non-vacuity for the two tests above: the ladder must genuinely be driven
    // by the floors, not by a hard-coded length.
    expect(
      ladder('--width', '600', '--min-width', '600', '--fps', '10', '--min-fps', '10',
        '--colors', '256', '--min-colors', '256'),
    ).toEqual([{ width: 600, fps: 10, colors: 256 }]);
  });

  it('has no ladder under --no-fit or without a budget', () => {
    expect(ladder('--no-fit')).toHaveLength(1);
    expect(ladder('--max-bytes', 'none')).toHaveLength(1);
    expect(run('--ladder', '--max-bytes', 'none').stdout).toMatch(/no budget/);
    expect(run('--ladder', '--no-fit').stdout).toMatch(/--no-fit/);
  });

  it('terminates on extreme settings', () => {
    // The descent is a while(true); an axis that never reports "no change"
    // would hang here rather than fail somewhere subtle later.
    const rungs = ladder('--width', '4000', '--fps', '30', '--colors', '256',
      '--min-width', '16', '--min-fps', '1', '--min-colors', '2', '--max-bytes', '1');
    expect(rungs.length).toBeGreaterThan(20);
    expect(rungs.length).toBeLessThan(200);
    expect(rungs[rungs.length - 1]).toEqual({ width: 16, fps: 1, colors: 2 });
  });

  it('reads byte budgets in every documented spelling', () => {
    // 1.5M is 1.50MB; 1500k is 1500 KiB = 1.46MB; the plain integer is decimal.
    expect(run('--ladder', '--max-bytes', '1.5M').stdout).toMatch(/budget 1\.50MB/);
    expect(run('--ladder', '--max-bytes', '1500k').stdout).toMatch(/budget 1\.46MB/);
    expect(run('--ladder', '--max-bytes', '1572864').stdout).toMatch(/budget 1\.50MB/);
    expect(run('--ladder', '--max-bytes', '900KB').stdout).toMatch(/budget 900KB/);
  });
});

describe('to-gif.sh argument gate', () => {
  // Every case here must be rejected before ffmpeg is looked for. The reverse
  // order made every typo report itself as "required command not found:
  // ffmpeg" on machines without it — passing locally, failing only in CI
  // (compose.sh, PR #1562).
  const cases: Array<[string[], RegExp]> = [
    [['x.mp4', '--width', 'abc'], /--width must be a whole number/],
    [['x.mp4', '--fps', '0'], /--fps must be at least 1/],
    [['x.mp4', '--colors', '999'], /--colors must be 2\.\.256/],
    [['x.mp4', '--colors', '1'], /--colors must be 2\.\.256/],
    [['x.mp4', '--max-bytes', '1.5X'], /--max-bytes must look like/],
    [['x.mp4', '--stats-mode', 'wat'], /--stats-mode must be full, diff or single/],
    [['x.mp4', '--width', '100', '--min-width', '400'], /--width \(100\) is below --min-width \(400\)/],
    [['x.mp4', '--fps', '6', '--min-fps', '10'], /--fps \(6\) is below --min-fps \(10\)/],
    [['x.mp4', '--bogus'], /unknown argument: --bogus/],
    [['x.mp4', '--width'], /--width needs a value/],
    [[], /no input files/],
  ];

  it.each(cases)('rejects %j', (args, message) => {
    const r = run(...args);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(message);
    // Not a message about a missing binary, which is the failure this ordering
    // exists to avoid.
    expect(r.stderr).not.toMatch(/required command not found: ffmpeg/);
  });

  it('accepts the settings it is asked to reject the negation of', () => {
    // Proves the gate is a gate and not a blanket reject.
    expect(run('--ladder', '--width', '400', '--min-width', '400').status).toBe(0);
    expect(run('--ladder', '--colors', '256').status).toBe(0);
    expect(run('--ladder', '--colors', '2', '--min-colors', '2').status).toBe(0);
    expect(run('--ladder', '--stats-mode', 'diff').status).toBe(0);
  });

  it('prints usage on --help and exits 0', () => {
    const r = run('--help');
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/Usage: to-gif\.sh/);
  });

  it('reports every dependency by name under --check', () => {
    const r = run('--check');
    for (const tool of ['ffmpeg', 'ffprobe', 'awk']) {
      expect(`${r.stdout}${r.stderr}`).toMatch(new RegExp(`(ok|MISSING)\\s+${tool}`));
    }
    // Exit status has to follow what is actually installed — CI has no ffmpeg,
    // developer machines do, and both are correct.
    const missing = /MISSING/.test(`${r.stdout}${r.stderr}`);
    expect(r.status).toBe(missing ? 1 : 0);
  });
});
