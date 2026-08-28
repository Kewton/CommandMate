/**
 * The operator-facing calls into one opencode instance's own server
 * (Issue #2038).
 *
 * Every response body below was measured against opencode 1.18.22 running
 * headless (`opencode serve --port … --hostname 127.0.0.1`) under an isolated
 * `HOME`, so what is pinned here is the server's behaviour rather than a guess
 * at it:
 *
 *  - `GET /session/<id>` answers a `Session` with `directory` and `title`;
 *    `parentID` appears only for a sub-agent.
 *  - `POST /session/<id>/fork` answers a whole new `Session` titled
 *    `"<original> (fork #1)"` and carrying **no** `parentID`.
 *  - `POST /tui/open-sessions` and `POST /tui/execute-command` answer `true`
 *    **with no TUI attached at all**, which is why the callers report
 *    "accepted" and never "opened".
 *
 * The most consequential assertion is the last one: **nothing here ever
 * requests `GET /session`**. Measured, a server started in directory A listed
 * directory B's sessions (`projectID: "global"` for both), so that endpoint
 * cannot answer "this instance's sessions" — #1758 §5.6.3, re-measured for this
 * Issue.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  OPENCODE_TUI_NEW_SESSION_COMMAND,
  executeOpencodeTuiCommand,
  fetchOpencodeSession,
  forkOpencodeSession,
  openOpencodeSessionPicker,
  selectOpencodeSession,
  toOpencodeSessionInfo,
} from '@/lib/session/opencode-session-api';

const PORT = 4211;
const SESSION_ID = 'ses_fc9802f88ffeZzlE5mU5cYYEFs';
const FORK_ID = 'ses_fc97fcc64ffexwMzjZ3t5umRnf';
const DIRECTORY = '/tmp/scratch/projA';

/** A `Session` exactly as 1.18.22 serialised it. */
const SESSION_BODY = {
  id: SESSION_ID,
  slug: 'mighty-meadow',
  projectID: 'global',
  directory: DIRECTORY,
  path: '',
  title: 'New session - 2026-08-25T01:19:01.239Z',
  version: '1.18.22',
  time: { created: 1787620741239, updated: 1787620741239 },
};

const FORK_BODY = {
  ...SESSION_BODY,
  id: FORK_ID,
  title: 'New session - 2026-08-25T01:19:01.239Z (fork #1)',
};

interface Recorded {
  url: string;
  init: RequestInit | undefined;
}

let requests: Recorded[];
let fetchMock: ReturnType<typeof vi.fn>;

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? 'application/json' : null) },
    json: async () => body,
  } as unknown as Response;
}

/** What an unknown route on a real opencode server answers: the SPA shell. */
function htmlResponse(): Response {
  return {
    ok: true,
    status: 200,
    headers: { get: () => 'text/html; charset=utf-8' },
    json: async () => ({ never: 'reached' }),
  } as unknown as Response;
}

