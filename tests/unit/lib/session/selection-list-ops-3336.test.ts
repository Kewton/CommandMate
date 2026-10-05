/**
 * 番号キーを数える窓は、カードが描くダイアログの範囲（Issue #3336）
 *
 * #2297 の `readSelectionListShape` は、pane の末尾 40 行から番号を数える。カードが描く
 * のは `extractDialogFrameTail(frame, { selectionList: true })` で、opencode のオーバー
 * レイや Command Code のピッカーでは、ダイアログ自身の行だけになる。2 つの窓がずれると、
 * 番号の無いダイアログの上 40 行以内にある番号つきの返答を、ダイアログの選択肢として
 * 数えてしまう。#3305 で番号キーをターミナル面にも出したので、ずれは両方の面に出ていた。
 *
 * 陽性対照: `selection-list-number-window-3336/` の fixture（番号の無い `Select agent` の
 * 下、末尾 40 行以内に `1. Yes` / `2. No` / `3. Cancel`）。直す前は 3 を返していた。
 * 陰性対照: 番号つきのダイアログ（codex の `/model` など）と、コミット済みの fixture すべて
 * — 窓をそろえても、数は直す前と同じ。
 *
 * @vitest-environment node
 */

import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { readSelectionListFrame } from '@/lib/session/selection-list-ops';
import {
  readCommandCodeQuestionRegion,
  readSelectionListShape,
  shouldOfferOptionNumbers,
} from '@/lib/detection/selection-shape';
import { extractOpenCodeModalOverlayFrame } from '@/lib/detection/opencode-modal-overlay';

const FIXTURES = path.resolve(__dirname, '../../../fixtures');
const capture = (rel: string): string => fs.readFileSync(path.join(FIXTURES, rel), 'utf-8');

const NEW_FIXTURE_DIR = 'selection-list-number-window-3336';
/** opencode 1.18.22 の `Select agent` の下に、番号つきの返答を置いたもの（README 参照）。 */
const AGENT_LIST_OVER_NUMBERED_REPLY = capture(
  `${NEW_FIXTURE_DIR}/opencode-agent-list-over-numbered-reply.txt`,
);
/** 元にした実機の画面。 */
const AGENT_LIST = capture('opencode-live-2046/w80/dialog-agent-list.txt');

/** 直す前の `readSelectionListFrame` の番号キーの数（末尾 40 行だけで数える）。 */
function numberKeyCountBefore3336(frame: string): number {
  const shape = readSelectionListShape(frame);
  return shouldOfferOptionNumbers(shape) && readCommandCodeQuestionRegion(frame) === null
    ? shape.optionCount
    : 0;
}

function fixtureFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return fixtureFiles(full);
    return entry.name.endsWith('.txt') ? [full] : [];
  });
}

describe('[#3336] 番号の無いダイアログの上にある番号つきの返答は、数えない', () => {
  it('fixture は、元の画面に返答の 3 行を足しただけ（オーバーレイはそのまま読める）', () => {
    expect(AGENT_LIST_OVER_NUMBERED_REPLY.split('\n')).toHaveLength(AGENT_LIST.split('\n').length);
    expect(extractOpenCodeModalOverlayFrame(AGENT_LIST_OVER_NUMBERED_REPLY)).toBe(
      extractOpenCodeModalOverlayFrame(AGENT_LIST),
    );
    expect(extractOpenCodeModalOverlayFrame(AGENT_LIST_OVER_NUMBERED_REPLY)).not.toBeNull();
  });

  it('陽性対照: 末尾 40 行だけで数えると、返答の 3 つが番号キーになる', () => {
    expect(numberKeyCountBefore3336(AGENT_LIST_OVER_NUMBERED_REPLY)).toBe(3);
  });

  it('カードが描く範囲で数えるので、番号キーは出ない', () => {
    expect(readSelectionListFrame(AGENT_LIST_OVER_NUMBERED_REPLY).numberKeyCount).toBe(0);
  });

  it('元の画面（返答なし）も、番号キーは出ない', () => {
    expect(readSelectionListFrame(AGENT_LIST).numberKeyCount).toBe(0);
  });
});

describe('[#3336] 番号つきのダイアログは、今までどおり', () => {
  it.each([
    ['chat-dialog-card-2254/codex-model-0-151-0.txt'],
    ['chat-dialog-card-2254/codex-trust-0-151-0.txt'],
    ['command-code-askuserquestion-2753/multiselect-answered-tabs.txt'],
  ])('%s: 番号キーが出て、数は直す前と同じ', (rel) => {
    const frame = capture(rel);
    const before = numberKeyCountBefore3336(frame);
    const after = readSelectionListFrame(frame).numberKeyCount;
    expect(after).toBe(before);
    // codex の `/model` は番号つきの 7 件。trust は 2 件。AskUserQuestion は #2521 が
    // 番号を外しているので 0（その判断も変えない）。
    if (rel.startsWith('chat-dialog-card-2254/codex-model')) expect(after).toBe(7);
    if (rel.startsWith('chat-dialog-card-2254/codex-trust')) expect(after).toBeGreaterThan(0);
  });

  it('コミット済みの fixture すべてで、数は直す前と同じ（この Issue の fixture を除く）', () => {
    const changed = fixtureFiles(FIXTURES)
      .filter((file) => !file.includes(`${path.sep}${NEW_FIXTURE_DIR}${path.sep}`))
      .filter((file) => {
        const frame = fs.readFileSync(file, 'utf-8');
        return readSelectionListFrame(frame).numberKeyCount !== numberKeyCountBefore3336(frame);
      })
      .map((file) => path.relative(FIXTURES, file));
    expect(changed).toEqual([]);
  });
});
