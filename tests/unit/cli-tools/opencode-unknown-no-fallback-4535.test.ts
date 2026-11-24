/**
 * Issue #4535 PR-A1 (design `docs/design/send-outcome-4535.md` §2.3・§3.2・§5.2
 * T1〜T6, INV-S1・INV-F2): after an OpenCode dispatch whose outcome is
 * `unknown`, the sender types no key and posts no second HTTP dispatch — the
 * message may already be in. `not_sent` (a 4xx, the SPA shell, a read-back that
 * is 404 for the whole ladder) still falls back as before.
 *
 * The footing is #4534's (`../guards/send-fence-process`): real from the route
 * down — the send route, the send service, the fence, the OpenCode driver and
 * its client, `tmux.ts`; fake: the process boundary (every tmux call is
 * recorded, a change is a `send-keys`), `fetch` (OpenCode's loopback server)
 * and the port / subscription tables. The pane shows an EMPTY input box the
 * whole time (`buildOpencodeComposerFrame`): without it the keyboard fallback
 * refuses on its own and types nothing even before the fix (#4040).
 *
 * Before the fix (red): T1・T3・T5 and the 404 rows type the body; T2 posts a
 * second dispatch (the path fallback). The controls (`control:`) and the fence
 * row are green on both sides.
 *
 * Nothing here reaches a real opencode, tmux or the developer's home: HOME is a
 * fresh `os.tmpdir()` directory, removed after the file.
 *
 * @vitest-environment node
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('child_process', async () => (await import('../guards/send-fence-process')).fakeChildProcess());
vi.mock('@/lib/db/db-instance', () => {
  let current: unknown = null;
  return {
    getDbInstance: () => {
      if (current === null) throw new Error('no test db');
      return current;
    },
    setTestDb: (db: unknown) => {
      current = db;
    },
    closeDbInstance: () => {
      current = null;
    },
  };
});
vi.mock('@/lib/polling/response-poller', () => ({ startPolling: vi.fn(), getActivePollers: vi.fn(() => []) }));
vi.mock('@/lib/assistant-response-saver', () => ({ savePendingAssistantResponse: vi.fn().mockResolvedValue(null) }));
vi.mock('@/lib/ws-server', () => ({ broadcastMessage: vi.fn() }));
vi.mock('@/lib/realtime/terminal-broadcast', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/realtime/terminal-broadcast')>()),
  broadcastSessionStatus: vi.fn(),
}));
vi.mock('@/lib/git/git-utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/git/git-utils')>()),
  getGitStatus: vi.fn(async () => {
    throw new Error('not a repository');
  }),
}));
vi.mock('@/lib/relay/relay-readiness', () => ({ findRelayHoldReason: vi.fn(async () => null) }));
vi.mock('@/lib/cli-tools/opencode-config', () => ({ ensureOpencodeConfig: vi.fn() }));
vi.mock('@/lib/hooks/sources/opencode/ports', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/hooks/sources/opencode/ports')>()),
  getAssignedOpencodePort: vi.fn(),
}));
vi.mock('@/lib/hooks/sources/opencode/subscription', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/hooks/sources/opencode/subscription')>()),
  getOpencodeLiveness: vi.fn(),
  getOpencodePrimarySession: vi.fn(),
}));
// INV-F2: the dispatch's own confirmation is counted (it still runs the real one).
vi.mock('@/lib/session/terminal-fence', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/session/terminal-fence')>();
  return { ...actual, fenceConfirmDispatch: vi.fn(actual.fenceConfirmDispatch) };
});

import type { NextRequest } from 'next/server';
import { runMigrations } from '@/lib/db/db-migrations';
import { upsertWorktree } from '@/lib/db';
import type { Worktree } from '@/types/models';
import { resolveSessionName } from '@/lib/cli-tools/session-name';
import { addPane, fakeFetch, gateObserver, resetWorld, world, type Out } from '../guards/send-fence-process';
import { fenceConfirmDispatch, resetFenceForTests, setFenceObserver } from '@/lib/session/terminal-fence';
import { resetInstanceInputLocks } from '@/lib/session/instance-input-lock';
import { classifySendFailure, clearSendAttempts, getLastSendAttempt } from '@/lib/session/send-attempt-state';
import { getAssignedOpencodePort } from '@/lib/hooks/sources/opencode/ports';
import { getOpencodeLiveness, getOpencodePrimarySession } from '@/lib/hooks/sources/opencode/subscription';
import { sendOpencodePrompt } from '@/lib/hooks/sources/opencode/client';
import { OPENCODE_SEND_READBACK_DELAYS_MS, type OpenCodeTool } from '@/lib/cli-tools/opencode';
import { CLIToolManager } from '@/lib/cli-tools/manager';
import { resetRelayDeliveryState } from '@/lib/relay/relay-delivery';
import { resetSessionLaunchFlightsForTest } from '@/lib/session/session-launch-flight';
import { isOpenCodeComposerReady } from '@/lib/detection/tools/opencode/readiness';
import { registerIsolatedAgentHooksDir } from '@tests/helpers/agent-hooks-dir';
import { buildOpencodeComposerFrame } from '@tests/fixtures/opencode-launch-boot-11821';

registerIsolatedAgentHooksDir('opencode-unknown-4535');

const WT = 'wt-opencode-unknown-4535';
const PORT = 4835;
const SESSION = 'ses_unknown4535';
const NOW = Date.now();
let home = '';
let wtPath = '';
let db: Database.Database;
const previousHome = process.env.HOME;
const originalFetch = globalThis.fetch;

beforeAll(() => {
  // Nothing here may reach the developer's own home (~/.local/share/opencode …).
  home = mkdtempSync(join(tmpdir(), 'opencode-unknown-4535-home-'));
  wtPath = mkdtempSync(join(tmpdir(), 'opencode-unknown-4535-wt-'));
  process.env.HOME = home;
});
afterAll(() => {
  process.env.HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
  rmSync(wtPath, { recursive: true, force: true });
});

beforeEach(async () => {
  resetWorld();
  world.path = wtPath;
  resetFenceForTests();
  resetInstanceInputLocks();
  resetRelayDeliveryState();
  resetSessionLaunchFlightsForTest();
  clearSendAttempts();
  setFenceObserver(gateObserver);
  const fence = await vi.importActual<typeof import('@/lib/session/terminal-fence')>('@/lib/session/terminal-fence');
  vi.mocked(fenceConfirmDispatch).mockReset().mockImplementation(fence.fenceConfirmDispatch);
  vi.mocked(getAssignedOpencodePort).mockReturnValue(PORT);
  vi.mocked(getOpencodeLiveness).mockReturnValue({ state: 'live', lastHeartbeatAt: 1 } as never);
  vi.mocked(getOpencodePrimarySession).mockReturnValue(SESSION);
  db = new Database(':memory:');
  runMigrations(db);
  const instance = (await import('@/lib/db/db-instance')) as unknown as { setTestDb: (d: unknown) => void };
  instance.setTestDb(db);
  upsertWorktree(db, { id: WT, name: WT, path: wtPath, repositoryPath: wtPath, repositoryName: 'repo', cliToolId: 'claude' } as Worktree);
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  setFenceObserver(null);
  resetRelayDeliveryState();
  db.close();
});

// ---------------------------------------------------------------------------
// The world: one opencode instance with a live server and an empty input box
// ---------------------------------------------------------------------------

type Answer = Record<string, unknown>;
const json = (status: number, body: unknown = {}): Answer => ({
  ok: status >= 200 && status < 300,
  status,
  headers: new Headers({ 'content-type': 'application/json' }),
  json: async () => body,
});
const ACCEPTED: Answer = { ok: true, status: 204, headers: new Headers(), json: async () => undefined };
const MISSING: Answer = json(404, { name: 'NotFoundError' });
const found = (text: string): Answer => json(200, { info: { id: 'msg', role: 'user' }, parts: [{ type: 'text', text }] });
const noAnswer = (): never => {
  throw new TypeError('fetch failed');
};

interface Server {
  /** `prompt_async` POSTs, in order. */
  posts: () => number;
  /** Read-backs (`GET …/message/:id`), in order. */
  gets: () => number;
  /** What each POST carried as its first text part. */
  postedTexts: () => string[];
}

