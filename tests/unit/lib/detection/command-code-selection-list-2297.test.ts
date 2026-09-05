/**
 * Command Code's picker, which nothing read before Issue #2297.
 *
 * Issue #2297's plan assumed Command Code's `/model` was claude's — "claude 同型
 * なら同じ `s` 欠落" — and said to measure it before wiring anything. It was
 * measured, live, on v1.40.1 at the production 200x1000 geometry, and it is not
 * claude's:
 *
 *     Select model
 *     Switch between the available models. Sets the default for new sessions; …
 *     › Type to search models...
 *     Command Code
 *     DeepSeek V4 Pro (latest)              hybrid-attention long-context reasoning
 *     …
 *     type to search · ↑/↓ navigate · shift+↑/↓ jump provider · enter to select · esc to cancel
 *
 * No option numbers, no session scope, and a focused search box. What matters
 * more than any of that is what CommandMate did with it: **no detector branch
 * matched**, so the frame reached the `default` floor, which
 * `isUnclassifiedFrame` publishes as `isUnclassifiedActive` — and the chat
 * surface answers THAT with `PromptAnswerKeys`, the fixed `1`–`9` / `y` / `n`
 * pad. Every one of those characters would have been typed into the search box.
 *
 * So the fix is a detection fix and not only a UI one, and the property pinned
 * here is the one the user feels: this frame is a SELECTION LIST, so the card
 * offers the arrow pad rather than a row of characters.
 *
 * @vitest-environment node
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

import {
  SELECTION_LIST_REASONS,
  STATUS_REASON,
  detectSessionStatus,
} from '@/lib/detection/status-detector';
import { isUnclassifiedFrame } from '@/lib/session/status-evidence';

const CARD_DIR = path.resolve(__dirname, '../../../fixtures/chat-dialog-card-2254');
const LIVE_DIR = path.resolve(__dirname, '../../../fixtures/command-code-live-2250');

const frame = (dir: string, name: string): string =>
  fs.readFileSync(path.join(dir, name), 'utf-8');

const MODEL_PICKER = frame(CARD_DIR, 'command-code-model-1-40-1.txt');

describe('[#2297] the Command Code model picker is read as a selection list', () => {
  const result = detectSessionStatus(MODEL_PICKER, 'command-code');

  it('answers its own reason rather than claude’s', () => {
    // Command Code renders claude's TUI, but this footer is its own sentence and
    // claude's rule does not match it. Reporting `claude_selection_list` would
    // point an operator reading `capture --json` at a rule that never fired.
    expect(result.reason).toBe(STATUS_REASON.COMMAND_CODE_SELECTION_LIST);
    expect(result.status).toBe('waiting');
    expect(result.evidence).toBe('positive');
  });

  it('is in SELECTION_LIST_REASONS, which is what puts the arrow pad on the card', () => {
    expect(SELECTION_LIST_REASONS.has(result.reason)).toBe(true);
  });

  it('is no longer the unclassified floor — the bug this branch closes', () => {
    // Red before the branch existed: `default` is one of the three reasons
    // `isUnclassifiedFrame` accepts, and the chat surface renders that state
    // with the 1-9 / y / n keys, into a search box.
    expect(isUnclassifiedFrame(result.status, result.reason)).toBe(false);
    expect(result.reason).not.toBe(STATUS_REASON.DEFAULT);
  });

  it('does not claim an answerable prompt — there is no numbered list to answer', () => {
    // `hasActivePrompt` is what `respond <id> N` and Auto-Yes key off. This
    // picker has no numbers at all, so claiming one would invite a number that
    // lands in the filter.
    expect(result.hasActivePrompt).toBe(false);
  });
});

describe('[#2297] the branch does not disturb the frames #2250 already reads', () => {
  it.each<[string, string]>([
    ['boot-idle.txt', STATUS_REASON.INPUT_PROMPT],
    ['turn-thinking.txt', STATUS_REASON.THINKING_INDICATOR],
  ])('%s still answers %s', (name, reason) => {
    expect(detectSessionStatus(frame(LIVE_DIR, name), 'command-code').reason).toBe(reason);
  });

  it('still reads the file-permission dialog as an answerable numbered prompt', () => {
    // The negative control that matters: the new branch runs in `afterPrompt`,
    // i.e. AFTER `detectPrompt`, so a real dialog must still win. A branch
    // placed earlier would swallow this one.
    const result = detectSessionStatus(frame(LIVE_DIR, 'dialog-create-file.txt'), 'command-code');

    expect(result.hasActivePrompt).toBe(true);
    expect(SELECTION_LIST_REASONS.has(result.reason)).toBe(false);
  });
});

describe('[#2297] the picker is not mistaken for another tool’s screen', () => {
  it('is not read as a selection list for a tool whose rules it is not', () => {
    // The footer pattern lives in the Command Code detector alone. Handing the
    // same bytes to claude must not produce a selection-list verdict, or the
    // pattern has leaked into the shared chain.
    expect(detectSessionStatus(MODEL_PICKER, 'claude').reason).not.toBe(
      STATUS_REASON.COMMAND_CODE_SELECTION_LIST,
    );
  });

  it('does not fire on claude’s own /model overlay', () => {
    // `Enter to set as default · s to use this session only · Esc to cancel` is
    // a different sentence and must stay claude's.
    const claudeModel = frame(CARD_DIR, 'claude-model-2-1-259.txt');

    expect(detectSessionStatus(claudeModel, 'command-code').reason).not.toBe(
      STATUS_REASON.COMMAND_CODE_SELECTION_LIST,
    );
  });
});
