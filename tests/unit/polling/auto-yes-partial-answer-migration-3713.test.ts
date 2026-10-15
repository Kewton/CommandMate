/**
 * Auto-Yes's memory of an answer stopped part-way follows a worktree ID move
 * (Issue #3713).
 *
 * #3706 remembers an answer whose send was stopped with keys already on the
 * pane (`{screen, session epoch}` under the composite key) so the same prompt
 * is not typed at again (`yy`). A worktree ID move renames the tmux session and
 * restarts the poller under the new key; the memory has to go with the session
 * — including a send that has not come back yet when the move happens — and
 * only with a session that really moved.
 *
 * Driven through the real poller, the real `sendPromptAnswer`, the real
 * registry (`auto-yes-poller-state`) and the real `reconcileWorktreeSessions`.
 * tmux is a fake server holding one pane and one key log per session: the
 * reconcile's two-stage rename moves a session (pane, keys and all) to its new
 * name, and the poller's capture and keys address sessions by the name the
 * real CLI tool derives. Only the ownership checks and side channels (response
 * poller, WebSocket, terminal broadcast) are stubbed.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';
import { TUI_TEXT_INPUT_WAIT_MS } from '@/config/cli-tool-timing-config';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/** A promise the test resolves by hand. */
interface Deferred<T = void> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}
function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

// --- the fake tmux server ------------------------------------------------------

interface FakeSession {
  pane: string;
  /** Every key that reached this pane, in order (`<Enter>` for a submit). */
  keys: string[];
}
/** Session name -> the process behind it. A rename moves the object. */
const sessions = new Map<string, FakeSession>();
/** Held open AFTER a typed key reached the pane: the send's Promise has not come back. */
let typedKeyGate: Deferred | null = null;
/** Like {@link typedKeyGate}, but only the next typed send is held (re-instruction 1, P2-2). */
let typedKeyGateOnce: Deferred | null = null;
/** Held open while the sender's guard reads the pane: no key issued yet. */
let guardReadGate: Deferred | null = null;
/** Held open after the first special key of a sequence reached the pane. */
let specialKeyGate: Deferred | null = null;
/** Captures per session name, to prove a tick really read the pane. */
const captures = new Map<string, number>();

function session(name: string): FakeSession {
  const found = sessions.get(name);
  if (!found) throw new Error(`can't find session: ${name}`);
  return found;
}

vi.mock('@/lib/tmux/tmux', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/tmux/tmux')>();
  return {
    ...actual,
    sendKeys: async (name: string, keys: string, enter = true) => {
      session(name).keys.push(enter ? `${keys}<Enter>` : keys);
      if (!enter && typedKeyGate) await typedKeyGate.promise;
      if (!enter && typedKeyGateOnce) {
        const once = typedKeyGateOnce;
        typedKeyGateOnce = null;
        await once.promise;
      }
    },
    sendSpecialKeys: async (name: string, keys: string[], options?: { shouldContinue?: () => boolean }) => {
      for (let i = 0; i < keys.length; i++) {
        session(name).keys.push(keys[i]);
        if (i === 0 && keys.length > 1 && specialKeyGate) await specialKeyGate.promise;
        if (i < keys.length - 1 && options?.shouldContinue && !options.shouldContinue()) {
          const stop = new Error('stopped');
          stop.name = 'SpecialKeysAbortedError';
          throw stop;
        }
      }
    },
    capturePane: async (name: string) => {
      if (guardReadGate) await guardReadGate.promise;
      return sessions.get(name)?.pane ?? '';
    },
  };
});

/** The name the real CLI tool derives, so the poller and the reconcile agree. */
async function sessionNameOf(worktreeId: string, cliToolId: string, instanceId?: string): Promise<string> {
  const { CLIToolManager } = await import('@/lib/cli-tools/manager');
  return CLIToolManager.getInstance()
    .getTool(cliToolId as never)
    .getSessionName(worktreeId, instanceId);
}

vi.mock('@/lib/session/cli-session', () => ({
  captureSessionOutput: async (worktreeId: string, cliToolId: string, _lines: number, instanceId?: string) => {
    const name = await sessionNameOf(worktreeId, cliToolId, instanceId);
    captures.set(name, (captures.get(name) ?? 0) + 1);
    return session(name).pane;
  },
  captureSessionOutputFresh: async (worktreeId: string, cliToolId: string, _lines: number, instanceId?: string) =>
    session(await sessionNameOf(worktreeId, cliToolId, instanceId)).pane,
  getSessionPresence: async (worktreeId: string, cliToolId: string, instanceId?: string) =>
    sessions.has(await sessionNameOf(worktreeId, cliToolId, instanceId)) ? 'present' : 'absent',
}));

vi.mock('@/lib/cli-tools/worktree-session-ownership', () => ({
  checkWorktreeSessionOwnership: async () => ({ verdict: 'owned', sessionPath: null }),
}));

