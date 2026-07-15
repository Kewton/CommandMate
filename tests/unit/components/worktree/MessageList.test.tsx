/**
 * MessageList Component Tests
 * Issue #1117: チャット履歴UIをConversationPairCard系デザインへ統一
 *
 * Verifies visual-language unification (status tint tokens, lucide icons,
 * hover-reveal toolbar touch fallback) and functional parity (markdown,
 * file path links, prompt responses, ANSI always-dark island).
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MessageList } from '@/components/worktree/MessageList';
import type { ChatMessage } from '@/types/models';

const pushMock = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock }),
}));

function createMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'msg-1',
    worktreeId: 'wt-1',
    role: 'assistant',
    content: 'Hello',
    timestamp: new Date('2026-01-01T10:00:00Z'),
    messageType: 'normal',
    archived: false,
    ...overrides,
  };
}

/**
 * Raw palette utilities banned from the MessageList render path (Issue #1117
 * acceptance criteria; mirrors the #1116 token-discipline guard pattern).
 */
const RAW_PALETTE_PATTERN =
  /(bg|text|border|ring)-(red|green|yellow|amber|orange|purple|violet|sky|blue|gray|slate)-[0-9]/;

describe('MessageList (Issue #1117 visual unification)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) })
    );
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
      configurable: true,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('empty and loading states', () => {
    it('renders empty state without raw palette classes', () => {
      const { container } = render(<MessageList messages={[]} worktreeId="wt-1" />);
      expect(screen.getByText('No messages yet')).toBeInTheDocument();
      expect(container.innerHTML).not.toMatch(RAW_PALETTE_PATTERN);
    });

    it('renders loading state', () => {
      render(<MessageList messages={[]} worktreeId="wt-1" loading />);
      expect(screen.getByText('Loading messages...')).toBeInTheDocument();
    });
  });

  describe('markdown rendering parity', () => {
    it('renders markdown content (bold)', () => {
      const messages = [createMessage({ content: 'This is **important** text' })];
      render(<MessageList messages={messages} worktreeId="wt-1" />);
      const strong = screen.getByText('important');
      expect(strong.tagName).toBe('STRONG');
    });
  });

  describe('file path links', () => {
    it('navigates to file viewer when a file path is clicked', () => {
      const messages = [createMessage({ content: 'See src/lib/foo.ts for details' })];
      render(<MessageList messages={messages} worktreeId="wt-1" />);
      const link = screen.getByRole('button', { name: 'src/lib/foo.ts' });
      fireEvent.click(link);
      expect(pushMock).toHaveBeenCalledWith('/worktrees/wt-1/files/src/lib/foo.ts');
    });
  });

  describe('user message section (ConversationPairCard language)', () => {
    it('renders user message with accent left-border section', () => {
      const messages = [createMessage({ role: 'user', content: 'my question' })];
      const { container } = render(<MessageList messages={messages} worktreeId="wt-1" />);
      expect(container.querySelector('.border-accent-500')).not.toBeNull();
      expect(screen.getByText('You')).toBeInTheDocument();
      expect(container.innerHTML).not.toMatch(RAW_PALETTE_PATTERN);
    });

    it('copy toolbar is hover-reveal with touch fallback', () => {
      const messages = [createMessage({ role: 'user', content: 'copy me' })];
      render(<MessageList messages={messages} worktreeId="wt-1" />);
      const copyButton = screen.getByTestId('copy-user-message');
      const toolbar = copyButton.parentElement as HTMLElement;
      expect(toolbar.className).toContain('group-hover:opacity-100');
      expect(toolbar.className).toContain('[@media(hover:none)]:opacity-100');
    });

    it('copies message content to clipboard', () => {
      const messages = [createMessage({ content: 'assistant output' })];
      render(<MessageList messages={messages} worktreeId="wt-1" />);
      fireEvent.click(screen.getByTestId('copy-assistant-message'));
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith('assistant output');
    });
  });

  describe('prompt response UI (status tint tokens)', () => {
    function createYesNoPrompt(overrides: Partial<ChatMessage> = {}): ChatMessage {
      return createMessage({
        content: 'Do you want to proceed?',
        promptData: {
          type: 'yes_no',
          question: 'Do you want to proceed?',
          status: 'pending',
          options: ['yes', 'no'],
        },
        ...overrides,
      });
    }

    it('renders awaiting badge with warning tint tokens', () => {
      render(<MessageList messages={[createYesNoPrompt()]} worktreeId="wt-1" />);
      const badge = screen.getByText('prompt.awaitingSelection');
      expect(badge.className).toContain('bg-warning-subtle');
      expect(badge.className).toContain('text-warning-foreground');
    });

    it('sends yes response and applies optimistic update', async () => {
      const onOptimisticUpdate = vi.fn();
      render(
        <MessageList
          messages={[createYesNoPrompt()]}
          worktreeId="wt-1"
          onOptimisticUpdate={onOptimisticUpdate}
        />
      );
      fireEvent.click(screen.getByRole('button', { name: /prompt\.yes/ }));
      await waitFor(() => {
        expect(onOptimisticUpdate).toHaveBeenCalled();
      });
      const optimistic = onOptimisticUpdate.mock.calls[0][0] as ChatMessage;
      expect(optimistic.promptData?.status).toBe('answered');
      expect(optimistic.promptData?.answer).toBe('yes');
      expect(global.fetch).toHaveBeenCalledWith(
        '/api/worktrees/wt-1/respond',
        expect.objectContaining({ method: 'POST' })
      );
    });

    it('renders answered state with success tint tokens', () => {
      const answered = createYesNoPrompt({
        promptData: {
          type: 'yes_no',
          question: 'Do you want to proceed?',
          status: 'answered',
          answer: 'yes',
          options: ['yes', 'no'],
        },
      });
      render(<MessageList messages={[answered]} worktreeId="wt-1" />);
      const box = screen.getByText(/prompt\.answered/).closest('div') as HTMLElement;
      expect(box.className).toContain('bg-success-subtle');
      expect(box.className).toContain('text-success-foreground');
    });

    it('handles multiple choice with text input option', async () => {
      const choicePrompt = createMessage({
        content: 'Select an option',
        promptData: {
          type: 'multiple_choice',
          question: 'Choose one',
          status: 'pending',
          options: [
            { number: 1, label: 'Option 1', isDefault: true },
            { number: 2, label: 'Custom', requiresTextInput: true },
          ],
        },
      });
      render(<MessageList messages={[choicePrompt]} worktreeId="wt-1" />);

      // Regular + text-input options render
      expect(screen.getByText('Option 1')).toBeInTheDocument();

      // Selecting the text-input option shows a textarea instead of sending
      fireEvent.click(screen.getByText('Custom'));
      const textarea = screen.getByPlaceholderText('prompt.enterMessageHere');
      expect(textarea).toBeInTheDocument();
      expect(global.fetch).not.toHaveBeenCalled();

      // Send button disabled until text entered
      const sendButton = screen.getByRole('button', { name: 'common.send' });
      expect(sendButton).toBeDisabled();
      fireEvent.change(textarea, { target: { value: 'my custom answer' } });
      expect(sendButton).not.toBeDisabled();

      fireEvent.click(sendButton);
      await waitFor(() => {
        expect(global.fetch).toHaveBeenCalledWith(
          '/api/worktrees/wt-1/respond',
          expect.objectContaining({
            body: JSON.stringify({ messageId: 'msg-1', answer: 'my custom answer' }),
          })
        );
      });
    });

    it('prompt UI contains no raw palette classes', () => {
      const { container } = render(
        <MessageList messages={[createYesNoPrompt()]} worktreeId="wt-1" />
      );
      expect(container.innerHTML).not.toMatch(RAW_PALETTE_PATTERN);
    });
  });

  describe('ANSI always-dark island (preserved)', () => {
    it('renders ANSI content in the fixed dark code surface', () => {
      const messages = [createMessage({ content: '\x1b[31merror text\x1b[0m' })];
      const { container } = render(<MessageList messages={messages} worktreeId="wt-1" />);
      const pre = container.querySelector('pre') as HTMLElement;
      expect(pre).not.toBeNull();
      expect(pre.className).toContain('bg-[#0d1117]');
    });
  });

  describe('realtime output section', () => {
    it('renders running state with tint tokens only', () => {
      const { container } = render(
        <MessageList
          messages={[createMessage()]}
          worktreeId="wt-1"
          waitingForResponse
          realtimeOutput="building project..."
        />
      );
      expect(screen.getByText('worktree.session.running')).toBeInTheDocument();
      expect(screen.getByText('building project...')).toBeInTheDocument();
      expect(container.innerHTML).not.toMatch(RAW_PALETTE_PATTERN);
    });

    it('renders thinking state with tint tokens only', () => {
      const { container } = render(
        <MessageList
          messages={[createMessage()]}
          worktreeId="wt-1"
          waitingForResponse
          isThinking
        />
      );
      expect(screen.getByText('worktree.status.thinking')).toBeInTheDocument();
      expect(container.innerHTML).not.toMatch(RAW_PALETTE_PATTERN);
    });
  });
});
