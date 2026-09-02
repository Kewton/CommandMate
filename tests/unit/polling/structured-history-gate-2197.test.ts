/**
 * The gate branches on a declared capability, not on a tool name (Issue #2197).
 *
 * `./structured-history-gate-2041.test.ts` pins the push question and
 * `./structured-history-gate-2121.test.ts` the pull one. This file pins what
 * #2197 changed underneath both of them: *which* question gets asked is now
 * `AgentSourceCapabilities.transcriptHistory`, read off the source in the
 * registry, and the tool ids that used to be in the two `if`s are gone.
 *
 * ## What this file has to catch that the pin table cannot
 *
 * `tests/unit/hooks/sources/capabilities.test.ts` fixes every source's declared
 * value. That is a transcription check — it proves the table says what the
 * design says. It cannot prove that anything *reads* the table, and a capability
 * nothing reads is the vacuous green that file's own header warns about. So the
 * assertions below flip the declaration at runtime and require the gate's
 * behaviour to follow it: codex declared `null` must stop reaching codex's
 * reader, and gemini declared `'pull'` must start reaching a reader. That is the
 * mutation the Issue's acceptance criteria ask for, executed rather than
 * described.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/hooks/sources/opencode/subscription', () => ({
  isOpencodeStructuredHistoryLive: vi.fn(() => false),
}));
vi.mock('@/lib/hooks/sources/claude/history', () => ({
  captureClaudeTranscriptTurn: vi.fn(async () => false),
}));
vi.mock('@/lib/hooks/sources/codex/history', () => ({
  captureCodexTranscriptTurn: vi.fn(async () => false),
}));
vi.mock('@/lib/hooks/sources/antigravity/history', () => ({
  captureAntigravityTranscriptTurn: vi.fn(async () => false),
}));

import { captureClaudeTranscriptTurn } from '@/lib/hooks/sources/claude/history';
import { captureCodexTranscriptTurn } from '@/lib/hooks/sources/codex/history';
import { captureAntigravityTranscriptTurn } from '@/lib/hooks/sources/antigravity/history';
import { isOpencodeStructuredHistoryLive } from '@/lib/hooks/sources/opencode/subscription';
import { getAgentEventSource } from '@/lib/hooks/sources/registry';
import type { AgentSourceCapabilities } from '@/lib/hooks/sources/types';
import type { CLIToolType } from '@/lib/cli-tools/types';
import {
  captureStructuredHistoryTurn,
  isStructuredHistoryWriterLive,
} from '@/lib/polling/structured-history-gate';

const CAPTURE = { worktreePath: '/repos/wt-2197', transcriptPathHint: null } as const;

const EVERY_TOOL = ['claude', 'codex', 'opencode', 'gemini', 'copilot', 'antigravity'] as const;

/** Restore whatever the declarations were, whatever a test did to them. */
const declared = new Map<CLIToolType, AgentSourceCapabilities['transcriptHistory']>();

/**
 * Rewrite one source's declaration for the duration of a test.
 *
 * The registry hands out the real source objects, so this is the same mutation
 * an edit to the tool's `source.ts` would be — which is the point: the gate has
 * to be reading the declaration rather than agreeing with it by coincidence.
 */
function declareTranscriptHistory(
  cliToolId: CLIToolType,
  value: AgentSourceCapabilities['transcriptHistory']
): void {
  const capabilities = getAgentEventSource(cliToolId).capabilities as {
    transcriptHistory: AgentSourceCapabilities['transcriptHistory'];
  };
  capabilities.transcriptHistory = value;
}

beforeEach(() => {
  vi.clearAllMocks();
  for (const tool of EVERY_TOOL) {
    declared.set(tool, getAgentEventSource(tool).capabilities.transcriptHistory);
  }
  vi.mocked(isOpencodeStructuredHistoryLive).mockReturnValue(false);
  vi.mocked(captureClaudeTranscriptTurn).mockResolvedValue(false);
  vi.mocked(captureCodexTranscriptTurn).mockResolvedValue(false);
  vi.mocked(captureAntigravityTranscriptTurn).mockResolvedValue(false);
});

