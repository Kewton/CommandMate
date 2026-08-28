/**
 * `GET /config`, `POST /session/:id/share`, `DELETE /session/:id/share` (Issue #2051).
 *
 * Every body and status below is a verbatim capture from opencode 1.18.22 in an
 * isolated HOME; the record is `docs/design/opencode-server-live-verification.md`
 * §23. Three of them are counter-intuitive enough to be the reason this suite
 * exists:
 *
 *  - Publishing with `share: "disabled"` configured is a bare **HTTP 500
 *    `UnknownError`**, not a 4xx and not a coded refusal. `shareOpencodeSession`
 *    must not report that as anything more specific than "refused", because
 *    nothing in the response says what it was.
 *  - `DELETE` answers **200 with the `share` object still on the session.** A
 *    reader that took the response body as the new state would conclude the page
 *    was still up.
 *  - The URL is `https://opncd.ai/share/<last 8 of the session id>`. The Issue
 *    body says `opncd.ai/s/<id>`; that spelling does not exist on 1.18.22.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  fetchOpencodeSessionShareUrl,
  fetchOpencodeShareMode,
  shareOpencodeSession,
  unshareOpencodeSession,
} from '@/lib/hooks/sources/opencode/client';

const PORT = 4877;
const SESSION = 'ses_fc35f3dadffe2uirJpjJBtxFhy';
const SHARE_URL = 'https://opncd.ai/share/jJBtxFhy';

/** The `Session` body `POST /share` was measured to return. */
const SHARED_SESSION = {
  id: SESSION,
  slug: 'mighty-planet',
  projectID: 'b9c6689833917e81595fe1c975d4eee402ee6bc1',
  directory: '/tmp/probe/clean',
  path: '',
  share: { url: SHARE_URL },
  title: 'SHARE-PROBE-2051',
  agent: 'build',
  version: '1.18.22',
};

/** The 500 body opencode sends when sharing is disabled in its configuration. */
const DISABLED_ERROR = {
  name: 'UnknownError',
  data: {
    message: 'Unexpected server error. Check server logs for details.',
    ref: 'err_b14ff12c',
  },
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchOpencodeShareMode', () => {
  it('reads the captured GET /config of a server with sharing disabled', async () => {
    fetchMock.mockResolvedValue(
      json({
        $schema: 'https://opencode.ai/config.json',
        command: {},
        plugin: [],
        share: 'disabled',
        model: 'github-copilot/claude-sonnet-4.6',
        username: 'someone',
        mode: {},
        agent: {},
      })
    );

    await expect(fetchOpencodeShareMode(PORT)).resolves.toBe('disabled');
    expect(fetchMock.mock.calls[0][0]).toBe(`http://127.0.0.1:${PORT}/config`);
  });

  it('reads the captured GET /config of a server with no share key', async () => {
    fetchMock.mockResolvedValue(
      json({
        $schema: 'https://opencode.ai/config.json',
        command: {},
        plugin: [],
        model: 'github-copilot/claude-sonnet-4.6',
        username: 'someone',
        mode: {},
        agent: {},
      })
    );

    await expect(fetchOpencodeShareMode(PORT)).resolves.toBeNull();
  });

  it('answers null when nothing is listening', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(fetchOpencodeShareMode(PORT)).resolves.toBeNull();
  });
});

