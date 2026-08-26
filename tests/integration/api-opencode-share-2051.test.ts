/**
 * `GET` / `POST` / `DELETE /api/worktrees/:id/opencode/share` (Issue #2051).
 *
 * This is the route that publishes a conversation to the public internet, so
 * the tests that matter most are the ones about *not* doing it. Three
 * properties carry the whole design, and each is a measurement against opencode
 * 1.18.22 (`docs/design/opencode-server-live-verification.md` §23):
 *
 *  1. **The config gate happens before the publish, not after.** With
 *     `share: "disabled"` configured, opencode answers `POST /share` with a bare
 *     HTTP 500 carrying no code, so a refusal cannot be recognised afterwards.
 *     The route therefore asks `GET /config` first and refuses locally, and the
 *     assertion below is that opencode's share route is **never called**.
 *  2. **An unset `share` key is not `disabled`.** `GET /config` omits the key
 *     unless it was configured, and conflating the two would disable the
 *     feature on every default installation.
 *  3. **`DELETE` does not echo the URL back.** opencode keeps `share: { url }`
 *     on the session for ever after an unshare, and a response that repeated it
 *     would be how a UI comes to show a revoked page as live.
 *
 * The opencode HTTP client is driven through a stubbed `fetch`, so no server is
 * contacted and nothing can be published from a test run.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';
import { upsertWorktree } from '@/lib/db';
import { setAgentInstances } from '@/lib/db/agent-instances-db';
import type { Worktree } from '@/types/models';

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
    setMockDb: (db: Database.Database) => {
      mockDb = db;
    },
    closeDbInstance: () => {
      if (mockDb) {
        mockDb.close();
        mockDb = null;
      }
    },
  };
});

const portMock = vi.hoisted(() => vi.fn<() => number | null>());
vi.mock('@/lib/hooks/sources/opencode/ports', () => ({
  getAssignedOpencodePort: () => portMock(),
}));

const sessionIdMock = vi.hoisted(() => vi.fn<() => Promise<string | null>>());
vi.mock('@/lib/session/opencode-session-recall', () => ({
  resolveOpencodeCurrentSessionId: () => sessionIdMock(),
}));

vi.mock('@/lib/session/opencode-session-store', () => ({
  getRememberedOpencodeSession: () => null,
}));

import { DELETE, GET, POST } from '@/app/api/worktrees/[id]/opencode/share/route';
import { NextRequest } from 'next/server';

const WT = 'wt-2051-api';
const PORT = 4877;
const SESSION = 'ses_fc35f3dadffe2uirJpjJBtxFhy';
const SHARE_URL = 'https://opncd.ai/share/jJBtxFhy';

/** A `Session` body shaped like the one `POST /share` was measured to return. */
const SHARED_SESSION = {
  id: SESSION,
  slug: 'mighty-planet',
  directory: '/tmp/probe/clean',
  share: { url: SHARE_URL },
  title: 'probe',
};

/** A fresh promise per call — Next hands the route a new one each time. */
function params() {
  return { params: Promise.resolve({ id: WT }) };
}

function request(method: string, options: { body?: unknown; query?: string } = {}): NextRequest {
  const url = `http://localhost:3000/api/worktrees/${WT}/opencode/share${options.query ?? ''}`;
  // `NextRequest`'s own init type, not the DOM `RequestInit`: its `signal` is
  // not nullable and the two are not assignable.
  const init: ConstructorParameters<typeof NextRequest>[1] = { method };
  if (options.body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = JSON.stringify(options.body);
  }
  // A real NextRequest, not a cast Request: the route reads `nextUrl`, which
  // only the former has.
  return new NextRequest(url, init);
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

let fetchMock: ReturnType<typeof vi.fn>;

/**
 * Stub the opencode server.
 *
 * @param config - what `GET /config` answers
 * @param share - what `POST` / `DELETE /session/:id/share` answers
 */
function stubOpencode(options: { config?: unknown; share?: Response } = {}) {
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const target = String(url);
    if (target.endsWith('/config')) return json(options.config ?? {});
    if (target.endsWith('/share')) {
      return options.share !== undefined
        ? options.share.clone()
        : json(SHARED_SESSION);
    }
    if (target.includes('/session/')) return json(SHARED_SESSION);
    throw new Error(`unexpected request: ${init?.method ?? 'GET'} ${target}`);
  });
  vi.stubGlobal('fetch', fetchMock);
}

