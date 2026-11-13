/**
 * A #4344 server's ask routes, laid over a test's own fetch mock (Issue #4344,
 * design `docs/design/ask-attribution-4344.md` §6 PR3).
 *
 * The `ask` suites written before #4344 fake `/send`, `/current-output`,
 * `/messages` and `/capture`. Since PR3 `ask` also reads
 * `GET /api/asks/capabilities` before the send, names `ask: { id, protocol }` on
 * the send of an attributed tool, and reads the reply by that id
 * (`GET /api/asks/:askId`). This wraps whatever `global.fetch` the suite
 * installed and answers those three the way the PR1/PR2 server does; every
 * other request goes to the suite's own mock untouched, so its fixtures keep
 * meaning what they meant.
 *
 * The default ledger answer models the server's reader: the ask is `matched`
 * with the newest assistant row a transcript reader wrote (`<tool>-turn:`) in
 * the suite's own `/messages`, else `pending` (a turn row that never lands).
 */

import { vi } from 'vitest';
import type { AskAttributionResponse } from '../../../../src/cli/types/api-responses';

/** The capability table of a server with PR1 + PR2 (claude and codex attributed). */
export const PR2_ASK_TOOLS: Readonly<Record<string, boolean>> = {
  claude: true,
  codex: true,
  gemini: false,
  'vibe-local': false,
  opencode: false,
  copilot: false,
  antigravity: false,
  'command-code': false,
  'opencode-v2': false,
};

export interface AskLedgerFake {
  /** The ask ids the CLI named on its sends, in order. */
  askIds: string[];
  /** The `ask` field of each send body (undefined when the send named none). */
  sendAsks: unknown[];
}

export interface AskLedgerOptions {
  /** `GET /api/asks/capabilities`'s tools; `'404'` answers like a server before #4344. */
  tools?: Readonly<Record<string, boolean>> | '404';
  /**
   * `GET /api/asks/:askId`. Default: matched with the suite's newest
   * `<tool>-turn:` assistant row, else pending.
   */
  answer?: (askId: string) => Partial<AskAttributionResponse> | Promise<Partial<AskAttributionResponse>>;
  /** The `ask` the send answers with. Default: `pending`/`sent` with the id it was given. */
  sendAnswer?: (askId: string) => unknown;
}

const json = (data: unknown, status = 200): Response =>
  ({
    ok: status >= 200 && status < 300,
    status,
    redirected: false,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(JSON.stringify(data)),
  }) as unknown as Response;

/** A full answer of `GET /api/asks/:askId`. */
export function askAnswer(askId: string, fields: Partial<AskAttributionResponse>): AskAttributionResponse {
  return {
    askId,
    state: 'pending',
    reason: null,
    reply: null,
    sendState: 'sent',
    nativeInputSeen: false,
    notified: false,
    ...fields,
  };
}

/**
 * The server reader's answer for a ledger of rows: matched with the newest
 * assistant row a transcript reader wrote (`<tool>-turn:`), else pending.
 */
export function answerFromRows(
  rows: readonly { role?: string; requestId?: string | null; content?: string; timestamp?: string }[],
): Partial<AskAttributionResponse> {
  const turnRows = rows
    .filter((r) => r.role === 'assistant' && typeof r.requestId === 'string' && /-turn:/.test(r.requestId))
    .slice()
    .sort((a, b) => Date.parse(a.timestamp ?? '') - Date.parse(b.timestamp ?? ''));
  const newest = turnRows[turnRows.length - 1];
  return newest ? { state: 'matched', reply: newest.content ?? '', nativeInputSeen: true } : { state: 'pending' };
}

/** Wrap the suite's installed `global.fetch` with the ask routes. Call after the suite's mock. */
export function installAskLedger(options: AskLedgerOptions = {}): AskLedgerFake {
  const inner = global.fetch;
  const fake: AskLedgerFake = { askIds: [], sendAsks: [] };
  let worktreeId: string | null = null;

  const defaultAnswer = async (): Promise<Partial<AskAttributionResponse>> => {
    if (worktreeId === null) return { state: 'pending' };
    const response = await inner(`http://localhost:3000/api/worktrees/${worktreeId}/messages?limit=30`);
    const rows = (await response?.json?.()) as unknown;
    return answerFromRows(Array.isArray(rows) ? rows : []);
  };

  global.fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost:3000');
    const method = init?.method ?? 'GET';
    if (url.pathname === '/api/asks/capabilities') {
      if (options.tools === '404') return json({ error: 'Not found' }, 404);
      return json({ protocol: 1, tools: options.tools ?? PR2_ASK_TOOLS });
    }
    const send = /^\/api\/worktrees\/([^/]+)\/send$/.exec(url.pathname);
    if (send && method === 'POST') {
      worktreeId = decodeURIComponent(send[1]);
      const body = JSON.parse(String(init?.body ?? '{}')) as { ask?: { id?: string } };
      fake.sendAsks.push(body.ask);
      const response = await inner(input as string, init);
      const askId = body.ask?.id;
      if (!askId || !response?.ok) return response;
      fake.askIds.push(askId);
      const data = (await response.json()) as Record<string, unknown> | undefined;
      const ask = options.sendAnswer ? options.sendAnswer(askId) : { id: askId, state: 'pending', reason: null, sendState: 'sent' };
      return json(ask === undefined ? data : { ...(data ?? {}), ask }, response.status);
    }
    const read = /^\/api\/asks\/([^/]+)$/.exec(url.pathname);
    if (read && method === 'GET') {
      const askId = decodeURIComponent(read[1]);
      const fields = await (options.answer ? options.answer(askId) : defaultAnswer());
      return json(askAnswer(askId, fields));
    }
    return inner(input as string, init);
  }) as unknown as typeof fetch;
  return fake;
}
