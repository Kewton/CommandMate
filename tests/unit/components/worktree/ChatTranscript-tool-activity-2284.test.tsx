/**
 * The reply is the page, and the tool log is one chip (Issue #2284).
 *
 * ## What was on screen
 *
 * Issue #2232 shipped both halves of the conversation as bubbles: the prompt at
 * `max-w-[85%] sm:max-w-[75%]` on the right, the reply at `max-w-[92%]` in a
 * bordered `bg-surface-2` box on the left. Two capped boxes stacked read as a
 * log rather than as a conversation, and the half being READ is the one that
 * wants the width — a fenced code block, a table and a diff each lose a wrapped
 * line per 8 % of the pane.
 *
 * And the reply was still carrying its own tool log. Since #2234 every one of
 * the five transcript readers ends an agent body with a `> **Tool calls (N)**`
 * blockquote, which `ChatMarkdownBody` drew as a blockquote — so a turn that
 * called twenty tools ran twenty `- \`Bash\` — …` lines under the answer, and
 * the next answer started below all of them. #2245 had already folded the
 * approval dialogs and #2272 the reasoning; the tool log was the last one still
 * spilling.
 *
 * ## What this file pins
 *
 *  1. **the asymmetry.** The assistant body has no cap, no border, no ground and
 *     no `w-fit`; the user bubble keeps every one of them. Both halves are
 *     asserted, because "tidying up" in either direction is a regression;
 *  2. **the fold.** A tool section becomes one chip, its lines are not in the
 *     DOM while it is shut, and a turn that only ran tools is a chip and not an
 *     empty row;
 *  3. **one toggle for three folds.** Tool calls, reasoning and the approval run
 *     all obey the transcript's control, a chip may still be worked by hand, and
 *     the choice survives a remount through localStorage;
 *  4. **the live tail folds too**, and its count follows the body as `version`
 *     advances — a chip that only appeared once a turn settled would be exactly
 *     the settle-time re-typeset #2233 exists to prevent;
 *  5. **search reaches inside a fold.** `content` is searched whole, so a hit
 *     can land in a shut chip; the row opens rather than reporting a match the
 *     reader cannot see;
 *  6. **the labels exist in both dictionaries.** The global next-intl stub
 *     echoes keys back, so every assertion above stays green with the whole
 *     section missing from `locales/` — the last `describe` reads the real files.
 *
 * jsdom performs no layout, so the virtualizer materializes zero rows and
 * #1123's fallback list is what renders here, as in every other transcript
 * suite.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import fs from 'fs';
import path from 'path';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ChatMessage } from '@/types/models';

const copyToClipboardMock = vi.fn(async (_text: string) => {});
vi.mock('@/lib/clipboard-utils', () => ({
  copyToClipboard: (text: string) => copyToClipboardMock(text),
}));

import { ChatTranscript, type ChatTranscriptLiveTurn } from '@/components/worktree/ChatTranscript';
import {
  CHAT_BUBBLE_MAX_WIDTH_USER,
  CHAT_BUBBLE_TESTID,
  CHAT_BUBBLE_WIDTH_ASSISTANT,
  CHAT_THINKING_GROUP_TESTID,
  CHAT_TOOL_APPROVAL_GROUP_TESTID,
  CHAT_TOOL_APPROVAL_TOGGLE_TESTID,
  CHAT_TOOL_LOG_BODY_TESTID,
  CHAT_TOOL_LOG_GROUP_TESTID,
  CHAT_TOOL_LOG_TOGGLE_TESTID,
} from '@/components/worktree/ChatMessageBubble';
import { CHAT_TOOL_ACTIVITY_STORAGE_KEY } from '@/lib/chat/chat-tool-activity';
import {
  separateTurnBody,
  TURN_REASONING_LABEL,
  TURN_TOOL_LOG_LABEL,
} from '@/lib/hooks/sources/turn-body';

const WORKTREE_ID = 'wt-2284';
/** A `requestId` prefix that puts the row on the Markdown path (Issue #2041). */
const MD_REQUEST_ID = 'claude-turn:u-1';

