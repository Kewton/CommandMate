/**
 * Issue #4313 (a): Codex 0.167.1 answers `/new` with a "Where should the new
 * conversation run?" picker. The next body must not be typed into it, and the
 * reset brief must not be spent on a body that never arrived.
 *
 * This is a preservation test, not a regression test: the refusal already
 * exists (#1708 guard, run 1 `server.log.txt:6208-6243`), so it is green on the
 * current version. No red was manufactured. What it pins:
 *
 *   - on the live picker frame, `POST /send` answers 409 / PROMPT_WAITING, the
 *     tool's transport is called 0 times and the reset boundary stays pending;
 *   - once a human has chosen (the pane is back at the composer), the body is
 *     typed once, the reset boundary becomes `sent`, and the next body is plain.
 *
 * Real: the migrated DB, the launch, the send route, the send service, the
 * prompt guard and Codex's screen detection. Faked: the tool's `sendMessage`
 * (records what would be typed), the pane capture, tmux ownership, polling.
 *
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import type { NextRequest } from 'next/server';

vi.mock('@/lib/logger', () => ({
  createLogger: () => {
    const quiet = () => undefined;
    return { info: quiet, warn: quiet, error: quiet, debug: quiet, withContext: () => ({ info: quiet, warn: quiet, error: quiet, debug: quiet }) };
  },
}));
vi.mock('@/lib/cli-tools/worktree-session-ownership', () => ({
  checkWorktreeSessionOwnership: vi.fn(async () => ({ verdict: 'owned', sessionPath: null })),
}));
vi.mock('@/lib/cli-tools/session-ownership', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/cli-tools/session-ownership')>()),
  checkSessionOwnership: vi.fn(async () => ({ verdict: 'owned', sessionPath: null })),
}));
vi.mock('@/lib/cli-tools/manager', () => ({
  CLIToolManager: { getInstance: () => ({ getTool: (id: string) => globalThis.__briefTools?.[id] }) },
}));
vi.mock('@/lib/polling/response-poller', () => ({ startPolling: vi.fn(), getActivePollers: () => [] }));
vi.mock('@/lib/assistant-response-saver', () => ({ savePendingAssistantResponse: vi.fn().mockResolvedValue(null) }));
vi.mock('@/lib/ws-server', () => ({ broadcastMessage: vi.fn() }));
vi.mock('@/lib/session/cli-session', () => ({
  captureSessionOutputFresh: vi.fn(async () => ''),
  captureSessionOutput: vi.fn(async () => ''),
  isSessionRunning: vi.fn(async () => true),
}));
vi.mock('@/lib/detection/composer-text', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/detection/composer-text')>()),
  extractComposerText: vi.fn(() => ({ text: '', state: 'empty' })),
}));
vi.mock('@/lib/db/db-instance', () => ({
  getDbInstance: () => globalThis.__briefDb,
  closeDbInstance: () => undefined,
}));

import {
  FAKE_BRIEF,
  WT,
  bindWorld,
  closeWorld,
  fakeProvider,
  launch,
  makeWorld,
  rows,
  send,
  typed,
  type World,
} from '../unit/lib/session/session-brief-4274-harness';
import { resolveSessionName } from '@/lib/cli-tools/session-name';
import { POST as sendRoute } from '@/app/api/worktrees/[id]/send/route';
import { captureSessionOutput } from '@/lib/session/cli-session';
import { PROMPT_WAITING_CODE } from '@/lib/session/prompt-waiting-guard';

const PICKER = readFileSync(path.join(process.cwd(), 'tests/fixtures/codex-new-0167/worktree-picker.txt'), 'utf8');
/** The same pane after a human chose "1. Use current Git worktree": back at the composer. */
const COMPOSER = ['  gpt-5.5 high · ~/work/wt', '', '› Ask Codex to do something', '', '  ? for shortcuts'].join('\n');

let world: World;

function post(body: Record<string, unknown>): Promise<Response> {
  const request = new Request(`http://localhost:3000/api/worktrees/${WT}/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return sendRoute(request as unknown as NextRequest, { params: Promise.resolve({ id: WT }) }) as Promise<Response>;
}

beforeEach(() => {
  world = makeWorld();
  bindWorld(world);
  Object.assign(world.tools.codex, {
    id: 'codex',
    isRunning: async () => true,
    getSessionName: (worktreeId: string, instanceId?: string) => resolveSessionName('codex', worktreeId, instanceId),
  });
  fakeProvider();
  vi.mocked(captureSessionOutput).mockResolvedValue(COMPOSER);
});

afterEach(() => {
  closeWorld(world);
});

async function openResetBoundary(): Promise<void> {
  launch('codex');
  await send('codex', 'first');
  await send('codex', '/new');
}

describe('codex /new worktree picker (Issue #4313 a)', () => {
  it('refuses the body with 409 PROMPT_WAITING; the transport is not called and the reset brief is not spent', async () => {
    await openResetBoundary();
    const typedBefore = typed(world, 'codex').length;
    const pendingBefore = rows(world, 'codex').filter((r) => r.kind === 'reset');
    expect(pendingBefore).toHaveLength(1);
    expect(pendingBefore[0].state).toBe('pending');

    vi.mocked(captureSessionOutput).mockResolvedValue(PICKER);
    const response = await post({ content: 'after the picker', cliToolId: 'codex' });

    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe(PROMPT_WAITING_CODE);
    expect(typed(world, 'codex')).toHaveLength(typedBefore);
    expect(typed(world, 'codex').some((t) => t.includes('after the picker'))).toBe(false);
    expect(rows(world, 'codex').filter((r) => r.kind === 'reset')).toEqual(pendingBefore);
  });

  it('after the human chose, the body is typed once with the reset brief, and the next body is plain', async () => {
    await openResetBoundary();
    vi.mocked(captureSessionOutput).mockResolvedValue(PICKER);
    expect((await post({ content: 'after the picker', cliToolId: 'codex' })).status).toBe(409);

    vi.mocked(captureSessionOutput).mockResolvedValue(COMPOSER);
    const retry = await post({ content: 'after the picker', cliToolId: 'codex' });
    expect(retry.status).toBe(201);
    await send('codex', 'next');

    const bodies = typed(world, 'codex');
    expect(bodies.filter((t) => t.includes('after the picker'))).toEqual([`${FAKE_BRIEF}\n\nafter the picker`]);
    expect(bodies[bodies.length - 1]).toBe('next');
    expect(rows(world, 'codex').find((r) => r.kind === 'reset')).toMatchObject({ state: 'sent' });
  });

  it('control: a composer pane (no picker) is not refused', async () => {
    launch('codex');
    const response = await post({ content: 'plain', cliToolId: 'codex' });
    expect(response.status).toBe(201);
  });
});
