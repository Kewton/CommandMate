/**
 * `ask` and the junk row the codex scraper writes (Issue #2386).
 *
 * ## The measurement this suite is built from
 *
 * UAT 2026-09-07, isolated server, codex 0.153.4, 3 runs out of 3:
 * `commandmate ask <wt> --instance codex "<question>"` exited 0 and printed an
 * EMPTY COMPOSER, in raw ANSI, instead of the answer. codex had answered
 * correctly — the row was in `chat_messages` — and the reading side was what
 * was broken. In time order:
 *
 * ```
 * 05:49:53.518 assistant request_id=NULL          (ANSI) "Ask Codex to do anything…"
 * 05:49:53.519 user      codex-prompt:01a07a6a-…  "5+6 は？ 答えの数字だけを返してください。"
 * 05:49:58.706 assistant codex-turn:01a07a6a-7a…  "11"
 * ```
 *
 * The scraper writes the idle composer as an assistant row in the millisecond
 * BEFORE the send, so `since` (taken before the send) does not fence it off,
 * and the real answer lands 5.2 s after `wait` has already reported
 * `basis=hook_stop`. Reading the ledger once at that instant reads the junk.
 *
 * ## What is pinned here
 *
 *  1. a row with no `<tool>-turn:` request id is never printed as the answer;
 *  2. `ask` waits out the gap and answers with the turn row when it lands;
 *  3. the reply carries no ANSI, on either source;
 *  4. CommandMate's own furniture rows (`relay-sys:`, `model-changed:`) are not
 *     answers either;
 *  5. the tools that have NO transcript reader keep the behaviour they had —
 *     the scraper's row is all they will ever write, and demanding a marker
 *     from them would throw a cleaned reply away for a raw pane.
 *
 * Fixtures are answered by route rather than by sequence: the grace window
 * re-reads the ledger, and a sequence would run dry mid-window and hide which
 * read produced the printed reply.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { restoreFetch } from '../../../helpers/mock-api';

const mockExit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
const mockConsoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
const mockConsoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

afterEach(() => {
  restoreFetch();
  mockExit.mockClear();
  mockConsoleLog.mockClear();
  mockConsoleError.mockClear();
  vi.useRealTimers();
});

/** Fixed clock the fake timers start from. */
const NOW = 1_787_400_000_000;

/** The gap #2386 measured between `wait` completing and the turn row landing. */
const TURN_ROW_LANDS_AT = NOW + 5_200;

const ESC = String.fromCharCode(27);

/**
 * The idle composer, exactly as the scraper stored it: raw ANSI, no request id.
 *
 * Written a millisecond before the send, so its timestamp is inside the window
 * `since` opens — which is why a timestamp comparison alone cannot reject it.
 */
const JUNK_COMPOSER_TEXT = `${ESC}[2m${ESC}[38;5;245mAsk Codex to do anything${ESC}[0m`;

const json = (data: unknown, status = 200): Response =>
  ({
    ok: status >= 200 && status < 300,
    status,
    redirected: false,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(JSON.stringify(data)),
  }) as unknown as Response;

/** A frame that says "the turn ended", as `wait`'s own tests spell it. */
const completedFrame = (cliToolId: string) => ({
  isRunning: true,
  isComplete: true,
  isPromptWaiting: false,
  isGenerating: false,
  content: 'done',
  fullOutput: 'done',
  realtimeSnippet: '',
  lineCount: 1,
  lastCapturedLine: 1,
  promptData: null,
  autoYes: { enabled: false, expiresAt: null },
  thinking: false,
  thinkingMessage: null,
  cliToolId,
  isSelectionListActive: false,
  lastServerResponseTimestamp: null,
  serverPollerActive: false,
  sessionStatus: 'ready' as const,
});

function row(overrides: Record<string, unknown>) {
  return {
    id: 'm',
    worktreeId: 'wt1',
    role: 'assistant',
    messageType: 'normal',
    archived: false,
    ...overrides,
  };
}

/** The scraper's pre-send row: assistant, in-window, and keyed nothing. */
const junkRow = row({
  id: 'junk',
  content: JUNK_COMPOSER_TEXT,
  timestamp: new Date(NOW + 1).toISOString(),
});

interface Routes {
  cliToolId: string;
  instanceId?: string;
  /** Ledger contents, resolved at read time so it can change mid-grace. */
  messages: () => unknown;
  /** What `capture` answers when the ledger yields nothing. */
  pane?: string;
}

