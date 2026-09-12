/**
 * `POST /prompt-response` refuses a numbered REPLY and answers a real dialog
 * (Issue #2457, 受入条件 2 and 3).
 *
 * The route re-verifies the prompt before sending a key (#161) so that a `1`
 * cannot be typed into a composer after the dialog has closed. That
 * re-verification asked the generic parser and nothing else — and for claude the
 * generic parser will build a `multiple_choice` candidate out of Markdown list
 * rows with no `❯` on them. So the very screen #2457 is about, an idle pane
 * whose last turn answered in a list, passed the check: `sendPromptAnswer` typed
 * a digit at the composer and the Enter after it SENT it, which reaches the
 * agent as a new instruction reading `1`.
 *
 * Nothing here stubs the detection layer. `detectPrompt`, `evaluateDialogPresence`
 * and claude's own `detectDialog` are the shipping ones, and the frames are the
 * #2457 corpus and the live `claude-live-1708` captures — the point is which
 * screens the route acts on, so a mocked verdict would decide the test rather
 * than the code.
 *
 * @vitest-environment node
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { POST as promptResponse } from '@/app/api/worktrees/[id]/prompt-response/route';
import type { NextRequest } from 'next/server';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';
import { upsertWorktree, getMessages } from '@/lib/db';
import type { Worktree } from '@/types/models';
import { detectPrompt } from '@/lib/detection/prompt-detector';
import { stripAnsi, stripBoxDrawing, buildDetectPromptOptions } from '@/lib/detection/cli-patterns';

declare module '@/lib/db/db-instance' {
  export function setMockDb(db: Database.Database): void;
}

vi.mock('@/lib/db/db-instance', () => {
  let mockDb: Database.Database | null = null;
  return {
    getDbInstance: () => {
      if (!mockDb) throw new Error('Mock database not initialized');
      return mockDb;
    },
    setMockDb: (db: Database.Database) => { mockDb = db; },
    closeDbInstance: () => {
      if (mockDb) { mockDb.close(); mockDb = null; }
    },
  };
});

vi.mock('@/lib/tmux/tmux', () => ({
  sendKeys: vi.fn().mockResolvedValue(undefined),
  sendSpecialKeys: vi.fn().mockResolvedValue(undefined),
  capturePane: vi.fn().mockResolvedValue(''),
}));

vi.mock('@/lib/session/cli-session', () => ({
  captureSessionOutput: vi.fn().mockResolvedValue(''),
  captureSessionOutputFresh: vi.fn().mockResolvedValue(''),
}));
vi.mock('@/lib/polling/response-poller', () => ({ startPolling: vi.fn() }));
vi.mock('@/lib/realtime/terminal-broadcast', () => ({
  broadcastTerminalSnapshotAfterInteraction: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/ws-server', () => ({ broadcastMessage: vi.fn() }));

// #1898's structured path answers over the agent's own API and returns before
// any keystroke. Declined so the KEYSTROKE path — the one this Issue is about —
// is the path under test.
vi.mock('@/lib/hooks/structured-decision-response', () => ({
  answerStructuredDecision: vi.fn().mockResolvedValue({
    kind: 'not-applicable',
    reason: 'no-pending-decision',
  }),
}));
vi.mock('@/lib/session/agent-event-state', () => ({ getAskUserQuestion: vi.fn(() => null) }));

// NOT mocked, deliberately: `@/lib/detection/cli-patterns` is where every tool
// module reads its measured patterns from, so a stub with a few exports would
// leave `detectDialog` matching against undefined and the gate would answer for
// reasons that have nothing to do with the frame.

vi.mock('@/lib/cli-tools/manager', () => ({
  CLIToolManager: {
    getInstance: vi.fn(() => ({
      getTool: () => ({
        name: 'Claude',
        isRunning: vi.fn().mockResolvedValue(true),
        getSessionName: (id: string) => `claude-${id}`,
      }),
    })),
  },
}));

const REPLIES = path.resolve(__dirname, '../../fixtures/claude-idle-numbered-list-2457');
const DIALOGS = path.resolve(__dirname, '../lib/detection/fixtures/claude-live-1708');

function reply(name: string): string {
  return readFileSync(path.join(REPLIES, `${name}.txt`), 'utf8');
}

function dialog(name: string): string {
  return readFileSync(path.join(DIALOGS, `${name}.txt`), 'utf8');
}

function createRequest(worktreeId: string, body: Record<string, unknown>): NextRequest {
  return new Request(`http://localhost:3000/api/worktrees/${worktreeId}/prompt-response`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

const WT = 'test-wt';

describe('[#2457] POST /prompt-response on a Claude pane', () => {
  let db: Database.Database;

  beforeEach(async () => {
    db = new Database(':memory:');
    runMigrations(db);
    const { setMockDb } = await import('@/lib/db/db-instance');
    setMockDb(db);

    const worktree: Worktree = {
      id: WT,
      name: 'Test Worktree',
      path: '/path/to/test',
      repositoryPath: '/path/to/repo',
      repositoryName: 'TestRepo',
      cliToolId: 'claude',
    };
    upsertWorktree(db, worktree);

    vi.clearAllMocks();
  });

  it.each([
    // The two frames where the gate is what refuses: with the footer not yet
    // redrawn there is no composer row, so the parser's own user-input barrier
    // never fires and the candidate reaches the re-verification intact. The
    // `detectPrompt` assertion inside the test pins that.
    'reply-numbered-list-repaint',
    'reply-numbered-list-generating-repaint',
    // The rest are refused upstream by `!promptCheck.isPrompt` and are here as
    // the belt to the gate's braces — a parser change that reopened any of them
    // must not reopen the route with it.
    'reply-numbered-list-idle',
    'reply-numbered-list-taskpanel',
    'reply-question-paragraph',
    'reply-quotes-dialog-wording',
  ])('%s: refuses with prompt_no_longer_active and sends no key', async name => {
    const { captureSessionOutputFresh } = await import('@/lib/session/cli-session');
    const { sendKeys, sendSpecialKeys } = await import('@/lib/tmux/tmux');
    vi.mocked(captureSessionOutputFresh).mockResolvedValue(reply(name));

    const response = await promptResponse(createRequest(WT, { answer: '1' }), {
      params: Promise.resolve({ id: WT }),
    });
    const data = await response.json();

    // The existing JSON contract, unchanged — this is the same refusal the
    // route has returned since #161 for a prompt that has gone away.
    expect(response.status).toBe(200);
    expect(data).toEqual({ success: false, reason: 'prompt_no_longer_active', answer: '1' });

    // 受入条件, literally: not the `1`, and not the Enter after it.
    expect(sendKeys).not.toHaveBeenCalled();
    expect(sendSpecialKeys).not.toHaveBeenCalled();
  });

  it('the two repaint frames really do reach the gate', () => {
    // Non-vacuity for the table above. If the generic parser ever stops
    // building a candidate out of these, the refusals become statements about
    // `!promptCheck.isPrompt` and the gate is no longer under test at all.
    for (const name of ['reply-numbered-list-repaint', 'reply-numbered-list-generating-repaint']) {
      const detection = detectPrompt(
        stripBoxDrawing(stripAnsi(reply(name))),
        buildDetectPromptOptions('claude'),
      );
      expect(detection.isPrompt, name).toBe(true);
      expect(detection.promptData?.type, name).toBe('multiple_choice');
    }
  });

  it('records no answered prompt and does not resume polling on a refusal', async () => {
    const { captureSessionOutputFresh } = await import('@/lib/session/cli-session');
    const { startPolling } = await import('@/lib/polling/response-poller');
    vi.mocked(captureSessionOutputFresh).mockResolvedValue(reply('reply-numbered-list-repaint'));

    await promptResponse(createRequest(WT, { answer: '1' }), {
      params: Promise.resolve({ id: WT }),
    });

    expect(startPolling).not.toHaveBeenCalled();
    expect(getMessages(db, WT)).toEqual([]);
  });

  it('refuses `--default` on a numbered reply too', async () => {
    // `respond --default` (#1681) resolves the prompt's own default option, so
    // on a reply it would press Enter at an idle composer — a blank submit, which
    // on claude re-runs whatever is in the box.
    const { captureSessionOutputFresh } = await import('@/lib/session/cli-session');
    const { sendKeys, sendSpecialKeys } = await import('@/lib/tmux/tmux');
    vi.mocked(captureSessionOutputFresh).mockResolvedValue(reply('reply-numbered-list-repaint'));

    const response = await promptResponse(createRequest(WT, { useDefault: true }), {
      params: Promise.resolve({ id: WT }),
    });
    const data = await response.json();

    expect(data).toEqual({ success: false, reason: 'prompt_no_longer_active', answer: '' });
    expect(sendKeys).not.toHaveBeenCalled();
    expect(sendSpecialKeys).not.toHaveBeenCalled();
  });

  it('still answers a real permission dialog', async () => {
    const { captureSessionOutputFresh } = await import('@/lib/session/cli-session');
    const { sendSpecialKeys } = await import('@/lib/tmux/tmux');
    vi.mocked(captureSessionOutputFresh).mockResolvedValue(dialog('bash-approval-taskpanel'));

    const response = await promptResponse(createRequest(WT, { answer: '2' }), {
      params: Promise.resolve({ id: WT }),
    });
    const data = await response.json();

    expect(data.success).toBe(true);
    // claude's menus are cursor-navigated, so option 2 is one Down then Enter.
    expect(sendSpecialKeys).toHaveBeenCalledWith(`claude-${WT}`, ['Down', 'Enter']);
  });

  it('still answers the AskUserQuestion confirmation screen, which has no footer', async () => {
    const { captureSessionOutputFresh } = await import('@/lib/session/cli-session');
    const { sendSpecialKeys } = await import('@/lib/tmux/tmux');
    vi.mocked(captureSessionOutputFresh).mockResolvedValue(dialog('askuserquestion-submit-taskpanel'));

    const response = await promptResponse(createRequest(WT, { answer: '1' }), {
      params: Promise.resolve({ id: WT }),
    });
    const data = await response.json();

    expect(data.success).toBe(true);
    expect(sendSpecialKeys).toHaveBeenCalled();
  });

  it('still answers that screen under claude-cli 2.1.267\'s files-edited HUD (#2468)', async () => {
    // The HUD row right-aligned at the bottom of this live capture used to be
    // read as the screen's footer, and the route refused a dialog that was open.
    const { captureSessionOutputFresh } = await import('@/lib/session/cli-session');
    const { sendSpecialKeys } = await import('@/lib/tmux/tmux');
    const capture = path.resolve(
      __dirname,
      '../../fixtures/claude-live-2468/askuserquestion-submit-files-edited-panel.txt',
    );
    vi.mocked(captureSessionOutputFresh).mockResolvedValue(readFileSync(capture, 'utf8'));

    const response = await promptResponse(createRequest(WT, { answer: '1' }), {
      params: Promise.resolve({ id: WT }),
    });
    const data = await response.json();

    expect(data.success).toBe(true);
    expect(sendSpecialKeys).toHaveBeenCalled();
  });

  it('leaves the capture-failure path exactly where it was', async () => {
    // A negative verdict and an unreadable pane are different things: #287's
    // fallback answers a client-declared prompt when the capture threw, and
    // #2457 must not turn that into a refusal — the gate is only consulted on a
    // frame that came back.
    const { captureSessionOutputFresh } = await import('@/lib/session/cli-session');
    const { sendKeys } = await import('@/lib/tmux/tmux');
    vi.mocked(captureSessionOutputFresh).mockRejectedValue(new Error('tmux capture failed'));

    const response = await promptResponse(createRequest(WT, { answer: 'yes' }), {
      params: Promise.resolve({ id: WT }),
    });
    const data = await response.json();

    expect(data.success).toBe(true);
    expect(sendKeys).toHaveBeenCalledWith(`claude-${WT}`, 'yes', false);
  });
});
