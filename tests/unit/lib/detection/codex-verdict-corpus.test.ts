/**
 * Every codex capture in the repository, and the verdict the detector gives it
 * (Issue #2842).
 *
 * codex's screens change with its releases (#1154, #2310, #2798, #2818 were all
 * a codex upgrade), and the detector's rules were written one Issue at a time,
 * each pinned by its own test file. Nothing pinned them TOGETHER, so a rule
 * added for one screen could move another screen's verdict without any test
 * noticing — the per-Issue files only look at their own fixtures.
 *
 * This file is that single table:
 *
 *  1. **corpus** — every `*.txt` / `*.capture` under `tests/` whose path mentions
 *     codex, read as captured AND after `stripAnsi` (Auto-Yes's spelling), with
 *     the expected `status/reason[/prompt]`. A verdict that moves fails here.
 *     The rows record what the detector says today; a row that looks wrong is
 *     fixed in the detector's own Issue, and then here.
 *  2. **completeness** — a codex capture added to `tests/` without a row fails,
 *     so the table cannot silently fall behind.
 *  3. **probe** — `CODEX_PROBE_DIR=<dir>` runs a standard set of screens
 *     captured from a NEW codex build (see
 *     `docs/design/codex-detection-corpus.md`). Skipped when unset.
 *
 * @vitest-environment node
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { detectSessionStatus } from '@/lib/detection/status-detector';
import { stripAnsi } from '@/lib/detection/cli-patterns';

const TESTS_ROOT = path.resolve(__dirname, '../../..');

/** `status/reason`, plus `/prompt` when `hasActivePrompt` is true. */
function verdictOf(frame: string): string {
  const r = detectSessionStatus(frame, 'codex');
  return `${r.status}/${r.reason}${r.hasActivePrompt ? '/prompt' : ''}`;
}

