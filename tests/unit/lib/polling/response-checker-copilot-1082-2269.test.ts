/**
 * What copilot 1.0.82 actually saves as the agent's reply (Issue #2269).
 *
 * The unit under test is the whole read path a poll takes, in the order
 * `checkForResponse` runs it:
 *
 *   captured pane
 *     -> extractCopilotContentLines()   (Layer 2 accumulator source)
 *     -> cleanCopilotResponse()         (what is written to History)
 *
 * plus `extractResponse`, whose `isComplete` decides whether the poll saves at
 * all and whose `response` is the fallback source when the accumulator is empty
 * (`accumulatedContent || result.response` in the copilot branch).
 *
 * Testing the pair together is deliberate. #2269's symptom -- a reply fenced by
 * 150+ `▀` and the `← open sidebar …` footer -- was produced by the two paths
 * agreeing, and the launch-screen leak was produced by them DISAGREEING: the
 * banner guard runs on `extractResponse`'s output while the row that reached
 * History came through the cleaner. A test on either half alone passes while the
 * defect is live.
 *
 * @vitest-environment node
 */

import { afterEach, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { extractResponse } from '@/lib/polling/response-checker';
import { cleanCopilotResponse } from '@/lib/response-cleaner';
import {
  accumulateTuiContent,
  clearTuiAccumulator,
  extractCopilotContentLines,
  getAccumulatedContent,
  initTuiAccumulator,
} from '@/lib/tui-accumulator';

const FIXTURE_DIR = fileURLToPath(
  new URL('../detection/fixtures/copilot-live-2269/', import.meta.url),
);

const FIXTURE_DIR_1080 = fileURLToPath(
  new URL('../detection/fixtures/copilot-live-1885/', import.meta.url),
);

function pane(name: string, dir: string = FIXTURE_DIR): string {
  return readFileSync(`${dir}${name}.txt`, 'utf-8');
}

/**
 * What the poller would write to History for this frame.
 *
 * Mirrors `checkForResponse`'s copilot branch: the accumulator's content when it
 * has any, `extractResponse`'s region when it does not.
 */
function savedContent(name: string, dir: string = FIXTURE_DIR): string {
  const raw = pane(name, dir);
  const accumulated = extractCopilotContentLines(raw).join('\n');
  const extracted = extractResponse(raw, 0, 'copilot');
  if (!extracted?.isComplete) return '';
  return cleanCopilotResponse(accumulated || extracted.response);
}

describe('[#2269] copilot 1.0.82 — what reaches History', () => {
  describe('the reply is the reply and nothing else', () => {
    it('saves a one-word answer as that one word', () => {
      expect(savedContent('turn-complete')).toBe('uat-run1');
      expect(savedContent('turn-complete-oneword')).toBe('13');
    });

    it.each([
      'turn-complete',
      'turn-complete-oneword',
      'turn-tool-rows',
      'turn-tool-badges',
      'turn-shell-block',
    ])('leaves no half-block wall and no status bar in %s', (name) => {
      const saved = savedContent(name);

      expect(saved.startsWith('▀')).toBe(false);
      expect(saved).not.toMatch(/[▀▄]{10,}/);
      expect(saved).not.toContain('open sidebar');
      expect(saved).not.toContain('esc interrupt');
      expect(saved).not.toContain('AIC used');
      expect(saved).not.toContain('GPT-5.6');
    });

    it('drops the badge-marked tool rows and keeps the answer', () => {
      // ` / Search "note.md" 1 file found` and ` MD Read note.md L1:1 …`
      const saved = savedContent('turn-tool-rows');

      expect(saved).toBe('hello-2269');
      expect(saved).not.toContain('Read');
      expect(saved).not.toContain('Search');
    });

    it('drops every measured file-type badge and keeps the prose around them', () => {
      // `TS Read`, `{} Read`, `PY Read` and the badge-less `● Read`, four
      // `/ Search` rows, and two rows of the agent's own text.
      expect(savedContent('turn-tool-badges')).toBe(
        '対象ファイルを確認して内容を読み込みます。\ndone',
      );
    });

    it('still folds the 1.0.80 shell block', () => {
      expect(savedContent('turn-shell-block')).toBe('2269-ok');
    });
  });

  describe('frames that must not be saved at all', () => {
    it('saves nothing from the launch screen', () => {
      // Every row of it: the tab bar, the logo, the split disclaimer
      // (`Copilot v1.0.82 uses AI.` / `Check for mistakes.`), the rotating
      // `● Tip: /…` and its `└ …` detail row.
      expect(savedContent('boot-idle')).toBe('');
    });

    it('saves nothing for a turn whose only output was an ask-user call', () => {
      // A bare ` ❯ a` nudge: copilot thinks for 57s, calls its ask-user tool and
      // leaves `● Asked user What would you like me to help with?` behind. That
      // row is chrome for a turn that produced no answer.
      expect(savedContent('turn-oneword-echo-askuser')).toBe('');
    });

    it('reports a generating turn as incomplete', () => {
      expect(extractResponse(pane('turn-running'), 0, 'copilot')?.isComplete).toBe(false);
    });

    it('still classifies a dialog as a prompt, not a reply', () => {
      // 1.0.80's permission dialog: the 1.0.82 folder-trust frame is measured in
      // the fixture README but not shipped, because a new dialog capture under
      // `fixtures/` is a change to the answerable-dialog list that
      // `tests/unit/polling/auto-yes-dialog-gate.test.ts` pins by equality.
      const result = extractResponse(pane('permission-dialog', FIXTURE_DIR_1080), 0, 'copilot');

      expect(result?.promptDetection?.isPrompt).toBe(true);
    });
  });

  describe('across polls, the way the poller actually accumulates', () => {
    // The single-frame cases above cannot see this: `checkForResponse` calls
    // `accumulateTuiContent` on EVERY tick and reads the merged result, so a
    // chrome row that survives one poll is appended once per tick. #1897's
    // headline symptom was exactly that shape, and the walls are worse -- they
    // sit inside the transcript region, above `contentEnd`, so the structural
    // cut does not reach them and only the skip rule does.
    const KEY = '[#2269] copilot poll sequence';

    afterEach(() => clearTuiAccumulator(KEY));

    it('still saves the one word after the whole turn has been polled', () => {
      initTuiAccumulator(KEY);

      // The real sequence: the launch screen, the turn while it generates, then
      // the finished frame -- and the finished frame polled twice, because the
      // pane goes static and the poller keeps ticking.
      for (const name of ['boot-idle', 'turn-running', 'turn-complete', 'turn-complete']) {
        accumulateTuiContent(KEY, pane(name), 'copilot');
      }

      const accumulated = getAccumulatedContent(KEY);
      expect(accumulated.length).toBeGreaterThan(0);

      const saved = cleanCopilotResponse(accumulated);
      expect(saved).toBe('uat-run1');
    });

    it('does not append the chrome once per tick', () => {
      initTuiAccumulator(KEY);
      for (let tick = 0; tick < 5; tick++) {
        accumulateTuiContent(KEY, pane('turn-tool-rows'), 'copilot');
      }

      const saved = cleanCopilotResponse(getAccumulatedContent(KEY));
      expect(saved).toBe('hello-2269');
    });
  });

  describe('no 1.0.80 regression', () => {
    it('still saves the 1.0.80 reply and still suppresses its launch banner', () => {
      expect(savedContent('boot-idle', FIXTURE_DIR_1080)).toBe('');

      const saved = savedContent('turn-complete', FIXTURE_DIR_1080);
      expect(saved.length).toBeGreaterThan(0);
      expect(saved).not.toContain('esc interrupt');
      expect(saved).not.toContain('open sidebar');
      expect(saved).not.toContain('AIC used');
    });

    it('still keeps a reply that quotes copilot\'s own status vocabulary', () => {
      // The frame #1885 captured to forbid a windowed match on the busy words:
      // copilot was asked to print them and did, as body text.
      const saved = savedContent('status-vocabulary-in-response', FIXTURE_DIR_1080);

      expect(saved).toContain('esc interrupt');
    });
  });
});
