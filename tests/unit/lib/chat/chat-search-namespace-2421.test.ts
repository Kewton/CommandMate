/**
 * Issue #2421: the chat transcript's per-split search highlights, at 4 splits.
 *
 * `makeChatSearchNamespace(i)` happily returns a name for any index — the bound
 * on the split count lives in `src/app/globals.css`, because `::highlight()`
 * rules cannot be created at runtime. The rules stopped at `-2` while
 * MAX_SPLITS was 3; raising the ceiling to 4 without extending them would leave
 * the 4th split as the one where chat search matches, counts and scrolls but
 * paints nothing at all — a failure that logs nothing and throws nothing.
 *
 * Mirrors the History-side assertions in tests/unit/lib/terminal-highlight.test.ts
 * (#744's half of the same contract).
 *
 * @vitest-environment node
 */

import { readFileSync } from 'fs';
import path from 'path';
import { describe, it, expect } from 'vitest';
import { MAX_SPLITS } from '@/config/terminal-split-config';
import {
  CHAT_SEARCH_NAMESPACE,
  makeChatSearchNamespace,
  resolveChatSearchNamespace,
} from '@/lib/chat/chat-search-namespace';

const css = readFileSync(path.join(process.cwd(), 'src/app/globals.css'), 'utf8');

/** The declaration block that follows a comma-grouped selector's LAST selector. */
function declarationsFor(selector: string): string {
  const at = css.indexOf(selector);
  expect(at, `${selector} is not declared at all`).toBeGreaterThanOrEqual(0);
  const block = css.slice(at);
  return block.slice(block.indexOf('{'), block.indexOf('}'));
}

describe('[#2421] chat search highlight rules cover every split', () => {
  it('declares a rule for every split index makeChatSearchNamespace can produce', () => {
    for (let i = 0; i < MAX_SPLITS; i++) {
      const ns = makeChatSearchNamespace(i);
      expect(ns.highlightName).toBe(`chat-search-${i}`);
      expect(ns.currentHighlightName).toBe(`chat-search-current-${i}`);
      expect(css, `missing ::highlight(${ns.highlightName})`).toContain(
        `::highlight(${ns.highlightName})`,
      );
      expect(css, `missing ::highlight(${ns.currentHighlightName})`).toContain(
        `::highlight(${ns.currentHighlightName})`,
      );
    }
  });

  it('paints each of them (a declared rule with no background is the same bug)', () => {
    for (let i = 0; i < MAX_SPLITS; i++) {
      const ns = makeChatSearchNamespace(i);
      for (const name of [ns.highlightName, ns.currentHighlightName]) {
        expect(
          declarationsFor(`::highlight(${name})`),
          `::highlight(${name}) paints nothing`,
        ).toContain('background-color:');
      }
    }
  });

  it('still declares the single-surface (phone) namespace', () => {
    expect(css).toContain(`::highlight(${CHAT_SEARCH_NAMESPACE.highlightName})`);
    expect(css).toContain(`::highlight(${CHAT_SEARCH_NAMESPACE.currentHighlightName})`);
  });

  // Negative control: without it, "contains `chat-search-3`" would also be
  // satisfied by a rule list that simply enumerated every conceivable suffix,
  // and the assertions above would not be reading the ceiling at all.
  it('does not declare a rule beyond the ceiling', () => {
    expect(css).not.toContain(`::highlight(chat-search-${MAX_SPLITS})`);
    expect(css).not.toContain(`::highlight(chat-search-current-${MAX_SPLITS})`);
  });

  it('resolveChatSearchNamespace still routes the last split to its own name', () => {
    const last = MAX_SPLITS - 1;
    expect(resolveChatSearchNamespace(last).highlightName).toBe(`chat-search-${last}`);
    expect(resolveChatSearchNamespace(undefined)).toEqual(CHAT_SEARCH_NAMESPACE);
  });
});