describe('shareOpencodeSession', () => {
  it('returns the URL opencode minted', async () => {
    fetchMock.mockResolvedValue(json(SHARED_SESSION));

    await expect(shareOpencodeSession(PORT, SESSION)).resolves.toEqual({
      kind: 'shared',
      url: SHARE_URL,
    });
  });

  it('POSTs with no request body at all', async () => {
    // Measured from opencode's own OpenAPI: `requestBody: null`.
    fetchMock.mockResolvedValue(json(SHARED_SESSION));

    await shareOpencodeSession(PORT, SESSION);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`http://127.0.0.1:${PORT}/session/${SESSION}/share`);
    expect(init.method).toBe('POST');
    expect(init.body).toBeUndefined();
  });

  it('percent-encodes the session id on the way into the path', async () => {
    fetchMock.mockResolvedValue(json(SHARED_SESSION));
    await shareOpencodeSession(PORT, 'ses_a/../b');
    expect(fetchMock.mock.calls[0][0]).toBe(
      `http://127.0.0.1:${PORT}/session/ses_a%2F..%2Fb/share`
    );
  });

  it('reports the disabled-in-config 500 as refused, and nothing more specific', async () => {
    // The whole point: the body carries no code, and the real reason
    // (`Sharing is disabled in configuration`) is only in opencode's log. A
    // caller that wants to know must ask `GET /config` first.
    fetchMock.mockResolvedValue(json(DISABLED_ERROR, 500));

    await expect(shareOpencodeSession(PORT, SESSION)).resolves.toEqual({
      kind: 'refused',
      status: 500,
    });
  });

  it('tells a missing session apart from a refusal', async () => {
    fetchMock.mockResolvedValue(
      json({ name: 'NotFoundError', data: { message: `Session not found: ${SESSION}` } }, 404)
    );

    await expect(shareOpencodeSession(PORT, SESSION)).resolves.toEqual({ kind: 'not-found' });
  });

  it('does not report success for a 200 that carries no URL', async () => {
    // The session may well be published; saying it is not would leave the
    // operator with no revoke path to a live page.
    fetchMock.mockResolvedValue(json({ id: SESSION, title: 'probe' }));

    await expect(shareOpencodeSession(PORT, SESSION)).resolves.toMatchObject({
      kind: 'failed',
    });
  });

  it('does not report success for a 200 that is not JSON', async () => {
    fetchMock.mockResolvedValue(
      new Response('<html>hello</html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      })
    );

    await expect(shareOpencodeSession(PORT, SESSION)).resolves.toMatchObject({
      kind: 'failed',
    });
  });

  it('answers failed rather than throwing when the server is gone', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(shareOpencodeSession(PORT, SESSION)).resolves.toMatchObject({
      kind: 'failed',
      reason: 'ECONNREFUSED',
    });
  });
});

describe('unshareOpencodeSession', () => {
  it('accepts the measured 200 even though the session keeps its share object', async () => {
    // Verbatim: `DELETE` answers with the session *including* `share: { url }`.
    // The boolean is the only signal, which is why this function returns one.
    fetchMock.mockResolvedValue(json(SHARED_SESSION));

    await expect(unshareOpencodeSession(PORT, SESSION)).resolves.toBe(true);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`http://127.0.0.1:${PORT}/session/${SESSION}/share`);
    expect(init.method).toBe('DELETE');
  });

  it('reports false when opencode refuses', async () => {
    fetchMock.mockResolvedValue(json(DISABLED_ERROR, 500));
    await expect(unshareOpencodeSession(PORT, SESSION)).resolves.toBe(false);
  });

  it('reports false rather than throwing when the server is gone', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(unshareOpencodeSession(PORT, SESSION)).resolves.toBe(false);
  });
});

describe('fetchOpencodeSessionShareUrl', () => {
  it('reads the share URL that `fetchOpencodeSession` projects away', async () => {
    fetchMock.mockResolvedValue(json(SHARED_SESSION));

    await expect(fetchOpencodeSessionShareUrl(PORT, SESSION)).resolves.toBe(SHARE_URL);
    expect(fetchMock.mock.calls[0][0]).toBe(`http://127.0.0.1:${PORT}/session/${SESSION}`);
  });

  it('still reports a URL for a session whose page was already revoked', async () => {
    // Not a defect in this function — it is what the server says. Measured: the
    // field survives the DELETE and a server restart. Callers must read it as
    // "was published once"; the route names it `lastShareUrl` for that reason.
    fetchMock.mockResolvedValue(json(SHARED_SESSION));
    await expect(fetchOpencodeSessionShareUrl(PORT, SESSION)).resolves.toBe(SHARE_URL);
  });

  it('answers null for a session that was never shared', async () => {
    fetchMock.mockResolvedValue(json({ id: SESSION, title: 'probe', share: null }));
    await expect(fetchOpencodeSessionShareUrl(PORT, SESSION)).resolves.toBeNull();
  });
});