function mockRoutes(routes: Routes): void {
  global.fetch = vi.fn((input: unknown) => {
    const url = String(input);
    if (url.includes('/api/capabilities')) {
      return Promise.resolve(
        json({ serverVersion: '0.0.0-test', capabilities: ['resolve-session-target'] }),
      );
    }
    if (url.includes('/resolve-target')) {
      return Promise.resolve(
        json({
          cliToolId: routes.cliToolId,
          instanceId: routes.instanceId ?? routes.cliToolId,
          resolvedBy: 'roster',
          conflict: null,
        }),
      );
    }
    if (url.includes('/send')) return Promise.resolve(json({ id: 1 }, 201));
    if (url.includes('/messages')) return Promise.resolve(json(routes.messages()));
    if (url.includes('/capture')) return Promise.resolve(json({ output: routes.pane ?? '' }));
    return Promise.resolve(json(completedFrame(routes.cliToolId)));
  }) as unknown as typeof fetch;
}

async function runAsk(argv: string[], advanceMs = 0): Promise<void> {
  const { createAskCommand } = await import('../../../../src/cli/commands/ask');
  const pending = createAskCommand().parseAsync(['node', 'ask', ...argv]);
  if (advanceMs > 0) await vi.advanceTimersByTimeAsync(advanceMs);
  await pending;
}

/** The `--json` payload `ask` printed. */
function payload(): { source: string; reply: string | null } {
  return JSON.parse(mockConsoleLog.mock.calls[0][0] as string);
}

describe('ask: the junk composer row is not an answer (Issue #2386)', () => {
  it('never prints the request_id=NULL row the scraper wrote before the send', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    // The defect's exact ledger: the junk is there, the turn row never arrives.
    mockRoutes({
      cliToolId: 'codex',
      messages: () => [junkRow],
      pane: 'pane fallback text\n',
    });

    await runAsk(['wt1', '1+1 は？', '--instance', 'codex', '--json'], 20_000);

    // The whole defect in one assertion: whatever `ask` answered with, it was
    // not the composer. Removing the turn-row requirement from
    // `readLatestReply` makes this row the newest candidate and fails here.
    expect(payload().reply ?? '').not.toContain('Ask Codex to do anything');
    expect(payload().source).not.toBe('history');
    expect(mockExit).toHaveBeenCalledWith(0);
  });

  it('waits out the gap and answers with the turn row that lands 5.2s later', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    mockRoutes({
      cliToolId: 'codex',
      // Exactly the measured timeline: junk from the start, the rollout
      // reader's row 5.2 seconds after `wait` said the turn was over.
      messages: () =>
        Date.now() >= TURN_ROW_LANDS_AT
          ? [
            junkRow,
            row({
              id: 'turn',
              content: '11',
              requestId: 'codex-turn:01a07a6a-7a',
              timestamp: new Date(TURN_ROW_LANDS_AT).toISOString(),
            }),
          ]
          : [junkRow],
    });

    await runAsk(['wt1', '5+6 は？', '--instance', 'codex'], 20_000);

    expect(mockExit).toHaveBeenCalledWith(0);
    expect(mockConsoleLog).toHaveBeenCalledTimes(1);
    expect(mockConsoleLog).toHaveBeenCalledWith('11');
  });

  it('prefers the turn row even while the junk row is still the newest', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    // The junk is written AFTER the answer here — the scraper flushing the
    // composer once the turn is over. "Newest wins" would print the composer;
    // "a reader wrote it" picks the answer.
    mockRoutes({
      cliToolId: 'codex',
      messages: () => [
        row({
          id: 'turn',
          content: '11',
          requestId: 'codex-turn:01a07a6a-7a',
          timestamp: new Date(NOW + 1_000).toISOString(),
        }),
        row({
          id: 'junk-after',
          content: JUNK_COMPOSER_TEXT,
          timestamp: new Date(NOW + 2_000).toISOString(),
        }),
      ],
    });

    await runAsk(['wt1', '5+6 は？', '--instance', 'codex']);

    expect(mockConsoleLog).toHaveBeenCalledWith('11');
  });

  it('keeps the last turn row when one turn wrote several', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    mockRoutes({
      cliToolId: 'codex',
      messages: () => [
        row({
          id: 'narration',
          content: 'Reading the file…',
          requestId: 'codex-turn:t1',
          timestamp: new Date(NOW + 1_000).toISOString(),
        }),
        row({
          id: 'summary',
          content: '11',
          requestId: 'codex-turn:t1',
          timestamp: new Date(NOW + 2_000).toISOString(),
        }),
      ],
    });

    await runAsk(['wt1', '5+6 は？', '--instance', 'codex']);

    expect(mockConsoleLog).toHaveBeenCalledWith('11');
  });
});

