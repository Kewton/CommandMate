/**
 * Rendering an agent-authored reply as Markdown (Issue #2041).
 *
 * Two rows now live in `chat_messages`: a scrape of a terminal, and the agent's
 * own Markdown source. Only the second may be parsed, and the risk this file
 * exists for is the first one being parsed by accident — a captured pane is
 * full of `#`, `*`, `-` and box drawing, so Markdown-rendering it would rewrite
 * text that has always been shown verbatim.
 *
 * @vitest-environment jsdom
 */

import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ConversationPairCard } from '@/components/worktree/ConversationPairCard';
import { opencodeTurnRequestId } from '@/types/agent-transcript';
import type { ConversationPair } from '@/types/conversation';
import type { ChatMessage } from '@/types/models';

function message(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'msg-1',
    worktreeId: 'wt-1',
    role: 'assistant',
    content: 'body',
    timestamp: new Date('2026-08-25T10:00:00'),
    messageType: 'normal',
    archived: false,
    ...overrides,
  };
}

/** A pair whose single assistant reply is `content`. */
function pairWith(content: string, requestId?: string): ConversationPair {
  return {
    id: 'pair-1',
    userMessage: message({ id: 'user-1', role: 'user', content: 'go' }),
    assistantMessages: [message({ id: 'asst-1', role: 'assistant', content, requestId })],
    status: 'completed',
  };
}

const props = {
  onFilePathClick: vi.fn(),
  isExpanded: true,
};

/** The Markdown body opencode produced in the measured turn 1. */
const MEASURED = '## Heading A\n\n- item one\n- item two\n\n**bold** and `code`';
const STRUCTURED_ID = opencodeTurnRequestId('msg_user0000000000000000001');

describe('a row written by the opencode history writer', () => {
  it('renders its Markdown', () => {
    render(<ConversationPairCard {...props} pair={pairWith(MEASURED, STRUCTURED_ID)} />);

    expect(screen.getByRole('heading', { level: 2, name: 'Heading A' })).toBeInTheDocument();
    expect(screen.getAllByRole('listitem').map((node) => node.textContent)).toEqual([
      'item one',
      'item two',
    ]);
    // The literal syntax is gone, which is the whole point.
    expect(screen.queryByText(/## Heading A/)).not.toBeInTheDocument();
  });

  it('renders a table, which needs GFM rather than plain CommonMark', () => {
    const table = '| a | b |\n| --- | --- |\n| 1 | 2 |';
    render(<ConversationPairCard {...props} pair={pairWith(table, STRUCTURED_ID)} />);
    expect(screen.getByRole('table')).toBeInTheDocument();
  });

  it('keeps file paths clickable inside the rendered Markdown', () => {
    // The affordance that existed before this Issue. Losing it silently would be
    // a regression paid for by a feature nobody asked to trade it against.
    const onFilePathClick = vi.fn();
    render(
      <ConversationPairCard
        {...props}
        onFilePathClick={onFilePathClick}
        pair={pairWith('See /src/lib/foo.ts for the change.', STRUCTURED_ID)}
      />
    );

    // Queried by its text, not its accessible name: the `aria-label` is an
    // i18n key that the test harness stubs.
    const button = screen.getByText('/src/lib/foo.ts');
    expect(button.tagName).toBe('BUTTON');
    button.click();
    expect(onFilePathClick).toHaveBeenCalledWith('/src/lib/foo.ts');
  });

  it('renders reasoning as a blockquote rather than dropping it', () => {
    render(
      <ConversationPairCard
        {...props}
        pair={pairWith('> **Thinking**\n>\n> weighing it up\n\nThe answer.', STRUCTURED_ID)}
      />
    );
    expect(document.querySelector('blockquote')).not.toBeNull();
    expect(screen.getByText('weighing it up')).toBeInTheDocument();
  });

  it('does not execute HTML the agent emitted', () => {
    // No `rehype-raw`, and `rehype-sanitize` behind it. An agent that quotes an
    // attack string in prose must not have it become a node.
    render(
      <ConversationPairCard
        {...props}
        pair={pairWith('<img src=x onerror="alert(1)"> and <script>alert(2)</script>', STRUCTURED_ID)}
      />
    );
    expect(document.querySelector('img')).toBeNull();
    expect(document.querySelector('script')).toBeNull();
  });

  it('shows the whole body when collapsed, clamped rather than cut', () => {
    // A Markdown string cut at 100 characters is routinely cut inside a token,
    // so the collapse clamps height instead. The body has to be complete for
    // that to be true.
    const { container } = render(
      <ConversationPairCard {...props} isExpanded={false} pair={pairWith(MEASURED, STRUCTURED_ID)} />
    );
    const body = container.querySelector('[data-markdown="true"]');
    expect(body).not.toBeNull();
    expect(body?.className).toContain('overflow-y-hidden');
    // Both list items are present even though only the first would survive a
    // two-line string truncation.
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
  });
});

describe('a row scraped off a terminal', () => {
  it('is shown verbatim, with no Markdown parsing at all', () => {
    // This is the regression guard. `# ` here is a captured shell prompt, not a
    // heading, and `- ` is what the TUI drew.
    const scraped = '# claude output\n- drawn by the TUI\n**not bold**';
    render(<ConversationPairCard {...props} pair={pairWith(scraped)} />);

    expect(screen.queryByRole('heading')).not.toBeInTheDocument();
    expect(screen.queryByRole('listitem')).not.toBeInTheDocument();
    expect(screen.getByText(/\*\*not bold\*\*/)).toBeInTheDocument();
  });

  it('is still truncated as a string when collapsed', () => {
    const long = Array.from({ length: 10 }, (_, i) => `line ${i}`).join('\n');
    const { container } = render(
      <ConversationPairCard {...props} isExpanded={false} pair={pairWith(long)} />
    );
    expect(container.querySelector('[data-markdown="true"]')).toBeNull();
    expect(screen.queryByText(/line 9/)).not.toBeInTheDocument();
  });

  it('is not upgraded by a claude request id that happens to be set', () => {
    // `request_id` has one pre-existing producer (`parseClaudeOutput`), and its
    // values must never be mistaken for the structured-history marker.
    render(
      <ConversationPairCard
        {...props}
        pair={pairWith('# not a heading', 'req_01ABCDEFGHIJKLMNOPQRSTUV')}
      />
    );
    expect(screen.queryByRole('heading')).not.toBeInTheDocument();
  });
});
