/**
 * The body a promote writes, the same for a comment and a document (Issue #4225,
 * design §5.2・§5.5).
 *
 * Every free field (the decision's text, the quote) sits inside its own code fence,
 * so nothing typed by an agent becomes a heading, HTML, a link, an `@` mention or an
 * `#N` reference. A fence is a run of backticks of `max(3, longest run inside + 1)`:
 * three at least (CommonMark), and longer than any run of the content, so the
 * content cannot close it (design ⑥). Invisible code points are shown as
 * `[U+XXXX]` (C's rule), and the whole body is checked against the secret rules.
 *
 * Pure: no database, no `fs`, no clock.
 *
 * @module lib/promote/render
 */

import { createHash } from 'crypto';
import { revealInvisible } from '@/lib/brief/sanitize';
import { findSecretRule } from '@/lib/mem/secret-scan';
import type { PromoteEffect, PromoteQuoteOrigin } from './model';

export const PROMOTE_MARK_PREFIX = '<!-- commandmate-promote:';

export const sha256 = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');

/** The fence for a content: `max(3, longest backtick run + 1)` backticks. */
export function fenceFor(content: string): string {
  let longest = 0;
  for (const run of content.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  return '`'.repeat(Math.max(3, longest + 1));
}

function fenced(content: string): string {
  const fence = fenceFor(content);
  return content.length === 0 ? `${fence}\n${fence}` : `${fence}\n${content}\n${fence}`;
}

/** The mark that names the operation in a comment (design §3.2). */
export function commentMark(operationId: string, itemId: string): string {
  return `${PROMOTE_MARK_PREFIX}op=${operationId}; item=${itemId} -->`;
}

export interface PromoteRenderInput {
  operationId: string;
  itemId: string;
  itemVersion: number;
  branch: string | null;
  effect: PromoteEffect;
  authorInstanceId: string;
  authorCreatedAt: number;
  createdAt: number;
  text: string;
  quote: { text: string; origin: Exclude<PromoteQuoteOrigin, 'none'>; at: number } | null;
}

export type PromoteRenderResult =
  | { ok: true; body: string; bodySha256: string; invisibleReplaced: boolean }
  | { ok: false; code: 'secret_like'; rule: string };

const iso = (epoch: number) => new Date(epoch).toISOString();

export function renderPromoteBody(input: PromoteRenderInput): PromoteRenderResult {
  const text = revealInvisible(input.text);
  const quote = input.quote ? revealInvisible(input.quote.text) : null;
  const invisibleReplaced = text !== input.text || (input.quote !== null && quote !== input.quote.text);
  const effect = input.effect === 'spec' ? '仕様を変える決定・反映待ち' : '記録だけ';
  const lines = [
    commentMark(input.operationId, input.itemId),
    `**CommandMate: 決定の記録**（${effect}）`,
    `- 項目: ${input.itemId} v${input.itemVersion}・ブランチ: ${input.branch ?? '(detached)'}・差分の作成: ${iso(input.createdAt)}（承認は人が画面で行う）`,
    `- 書いたもの: Agent ${input.authorInstanceId}（${iso(input.authorCreatedAt)}）`,
    '',
    '決定（Agent の記録）:',
    fenced(text),
  ];
  if (input.quote && quote !== null) {
    const heading =
      input.quote.origin === 'human'
        ? `人が画面で確かめた引用（${iso(input.quote.at)}）`
        : `Agent が記録した引用（${iso(input.quote.at)}、未確認）`;
    lines.push('', `${heading}:`, fenced(quote));
  }
  const body = lines.join('\n');
  const rule = findSecretRule(body);
  if (rule) return { ok: false, code: 'secret_like', rule };
  return { ok: true, body, bodySha256: sha256(body), invisibleReplaced };
}

/** The fingerprint of the item's fields a diff was made from (design §2.1). */
export function itemFingerprint(item: {
  text: string;
  quote: string | null;
  quoteAt: number | null;
  evidence: string[];
  promoteTo: string | null;
  checkedRulesVersion: number;
}): string {
  return sha256(
    JSON.stringify([item.text, item.quote, item.quoteAt, item.evidence, item.promoteTo, item.checkedRulesVersion])
  );
}
