/**
 * The "thinking" placeholder names the agent that is actually thinking
 * (Issue #1914).
 *
 * `worktree.status.claudeIsThinking` was the literal "Claude is thinking..." and
 * was rendered for every CLI tool, so a worktree running codex or opencode
 * reported a tool that was not running. The key is now
 * `status.agentIsThinking` with a `{toolName}` placeholder fed from the same
 * `getCliToolDisplayNameSafe(selectedCliTool)` the header already uses.
 *
 * **Mocked next-intl cannot prove this.** The suite-wide mock in tests/setup.ts
 * returns the key path and interpolates parameters into *that*, so a
 * placeholder deleted from the dictionary is invisible to it — the assertion
 * would be about `worktree.status.agentIsThinking`, which never contained the
 * tool name in the first place. Both cases below therefore run against the real
 * dictionary via `createRealIntlMock`, in both locales.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MessageList } from '@/components/worktree/MessageList';
import type { ChatMessage } from '@/types/models';

const locale = vi.hoisted(() => ({ current: 'en' }));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock(() => locale.current);
});

/**
 * One message, because `messages.length === 0` returns the empty-state card
 * before the waiting block is reached.
 */
const SENT: ChatMessage = {
  id: 'msg-1',
  worktreeId: 'wt-1',
  role: 'user',
  content: 'go',
  timestamp: new Date('2026-01-01T10:00:00Z'),
  messageType: 'normal',
  archived: false,
};

/** The state that renders the placeholder: waiting, thinking, nothing captured yet. */
function renderThinking(selectedCliTool: string) {
  return render(
    <MessageList
      messages={[SENT]}
      worktreeId="wt-1"
      waitingForResponse
      isThinking
      realtimeOutput=""
      selectedCliTool={selectedCliTool}
    />
  );
}

describe('MessageList thinking placeholder (Issue #1914)', () => {
  beforeEach(() => {
    locale.current = 'en';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }));
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it.each([
    ['codex', 'Codex'],
    ['opencode', 'OpenCode'],
    ['copilot', 'Copilot'],
    ['antigravity', 'Antigravity'],
    ['claude', 'Claude'],
  ])('en: %s renders "%s is thinking..."', (cliToolId, displayName) => {
    renderThinking(cliToolId);
    expect(screen.getByText(`${displayName} is thinking...`)).toBeInTheDocument();
  });

  it('ja: the interpolated tool name reaches the Japanese dictionary too', () => {
    locale.current = 'ja';
    renderThinking('codex');
    expect(screen.getByText('Codex が考え中です...')).toBeInTheDocument();
  });

  it('does not hardcode Claude when another tool is selected', () => {
    renderThinking('opencode');
    // The pre-#1914 literal. `queryAllByText` rather than a regex over the whole
    // container, so a legitimate "Claude" elsewhere in the tree cannot mask it.
    expect(screen.queryByText('Claude is thinking...')).toBeNull();
  });

  it('falls back to a generic name rather than to Claude for an unknown tool', () => {
    renderThinking('not-a-real-tool');
    expect(screen.getByText('Assistant is thinking...')).toBeInTheDocument();
  });
});
