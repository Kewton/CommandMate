/**
 * The steps `handleSend` was split into (Issue #4055), each on its own.
 *
 * The route's behaviour is pinned by the other send-*.test.ts files through
 * POST; these check the step functions directly — what each accepts, and what
 * it answers (status, body) when it refuses.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';
import type { ICLITool } from '@/lib/cli-tools/types';
import { SESSION_STARTING_CODE } from '@/lib/session/session-start-error';
import { FOREIGN_SESSION_ERROR_CODE } from '@/lib/cli-tools/session-ownership';

const isPaneBackAtShell = vi.fn(async (..._args: unknown[]): Promise<boolean> => false);
vi.mock('@/app/api/worktrees/[id]/send/pane-shell', () => ({
  isPaneBackAtShell: (...args: unknown[]) => isPaneBackAtShell(...args),
}));

import {
  validateSendRequest,
  validateSendModel,
} from '@/app/api/worktrees/[id]/send/send-request';
import { judgeTurnOpenAtSend, reserveRelayForSend } from '@/app/api/worktrees/[id]/send/send-relay';
import { refuseModelOnRunningSession } from '@/app/api/worktrees/[id]/send/send-session-start';
import { resolveSendImagePath } from '@/app/api/worktrees/[id]/send/send-image-path';
import { answerSendFailure, type SendFailureInput } from '@/app/api/worktrees/[id]/send/send-failure';

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  runMigrations(db);
  return db;
}

const fakeTool = {
  id: 'codex',
  name: 'Codex CLI',
  getSessionName: (id: string) => `mcbd-codex-${id}`,
} as unknown as ICLITool;

describe('validateSendRequest (Issue #4055)', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = makeDb();
  });
  afterEach(() => {
    db.close();
  });

  it('accepts a body and resolves the named tool, trimming the content', () => {
    const step = validateSendRequest(db, 'wt', { content: '  hello  ', cliToolId: 'codex' });
    expect(step.ok).toBe(true);
    if (!step.ok) return;
    expect(step.value.trimmedContent).toBe('hello');
    expect(step.value.requestedCliToolId).toBe('codex');
    expect(step.value.instanceId).toBeUndefined();
    expect(step.value.target.cliToolId).toBe('codex');
  });

  it('refuses empty content with the 400 the route answered', async () => {
    const step = validateSendRequest(db, 'wt', { content: '   ' });
    expect(step.ok).toBe(false);
    if (step.ok) return;
    const res = await step.response;
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Message content is required and must be a non-empty string' });
  });

  it('refuses an unknown tool and a bad instance id, in that order', async () => {
    const tool = validateSendRequest(db, 'wt', { content: 'x', cliToolId: 'nope' as never, instanceId: 'bad id' });
    expect(tool.ok).toBe(false);
    if (tool.ok) return;
    expect((await (await tool.response).json()).error).toMatch(/^Invalid CLI tool ID/);

    const inst = validateSendRequest(db, 'wt', { content: 'x', instanceId: 'bad id' });
    expect(inst.ok).toBe(false);
    if (inst.ok) return;
    expect((await (await inst.response).json()).error).toMatch(/^Invalid instanceId/);
  });

  it('refuses a model the resolved tool cannot take', async () => {
    const step = validateSendRequest(db, 'wt', { content: 'x', cliToolId: 'codex', model: 'gpt' });
    expect(step.ok).toBe(false);
    if (step.ok) return;
    expect((await step.response).status).toBe(400);
  });
});

describe('validateSendModel (Issue #4055)', () => {
  it('passes no model, for any tool', () => {
    expect(validateSendModel(undefined, 'codex')).toBeNull();
  });

  it('refuses a model for a tool outside copilot / antigravity / claude', async () => {
    const res = validateSendModel('m', 'opencode');
    expect(res?.status).toBe(400);
    expect((await res!.json()).error).toBe('The model parameter is only supported for copilot, antigravity and claude agents');
  });
});

describe('refuseModelOnRunningSession (Issue #4055)', () => {
  it('refuses a model for a running antigravity or claude session', () => {
    expect(refuseModelOnRunningSession('m', 'antigravity', true)?.status).toBe(400);
    expect(refuseModelOnRunningSession('m', 'claude', true)?.status).toBe(400);
  });

  it('lets a start, a copilot session, or no model through', () => {
    expect(refuseModelOnRunningSession('m', 'claude', false)).toBeNull();
    expect(refuseModelOnRunningSession('m', 'copilot', true)).toBeNull();
    expect(refuseModelOnRunningSession(undefined, 'claude', true)).toBeNull();
  });
});

describe('judgeTurnOpenAtSend (Issue #4055)', () => {
  it('answers the reading when the generation held and hooks report turns', () => {
    expect(judgeTurnOpenAtSend({ open: true, generation: 1 }, 1, 1, true)).toBe(true);
    expect(judgeTurnOpenAtSend({ open: false, generation: 1 }, 1, 1, true)).toBe(false);
  });

  it('answers "not known" without hooks, a reading, or with a generation change', () => {
    expect(judgeTurnOpenAtSend({ open: true, generation: 1 }, 1, 1, false)).toBeUndefined();
    expect(judgeTurnOpenAtSend(null, 1, 1, true)).toBeUndefined();
    expect(judgeTurnOpenAtSend({ open: true, generation: 1 }, 1, 2, true)).toBeUndefined();
  });
});

describe('reserveRelayForSend (Issue #4055)', () => {
  const input = { worktreeId: 'wt', cliToolId: 'codex' as const, targetInstanceId: 'codex', instanceId: undefined };

  it('reserves nothing when the body names no relay', () => {
    const db = makeDb();
    try {
      expect(reserveRelayForSend(db, undefined, input)).toEqual({ ok: true, value: null });
    } finally {
      db.close();
    }
  });

  it('refuses a relayId that is not a string with RELAY_BIND_INVALID', async () => {
    const db = makeDb();
    try {
      const step = reserveRelayForSend(db, 42, input);
      expect(step.ok).toBe(false);
      if (step.ok) return;
      const res = await step.response;
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'relayId must be a string', code: 'RELAY_BIND_INVALID' });
    } finally {
      db.close();
    }
  });
});

describe('resolveSendImagePath (Issue #4055)', () => {
  let worktreePath: string;
  beforeEach(() => {
    worktreePath = fs.mkdtempSync(path.join(os.tmpdir(), 'send-split-4055-'));
    fs.mkdirSync(path.join(worktreePath, '.commandmate', 'attachments'), { recursive: true });
    fs.writeFileSync(path.join(worktreePath, '.commandmate', 'attachments', 'a.png'), '');
    fs.writeFileSync(path.join(worktreePath, 'outside.png'), '');
  });
  afterEach(() => {
    fs.rmSync(worktreePath, { recursive: true, force: true });
  });

  it('resolves an attachment to its absolute path, and no imagePath to undefined', () => {
    const step = resolveSendImagePath('.commandmate/attachments/a.png', worktreePath);
    expect(step).toEqual({ ok: true, value: path.resolve(worktreePath, '.commandmate/attachments/a.png') });
    expect(resolveSendImagePath(undefined, worktreePath)).toEqual({ ok: true, value: undefined });
  });

  it('refuses a URL scheme and a file outside the attachments directory', async () => {
    const scheme = resolveSendImagePath('https://example.com/a.png', worktreePath);
    expect(scheme.ok).toBe(false);
    if (scheme.ok) return;
    expect(await scheme.response.json()).toEqual({ error: 'URL schemes are not allowed in imagePath', code: 'INVALID_PATH' });

    const outside = resolveSendImagePath('outside.png', worktreePath);
    expect(outside.ok).toBe(false);
    if (outside.ok) return;
    expect(await outside.response.json()).toEqual({
      error: 'imagePath must be within .commandmate/attachments/',
      code: 'INVALID_PATH',
    });
  });
});

describe('answerSendFailure (Issue #4055)', () => {
  const base: SendFailureInput = {
    cliTool: fakeTool,
    worktreeId: 'wt',
    instanceId: undefined,
    model: 'm1',
    sendAttemptInstance: { worktreeId: 'wt-4055-none', cliToolId: 'codex', instanceId: 'codex' },
    ownAttempt: null,
    sendStartedAt: Date.now(),
    trimmedContent: 'hello',
  };

  it('maps foreign_session to 409 with its code', async () => {
    const foreign = await answerSendFailure({ stage: 'foreign_session', error: 'theirs' }, base);
    expect(foreign.status).toBe(409);
    expect(await foreign.json()).toEqual({ error: 'theirs', code: FOREIGN_SESSION_ERROR_CODE });
  });

  it('answers a start still coming up as 503 SESSION_STARTING', async () => {
    isPaneBackAtShell.mockResolvedValueOnce(false);
    const res = await answerSendFailure(
      { stage: 'send', error: 'starting', code: SESSION_STARTING_CODE },
      base,
    );
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'starting', code: SESSION_STARTING_CODE });
  });

  it('names the model of a failed switch, and adds the own attempt to a failed send', async () => {
    const model = await answerSendFailure({ stage: 'model', error: 'no' }, base);
    expect(model.status).toBe(500);
    expect((await model.json()).error).toBe('Failed to switch model to m1: no');

    const bare = await answerSendFailure({ stage: 'send', error: 'boom' }, base);
    expect((await bare.json()).error).toBe('Failed to send message to Codex CLI: boom');

    const own = await answerSendFailure(
      { stage: 'send', error: 'boom' },
      { ...base, ownAttempt: { state: 'not-sent', reason: 'send-failed' } },
    );
    const ownError: string = (await own.json()).error;
    expect(ownError.startsWith('Failed to send message to Codex CLI: boom ')).toBe(true);
    expect(ownError.length).toBeGreaterThan('Failed to send message to Codex CLI: boom '.length);
  });
});
