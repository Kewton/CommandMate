/**
 * Reading how full an opencode session's context is (Issue #2042).
 *
 * The Issue asked for `cost · N tokens (x%)` on the header, "context 使用率は
 * footer の `6.4K (1%)` と突き合わせて算出方法を決める". The measurement that
 * settled it is in `docs/design/opencode-server-live-verification.md` §14, and
 * the two things it settled are what this file guards:
 *
 *  - **The denominator is `limit.context`, not `limit.input`.** Both are
 *    published (1,000,000 and 936,000 on the measured model) and either one
 *    produces a believable percentage. The fixture keeps both so a future
 *    reader cannot pick the wrong one by accident.
 *  - **The numerator is one message, not the session.** `Session.tokens` is
 *    cumulative — it is what `opencode stats` prints — while the footer shows
 *    the last finished assistant turn. On the captured two-turn session those
 *    are 16,999 and 8,508, i.e. `2%` and `1%`.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  fetchOpencodeContextTokens,
  fetchOpencodeModelContextLimit,
  OPENCODE_CONTEXT_MESSAGE_WINDOW,
} from '@/lib/hooks/sources/opencode/client';

const FIXTURES = join(process.cwd(), 'tests/fixtures/hooks/opencode');

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), 'utf8'));
}

const PROVIDERS = fixture('config-providers-2042');
const MESSAGE_WINDOW = fixture('session-message-window-2042') as Array<{
  info: Record<string, unknown>;
}>;

/** The captured session, and the numbers opencode's own surfaces printed for it. */
const MEASURED = {
  provider: 'github-copilot',
  model: 'claude-sonnet-4.6',
  /** `GET /config/providers` → `limit.context`. */
  contextLimit: 1_000_000,
  /** The last assistant message's five counts, summed. The TUI read `8,508`. */
  contextTokens: 8_508,
  /** The *other* `limit`, kept as the trap it is. */
  inputLimit: 936_000,
} as const;

const originalFetch = globalThis.fetch;

/** Answer every request with one JSON body and opencode's own media type. */
function stubJson(body: unknown, ok = true): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn().mockResolvedValue({
    ok,
    status: ok ? 200 : 500,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => body,
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('fetchOpencodeModelContextLimit', () => {
  it('answers the model context window from the captured providers document', async () => {
    stubJson(PROVIDERS);
    await expect(
      fetchOpencodeModelContextLimit(4242, MEASURED.provider, MEASURED.model)
    ).resolves.toBe(MEASURED.contextLimit);
  });

  it('does NOT answer limit.input, which the same document also publishes', async () => {
    stubJson(PROVIDERS);
    const limit = await fetchOpencodeModelContextLimit(4242, MEASURED.provider, MEASURED.model);
    // The regression this guards: 8,508 against 936,000 is 0.91% and against
    // 1,000,000 is 0.85%, and both round to the `1%` opencode printed — so the
    // live reading could not tell them apart. Only the bundle could.
    expect(limit).not.toBe(MEASURED.inputLimit);
  });

  it('asks the provider config route on the loopback port', async () => {
    const fetchMock = stubJson(PROVIDERS);
    await fetchOpencodeModelContextLimit(4242, MEASURED.provider, MEASURED.model);
    expect(fetchMock.mock.calls[0][0]).toBe('http://127.0.0.1:4242/config/providers');
  });

  it('answers null for a provider the document does not list', async () => {
    stubJson(PROVIDERS);
    await expect(
      fetchOpencodeModelContextLimit(4242, 'no-such-provider', MEASURED.model)
    ).resolves.toBeNull();
  });

  it('answers null for a model the provider does not list', async () => {
    stubJson(PROVIDERS);
    await expect(
      fetchOpencodeModelContextLimit(4242, MEASURED.provider, 'no-such-model')
    ).resolves.toBeNull();
  });

  it('answers null for a model whose context limit is zero or absent', async () => {
    stubJson({
      providers: [{ id: 'p', models: { zero: { limit: { context: 0 } }, none: { limit: {} } } }],
    });
    await expect(fetchOpencodeModelContextLimit(4242, 'p', 'zero')).resolves.toBeNull();
    await expect(fetchOpencodeModelContextLimit(4242, 'p', 'none')).resolves.toBeNull();
  });

  it('answers null rather than throwing when nothing is listening', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED')) as unknown as typeof fetch;
    await expect(
      fetchOpencodeModelContextLimit(4242, MEASURED.provider, MEASURED.model)
    ).resolves.toBeNull();
  });

  it('answers null for an unknown route answering 200 text/html (#1931)', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'text/html' }),
      json: async () => PROVIDERS,
    }) as unknown as typeof fetch;
    await expect(
      fetchOpencodeModelContextLimit(4242, MEASURED.provider, MEASURED.model)
    ).resolves.toBeNull();
  });
});