/** [path under tests/, verdict as captured, verdict after stripAnsi] */
const CORPUS: ReadonlyArray<readonly [string, string, string]> = [
  ['fixtures/agent-mode-2592/codex-default-thread-title.txt', 'ready/input_prompt', 'ready/input_prompt'],
  ['fixtures/agent-mode-2592/codex-default.txt', 'ready/input_prompt', 'ready/input_prompt'],
  ['fixtures/agent-mode-2592/codex-plan-no-thread-title.txt', 'ready/input_prompt', 'ready/input_prompt'],
  ['fixtures/agent-mode-2592/codex-plan.txt', 'ready/input_prompt', 'ready/input_prompt'],
  ['fixtures/chat-dialog-card-2254/codex-model-0-151-0.txt', 'waiting/codex_selection_list', 'waiting/codex_selection_list'],
  ['fixtures/chat-dialog-card-2254/codex-trust-0-151-0.txt', 'waiting/prompt_detected/prompt', 'waiting/prompt_detected/prompt'],
  ['fixtures/codex-browser-use-2609/approval-form-browser-use.txt', 'waiting/prompt_detected/prompt', 'waiting/prompt_detected/prompt'],
  ['fixtures/codex-dialogs-0155/composer-typed-slash.txt', 'ready/input_prompt', 'ready/input_prompt'],
  ['fixtures/codex-dialogs-0155/dialog-approval-run-command.txt', 'waiting/prompt_detected/prompt', 'waiting/prompt_detected/prompt'],
  ['fixtures/codex-dialogs-0155/dialog-experimental-toggles.txt', 'waiting/codex_selection_list', 'ready/input_prompt'],
  ['fixtures/codex-dialogs-0155/dialog-keymap-editor.txt', 'waiting/codex_selection_list', 'ready/input_prompt'],
  ['fixtures/codex-dialogs-0155/dialog-model-picker.txt', 'waiting/codex_selection_list', 'waiting/codex_selection_list'],
  ['fixtures/codex-dialogs-0155/dialog-trust-directory.txt', 'waiting/prompt_detected/prompt', 'waiting/prompt_detected/prompt'],
  ['fixtures/codex-dialogs-0155/idle-after-declined-approval.txt', 'ready/input_prompt', 'ready/input_prompt'],
  ['fixtures/codex-dialogs-0155/idle-composer.txt', 'ready/input_prompt', 'ready/input_prompt'],
  ['fixtures/codex-idle-composer-0155/idle-after-turn.txt', 'ready/input_prompt', 'ready/input_prompt'],
  ['fixtures/codex-live-2310/dialog-experimental-toggles.txt', 'waiting/codex_selection_list', 'ready/input_prompt'],
  ['fixtures/codex-live-2310/dialog-keymap-editor.txt', 'waiting/codex_selection_list', 'ready/input_prompt'],
  ['fixtures/codex-live-2310/dialog-permissions-picker.txt', 'waiting/codex_selection_list', 'waiting/codex_selection_list'],
  ['fixtures/codex-live-2310/dialog-trust-directory.txt', 'waiting/prompt_detected/prompt', 'waiting/prompt_detected/prompt'],
  ['fixtures/codex-live-2310/idle-composer.txt', 'ready/input_prompt', 'ready/input_prompt'],
  ['fixtures/codex-live-2310/saturated-idle-tail.txt', 'ready/input_prompt', 'ready/input_prompt'],
  ['fixtures/codex-live-2310/steer-queued-running.txt', 'ready/input_prompt', 'ready/input_prompt'],
  ['fixtures/codex-live-2310/turn-running.txt', 'running/thinking_indicator', 'running/thinking_indicator'],
  ['fixtures/codex-live-2310/turn-submitted-no-status.txt', 'ready/input_prompt', 'ready/input_prompt'],
  ['fixtures/codex-quoted-footer-2774/idle-after-quoted-picker-footer.txt', 'ready/input_prompt', 'ready/input_prompt'],
  ['fixtures/codex-thread-title-probe/idle-after-command.txt', 'ready/input_prompt', 'ready/input_prompt'],
  ['fixtures/codex-thread-title-probe/running-after-command.txt', 'running/thinking_indicator', 'running/thinking_indicator'],
  ['fixtures/codex-thread-title-probe/running-in-command.txt', 'running/thinking_indicator', 'running/thinking_indicator'],
  ['fixtures/codex-update-dialog-2068/update-dialog-01491.txt', 'waiting/prompt_detected/prompt', 'waiting/prompt_detected/prompt'],
  ['fixtures/codex-update-dialog-2068/updated-shell-01491.txt', 'waiting/prompt_detected/prompt', 'waiting/prompt_detected/prompt'],
  ['fixtures/codex-update-dialog-2068/updating-01491.txt', 'waiting/prompt_detected/prompt', 'waiting/prompt_detected/prompt'],
  ['fixtures/long-body-2464/codex-idle.capture', 'ready/input_prompt', 'ready/input_prompt'],
  ['fixtures/long-body-2464/codex-pasted-content.capture', 'ready/input_prompt', 'ready/input_prompt'],
  ['fixtures/tool-liveness-2070/codex-exited-01491.txt', 'waiting/prompt_detected/prompt', 'waiting/prompt_detected/prompt'],
  ['fixtures/tool-liveness-2070/codex-ready-01491.txt', 'ready/input_prompt', 'ready/input_prompt'],
  ['fixtures/tool-liveness-2070/codex-trust-dialog-01491.txt', 'waiting/prompt_detected/prompt', 'waiting/prompt_detected/prompt'],
  ['fixtures/tui-frame-footer-2776/codex-0.155.1-idle-after-turn.txt', 'ready/input_prompt', 'ready/input_prompt'],
  ['fixtures/tui-frame-footer-2776/codex-0.155.1-idle-quoted-footers.txt', 'ready/input_prompt', 'ready/input_prompt'],
  ['unit/lib/detection/fixtures/codex-live-1628/approval-apply-patch.txt', 'waiting/prompt_detected/prompt', 'waiting/prompt_detected/prompt'],
  ['unit/lib/detection/fixtures/codex-live-1628/approval-run-command.txt', 'waiting/prompt_detected/prompt', 'waiting/prompt_detected/prompt'],
  ['unit/lib/detection/fixtures/codex-live-1628/idle-ready.txt', 'ready/input_prompt', 'ready/input_prompt'],
  ['unit/lib/detection/fixtures/codex-live-1628/model-picker-step1.txt', 'waiting/codex_selection_list', 'waiting/codex_selection_list'],
  ['unit/lib/detection/fixtures/codex-live-1628/model-picker-step2.txt', 'waiting/codex_selection_list', 'waiting/codex_selection_list'],
  ['unit/lib/detection/fixtures/codex-live-1628/working.txt', 'running/thinking_indicator', 'running/thinking_indicator'],
  ['unit/lib/detection/fixtures/codex-live-1671/reported-session-tail.txt', 'ready/input_prompt', 'ready/input_prompt'],
  ['unit/lib/detection/fixtures/codex-live-1671/turn-complete-short-message.txt', 'ready/input_prompt', 'ready/input_prompt'],
  ['unit/lib/detection/fixtures/codex-live-1671/turn-running-command.txt', 'running/thinking_indicator', 'running/thinking_indicator'],
  ['unit/lib/detection/fixtures/codex-live-1890/composer-placeholder-ask.txt', 'ready/input_prompt', 'ready/input_prompt'],
  ['unit/lib/detection/fixtures/codex-live-1890/composer-residual-leading-number.txt', 'ready/input_prompt', 'ready/input_prompt'],
  ['unit/lib/detection/fixtures/codex-live-1890/composer-residual-multiline.txt', 'running/thinking_indicator', 'running/thinking_indicator'],
  ['unit/lib/detection/fixtures/codex-live-1890/composer-residual-plain.txt', 'ready/input_prompt', 'ready/input_prompt'],
  ['unit/lib/detection/fixtures/codex-live-1890/composer-residual-slash.txt', 'ready/input_prompt', 'ready/input_prompt'],
  ['unit/lib/detection/fixtures/codex-live-1890/dialog-model-picker.txt', 'waiting/codex_selection_list', 'waiting/codex_selection_list'],
  ['unit/lib/tmux/fixtures/capture-codex.txt', 'running/thinking_indicator', 'running/thinking_indicator'],
];