afterEach(() => {
  for (const [tool, value] of declared) declareTranscriptHistory(tool, value);
  declared.clear();
  vi.restoreAllMocks();
});

describe('[#2197] the codex reader is wired into the gate', () => {
  it('asks codex’s reader and reports what it answered', async () => {
    vi.mocked(captureCodexTranscriptTurn).mockResolvedValue(true);
    expect(await captureStructuredHistoryTurn('wt-1', 'codex', 'codex', CAPTURE)).toBe(true);
    expect(vi.mocked(captureCodexTranscriptTurn)).toHaveBeenCalledWith(
      { worktreeId: 'wt-1', cliToolId: 'codex', instanceId: 'codex' },
      CAPTURE
    );
  });

  it('is false when codex’s reader did not record the turn', async () => {
    expect(await captureStructuredHistoryTurn('wt-1', 'codex', 'codex', CAPTURE)).toBe(false);
  });

  it('defaults the instance to the primary and carries a named one through', async () => {
    await captureStructuredHistoryTurn('wt-1', 'codex', undefined, CAPTURE);
    expect(vi.mocked(captureCodexTranscriptTurn).mock.calls[0][0]).toEqual({
      worktreeId: 'wt-1',
      cliToolId: 'codex',
      instanceId: 'codex',
    });

    await captureStructuredHistoryTurn('wt-1', 'codex', 'codex-2', CAPTURE);
    expect(vi.mocked(captureCodexTranscriptTurn).mock.calls[1][0]).toEqual({
      worktreeId: 'wt-1',
      cliToolId: 'codex',
      instanceId: 'codex-2',
    });
  });

  it('never sends a codex pane to claude’s reader, or the other way round', async () => {
    // Two pull tools now share one branch, so "the right reader" stopped being
    // free. Answering with the wrong tool's reader would file this turn against
    // a transcript that belongs to a different conversation.
    vi.mocked(captureClaudeTranscriptTurn).mockResolvedValue(true);
    vi.mocked(captureCodexTranscriptTurn).mockResolvedValue(true);

    await captureStructuredHistoryTurn('wt-1', 'codex', 'codex', CAPTURE);
    expect(vi.mocked(captureClaudeTranscriptTurn)).not.toHaveBeenCalled();

    await captureStructuredHistoryTurn('wt-1', 'claude', 'claude', CAPTURE);
    expect(vi.mocked(captureCodexTranscriptTurn)).toHaveBeenCalledTimes(1);
  });

  it('leaves the scraper as the only writer for the two tools with no reader', async () => {
    // gemini and copilot, since #2198 moved antigravity out of this list. The
    // assertion is the fail-open: a tool with no second writer must never have
    // its scrape suppressed.
    vi.mocked(captureClaudeTranscriptTurn).mockResolvedValue(true);
    vi.mocked(captureCodexTranscriptTurn).mockResolvedValue(true);
    vi.mocked(captureAntigravityTranscriptTurn).mockResolvedValue(true);
    for (const tool of ['gemini', 'copilot'] as const) {
      expect(await captureStructuredHistoryTurn('wt-1', tool, undefined, CAPTURE)).toBe(false);
    }
    expect(vi.mocked(captureClaudeTranscriptTurn)).not.toHaveBeenCalled();
    expect(vi.mocked(captureCodexTranscriptTurn)).not.toHaveBeenCalled();
    expect(vi.mocked(captureAntigravityTranscriptTurn)).not.toHaveBeenCalled();
  });
});

