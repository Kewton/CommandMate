/**
 * A saved `AskUserQuestion` set, as the chat surface receives it (Issue #2460).
 *
 * SYNTHETIC, and deliberately so — see `README.md` beside this file for what was
 * measured and what was rebuilt. The three rows reproduce the reported defect
 * without publishing the private worktree they were observed on: two question
 * screens and the set's submit confirmation, in one pane, at
 * 21:48:04.000 / 21:48:06.000 / 21:48:11.000 (+09:00).
 *
 * The clock matters more than usual here. `21:48:06 → 21:48:11` is exactly
 * {@link TOOL_APPROVAL_MERGE_WINDOW_MS}, so this fixture is what pins the
 * inclusive edge of the window: a fold that used `<` would leave the reported
 * row uncounted and every other assertion in the suite would still pass.
 */

import type { ChatMessage } from '@/types/models';
import raw from './question-set-messages.json';

/** A row as the API serializes it: `timestamp` is an ISO string, not a `Date`. */
type RawMessage = Omit<ChatMessage, 'timestamp'> & { timestamp: string };

/**
 * The three rows, hydrated the way the chat surface receives them.
 *
 * A function rather than a constant: every caller gets its own `Date` objects
 * and its own `promptData`, so a test that edits a row (a different scope, a
 * later timestamp) cannot reach the next test.
 */
export function questionSetMessages(): ChatMessage[] {
  return (raw as unknown as RawMessage[]).map((row) => ({
    ...row,
    timestamp: new Date(row.timestamp),
    promptData: JSON.parse(JSON.stringify(row.promptData)) as ChatMessage['promptData'],
  }));
}

/** The rows by name, so a test never indexes into the array by number. */
export const QUESTION_SET_IDS = {
  first: '2460-q1',
  second: '2460-q2',
  confirmation: '2460-confirm',
} as const;

/** The measured clock, to the millisecond. */
export const QUESTION_SET_TIMESTAMPS = {
  first: '2026-09-10T21:48:04.000+09:00',
  second: '2026-09-10T21:48:06.000+09:00',
  confirmation: '2026-09-10T21:48:11.000+09:00',
} as const;

/**
 * What each question asks once the picker's tab bar is off it.
 *
 * The first one is 179 characters — longer than
 * {@link TOOL_APPROVAL_LABEL_MAX_CHARS} — which is what makes it able to catch
 * an identity built from the ELIDED label: its first 160 characters are shared
 * with the variant `chat-tool-approvals-2460.test.ts` derives from it.
 */
export const QUESTION_TEXTS = {
  first:
    'この Issue の核心は「スケジュールが実行されても実際には何も書き込めていなかった」ことです。' +
    'UAT では commandmate schedule の作成から実行、ログとファイル書き込みの確認までを一続きで見たいのですが、' +
    '今回はどこまで実行しますか？対象は develop の worktree だけで構いません。所要時間は 15 分を想定しています。',
  second: 'UAT サーバーをどこで起動しますか？',
} as const;

/** The picker chrome that must not survive into a chip label. */
export const QUESTION_SET_TAB_ROWS = {
  first: '←  ☐ 実行範囲  ☐ 起動場所  ✔ Submit  →',
  second: '←  ☒ 実行範囲  ☐ 起動場所  ✔ Submit  →',
  confirmation: '←  ☒ 実行範囲  ☒ 起動場所  ✔ Submit  →',
} as const;

/**
 * The unrelated shell fragment the confirmation row carries.
 *
 * It is in `content` and in `instructionText`, exactly as the measured row had
 * it: both fields hold whatever was on the pane, which is why neither may be
 * read as a label fallback.
 */
export const UNRELATED_SHELL_FRAGMENT = '=== commandcode インストール状況 ===';
