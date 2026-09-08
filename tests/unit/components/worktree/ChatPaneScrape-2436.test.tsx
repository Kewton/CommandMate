/**
 * A pane dump does not stand beside the answer it duplicates (Issue #2436).
 *
 * ## What was on screen
 *
 * `commandagent-develop`, codex, 2026-09-08: a turn whose Markdown row the
 * rollout reader wrote ~700 ms after the frame went quiet, and — one row above
 * it — the whole pane the poller had already saved: the prompt echoed back, the
 * intermediate output, the composer and the footer. The largest measured was
 * 234,323 characters. 44 such rows on that database since 2026-09-07.
 *
 * The poller side of this Issue stops NEW ones being written. The rows already
 * saved cannot be rewritten (the writers stand down on `request_id`), and #2399
 * argued at length that deleting them would be wrong: an interrupted turn leaves
 * text in the pane that the transcript's closed turn does not have. So they are
 * FOLDED — one chip, openable, nothing deleted.
 *
 * ## The limit that matters most
 *
 * "assistant + normal + no request id" is three quarters of the rule. The fourth
 * quarter is the tool table, and without it this feature deletes copilot and
 * gemini from the product: their scraped row is the only record either tool ever
 * produces, and every one of those rows has `request_id` NULL — 255 of 255 and
 * 3 of 3 respectively, measured over the whole of the reference database. The
 * suite below is written so that removing `CHAT_TRANSCRIPT_READER_TOOLS` from
 * the predicate turns four assertions red rather than none.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import {
  CHAT_PANE_SCRAPE_BODY_TESTID,
  CHAT_PANE_SCRAPE_GROUP_TESTID,
  CHAT_PANE_SCRAPE_TOGGLE_TESTID,
  CHAT_TRANSCRIPT_READER_TOOLS,
  ChatMessageBubble,
  isFoldedPaneScrape,
} from '@/components/worktree/ChatMessageBubble';
import { codexTurnRequestId } from '@/types/agent-transcript';
import type { CLIToolType } from '@/lib/cli-tools/types';
import type { ChatMessage } from '@/types/models';

const WORKTREE_ID = 'wt-2436';

/**
 * CommandMate's own assistant/normal rows, spelled here rather than imported.
 * `MODEL_CHANGE_REQUEST_ID_PREFIX` (`chat-db.ts:995`) and
 * `RELAY_SYSTEM_REQUEST_ID_PREFIX` (`chat-db.ts:1064`) live in a module that
 * opens the database; this suite renders a React component in jsdom.
 */
const MODEL_CHANGED_PREFIX = 'model-changed:';
const RELAY_SYSTEM_PREFIX = 'relay-sys:';

/** The shape of the row this Issue is about: a whole pane, saved as a reply. */
const PANE_DUMP = [
  '› summarize the project',
  '',
  '• Explored',
  '  └ Read response-checker.ts',
  '',
  '• A worktree is a working directory for a repository.',
  '',
  '─'.repeat(80),
  '› Ask Codex to do anything',
  '  gpt-5.6-sol xhigh · ~/share/work/github_kewton/CommandMate',
].join('\n');

function msg(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'm-1',
    worktreeId: WORKTREE_ID,
    role: 'assistant',
    content: PANE_DUMP,
    timestamp: new Date(Date.UTC(2026, 8, 8, 14, 8, 0)),
    messageType: 'normal',
    archived: false,
    cliToolId: 'codex',
    ...overrides,
  };
}

function renderBubble(overrides: Partial<ChatMessage> = {}) {
  return render(
    <ChatMessageBubble
      message={msg(overrides)}
      showHeader
      onFilePathClick={vi.fn()}
    />,
  );
}

// ---------------------------------------------------------------------------
// Premises
// ---------------------------------------------------------------------------

describe('[#2436] the tool table this fold is limited by', () => {
  it('says the scraper is the only writer for copilot, gemini and vibe-local', () => {
    // The record `lib/relay/relay-delivery` keeps under the same name, and the
    // reason the predicate consults a table rather than testing the id's shape.
    expect(CHAT_TRANSCRIPT_READER_TOOLS).toEqual({
      claude: true,
      codex: true,
      antigravity: true,
      'command-code': true,
      opencode: true,
      copilot: false,
      gemini: false,
      'vibe-local': false,
    });
  });
});

// ---------------------------------------------------------------------------
// The predicate
// ---------------------------------------------------------------------------