describe('[#2198] the antigravity reader is wired into the gate', () => {
  it('asks antigravity’s reader and reports what it answered', async () => {
    vi.mocked(captureAntigravityTranscriptTurn).mockResolvedValue(true);
    expect(await captureStructuredHistoryTurn('wt-1', 'antigravity', 'antigravity', CAPTURE)).toBe(
      true
    );
    expect(vi.mocked(captureAntigravityTranscriptTurn)).toHaveBeenCalledWith(
      { worktreeId: 'wt-1', cliToolId: 'antigravity', instanceId: 'antigravity' },
      CAPTURE
    );
  });

  it('is false when antigravity’s reader did not record the turn', async () => {
    expect(await captureStructuredHistoryTurn('wt-1', 'antigravity', 'antigravity', CAPTURE)).toBe(
      false
    );
  });

  it('defaults the instance to the primary and carries a named one through', async () => {
    await captureStructuredHistoryTurn('wt-1', 'antigravity', undefined, CAPTURE);
    expect(vi.mocked(captureAntigravityTranscriptTurn).mock.calls[0][0]).toEqual({
      worktreeId: 'wt-1',
      cliToolId: 'antigravity',
      instanceId: 'antigravity',
    });

    await captureStructuredHistoryTurn('wt-1', 'antigravity', 'antigravity-2', CAPTURE);
    expect(vi.mocked(captureAntigravityTranscriptTurn).mock.calls[1][0]).toEqual({
      worktreeId: 'wt-1',
      cliToolId: 'antigravity',
      instanceId: 'antigravity-2',
    });
  });

  it('keeps the three pull readers apart', async () => {
    // Three tools now share one branch, so "the right reader" is not free.
    // Answering with the wrong tool's reader would file this turn against a
    // transcript belonging to a different conversation — and for antigravity
    // that is not even a near miss, because claude's reader derives its path
    // from a worktree `cwd` that agy never reports.
    vi.mocked(captureClaudeTranscriptTurn).mockResolvedValue(true);
    vi.mocked(captureCodexTranscriptTurn).mockResolvedValue(true);
    vi.mocked(captureAntigravityTranscriptTurn).mockResolvedValue(true);

    await captureStructuredHistoryTurn('wt-1', 'antigravity', 'antigravity', CAPTURE);
    expect(vi.mocked(captureClaudeTranscriptTurn)).not.toHaveBeenCalled();
    expect(vi.mocked(captureCodexTranscriptTurn)).not.toHaveBeenCalled();

    await captureStructuredHistoryTurn('wt-1', 'claude', 'claude', CAPTURE);
    await captureStructuredHistoryTurn('wt-1', 'codex', 'codex', CAPTURE);
    expect(vi.mocked(captureAntigravityTranscriptTurn)).toHaveBeenCalledTimes(1);
  });

  it('never asks antigravity about a subscription it does not have', async () => {
    // `'pull'` and `'push'` are not two spellings of "somebody else has it".
    vi.mocked(isOpencodeStructuredHistoryLive).mockReturnValue(true);
    expect(isStructuredHistoryWriterLive('wt-1', 'antigravity', 'antigravity')).toBe(false);
    expect(vi.mocked(isOpencodeStructuredHistoryLive)).not.toHaveBeenCalled();
  });

  it('stops asking antigravity the moment its declaration says `null`', async () => {
    // The mutation the acceptance criteria name, for the source #2198 added. If
    // this stayed green with the reader still being called, the capability would
    // be decoration and the dispatch would be agreeing with it by coincidence.
    vi.mocked(captureAntigravityTranscriptTurn).mockResolvedValue(true);
    declareTranscriptHistory('antigravity', null);

    expect(await captureStructuredHistoryTurn('wt-1', 'antigravity', 'antigravity', CAPTURE)).toBe(
      false
    );
    expect(vi.mocked(captureAntigravityTranscriptTurn)).not.toHaveBeenCalled();
  });

  it('falls back to the scraper when antigravity’s reader throws', async () => {
    vi.mocked(captureAntigravityTranscriptTurn).mockRejectedValue(new Error('no home'));
    expect(await captureStructuredHistoryTurn('wt-1', 'antigravity', 'antigravity', CAPTURE)).toBe(
      false
    );
  });
});