/** The body a claude turn that answered, thought and called two tools stores. */
const TURN_BODY = separateTurnBody([
  { kind: 'prose', text: 'Created `probe.txt` and wrote one line to it.' },
  { kind: 'reasoning', text: 'The write succeeded; now check the content.' },
  { kind: 'tool', text: '- `Bash` — ls' },
  { kind: 'tool', text: '- `apply_patch` — probe.txt' },
]).body;

function msg(
  id: string,
  role: ChatMessage['role'],
  content = `content ${id}`,
  extra: Partial<ChatMessage> = {},
): ChatMessage {
  return {
    id,
    worktreeId: WORKTREE_ID,
    role,
    content,
    timestamp: new Date(Date.UTC(2026, 8, 4, 10, 0, 0)),
    messageType: 'normal',
    archived: false,
    cliToolId: 'claude',
    ...extra,
  };
}

/** An agent-authored assistant row: the only path `splitToolLog` runs on. */
function agentRow(id: string, content: string): ChatMessage {
  return msg(id, 'assistant', content, { requestId: `${MD_REQUEST_ID}${id}` });
}

/**
 * One approval dialog, in the shape #2245 folds.
 *
 * `question` and `timestamp` vary per row on purpose: two rows describing the
 * same dialog within {@link TOOL_APPROVAL_MERGE_WINDOW_MS} are Auto-Yes's
 * duplicate and fold into ONE entry, which is #2245's behaviour and not what
 * this file is measuring.
 */
function approvalRow(id: string, minute = 0): ChatMessage {
  return msg(id, 'assistant', 'the whole pane, 2 KB of it', {
    messageType: 'prompt',
    timestamp: new Date(Date.UTC(2026, 8, 4, 10, minute, 0)),
    promptData: {
      type: 'yes_no',
      question: `Approve ${id}?`,
      status: 'pending',
      options: ['yes', 'no'],
    },
  });
}

function renderTranscript(messages: ChatMessage[], props: Record<string, unknown> = {}) {
  return render(
    <ChatTranscript
      messages={messages}
      worktreeId={WORKTREE_ID}
      cliToolId="claude"
      onFilePathClick={vi.fn()}
      {...props}
    />,
  );
}

function rowFor(messageId: string): HTMLElement {
  const row = document.querySelector<HTMLElement>(`[data-row-message-id="${messageId}"]`);
  expect(row, `row for ${messageId}`).not.toBeNull();
  return row!;
}

/** The box a role's presentation is on — see `CHAT_BUBBLE_TESTID`. */
function bubbleOf(row: HTMLElement): HTMLElement {
  const bubble = row.querySelector<HTMLElement>(`[data-testid="${CHAT_BUBBLE_TESTID}"]`);
  expect(bubble, 'row has a bubble box').not.toBeNull();
  return bubble!;
}

function toolActivityToggle(): HTMLElement {
  return screen.getByTestId('chat-transcript-tool-activity-toggle');
}

beforeEach(() => {
  window.localStorage.clear();
  copyToClipboardMock.mockClear();
});

// ---------------------------------------------------------------------------
// 1. The asymmetry
// ---------------------------------------------------------------------------

