/**
 * agy 1.4's `/model` picker read as `antigravity-model-picker` (Issue #3797).
 *
 * Positive case: the live agy 1.4.2 captures of
 * `tests/fixtures/prompt-observation-3797/` (search box between the header and
 * the models, composer drawn ABOVE the picker), which came out `unknown`
 * before (#3773 D, #3788 3). Negative controls: every other screen captured in
 * the same session, and frames that carry the picker's words without being the
 * picker open at the bottom — a quote with the composer under it, a footer
 * folded by a narrow pane, a reply that names the rows, two highlights. The
 * strict `respond` still answers none of them.
 *
 * Mutated frames are written to a temp directory and read back, so no
 * fixture in the repository is touched.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { classifyScreen, type ScreenSnapshot } from '@/lib/prompt-observation/classify';
import { readAntigravityModelPicker } from '@/lib/prompt-observation/antigravity-model-picker';
import { buildPromptObservation, type ObservationInput } from '@/lib/prompt-observation/observe';
import { isStrictRespondKind } from '@/lib/prompt-observation/kinds';
import { stripAnsi } from '@/lib/detection/cli-patterns';
import { readAntigravityArrowScreen } from '@/lib/detection/tools/antigravity/screens';
import { detectSessionStatus } from '@/lib/detection/status-detector';
import { STATUS_REASON } from '@/lib/detection/status-reason';

const FIXTURES = path.resolve(__dirname, '../../../fixtures');
const read = (rel: string): string => fs.readFileSync(path.join(FIXTURES, rel), 'utf8');

const DIR = 'prompt-observation-3797';
const PICKER = read(`${DIR}/antigravity-model-picker-1.4.2.txt`);
const PICKER_TOP = read(`${DIR}/antigravity-model-picker-1.4.2-highlight-1.txt`);
const PICKER_THIRD = read(`${DIR}/antigravity-model-picker-1.4.2-highlight-3.txt`);
const PICKER_SEARCH = read(`${DIR}/antigravity-model-picker-1.4.2-search.txt`);
const PICKER_NO_MATCH = read(`${DIR}/antigravity-model-picker-1.4.2-no-match.txt`);
const SLASH_ONE_ROW = read(`${DIR}/antigravity-slash-popup-1.4.2-one-row.txt`);
const LOGIN_METHOD = read(`${DIR}/antigravity-login-method.txt`);
const IDLE_AFTER = read(`${DIR}/antigravity-idle-after-picker.txt`);
const PICKER_1127 = read('antigravity-live-2364/picker-switch-model.txt');
const TRUST = read('antigravity-live-2364/trust-dialog.txt');
const PERMISSION = read('antigravity-live-2364/dialog-bash-oneline.txt');

const MODELS = ['Gemini 4 Argon', 'Gemini 3.8 Flash (current)', 'Claude Opus 5.5', 'Claude Sonnet 5.5', 'GPT-OSS 120B (Medium)'];

/** The frame as the server publishes it: status flags from the real detector. */
function snapshot(frame: string): ScreenSnapshot {
  const status = detectSessionStatus(frame, 'antigravity');
  return {
    cliToolId: 'antigravity',
    fullOutput: frame,
    sessionStatus: status.status,
    isPromptWaiting: status.status === 'waiting' && status.reason === STATUS_REASON.PROMPT_DETECTED,
    promptData: null,
    isSelectionListActive: status.reason === STATUS_REASON.ANTIGRAVITY_SELECTION_LIST,
    isPagerActive: false,
    isDismissablePanelActive: false,
    isUnclassifiedActive: false,
  };
}

const kindOf = (frame: string) => classifyScreen(snapshot(frame)).kind;

/** The picker's rows with `edit` applied to the ANSI-stripped frame. */
function edited(frame: string, edit: (lines: string[]) => string[]): string {
  return edit(stripAnsi(frame).split('\n')).join('\n');
}

const footerIndex = (lines: string[]) => lines.findIndex(row => row.startsWith('Keyboard:'));

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-3797-'));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** Write a mutated frame under the temp directory and read it back. */
function viaTemp(name: string, frame: string): string {
  const file = path.join(tmp, name);
  fs.writeFileSync(file, frame);
  return fs.readFileSync(file, 'utf8');
}

