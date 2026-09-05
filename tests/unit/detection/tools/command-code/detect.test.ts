/**
 * Issue #2250 — the Command Code status detector, against its own live frames.
 *
 * The three states Phase A has to publish correctly, because everything else
 * reads them: `ready` closes the send guard and lets `wait` return, `running`
 * keeps it open, and `waiting` + `hasActivePrompt` is what renders the
 * PromptPanel and what Auto-Yes answers.
 *
 * @vitest-environment node
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { getToolStatusDetector } from '@/lib/detection/tools/registry';
import { normalizeFrame } from '@/lib/detection/tools/frame';
import { stripAnsi } from '@/lib/detection/cli-patterns';
import { STATUS_REASON } from '@/lib/detection/status-detector';
import { COMMAND_CODE_VERIFIED_AGAINST } from '@/lib/detection/tools/verified-against';
import { commandCodeStatusDetector } from '@/lib/detection/tools/command-code/detect';
import type { MultipleChoicePromptData } from '@/types/models';

const DIR = path.resolve(__dirname, '../../../../fixtures/command-code-live-2250');
const frame = (name: string): string => fs.readFileSync(path.join(DIR, `${name}.txt`), 'utf-8');

const detector = getToolStatusDetector('command-code');
const verdict = (name: string) => detector.detect(normalizeFrame(frame(name)));

describe('Issue #2250: the registry resolves Command Code to its own module', () => {
  it('is the module, and it records what it was measured against', () => {
    expect(detector).toBe(commandCodeStatusDetector);
    expect(detector.tool).toBe('command-code');
    expect(detector.verifiedAgainst).toBe(COMMAND_CODE_VERIFIED_AGAINST);
    expect(detector.verifiedAgainst.version).toBe('1.40.1');
    expect(detector.verifiedAgainst.paneGeometry).toBe('200x1000');
  });

  it('declares no measured dialog rules, so Auto-Yes keeps the legacy path', () => {
    // Epic #2249 決定 3: Command Code fires `PreToolUse` AFTER its permission
    // dialog is answered, so a hook-driven decision cannot dismiss the dialog
    // and there is nothing for a `detectDialog` rule to gate on yet.
    expect(detector.hasDialogRules).toBe(false);
    expect(detector.detectDialog(normalizeFrame(frame('dialog-create-file')))).toBeNull();
  });
});

describe('Issue #2250: idle', () => {
  it('reads the launch screen as ready', () => {
    const v = verdict('boot-idle');
    expect(v.status).toBe('ready');
    expect(v.reason).toBe(STATUS_REASON.INPUT_PROMPT);
    expect(v.hasActivePrompt).toBe(false);
  });

  it('reads a finished turn as ready', () => {
    for (const name of ['turn-version', 'turn-tool-write'] as const) {
      const v = verdict(name);
      expect(v.status, name).toBe('ready');
      expect(v.reason, name).toBe(STATUS_REASON.INPUT_PROMPT);
      expect(v.hasActivePrompt, name).toBe(false);
    }
  });
});

describe('Issue #2250: running', () => {
  it('reads a turn in flight as running even though the composer is drawn', () => {
    // This is why the module exists. Command Code keeps `❯ Ask your question...`
    // on screen for the whole turn, so the shared composer check at step 3 would
    // publish `ready` for a pane that is still generating.
    // Read through `stripAnsi`: the placeholder's first character carries the
    // cursor's reverse-video SGR, so the raw row spells it `❯ <ESC>[7mA<ESC>[0m…sk
    // your question...` and holds no contiguous copy of the string.
    expect(stripAnsi(frame('turn-thinking'))).toContain('❯ Ask your question...');

    const v = verdict('turn-thinking');
    expect(v.status).toBe('running');
    expect(v.reason).toBe(STATUS_REASON.THINKING_INDICATOR);
    expect(v.hasActivePrompt).toBe(false);
  });
});

describe('Issue #2250: waiting', () => {
  it.each(['dialog-create-file', 'dialog-shell-command'] as const)(
    'reads the %s permission dialog as waiting with an active prompt',
    (name) => {
      const v = verdict(name);
      expect(v.status).toBe('waiting');
      expect(v.reason).toBe(STATUS_REASON.PROMPT_DETECTED);
      expect(v.hasActivePrompt).toBe(true);
    },
  );

  it('reads the file-permission dialog as a three-option multiple choice defaulting to 1', () => {
    const data = verdict('dialog-create-file').promptDetection?.promptData;
    expect(data?.type).toBe('multiple_choice');

    const options = (data as MultipleChoicePromptData).options;
    expect(options.map((o) => o.number)).toEqual([1, 2, 3]);
    expect(options.map((o) => o.label)).toEqual([
      'Yes',
      'Yes, allow all edits this session [shift+tab]',
      'No, tell Command Code what to do differently',
    ]);
    // `❯` marks the highlighted option and typing `1` confirms it immediately
    // (measured live: a bare `1` with no Enter dismissed the dialog).
    expect(options.filter((o) => o.isDefault).map((o) => o.number)).toEqual([1]);
  });

  it('reads the shell-permission dialog, whose second option is worded differently', () => {
    const data = verdict('dialog-shell-command').promptDetection?.promptData;
    expect(data?.type).toBe('multiple_choice');

    const options = (data as MultipleChoicePromptData).options;
    expect(options.map((o) => o.number)).toEqual([1, 2, 3]);
    expect(options[1].label).toContain("don't ask again for `sleep` commands");
    expect(options.filter((o) => o.isDefault).map((o) => o.number)).toEqual([1]);
  });

  it('does not need a buildDetectPromptOptions entry to read either dialog', () => {
    // Command Code marks its default with `❯`, which is one of
    // DEFAULT_OPTION_PATTERN's own cursor glyphs, so the DEFAULT
    // `requireDefaultIndicator: true` already passes Pass 1. agy needed the
    // override because it highlights with an ASCII `>` (#999); Command Code does
    // not, and adding an override it does not need would loosen the gate for no
    // measured reason.
    expect(verdict('dialog-create-file').promptDetection?.isPrompt).toBe(true);
  });
});