describe('[#2284] the reply is the page and the prompt is a bubble', () => {
  it('gives the assistant body the whole row with no box around it', () => {
    renderTranscript([agentRow('a1', 'A reply.')]);
    const bubble = bubbleOf(rowFor('a1'));

    // By literal value, not only against the constant the markup came from: a
    // comparison against its own source stays green when the constant is
    // emptied, which is the mutation this Issue asks to be caught.
    expect(bubble.className).toContain('w-full');
    expect(bubble.className).toContain('max-w-full');
    expect(CHAT_BUBBLE_WIDTH_ASSISTANT).toBe('w-full max-w-full');

    expect(bubble.className).not.toContain('max-w-[92%]');
    expect(bubble.className).not.toContain('max-w-[');
    expect(bubble.className).not.toContain('w-fit');
    expect(bubble.className).not.toContain('border');
    expect(bubble.className).not.toContain('bg-surface-2');
    expect(bubble.className).not.toContain('rounded');
  });

  it('leaves the user bubble capped, boxed and pushed right', () => {
    renderTranscript([msg('u1', 'user', 'A prompt.')]);
    const bubble = bubbleOf(rowFor('u1'));

    expect(bubble.className).toContain('ml-auto');
    expect(bubble.className).toContain('max-w-[85%]');
    expect(bubble.className).toContain('sm:max-w-[75%]');
    expect(bubble.className).toContain('rounded-2xl');
    expect(bubble.className).toContain('border');
    expect(bubble.className).toContain('w-fit');
    expect(CHAT_BUBBLE_MAX_WIDTH_USER).toBe('max-w-[85%] sm:max-w-[75%]');
  });

  it('keeps both halves at the same type size', () => {
    // #2232's rule, unchanged: History renders the answer at `text-xs`, which
    // makes it read as metadata about the question.
    renderTranscript([msg('u1', 'user'), agentRow('a1', 'A reply.')]);

    expect(bubbleOf(rowFor('u1')).className).toContain('text-sm');
    expect(bubbleOf(rowFor('a1')).className).toContain('text-sm');
  });
});

// ---------------------------------------------------------------------------
// 2. The fold
// ---------------------------------------------------------------------------

describe('[#2284] the tool log is one chip', () => {
  it('folds a stored turn body and keeps its lines out of the DOM', () => {
    // Positive control on the fixture: it is `separateTurnBody`'s own output
    // and really does carry the section.
    expect(TURN_BODY).toContain(`> **${TURN_TOOL_LOG_LABEL} (2)**`);

    renderTranscript([agentRow('a1', TURN_BODY)]);
    const row = rowFor('a1');

    const group = within(row).getByTestId(CHAT_TOOL_LOG_GROUP_TESTID);
    expect(group.getAttribute('data-tool-calls')).toBe('2');
    expect(within(row).getByTestId(CHAT_TOOL_LOG_TOGGLE_TESTID)).toHaveAttribute(
      'aria-expanded',
      'false',
    );

    // The answer is what the row opens with, and the calls are nowhere in it.
    expect(row.textContent).toContain('Created');
    expect(row.textContent).not.toContain('apply_patch');
    expect(row.textContent).not.toContain('- `Bash`');
    expect(within(row).queryByTestId(CHAT_TOOL_LOG_BODY_TESTID)).toBeNull();
  });

  it('shows the calls when the chip is opened, and hides them again', () => {
    renderTranscript([agentRow('a1', TURN_BODY)]);
    const row = rowFor('a1');
    const toggle = within(row).getByTestId(CHAT_TOOL_LOG_TOGGLE_TESTID);

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const body = within(row).getByTestId(CHAT_TOOL_LOG_BODY_TESTID);
    expect(body.textContent).toContain('apply_patch');
    expect(body.textContent).toContain('probe.txt');

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(within(row).queryByTestId(CHAT_TOOL_LOG_BODY_TESTID)).toBeNull();
  });

  it('draws a chip and no empty prose for a turn that only ran tools', () => {
    const toolsOnly = separateTurnBody([
      { kind: 'tool', text: '- `Bash` — ls' },
      { kind: 'tool', text: '- `Bash` — pwd' },
    ]).body;

    renderTranscript([agentRow('a1', toolsOnly)]);
    const row = rowFor('a1');

    expect(within(row).getByTestId(CHAT_TOOL_LOG_GROUP_TESTID).getAttribute('data-tool-calls'))
      .toBe('2');
    expect(row.textContent).not.toContain('pwd');
  });

  it('draws no chip for a reply that called nothing', () => {
    renderTranscript([agentRow('a1', 'Just the answer.')]);

    expect(screen.queryByTestId(CHAT_TOOL_LOG_GROUP_TESTID)).toBeNull();
    expect(rowFor('a1').textContent).toContain('Just the answer.');
  });

  it('leaves a terminal scrape alone', () => {
    // No `requestId` means the plain path, where the body is a screen scrape
    // and every character of it — `>` included — is content.
    renderTranscript([msg('a1', 'assistant', TURN_BODY)]);

    expect(screen.queryByTestId(CHAT_TOOL_LOG_GROUP_TESTID)).toBeNull();
    expect(rowFor('a1').textContent).toContain(`**${TURN_TOOL_LOG_LABEL} (2)**`);
  });

  it('hands the copy button the whole body, tool log included', () => {
    // What is folded is not deleted: the reader who copies a reply gets the
    // calls too, exactly as they did before the chip existed.
    renderTranscript([agentRow('a1', TURN_BODY)]);

    fireEvent.click(within(rowFor('a1')).getByTestId('chat-copy-message'));
    expect(copyToClipboardMock).toHaveBeenCalledWith(TURN_BODY);
  });
});