describe('ask: the reply carries no control characters (Issue #2386)', () => {
  it('strips ANSI out of a transcript row before printing it', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    mockRoutes({
      cliToolId: 'codex',
      messages: () => [
        row({
          id: 'turn',
          content: `${ESC}[1m11${ESC}[0m`,
          requestId: 'codex-turn:t1',
          timestamp: new Date(NOW + 1_000).toISOString(),
        }),
      ],
    });

    await runAsk(['wt1', '5+6 は？', '--instance', 'codex', '--json']);

    expect(payload().reply).toBe('11');
    expect(JSON.stringify(payload())).not.toContain(ESC);
  });

  it('strips ANSI out of the pane fallback too', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    mockRoutes({
      cliToolId: 'copilot',
      messages: () => [],
      pane: `${ESC}[32mcopilot said this${ESC}[0m\n`,
    });

    await runAsk(['wt1', 'hi', '--instance', 'copilot', '--json']);

    expect(payload().source).toBe('pane');
    expect(payload().reply).toBe('copilot said this');
    expect(JSON.stringify(payload())).not.toContain(ESC);
  });
});

describe("ask: CommandMate's own rows are not the agent's answer (Issue #2386)", () => {
  it('steps over a relay notice, on a tool with no transcript reader', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    // `chat_messages` has no `system` role, so #2377's "Reply from X" notice is
    // an ASSISTANT row. Printing it back would be the smallest possible loop.
    mockRoutes({
      cliToolId: 'copilot',
      messages: () => [
        row({
          id: 'relay',
          content: '[from codex / wt2] 11',
          requestId: 'relay-sys:rel_1:delivered',
          timestamp: new Date(NOW + 1_000).toISOString(),
        }),
      ],
      pane: 'copilot said this\n',
    });

    await runAsk(['wt1', 'hi', '--instance', 'copilot', '--json']);

    expect(payload().reply ?? '').not.toContain('[from codex / wt2]');
    expect(payload().source).toBe('pane');
  });

  it('steps over a model-change row, on a tool with no transcript reader', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    mockRoutes({
      cliToolId: 'copilot',
      messages: () => [
        row({
          id: 'model',
          content: 'モデルを gpt-5 に変更しました',
          requestId: `model-changed:${NOW + 1_000}`,
          timestamp: new Date(NOW + 1_000).toISOString(),
        }),
      ],
      pane: 'copilot said this\n',
    });

    await runAsk(['wt1', 'hi', '--instance', 'copilot', '--json']);

    expect(payload().reply).toBe('copilot said this');
    expect(payload().source).toBe('pane');
  });
});

describe('ask: the tools that keep no transcript are unchanged (Issue #2386)', () => {
  it('still answers from copilot\'s scraped ledger row, with no request id', async () => {
    // No fake timers on purpose: a tool with no transcript reader must not
    // spend the grace window, and a real-time run is the only way to say so.
    mockRoutes({
      cliToolId: 'copilot',
      messages: () => [
        row({
          id: 'scraped',
          content: 'copilot answered in the ledger',
          timestamp: new Date(Date.now() + 1_000).toISOString(),
        }),
      ],
      pane: 'the pane, which must NOT be used here\n',
    });

    await runAsk(['wt1', 'hi', '--instance', 'copilot', '--json']);

    expect(payload().source).toBe('history');
    expect(payload().reply).toBe('copilot answered in the ledger');
  });

  it('answers from gemini\'s scraped ledger row as well', async () => {
    mockRoutes({
      cliToolId: 'gemini',
      messages: () => [
        row({
          id: 'scraped',
          content: 'gemini answered in the ledger',
          timestamp: new Date(Date.now() + 1_000).toISOString(),
        }),
      ],
    });

    await runAsk(['wt1', 'hi', '--instance', 'gemini', '--json']);

    expect(payload().source).toBe('history');
    expect(payload().reply).toBe('gemini answered in the ledger');
  });
});

describe('ask: the claude path is unchanged (Issue #2386)', () => {
  it('answers with a claude-turn row', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    mockRoutes({
      cliToolId: 'claude',
      messages: () => [
        row({
          id: 'turn',
          content: '2',
          requestId: 'claude-turn:0d2f4c1e-9a11-4f1e-9d55-3f7a2b1c8e44',
          timestamp: new Date(NOW + 1_000).toISOString(),
        }),
      ],
    });

    await runAsk(['wt1', '1+1 は？', '--instance', 'claude']);

    expect(mockExit).toHaveBeenCalledWith(0);
    expect(mockConsoleLog).toHaveBeenCalledTimes(1);
    expect(mockConsoleLog).toHaveBeenCalledWith('2');
  });

  it('answers with an opencode oc-turn row', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    mockRoutes({
      cliToolId: 'opencode',
      messages: () => [
        row({
          id: 'turn',
          content: '2',
          requestId: 'oc-turn:msg_01H',
          timestamp: new Date(NOW + 1_000).toISOString(),
        }),
      ],
    });

    await runAsk(['wt1', '1+1 は？', '--instance', 'opencode']);

    expect(mockConsoleLog).toHaveBeenCalledWith('2');
  });
});
