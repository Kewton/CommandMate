/**
 * Issue #3881 acceptance (1), the last step: the 16-column confirm page, saved
 * with its reading, is DRAWN as a question set's submission — not as a tool
 * approval — by the transcript the PC and the phone share.
 *
 * Both surfaces render `ChatSurface` (`TerminalSplitPaneContent` on the PC,
 * `MobileTerminalTab` on the phone), and `ChatSurface` renders the rows through
 * `ChatTranscript` → `buildChatTranscriptRows` → `ChatToolApprovalGroup`. The
 * second describe pins that wiring, so "drawn by the transcript" stays "drawn
 * on both".
 *
 * The row is produced from the live fixture by the save path's own function
 * (`promptDataForStorage`), not written by hand.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import type { ChatMessage, PromptData } from '@/types/models';
import { ChatTranscript } from '@/components/worktree/ChatTranscript';
import { extractResponse } from '@/lib/polling/response-checker';
import { promptDataForStorage } from '@/lib/polling/prompt-screen-reading';

const REPO = path.resolve(__dirname, '../../../..');
const FRAME = readFileSync(
  path.join(REPO, 'tests/fixtures/claude-confirm-live-3791/tab-row-wrapped-16x1000.txt'),
  'utf8',
);

/** The stored row, as the response poller saves it and the messages API returns it (JSON round trip). */
function savedRow(promptData: PromptData | undefined): ChatMessage {
  return {
    id: 'confirm-16',
    worktreeId: 'wt-3881',
    role: 'assistant',
    content: 'Ready to submit your answers?',
    timestamp: new Date('2026-10-24T10:00:00.000Z'),
    messageType: 'prompt',
    cliToolId: 'claude',
    instanceId: 'claude',
    archived: false,
    promptData: JSON.parse(JSON.stringify(promptData)) as ChatMessage['promptData'],
  };
}

function detection() {
  const result = extractResponse(FRAME, 0, 'claude');
  if (!result?.promptDetection?.isPrompt) throw new Error('fixture drifted');
  return result.promptDetection;
}

function renderRows(messages: ChatMessage[]) {
  return render(
    <ChatTranscript messages={messages} worktreeId="wt-3881" cliToolId="claude" onFilePathClick={vi.fn()} />,
  );
}

describe('[#3881] the transcript draws the stored reading', () => {
  it('the 16-column confirm page is a confirmation, not an approval', () => {
    renderRows([savedRow(promptDataForStorage('claude', FRAME, detection()))]);
    const group = screen.getByTestId('chat-tool-approval-group');
    expect(group.getAttribute('data-confirmations')).toBe('1');
    expect(group.getAttribute('data-approvals')).toBe('0');
  });

  it('陽性対照: the same row without its reading (pre-#3881) is drawn as an approval', () => {
    renderRows([savedRow(detection().promptData)]);
    const group = screen.getByTestId('chat-tool-approval-group');
    expect(group.getAttribute('data-approvals')).toBe('1');
    expect(group.getAttribute('data-confirmations')).toBe('0');
  });
});

describe('[#3881] the PC and the phone draw rows through the same transcript', () => {
  const source = (file: string): string => readFileSync(path.join(REPO, file), 'utf8');

  it.each([
    ['PC', 'src/components/worktree/TerminalSplitPaneContent.tsx'],
    ['phone', 'src/components/worktree/MobileTerminalTab.tsx'],
  ])('%s renders ChatSurface', (_surface, file) => {
    expect(source(file)).toMatch(/<ChatSurface\b/);
  });

  it('ChatSurface renders ChatTranscript', () => {
    expect(source('src/components/worktree/ChatSurface.tsx')).toMatch(/<ChatTranscript\b/);
  });
});