// ---------------------------------------------------------------------------
// 3. One toggle, three folds
// ---------------------------------------------------------------------------

describe('[#2284] one toggle governs every fold on the surface', () => {
  const MESSAGES = [
    agentRow('a1', TURN_BODY),
    approvalRow('p1'),
    agentRow('a2', TURN_BODY),
  ];

  it('starts folded, and opens every chip in the column at once', () => {
    renderTranscript(MESSAGES);

    const shut = screen.getAllByTestId(CHAT_TOOL_LOG_TOGGLE_TESTID);
    expect(shut).toHaveLength(2);
    for (const toggle of shut) expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByTestId(CHAT_TOOL_APPROVAL_TOGGLE_TESTID)).toHaveAttribute(
      'aria-expanded',
      'false',
    );

    fireEvent.click(toolActivityToggle());

    for (const toggle of screen.getAllByTestId(CHAT_TOOL_LOG_TOGGLE_TESTID)) {
      expect(toggle).toHaveAttribute('aria-expanded', 'true');
    }
    // #2272's reasoning chip and #2245's approval run answer to the same
    // control: three folds, one question.
    for (const toggle of screen.getAllByTestId('chat-thinking-toggle')) {
      expect(toggle).toHaveAttribute('aria-expanded', 'true');
    }
    expect(screen.getByTestId(CHAT_TOOL_APPROVAL_TOGGLE_TESTID)).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    expect(screen.getAllByTestId(CHAT_TOOL_LOG_BODY_TESTID)).toHaveLength(2);
  });

  it('closes them all again on a second press', () => {
    renderTranscript(MESSAGES);

    fireEvent.click(toolActivityToggle());
    fireEvent.click(toolActivityToggle());

    for (const toggle of screen.getAllByTestId(CHAT_TOOL_LOG_TOGGLE_TESTID)) {
      expect(toggle).toHaveAttribute('aria-expanded', 'false');
    }
    expect(screen.queryByTestId(CHAT_TOOL_LOG_BODY_TESTID)).toBeNull();
  });

  it('lets one chip be worked by hand without moving the others', () => {
    renderTranscript(MESSAGES);

    const [first, second] = screen.getAllByTestId(CHAT_TOOL_LOG_TOGGLE_TESTID);
    fireEvent.click(first);

    expect(first).toHaveAttribute('aria-expanded', 'true');
    expect(second).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByTestId(CHAT_TOOL_APPROVAL_TOGGLE_TESTID)).toHaveAttribute(
      'aria-expanded',
      'false',
    );
  });

  it('brings a hand-worked chip back into line when the toggle moves', () => {
    renderTranscript(MESSAGES);

    // Open one by hand, then ask for everything: the odd one out must not end
    // up CLOSED because it was already open.
    fireEvent.click(screen.getAllByTestId(CHAT_TOOL_LOG_TOGGLE_TESTID)[0]);
    fireEvent.click(toolActivityToggle());

    for (const toggle of screen.getAllByTestId(CHAT_TOOL_LOG_TOGGLE_TESTID)) {
      expect(toggle).toHaveAttribute('aria-expanded', 'true');
    }
  });

  it('says which way it is pointing', () => {
    renderTranscript(MESSAGES);
    const button = toolActivityToggle();

    expect(button).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByTestId('chat-transcript')).toHaveAttribute('data-tool-activity', 'folded');

    fireEvent.click(button);

    expect(toolActivityToggle()).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('chat-transcript')).toHaveAttribute('data-tool-activity', 'shown');
  });

  it('costs the transcript no height', () => {
    // Issue #2106's vertical budget: every piece of chrome on this surface
    // floats over the scroll region rather than sitting above it.
    renderTranscript(MESSAGES);

    const strip = toolActivityToggle().closest('.absolute');
    expect(strip, 'the toggle floats').not.toBeNull();
    expect(strip!.className).toContain('top-2');
  });

  it('yields the strip to the search bar', () => {
    // The strip is right-anchored with no left edge to grow into; a 28px button
    // beside the bar is what pushes it off a 360px pane. A search hit opens the
    // chips in its own row anyway.
    renderTranscript(MESSAGES);

    fireEvent.click(screen.getByTestId('chat-transcript-search-toggle'));
    expect(screen.queryByTestId('chat-transcript-tool-activity-toggle')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 4. Remembering the choice
// ---------------------------------------------------------------------------

describe('[#2284] the choice survives the mount', () => {
  it('writes the reader’s answer to localStorage', () => {
    renderTranscript([agentRow('a1', TURN_BODY)]);

    fireEvent.click(toolActivityToggle());
    expect(window.localStorage.getItem(CHAT_TOOL_ACTIVITY_STORAGE_KEY)).toBe('true');

    fireEvent.click(toolActivityToggle());
    expect(window.localStorage.getItem(CHAT_TOOL_ACTIVITY_STORAGE_KEY)).toBe('false');
  });

  it('reads it back on the next mount, chips already open', () => {
    const { unmount } = renderTranscript([agentRow('a1', TURN_BODY)]);
    fireEvent.click(toolActivityToggle());
    unmount();

    renderTranscript([agentRow('a1', TURN_BODY)]);

    expect(toolActivityToggle()).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId(CHAT_TOOL_LOG_TOGGLE_TESTID)).toHaveAttribute(
      'aria-expanded',
      'true',
    );
  });

  it('treats any other stored value as folded', () => {
    window.localStorage.setItem(CHAT_TOOL_ACTIVITY_STORAGE_KEY, '1');
    renderTranscript([agentRow('a1', TURN_BODY)]);

    expect(toolActivityToggle()).toHaveAttribute('aria-pressed', 'false');
  });
});

// ---------------------------------------------------------------------------
// 5. The live tail
// ---------------------------------------------------------------------------

describe('[#2284] the in-flight body folds the same way', () => {
  function liveTurn(body: string, version: number): ChatTranscriptLiveTurn {
    return { turnKey: MD_REQUEST_ID, version, body };
  }

  it('folds a growing tool section instead of trailing it under the reply', () => {
    const oneCall = separateTurnBody([
      { kind: 'prose', text: 'Working on it.' },
      { kind: 'tool', text: '- `Bash` — ls' },
    ]).body;

    const { rerender } = render(
      <ChatTranscript
        messages={[msg('u1', 'user')]}
        worktreeId={WORKTREE_ID}
        cliToolId="claude"
        onFilePathClick={vi.fn()}
        liveTurn={liveTurn(oneCall, 1)}
      />,
    );

    const live = screen.getByTestId('chat-live-turn');
    expect(within(live).getByTestId(CHAT_TOOL_LOG_GROUP_TESTID).getAttribute('data-tool-calls'))
      .toBe('1');
    expect(live.textContent).toContain('Working on it.');
    expect(live.textContent).not.toContain('- `Bash`');

    // The next progress frame carries a third call; the chip's count follows.
    const threeCalls = separateTurnBody([
      { kind: 'prose', text: 'Working on it.' },
      { kind: 'tool', text: '- `Bash` — ls' },
      { kind: 'tool', text: '- `Bash` — pwd' },
      { kind: 'tool', text: '- `Read` — probe.txt' },
    ]).body;

    rerender(
      <ChatTranscript
        messages={[msg('u1', 'user')]}
        worktreeId={WORKTREE_ID}
        cliToolId="claude"
        onFilePathClick={vi.fn()}
        liveTurn={liveTurn(threeCalls, 2)}
      />,
    );

    const grown = screen.getByTestId('chat-live-turn');
    expect(grown).toHaveAttribute('data-version', '2');
    expect(within(grown).getByTestId(CHAT_TOOL_LOG_GROUP_TESTID).getAttribute('data-tool-calls'))
      .toBe('3');
  });

  it('obeys the transcript toggle while the turn is still running', () => {
    renderTranscript([msg('u1', 'user')], { liveTurn: liveTurn(TURN_BODY, 1) });

    fireEvent.click(toolActivityToggle());

    const live = screen.getByTestId('chat-live-turn');
    expect(within(live).getByTestId(CHAT_TOOL_LOG_BODY_TESTID).textContent).toContain(
      'apply_patch',
    );
  });

  it('folds the held body too, so settling re-typesets nothing', () => {
    renderTranscript([msg('u1', 'user')], {
      liveTurn: { turnKey: MD_REQUEST_ID, version: 3, body: TURN_BODY, settling: true },
    });

    const held = screen.getByTestId('chat-live-turn');
    expect(held).toHaveAttribute('data-settling', 'true');
    expect(within(held).getByTestId(CHAT_TOOL_LOG_GROUP_TESTID).getAttribute('data-tool-calls'))
      .toBe('2');
  });
});

// ---------------------------------------------------------------------------
// 6. Search reaches inside a fold
// ---------------------------------------------------------------------------

describe('[#2284] a search hit opens the row it landed in', () => {
  it('opens the chip holding the match', async () => {
    // Positive control: the string being searched for is ONLY inside the folded
    // section, so the row cannot show it by accident.
    expect(TURN_BODY).toContain('apply_patch');
    renderTranscript([agentRow('a1', TURN_BODY), agentRow('a2', 'An unrelated reply.')]);

    expect(screen.queryByTestId(CHAT_TOOL_LOG_BODY_TESTID)).toBeNull();

    fireEvent.click(screen.getByTestId('chat-transcript-search-toggle'));
    fireEvent.change(screen.getByLabelText('worktree.history.search.keywordLabel'), {
      target: { value: 'apply_patch' },
    });

    await waitFor(() => {
      expect(within(rowFor('a1')).getByTestId(CHAT_TOOL_LOG_BODY_TESTID).textContent).toContain(
        'apply_patch',
      );
    });
    // Only the matched row opens; the rest of the column stays folded.
    expect(screen.getAllByTestId(CHAT_TOOL_LOG_BODY_TESTID)).toHaveLength(1);
  });

  it('folds the row back up when the search is closed', async () => {
    renderTranscript([agentRow('a1', TURN_BODY)]);

    fireEvent.click(screen.getByTestId('chat-transcript-search-toggle'));
    fireEvent.change(screen.getByLabelText('worktree.history.search.keywordLabel'), {
      target: { value: 'apply_patch' },
    });
    await waitFor(() => expect(screen.getByTestId(CHAT_TOOL_LOG_BODY_TESTID)).toBeInTheDocument());

    fireEvent.click(screen.getByLabelText('worktree.history.search.close'));

    // The transcript's own answer is untouched by a search: it was folded
    // before and it is folded after.
    await waitFor(() => expect(screen.queryByTestId(CHAT_TOOL_LOG_BODY_TESTID)).toBeNull());
    expect(toolActivityToggle()).toHaveAttribute('aria-pressed', 'false');
  });
});

// ---------------------------------------------------------------------------
// 7. The real dictionaries
// ---------------------------------------------------------------------------

describe('[#2284] worktree.chatTranscript i18n parity', () => {
  // `tests/setup.ts` stubs next-intl with an echo of the key, so every
  // assertion above is green with the section missing from `locales/` and
  // `src/i18n.ts` has no `getMessageFallback` — in production the chip would
  // read `chatTranscript.toolLog.summary`.
  const LOCALES_DIR = path.resolve(__dirname, '../../../../locales');
  const KEYS: readonly [string, readonly string[]][] = [
    ['toolLog', ['summary', 'expand', 'collapse']],
    ['toolActivity', ['show', 'hide']],
  ];

  for (const locale of ['en', 'ja'] as const) {
    it(`${locale} defines every label the fold and its toggle request`, () => {
      const worktree = JSON.parse(
        fs.readFileSync(path.join(LOCALES_DIR, locale, 'worktree.json'), 'utf-8'),
      ) as Record<string, Record<string, Record<string, string>>>;
      const section = worktree.chatTranscript;

      for (const [group, keys] of KEYS) {
        expect(section?.[group], `${locale}: chatTranscript.${group}`).toBeTypeOf('object');
        for (const key of keys) {
          const value = section[group][key];
          expect(value, `${locale}: chatTranscript.${group}.${key}`).toBeTypeOf('string');
          expect(value.trim().length, `${locale}: chatTranscript.${group}.${key}`)
            .toBeGreaterThan(0);
        }
      }

      // The chip has to be able to say HOW MANY, or it reports a fold of
      // unknown size — which is the one thing the reader needs to decide
      // whether to open it.
      expect(section.toolLog.summary).toContain('{count}');
      // The two directions of the toggle must not be the same sentence.
      expect(section.toolActivity.show).not.toBe(section.toolActivity.hide);
    });
  }

  it('keeps the chip label spelled the way the writers spell it', () => {
    // The tool section is found by the label `separateTurnBody` bakes into the
    // row; the English chip says the same words so the two are not two
    // vocabularies for one thing.
    const en = JSON.parse(
      fs.readFileSync(path.join(LOCALES_DIR, 'en', 'worktree.json'), 'utf-8'),
    ) as Record<string, Record<string, Record<string, string>>>;

    expect(en.chatTranscript.toolLog.summary).toContain(TURN_TOOL_LOG_LABEL);
    expect(en.chatTranscript.thinking.summary).toContain(TURN_REASONING_LABEL);
  });
});

// ---------------------------------------------------------------------------
// 8. What #2245 and #2272 already had, still true
// ---------------------------------------------------------------------------

describe('[#2284] the two older folds are unchanged in kind', () => {
  it('still draws the reasoning as its own chip, above the tool log', () => {
    renderTranscript([agentRow('a1', TURN_BODY)]);
    const row = rowFor('a1');

    const thinking = within(row).getByTestId(CHAT_THINKING_GROUP_TESTID);
    const tools = within(row).getByTestId(CHAT_TOOL_LOG_GROUP_TESTID);

    expect(thinking.getAttribute('data-thinking-blocks')).toBe('1');
    // Document order: the answer, then what it was thinking, then what it ran.
    expect(thinking.compareDocumentPosition(tools) & Node.DOCUMENT_POSITION_FOLLOWING)
      .toBeTruthy();
  });

  it('still folds a run of approvals into one row', () => {
    renderTranscript([approvalRow('p1', 0), approvalRow('p2', 1)]);

    const group = screen.getByTestId(CHAT_TOOL_APPROVAL_GROUP_TESTID);
    expect(group.getAttribute('data-approval-count')).toBe('2');
    expect(group.textContent).not.toContain('2 KB of it');
  });
});
