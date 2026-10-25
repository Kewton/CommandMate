/**
 * Issue #3818: the daily check judges a picker frame's `isPrompt` the way
 * Auto-Yes reads it — agy through the Auto-Yes entry (`detectPromptOnCleanFrame`),
 * every other tool through `detectPrompt` as before.
 *
 * `pickerReadsAsPrompt` is what `pickerTurn` stores into `verdict.isPrompt`
 * (asserted on the source below, as `picker-3053.test.ts` reads the keys it
 * sends). The cut agy frame is `antigravity-live-2364/dialog-bash-oneline.txt`
 * (agy 1.1.27, live) without option 2's row, written to a temp dir and read back.
 *
 * @vitest-environment node
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { stripAnsi } from '@/lib/detection/ansi';
import { buildDetectPromptOptions, stripBoxDrawing } from '@/lib/detection/cli-patterns';
import { detectPrompt } from '@/lib/detection/prompt-detector';
import { detectPromptOnCleanFrame } from '@/lib/polling/response-checker';
import { pickerReadsAsPrompt } from '../../../../scripts/agent-health/probe-tool';

const REPO = path.join(__dirname, '..', '..', '..', '..');
const read = (rel: string): string => fs.readFileSync(path.join(REPO, 'tests', 'fixtures', rel), 'utf8');

/** What `look()` hands `pickerTurn`: the capture and its ANSI-stripped copy. */
const settledOf = (frame: string) => ({ frame, clean: stripAnsi(frame) });

/** The Auto-Yes entry's reading of the same frame. */
const autoYesReads = (frame: string): boolean =>
  detectPromptOnCleanFrame(stripBoxDrawing(stripAnsi(frame)), 'antigravity', undefined, frame).isPrompt;

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-3818-probe-'));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function withNumberMissing(): string {
  const rows = read('antigravity-live-2364/dialog-bash-oneline.txt').split('\n');
  const option2 = rows.findIndex(row => /^\s*2\.\s/.test(stripAnsi(row)));
  if (option2 < 0) throw new Error('no option 2 row');
  const file = path.join(tmp, 'gap.txt');
  fs.writeFileSync(file, rows.filter((_, i) => i !== option2).join('\n'));
  return fs.readFileSync(file, 'utf8');
}

describe('[#3818] the probe\'s picker isPrompt on agy is the Auto-Yes entry\'s', () => {
  it('a permission dialog missing a number: detectPrompt alone says prompt, the probe does not', () => {
    const frame = withNumberMissing();
    const generic = detectPrompt(stripBoxDrawing(stripAnsi(frame)), buildDetectPromptOptions('antigravity')).isPrompt;
    expect(generic).toBe(true);
    expect(autoYesReads(frame)).toBe(false);
    expect(pickerReadsAsPrompt('antigravity', settledOf(frame))).toBe(false);
  });

  it.each([
    'antigravity-live-2364/dialog-bash-oneline.txt',
    'antigravity-live-2364/dialog-feedback-category.txt',
    'antigravity-live-2364/picker-switch-model.txt',
    'prompt-observation-3797/antigravity-login-method.txt',
  ])('%s: the same answer as the Auto-Yes entry', (rel) => {
    const frame = read(rel);
    expect(pickerReadsAsPrompt('antigravity', settledOf(frame))).toBe(autoYesReads(frame));
  });
});

describe('[#3818] the other tools keep detectPrompt\'s reading', () => {
  it.each([
    ['claude', 'agent-health-picker-3053/claude-model.txt'],
    ['claude', 'agent-health-picker-3053/claude-effort.txt'],
    ['codex', 'agent-health-picker-3053/codex-model.txt'],
  ] as const)('%s %s', (tool, rel) => {
    const frame = read(rel);
    const clean = stripAnsi(frame);
    expect(pickerReadsAsPrompt(tool, settledOf(frame))).toBe(
      detectPrompt(stripBoxDrawing(clean), buildDetectPromptOptions(tool)).isPrompt,
    );
  });
});

describe('[#3818] pickerTurn stores pickerReadsAsPrompt (probe-tool.ts)', () => {
  it('and calls detectPrompt nowhere else in the turn', () => {
    const source = fs.readFileSync(path.join(REPO, 'scripts', 'agent-health', 'probe-tool.ts'), 'utf8');
    const start = source.indexOf('async pickerTurn(');
    const end = source.indexOf('async start(', start);
    expect(start).toBeGreaterThan(0);
    const body = source.slice(start, end);
    expect(body).toContain('pickerReadsAsPrompt(this.spec.cliToolId, settled)');
    expect(body).not.toMatch(/detectPrompt\(/);
  });
});