describe('[#2436] which rows are a pane dump', () => {
  it.each(['claude', 'codex', 'antigravity', 'command-code', 'opencode'] as CLIToolType[])(
    '%s: an assistant row with no request id is one',
    (cliToolId) => {
      expect(isFoldedPaneScrape(msg({ cliToolId }))).toBe(true);
    },
  );

  it.each(['copilot', 'gemini', 'vibe-local'] as CLIToolType[])(
    '%s: an assistant row with no request id is the ANSWER and is not',
    (cliToolId) => {
      // The mutation this catches: drop the tool table from the predicate and
      // every reply these three tools have ever given goes behind a chip.
      expect(isFoldedPaneScrape(msg({ cliToolId }))).toBe(false);
    },
  );

  it('a turn-keyed row is not one, whatever it contains', () => {
    expect(
      isFoldedPaneScrape(
        msg({ requestId: codexTurnRequestId('0199a0bb-0000-4000-8000-000000000001') }),
      ),
    ).toBe(false);
  });

  it('the scraper’s own `req_…` id is not one either', () => {
    // `parseClaudeOutput` has written this id on scraped Claude rows since long
    // before any reader existed. The rule is "no request id", not "no turn key".
    expect(isFoldedPaneScrape(msg({ cliToolId: 'claude', requestId: 'req_019' }))).toBe(false);
  });

  it('a `model-changed:` notice is not one', () => {
    // CommandMate's own furniture: assistant / normal, and it must stay on
    // screen. It stays by carrying a key, not by being on an exclusion list.
    expect(
      isFoldedPaneScrape(
        msg({ requestId: `${MODEL_CHANGED_PREFIX}1757340000000`, content: 'model changed' }),
      ),
    ).toBe(false);
  });

  it('a `relay-sys:` notice is not one', () => {
    expect(
      isFoldedPaneScrape(
        msg({ requestId: `${RELAY_SYSTEM_PREFIX}r-1:expired`, content: 'the relay expired' }),
      ),
    ).toBe(false);
  });

  it('a user row is not one', () => {
    expect(isFoldedPaneScrape(msg({ role: 'user' }))).toBe(false);
  });

  it('a prompt row is not one', () => {
    expect(isFoldedPaneScrape(msg({ messageType: 'prompt' }))).toBe(false);
  });

  it('an empty-string request id is still "no request id"', () => {
    expect(isFoldedPaneScrape(msg({ requestId: '' }))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The rendering
// ---------------------------------------------------------------------------

describe('[#2436] what a folded row draws', () => {
  it('shows a chip and none of the pane', () => {
    renderBubble();

    expect(screen.getByTestId(CHAT_PANE_SCRAPE_GROUP_TESTID)).toBeTruthy();
    expect(screen.queryByTestId(CHAT_PANE_SCRAPE_BODY_TESTID)).toBeNull();
    // Non-vacuity: the fixture really is the thing that used to be on screen.
    expect(PANE_DUMP).toContain('Ask Codex to do anything');
    expect(document.body.textContent).not.toContain('Ask Codex to do anything');
  });

  it('puts the whole pane back when the reader opens it', () => {
    renderBubble();

    fireEvent.click(screen.getByTestId(CHAT_PANE_SCRAPE_TOGGLE_TESTID));

    const body = screen.getByTestId(CHAT_PANE_SCRAPE_BODY_TESTID);
    expect(body.textContent).toContain('Ask Codex to do anything');
    expect(body.textContent).toContain('A worktree is a working directory');
  });

  it('keeps the row addressable by message id, so a search hit can be marked', () => {
    renderBubble();
    fireEvent.click(screen.getByTestId(CHAT_PANE_SCRAPE_TOGGLE_TESTID));

    expect(document.querySelector('[data-message-id="m-1"]')).not.toBeNull();
  });

  it('keeps the copy action, because nothing has been deleted', () => {
    const onCopy = vi.fn();
    render(
      <ChatMessageBubble
        message={msg()}
        showHeader
        onFilePathClick={vi.fn()}
        onCopy={onCopy}
      />,
    );

    fireEvent.click(screen.getByTestId('chat-copy-message'));
    expect(onCopy).toHaveBeenCalledWith(PANE_DUMP);
  });

  it.each(['copilot', 'gemini'] as CLIToolType[])(
    '%s: draws its reply in full, with no chip at all',
    (cliToolId) => {
      renderBubble({ cliToolId });

      expect(screen.queryByTestId(CHAT_PANE_SCRAPE_GROUP_TESTID)).toBeNull();
      expect(document.body.textContent).toContain('A worktree is a working directory');
    },
  );

  it('draws a `model-changed:` notice in full', () => {
    renderBubble({
      requestId: `${MODEL_CHANGED_PREFIX}1757340000000`,
      content: 'Model changed to gpt-5.6-sol',
    });

    expect(screen.queryByTestId(CHAT_PANE_SCRAPE_GROUP_TESTID)).toBeNull();
    expect(document.body.textContent).toContain('Model changed to gpt-5.6-sol');
  });

  it('draws a `relay-sys:` notice in full', () => {
    renderBubble({
      requestId: `${RELAY_SYSTEM_PREFIX}r-1:expired`,
      content: 'The relay to codex expired without an answer',
    });

    expect(screen.queryByTestId(CHAT_PANE_SCRAPE_GROUP_TESTID)).toBeNull();
    expect(document.body.textContent).toContain('The relay to codex expired');
  });

  it('draws a user row in full', () => {
    renderBubble({ role: 'user', content: 'summarize the project' });

    expect(screen.queryByTestId(CHAT_PANE_SCRAPE_GROUP_TESTID)).toBeNull();
    expect(document.body.textContent).toContain('summarize the project');
  });
});