beforeEach(() => {
  requests = [];
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    requests.push({ url, init });
    if (url.endsWith(`/session/${SESSION_ID}`)) return jsonResponse(SESSION_BODY);
    if (url.endsWith(`/session/${SESSION_ID}/fork`)) return jsonResponse(FORK_BODY);
    if (url.endsWith('/tui/open-sessions')) return jsonResponse(true);
    if (url.endsWith('/tui/execute-command')) return jsonResponse(true);
    if (url.endsWith('/tui/select-session')) return jsonResponse(true);
    return jsonResponse({ name: 'NotFoundError' }, 404);
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('toOpencodeSessionInfo', () => {
  it('reads the four fields CommandMate cares about', () => {
    expect(toOpencodeSessionInfo(SESSION_BODY)).toEqual({
      id: SESSION_ID,
      title: SESSION_BODY.title,
      directory: DIRECTORY,
      parentId: null,
    });
  });

  it('reports parentID for a sub-agent session', () => {
    expect(toOpencodeSessionInfo({ ...SESSION_BODY, parentID: 'ses_parent000000000000000' })?.parentId)
      .toBe('ses_parent000000000000000');
  });

  it('refuses a body whose id is not a session id', () => {
    expect(toOpencodeSessionInfo({ ...SESSION_BODY, id: 'msg_x' })).toBeNull();
    expect(toOpencodeSessionInfo('a string')).toBeNull();
  });
});

describe('fetchOpencodeSession', () => {
  it('reads one session back by id', async () => {
    await expect(fetchOpencodeSession(PORT, SESSION_ID)).resolves.toMatchObject({
      id: SESSION_ID,
      directory: DIRECTORY,
    });
    expect(requests[0].url).toBe(`http://127.0.0.1:${PORT}/session/${SESSION_ID}`);
  });

  it('refuses redirects, exactly as the event client does', async () => {
    await fetchOpencodeSession(PORT, SESSION_ID);
    expect(requests[0].init?.redirect).toBe('manual');
  });

  it('answers null for a 404 (the session was deleted)', async () => {
    await expect(fetchOpencodeSession(PORT, 'ses_00000000000000000000000000')).resolves.toBeNull();
  });

  it('answers null for a 200 that is not JSON — the SPA shell of a squatter', async () => {
    fetchMock.mockImplementationOnce(async () => htmlResponse());
    await expect(fetchOpencodeSession(PORT, SESSION_ID)).resolves.toBeNull();
  });

  it('answers null without asking when the id is not a session id', async () => {
    await expect(fetchOpencodeSession(PORT, 'ses_x; rm -rf /')).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('answers null when nothing is listening', async () => {
    fetchMock.mockImplementationOnce(async () => {
      throw new Error('ECONNREFUSED');
    });
    await expect(fetchOpencodeSession(PORT, SESSION_ID)).resolves.toBeNull();
  });
});

describe('forkOpencodeSession', () => {
  it('POSTs to the fork route and returns the new session', async () => {
    const forked = await forkOpencodeSession(PORT, SESSION_ID);
    expect(forked?.id).toBe(FORK_ID);
    expect(forked?.title).toContain('(fork #1)');
    // A fork is a sibling, not a sub-agent: measured, it carries no parentID.
    expect(forked?.parentId).toBeNull();
    expect(requests[0].init?.method).toBe('POST');
  });
});

describe('the TUI commands', () => {
  it('opens the session picker and reports only that it was accepted', async () => {
    await expect(openOpencodeSessionPicker(PORT)).resolves.toBe(true);
    expect(requests[0].url).toBe(`http://127.0.0.1:${PORT}/tui/open-sessions`);
  });

  it('sends opencode own command id for a new session', async () => {
    await expect(
      executeOpencodeTuiCommand(PORT, OPENCODE_TUI_NEW_SESSION_COMMAND)
    ).resolves.toBe(true);
    expect(JSON.parse(String(requests[0].init?.body))).toEqual({ command: 'session_new' });
  });

  it('navigates the pane to a session with the sessionID spelling the server uses', async () => {
    await expect(selectOpencodeSession(PORT, FORK_ID)).resolves.toBe(true);
    expect(JSON.parse(String(requests[0].init?.body))).toEqual({ sessionID: FORK_ID });
  });

  it('reports false for anything other than a literal true body', async () => {
    fetchMock.mockImplementationOnce(async () => jsonResponse({ ok: true }));
    await expect(openOpencodeSessionPicker(PORT)).resolves.toBe(false);
  });
});

describe('GET /session is never used', () => {
  it('every session request this module makes names one session', async () => {
    await fetchOpencodeSession(PORT, SESSION_ID);
    await forkOpencodeSession(PORT, SESSION_ID);
    await openOpencodeSessionPicker(PORT);
    await executeOpencodeTuiCommand(PORT, OPENCODE_TUI_NEW_SESSION_COMMAND);
    await selectOpencodeSession(PORT, FORK_ID);

    const listRequests = requests.filter(({ url }) => new URL(url).pathname === '/session');
    expect(listRequests).toEqual([]);
  });
});
