/**
 * Issue #2983: which OpenCode V2 screens raise the chat surface's dialog card,
 * and which of them may carry the model keys.
 *
 * The card is drawn for `isSelectionListActive`, which the server publishes for
 * `waiting` with a reason in `SELECTION_LIST_REASONS`. The frames below were
 * captured from `opencode2` 2.0.18 for this Issue (80x200, private tmux socket,
 * isolated `HOME` / XDG — `tests/fixtures/opencode-v2-model-keys-2983/`): the
 * model picker, the palette and the variant picker all read as
 * `opencode_modal_overlay`, so the card IS there when they are open, and each
 * of them has the title row the card's v2 gate reads.
 *
 * @vitest-environment node
 */

import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { getToolStatusDetector } from '@/lib/detection/tools/registry';
import { normalizeFrame } from '@/lib/detection/tools/frame';
import * as cliPatterns from '@/lib/detection/cli-patterns';
import { stripAnsi } from '@/lib/detection/ansi';
import {
  OPENCODE_V2_DIALOG_TITLE_PATTERN,
  findOpencodeV2DialogTitle,
} from '@/lib/detection/tools/opencode-v2/dialog-title';
import { STATUS_REASON } from '@/lib/detection/status-reason';
import { SELECTION_LIST_REASONS } from '@/lib/detection/status-detector';

const FIXTURES = path.resolve(__dirname, '../../../../fixtures');
const read = (dir: string, name: string): string =>
  fs.readFileSync(path.join(FIXTURES, dir, `${name}.txt`), 'utf-8');
const frame2983 = (name: string): string => read('opencode-v2-model-keys-2983', name);

const detector = getToolStatusDetector('opencode-v2');

describe('Issue #2983: the dialog title reader is one implementation', () => {
  it('cli-patterns re-exports the browser-safe leaf rather than a copy', () => {
    expect(cliPatterns.findOpencodeV2DialogTitle).toBe(findOpencodeV2DialogTitle);
    expect(cliPatterns.OPENCODE_V2_DIALOG_TITLE_PATTERN).toBe(OPENCODE_V2_DIALOG_TITLE_PATTERN);
  });
});

describe('Issue #2983: the dialogs the model keys open raise the card', () => {
  it.each([
    ['select-model-ctrl-x-m', 'Select model'],
    ['commands-ctrl-p', 'Commands'],
    ['space-bunny-variant-dialog', 'Select variant'],
    ['palette-then-ctrl-x-m', 'Commands'],
    ['model-then-ctrl-p', 'Select model'],
  ])('%s reads as a selection list, with the title %s', (name, title) => {
    const text = frame2983(name);
    const verdict = detector.detect(normalizeFrame(text));
    expect(verdict.status).toBe('waiting');
    expect(verdict.reason).toBe(STATUS_REASON.OPENCODE_MODAL_OVERLAY);
    expect(SELECTION_LIST_REASONS.has(verdict.reason)).toBe(true);
    expect(findOpencodeV2DialogTitle(stripAnsi(text))).toBe(title);
  });

  it.each(['home', 'variant-default', 'variant-ctrl-t-1', 'home-esc-then-variant'])(
    '%s (no dialog) raises no card and has no title',
    (name) => {
      const text = frame2983(name);
      const verdict = detector.detect(normalizeFrame(text));
      expect(verdict.status).toBe('ready');
      expect(SELECTION_LIST_REASONS.has(verdict.reason)).toBe(false);
      expect(findOpencodeV2DialogTitle(stripAnsi(text))).toBeNull();
    },
  );

  it.each(['permission-required', 'question'])(
    'the #2945 %s frame raises the card but has NO title row (no Escape may reach it)',
    (name) => {
      const text = read('opencode-v2-live-2945', name);
      expect(SELECTION_LIST_REASONS.has(detector.detect(normalizeFrame(text)).reason)).toBe(true);
      expect(findOpencodeV2DialogTitle(stripAnsi(text))).toBeNull();
    },
  );
});

describe('Issue #2983: what the live probe recorded', () => {
  const modelBar = (name: string): string | undefined =>
    frame2983(name)
      .split('\n')
      .find((line) => line.includes('Build · Space Bunny'))
      ?.trim();

  it('ctrl+t cycles the variant from the home screen', () => {
    expect(modelBar('variant-default')).toBe('┃  Build · Space Bunny Free OpenCode Zen');
    expect(modelBar('variant-ctrl-t-1')).toBe('┃  Build · Space Bunny Free OpenCode Zen · low');
  });

  it('a bare key does not reach through an open dialog', () => {
    // ctrl+p / ctrl+t inside `Select model`, ctrl+t inside `Commands`: the dialog stays.
    expect(findOpencodeV2DialogTitle(frame2983('model-then-ctrl-p'))).toBe('Select model');
    expect(findOpencodeV2DialogTitle(frame2983('model-then-ctrl-t'))).toBe('Select model');
    expect(findOpencodeV2DialogTitle(frame2983('palette-then-ctrl-t'))).toBe('Commands');
    // ctrl+x m inside `Commands` types `m` into the palette's filter.
    expect(frame2983('palette-then-ctrl-x-m')).toMatch(/^\s+m$/m);
  });

  it('Escape first lets each key do what it says from inside a dialog', () => {
    expect(findOpencodeV2DialogTitle(frame2983('palette-esc-then-models'))).toBe('Select model');
    expect(findOpencodeV2DialogTitle(frame2983('models-esc-then-commands'))).toBe('Commands');
    expect(findOpencodeV2DialogTitle(frame2983('models-esc-then-variant'))).toBeNull();
    expect(modelBar('models-esc-then-variant')).toBe('┃  Build · Space Bunny Free OpenCode Zen · high');
    expect(modelBar('home-esc-then-variant')).toBe('┃  Build · Space Bunny Free OpenCode Zen · xhigh');
  });
});

describe('Issue #2983: controls written outside the repository', () => {
  let tmp: string | null = null;
  afterEach(() => {
    if (tmp !== null) fs.rmSync(tmp, { recursive: true, force: true });
    tmp = null;
  });

  const readVia = (name: string, text: string): string | null => {
    tmp = tmp ?? fs.mkdtempSync(path.join(os.tmpdir(), 'ocv2-2983-'));
    const file = path.join(tmp, name);
    fs.writeFileSync(file, text, 'utf-8');
    return findOpencodeV2DialogTitle(stripAnsi(fs.readFileSync(file, 'utf-8')));
  };

  it('positive: the captured model picker, copied byte for byte, is found', () => {
    expect(readVia('model.txt', frame2983('select-model-ctrl-x-m'))).toBe('Select model');
  });

  it('negative: the same frame with the title row removed is not', () => {
    const noTitle = frame2983('select-model-ctrl-x-m').replace(/^\s+Select model\s+esc$/m, '');
    expect(readVia('model-no-title.txt', noTitle)).toBeNull();
  });
});