/**
 * The instance `instanceId` on the roster, its pane up with an empty input box,
 * and its server answering POSTs with `post(n)` (n from 0) and read-backs with
 * `reads[n]` (the last one repeats).
 */
function liveOpencode(instanceId: string, post: (n: number) => Answer, reads: readonly Answer[] = [found('')]): Server {
  db.prepare(
    `INSERT INTO agent_instances (worktree_id, instance_id, cli_tool_id, alias, sort_order, created_at) VALUES (?, ?, 'opencode', '', 0, ?)`,
  ).run(WT, instanceId, NOW);
  const S = resolveSessionName('opencode', WT, instanceId);
  addPane(S, 'opencode');
  world.frame = (s) => (s === S ? buildOpencodeComposerFrame() : null);
  let posts = 0;
  let gets = 0;
  const texts: string[] = [];
  globalThis.fetch = fakeFetch((_url, init) => {
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as { parts: Array<{ text?: string }> };
      texts.push(body.parts[0]?.text ?? '');
      return post(posts++);
    }
    return reads[Math.min(gets++, reads.length - 1)];
  });
  return { posts: () => posts, gets: () => gets, postedTexts: () => [...texts] };
}

const dropRoster = (instanceId: string): void => {
  db.prepare(`DELETE FROM agent_instances WHERE worktree_id = ? AND instance_id = ?`).run(WT, instanceId);
};