/** Every codex capture under tests/ (the completeness rule's definition). */
function listCodexCaptures(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === 'node_modules') continue;
      listCodexCaptures(full, out);
      continue;
    }
    const rel = path.relative(TESTS_ROOT, full).split(path.sep).join('/');
    if (/codex/i.test(rel) && /\.(txt|capture)$/.test(name)) out.push(rel);
  }
  return out;
}

describe('codex verdict corpus', () => {
  describe.each(CORPUS)('%s', (rel, asCaptured, stripped) => {
    const frame = readFileSync(path.join(TESTS_ROOT, rel), 'utf8');

    it('as captured', () => {
      expect(verdictOf(frame)).toBe(asCaptured);
    });

    it('after stripAnsi', () => {
      expect(verdictOf(stripAnsi(frame))).toBe(stripped);
    });
  });

  it('lists every codex capture under tests/', () => {
    const listed = new Set(CORPUS.map(([rel]) => rel));
    const missing = listCodexCaptures(TESTS_ROOT).filter((rel) => !listed.has(rel));
    expect(missing).toEqual([]);
  });
});

/**
 * The standard screens to capture from a new codex build, and what each must
 * read. File names are fixed so the procedure doc and this table agree.
 */
const PROBE_SCREENS: ReadonlyArray<readonly [string, string]> = [
  ['idle.txt', 'ready/input_prompt'],
  ['running.txt', 'running/thinking_indicator'],
  ['approval.txt', 'waiting/prompt_detected/prompt'],
  ['model-picker.txt', 'waiting/codex_selection_list'],
  ['trust.txt', 'waiting/prompt_detected/prompt'],
  ['quoted-approval-idle.txt', 'ready/input_prompt'],
];

const PROBE_DIR = process.env.CODEX_PROBE_DIR;

describe.skipIf(!PROBE_DIR)('codex probe (CODEX_PROBE_DIR)', () => {
  it.each(PROBE_SCREENS)('%s', (name, expected) => {
    const file = path.join(PROBE_DIR ?? '', name);
    // A missing screen is reported, not skipped: the point of the probe is that
    // every screen was looked at on the new build.
    expect(existsSync(file), `${file} was not captured`).toBe(true);
    const frame = readFileSync(file, 'utf8');
    expect(verdictOf(frame)).toBe(expected);
    expect(verdictOf(stripAnsi(frame))).toBe(expected);
  });
});
