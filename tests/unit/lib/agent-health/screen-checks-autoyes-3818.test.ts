/**
 * The agent-health picker check reads agy frames the way Auto-Yes does
 * (Issue #3818).
 *
 * `ScreenVerdict.isPrompt` is documented as "what Auto-Yes reads", and the
 * probe filled it from `detectPrompt` alone — which on agy skips the dialog
 * reader and the refusal of numbered screens nothing vouches for (#3808,
 * #3818). `readsAsAutoYesPrompt` routes agy through `detectPromptOnCleanFrame`,
 * the Auto-Yes poller's entry, and leaves every other tool on the caller's
 * reading.
 *
 * The cut frame is `antigravity-live-2364/dialog-bash-oneline.txt` (agy 1.1.27,
 * live) with option 2's row removed, written to a temp dir and read back.
 *
 * @vitest-environment node
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readsAsAutoYesPrompt } from '@/lib/agent-health/screen-checks';
import { buildDetectPromptOptions, stripAnsi, stripBoxDrawing } from '@/lib/detection/cli-patterns';
import { detectPrompt } from '@/lib/detection/prompt-detector';
import { detectPromptOnCleanFrame } from '@/lib/polling/response-checker';

const FIXTURES = path.resolve(__dirname, '../../../fixtures');
const read = (rel: string): string => readFileSync(path.join(FIXTURES, rel), 'utf8');
const PERMISSION = read('antigravity-live-2364/dialog-bash-oneline.txt');

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'cm-3818-health-'));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/** The live frame without option 2's row (`> 1.` / `3.` / `4.`). */
function withNumberMissing(): string {
  const rows = PERMISSION.split('\n');
  const option2 = rows.findIndex(row => /^\s*2\.\s/.test(stripAnsi(row)));
  if (option2 < 0) throw new Error('no option 2 row');
  const file = path.join(tmp, 'gap.txt');
  writeFileSync(file, rows.filter((_, i) => i !== option2).join('\n'));
  return readFileSync(file, 'utf8');
}

/** What the probe hands in: the frame as captured, and its ANSI-stripped copy. */
const generic = (clean: string) => () =>
  detectPrompt(stripBoxDrawing(clean), buildDetectPromptOptions('antigravity')).isPrompt;

describe('[#3818] readsAsAutoYesPrompt on agy is the Auto-Yes entry\'s reading', () => {
  it('a permission dialog missing a number: detectPrompt alone says prompt, Auto-Yes does not', () => {
    const raw = withNumberMissing();
    const clean = stripAnsi(raw);
    const autoYes = detectPromptOnCleanFrame(stripBoxDrawing(clean), 'antigravity', undefined, raw).isPrompt;

    expect(generic(clean)()).toBe(true);
    expect(autoYes).toBe(false);
    expect(readsAsAutoYesPrompt('antigravity', clean, raw, generic(clean))).toBe(autoYes);
  });

  it.each([
    'antigravity-live-2364/dialog-bash-oneline.txt',
    'antigravity-live-2364/dialog-feedback-category.txt',
    'antigravity-live-2364/picker-switch-model.txt',
    'prompt-observation-3797/antigravity-login-method.txt',
  ])('%s: the same answer as detectPromptOnCleanFrame', (rel) => {
    const raw = read(rel);
    const clean = stripAnsi(raw);
    expect(readsAsAutoYesPrompt('antigravity', clean, raw, generic(clean))).toBe(
      detectPromptOnCleanFrame(stripBoxDrawing(clean), 'antigravity', undefined, raw).isPrompt,
    );
  });

  it('every other tool keeps the caller\'s reading, unchanged', () => {
    const readGeneric = vi.fn(() => true);
    expect(readsAsAutoYesPrompt('codex', 'anything', 'anything', readGeneric)).toBe(true);
    expect(readGeneric).toHaveBeenCalledTimes(1);
    expect(readsAsAutoYesPrompt('claude', 'anything', 'anything', () => false)).toBe(false);
  });
});