describe('[#3797] agy 1.4.2 /model picker (positive case)', () => {
  it('the frames are the 200x1000 live captures', () => {
    for (const frame of [PICKER, PICKER_TOP, PICKER_THIRD, PICKER_SEARCH]) {
      expect(frame.split('\n')).toHaveLength(1001);
    }
  });

  it('the status layer publishes them as a selection list (something waits)', () => {
    const status = detectSessionStatus(PICKER, 'antigravity');
    expect(status.status).toBe('waiting');
    expect(status.reason).toBe(STATUS_REASON.ANTIGRAVITY_SELECTION_LIST);
  });

  it('the 1.1.27 reader does not read them (why they were unknown)', () => {
    expect(readAntigravityArrowScreen(stripAnsi(PICKER))).toBeNull();
  });

  it.each([
    ['the cursor on the current model', PICKER, 1],
    ['the cursor on the first model', PICKER_TOP, 0],
    ['the cursor moved down one', PICKER_THIRD, 2],
  ])('reads %s as antigravity-model-picker with its models', (_name, frame, selectedIndex) => {
    expect(classifyScreen(snapshot(frame))).toEqual({
      kind: 'antigravity-model-picker',
      question: 'Switch Model',
      approvalTarget: null,
      options: MODELS,
      selectedIndex,
    });
  });

  it('reads a search that narrowed the list to the rows it shows', () => {
    expect(classifyScreen(snapshot(PICKER_SEARCH))).toEqual({
      kind: 'antigravity-model-picker',
      question: 'Switch Model',
      approvalTarget: null,
      options: ['Claude Opus 5.5', 'Claude Sonnet 5.5'],
      selectedIndex: 0,
    });
  });

  it('reads a search that left one row', () => {
    const frame = viaTemp(
      'one-row.txt',
      edited(PICKER_SEARCH, lines => lines.filter(row => row !== '  Claude Sonnet 5.5'))
    );
    expect(readAntigravityModelPicker(frame)?.options).toEqual(['Claude Opus 5.5']);
  });

  it('the 1.1.27 picker is still read by its own reader', () => {
    expect(kindOf(PICKER_1127)).toBe('antigravity-model-picker');
  });

  it('is answered at the terminal, never by the strict respond', () => {
    const observation = buildPromptObservation(observationInput(PICKER));
    expect(observation.screen?.kind).toBe('antigravity-model-picker');
    expect(observation.screen?.answerVia).toBe('terminal');
    expect(observation.screen?.selectedPosition).toBe(2);
    expect(isStrictRespondKind('antigravity-model-picker')).toBe(false);
  });
});

describe('[#3797] negative controls: other screens of the same session', () => {
  it('a search that matched nothing has no rows to choose: unknown', () => {
    expect(kindOf(PICKER_NO_MATCH)).toBe('unknown');
    expect(readAntigravityModelPicker(stripAnsi(PICKER_NO_MATCH))).toBeNull();
  });

  it('the slash popup narrowed to /model is not the picker', () => {
    expect(readAntigravityModelPicker(stripAnsi(SLASH_ONE_ROW))).toBeNull();
    expect(kindOf(SLASH_ONE_ROW)).not.toBe('antigravity-model-picker');
  });

  it('the login-method screen is not the picker', () => {
    expect(readAntigravityModelPicker(stripAnsi(LOGIN_METHOD))).toBeNull();
    expect(kindOf(LOGIN_METHOD)).not.toBe('antigravity-model-picker');
  });

  it('the numbered login-method screen is unknown, not a permission dialog the strict respond answers', () => {
    // It passes the numbered-dialog structural test and is published as a
    // prompt; before #3797 it came out `antigravity-permission`.
    expect(detectSessionStatus(LOGIN_METHOD, 'antigravity').reason).toBe(STATUS_REASON.PROMPT_DETECTED);
    const observation = buildPromptObservation(observationInput(LOGIN_METHOD));
    expect(observation.screen?.kind).toBe('unknown');
    expect(observation.screen?.token).toBeNull();
    expect(observation.screen?.tokenWithheld).toBe('unknown-screen');
  });

  it('a permission dialog whose footer is not the measured `tab Amend` one is unknown', () => {
    const frame = viaTemp(
      'permission-other-footer.txt',
      edited(PERMISSION, lines =>
        lines.map(row => (/↑\/↓\s*Navigate/.test(row) ? '  ↑/↓ Navigate · enter Select' : row))
      )
    );
    expect(kindOf(PERMISSION)).toBe('antigravity-permission');
    expect(kindOf(frame)).toBe('unknown');
  });

  it('the composer after the picker closed: nothing asks', () => {
    expect(kindOf(IDLE_AFTER)).toBe('composer');
  });

  it('the trust screen and the permission dialog keep their kinds', () => {
    expect(kindOf(TRUST)).toBe('antigravity-trust');
    expect(kindOf(PERMISSION)).toBe('antigravity-permission');
  });
});

