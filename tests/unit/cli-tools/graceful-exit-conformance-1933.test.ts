/**
 * What each tool's shutdown path actually sends equals what it declares
 * (Issue #1933, 受入条件 S10 + 「既存 7 ツールの挙動を変えないこと」).
 *
 * ## Why this file exists rather than a shared executor
 *
 * `gracefulExitSequence()` would be a decoration if nothing checked it against
 * reality. The obvious way to make it real — route every `killSession()`
 * through one executor — was measured against the suite and rejected: the argv
 * of opencode's `/exit` is pinned by exact arity in
 * `tests/unit/api/kill-session-cli-tool-gateway-1905.test.ts`
 * (`expect(sendKeys).toHaveBeenCalledWith(sessionName, OPENCODE_EXIT_COMMAND,
 * false)`), a file outside this Issue's scope, and the executor would add a
 * fourth argument to it. There is also no behavioural gain to buy with that
 * breakage: `/exit` and `/quit` are tool-owned constants, not tmux key names,
 * so `-l` changes not one byte for them. The string that DOES change under
 * `-l` is the user-typed message body, and that went through it in the same
 * commit (`tests/unit/lib/key-sequence-1933.test.ts`).
 *
 * So the declaration is held to the implementation from this side instead. A
 * change to either one without the other turns this file red.
 *
 * ## The normalisation, and the one measurement it rests on
 *
 * The recorded tmux calls are folded back into `KeySequence` steps.
 * `sendKeys(name, text, true)` — gemini's batched `/quit` — becomes
 * `literal(text + CR)`, because `send-keys -t X '/quit' 'C-m'` and
 * `send-keys -t X -l -- '/quit\r'` deliver the identical six bytes
 * (`2f 71 75 69 74 0d`) in one write. Measured on tmux 3.5a against a private
 * socket with `cat` on a raw pty; without that measurement the fold would be an
 * assumption.
 *
 * @vitest-environment node
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Timing constants are what the sequences' `delayAfterMs` and `exitWaitMs` are
// made of, and this file asserts only the KEYSTROKES — the values are pinned in
// `graceful-exit-1933.test.ts`, which does not mock them. Zeroing the waits here
// keeps nine real shutdown windows (up to COPILOT_EXIT_WAIT_MS = 3000) out of a
// suite that drives them all. Same shape as the mock Issue #1977 added to
// `tests/unit/lib/tmux-capture-invalidation.test.ts`; only `*_MS` numbers are
// touched, so a future non-duration export does not silently become 0.
vi.mock('@/config/cli-tool-timing-config', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return Object.fromEntries(
    Object.entries(actual).map(([name, value]) => [
      name,
      name.endsWith('_MS') && typeof value === 'number' ? 0 : value,
    ])
  );
});
vi.mock('@/config/copilot-constants', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return Object.fromEntries(
    Object.entries(actual).map(([name, value]) => [
      name,
      name.endsWith('_MS') && typeof value === 'number' ? 0 : value,
    ])
  );
});

/** Every keystroke the tools sent, in order, as `[api, ...args]`. */
const sent: Array<[string, ...unknown[]]> = [];

vi.mock('@/lib/tmux/tmux', () => ({
  hasSession: vi.fn().mockResolvedValue(true),
  createSession: vi.fn().mockResolvedValue(undefined),
  capturePane: vi.fn().mockResolvedValue(''),
  exactTarget: (name: string) => `=${name}:`,
  reconcileSessionGeometry: vi.fn().mockResolvedValue(false),
  killSession: vi.fn().mockResolvedValue(true),
  sendKeys: vi.fn(async (...args: unknown[]) => {
    sent.push(['sendKeys', ...args]);
  }),
  sendSpecialKey: vi.fn(async (...args: unknown[]) => {
    sent.push(['sendSpecialKey', ...args]);
  }),
  sendSpecialKeys: vi.fn(async (...args: unknown[]) => {
    sent.push(['sendSpecialKeys', ...args]);
  }),
  clearInputLine: vi.fn().mockResolvedValue(undefined),
  clearComposerLine: vi.fn().mockResolvedValue(undefined),
  listSessions: vi.fn().mockResolvedValue([]),
}));

vi.mock('@/lib/tmux/tmux-capture-cache', () => ({
  invalidateCache: vi.fn(),
  getOrFetchCapture: vi.fn(async (_n: string, _l: number, fetchFn: () => Promise<string>) =>
    fetchFn()
  ),
  sliceOutput: vi.fn((output: string) => output),
  setCachedCapture: vi.fn(),
  getCachedCapture: vi.fn().mockReturnValue(null),
}));