describe('fetchOpencodeContextTokens', () => {
  it('sums the LAST assistant turn, matching what the TUI printed', async () => {
    stubJson(MESSAGE_WINDOW);
    await expect(fetchOpencodeContextTokens(4242, 'ses_x')).resolves.toBe(
      MEASURED.contextTokens
    );
  });

  it('equals the agent’s own `tokens.total` on that message', async () => {
    stubJson(MESSAGE_WINDOW);
    const last = MESSAGE_WINDOW[MESSAGE_WINDOW.length - 1].info;
    const total = (last.tokens as { total: number }).total;
    // `total` is not what the client reads — it is absent until a turn ends —
    // but it is opencode's own sum of the same five, so the two agreeing is the
    // evidence that the five are the right five.
    await expect(fetchOpencodeContextTokens(4242, 'ses_x')).resolves.toBe(total);
  });

  it('does NOT sum the whole window (that would be the cumulative figure)', async () => {
    stubJson(MESSAGE_WINDOW);
    const bothTurns = MESSAGE_WINDOW.filter((m) => m.info.role === 'assistant').reduce(
      (sum, m) => sum + (m.info.tokens as { total: number }).total,
      0
    );
    expect(bothTurns).toBe(16_999);
    await expect(fetchOpencodeContextTokens(4242, 'ses_x')).resolves.not.toBe(bothTurns);
  });

  it('asks for the trailing window on the message route', async () => {
    const fetchMock = stubJson(MESSAGE_WINDOW);
    await fetchOpencodeContextTokens(4242, 'ses_x');
    expect(fetchMock.mock.calls[0][0]).toBe(
      `http://127.0.0.1:4242/session/ses_x/message?limit=${OPENCODE_CONTEXT_MESSAGE_WINDOW}`
    );
  });

  it('skips the assistant message a turn opens with (output === 0)', async () => {
    // The shape that reaches a poll mid-turn: opencode has created the reply
    // and filled nothing in yet. Counting it would flash `0 (0%)` over a real
    // reading every time a turn started.
    stubJson([
      {
        info: {
          role: 'assistant',
          tokens: { input: 3, output: 6, reasoning: 0, cache: { read: 0, write: 8482 } },
        },
      },
      { info: { role: 'user', tokens: null } },
      {
        info: {
          role: 'assistant',
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        },
      },
    ]);
    await expect(fetchOpencodeContextTokens(4242, 'ses_x')).resolves.toBe(8_491);
  });

  it('answers null when the window holds no finished assistant turn', async () => {
    stubJson([{ info: { role: 'user', tokens: null } }]);
    await expect(fetchOpencodeContextTokens(4242, 'ses_x')).resolves.toBeNull();
  });

  it('answers null for an empty session', async () => {
    stubJson([]);
    await expect(fetchOpencodeContextTokens(4242, 'ses_x')).resolves.toBeNull();
  });

  it('answers null rather than throwing when nothing is listening', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED')) as unknown as typeof fetch;
    await expect(fetchOpencodeContextTokens(4242, 'ses_x')).resolves.toBeNull();
  });

  it('percent-encodes the session id it was handed', async () => {
    const fetchMock = stubJson([]);
    await fetchOpencodeContextTokens(4242, 'ses_a/b');
    expect(fetchMock.mock.calls[0][0]).toContain('/session/ses_a%2Fb/message');
  });
});
