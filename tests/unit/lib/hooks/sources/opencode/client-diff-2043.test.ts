/**
 * `GET /session/:id/diff`, `POST /revert`, `POST /unrevert` (Issue #2043).
 *
 * Every response body below is a **verbatim capture** from opencode 1.18.22 in
 * an isolated HOME, and the outcomes asserted are the ones the real server was
 * measured to produce — including two that look like success at the HTTP layer
 * and are not.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  fetchOpencodeMessageDiff,
  readOpencodeFileDiffs,
  revertOpencodeMessage,
  unrevertOpencodeSession,
  MAX_OPENCODE_DIFF_FILES,
  MAX_OPENCODE_DIFF_PATCH_CHARS,
} from '@/lib/hooks/sources/opencode/client';

const FIXTURES = join(__dirname, '../../../../../fixtures/hooks/opencode');
const SESSION = 'ses_fc65b58b2ffe0kur0cUkuLmkrr';
const MESSAGE = 'msg_cmatee6cc7a4ab0b7aa86d103841a';

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURES, name), 'utf8')) as unknown;
}

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

describe('readOpencodeFileDiffs', () => {
  it('reads the captured GET /diff body', () => {
    const files = readOpencodeFileDiffs(fixture('session-message-diff-2043.json'));

    expect(files.map((f) => [f.file, f.status, f.additions, f.deletions])).toEqual([
      ['added.txt', 'added', 1, 0],
      ['sample.txt', 'modified', 1, 1],
    ]);
  });

  it('tolerates the fields opencode does not mark required', () => {
    // `file`, `patch` and `status` are optional in 1.18.22's own OpenAPI; only
    // `additions` and `deletions` are required.
    expect(readOpencodeFileDiffs([{ additions: 4, deletions: 2 }])).toEqual([
      { file: null, patch: null, additions: 4, deletions: 2, status: null },
    ]);
  });

  it('rejects a status outside the declared enum', () => {
    expect(readOpencodeFileDiffs([{ additions: 0, deletions: 0, status: 'renamed' }])[0].status)
      .toBeNull();
  });

  it('answers the empty array for anything that is not an array', () => {
    expect(readOpencodeFileDiffs(null)).toEqual([]);
    expect(readOpencodeFileDiffs({ diff: [] })).toEqual([]);
  });

  it('bounds the file count and each patch', () => {
    const many = Array.from({ length: MAX_OPENCODE_DIFF_FILES + 30 }, (_, i) => ({
      file: `f${i}.ts`,
      additions: 1,
      deletions: 0,
      patch: 'x'.repeat(MAX_OPENCODE_DIFF_PATCH_CHARS + 500),
    }));
    const files = readOpencodeFileDiffs(many);

    expect(files).toHaveLength(MAX_OPENCODE_DIFF_FILES);
    expect(files[0].patch).toHaveLength(MAX_OPENCODE_DIFF_PATCH_CHARS);
  });
});

describe('fetchOpencodeMessageDiff', () => {
  it('asks with messageID — the only form measured to answer files', async () => {
    fetchMock.mockResolvedValue(json(fixture('session-message-diff-2043.json')));

    const files = await fetchOpencodeMessageDiff(4843, SESSION, MESSAGE);

    expect(files).toHaveLength(2);
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain(`/session/${SESSION}/diff`);
    expect(url).toContain(`messageID=${MESSAGE}`);
  });

  it('answers null on the 400 a malformed messageID produces', async () => {
    fetchMock.mockResolvedValue(
      json({ name: 'BadRequest', data: { message: 'Expected a string starting with "msg"' } }, 400)
    );

    expect(await fetchOpencodeMessageDiff(4843, SESSION, 'nope')).toBeNull();
  });

  it('answers the empty array for the measured no-messageID-style empty body', async () => {
    fetchMock.mockResolvedValue(json(fixture('session-diff-no-message-id-2043.json')));

    expect(await fetchOpencodeMessageDiff(4843, SESSION, MESSAGE)).toEqual([]);
  });
});

/** The `Session` a revert route answers, reduced to the field that decides. */
function session(revertMessageId: string | null): Record<string, unknown> {
  return {
    id: SESSION,
    title: 't',
    revert: revertMessageId === null ? undefined : { messageID: revertMessageId },
  };
}

