/**
 * Issue #4344 (PR3 review r1, P3-1・P3-2): the `reply` that the "reply not
 * collected" line recommends for a tool `ask` does not attribute.
 *
 * Invariants:
 *  (I1) a recommended `reply` always carries `--since <the ask's send time>` —
 *       without it `reply` can return the previous turn's answer, the very
 *       mix-up #4344 prevents; with no send time, `reply` is not recommended;
 *  (I2) a tool whose `reply` is always empty (`REPLY_COMMAND_TOOLS` false) is
 *       not told to use it: only `--async` and `capture --pane`. Looped over
 *       every tool id, so a tool added later is covered;
 *  the guide's table (ja・en) names exactly the tools the definition marks true;
 *  (I3) `--json`, the exit code and the reason are as before;
 *  (I4) the screen is never read (no `/capture`).
 *
 * Positive (red before the fix): `reply` had no `--since`, and copilot・gemini・
 * vibe-local were told to use it.
 *
 * @vitest-environment node
 */

import * as fs from 'fs';
import * as path from 'path';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { restoreFetch } from '../../../helpers/mock-api';
import { ExitCode } from '../../../../src/cli/types';
import { CLI_TOOL_IDS } from '../../../../src/cli/config/cli-tool-ids';
import {
  REPLY_COMMAND_TOOLS,
  formatReplyNotCollected,
  unavailableOutcome,
} from '../../../../src/cli/utils/ask-reply';
import { frame, mockServer, start, type Route } from './command-deadline-server';

const mockExit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
const mockConsoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
const mockConsoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv('CM_PORT', '3999');
});

afterEach(() => {
  restoreFetch();
  mockExit.mockClear();
  mockConsoleLog.mockClear();
  mockConsoleError.mockClear();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

const SENT_AT = '2026-11-16T08:00:00.000Z';
const ALL_OFF = Object.fromEntries(CLI_TOOL_IDS.map((id) => [id, false]));
const stderrText = (): string => mockConsoleError.mock.calls.map((c) => String(c[0])).join('\n');
const payload = (): Record<string, unknown> => JSON.parse(mockConsoleLog.mock.calls.map((c) => String(c[0]))[0]);
const captures = (): number => vi.mocked(global.fetch).mock.calls.filter(([input]) => String(input).includes('/capture')).length;

/** Every `reply …` command the line recommends (inside backticks). */
const replyCommands = (line: string): string[] => [...line.matchAll(/`(reply [^`]*)`/g)].map((m) => m[1]);

describe('the recommended reply (formatReplyNotCollected)', () => {
  it.each([...CLI_TOOL_IDS])('%s: (I1) a recommended reply carries --since; (I2) only where reply can answer', (tool) => {
    const line = formatReplyNotCollected(unavailableOutcome('tool_unsupported'), {
      worktreeId: 'wt1', instanceId: tool, cliToolId: tool, sentAt: SENT_AT,
    });
    const replies = replyCommands(line);
    if (REPLY_COMMAND_TOOLS[tool]) {
      expect(replies).toEqual([`reply wt1 --instance ${tool} --since ${SENT_AT}`]);
    } else {
      expect(replies).toEqual([]);
      expect(line).not.toContain('reply wt1');
    }
    expect(line).toContain(`--instance ${tool} --async`);
    expect(line).toContain(`capture wt1 --instance ${tool} --pane`);
  });

  it('with no send time, reply is not recommended at all (I1)', () => {
    const line = formatReplyNotCollected(unavailableOutcome('tool_unsupported'), {
      worktreeId: 'wt1', instanceId: 'antigravity', cliToolId: 'antigravity',
    });
    expect(replyCommands(line)).toEqual([]);
    expect(line).toContain('--async');
  });

  it('an unknown tool is not told to use reply (I2: no definition, no recommendation)', () => {
    const line = formatReplyNotCollected(unavailableOutcome('tool_unsupported'), { worktreeId: 'wt1', sentAt: SENT_AT });
    expect(replyCommands(line)).toEqual([]);
  });
});

describe('through ask, every tool the server turns down (I1・I2・I3・I4)', () => {
  const SEND: Route = () => ({ id: 'm1', worktreeId: 'wt1', role: 'user', content: 'hi', timestamp: SENT_AT });

  it.each([...CLI_TOOL_IDS])('%s', async (tool) => {
    mockServer({
      '/resolve-target': () => ({ cliToolId: tool, instanceId: tool, resolvedBy: 'roster', conflict: null }),
      '/api/asks/capabilities': { protocol: 1, tools: ALL_OFF, versions: {} },
      'POST /send': SEND,
      '/current-output': { ...frame, cliToolId: tool },
      'POST /capture': { output: 'on the screen\n' },
    });

    const run = await start('ask', ['wt1', 'hi', '--instance', tool, '--json']);
    await vi.advanceTimersByTimeAsync(60_000);
    await run.pending;

    expect(mockExit.mock.calls[0]?.[0]).toBe(ExitCode.SUCCESS);
    expect(captures()).toBe(0);
    expect(payload()).toEqual({
      worktreeId: 'wt1', instanceId: tool, cliToolId: tool, source: 'none', reply: null, askId: null,
      attribution: { state: 'unavailable', reason: 'tool_unsupported', notified: false },
    });
    const replies = replyCommands(stderrText());
    expect(replies).toEqual(REPLY_COMMAND_TOOLS[tool] ? [`reply wt1 --instance ${tool} --since ${SENT_AT}`] : []);
  });
});

describe('the guide\'s table names the tools the definition marks (one source)', () => {
  const root = path.resolve(__dirname, '../../../..');
  it.each([
    ['docs/user-guide/cli-operations-guide.md', '送って待って台帳を読む'],
    ['docs/en/user-guide/cli-operations-guide.md', 'Send, wait, read the ledger'],
  ])('%s', (file, rowHead) => {
    const text = fs.readFileSync(path.join(root, file), 'utf8');
    const row = text.split('\n').find((l) => l.startsWith(`| ${rowHead} |`));
    expect(row, `row "${rowHead}" in ${file}`).toBeDefined();
    const cells = (row as string).split(' | ');
    const answers = cells[cells.length - 1];
    const [yes, no] = answers.split(/。|\. /);
    const named = (part: string) => CLI_TOOL_IDS.filter((id) => new RegExp('`' + id + '`').test(part)).sort();
    expect(named(yes)).toEqual(CLI_TOOL_IDS.filter((id) => REPLY_COMMAND_TOOLS[id]).sort());
    expect(named(no ?? '')).toEqual(CLI_TOOL_IDS.filter((id) => !REPLY_COMMAND_TOOLS[id]).sort());
  });
});
