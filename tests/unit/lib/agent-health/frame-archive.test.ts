/**
 * A failing `screen-*` check keeps its whole frame (Issue #3183).
 *
 * The report's `evidence` is `paneEvidence` — ANSI stripped, blank rows
 * compacted, the tail only, truncated — so a fixture used to need a second
 * live capture. These tests pin that the frame is now written as captured,
 * byte for byte, beside the report, and only when the archive keeps it.
 *
 * Every write goes to a `mkdtemp` directory under `os.tmpdir()`.
 *
 * @vitest-environment node
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  SAVE_FRAMES_ENV_VAR,
  archiveCheckFrames,
  frameFileBase,
  framesDirFor,
  resolveFrameSaveMode,
  type FrameArchive,
} from '@/lib/agent-health/frame-archive';
import { evaluatePickerScreens, evaluateScreen } from '@/lib/agent-health/screen-checks';
import { MAX_EVIDENCE_CHARS } from '@/lib/agent-health/types';
import { detectSessionStatus } from '@/lib/detection/status-detector';

const ROOT = path.resolve(__dirname, '../../../..');
/** A real 1000-row capture, ANSI intact — far longer than any evidence. */
const RAW = fs.readFileSync(path.join(ROOT, 'tests/fixtures/codex-dialogs-0157/approval.txt'), 'utf8');

let tmp: string;
let archive: FrameArchive;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-3183-frames-'));
  archive = { dir: path.join(tmp, 'frames', '2026-10-04'), mode: 'fail' };
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** The approval frame judged as `screen-idle`: a real failing verdict. */
function failingIdleCheck() {
  const status = detectSessionStatus(RAW, 'codex');
  const verdict = {
    status: status.status,
    reason: status.reason,
    hasActivePrompt: status.hasActivePrompt,
    evidence: status.evidence,
  };
  return { checkId: 'screen-idle' as const, ...evaluateScreen('screen-idle', verdict, RAW) };
}

describe('[#3183] a failing screen check keeps the whole frame', () => {
  it('the check is really failing and its evidence is only an excerpt (non-vacuity)', () => {
    const check = failingIdleCheck();
    expect(check.status).toBe('fail');
    expect(check.evidence!.length).toBeLessThanOrEqual(MAX_EVIDENCE_CHARS);
    expect(check.evidence!.length).toBeLessThan(RAW.length);
  });

  it('writes the capture byte for byte, and the judgement beside it', () => {
    const kept = archiveCheckFrames(archive, {
      tool: 'codex',
      version: 'codex-cli 0.157.1',
      check: failingIdleCheck(),
      frames: [{ frame: RAW }],
      now: new Date('2026-10-04T00:00:00.000Z'),
    });

    const txt = path.join(archive.dir, 'codex-screen-idle.txt');
    expect(kept.framePaths).toEqual([txt]);
    expect(fs.readFileSync(txt, 'utf8')).toBe(RAW);

    const meta = JSON.parse(fs.readFileSync(path.join(archive.dir, 'codex-screen-idle.json'), 'utf8'));
    expect(meta).toMatchObject({
      tool: 'codex',
      checkId: 'screen-idle',
      status: 'fail',
      version: 'codex-cli 0.157.1',
      savedAt: '2026-10-04T00:00:00.000Z',
    });
    expect(meta.summary).toContain('期待:');
  });

  it('keeps nothing for a passing check, unless the archive keeps every frame', () => {
    const passing = { checkId: 'screen-quoted-dialog' as const, status: 'pass' as const, summary: 'ok' };

    expect(archiveCheckFrames(archive, { tool: 'claude', check: passing, frames: [{ frame: RAW }] })).toBe(passing);
    expect(fs.existsSync(archive.dir)).toBe(false);

    const all = archiveCheckFrames({ ...archive, mode: 'all' }, { tool: 'claude', check: passing, frames: [{ frame: RAW }] });
    expect(all.framePaths).toEqual([path.join(archive.dir, 'claude-screen-quoted-dialog.txt')]);
    expect(fs.readFileSync(all.framePaths![0], 'utf8')).toBe(RAW);
  });

  it('a screen-picker check keeps one file per picker it opened', () => {
    const results = [
      { screen: '/model', opened: true, verdict: null, frame: `${RAW}\n<model>`, closed: true },
      { screen: '/effort', opened: false, verdict: null, frame: `${RAW}\n<effort>`, closed: true },
    ];
    const check = { checkId: 'screen-picker' as const, ...evaluatePickerScreens(results) };
    expect(check.status).toBe('fail');

    const kept = archiveCheckFrames(archive, {
      tool: 'claude',
      check,
      frames: results.map(result => ({ screen: result.screen, frame: result.frame })),
    });
    expect(kept.framePaths).toEqual([
      path.join(archive.dir, 'claude-screen-picker-model.txt'),
      path.join(archive.dir, 'claude-screen-picker-effort.txt'),
    ]);
    expect(fs.readFileSync(kept.framePaths![1], 'utf8')).toBe(`${RAW}\n<effort>`);
  });

  it('leaves non-screen checks, skips, empty frames and a missing archive alone', () => {
    const hook = { checkId: 'hook-correlation' as const, status: 'fail' as const, summary: 'x' };
    expect(archiveCheckFrames(archive, { tool: 'codex', check: hook, frames: [{ frame: RAW }] })).toBe(hook);

    const skip = { checkId: 'screen-approval' as const, status: 'skip' as const, summary: 'x' };
    expect(archiveCheckFrames({ ...archive, mode: 'all' }, { tool: 'codex', check: skip, frames: [{ frame: RAW }] })).toBe(skip);

    const failing = failingIdleCheck();
    expect(archiveCheckFrames(archive, { tool: 'codex', check: failing, frames: [{ frame: '' }] })).toBe(failing);
    expect(archiveCheckFrames(null, { tool: 'codex', check: failing, frames: [{ frame: RAW }] })).toBe(failing);
    expect(fs.existsSync(archive.dir)).toBe(false);
  });

  it('a frame that cannot be written leaves the check as it was, without throwing', () => {
    // The frames directory's parent is a FILE, so mkdir fails.
    fs.writeFileSync(path.join(tmp, 'frames'), 'not a directory');
    const failing = failingIdleCheck();
    const kept = archiveCheckFrames(archive, { tool: 'codex', check: failing, frames: [{ frame: RAW }] });
    expect(kept).toBe(failing);
    expect(kept.framePaths).toBeUndefined();
  });
});

describe('[#3183] where frames go', () => {
  it('beside the report directory, one directory per date', () => {
    expect(framesDirFor('/x/agent-health/reports/2026-10-04.json', '2026-10-04')).toBe(
      path.join('/x/agent-health', 'frames', '2026-10-04'),
    );
  });

  it('file names are <tool>-<checkId>[-<screen>]', () => {
    expect(frameFileBase('codex', 'screen-idle')).toBe('codex-screen-idle');
    expect(frameFileBase('claude', 'screen-picker', '/model')).toBe('claude-screen-picker-model');
    expect(frameFileBase('opencode-v2', 'screen-picker', '/')).toBe('opencode-v2-screen-picker');
  });

  it(`${SAVE_FRAMES_ENV_VAR}=all keeps every frame; anything else only failing ones`, () => {
    expect(resolveFrameSaveMode({ [SAVE_FRAMES_ENV_VAR]: 'all' })).toBe('all');
    expect(resolveFrameSaveMode({ [SAVE_FRAMES_ENV_VAR]: 'yes' })).toBe('fail');
    expect(resolveFrameSaveMode({})).toBe('fail');
  });
});
