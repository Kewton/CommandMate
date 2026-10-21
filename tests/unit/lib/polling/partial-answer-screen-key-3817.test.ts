/** @vitest-environment node */

/**
 * Issue #3817 (事象 2): the memory of an Auto-Yes answer stopped part-way
 * (`partialAnswerScreenKey`, #3706) tells apart two approvals whose command
 * bodies differ only by indentation or a `>`, and still reads a moved cursor
 * as the same screen.
 *
 * The key used to strip the leading marks and indentation of every row of
 * `approvalTarget`, the body included. Now only the rows the shared block
 * reader adopted as the options are aligned — the same reading #3812 gives the
 * strict respond (`approvalTargetWithoutHighlight`).
 *
 * Prompts are read through the poller's pipeline:
 * stripBoxDrawing(stripAnsi(pane)) → detectPrompt(buildDetectPromptOptions(tool)).
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { describe, it, expect, beforeEach } from 'vitest';
import { detectPrompt, resetDetectPromptCache } from '@/lib/detection/prompt-detector';
import { buildDetectPromptOptions, stripAnsi, stripBoxDrawing } from '@/lib/detection/cli-patterns';
import { partialAnswerScreenKey } from '@/lib/polling/auto-yes-poller-state';
import type { PromptData } from '@/types/models';

const RULE = '─'.repeat(60);

function promptOf(tool: 'claude' | 'codex' | 'gemini', pane: string): PromptData {
  resetDetectPromptCache();
  const detection = detectPrompt(stripBoxDrawing(stripAnsi(pane)), buildDetectPromptOptions(tool));
  expect(detection.isPrompt).toBe(true);
  return detection.promptData!;
}

/** claude's Bash permission with `command` as its body and the cursor on `cursorAt`. */
function claudeBash(command: readonly string[], cursorAt = 1): string {
  const option = (n: number, label: string): string => `${n === cursorAt ? ' ❯' : '  '} ${n}. ${label}`;
  return [
    '⏺ Writing the notes.',
    RULE,
    ' Bash command',
    '',
    ...command,
    // Enough description rows to keep the body out of `question`'s 5-row window.
    '   Write the notes file',
    '   from the template',
    '   into the repository root',
    '   without staging it',
    '',
    ' Do you want to proceed?',
    option(1, 'Yes'),
    option(2, "Yes, and don't ask again for cat commands in /repo"),
    option(3, 'No'),
    '',
    ' Esc to cancel · Tab to amend',
  ].join('\n');
}

const QUOTED = ["   cat <<'EOF' > notes.md", '   > rm -rf build', '   EOF'];
const UNQUOTED = ["   cat <<'EOF' > notes.md", '   rm -rf build', '   EOF'];
const INDENTED = ["   cat <<'EOF' > notes.md", '       rm -rf build', '   EOF'];

describe('Issue #3817: partialAnswerScreenKey reads the body as it is', () => {
  beforeEach(() => {
    resetDetectPromptCache();
  });

  it('two approvals whose bodies differ only by a `>` are different screens', () => {
    const quoted = promptOf('claude', claudeBash(QUOTED));
    const unquoted = promptOf('claude', claudeBash(UNQUOTED));
    // Fixture guard: the question and the options are the same words.
    expect(quoted.question).toBe(unquoted.question);
    expect(quoted.options).toEqual(unquoted.options);

    expect(partialAnswerScreenKey(quoted)).not.toBe(partialAnswerScreenKey(unquoted));
  });

  it('two approvals whose bodies differ only by indentation are different screens', () => {
    expect(partialAnswerScreenKey(promptOf('claude', claudeBash(INDENTED)))).not.toBe(
      partialAnswerScreenKey(promptOf('claude', claudeBash(UNQUOTED))),
    );
  });

  it('negative: the same approval with only its cursor moved is the same screen', () => {
    const before = promptOf('claude', claudeBash(QUOTED, 1));
    for (const cursorAt of [2, 3]) {
      const after = promptOf('claude', claudeBash(QUOTED, cursorAt));
      // Fixture guard: the cursor row really did move inside approvalTarget.
      expect(after.approvalTarget).not.toBe(before.approvalTarget);
      expect(partialAnswerScreenKey(after)).toBe(partialAnswerScreenKey(before));
    }
  });

  it('negative: a moved cursor on a list with no body is the same screen (gemini, #3706)', () => {
    expect(partialAnswerScreenKey(promptOf('gemini', 'Select an option:\n❯ 1. Yes\n  2. No'))).toBe(
      partialAnswerScreenKey(promptOf('gemini', 'Select an option:\n  1. Yes\n❯ 2. No')),
    );
  });

  it('a different command under the same question is still a different screen', () => {
    expect(partialAnswerScreenKey(promptOf('claude', claudeBash(['   touch a.txt'])))).not.toBe(
      partialAnswerScreenKey(promptOf('claude', claudeBash(['   touch b.txt']))),
    );
  });

  /** A live codex-cli 0.146.0 approval (`codex-live-1628`), its `›` moved from option 1 to option 2. */
  it('negative: a live codex approval with only its cursor moved is the same screen', () => {
    const live = readFileSync(
      fileURLToPath(
        new URL('../detection/fixtures/codex-live-1628/approval-run-command.txt', import.meta.url),
      ),
      'utf8',
    );
    const rows = live.split('\n');
    const first = rows.findIndex(row => row.includes('1. Yes, proceed (y)'));
    const second = rows.findIndex(row => row.startsWith('  2. Yes, and'));
    expect(first).toBeGreaterThan(0);
    expect(second).toBe(first + 1);
    const moved = [...rows];
    moved[first] = `  ${stripAnsi(rows[first]).replace(/^›\s*/, '')}`;
    moved[second] = rows[second].replace(/^  /, '› ');

    const before = promptOf('codex', live);
    const after = promptOf('codex', moved.join('\n'));
    expect(after.approvalTarget).not.toBe(before.approvalTarget);
    expect(partialAnswerScreenKey(after)).toBe(partialAnswerScreenKey(before));
  });
});
