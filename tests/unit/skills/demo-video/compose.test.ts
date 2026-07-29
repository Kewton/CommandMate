/**
 * compose.sh — cut, overlay and the 30 second duration gate (Issue #1554).
 *
 * Two layers, deliberately:
 *
 *   1. The gate's decision boundary is exercised with `--compare`, which needs
 *      nothing but awk. That runs everywhere, including a CI image with no
 *      ffmpeg, so the arithmetic can never be "covered" only by a skip.
 *   2. The real pipeline — dummy webm + PNGs through concat, overlay and
 *      ffprobe — runs where ffmpeg exists. Skipping is announced by a test that
 *      asserts *why* it skipped, so a silent disappearance is visible.
 *
 * Everything is judged by exit code. `cmd | grep` would report grep's status
 * and turn a failed compose into a pass.
 *
 * @vitest-environment node
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const COMPOSE = path.join(REPO_ROOT, '.claude/skills/demo-video/scripts/compose.sh');

function has(tool: string): boolean {
  return spawnSync('command', ['-v', tool], { shell: true, stdio: 'ignore' }).status === 0;
}
const HAS_FFMPEG = has('ffmpeg') && has('ffprobe');

const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'demo-video-compose-'));
afterAll(() => {
  fs.rmSync(SCRATCH, { recursive: true, force: true });
});

/** Absolute, so a test that strips PATH can still start the shell. */
const BASH = spawnSync('command', ['-v', 'bash'], { shell: true, encoding: 'utf8' }).stdout.trim() || '/bin/bash';

function compose(args: string[], pathOverride?: string) {
  return spawnSync(BASH, [COMPOSE, ...args], {
    encoding: 'utf8',
    timeout: 300_000,
    ...(pathOverride === undefined
      ? {}
      : { env: { ...process.env, PATH: pathOverride } }),
  });
}

/**
 * A PATH holding everything compose.sh legitimately needs *except* ffmpeg and
 * ffprobe — the CI runner's situation, reproduced on a developer machine where
 * `brew install ffmpeg` has already happened.
 *
 * Symlinking an allowlist rather than filtering the real PATH: ffmpeg lives in
 * /opt/homebrew/bin here and could live in /usr/bin elsewhere, and dropping the
 * directory that holds awk too would make every case below fail for the wrong
 * reason.
 */
function pathWithoutFfmpeg(): string {
  const dir = fs.mkdtempSync(path.join(SCRATCH, 'no-ffmpeg-bin-'));
  for (const tool of ['awk', 'cat', 'tail', 'dirname', 'basename', 'rm', 'mkdir']) {
    const found = spawnSync('command', ['-v', tool], { shell: true, encoding: 'utf8' }).stdout.trim();
    if (found) fs.symlinkSync(found, path.join(dir, tool));
  }
  return dir;
}

function ffmpeg(args: string[]): void {
  const result = spawnSync('ffmpeg', ['-hide_banner', '-nostdin', '-y', ...args], {
    encoding: 'utf8',
    timeout: 300_000,
  });
  if (result.status !== 0) throw new Error(`ffmpeg failed: ${result.stderr?.slice(-800)}`);
}

function probe(file: string): number {
  const result = spawnSync(
    'ffprobe',
    ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file],
    { encoding: 'utf8' },
  );
  return Number(result.stdout.trim());
}

describe('argument handling', () => {
  it('rejects an unknown argument', () => {
    const result = compose(['--frobnicate']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('unknown argument');
  });

  it('refuses to write anything but an mp4', () => {
    const plan = path.join(SCRATCH, 'stem.tsv');
    fs.writeFileSync(plan, '#total\t3.000\n');
    const result = compose(['--plan', plan, '--scenes', SCRATCH, '--overlays', SCRATCH, '--out', path.join(SCRATCH, 'x.mov')]);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/must end in \.mp4/);
  });

  it('refuses a plan that storyboard.ts did not produce', () => {
    // Without the #total row there is nothing to gate the duration against, and
    // a silent pass here is exactly the failure the gate exists to prevent.
    const plan = path.join(SCRATCH, 'no-total.tsv');
    fs.writeFileSync(plan, 'title\tcard\tpc\t0.000\t3.000\tHello\n');
    const result = compose(['--plan', plan, '--scenes', SCRATCH, '--overlays', SCRATCH, '--out', path.join(SCRATCH, 'x.mp4')]);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/no '#total' row/);
  });

  it('requires --expect alongside --compare', () => {
    const result = compose(['--compare', '30.2']);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/--compare also needs --expect/);
  });
});

/**
 * The regression from PR #1562: compose.sh checked for ffmpeg *before* it looked
 * at its arguments, so every argument error came back as "required command not
 * found" on a machine without ffmpeg. It passed on every developer machine and
 * failed only in CI — the same shape as #1553's ANSI mismatch.
 *
 * These cases are the ones above, re-run with ffmpeg taken off PATH. Argument
 * validation needs no external binary, so it must produce the same message
 * either way.
 */