describe('revertOpencodeMessage', () => {
  it('reports `reverted` when the server echoes the id that was asked for', async () => {
    fetchMock.mockResolvedValue(json(session(MESSAGE)));

    expect(await revertOpencodeMessage(4843, SESSION, MESSAGE)).toEqual({
      kind: 'reverted',
      messageId: MESSAGE,
    });
    const [, init] = fetchMock.mock.calls[0];
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ messageID: MESSAGE });
  });

  it('reports `no_op` for the measured 200-with-null-revert', async () => {
    // An unknown but well-formed message id, on a session with nothing
    // reverted. opencode answers 200 and does nothing.
    fetchMock.mockResolvedValue(json(session(null)));

    expect(await revertOpencodeMessage(4843, SESSION, 'msg_zzzzzzzzzzzzzzzzzzzzzzzzzz')).toEqual({
      kind: 'no_op',
    });
  });

  it('reports `no_op` when a DIFFERENT revert is already held', async () => {
    // The case a null check alone got wrong, caught against the live server:
    // opencode answers 200 with the *existing* revert untouched, so the reply
    // looks like success and names the wrong turn.
    fetchMock.mockResolvedValue(json(session('msg_someothermessage00000000')));

    expect(await revertOpencodeMessage(4843, SESSION, MESSAGE)).toEqual({ kind: 'no_op' });
  });

  it('reports `busy` on the 409 a mid-turn session answers', async () => {
    fetchMock.mockResolvedValue(
      json({ _tag: 'SessionBusyError', sessionID: SESSION, message: 'Session is busy' }, 409)
    );

    expect(await revertOpencodeMessage(4843, SESSION, MESSAGE)).toEqual({ kind: 'busy' });
  });

  it('reports `rejected` on a 400', async () => {
    fetchMock.mockResolvedValue(json({ name: 'BadRequest' }, 400));

    expect(await revertOpencodeMessage(4843, SESSION, MESSAGE)).toEqual({
      kind: 'rejected',
      status: 400,
    });
  });

  it('reports `unreachable` when nothing answers', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));

    expect(await revertOpencodeMessage(4843, SESSION, MESSAGE)).toEqual({ kind: 'unreachable' });
  });

  it('reports `unreachable` for the 200 text/html an unknown route answers (#1931)', async () => {
    fetchMock.mockResolvedValue(
      new Response('<!doctype html>', { status: 200, headers: { 'content-type': 'text/html' } })
    );

    expect(await revertOpencodeMessage(4843, SESSION, MESSAGE)).toEqual({ kind: 'unreachable' });
  });
});

describe('unrevertOpencodeSession', () => {
  it('reports `restored` when nothing is held back any more', async () => {
    fetchMock.mockResolvedValue(json(session(null)));

    expect(await unrevertOpencodeSession(4843, SESSION)).toEqual({ kind: 'restored' });
    expect(String(fetchMock.mock.calls[0][0])).toContain(`/session/${SESSION}/unrevert`);
  });

  it('reports `no_op` when the session still holds a revert', async () => {
    fetchMock.mockResolvedValue(json(session(MESSAGE)));

    expect(await unrevertOpencodeSession(4843, SESSION)).toEqual({ kind: 'no_op' });
  });

  it('reports `busy` on 409', async () => {
    fetchMock.mockResolvedValue(json({ _tag: 'SessionBusyError' }, 409));

    expect(await unrevertOpencodeSession(4843, SESSION)).toEqual({ kind: 'busy' });
  });
});
