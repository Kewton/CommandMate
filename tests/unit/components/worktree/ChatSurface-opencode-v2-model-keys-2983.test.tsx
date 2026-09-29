/**
 * The dialog card's model keys for OpenCode V2 (Issue #2983).
 *
 * v1 has had `ctrl+t` / `ctrl+x m` / `ctrl+p` on the card since #2297; v2 had
 * none. The card is raised for v2 by three kinds of screen (#2965 / #2971): the
 * approval strip, the question form, and a picker or the palette. Measured on
 * `opencode2` 2.0.18 (`tests/fixtures/opencode-v2-model-keys-2983/`), none of
 * the three keys reaches through an open picker or palette, so each v2 key is
 * sent after an `Escape` that closes it — and is therefore drawn ONLY on a
 * picker / palette frame, never on the approval or the question, where `Escape`
 * would be an answer.
 *
 * Every claim is anchored on a FRAME, as #2297's suite is: the gate reads the
 * pane, not a flag, so a suite that only varied `cliToolId` would be vacuous.
 * v1's behaviour is pinned by `ChatSurface-selection-keys-2297.test.tsx`,
 * unchanged.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import fs from 'fs';
import path from 'path';
import type { ChatMessage } from '@/types/models';
import type { CLIToolType } from '@/lib/cli-tools/types';

vi.mock('@/components/worktree/ChatTranscript', () => ({
  ChatTranscript: ({ messages }: { messages: Array<{ id: string }> }) => (
    <div data-testid="chat-transcript" data-message-count={String(messages.length)}>
      <div data-testid="chat-transcript-scroll-container" />
    </div>
  ),
  CHAT_TRANSCRIPT_SCROLL_CONTAINER_TESTID: 'chat-transcript-scroll-container',
}));

import { ChatSurface, type ChatSurfaceLiveState } from '@/components/worktree/ChatSurface';
import { opencodeModelKeyBindings } from '@/components/worktree/OpencodeQuickKeys';

const FIXTURES = path.resolve(__dirname, '../../../fixtures');
const read = (dir: string, name: string): string =>
  fs.readFileSync(path.join(FIXTURES, dir, `${name}.txt`), 'utf-8');

/** `ctrl+x m` on the launch screen of 2.0.18. */
const V2_SELECT_MODEL = read('opencode-v2-model-keys-2983', 'select-model-ctrl-x-m');
/** `ctrl+p` on the launch screen of 2.0.18. */
const V2_COMMANDS = read('opencode-v2-model-keys-2983', 'commands-ctrl-p');
/** The variant picker 2.0.18 opens after a model with variants is chosen. */
const V2_SELECT_VARIANT = read('opencode-v2-model-keys-2983', 'space-bunny-variant-dialog');
/** #2945's approval strip and question form — the card is raised, Escape must not be sent. */
const V2_PERMISSION = read('opencode-v2-live-2945', 'permission-required');
const V2_QUESTION = read('opencode-v2-live-2945', 'question');
/** opencode 1.18.27 `ctrl+x a` overlay, #2297's v1 frame. */
const V1_OVERLAY = read('chat-dialog-card-2254', 'opencode-agent-overlay-1-18-27');

const WORKTREE_ID = 'wt-2983';

function msg(id: string, role: ChatMessage['role']): ChatMessage {
  return {
    id,
    worktreeId: WORKTREE_ID,
    role,
    content: `content-${id}`,
    timestamp: new Date('2026-09-29T10:00:00Z'),
    messageType: 'normal',
    archived: false,
    cliToolId: 'opencode-v2',
  };
}

const SELECTION_LIST: ChatSurfaceLiveState = {
  isRunning: true,
  sessionStatus: 'waiting',
  isThinking: false,
  isPromptWaiting: false,
  promptData: null,
  isSelectionListActive: true,
  isPagerActive: false,
  isUnclassifiedActive: false,
};

function renderSurface(frame: string, cliToolId: CLIToolType = 'opencode-v2') {
  return render(
    <ChatSurface
      messages={[msg('u1', 'user'), msg('a1', 'assistant')]}
      worktreeId={WORKTREE_ID}
      cliToolId={cliToolId}
      live={SELECTION_LIST}
      onSurfaceModeChange={vi.fn()}
      frame={frame}
    />,
  );
}