describe('argument handling with no ffmpeg on PATH', () => {
  const NO_FFMPEG = pathWithoutFfmpeg();

  it('really has removed ffmpeg, and really has kept awk', () => {
    // Without this, a typo that emptied PATH would make every case below "pass"
    // by failing for an entirely different reason.
    const probe = (tool: string) =>
      spawnSync(BASH, ['-c', `command -v ${tool}`], {
        encoding: 'utf8',
        env: { ...process.env, PATH: NO_FFMPEG },
      }).status;
    expect(probe('ffmpeg')).not.toBe(0);
    expect(probe('ffprobe')).not.toBe(0);
    expect(probe('awk')).toBe(0);
  });

  it('refuses to write anything but an mp4', () => {
    const plan = path.join(SCRATCH, 'stem-noffmpeg.tsv');
    fs.writeFileSync(plan, '#total\t3.000\n');
    const result = compose(
      ['--plan', plan, '--scenes', SCRATCH, '--overlays', SCRATCH, '--out', path.join(SCRATCH, 'x.mov')],
      NO_FFMPEG,
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/must end in \.mp4/);
  });

  it('refuses a plan that storyboard.ts did not produce', () => {
    const plan = path.join(SCRATCH, 'no-total-noffmpeg.tsv');
    fs.writeFileSync(plan, 'title\tcard\tpc\t0.000\t3.000\tHello\n');
    const result = compose(
      ['--plan', plan, '--scenes', SCRATCH, '--overlays', SCRATCH, '--out', path.join(SCRATCH, 'x.mp4')],
      NO_FFMPEG,
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/no '#total' row/);
  });

  it('reports a missing plan file as a missing plan file', () => {
    const result = compose(
      ['--plan', path.join(SCRATCH, 'absent.tsv'), '--scenes', SCRATCH, '--overlays', SCRATCH,
        '--out', path.join(SCRATCH, 'x.mp4')],
      NO_FFMPEG,
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/no such plan/);
  });

  it('rejects an unknown argument', () => {
    const result = compose(['--frobnicate'], NO_FFMPEG);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('unknown argument');
  });

  it('still runs the --compare gate, which needs only awk', () => {
    expect(compose(['--compare', '30.2', '--expect', '30'], NO_FFMPEG).status).toBe(0);
    expect(compose(['--compare', '30.6', '--expect', '30'], NO_FFMPEG).status).toBe(1);
  });

  it('reports the missing file before the missing ffprobe under --verify', () => {
    const result = compose(
      ['--verify', path.join(SCRATCH, 'absent.mp4'), '--expect', '30'],
      NO_FFMPEG,
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/no such file/);
  });

  // The other direction. Moving the dependency check must not delete it: once
  // the arguments are right, the run cannot proceed without ffmpeg and has to
  // say so rather than failing somewhere inside a filter graph.
  it('still stops on the missing dependency when the arguments are valid', () => {
    const plan = path.join(SCRATCH, 'valid-noffmpeg.tsv');
    fs.writeFileSync(
      plan,
      ['#id\ttype\tviewport\tstart\tduration\ttelop', '#total\t3.000', 'intro\tcard\tpc\t0.000\t3.000\tはじめに', ''].join('\n'),
    );
    const result = compose(
      ['--plan', plan, '--scenes', SCRATCH, '--overlays', SCRATCH, '--out', path.join(SCRATCH, 'valid.mp4')],
      NO_FFMPEG,
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/required command not found: ffmpeg/);
  });

  it('still stops on the missing dependency when --verify names a real file', () => {
    const real = path.join(SCRATCH, 'real-but-unreadable.mp4');
    fs.writeFileSync(real, 'not really an mp4, but it exists');
    const result = compose(['--verify', real, '--expect', '30'], NO_FFMPEG);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/required command not found: ffprobe/);
  });
});

describe('duration gate boundary', () => {
  const gate = (actual: string, tolerance = '0.5') =>
    compose(['--compare', actual, '--expect', '30', '--tolerance', tolerance]).status;

  it('passes at 30.2s and fails at 30.6s, the two cases the Issue names', () => {
    expect(gate('30.2')).toBe(0);
    expect(gate('30.6')).toBe(1);
  });

  it('is symmetric about the target', () => {
    expect(gate('29.8')).toBe(0);
    expect(gate('29.4')).toBe(1);
  });

  it('treats the tolerance as inclusive and does not drift with float noise', () => {
    // 30 - 29.5 is 0.5000000000000036 in binary floating point; a bare `<=`
    // would reject a take that is exactly on the limit.
    expect(gate('30.5')).toBe(0);
    expect(gate('29.5')).toBe(0);
    expect(gate('30.501')).toBe(1);
  });

  it('honours a custom tolerance in both directions', () => {
    expect(gate('30.6', '1.0')).toBe(0);
    expect(gate('30.2', '0.1')).toBe(1);
  });

  it('reports the measured and expected duration when it fails', () => {
    const result = compose(['--compare', '30.6', '--expect', '30', '--tolerance', '0.5']);
    expect(result.stderr).toContain('duration gate FAILED: 30.6s, expected 30s +/- 0.5s');
  });
});