describe('[#3797] negative controls: the picker\'s words, not the picker open', () => {
  it('a picker with the composer drawn under it (quoted / scrollback) is not read', () => {
    const frame = viaTemp(
      'quoted.txt',
      edited(PICKER, lines => {
        const footer = footerIndex(lines);
        return [...lines.slice(0, footer + 1), '', '─'.repeat(200), '>', '─'.repeat(200), ...lines.slice(footer + 1)];
      })
    );
    expect(readAntigravityModelPicker(frame)).toBeNull();
    expect(kindOf(frame)).not.toBe('antigravity-model-picker');
  });

  it('a reply that names the rows, with no footer, is not read', () => {
    const frame = viaTemp(
      'reply.txt',
      edited(PICKER, lines => lines.filter(row => !row.startsWith('Keyboard:')))
    );
    expect(readAntigravityModelPicker(frame)).toBeNull();
  });

  it('a footer folded onto two rows by a narrow pane is not read', () => {
    const frame = viaTemp(
      'folded.txt',
      edited(PICKER, lines => {
        const footer = footerIndex(lines);
        return [
          ...lines.slice(0, footer),
          'Keyboard: ↑/↓ Navigate  ←/→ Effort',
          'enter Select  esc Go Back',
          ...lines.slice(footer + 1),
        ];
      })
    );
    expect(readAntigravityModelPicker(frame)).toBeNull();
  });

  it('a model row folded onto two rows changes the options, never invents a highlight', () => {
    const frame = viaTemp(
      'folded-row.txt',
      edited(PICKER, lines =>
        lines.flatMap(row => (row === '  GPT-OSS 120B (Medium)' ? ['  GPT-OSS 120B', '  (Medium)'] : [row]))
      )
    );
    const read = readAntigravityModelPicker(frame);
    expect(read?.selectedIndex).toBe(1);
    expect(read?.options).not.toEqual(MODELS);
  });

  it('two highlighted rows are not read', () => {
    const frame = viaTemp(
      'two-highlights.txt',
      edited(PICKER, lines => lines.map(row => (row === '  Claude Opus 5.5' ? '> Claude Opus 5.5' : row)))
    );
    expect(readAntigravityModelPicker(frame)).toBeNull();
  });

  it('no highlighted row is not read', () => {
    const frame = viaTemp(
      'no-highlight.txt',
      edited(PICKER, lines => lines.map(row => row.replace(/^> Gemini 3\.8 Flash/, '  Gemini 3.8 Flash')))
    );
    expect(readAntigravityModelPicker(frame)).toBeNull();
  });

  it('a picker with no search box (the header straight over the models) is not read here', () => {
    const frame = viaTemp(
      'no-search.txt',
      edited(PICKER, lines => lines.filter(row => !/^\s*Search:/.test(row) && !/^\s*─+$/.test(row)))
    );
    expect(readAntigravityModelPicker(frame)).toBeNull();
  });

  it('a picker with no effort row is not read', () => {
    const frame = viaTemp(
      'no-effort.txt',
      edited(PICKER, lines => lines.filter(row => !/^\s*Effort\b/.test(row)))
    );
    expect(readAntigravityModelPicker(frame)).toBeNull();
  });

  it('another tool showing the same frame is not agy', () => {
    expect(classifyScreen({ ...snapshot(PICKER), cliToolId: 'claude' }).kind).toBe('unknown');
  });
});

const NOW = 1_800_000_000_000;

function observationInput(frame: string): ObservationInput {
  const status = detectSessionStatus(frame, 'antigravity');
  return {
    worktreeId: 'wt-1',
    cliToolId: 'antigravity',
    instanceId: 'antigravity',
    resolvedBy: 'explicit',
    payload: {
      isRunning: true,
      sessionName: 'mcbd-antigravity-wt-1',
      sessionStatus: status.status,
      sessionStatusReason: status.reason,
      fullOutput: frame,
      isPromptWaiting: false,
      promptData: null,
      promptView: null,
      isSelectionListActive: true,
      isPagerActive: false,
      isDismissablePanelActive: false,
      isUnclassifiedActive: false,
      startingSince: null,
      autoYes: { enabled: false, expiresAt: null, lastSuppression: null, lastEnterFallback: null },
      serverPollerActive: false,
    },
    sessionGeneration: NOW - 60_000,
    contract: { policy: null, taskId: null },
    appearance: { note: () => NOW - 5_000, forget: () => {} },
    now: NOW,
  };
}