describe('[#2197] the branch follows the declaration', () => {
  it('stops asking codex the moment its declaration says `null`', async () => {
    // The mutation the acceptance criteria name. With `transcriptHistory` set to
    // `null` the gate must fall back to the scraper for codex — if this stayed
    // green with the reader still being called, the capability would be
    // decoration and the tool-name branch would still be in charge.
    vi.mocked(captureCodexTranscriptTurn).mockResolvedValue(true);
    declareTranscriptHistory('codex', null);

    expect(await captureStructuredHistoryTurn('wt-1', 'codex', 'codex', CAPTURE)).toBe(false);
    expect(vi.mocked(captureCodexTranscriptTurn)).not.toHaveBeenCalled();
  });

  it('stops asking claude the moment its declaration says `null`', async () => {
    vi.mocked(captureClaudeTranscriptTurn).mockResolvedValue(true);
    declareTranscriptHistory('claude', null);

    expect(await captureStructuredHistoryTurn('wt-1', 'claude', 'claude', CAPTURE)).toBe(false);
    expect(vi.mocked(captureClaudeTranscriptTurn)).not.toHaveBeenCalled();
  });

  it('starts asking a tool that declares `pull`, and says so when it has no reader', async () => {
    // The other direction. gemini has no reader, so declaring `'pull'` for it
    // must not silently suppress the scrape — the gate answers false, which is
    // the fail-open, and the missing reader is a logged fact rather than a lost
    // reply.
    declareTranscriptHistory('gemini', 'pull');
    expect(await captureStructuredHistoryTurn('wt-1', 'gemini', undefined, CAPTURE)).toBe(false);
    expect(vi.mocked(captureClaudeTranscriptTurn)).not.toHaveBeenCalled();
    expect(vi.mocked(captureCodexTranscriptTurn)).not.toHaveBeenCalled();
  });

  it('stops asking opencode about its subscription when it declares `null`', async () => {
    vi.mocked(isOpencodeStructuredHistoryLive).mockReturnValue(true);
    expect(isStructuredHistoryWriterLive('wt-1', 'opencode', 'opencode')).toBe(true);

    declareTranscriptHistory('opencode', null);
    expect(isStructuredHistoryWriterLive('wt-1', 'opencode', 'opencode')).toBe(false);
    expect(vi.mocked(isOpencodeStructuredHistoryLive)).toHaveBeenCalledTimes(1);
  });

  it('asks about the subscription for whichever tool declares `push`', async () => {
    vi.mocked(isOpencodeStructuredHistoryLive).mockReturnValue(true);
    expect(isStructuredHistoryWriterLive('wt-1', 'codex', 'codex')).toBe(false);

    declareTranscriptHistory('codex', 'push');
    expect(isStructuredHistoryWriterLive('wt-1', 'codex', 'codex')).toBe(true);
  });

  it('keeps the two questions apart: a pull tool is never asked about liveness', async () => {
    // `'pull'` and `'push'` are not two spellings of "somebody else has it".
    // Asking a pull tool whether a subscription is live would answer from a map
    // that has never had an entry for it.
    vi.mocked(isOpencodeStructuredHistoryLive).mockReturnValue(true);
    expect(isStructuredHistoryWriterLive('wt-1', 'claude', 'claude')).toBe(false);
    expect(isStructuredHistoryWriterLive('wt-1', 'codex', 'codex')).toBe(false);
    expect(vi.mocked(isOpencodeStructuredHistoryLive)).not.toHaveBeenCalled();

    // …and a push tool is never handed to a transcript reader.
    expect(await captureStructuredHistoryTurn('wt-1', 'opencode', undefined, CAPTURE)).toBe(false);
    expect(vi.mocked(captureClaudeTranscriptTurn)).not.toHaveBeenCalled();
    expect(vi.mocked(captureCodexTranscriptTurn)).not.toHaveBeenCalled();
  });
});

describe('[#2197] the declarations the gate is reading', () => {
  it('is the registry’s source that answers, for every tool', () => {
    // The gate asks the registry, so what it reads is what a tool's own
    // `source.ts` declares — not a copy of the table kept here.
    expect(
      Object.fromEntries(
        EVERY_TOOL.map((tool) => [tool, getAgentEventSource(tool).capabilities.transcriptHistory])
      )
    ).toEqual({
      claude: 'pull',
      codex: 'pull',
      opencode: 'push',
      gemini: null,
      copilot: null,
      antigravity: 'pull',
    });
  });

  it('falls back to the scraper when a throwing reader is asked', async () => {
    // This runs inside the poller's save path. A throwing reader must not
    // silence the only writer there is, and must not take the save path down.
    vi.mocked(captureCodexTranscriptTurn).mockRejectedValue(new Error('registry not ready'));
    expect(await captureStructuredHistoryTurn('wt-1', 'codex', 'codex', CAPTURE)).toBe(false);
  });
});