// --- the rest ---------------------------------------------------------------
let db: Database.Database;
vi.mock('@/lib/db/db-instance', () => ({ getDbInstance: () => db }));
vi.mock('@/lib/polling/response-poller', () => ({
  startPolling: vi.fn(),
  migrateResponsePollerWorktreeIds: () => [],
}));
vi.mock('@/lib/realtime/terminal-broadcast', () => ({
  broadcastTerminalSnapshotAfterInteraction: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/ws-server', () => ({ broadcastMessage: vi.fn(), migrateWorktreeRooms: () => [] }));
vi.mock('@/lib/tmux/control-mode-tmux-transport', () => ({
  getControlModeTmuxTransport: () => ({ renameSession: () => undefined }),
}));
vi.mock('@/lib/hooks/pending-decision-recheck', () => ({
  recheckPendingDecisions: vi.fn(async () => ({ examined: 0, delivered: 0, skipped: 0, reason: 'no-pending' })),
}));

import { stopAllAutoYesPolling, stopAutoYesPollingByWorktree, clearAllPollerStates } from '@/lib/auto-yes-poller';
import {
  buildCompositeKey,
  clearAllAutoYesStates,
  setAutoYesEnabled,
  POLLING_INTERVAL_MS,
} from '@/lib/auto-yes-state';
import { startAutoYesPolling, getAutoYesPollerCompositeKeys } from '@/lib/polling/auto-yes-manager';
import {
  beginEnterFallbackSession,
  clearEnterFallbacks,
  getEnterFallbackSessionEpoch,
} from '@/lib/polling/auto-yes-enter-fallback';
import {
  beginSendAttempt,
  clearPartialAnswers,
  getPartialAnswer,
  hasMovedSendInFlight,
  movePartialAnswers,
  settleSendAttempt,
} from '@/lib/polling/auto-yes-poller-state';
import { clearPolicySuppressions, getLastPolicySuppression } from '@/lib/polling/auto-yes-suppression-state';
import {
  reconcileWorktreeSessions,
  type ReconcileTmuxDeps,
  type WorktreeIdRename,
} from '@/lib/session/worktree-session-reconcile';
import { setAgentInstances } from '@/lib/db/agent-instances-db';
import type { CLIToolType } from '@/lib/cli-tools/types';

const A = 'wt-alpha';
const B = 'wt-bravo';
const C = 'wt-charlie';
const ONE_HOUR = 3_600_000 as const;

/** A y/n prompt: `y` is typed, then — after a wait — submitted with Enter. */
const PROMPT_TYPED = 'Do you want to proceed? (y/n)';
/** Another y/n prompt: a different screen. */
const OTHER_PROMPT_TYPED = 'Overwrite the lockfile? (y/n)';
/** gemini answers a numbered list by typing the digit, then Enter after a wait. */
const GEMINI_LIST_A = 'Select an option:\n❯ 1. Yes\n  2. No';
const GEMINI_LIST_A_CURSOR_MOVED = 'Select an option:\n  1. Yes\n❯ 2. No';
const GEMINI_LIST_B = 'Select an option:\n❯ 1. Apply the patch\n  2. Skip it';
/** claude's cursor list on its default: answered with one Enter (special keys only). */
const CLAUDE_LIST = 'Select an option:\n❯ 1. Yes\n  2. No';
/** claude's AskUserQuestion picker (#2486 live capture): answered Down, Up, Enter. */
const CLAUDE_PICKER = readFileSync(path.resolve(__dirname, '../../fixtures/claude-live-2486/preview-q1.txt'), 'utf8');

/** Let every pending promise job run (no timer moves). */
async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
  for (let i = 0; i < 20; i++) await Promise.resolve();
  await vi.advanceTimersByTimeAsync(0);
}

async function ticks(count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    await vi.advanceTimersByTimeAsync(POLLING_INTERVAL_MS);
    await settle();
  }
}

/** A live session for an instance, holding `pane`, as `beginAgentSession` starts one. */
async function launch(worktreeId: string, pane: string, tool: CLIToolType = 'claude', instanceId?: string): Promise<FakeSession> {
  const created: FakeSession = { pane, keys: [] };
  sessions.set(await sessionNameOf(worktreeId, tool, instanceId), created);
  beginEnterFallbackSession(worktreeId, tool, instanceId);
  return created;
}

function enable(worktreeId: string, tool: CLIToolType = 'claude', instanceId?: string): void {
  setAutoYesEnabled(worktreeId, tool, true, ONE_HOUR, undefined, instanceId);
  startAutoYesPolling(worktreeId, tool, instanceId);
}

/** A renewal under the same poller: the tick in flight loses its grant. */
function renew(worktreeId: string, tool: CLIToolType = 'claude', instanceId?: string): void {
  setAutoYesEnabled(worktreeId, tool, true, ONE_HOUR, undefined, instanceId);
}

function keyOf(worktreeId: string, tool: CLIToolType = 'claude', instanceId?: string): string {
  return buildCompositeKey(worktreeId, tool, instanceId);
}

/** The partial answer that applies to the key's current session, or null. */
function partialAt(worktreeId: string, tool: CLIToolType = 'claude', instanceId?: string) {
  const key = keyOf(worktreeId, tool, instanceId);
  return getPartialAnswer(key, getEnterFallbackSessionEpoch(key));
}

/**
 * On `worktreeId`, type the answer to `pane`'s prompt and stop it before its
 * Enter with a renewal: the partial answer is then recorded under the key.
 */
async function stopAfterTheTypedKey(worktreeId: string, pane = PROMPT_TYPED, tool: CLIToolType = 'claude'): Promise<FakeSession> {
  const live = await launch(worktreeId, pane, tool);
  enable(worktreeId, tool);
  await ticks(1);
  expect(live.keys).toHaveLength(1);
  renew(worktreeId, tool);
  await vi.advanceTimersByTimeAsync(TUI_TEXT_INPUT_WAIT_MS);
  await settle();
  expect(partialAt(worktreeId, tool)).not.toBeNull();
  return live;
}

// --- the reconcile ------------------------------------------------------------

interface RenameFaults {
  /** Called on every rename; return a value to replace the fake's own outcome. */
  onRename?: (oldName: string, newName: string) => boolean | 'throw' | undefined;
  listFails?: boolean;
  foreign?: Set<string>;
}

function tmuxDeps(faults: RenameFaults = {}): ReconcileTmuxDeps {
  return {
    listSessions: async () => {
      if (faults.listFails) throw new Error('no tmux');
      return [...sessions.keys()].map((name) => ({ name, windows: 1, attached: false, path: `/repos/${name}` }));
    },
    isSessionOwnedBy: (sessionPath) => !faults.foreign?.has(String(sessionPath).replace('/repos/', '')),
    renameSession: async (oldName: string, newName: string) => {
      const forced = faults.onRename?.(oldName, newName);
      if (forced === 'throw') throw new Error(`Failed to rename tmux session: forced ${oldName}`);
      if (forced !== undefined) return forced;
      const moving = sessions.get(oldName);
      if (!moving) return false;
      if (sessions.has(newName)) throw new Error(`Failed to rename tmux session: duplicate session: ${newName}`);
      sessions.delete(oldName);
      sessions.set(newName, moving);
      return true;
    },
  };
}

async function move(renames: WorktreeIdRename[], faults?: RenameFaults) {
  const result = await reconcileWorktreeSessions(db, renames, { tmux: tmuxDeps(faults) });
  await settle();
  return result;
}

function addWorktree(id: string): void {
  db.prepare(
    `INSERT INTO worktrees (id, name, path, repository_path, repository_name, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, id, `/repo/${id}`, '/repo', 'repo', Date.now());
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_800_000_000_000);
  db = new Database(':memory:');
  runMigrations(db);
  for (const id of [A, B, C]) addWorktree(id);
  clearAllAutoYesStates();
  clearAllPollerStates();
  clearEnterFallbacks();
  // The session epochs are per process; start every test from none.
  globalThis.__autoYesEnterFallbackEpochs?.clear();
  clearPartialAnswers();
  clearPolicySuppressions();
  sessions.clear();
  captures.clear();
  typedKeyGate = null;
  typedKeyGateOnce = null;
  guardReadGate = null;
  specialKeyGate = null;
});

afterEach(() => {
  typedKeyGate?.resolve();
  typedKeyGateOnce?.resolve();
  guardReadGate?.resolve();
  specialKeyGate?.resolve();
  stopAllAutoYesPolling();
  clearAllAutoYesStates();
  clearEnterFallbacks();
  db.close();
  vi.useRealTimers();
});

// =============================================================================
// 1. A recorded partial answer moves with the session
// =============================================================================

describe('[#3713] 1: a partial answer recorded before the move', () => {
  it('the poller under the new id does not type at the same prompt for 3 ticks', async () => {
    const live = await stopAfterTheTypedKey(A);
    await move([{ oldId: A, newId: B }]);
    const name = await sessionNameOf(B, 'claude');
    expect(sessions.get(name)).toBe(live);
    const before = captures.get(name) ?? 0;

    await ticks(3);

    expect(live.keys).toEqual(['y']);
    expect((captures.get(name) ?? 0) - before).toBeGreaterThanOrEqual(3);
    expect(getLastPolicySuppression(B, 'claude')?.reason).toBe('partial-answer');
  });

  it('negative: with nothing remembered, the moved poller answers as before', async () => {
    const live = await launch(A, 'idle');
    enable(A);
    await ticks(1);
    await move([{ oldId: A, newId: B }]);
    live.pane = PROMPT_TYPED;

    await ticks(1);
    await vi.advanceTimersByTimeAsync(TUI_TEXT_INPUT_WAIT_MS);
    await settle();

    expect(live.keys).toEqual(['y', '<Enter>']);
  });
});

// =============================================================================
// 2. A send still in flight when the move happens ((a))
// =============================================================================

describe('[#3713] 2 (a): the old tick comes back after the move', () => {
  it("the new key's first tick runs before the old send returns, and nothing is typed again", async () => {
    const live = await launch(A, PROMPT_TYPED);
    enable(A);
    typedKeyGate = deferred();
    await ticks(1);
    expect(live.keys).toEqual(['y']); // on the pane; the send's Promise is held

    await move([{ oldId: A, newId: B }]);
    const name = await sessionNameOf(B, 'claude');
    expect(sessions.get(name)).toBe(live);
    const before = captures.get(name) ?? 0;
    await ticks(1); // the new poller's first tick: captured, prompt read, nothing sent
    expect(captures.get(name) ?? 0).toBeGreaterThan(before);
    expect(live.keys).toEqual(['y']);

    // The old send comes back; its Enter is withheld (its poller is gone).
    const gate = typedKeyGate;
    typedKeyGate = null;
    gate.resolve();
    await vi.advanceTimersByTimeAsync(TUI_TEXT_INPUT_WAIT_MS);
    await settle();
    expect(partialAt(B)).not.toBeNull();
    expect(partialAt(A)).toBeNull();

    await ticks(3);
    expect(live.keys).toEqual(['y']);
  });

  it('negative: stopped before any key (guard read held), the new key answers once it is back', async () => {
    const live = await launch(A, CLAUDE_LIST);
    enable(A);
    guardReadGate = deferred();
    await ticks(1);
    expect(live.keys).toEqual([]);

    await move([{ oldId: A, newId: B }]);
    await ticks(1); // the send is still in flight: held
    expect(live.keys).toEqual([]);

    const gate = guardReadGate;
    guardReadGate = null;
    gate.resolve();
    await settle();
    expect(partialAt(B)).toBeNull();
    expect(globalThis.__autoYesSendAttempts?.size ?? 0).toBe(0);

    await ticks(1);
    expect(live.keys).toEqual(['Enter']);
  });
});

// =============================================================================
// 3. A list answered by the cursor / by a digit
// =============================================================================

describe('[#3713] 3: a list whose answer was part-way when the session moved', () => {
  it("claude's special keys: Down is out when the session moves; nothing more goes to that picker", async () => {
    const live = await launch(A, CLAUDE_PICKER);
    enable(A);
    specialKeyGate = deferred(); // held after the first key of Down, Up, Enter
    await ticks(1);
    expect(live.keys).toEqual(['Down']);

    await move([{ oldId: A, newId: B }]);
    await ticks(1); // the successor reads the same picker while the send is in flight
    const gate = specialKeyGate;
    specialKeyGate = null;
    gate.resolve();
    await settle();
    expect(partialAt(B)).not.toBeNull();

    await ticks(3);
    expect(live.keys).toEqual(['Down']);
  });

  it('gemini: the same list with the cursor moved stays held after the move', async () => {
    const live = await launch(A, GEMINI_LIST_A, 'gemini');
    enable(A, 'gemini');
    typedKeyGate = deferred();
    await ticks(1);
    expect(live.keys).toEqual(['1']);

    await move([{ oldId: A, newId: B }]);
    live.pane = GEMINI_LIST_A_CURSOR_MOVED;
    await ticks(1);
    const gate = typedKeyGate;
    typedKeyGate = null;
    gate.resolve();
    await vi.advanceTimersByTimeAsync(TUI_TEXT_INPUT_WAIT_MS);
    await settle();
    await ticks(3);

    expect(live.keys).toEqual(['1']);
  });

  it('negative: a different list (another prompt) under the new key is answered', async () => {
    const live = await launch(A, GEMINI_LIST_A, 'gemini');
    enable(A, 'gemini');
    typedKeyGate = deferred();
    await ticks(1);

    await move([{ oldId: A, newId: B }]);
    live.pane = GEMINI_LIST_B;
    const gate = typedKeyGate;
    typedKeyGate = null;
    gate.resolve();
    await vi.advanceTimersByTimeAsync(TUI_TEXT_INPUT_WAIT_MS);
    await settle();
    await ticks(2);
    await vi.advanceTimersByTimeAsync(TUI_TEXT_INPUT_WAIT_MS);
    await settle();

    expect(live.keys.slice(0, 3)).toEqual(['1', '1', '<Enter>']);
  });
});

// =============================================================================
// 4. / 5. Session epochs ((b))
// =============================================================================

describe('[#3713] 4 (b): a session relaunched before the move', () => {
  it("the old process's memory is not carried: the new process's prompt is answered", async () => {
    const live = await stopAfterTheTypedKey(A);
    // A new process for A, with no read of the memory since.
    beginEnterFallbackSession(A, 'claude');
    await move([{ oldId: A, newId: B }]);

    expect(partialAt(B)).toBeNull();
    await ticks(1);
    await vi.advanceTimersByTimeAsync(TUI_TEXT_INPUT_WAIT_MS);
    await settle();
    expect(live.keys).toEqual(['y', 'y', '<Enter>']);
  });

  it('a relaunch under the old key while the renames run: not carried either', async () => {
    await stopAfterTheTypedKey(A);
    await move([{ oldId: A, newId: B }], {
      onRename: (oldName, newName) => {
        // During stage 1 a session is begun under the old key.
        if (newName.startsWith('cmate-renaming-')) beginEnterFallbackSession(A, 'claude');
        return undefined;
      },
    });
    expect(partialAt(B)).toBeNull();
  });

  it("negative: the same session's memory is carried and holds the prompt", async () => {
    await stopAfterTheTypedKey(A);
    await move([{ oldId: A, newId: B }]);
    expect(partialAt(B)).toMatchObject({ screenKey: expect.any(String) });
  });
});

describe('[#3713] 5: a session relaunched under the new key after the move', () => {
  it('the old send coming back afterwards records nothing there', async () => {
    const live = await launch(A, PROMPT_TYPED);
    enable(A);
    typedKeyGate = deferred();
    await ticks(1);
    await move([{ oldId: A, newId: B }]);
    beginEnterFallbackSession(B, 'claude');

    const gate = typedKeyGate;
    typedKeyGate = null;
    gate.resolve();
    await vi.advanceTimersByTimeAsync(TUI_TEXT_INPUT_WAIT_MS);
    await settle();
    expect(getPartialAnswer(keyOf(B), getEnterFallbackSessionEpoch(keyOf(B)))).toBeNull();
    expect(globalThis.__autoYesPartialAnswers?.has(keyOf(B))).toBe(false);

    await ticks(1);
    await vi.advanceTimersByTimeAsync(TUI_TEXT_INPUT_WAIT_MS);
    await settle();
    expect(live.keys).toEqual(['y', 'y', '<Enter>']);
  });

  it("negative: with B's epoch unchanged, the old send's stop protects B", async () => {
    await launch(A, PROMPT_TYPED);
    enable(A);
    typedKeyGate = deferred();
    await ticks(1);
    await move([{ oldId: A, newId: B }]);

    const gate = typedKeyGate;
    typedKeyGate = null;
    gate.resolve();
    await vi.advanceTimersByTimeAsync(TUI_TEXT_INPUT_WAIT_MS);
    await settle();
    expect(partialAt(B)).not.toBeNull();
  });
});

// =============================================================================
// 6. / 7. / 8. Moves that did not happen ((c)), and the destination's old memory
// =============================================================================

describe('[#3713] 6 (c): a refused or impossible move leaves the destination alone', () => {
  /** A and B both live, each with its own stopped answer on a different prompt. */
  async function twoStoppedAnswers(): Promise<{ bravoPartial: unknown }> {
    await stopAfterTheTypedKey(A, PROMPT_TYPED);
    await stopAfterTheTypedKey(B, OTHER_PROMPT_TYPED);
    return { bravoPartial: partialAt(B) };
  }

  it('a live B the pass is not moving: refused, B keeps its own memory', async () => {
    const { bravoPartial } = await twoStoppedAnswers();
    const result = await move([{ oldId: A, newId: B }]);
    expect(result.skippedSessions.map((s) => s.reason)).toContain('destination session already exists');
    expect(partialAt(B)).toEqual(bravoPartial);
  });

  it('a foreign source session: skipped, B unchanged', async () => {
    const { bravoPartial } = await twoStoppedAnswers();
    const foreign = new Set([await sessionNameOf(A, 'claude')]);
    sessions.delete(await sessionNameOf(B, 'claude'));
    await move([{ oldId: A, newId: B }], { foreign });
    expect(globalThis.__autoYesPartialAnswers?.get(keyOf(B))).toEqual(bravoPartial);
  });

  it('no source session: nothing is carried, B unchanged', async () => {
    const { bravoPartial } = await twoStoppedAnswers();
    sessions.delete(await sessionNameOf(A, 'claude'));
    await move([{ oldId: A, newId: B }]);
    expect(partialAt(B)).toEqual(bravoPartial);
  });

  it('the session list fails: nothing is carried, B unchanged', async () => {
    const { bravoPartial } = await twoStoppedAnswers();
    await move([{ oldId: A, newId: B }], { listFails: true });
    expect(partialAt(B)).toEqual(bravoPartial);
  });

  it('negative: an empty B and a rename that succeeds — A’s memory protects B', async () => {
    await stopAfterTheTypedKey(A);
    const alpha = partialAt(A);
    await move([{ oldId: A, newId: B }]);
    expect(partialAt(B)?.screenKey).toBe(alpha?.screenKey);
    expect(partialAt(A)).toBeNull();
  });
});

describe('[#3713] 7: only a rename that succeeded in both stages carries the memory', () => {
  async function alphaStoppedThenMoveWith(onRename: RenameFaults['onRename']) {
    await stopAfterTheTypedKey(A);
    const result = await move([{ oldId: A, newId: B }], { onRename });
    return result;
  }
  const isStage1 = (newName: string) => newName.startsWith('cmate-renaming-');
  const isStage2 = (oldName: string) => oldName.startsWith('cmate-renaming-');

  it('stage 1 false (the session vanished)', async () => {
    const result = await alphaStoppedThenMoveWith((_o, n) => (isStage1(n) ? false : undefined));
    expect(result.renamedSessions).toEqual([]);
    expect(partialAt(B)).toBeNull();
  });

  it('stage 1 throws', async () => {
    const result = await alphaStoppedThenMoveWith((_o, n) => (isStage1(n) ? 'throw' : undefined));
    expect(result.renamedSessions).toEqual([]);
    expect(partialAt(B)).toBeNull();
  });

  it('stage 2 false: reported as skipped, not as renamed', async () => {
    const result = await alphaStoppedThenMoveWith((o) => (isStage2(o) ? false : undefined));
    expect(result.renamedSessions).toEqual([]);
    expect(result.skippedSessions.map((s) => s.reason)).toContain('session no longer exists');
    expect(partialAt(B)).toBeNull();
  });

  it('stage 2 throws and is put back', async () => {
    const alphaName = await sessionNameOf(A, 'claude');
    const result = await alphaStoppedThenMoveWith((o, n) => (isStage2(o) && n !== alphaName ? 'throw' : undefined));
    expect(result.renamedSessions).toEqual([]);
    expect(sessions.has(alphaName)).toBe(true);
    expect(partialAt(B)).toBeNull();
  });

  it('stage 2 throws and the rollback fails too', async () => {
    const result = await alphaStoppedThenMoveWith((o) => (isStage2(o) ? 'throw' : undefined));
    expect(result.errors.some((e) => e.includes('left under temporary name'))).toBe(true);
    expect(partialAt(B)).toBeNull();
  });

  it('negative: both stages true carries it', async () => {
    const result = await alphaStoppedThenMoveWith(() => undefined);
    expect(result.renamedSessions).toHaveLength(1);
    expect(partialAt(B)).not.toBeNull();
  });
});

describe("[#3713] 8: the destination's memory of a session no longer there", () => {
  it('a stale memory under B (no live B) does not drop the memory A brings', async () => {
    // B once stopped an answer to another prompt; its session has since gone.
    await stopAfterTheTypedKey(B, OTHER_PROMPT_TYPED);
    sessions.delete(await sessionNameOf(B, 'claude'));
    const live = await stopAfterTheTypedKey(A, PROMPT_TYPED);

    await move([{ oldId: A, newId: B }]);
    await ticks(3);
    expect(live.keys).toEqual(['y']);
  });

  it('negative: a refused move does not replace live B’s memory with A’s', async () => {
    await stopAfterTheTypedKey(B, OTHER_PROMPT_TYPED);
    const bravo = partialAt(B);
    await stopAfterTheTypedKey(A, PROMPT_TYPED);
    await move([{ oldId: A, newId: B }]);
    expect(partialAt(B)).toEqual(bravo);
  });
});

// =============================================================================
// 9. Batches
// =============================================================================

describe('[#3713] 9: a batch moves each memory once, with its own session', () => {
  it('a swap A↔B (both epoch 1, both pollers running): each memory follows its session, both successors tick', async () => {
    const alpha = await stopAfterTheTypedKey(A, PROMPT_TYPED);
    const bravo = await stopAfterTheTypedKey(B, OTHER_PROMPT_TYPED);
    expect(getEnterFallbackSessionEpoch(keyOf(A))).toBe(getEnterFallbackSessionEpoch(keyOf(B)));
    const alphaMemory = partialAt(A);
    const bravoMemory = partialAt(B);

    await move([
      { oldId: A, newId: B },
      { oldId: B, newId: A },
    ]);

    expect(sessions.get(await sessionNameOf(B, 'claude'))).toBe(alpha);
    expect(sessions.get(await sessionNameOf(A, 'claude'))).toBe(bravo);
    expect(partialAt(B)?.screenKey).toBe(alphaMemory?.screenKey);
    expect(partialAt(A)?.screenKey).toBe(bravoMemory?.screenKey);
    expect(getAutoYesPollerCompositeKeys().sort()).toEqual([keyOf(A), keyOf(B)].sort());

    const nameA = await sessionNameOf(A, 'claude');
    const nameB = await sessionNameOf(B, 'claude');
    const before = [captures.get(nameA) ?? 0, captures.get(nameB) ?? 0];
    await ticks(3);
    // Both successors really ran (captured), and neither typed again.
    expect((captures.get(nameA) ?? 0) - before[0]).toBeGreaterThanOrEqual(3);
    expect((captures.get(nameB) ?? 0) - before[1]).toBeGreaterThanOrEqual(3);
    expect(alpha.keys).toEqual(['y']);
    expect(bravo.keys).toEqual(['y']);
  });

  it('a chain A→B, B→C', async () => {
    await stopAfterTheTypedKey(A, PROMPT_TYPED);
    await stopAfterTheTypedKey(B, OTHER_PROMPT_TYPED);
    const alphaMemory = partialAt(A);
    const bravoMemory = partialAt(B);
    await move([
      { oldId: A, newId: B },
      { oldId: B, newId: C },
    ]);
    expect(partialAt(B)?.screenKey).toBe(alphaMemory?.screenKey);
    expect(partialAt(C)?.screenKey).toBe(bravoMemory?.screenKey);
    expect(partialAt(A)).toBeNull();
  });

  it('two into one (A→C, B→C): only the session that landed brings its memory', async () => {
    await stopAfterTheTypedKey(A, PROMPT_TYPED);
    await stopAfterTheTypedKey(B, OTHER_PROMPT_TYPED);
    const memories = { [A]: partialAt(A), [B]: partialAt(B) };
    const result = await move([
      { oldId: A, newId: C },
      { oldId: B, newId: C },
    ]);
    expect(result.renamedSessions).toHaveLength(1);
    const landed = result.renamedSessions[0].oldName === (await sessionNameOf(A, 'claude')) ? A : B;
    const stayed = landed === A ? B : A;
    expect(partialAt(C)?.screenKey).toBe(memories[landed]?.screenKey);
    expect(partialAt(stayed)?.screenKey).toBe(memories[stayed]?.screenKey);
  });

  it('negative: a single move leaves an unrelated instance and worktree alone', async () => {
    await stopAfterTheTypedKey(A, PROMPT_TYPED);
    await stopAfterTheTypedKey(C, OTHER_PROMPT_TYPED);
    const charlie = partialAt(C);
    await move([{ oldId: A, newId: B }]);
    expect(partialAt(C)).toEqual(charlie);
  });

  it('negative: a request with the same id on both sides changes nothing', async () => {
    await stopAfterTheTypedKey(A);
    const alpha = partialAt(A);
    await move([{ oldId: A, newId: A }]);
    expect(partialAt(A)).toEqual(alpha);
  });
});

// =============================================================================
// 10. Moves in a row, and an old key used again
// =============================================================================

describe('[#3713] 10: the send follows its session across moves, and only it', () => {
  it('A→B then B→C before the old send returns: only C is protected', async () => {
    const live = await launch(A, PROMPT_TYPED);
    enable(A);
    typedKeyGate = deferred();
    await ticks(1);
    await move([{ oldId: A, newId: B }]);
    await move([{ oldId: B, newId: C }]);

    const gate = typedKeyGate;
    typedKeyGate = null;
    gate.resolve();
    await vi.advanceTimersByTimeAsync(TUI_TEXT_INPUT_WAIT_MS);
    await settle();

    expect(partialAt(C)).not.toBeNull();
    expect(partialAt(B)).toBeNull();
    expect(partialAt(A)).toBeNull();
    await ticks(3);
    expect(live.keys).toEqual(['y']);
  });

  it("after A↔B, a new send under A that is stopped records at A, not at B", async () => {
    await stopAfterTheTypedKey(A, PROMPT_TYPED);
    await launch(B, 'idle');
    enable(B);
    await move([
      { oldId: A, newId: B },
      { oldId: B, newId: A },
    ]);
    const bravoMemory = partialAt(B);
    // The session now under A (formerly B's) gets a prompt; its answer is stopped.
    const nowAlpha = sessions.get(await sessionNameOf(A, 'claude'))!;
    nowAlpha.pane = OTHER_PROMPT_TYPED;
    await ticks(1);
    expect(nowAlpha.keys).toEqual(['y']);
    renew(A);
    await vi.advanceTimersByTimeAsync(TUI_TEXT_INPUT_WAIT_MS);
    await settle();

    expect(partialAt(A)).not.toBeNull();
    expect(partialAt(B)).toEqual(bravoMemory);
  });

  it('negative: an ordinary disable → enable on the same key keeps the protection', async () => {
    const live = await launch(A, PROMPT_TYPED);
    enable(A);
    await ticks(1);
    // disable → enable while the Enter is withheld
    setAutoYesEnabled(A, 'claude', false);
    const { stopAutoYesPolling } = await import('@/lib/auto-yes-poller');
    stopAutoYesPolling(keyOf(A));
    enable(A);
    await vi.advanceTimersByTimeAsync(TUI_TEXT_INPUT_WAIT_MS);
    await settle();
    await ticks(3);
    expect(live.keys).toEqual(['y']);
  });
});

// =============================================================================
// 11. / 12. How an attempt ends, and how long it lives
// =============================================================================

describe('[#3713] 11: an attempt ends only itself', () => {
  it('a full answer, a stop before any key and a failed send leave no attempt and no memory', async () => {
    const live = await launch(A, PROMPT_TYPED);
    enable(A);
    await ticks(1);
    await vi.advanceTimersByTimeAsync(TUI_TEXT_INPUT_WAIT_MS);
    await settle();
    expect(live.keys).toEqual(['y', '<Enter>']);
    expect(globalThis.__autoYesSendAttempts?.size ?? 0).toBe(0);
    expect(partialAt(A)).toBeNull();

    const attempt = beginSendAttempt(keyOf(B), 'screen', getEnterFallbackSessionEpoch(keyOf(B)));
    settleSendAttempt(attempt, false);
    expect(globalThis.__autoYesSendAttempts?.size ?? 0).toBe(0);
    expect(globalThis.__autoYesPartialAnswers?.has(keyOf(B))).toBe(false);
  });

  it("the old attempt's settling does not end the successor's attempt", async () => {
    const epoch = getEnterFallbackSessionEpoch(keyOf(B));
    const old = beginSendAttempt(keyOf(A), 'screen', getEnterFallbackSessionEpoch(keyOf(A)));
    movePartialAnswers([{ oldKey: keyOf(A), newKey: keyOf(B), sourceEpoch: getEnterFallbackSessionEpoch(keyOf(A)) }]);
    const successor = beginSendAttempt(keyOf(B), 'screen', epoch);
    settleSendAttempt(old, false);
    expect(globalThis.__autoYesSendAttempts?.has(successor)).toBe(true);
    expect(hasMovedSendInFlight(keyOf(B), epoch, 'screen')).toBe(false);
    settleSendAttempt(successor, false);
  });

  it('negative: a stop with keys on the pane keeps the memory; a full answer is still taken as answered', async () => {
    await stopAfterTheTypedKey(A);
    expect(partialAt(A)).not.toBeNull();

    const live = await launch(B, PROMPT_TYPED);
    enable(B);
    await ticks(1);
    await vi.advanceTimersByTimeAsync(TUI_TEXT_INPUT_WAIT_MS);
    await settle();
    expect(live.keys).toEqual(['y', '<Enter>']);
    expect(globalThis.__autoYesPollerStates?.get(keyOf(B))?.lastAnsweredPromptKey).not.toBeNull();
    expect(partialAt(B)).toBeNull();
  });
});

describe('[#3713] 12: lifetime', () => {
  it('a send held for ten minutes keeps the successor off the prompt (no TTL)', async () => {
    const live = await launch(A, PROMPT_TYPED);
    enable(A);
    typedKeyGate = deferred();
    await ticks(1);
    await move([{ oldId: A, newId: B }]);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    await settle();
    expect(live.keys).toEqual(['y']);
  });

  it('the worktree removed while the send is held: its return revives nothing', async () => {
    await launch(A, PROMPT_TYPED);
    enable(A);
    typedKeyGate = deferred();
    await ticks(1);
    await move([{ oldId: A, newId: B }]);
    stopAutoYesPollingByWorktree(B);

    const gate = typedKeyGate;
    typedKeyGate = null;
    gate.resolve();
    await vi.advanceTimersByTimeAsync(TUI_TEXT_INPUT_WAIT_MS);
    await settle();
    expect(globalThis.__autoYesPartialAnswers?.has(keyOf(B))).toBe(false);
  });

  it('every poller stopped (shutdown) while the send is held: its return revives nothing', async () => {
    await launch(A, PROMPT_TYPED);
    enable(A);
    typedKeyGate = deferred();
    await ticks(1);
    stopAllAutoYesPolling();

    const gate = typedKeyGate;
    typedKeyGate = null;
    gate.resolve();
    await vi.advanceTimersByTimeAsync(TUI_TEXT_INPUT_WAIT_MS);
    await settle();
    expect(globalThis.__autoYesPartialAnswers?.size ?? 0).toBe(0);
  });

  it('negative: without a move, the prompt leaving the screen lets its return be answered', async () => {
    const live = await stopAfterTheTypedKey(A);
    live.pane = 'idle';
    await ticks(1);
    live.pane = PROMPT_TYPED;
    await ticks(1);
    await vi.advanceTimersByTimeAsync(TUI_TEXT_INPUT_WAIT_MS);
    await settle();
    expect(live.keys).toEqual(['y', 'y', '<Enter>']);
  });
});

// =============================================================================
// 13. Instances and namespaces
// =============================================================================

describe('[#3713] 13: each instance that moved carries its own memory', () => {
  it('an additional instance with no roster row, and another CLI tool', async () => {
    const extra = await launch(A, PROMPT_TYPED, 'claude', 'claude-2');
    enable(A, 'claude', 'claude-2');
    await ticks(1);
    expect(extra.keys).toEqual(['y']);
    renew(A, 'claude', 'claude-2');
    await vi.advanceTimersByTimeAsync(TUI_TEXT_INPUT_WAIT_MS);
    await settle();
    expect(partialAt(A, 'claude', 'claude-2')).not.toBeNull();

    await stopAfterTheTypedKey(A, PROMPT_TYPED, 'gemini');
    await move([{ oldId: A, newId: B }]);

    expect(partialAt(B, 'claude', 'claude-2')).not.toBeNull();
    expect(partialAt(B, 'gemini')).not.toBeNull();
    expect(partialAt(B, 'claude')).toBeNull();
  });

  it('a roster instance', async () => {
    setAgentInstances(db, A, [
      { id: 'claude', cliTool: 'claude', alias: null },
      { id: 'claude-3', cliTool: 'claude', alias: null },
    ] as never);
    await launch(A, PROMPT_TYPED, 'claude', 'claude-3');
    enable(A, 'claude', 'claude-3');
    await ticks(1);
    renew(A, 'claude', 'claude-3');
    await vi.advanceTimersByTimeAsync(TUI_TEXT_INPUT_WAIT_MS);
    await settle();
    await move([{ oldId: A, newId: B }]);
    expect(partialAt(B, 'claude', 'claude-3')).not.toBeNull();
  });

  it('negative: an instance whose session did not move keeps its memory where it was', async () => {
    await stopAfterTheTypedKey(A);
    // The primary's session is gone; only another instance is live.
    sessions.delete(await sessionNameOf(A, 'claude'));
    await launch(A, 'idle', 'claude', 'claude-2');
    const alpha = globalThis.__autoYesPartialAnswers?.get(keyOf(A));
    await move([{ oldId: A, newId: B }]);
    expect(globalThis.__autoYesPartialAnswers?.get(keyOf(A))).toEqual(alpha);
    expect(globalThis.__autoYesPartialAnswers?.has(keyOf(B))).toBe(false);
    expect(globalThis.__autoYesPartialAnswers?.has(keyOf(B, 'claude', 'claude-2'))).toBe(false);
  });
});

// =============================================================================
// 14. / 15. The reason, and the paths that are not Auto-Yes's
// =============================================================================

describe('[#3713] 14/15: the reason is a member, and only the poller produces it', () => {
  it('the moved memory is published as a partial-answer suppression under the new id', async () => {
    await stopAfterTheTypedKey(A);
    await move([{ oldId: A, newId: B }]);
    await ticks(1);
    expect(getLastPolicySuppression(B, 'claude')).toMatchObject({ reason: 'partial-answer', mode: null });
  });

  it('negative: a manual answer (no stillCurrent) sends the same keys and registers no attempt', async () => {
    const live = await launch(A, PROMPT_TYPED);
    const { sendPromptAnswer } = await import('@/lib/prompt-answer-sender');
    const sending = sendPromptAnswer({ sessionName: await sessionNameOf(A, 'claude'), answer: 'y', cliToolId: 'claude' });
    expect(globalThis.__autoYesSendAttempts?.size ?? 0).toBe(0);
    await vi.advanceTimersByTimeAsync(TUI_TEXT_INPUT_WAIT_MS);
    await sending;
    expect(live.keys).toEqual(['y', '<Enter>']);
    expect(globalThis.__autoYesPartialAnswers?.size ?? 0).toBe(0);
  });

  it('negative: the policy resolver never returns partial-answer', async () => {
    const { resolveAutoAnswerWithPolicy } = await import('@/lib/polling/auto-yes-resolver');
    const prompt = { type: 'yes_no', question: 'Proceed?', options: ['yes', 'no'], status: 'pending' } as const;
    const reasons = [
      resolveAutoAnswerWithPolicy(prompt as never, { mode: 'off' } as never).suppressedBy,
      resolveAutoAnswerWithPolicy(prompt as never, null).suppressedBy,
      resolveAutoAnswerWithPolicy(prompt as never, { mode: 'safe', denyPatterns: ['Proceed'] } as never).suppressedBy,
    ];
    expect(reasons).not.toContain('partial-answer');
    expect(reasons[0]).toBe('mode-off');
  });
});

// =============================================================================
// Re-instruction 1 (Codex review P2 x 3)
// =============================================================================

/** The auto-yes route, as `commandmate auto-yes <id> --disable` (no agent) calls it. */
async function postAutoYes(worktreeId: string, body: unknown): Promise<Response> {
  const { NextRequest } = await import('next/server');
  const { POST } = await import('@/app/api/worktrees/[id]/auto-yes/route');
  const request = new NextRequest(`http://localhost:3000/api/worktrees/${worktreeId}/auto-yes`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  return (await POST(request, { params: Promise.resolve({ id: worktreeId }) })) as Response;
}

describe('[#3713] re-instruction P2-1: disabling every agent is a disable, not a delete', () => {
  it('route disable (no agent) while the Enter is withheld → the old send returns → enable: no second y', async () => {
    const live = await launch(A, PROMPT_TYPED);
    enable(A);
    await ticks(1);
    expect(live.keys).toEqual(['y']);

    const res = await postAutoYes(A, { enabled: false });
    expect(res.status).toBe(200);
    await vi.advanceTimersByTimeAsync(TUI_TEXT_INPUT_WAIT_MS); // the old send comes back, stopped
    await settle();
    expect(partialAt(A)).not.toBeNull();

    enable(A);
    await ticks(3);
    expect(live.keys).toEqual(['y']);
    expect((captures.get(await sessionNameOf(A, 'claude')) ?? 0)).toBeGreaterThanOrEqual(4);
  });

  it('route disable (no agent) keeps a memory already recorded', async () => {
    const live = await stopAfterTheTypedKey(A);
    await postAutoYes(A, { enabled: false });
    expect(partialAt(A)).not.toBeNull();
    enable(A);
    await ticks(3);
    expect(live.keys).toEqual(['y']);
  });

  it('negative: the worktree being deleted (session-cleanup\'s lifecycle call) still expires the send', async () => {
    await launch(A, PROMPT_TYPED);
    enable(A);
    await ticks(1);
    const { stopAutoYesPollersFor } = await import('@/lib/auto-yes-lifecycle');
    stopAutoYesPollersFor('worktree-deleted', { scope: 'worktree', worktreeId: A });
    await vi.advanceTimersByTimeAsync(TUI_TEXT_INPUT_WAIT_MS);
    await settle();
    expect(globalThis.__autoYesPartialAnswers?.has(keyOf(A)) ?? false).toBe(false);
  });
});

describe('[#3713] re-instruction P2-2: a late old send does not overwrite a later memory', () => {
  it("A's X in flight → A→B → B stops its own answer to Y → old A returns: B keeps Y", async () => {
    const live = await launch(A, PROMPT_TYPED);
    enable(A);
    typedKeyGateOnce = deferred();
    const oldSend = typedKeyGateOnce;
    await ticks(1);
    expect(live.keys).toEqual(['y']);

    await move([{ oldId: A, newId: B }]);
    // A human dealt with X; the agent moved on to Y, and B's answer to it is stopped too.
    live.pane = OTHER_PROMPT_TYPED;
    await ticks(1);
    expect(live.keys).toEqual(['y', 'y']);
    renew(B);
    await vi.advanceTimersByTimeAsync(TUI_TEXT_INPUT_WAIT_MS);
    await settle();
    const bravo = partialAt(B);
    expect(bravo).not.toBeNull();

    oldSend.resolve();
    await vi.advanceTimersByTimeAsync(TUI_TEXT_INPUT_WAIT_MS);
    await settle();
    expect(partialAt(B)).toEqual(bravo);

    await ticks(3);
    expect(live.keys).toEqual(['y', 'y']);
  });

  it('registry: a send begun earlier does not overwrite what a send begun later recorded', () => {
    const key = keyOf(B);
    const epoch = getEnterFallbackSessionEpoch(key);
    const earlier = beginSendAttempt(key, 'X', epoch);
    const later = beginSendAttempt(key, 'Y', epoch);
    settleSendAttempt(later, true);
    settleSendAttempt(earlier, true);
    expect(getPartialAnswer(key, epoch)?.screenKey).toBe('Y');
  });

  it('negative: a memory recorded before the send began is replaced by its stop', () => {
    const key = keyOf(B);
    const epoch = getEnterFallbackSessionEpoch(key);
    settleSendAttempt(beginSendAttempt(key, 'Y', epoch), true);
    settleSendAttempt(beginSendAttempt(key, 'X', epoch), true);
    expect(getPartialAnswer(key, epoch)?.screenKey).toBe('X');
  });
});

describe('[#3713] re-instruction P2-3: a memory the move left out stays at the source', () => {
  it('A is relaunched during the renames and the new session stops an answer: that memory stays under A', async () => {
    await stopAfterTheTypedKey(A);
    let newGeneration: unknown = null;
    await move([{ oldId: A, newId: B }], {
      onRename: (_oldName, newName) => {
        if (newName.startsWith('cmate-renaming-')) {
          beginEnterFallbackSession(A, 'claude');
          const epoch = getEnterFallbackSessionEpoch(keyOf(A));
          settleSendAttempt(beginSendAttempt(keyOf(A), 'Z', epoch), true);
          newGeneration = getPartialAnswer(keyOf(A), epoch);
        }
        return undefined;
      },
    });
    expect(newGeneration).not.toBeNull();
    expect(partialAt(A)).toEqual(newGeneration);
    expect(partialAt(B)).toBeNull();
  });

  it('negative: the memory that moved is gone from the source', async () => {
    await stopAfterTheTypedKey(A);
    await move([{ oldId: A, newId: B }]);
    expect(globalThis.__autoYesPartialAnswers?.has(keyOf(A))).toBe(false);
    expect(partialAt(B)).not.toBeNull();
  });
});
