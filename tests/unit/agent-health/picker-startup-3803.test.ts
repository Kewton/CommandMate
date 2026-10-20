/**
 * Issue #3803: codex 0.163 refuses `/model` sent before its start-up is over
 * ("Model selection is disabled until startup completes."). The probe sent it
 * once, so `screen-picker` failed on a tool that was only still starting.
 * Now that refusal sends the command again; nothing else changes.
 *
 * @vitest-environment node
 */

import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { stripAnsi } from '@/lib/detection/ansi';
import {
  pickerBaseline,
  readPickerAttempt,
  sendUntilPickerOpens,
  type PickerOpenScreen,
} from '@/lib/agent-health/picker-open';
import { evaluatePickerScreens } from '@/lib/agent-health/screen-checks';
import {
  CODEX_MODEL_PICKER_OPEN,
  CODEX_PICKER_NOT_READY,
  TOOL_PROBE_SPECS,
} from '../../../scripts/agent-health/tool-table';

const REPO = path.join(__dirname, '..', '..', '..');
const CODEX_PICKER = stripAnsi(
  fs.readFileSync(path.join(REPO, 'tests', 'fixtures', 'agent-health-picker-3053', 'codex-model.txt'), 'utf8')
);

const IDLE = [
  '  >_ OpenAI Codex (v0.163.0)',
  '     /private/tmp/cm-agent-health-probe/codex',
  '',
  '› Ask Codex to do anything',
  '',
  '  GPT-6.1-Sol low · /private/tmp/cm-agent-health-probe/codex',
  '  ? for shortcuts',
].join('\n');

/** The frame of the 2026-10-19 report (Issue #3803), work-dir path replaced. */
const REFUSED = ['• Model selection is disabled until startup completes.', '', IDLE].join('\n');

const codex: PickerOpenScreen = { opened: CODEX_MODEL_PICKER_OPEN, notReady: CODEX_PICKER_NOT_READY };

const LIMITS = { appearMs: 15_000, startupMs: 45_000, retryMs: 3000, pollMs: 1000 };

/**
 * A pane on a virtual clock: `frames(sends)` is what it shows after that many
 * sends. Every `sleep` moves the clock, so nothing here waits for real.
 */
function fakePane(frames: (sends: number) => string) {
  let clock = 0;
  let sends = 0;
  return {
    get sends() {
      return sends;
    },
    deps: {
      look: async () => frames(sends),
      send: async () => {
        sends++;
      },
      sleep: async (ms: number) => {
        clock += ms;
      },
      now: () => clock,
    },
  };
}

describe('codex picker spec', () => {
  it('names the start-up refusal for /model', () => {
    const screen = TOOL_PROBE_SPECS.codex.picker?.screens[0];
    expect(screen?.command).toBe('/model');
    expect(screen?.notReady).toBe(CODEX_PICKER_NOT_READY);
  });

  it('the refusal text is on the reported frame, not on the picker or the idle screen', () => {
    expect(CODEX_PICKER_NOT_READY.test(REFUSED)).toBe(true);
    expect(CODEX_PICKER_NOT_READY.test(CODEX_PICKER)).toBe(false);
    expect(CODEX_PICKER_NOT_READY.test(IDLE)).toBe(false);
    // The refusal is not mistaken for the picker either.
    expect(CODEX_MODEL_PICKER_OPEN.test(REFUSED)).toBe(false);
  });

  it('leaves claude\'s pickers on one send (no refusal known)', () => {
    for (const screen of TOOL_PROBE_SPECS.claude.picker?.screens ?? []) expect(screen.notReady).toBeUndefined();
  });
});

describe('readPickerAttempt', () => {
  it('reads a new refusal as not-ready and a refusal already in the scrollback as pending', () => {
    expect(readPickerAttempt(REFUSED, codex, pickerBaseline(IDLE, codex))).toBe('not-ready');
    expect(readPickerAttempt(REFUSED, codex, pickerBaseline(REFUSED, codex))).toBe('pending');
  });

  it('reads the picker as opened even below an older refusal', () => {
    expect(readPickerAttempt(`${REFUSED}\n${CODEX_PICKER}`, codex, pickerBaseline(REFUSED, codex))).toBe('opened');
  });
});

describe('sendUntilPickerOpens', () => {
  it('sends /model again after the start-up refusal and judges the picker that then opens', async () => {
    // First send refused (start-up still running), second opens the picker.
    const pane = fakePane((sends) => (sends === 0 ? IDLE : sends === 1 ? REFUSED : `${REFUSED}\n${CODEX_PICKER}`));
    const outcome = await sendUntilPickerOpens(codex, pane.deps, LIMITS);
    expect(outcome).toEqual({ opened: true, refusals: 1 });
    expect(pane.sends).toBe(2);
  });

  it('counts a second refusal below the first as new', async () => {
    const pane = fakePane((sends) =>
      sends === 0 ? IDLE : sends < 3 ? Array(sends).fill(REFUSED).join('\n') : `${REFUSED}\n${REFUSED}\n${CODEX_PICKER}`
    );
    expect(await sendUntilPickerOpens(codex, pane.deps, LIMITS)).toEqual({ opened: true, refusals: 2 });
    expect(pane.sends).toBe(3);
  });

  it('stops sending once start-up runs out', async () => {
    const pane = fakePane((sends) => Array(sends).fill(REFUSED).join('\n') || IDLE);
    const outcome = await sendUntilPickerOpens(codex, pane.deps, LIMITS);
    expect(outcome.opened).toBe(false);
    expect(outcome.refusals).toBe(pane.sends);
    // 45 s of start-up, one poll plus a 3 s pause per refused send.
    expect(pane.sends).toBeGreaterThan(1);
    expect(pane.sends).toBeLessThanOrEqual(12);
  });

  it('sends once when the picker opens at once (unchanged)', async () => {
    const pane = fakePane((sends) => (sends === 0 ? IDLE : CODEX_PICKER));
    expect(await sendUntilPickerOpens(codex, pane.deps, LIMITS)).toEqual({ opened: true, refusals: 0 });
    expect(pane.sends).toBe(1);
  });

  it('sends once when nothing appears (unchanged: the picker is judged not opened)', async () => {
    const pane = fakePane(() => IDLE);
    expect(await sendUntilPickerOpens(codex, pane.deps, LIMITS)).toEqual({ opened: false, refusals: 0 });
    expect(pane.sends).toBe(1);
  });

  it('sends once on a screen without a refusal pattern, even if the text appears', async () => {
    const pane = fakePane((sends) => (sends === 0 ? IDLE : REFUSED));
    expect(await sendUntilPickerOpens({ opened: CODEX_MODEL_PICKER_OPEN }, pane.deps, LIMITS)).toEqual({
      opened: false,
      refusals: 0,
    });
    expect(pane.sends).toBe(1);
  });
});

describe('screen-picker summary', () => {
  it('says the picker was refused as still starting', () => {
    const verdict = evaluatePickerScreens([
      { screen: '/model', opened: false, verdict: null, frame: REFUSED, closed: true, expectPrompt: true, refusals: 3 },
    ]);
    expect(verdict.status).toBe('fail');
    expect(verdict.summary).toContain('/model: 不合格（画面が開いたことを確認できなかった。起動完了前として 3 回拒否された）');
  });

  it('keeps the old wording without refusals', () => {
    const verdict = evaluatePickerScreens([
      { screen: '/model', opened: false, verdict: null, frame: IDLE, closed: true, expectPrompt: true },
    ]);
    expect(verdict.summary).toContain('/model: 不合格（画面が開いたことを確認できなかった）');
  });
});