/** Every call the stub saw against opencode's own share route. */
function shareCalls(): [string, RequestInit | undefined][] {
  return (fetchMock.mock.calls as [string, RequestInit | undefined][]).filter(([url]) =>
    String(url).endsWith('/share')
  );
}

describe('/api/worktrees/:id/opencode/share (Issue #2051)', () => {
  let db: Database.Database;

  beforeEach(async () => {
    db = new Database(':memory:');
    runMigrations(db);
    const { setMockDb } = await import('@/lib/db/db-instance');
    setMockDb(db);

    const worktree: Worktree = {
      id: WT,
      name: WT,
      path: `/tmp/${WT}`,
      repositoryPath: '/tmp/repo',
      repositoryName: 'repo',
      cliToolId: 'opencode',
    };
    upsertWorktree(db, worktree);
    setAgentInstances(db, WT, [
      { id: 'opencode', cliTool: 'opencode', alias: '', order: 0 },
      { id: 'opencode-2', cliTool: 'opencode', alias: '', order: 1 },
      { id: 'claude', cliTool: 'claude', alias: '', order: 2 },
    ]);

    portMock.mockReturnValue(PORT);
    sessionIdMock.mockResolvedValue(SESSION);
    stubOpencode({ config: { share: 'manual' } });
  });

  afterEach(async () => {
    const { closeDbInstance } = await import('@/lib/db/db-instance');
    closeDbInstance();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  describe('GET', () => {
    it('reports canShare for a live instance whose config allows it', async () => {
      const response = await GET(request('GET'), params());
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        instanceId: 'opencode',
        shareMode: 'manual',
        canShare: true,
        sessionId: SESSION,
      });
    });

    it('reports canShare: false when the config disables sharing', async () => {
      stubOpencode({ config: { share: 'disabled' } });
      const response = await GET(request('GET'), params());
      await expect(response.json()).resolves.toMatchObject({
        shareMode: 'disabled',
        canShare: false,
      });
    });

    it('reports canShare: true when the config has no share key at all', async () => {
      // Measured: `GET /config` omits `share` unless it was set. Absent is not
      // `disabled`, and the UI gate reads only the latter.
      stubOpencode({ config: { model: 'github-copilot/claude-sonnet-4.6' } });
      const response = await GET(request('GET'), params());
      await expect(response.json()).resolves.toMatchObject({
        shareMode: null,
        canShare: true,
      });
    });

    it('reports canShare: false when the instance has no server', async () => {
      portMock.mockReturnValue(null);
      const response = await GET(request('GET'), params());
      await expect(response.json()).resolves.toMatchObject({
        canShare: false,
        sessionId: null,
      });
    });

    it('reports canShare: false when there is no session yet', async () => {
      sessionIdMock.mockResolvedValue(null);
      const response = await GET(request('GET'), params());
      await expect(response.json()).resolves.toMatchObject({
        canShare: false,
        sessionId: null,
      });
    });

    it('names the URL lastShareUrl, because it survives an unshare', async () => {
      const response = await GET(request('GET'), params());
      await expect(response.json()).resolves.toMatchObject({ lastShareUrl: SHARE_URL });
    });

    it('targets the instance the query names', async () => {
      const response = await GET(request('GET', { query: '?instance=opencode-2' }), params());
      await expect(response.json()).resolves.toMatchObject({ instanceId: 'opencode-2' });
    });

    it('rejects an instance that is not an opencode', async () => {
      const response = await GET(request('GET', { query: '?instance=claude' }), params());
      expect(response.status).toBe(400);
    });

    it('404s for a worktree that does not exist', async () => {
      const response = await GET(request('GET'), {
        params: Promise.resolve({ id: 'wt-missing' }),
      });
      expect(response.status).toBe(404);
    });
  });

  describe('POST', () => {
    it('publishes and returns the URL opencode minted', async () => {
      const response = await POST(request('POST', { body: {} }), params());
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ sessionId: SESSION, url: SHARE_URL });
    });

    it('never calls opencode\'s share route when the config disables sharing', async () => {
      // The load-bearing assertion of this file. opencode's refusal is an
      // undecodable 500, so the gate has to be here — and "returned 409" is not
      // proof it fired. "Did not publish" is.
      stubOpencode({ config: { share: 'disabled' } });

      const response = await POST(request('POST', { body: {} }), params());

      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toMatchObject({ code: 'SHARE_DISABLED' });
      expect(shareCalls()).toHaveLength(0);
    });

    it('publishes when the config has no share key', async () => {
      stubOpencode({ config: {} });
      const response = await POST(request('POST', { body: {} }), params());
      expect(response.status).toBe(200);
      expect(shareCalls()).toHaveLength(1);
    });

    it('409s without publishing when the instance has no server', async () => {
      portMock.mockReturnValue(null);
      const response = await POST(request('POST', { body: {} }), params());
      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toMatchObject({ code: 'NO_OPENCODE_PORT' });
      expect(shareCalls()).toHaveLength(0);
    });

    it('409s without publishing when there is no session', async () => {
      sessionIdMock.mockResolvedValue(null);
      const response = await POST(request('POST', { body: {} }), params());
      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toMatchObject({ code: 'NO_OPENCODE_SESSION' });
      expect(shareCalls()).toHaveLength(0);
    });

    it('502s when opencode refuses for a reason it does not name', async () => {
      // The measured disabled-in-config body, reached with `share` unset — i.e.
      // a 500 the gate above could not have predicted.
      stubOpencode({
        config: { share: 'manual' },
        share: json(
          { name: 'UnknownError', data: { message: 'Unexpected server error.', ref: 'err_x' } },
          500
        ),
      });

      const response = await POST(request('POST', { body: {} }), params());

      expect(response.status).toBe(502);
      await expect(response.json()).resolves.toMatchObject({ code: 'SHARE_REFUSED' });
    });

    it('rejects an instance that is not an opencode without publishing', async () => {
      const response = await POST(request('POST', { body: { instanceId: 'claude' } }), params());
      expect(response.status).toBe(400);
      expect(shareCalls()).toHaveLength(0);
    });

    it('rejects a malformed instanceId without publishing', async () => {
      const response = await POST(
        request('POST', { body: { instanceId: '../../etc/passwd' } }),
        params()
      );
      expect(response.status).toBe(400);
      expect(shareCalls()).toHaveLength(0);
    });

    it('404s for a worktree that does not exist without publishing', async () => {
      const response = await POST(request('POST', { body: {} }), {
        params: Promise.resolve({ id: 'wt-missing' }),
      });
      expect(response.status).toBe(404);
      expect(shareCalls()).toHaveLength(0);
    });
  });

  describe('DELETE', () => {
    it('revokes and reports it', async () => {
      const response = await DELETE(request('DELETE'), params());
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ sessionId: SESSION, removed: true });

      const [url, init] = shareCalls()[0];
      expect(String(url)).toBe(`http://127.0.0.1:${PORT}/session/${SESSION}/share`);
      expect(init?.method).toBe('DELETE');
    });

    it('does not echo back the URL opencode still records', async () => {
      // Measured: the session keeps `share: { url }` after the unshare, and
      // across a server restart. Repeating it here is how a UI ends up showing
      // a revoked page as live.
      const response = await DELETE(request('DELETE'), params());
      const body = (await response.json()) as Record<string, unknown>;
      expect(body).not.toHaveProperty('url');
      expect(body).not.toHaveProperty('lastShareUrl');
      expect(JSON.stringify(body)).not.toContain('opncd.ai');
    });

    it('does not consult the config, so a disabled server can still revoke', async () => {
      // A page published before sharing was turned off must remain revocable.
      stubOpencode({ config: { share: 'disabled' } });

      const response = await DELETE(request('DELETE'), params());

      expect(response.status).toBe(200);
      const configCalls = (fetchMock.mock.calls as [string][]).filter(([url]) =>
        String(url).endsWith('/config')
      );
      expect(configCalls).toHaveLength(0);
    });

    it('502s when opencode refuses the revocation', async () => {
      stubOpencode({ config: { share: 'manual' }, share: json({ name: 'UnknownError' }, 500) });
      const response = await DELETE(request('DELETE'), params());
      expect(response.status).toBe(502);
    });

    it('409s when the instance has no server', async () => {
      portMock.mockReturnValue(null);
      const response = await DELETE(request('DELETE'), params());
      expect(response.status).toBe(409);
    });
  });
});