function actions(): HTMLElement {
  return screen.getByTestId('chat-dialog-card-actions');
}

/** The requests that are NOT the relay-badge read (#2377), as parsed bodies. */
function keyBodies(): Array<{ keys: string[]; cliToolId: string }> {
  return fetchMock.mock.calls
    .filter((call) => !String(call[0]).startsWith('/api/relays'))
    .map((call) => JSON.parse(((call[1] ?? {}) as RequestInit).body as string));
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ success: true }) });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('[#2983] OpenCode V2 gets the model keys on a picker / palette card', () => {
  it.each([
    ['Select model', V2_SELECT_MODEL],
    ['Commands', V2_COMMANDS],
    ['Select variant', V2_SELECT_VARIANT],
  ])('draws variant / models / commands, in that order, over %s', (_title, frame) => {
    renderSurface(frame);

    const strip = within(actions()).getByTestId('opencode-model-keys');
    const ids = within(strip)
      .getAllByRole('button')
      .map((button) => button.getAttribute('data-testid'));
    expect(ids).toEqual([
      'opencode-model-key-variant',
      'opencode-model-key-models',
      'opencode-model-key-commands',
    ]);
  });

  it('prints v2’s own notation', () => {
    renderSurface(V2_SELECT_MODEL);

    expect(screen.getByTestId('opencode-model-key-variant')).toHaveTextContent('ctrl+t');
    expect(screen.getByTestId('opencode-model-key-models')).toHaveTextContent('ctrl+x m');
    expect(screen.getByTestId('opencode-model-key-commands')).toHaveTextContent('ctrl+p');
  });

  it.each([
    ['variant', ['Escape', 'C-t']],
    ['models', ['Escape', 'C-x', 'm']],
    ['commands', ['Escape', 'C-p']],
  ])('sends %s as ONE request that closes the open dialog first', (id, keys) => {
    renderSurface(V2_COMMANDS);

    fireEvent.click(screen.getByTestId(`opencode-model-key-${id}`));

    expect(keyBodies()).toHaveLength(1);
    expect(keyBodies()[0]).toMatchObject({ cliToolId: 'opencode-v2', keys });
  });

  it('keeps the arrow pad beside the keys', () => {
    renderSurface(V2_SELECT_MODEL);

    expect(within(actions()).getByLabelText('Up')).toBeInTheDocument();
    expect(within(actions()).getByLabelText('Escape')).toBeInTheDocument();
  });
});

describe('[#2983] …and never where an Escape would be an answer', () => {
  it.each([
    ['approval strip', V2_PERMISSION],
    ['question form', V2_QUESTION],
  ])('draws no model keys on the %s card', (_name, frame) => {
    renderSurface(frame);

    // The card is there (the arrow pad drives the dialog); the keys are not.
    expect(within(actions()).getByLabelText('Up')).toBeInTheDocument();
    expect(within(actions()).queryByTestId('opencode-model-keys')).not.toBeInTheDocument();
  });

  it('negative control: the picker with its title row removed draws none', () => {
    const noTitle = V2_SELECT_MODEL.replace(/^\s+Select model\s+esc$/m, '');
    renderSurface(noTitle);

    expect(within(actions()).queryByTestId('opencode-model-keys')).not.toBeInTheDocument();
  });
});

describe('[#2983] v1 is unchanged', () => {
  it('opencode still sends the bare keys, with no Escape, whatever the frame', () => {
    const expected = [
      { id: 'variant', keys: ['C-t'] },
      { id: 'models', keys: ['C-x', 'm'] },
      { id: 'commands', keys: ['C-p'] },
    ];
    expect(opencodeModelKeyBindings('opencode', V1_OVERLAY)).toEqual(expected);
    expect(opencodeModelKeyBindings('opencode')).toEqual(expected);
  });

  it('draws v1’s card from a frame that has no v2 title row', () => {
    renderSurface(V1_OVERLAY, 'opencode');

    fireEvent.click(screen.getByTestId('opencode-model-key-models'));
    expect(keyBodies()[0]).toMatchObject({ cliToolId: 'opencode', keys: ['C-x', 'm'] });
  });

  it.each<CLIToolType>(['claude', 'codex', 'command-code'])('%s still gets none', (tool) => {
    expect(opencodeModelKeyBindings(tool, V2_SELECT_MODEL)).toEqual([]);
  });
});