/** Run `action` once, right after the first call `when` matches. */
function onFirst(when: (o: Out) => boolean, action: () => void): void {
  let done = false;
  const inner = world.onCall;
  world.onCall = (o) => {
    inner(o);
    if (!done && when(o)) {
      done = true;
      action();
    }
  };
}

/** The `send-keys` of the body (`-l -- <body>`), however many: what the keyboard fallback typed. */
const typed = (body: string): string[] =>
  world.out.filter((o) => o.cls === 'change' && o.line.startsWith('send-keys') && o.line.includes(body)).map((o) => o.line);

async function postSend(body: Record<string, unknown>): Promise<{ status: number; json: Record<string, unknown> }> {
  const { POST } = await import('@/app/api/worktrees/[id]/send/route');
  const request = new Request(`http://localhost:3000/api/worktrees/${WT}/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const response = (await POST(request as unknown as NextRequest, { params: Promise.resolve({ id: WT }) })) as Response;
  return { status: response.status, json: (await response.json()) as Record<string, unknown> };
}

const send = (instanceId: string, content: string) => postSend({ content, cliToolId: 'opencode', instanceId });
const lastSend = (instanceId: string) => getLastSendAttempt({ worktreeId: WT, cliToolId: 'opencode', instanceId } as never);
const opencodeTool = (): OpenCodeTool => CLIToolManager.getInstance().getTool('opencode') as unknown as OpenCodeTool;

/** What a tool-level send threw (undefined when it resolved). */
async function thrownBy(run: Promise<void>): Promise<unknown> {
  try {
    await run;
    return undefined;
  } catch (error) {
    return error;
  }
}

/** The answer of a send the sender stopped after an `unknown` dispatch (C8): no key, one POST, unknown. */
function expectStoppedUnknown(answer: { status: number; json: Record<string, unknown> }, server: Server, body: string, instanceId: string): void {
  expect(typed(body), 'the keyboard fallback typed the body after an unknown dispatch').toEqual([]);
  expect(server.posts(), 'a second HTTP dispatch after an unknown one').toBe(1);
  expect(answer.status).toBe(500);
  expect(answer.json.sendOutcome).toBe('unknown');
  expect(lastSend(instanceId)).toMatchObject({ state: 'indeterminate' });
}

// ---------------------------------------------------------------------------
// T1〜T5
// ---------------------------------------------------------------------------

describe('Issue #4535 R1: an unknown OpenCode dispatch is followed by nothing', () => {
  it('precondition: the pane shows an empty input box (the keyboard would type into it)', () => {
    expect(isOpenCodeComposerReady(buildOpencodeComposerFrame())).toBe(true);
  });

  it('R1: the first dispatch drops before the answer — no second HTTP, no keys', async () => {
    const server = liveOpencode('opencode-t1', noAnswer);
    const answer = await send('opencode-t1', 'body t1 drop');
    expectStoppedUnknown(answer, server, 'body t1 drop', 'opencode-t1');
    expect(server.gets()).toBe(0);
  }, 60_000);

  it('R1: an image dispatch unknown — the path fallback is not dispatched', async () => {
    const server = liveOpencode('opencode-t2', noAnswer);
    const error = await thrownBy(opencodeTool().sendMessageWithImage(WT, 'body t2 look', '/tmp/x-4535.png', 'opencode-t2'));
    expect(server.posts(), 'the path fallback posted a second dispatch').toBe(1);
    expect(typed('body t2 look')).toEqual([]);
    expect(error).toBeInstanceOf(Error);
    expect(classifySendFailure(error).state).toBe('indeterminate');
  }, 60_000);

  it('C7: the stop after an unknown dispatch is recorded as lastSend.reason dispatch-unknown', async () => {
    const server = liveOpencode('opencode-c7', noAnswer);
    const answer = await send('opencode-c7', 'body c7 reason');
    expectStoppedUnknown(answer, server, 'body c7 reason', 'opencode-c7');
    expect(lastSend('opencode-c7')).toMatchObject({ state: 'indeterminate', reason: 'dispatch-unknown' });
    // The image path's stop is read the same way.
    const image = liveOpencode('opencode-c7-image', noAnswer);
    const error = await thrownBy(opencodeTool().sendMessageWithImage(WT, 'body c7 look', '/tmp/x-4535.png', 'opencode-c7-image'));
    expect(image.posts()).toBe(1);
    expect(classifySendFailure(error)).toEqual({ state: 'indeterminate', reason: 'dispatch-unknown' });
  }, 60_000);

  it('R1: a read-back mismatch — nothing typed, indeterminate', async () => {
    const server = liveOpencode('opencode-t3', () => ACCEPTED, [found('something else')]);
    const answer = await send('opencode-t3', 'body t3 mismatch');
    expectStoppedUnknown(answer, server, 'body t3 mismatch', 'opencode-t3');
  }, 60_000);

  it('control: a refused POST (4xx) still falls back to the keyboard', async () => {
    const server = liveOpencode('opencode-t4a', () => json(400, { name: 'BadRequest' }));
    await send('opencode-t4a', 'body t4 refused');
    expect(server.posts()).toBe(1);
    expect(typed('body t4 refused').length).toBeGreaterThan(0);
  }, 60_000);

  it('control: a read-back 404 to the end of the ladder still falls back', async () => {
    const server = liveOpencode('opencode-t4b', () => ACCEPTED, [MISSING]);
    await send('opencode-t4b', 'body t4 discarded');
    expect(server.posts()).toBe(1);
    expect(typed('body t4 discarded').length).toBeGreaterThan(0);
  }, 60_000);

  it('a read-back 404 then found is delivered — no keys', async () => {
    const server = liveOpencode('opencode-t4c', () => ACCEPTED, [MISSING, found('body t4 late')]);
    const answer = await send('opencode-t4c', 'body t4 late');
    expect(typed('body t4 late'), 'the first 404 was read as "not there" and the body typed').toEqual([]);
    expect(server.gets()).toBe(2);
    expect(answer.status).toBe(201);
    expect(lastSend('opencode-t4c')).toMatchObject({ state: 'sent' });
  }, 60_000);

  it('a read-back mixing 404 and 500 is unknown — no keys', async () => {
    const server = liveOpencode('opencode-t4d', () => ACCEPTED, [MISSING, json(500), MISSING, MISSING]);
    const answer = await send('opencode-t4d', 'body t4 mixed');
    expectStoppedUnknown(answer, server, 'body t4 mixed', 'opencode-t4d');
    expect(server.gets()).toBe(OPENCODE_SEND_READBACK_DELAYS_MS.length);
  }, 60_000);

  it.each([
    ['500', 500],
    ['503', 503],
    ['302 (a redirect, not an answer of the route)', 302],
  ])('a 5xx answer is unknown — no keys (%s)', async (_label, status) => {
    const id = `opencode-t5-${status}`;
    const server = liveOpencode(id, () => ({ ...json(status), headers: new Headers({ 'content-type': 'application/json', location: 'http://127.0.0.1:1/' }) }));
    const answer = await send(id, `body t5 ${status}`);
    expectStoppedUnknown(answer, server, `body t5 ${status}`, id);
    expect(server.gets()).toBe(0);
  }, 60_000);

  it.each([
    ['500 is unknown', 500, 'application/json', 'unknown'],
    ['302 is unknown', 302, 'text/html', 'unknown'],
    ['400 is rejected (not_sent)', 400, 'application/json', 'rejected'],
    ['200 text/html (the SPA shell) is rejected', 200, 'text/html', 'rejected'],
  ])('Q5: sendOpencodePrompt — %s', async (_label, status, type, verdict) => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: status < 300, status, headers: new Headers({ 'content-type': type }) }) as unknown as typeof fetch;
    await expect(sendOpencodePrompt(PORT, SESSION, 'msg_x', [{ type: 'text', text: 'x' }])).resolves.toBe(verdict);
  });
});

// ---------------------------------------------------------------------------
// INV-S1 (not_sent is unchanged) and INV-F2 (the fence first)
// ---------------------------------------------------------------------------

describe('Issue #4535 INV-S1・INV-F2: what not_sent and the fence still do', () => {
  it('control: an image dispatch refused (4xx) — the path fallback posts its second dispatch, confirmed first', async () => {
    const order: string[] = [];
    const fence = await vi.importActual<typeof import('@/lib/session/terminal-fence')>('@/lib/session/terminal-fence');
    vi.mocked(fenceConfirmDispatch).mockImplementation((...args) => {
      order.push('confirm');
      fence.fenceConfirmDispatch(...args);
    });
    const server = liveOpencode('opencode-f1', (n) => {
      order.push(`post${n + 1}`);
      return n === 0 ? json(400, { name: 'BadRequest' }) : ACCEPTED;
    }, [found('body f1 look\n\n[添付画像: /tmp/x-4535.png]')]);
    const error = await thrownBy(opencodeTool().sendMessageWithImage(WT, 'body f1 look', '/tmp/x-4535.png', 'opencode-f1'));
    expect(error).toBeUndefined();
    expect(server.posts()).toBe(2);
    expect(server.postedTexts()[1]).toBe('body f1 look\n\n[添付画像: /tmp/x-4535.png]');
    expect(order).toEqual(['confirm', 'post1', 'confirm', 'post2']);
    expect(typed('body f1 look')).toEqual([]);
  }, 60_000);

  it('fence: a refusal of the fence during the dispatch stays SEND_TARGET_CHANGED — not dispatch-unknown', async () => {
    const server = liveOpencode('opencode-f2', noAnswer);
    // The instance leaves the roster while its POST is out, and the POST gets no answer.
    onFirst((o) => o.via === 'fetch' && o.line.startsWith('POST'), () => dropRoster('opencode-f2'));
    const answer = await send('opencode-f2', 'body f2 fence');
    expect(answer.status).toBe(409);
    expect(answer.json.code).toBe('SEND_TARGET_CHANGED');
    expect(answer.json.reason).toBe('target-gone');
    // A dispatch had started: #4534 answers unknown, never not_sent.
    expect(answer.json.sendOutcome).toBe('unknown');
    expect(lastSend('opencode-f2')).toMatchObject({ state: 'indeterminate', reason: 'target-changed' });
    expect(server.posts()).toBe(1);
    expect(typed('body f2 fence')).toEqual([]);
  }, 60_000);
});