// opencode's stream release writes a file and opens sockets; neither belongs in
// a keystroke test. The port lookup stays REAL and answers null (nothing was
// allocated), which is what keeps the health probe out of this file.
vi.mock('@/lib/hooks/sources/opencode/runtime', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    reserveOpencodeServerPort: vi.fn().mockResolvedValue(null),
    attachOpencodeEventStream: vi.fn().mockResolvedValue(false),
    resumeOpencodeEventStream: vi.fn().mockResolvedValue(false),
    releaseOpencodeEventStream: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock('@/lib/cli-tools/opencode-config', () => ({
  ensureOpencodeConfig: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/db/db-instance', () => ({ getDbInstance: vi.fn().mockReturnValue({}) }));
vi.mock('@/lib/db', () => ({ getWorktreeById: vi.fn().mockReturnValue(null) }));

import { CodexTool } from '@/lib/cli-tools/codex';
import { GeminiTool } from '@/lib/cli-tools/gemini';
import { VibeLocalTool } from '@/lib/cli-tools/vibe-local';
import { CopilotTool } from '@/lib/cli-tools/copilot';
import { AntigravityTool } from '@/lib/cli-tools/antigravity';
import { CommandCodeTool } from '@/lib/cli-tools/command-code';
import { OpenCodeTool } from '@/lib/cli-tools/opencode';
import { ClaudeTool } from '@/lib/cli-tools/claude';
import { stopSession } from '@/lib/session-key-sender';
import type { ICLITool } from '@/lib/cli-tools/types';
import type { KeySequence } from '@/types/cli-tool-contracts';

const WORKTREE = 'wt-1933';

/** A step with its timing dropped: this file asserts keystrokes, not waits. */
type Keystroke = { kind: 'key'; name: string } | { kind: 'literal'; text: string };

function strip(step: KeySequence): Keystroke {
  return step.kind === 'literal'
    ? { kind: 'literal', text: step.text }
    : { kind: 'key', name: step.name };
}

/**
 * Fold the recorded tmux calls back into keystrokes.
 *
 * An EMPTY literal is dropped: `sendKeys(name, '', false)` — the flush
 * `session-key-sender.stopSession` sends before its Ctrl-D — puts zero bytes on
 * the pty, so it is not a keystroke that a sequence could describe.
 */
function recordedKeystrokes(): Keystroke[] {
  const out: Keystroke[] = [];
  for (const [api, , ...rest] of sent) {
    if (api === 'sendKeys') {
      const text = rest[0] as string;
      const sendEnter = rest[1] as boolean | undefined;
      const body = sendEnter === false ? text : `${text}\r`;
      if (body.length > 0) out.push({ kind: 'literal', text: body });
      continue;
    }
    if (api === 'sendSpecialKey') {
      out.push({ kind: 'key', name: rest[0] as string });
      continue;
    }
    if (api === 'sendSpecialKeys') {
      for (const key of rest[0] as string[]) out.push({ kind: 'key', name: key });
    }
  }
  return out;
}

describe('graceful exit: declaration == implementation (Issue #1933)', () => {
  beforeEach(() => {
    sent.length = 0;
    vi.clearAllMocks();
  });

  const cases: Array<{ label: string; tool: ICLITool; run: () => Promise<void> }> = [
    (() => {
      const tool = new CodexTool();
      return { label: 'codex', tool, run: () => tool.killSession(WORKTREE) };
    })(),
    (() => {
      const tool = new GeminiTool();
      return { label: 'gemini', tool, run: () => tool.killSession(WORKTREE) };
    })(),
    (() => {
      const tool = new VibeLocalTool();
      return { label: 'vibe-local', tool, run: () => tool.killSession(WORKTREE) };
    })(),
    (() => {
      const tool = new CopilotTool();
      return { label: 'copilot', tool, run: () => tool.killSession(WORKTREE) };
    })(),
    (() => {
      const tool = new AntigravityTool();
      return { label: 'antigravity', tool, run: () => tool.killSession(WORKTREE) };
    })(),
    (() => {
      const tool = new CommandCodeTool();
      return { label: 'command-code', tool, run: () => tool.killSession(WORKTREE) };
    })(),
    (() => {
      const tool = new OpenCodeTool();
      return { label: 'opencode', tool, run: () => tool.killSession(WORKTREE) };
    })(),
    (() => {
      // ClaudeTool.killSession delegates through `session/claude-session` (db,
      // pollers, cache). The graceful exit itself is `stopSession`, which is the
      // function that actually types the keys, so that is what is driven here.
      const tool = new ClaudeTool();
      return {
        label: 'claude',
        tool,
        run: async () => {
          await stopSession(tool.getSessionName(WORKTREE));
        },
      };
    })(),
  ];

  for (const { label, tool, run } of cases) {
    it(`${label} sends exactly the keystrokes it declares`, async () => {
      await run();

      expect(recordedKeystrokes()).toEqual(tool.gracefulExitSequence().keys.map(strip));
    });
  }

  it('every tool declares a non-empty sequence, so none of the above is vacuously green', async () => {
    for (const { tool } of cases) {
      expect(tool.gracefulExitSequence().keys.length).toBeGreaterThan(0);
    }
  });
});
