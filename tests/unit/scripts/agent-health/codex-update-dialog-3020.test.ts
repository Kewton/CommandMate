/**
 * Issue #3020: codex opened with its update offer instead of the composer, so
 * the daily `screen-idle` check judged that dialog — correctly `waiting` — and
 * failed the day codex 0.159.1 came out.
 *
 * The probe launches codex with `check_for_update_on_startup=false` (no dialog,
 * no refresh of the user's `version.json`), and answers "2. Skip" if the offer
 * still shows up. Pinned on the real 0.157.1 frame in
 * `tests/fixtures/codex-update-dialog-3020/`.
 *
 * @vitest-environment node
 */

import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { stripAnsi } from '@/lib/detection/ansi';
import { detectSessionStatus } from '@/lib/detection/status-detector';
import { CODEX_DIALOG_FOOTER_PATTERN } from '@/lib/detection/tools/codex/cli-patterns';
import { selectionKeys } from '@/lib/agent-health/dialog-select';
import { buildProbeLaunchCommand } from '../../../../scripts/agent-health/probe-tool';
import {
  CODEX_UPDATE_DIALOG_OPEN,
  CODEX_UPDATE_SKIP_OPTION,
  TOOL_PROBE_SPECS,
} from '../../../../scripts/agent-health/tool-table';

const FIXTURES = path.resolve(__dirname, '../../../fixtures');
const read = (rel: string): string => fs.readFileSync(path.join(FIXTURES, rel), 'utf8');

const UPDATE_0157 = read('codex-update-dialog-3020/update-dialog-01571.txt');
const UPDATE_0149 = read('codex-update-dialog-2068/update-dialog-01491.txt');
const IDLE_0157 = read('codex-dialogs-0157/idle.txt');

const codex = TOOL_PROBE_SPECS.codex;
const startupDialogFor = (frame: string) => codex.startupDialogs.find((d) => d.pattern.test(stripAnsi(frame)));

describe('codex update offer at launch (Issue #3020)', () => {
  it('the captured frame is the reported one, and the detector rightly calls it a prompt', () => {
    const clean = stripAnsi(UPDATE_0157);
    expect(clean).toContain('Update available · 0.157.1 → 0.159.1');
    expect(clean).toContain('enter continue · esc skip');
    const verdict = detectSessionStatus(UPDATE_0157, 'codex');
    expect(verdict.status).toBe('waiting');
    expect(verdict.reason).toBe('prompt_detected');
    expect(verdict.hasActivePrompt).toBe(true);
  });

  it('launches codex with the update check off', () => {
    const flags = codex.launchFlags('/tmp/cm-agent-health-x/codex');
    const at = flags.indexOf('check_for_update_on_startup=false');
    expect(at).toBeGreaterThan(0);
    expect(flags[at - 1]).toBe('-c');
    expect(buildProbeLaunchCommand(codex, "'codex'", '/w/codex')).toContain("'-c' 'check_for_update_on_startup=false'");
  });

  it('recognises the open offer as a start-up dialog (0.157.1 and 0.149.1 wording)', () => {
    expect(startupDialogFor(UPDATE_0157)?.id).toBe('update');
    expect(startupDialogFor(UPDATE_0149)?.id).toBe('update');
  });

  it('answers "2. Skip", never "3. Skip until next version"', () => {
    expect(selectionKeys(UPDATE_0157, CODEX_UPDATE_SKIP_OPTION)).toEqual(['Down', 'Enter']);
    expect(CODEX_UPDATE_SKIP_OPTION.test('  3. Skip until next version')).toBe(false);
    expect(CODEX_UPDATE_SKIP_OPTION.test('› 2. Skip')).toBe(true);
  });

  it('leaves the idle screen alone, even with an old offer in the scrollback above it', () => {
    expect(startupDialogFor(IDLE_0157)).toBeUndefined();
    const scrolled = `${stripAnsi(UPDATE_0157).trimEnd()}\n\n${stripAnsi(IDLE_0157)}`;
    expect(CODEX_UPDATE_DIALOG_OPEN.test(scrolled)).toBe(false);
  });

  it("knows the 0.157.1 footer, so the offer does not log a footer drift", () => {
    expect(CODEX_DIALOG_FOOTER_PATTERN.test('enter continue · esc skip')).toBe(true);
  });
});
