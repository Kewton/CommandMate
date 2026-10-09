/**
 * `chatSearchSections` locates chat's folded sections in the raw text exactly
 * where `splitChatMarkdownBody` takes them from (Issue #3503).
 *
 * @vitest-environment node
 */

import { describe, it, expect } from 'vitest';
import {
  CHAT_SEARCH_SECTION_REASONING,
  CHAT_SEARCH_SECTION_TOOL_LOG,
  chatSearchSections,
} from '@/components/worktree/chat-search-sections';
import { splitChatMarkdownBody } from '@/lib/chat/chat-markdown-body';
import { TURN_TOOL_LOG_LABEL } from '@/lib/hooks/sources/turn-body';

function textOf(content: string, key: string): string {
  const section = chatSearchSections(content).find((s) => s.key === key);
  return (section?.ranges ?? []).map((r) => content.slice(r.start, r.end)).join('');
}

/** The section's raw lines with their quote taken off, blank-line runs ignored. */
function unquoted(raw: string): string[] {
  return raw
    .split('\n')
    .map((l) => l.replace(/^>[ \t]?/, ''))
    .filter((l) => l.trim().length > 0 && !/^\*\*(Thinking|Tool calls)/.test(l));
}

describe('[#3503] chatSearchSections', () => {
  it('a message with no folded section has none', () => {
    expect(chatSearchSections('Just an answer.\n\n```mermaid\ngraph TD\n```')).toEqual([]);
    expect(chatSearchSections('I was Thinking about it.')).toEqual([]);
  });

  it('finds the leading reasoning quote and the trailing tool log', () => {
    const content = [
      '> **Thinking**',
      '>',
      '> ```mermaid',
      '> graph TD',
      '> ```',
      '',
      'The answer, Thinking aside.',
      '',
      '> **Thinking (1)**',
      '> more reasoning',
      '',
      'More answer.',
      '',
      `> **${TURN_TOOL_LOG_LABEL} (1)**`,
      '>',
      '> - `Bash` — ls',
    ].join('\n');
    const split = splitChatMarkdownBody(content);
    expect(unquoted(textOf(content, CHAT_SEARCH_SECTION_REASONING))).toEqual(
      split.reasoning!.split('\n').filter((l) => l.trim().length > 0),
    );
    expect(unquoted(textOf(content, CHAT_SEARCH_SECTION_TOOL_LOG))).toEqual(
      split.toolLog.split('\n').filter((l) => l.trim().length > 0),
    );
    // The answer's lines are in neither section.
    const reasoning = textOf(content, CHAT_SEARCH_SECTION_REASONING);
    expect(reasoning).not.toContain('The answer');
    expect(reasoning).not.toContain('More answer');
  });

  it('leaves a Thinking heading nested inside a larger quote in the answer, as the splitter does', () => {
    const content = ['> an ordinary quote', '> **Thinking**', '> still the same quote', '', 'answer'].join('\n');
    expect(splitChatMarkdownBody(content).reasoning).toBeNull();
    expect(chatSearchSections(content)).toEqual([]);
  });

  it('a legacy leading tool run is a prefix section', () => {
    const content = '- `Bash` — ls\n- `Read` — a.ts\n\nThe answer.';
    const split = splitChatMarkdownBody(content);
    expect(split.toolCalls).toBeGreaterThan(0);
    const [section] = chatSearchSections(content);
    expect(section.key).toBe(CHAT_SEARCH_SECTION_TOOL_LOG);
    expect(content.slice(section.ranges[0].end)).toBe(split.body);
  });
});