describe('ffmpeg availability', () => {
  it('is reported, so a skipped pipeline suite is never mistaken for a passing one', () => {
    // Deliberately not an assertion that ffmpeg exists: on a CI image without
    // it, this test still runs and the console line below says which half of
    // this file executed.
    expect(typeof HAS_FFMPEG).toBe('boolean');
    if (!HAS_FFMPEG) {
      process.stdout.write('compose.test.ts: ffmpeg/ffprobe absent — pipeline cases skipped\n');
    }
  });
});

describe.skipIf(!HAS_FFMPEG)('the real pipeline', () => {
  const DIR = path.join(SCRATCH, 'pipeline');
  const SCENES = path.join(DIR, 'scenes');
  const OVERLAYS = path.join(DIR, 'overlays');
  const FRAME = '320x200';

  /** A plan in storyboard.ts's own format: one card, one recorded scene. */
  function writePlan(file: string, total: string, cardSec: string, recordSec: string): string {
    fs.writeFileSync(
      file,
      [
        '#id\ttype\tviewport\tstart\tduration\ttelop',
        `#total\t${total}`,
        '#output\tfixture.ja',
        `intro\tcard\tpc\t0.000\t${cardSec}\tはじめに`,
        `body\trecord\tpc\t${cardSec}\t${recordSec}\t本編`,
        '',
      ].join('\n'),
    );
    return file;
  }

  beforeAll(() => {
    fs.mkdirSync(SCENES, { recursive: true });
    fs.mkdirSync(OVERLAYS, { recursive: true });

    // Dummy footage deliberately *shorter* than its slot, so the tpad/trim
    // normalisation is what makes the segment come out at the declared length.
    ffmpeg([
      '-f', 'lavfi', '-i', `testsrc=size=${FRAME}:rate=15:duration=1.4`,
      '-c:v', 'libvpx', '-b:v', '200k', '-an', path.join(SCENES, 'body.webm'),
    ]);
    // A transparent telop strip and an opaque card, matching what
    // render-overlays.ts writes.
    ffmpeg([
      '-f', 'lavfi', '-i', `color=c=black@0.0:s=${FRAME}:d=1`,
      '-frames:v', '1', '-vf', 'format=rgba,drawbox=x=20:y=150:w=280:h=30:color=white@0.9:t=fill',
      path.join(OVERLAYS, 'telop-body.ja.png'),
    ]);
    ffmpeg([
      '-f', 'lavfi', '-i', `color=c=navy:s=${FRAME}:d=1`,
      '-frames:v', '1', path.join(OVERLAYS, 'card-intro.ja.png'),
    ]);
  }, 300_000);

  it('concatenates the card and the overlaid footage to the declared length', () => {
    const out = path.join(DIR, 'ok.mp4');
    const result = compose([
      '--plan', writePlan(path.join(DIR, 'ok.tsv'), '3.000', '1.000', '2.000'),
      '--scenes', SCENES, '--overlays', OVERLAYS, '--locale', 'ja',
      '--frame', FRAME, '--fps', '15', '--tolerance', '0.5', '--out', out,
    ]);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(fs.existsSync(out)).toBe(true);
    expect(probe(out)).toBeGreaterThan(2.5);
    expect(probe(out)).toBeLessThan(3.5);
  }, 300_000);

  it('keeps the end of an over-long take, not the start', () => {
    // The payoff of every scene is at its end. This take counts frames from a
    // testsrc pattern, so the last frame of the segment must match the last
    // frame of the source rather than a frame from its first two seconds.
    const long = path.join(DIR, 'long.webm');
    ffmpeg([
      '-f', 'lavfi', '-i', `testsrc=size=${FRAME}:rate=15:duration=6`,
      '-c:v', 'libvpx', '-b:v', '200k', '-an', long,
    ]);
    const scenes = path.join(DIR, 'scenes-long');
    fs.mkdirSync(scenes, { recursive: true });
    fs.copyFileSync(long, path.join(scenes, 'body.webm'));

    const work = path.join(DIR, 'work-tail');
    const result = compose([
      '--plan', writePlan(path.join(DIR, 'tail.tsv'), '3.000', '1.000', '2.000'),
      '--scenes', scenes, '--overlays', OVERLAYS, '--locale', 'ja',
      '--frame', FRAME, '--fps', '15', '--tolerance', '0.5', '--keep-work',
      '--work', work, '--out', path.join(DIR, 'tail.mp4'),
    ]);
    expect(result.status).toBe(0);
    // Reported so a regression is legible in the log, not just in the pixels.
    expect(result.stdout).toMatch(/take 6\.\d+s, from \+4\.\d+s/);

    const segment = path.join(work, '02-body.mp4');
    expect(probe(segment)).toBeGreaterThan(1.9);
    expect(probe(segment)).toBeLessThan(2.2);
  }, 300_000);

  it('holds the last frame when the take is shorter than its slot', () => {
    // The footage is 1.4s and the slot is 2s. Without tpad the segment would be
    // short and every later telop would drift early.
    const out = path.join(DIR, 'padded.mp4');
    const result = compose([
      '--plan', writePlan(path.join(DIR, 'padded.tsv'), '3.000', '1.000', '2.000'),
      '--scenes', SCENES, '--overlays', OVERLAYS, '--locale', 'ja',
      '--frame', FRAME, '--fps', '15', '--tolerance', '0.05', '--keep-work',
      '--work', path.join(DIR, 'work-padded'), '--out', out,
    ]);
    expect(result.status).toBe(0);
    expect(probe(path.join(DIR, 'work-padded', '02-body.mp4'))).toBeGreaterThan(1.9);
  }, 300_000);

  it('fails with a non-zero exit code when the cut misses the declared total', () => {
    // The plan claims 30s while the scenes add up to 3s. A gate that only
    // printed a warning would let this reach a release asset.
    const out = path.join(DIR, 'over.mp4');
    const result = compose([
      '--plan', writePlan(path.join(DIR, 'over.tsv'), '30.000', '1.000', '2.000'),
      '--scenes', SCENES, '--overlays', OVERLAYS, '--locale', 'ja',
      '--frame', FRAME, '--fps', '15', '--tolerance', '0.5', '--out', out,
    ]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('duration gate FAILED');
  }, 300_000);

  it('names the per-scene contribution when the gate fails', () => {
    const result = compose([
      '--plan', writePlan(path.join(DIR, 'over2.tsv'), '30.000', '1.000', '2.000'),
      '--scenes', SCENES, '--overlays', OVERLAYS, '--locale', 'ja',
      '--frame', FRAME, '--fps', '15', '--tolerance', '0.5', '--out', path.join(DIR, 'over2.mp4'),
    ]);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/intro\s+declared\s+1\.000s\s+actual\s+\d\.\d+s/);
    expect(result.stderr).toMatch(/body\s+declared\s+2\.000s\s+actual\s+\d\.\d+s/);
  }, 300_000);

  it('measures a real file through --verify, passing at 30.2s and failing at 30.6s', () => {
    // The same boundary as the --compare cases above, but with the number
    // coming from ffprobe rather than from the test, which is what proves the
    // measurement and the gate are actually wired together.
    const short = path.join(DIR, 'len-30.2.mp4');
    const long = path.join(DIR, 'len-30.6.mp4');
    ffmpeg(['-f', 'lavfi', '-i', 'color=c=black:s=160x120:r=10:d=30.2', '-c:v', 'libx264', '-preset', 'ultrafast', short]);
    ffmpeg(['-f', 'lavfi', '-i', 'color=c=black:s=160x120:r=10:d=30.6', '-c:v', 'libx264', '-preset', 'ultrafast', long]);

    expect(compose(['--verify', short, '--expect', '30', '--tolerance', '0.5']).status).toBe(0);
    expect(compose(['--verify', long, '--expect', '30', '--tolerance', '0.5']).status).toBe(1);
  }, 300_000);

  it('stops with a usable message when a scene was never recorded', () => {
    const result = compose([
      '--plan', writePlan(path.join(DIR, 'missing.tsv'), '3.000', '1.000', '2.000'),
      '--scenes', path.join(DIR, 'empty'), '--overlays', OVERLAYS, '--locale', 'ja',
      '--frame', FRAME, '--fps', '15', '--out', path.join(DIR, 'missing.mp4'),
    ]);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/missing footage: .*body\.webm \(run record-scenes\.ts --scene body\)/);
  }, 300_000);

  it('stops when the telop PNG for the requested locale is absent', () => {
    // Composing without it would silently produce a video with no subtitles at
    // all, which looks like a success.
    const result = compose([
      '--plan', writePlan(path.join(DIR, 'nolocale.tsv'), '3.000', '1.000', '2.000'),
      '--scenes', SCENES, '--overlays', OVERLAYS, '--locale', 'en',
      '--frame', FRAME, '--fps', '15', '--out', path.join(DIR, 'nolocale.mp4'),
    ]);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/missing card image: .*card-intro\.en\.png/);
  }, 300_000);
});
