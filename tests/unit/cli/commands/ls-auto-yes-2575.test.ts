/**
 * `commandmate ls`: the AUTO_YES column (Issue #2575).
 *
 * `ls` already prints `waiting`, and until now that word was all a CLI-side
 * operator got: a prompt Auto-Yes is about to answer and a prompt nobody will
 * ever answer printed identically. The column added here is the difference
 * between the two, and it is derived from the row `GET /api/worktrees` already
 * sends (#2512's `autoYesByInstance` plus the un-aggregated
 * `sessionStatusByInstance`) — no push subscription, no VAPID key, no second
 * request. That independence is the acceptance criterion this suite pins: the
 * environment the Issue came from had no VAPID keys at all, so any answer that
 * needed a notification to arrive was no answer.
 *
 * The clock is frozen with `vi.useFakeTimers({ toFake: ['Date'] })` (precedent:
 * `tests/unit/app/api/worktrees/auto-yes-list-2512.test.ts`). Only `Date` is
 * faked, so ApiClient's own timers keep running; without the freeze the
 * expectation `10:00` for `now + 10 minutes` flickers to `09:59`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockFetchResponse, restoreFetch } from '../../../helpers/mock-api';
// The Web UI countdown. Imported HERE and not in `ls.ts`: it pulls
// `@/config/tmux-pane-config`, and `tsconfig.cli.json` sets `"paths": {}`, so a
// CLI module importing it breaks `npm run build:cli` while lint / tsc / vitest
// stay green. The duplicate in `ls.ts` is the price; this suite is what keeps
// the two spellings of the same format from drifting.
import { formatTimeRemaining } from '@/config/auto-yes-config';
import type { AutoYesInstanceSummary } from '@/types/auto-yes';
import type { CliToolSessionStatus } from '@/lib/session/worktree-status-helper';
import type { AutoYesInstanceWire, LsWorktreeItem } from '../../../../src/cli/commands/ls';

const mockExit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
const mockConsoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});

/** Frozen "now". Every `expiresAt` below is written relative to it. */
const NOW = new Date('2026-09-16T12:00:00Z').getTime();
const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
  restoreFetch();
  mockExit.mockClear();
  mockConsoleLog.mockClear();
});

async function runLs(worktrees: unknown[], args: string[] = []): Promise<string> {
  mockFetchResponse({ worktrees, repositories: [] });
  const { createLsCommand } = await import('../../../../src/cli/commands/ls');
  const cmd = createLsCommand();
  await cmd.parseAsync(['node', 'ls', ...args]);
  return mockConsoleLog.mock.calls[0][0] as string;
}

/** Every URL the command dialled, so "no second request" can be asserted. */
function fetchedUrls(): string[] {
  const mock = global.fetch as unknown as { mock?: { calls: unknown[][] } };
  return (mock.mock?.calls ?? []).map((call) => String(call[0]));
}

/** The cells of one data row, split on the two-space column gap. */
function cellsOf(out: string, id: string): string[] {
  const line = out
    .split('\n')
    .find((candidate) => candidate.split(/\s{2,}/)[0] === id);
  if (!line) throw new Error(`no row for ${id} in:\n${out}`);
  return line.split(/\s{2,}/);
}

/** The AUTO_YES cell of one row. ` (<instanceId>)` survives: one space, not two. */
function autoYesCell(out: string, id: string): string {
  const cells = cellsOf(out, id);
  return cells[cells.length - 1];
}

// ---------------------------------------------------------------------------
// Fixtures: the shape the CURRENT server sends.
//
// `sessionStatusByInstance` carries the un-aggregated per-instance rows, and
// rule 2 of the cell contract reads it. A fixture with only `sessionStatusByCli`
// (what the older `ls` suites use) would make every non-idle row `-` and would
// test nothing about Auto-Yes.
// ---------------------------------------------------------------------------

const WAITING_TOP = { isSessionRunning: true, isWaitingForResponse: true, isProcessing: false };
const RUNNING_TOP = { isSessionRunning: true, isWaitingForResponse: false, isProcessing: true };
const READY_TOP = { isSessionRunning: true, isWaitingForResponse: false, isProcessing: false };
const IDLE_TOP = { isSessionRunning: false, isWaitingForResponse: false, isProcessing: false };

const WAITING_ENTRY = {
  isRunning: true,
  isWaitingForResponse: true,
  isProcessing: false,
  sessionStatusReason: 'prompt_detected',
  statusEvidence: 'positive',
};
const RUNNING_ENTRY = {
  isRunning: true,
  isWaitingForResponse: false,
  isProcessing: true,
  sessionStatusReason: 'thinking_indicator',
  statusEvidence: 'positive',
};
const READY_ENTRY = {
  isRunning: true,
  isWaitingForResponse: false,
  isProcessing: false,
  sessionStatusReason: 'input_prompt',
  statusEvidence: 'positive',
};
const IDLE_ENTRY = { isRunning: false, isWaitingForResponse: false, isProcessing: false };
const EXITED_ENTRY = { ...IDLE_ENTRY, sessionStatusReason: 'exited', statusEvidence: 'positive' };

/** Armed until `NOW + ms`. */
function armed(ms: number): { enabled: boolean; expiresAt: number } {
  return { enabled: true, expiresAt: NOW + ms };
}

interface RowSpec {
  id: string;
  name?: string;
  cliToolId?: string;
  top: Record<string, unknown>;
  byInstance?: Record<string, unknown>;
  byCli?: Record<string, unknown>;
  autoYes?: Record<string, unknown>;
}

/** One `/api/worktrees` row. Keys are omitted, not nulled, when not given. */
function row(spec: RowSpec): Record<string, unknown> {
  return {
    id: spec.id,
    name: spec.name ?? spec.id,
    ...(spec.cliToolId === undefined ? {} : { cliToolId: spec.cliToolId }),
    ...spec.top,
    ...(spec.byInstance ? { sessionStatusByInstance: spec.byInstance } : {}),
    ...(spec.byCli ? { sessionStatusByCli: spec.byCli } : {}),
    ...(spec.autoYes ? { autoYesByInstance: spec.autoYes } : {}),
  };
}

describe('[#2575] ls table: the AUTO_YES column is appended, not inserted', () => {
  it('adds AUTO_YES as the sixth header and leaves the first five where they were', async () => {
    const worktrees = [
      row({
        id: 'wt-a',
        name: 'main',
        cliToolId: 'claude',
        top: WAITING_TOP,
        byInstance: { claude: WAITING_ENTRY },
        byCli: { claude: WAITING_ENTRY },
        autoYes: {},
      }),
      row({
        id: 'wt-long-id',
        name: 'feature/very-long-branch',
        cliToolId: 'claude',
        top: RUNNING_TOP,
        byInstance: { 'codex-2': RUNNING_ENTRY },
        byCli: { codex: RUNNING_ENTRY },
        autoYes: { 'codex-2': armed(HOUR + 5 * MINUTE + 33 * SECOND) },
      }),
    ];
    const out = await runLs(worktrees);
    const lines = out.split('\n');

    expect(lines[0].trim().split(/\s+/)).toEqual([
      'ID', 'NAME', 'STATUS', 'REASON', 'DEFAULT', 'AUTO_YES',
    ]);

    // The first five columns keep the offsets they had BEFORE the sixth existed.
    // Recomputed here from the same input with the old five-column width rule:
    // appending cannot move them, and this is what says so.
    const before = [
      ['ID', 'NAME', 'STATUS', 'REASON', 'DEFAULT'],
      ['wt-a', 'main', 'waiting', 'prompt_detected', 'claude'],
      ['wt-long-id', 'feature/very-long-branch', 'running', 'thinking_indicator', 'claude'],
    ];
    const widths = before[0].map((_, col) => Math.max(...before.map((r) => r[col].length)));
    let offset = 0;
    for (let col = 0; col < widths.length; col += 1) {
      for (let line = 0; line < before.length; line += 1) {
        expect(lines[line === 0 ? 0 : line + 1].indexOf(before[line][col], offset)).toBe(offset);
      }
      offset += widths[col] + 2;
    }
    // ...and the sixth starts right after the fifth, on the header and on every row.
    expect(lines[0].indexOf('AUTO_YES')).toBe(offset);
    expect(lines[2].indexOf('off')).toBe(offset);
    expect(lines[3].indexOf('1:05:33 (codex-2)')).toBe(offset);
  });

  it('leaves no trailing whitespace on any line', async () => {
    // The final column is deliberately not padded: ` (<instanceId>)` can carry a
    // 64-character id, and padding every row out to that width would wrap the
    // whole table on a narrow terminal because of one long row. Before #2575 the
    // final column was DEFAULT and every line DID end in padding.
    const out = await runLs([
      row({
        id: 'wt-a',
        cliToolId: 'claude',
        top: WAITING_TOP,
        byInstance: { claude: WAITING_ENTRY },
        autoYes: {},
      }),
      row({
        id: 'wt-b',
        cliToolId: 'claude',
        top: WAITING_TOP,
        byInstance: { 'claude-instance-with-a-very-long-id': WAITING_ENTRY },
        autoYes: { 'claude-instance-with-a-very-long-id': armed(10 * MINUTE) },
      }),
    ]);

    for (const line of out.split('\n')) {
      expect(line).toBe(line.trimEnd());
    }
  });
});

describe('[#2575] acceptance: the waiting row says whether anyone will answer', () => {
  it('prints off for a waiting instance with no Auto-Yes, from the list row alone', async () => {
    const out = await runLs([
      row({
        id: 'wt-a',
        cliToolId: 'claude',
        top: WAITING_TOP,
        byInstance: { claude: WAITING_ENTRY },
        byCli: { claude: WAITING_ENTRY },
        autoYes: {},
      }),
    ]);

    expect(cellsOf(out, 'wt-a')[2]).toBe('waiting');
    expect(autoYesCell(out, 'wt-a')).toBe('off');
    // The point of the column: no push subscription, no VAPID probe, no second
    // request. The Issue's server had no VAPID keys at all.
    for (const url of fetchedUrls()) {
      expect(url).not.toContain('/api/push');
    }
    expect(fetchedUrls().filter((u) => !u.includes('/api/capabilities'))).toEqual([
      expect.stringContaining('/api/worktrees'),
    ]);
  });

  it('prints 10:00 for a waiting instance armed until now + 10 minutes', async () => {
    const out = await runLs([
      row({
        id: 'wt-b',
        cliToolId: 'claude',
        top: WAITING_TOP,
        byInstance: { claude: WAITING_ENTRY },
        byCli: { claude: WAITING_ENTRY },
        autoYes: { claude: armed(10 * MINUTE) },
      }),
    ]);

    expect(autoYesCell(out, 'wt-b')).toBe('10:00');
  });

  it('prints off for an expiry that has already passed', async () => {
    // The server folds an expired arming away at read time, but the clocks are
    // two different machines' clocks: a past `expiresAt` can still arrive. It
    // must never round back up into "armed" — the same direction #959's
    // `displayEnabled = enabled && !hasExpired` falls in.
    const out = await runLs([
      row({
        id: 'wt-past',
        cliToolId: 'claude',
        top: WAITING_TOP,
        byInstance: { claude: WAITING_ENTRY },
        autoYes: { claude: { enabled: true, expiresAt: NOW - SECOND } },
      }),
      row({
        id: 'wt-exact',
        cliToolId: 'claude',
        top: WAITING_TOP,
        byInstance: { claude: WAITING_ENTRY },
        autoYes: { claude: { enabled: true, expiresAt: NOW } },
      }),
      row({
        id: 'wt-off',
        cliToolId: 'claude',
        top: WAITING_TOP,
        byInstance: { claude: WAITING_ENTRY },
        autoYes: { claude: { enabled: false, expiresAt: NOW + HOUR } },
      }),
    ]);

    expect(autoYesCell(out, 'wt-past')).toBe('off');
    expect(autoYesCell(out, 'wt-exact')).toBe('off');
    expect(autoYesCell(out, 'wt-off')).toBe('off');
  });

  it('prints - for a server that does not publish autoYesByInstance', async () => {
    // A CLI newer than the daemon it dials is the ordinary case. "I do not know"
    // is the honest cell; `off` there would be a claim about a field nobody sent.
    const out = await runLs([
      row({
        id: 'wt-old',
        cliToolId: 'claude',
        top: WAITING_TOP,
        byInstance: { claude: WAITING_ENTRY },
        byCli: { claude: WAITING_ENTRY },
      }),
    ]);

    expect(autoYesCell(out, 'wt-old')).toBe('-');
    expect(out).not.toContain('undefined');
  });
});

describe('[#2575] the cell is about the instance that explains the STATUS', () => {
  it('ignores an armed instance that is not the one waiting', async () => {
    // `claude` raised the wait and has no Auto-Yes; `codex` is merely thinking.
    // Printing codex's remaining time here would hide the prompt this column
    // exists to surface.
    const out = await runLs([
      row({
        id: 'wt-a',
        cliToolId: 'claude',
        top: WAITING_TOP,
        byInstance: { claude: WAITING_ENTRY, codex: RUNNING_ENTRY },
        autoYes: { codex: armed(42 * MINUTE) },
      }),
    ]);

    expect(autoYesCell(out, 'wt-a')).toBe('off');
  });

  it('names the instance when it is not the default agent primary', async () => {
    const out = await runLs([
      row({
        id: 'wt-c',
        cliToolId: 'claude',
        top: WAITING_TOP,
        byInstance: { claude: READY_ENTRY, 'codex-2': WAITING_ENTRY },
        autoYes: { 'codex-2': armed(10 * MINUTE) },
      }),
    ]);

    expect(autoYesCell(out, 'wt-c')).toBe('10:00 (codex-2)');
  });

  it('names the instance on an off cell too (the row where REASON cannot)', async () => {
    // Issue acceptance criterion 5: the default `claude` is armed but is not
    // waiting; `codex-2` is waiting and is not armed. REASON on this row is `-`
    // (the per-TOOL aggregate for codex merges codex and codex-2 and loses the
    // reason, #1926), so the parenthesis in AUTO_YES is the only thing on the
    // line that names an instance.
    const out = await runLs([
      row({
        id: 'wt-e',
        cliToolId: 'claude',
        top: WAITING_TOP,
        byInstance: { claude: READY_ENTRY, 'codex-2': WAITING_ENTRY },
        byCli: {
          claude: READY_ENTRY,
          codex: { isRunning: true, isWaitingForResponse: true, isProcessing: false },
        },
        autoYes: { claude: armed(42 * MINUTE) },
      }),
    ]);

    expect(cellsOf(out, 'wt-e')[3]).toBe('-');
    expect(autoYesCell(out, 'wt-e')).toBe('off (codex-2)');
  });

  it('names the instance when the row declares no default agent', async () => {
    const out = await runLs([
      row({
        id: 'wt-nodefault',
        top: WAITING_TOP,
        byInstance: { codex: WAITING_ENTRY },
        autoYes: { codex: armed(5 * MINUTE) },
      }),
    ]);

    expect(autoYesCell(out, 'wt-nodefault')).toBe('05:00 (codex)');
  });
});

describe('[#2575] several instances explain the status: the smallest remaining wins', () => {
  it('reports off when one of them is unarmed, whatever the others have left', async () => {
    // The row the Issue is about. `codex` has 10 minutes of Auto-Yes; `claude`
    // is waiting with none. Printing `10:00` would bury a prompt only a human
    // can clear under a countdown that has nothing to do with it.
    const out = await runLs([
      row({
        id: 'wt-d',
        cliToolId: 'claude',
        top: WAITING_TOP,
        byInstance: { claude: WAITING_ENTRY, codex: WAITING_ENTRY },
        autoYes: { codex: armed(10 * MINUTE) },
      }),
    ]);

    // Unlabelled: the minimum is the default agent's own primary.
    expect(autoYesCell(out, 'wt-d')).toBe('off');
  });

  it('reports the earliest expiry and names it', async () => {
    const out = await runLs([
      row({
        id: 'wt-min',
        cliToolId: 'claude',
        top: WAITING_TOP,
        byInstance: { claude: WAITING_ENTRY, codex: WAITING_ENTRY },
        autoYes: { claude: armed(30 * MINUTE), codex: armed(10 * MINUTE) },
      }),
    ]);

    expect(autoYesCell(out, 'wt-min')).toBe('10:00 (codex)');
  });

  it('breaks a tie toward the default agent primary, then by instance id', async () => {
    // Determinism: `Object.keys` order is the server's insertion order, and the
    // cell must not depend on it.
    const out = await runLs([
      row({
        id: 'wt-tie',
        cliToolId: 'claude',
        top: WAITING_TOP,
        byInstance: { codex: WAITING_ENTRY, claude: WAITING_ENTRY },
        autoYes: { codex: armed(10 * MINUTE), claude: armed(10 * MINUTE) },
      }),
      row({
        id: 'wt-tie2',
        cliToolId: 'claude',
        top: WAITING_TOP,
        byInstance: { codex: WAITING_ENTRY, antigravity: WAITING_ENTRY },
        autoYes: { codex: armed(10 * MINUTE), antigravity: armed(10 * MINUTE) },
      }),
    ]);

    expect(autoYesCell(out, 'wt-tie')).toBe('10:00');
    expect(autoYesCell(out, 'wt-tie2')).toBe('10:00 (antigravity)');
  });
});

describe('[#2575] the fallback to every armed instance is idle-only', () => {
  it('reads autoYesByInstance whole on a bare idle row', async () => {
    const out = await runLs([
      row({
        id: 'wt-idle',
        cliToolId: 'claude',
        top: IDLE_TOP,
        byInstance: { claude: IDLE_ENTRY, codex: IDLE_ENTRY },
        autoYes: { codex: armed(7 * MINUTE) },
      }),
    ]);

    expect(cellsOf(out, 'wt-idle')[2]).toBe('idle');
    expect(autoYesCell(out, 'wt-idle')).toBe('07:00 (codex)');
  });

  it('prints off for an idle row with nothing armed', async () => {
    const out = await runLs([
      row({
        id: 'wt-idle-empty',
        cliToolId: 'claude',
        top: IDLE_TOP,
        byInstance: { claude: IDLE_ENTRY },
        autoYes: {},
      }),
    ]);

    expect(autoYesCell(out, 'wt-idle-empty')).toBe('off');
  });

  it('falls back on an idle row that carries no per-instance map at all', async () => {
    const out = await runLs([
      row({
        id: 'wt-idle-nomap',
        cliToolId: 'claude',
        top: IDLE_TOP,
        autoYes: { claude: armed(3 * MINUTE) },
      }),
      row({
        id: 'wt-idle-emptymap',
        cliToolId: 'claude',
        top: IDLE_TOP,
        byInstance: {},
        autoYes: { claude: armed(3 * MINUTE) },
      }),
    ]);

    expect(autoYesCell(out, 'wt-idle-nomap')).toBe('03:00');
    expect(autoYesCell(out, 'wt-idle-emptymap')).toBe('03:00');
  });

  it('uses the exited instance, not the armed one, on an idle row that has one', async () => {
    // `exited` is the one reason an idle row can carry (#2070), so that instance
    // DOES explain the status and the fallback never runs. The armed `codex`
    // says nothing about the session that died under the operator.
    const out = await runLs([
      row({
        id: 'wt-exited',
        cliToolId: 'claude',
        top: IDLE_TOP,
        byInstance: { claude: EXITED_ENTRY, codex: IDLE_ENTRY },
        autoYes: { codex: armed(30 * MINUTE) },
      }),
    ]);

    expect(autoYesCell(out, 'wt-exited')).toBe('off');
  });

  it('prints - when a non-idle row has no instance explaining its status', async () => {
    // Cannot happen against the current server — the row's flags are the OR of
    // the per-instance ones. If a server change ever breaks that, the fallback
    // must NOT fire here: looking at the armed instances only would print a
    // countdown next to a `waiting` nobody is going to answer, which is the
    // exact failure this column exists to prevent.
    const out = await runLs([
      row({
        id: 'wt-nomap',
        cliToolId: 'claude',
        top: WAITING_TOP,
        autoYes: { claude: armed(30 * MINUTE) },
      }),
      row({
        id: 'wt-silent',
        cliToolId: 'claude',
        top: WAITING_TOP,
        byInstance: { claude: READY_ENTRY },
        autoYes: { claude: armed(30 * MINUTE) },
      }),
    ]);

    expect(autoYesCell(out, 'wt-nomap')).toBe('-');
    expect(autoYesCell(out, 'wt-silent')).toBe('-');
  });
});

describe('[#2575] what the column deliberately does not do', () => {
  it('drops a running instance\'s remaining time when an unarmed one shares the row', async () => {
    // The accepted trade-off: one interactive, unarmed instance on a `ready` row
    // hides the armed one's countdown. "The instance that will stop first" is
    // one rule for all four status words; the breakdown is in `ls --json`.
    const out = await runLs([
      row({
        id: 'wt-ready',
        cliToolId: 'claude',
        top: READY_TOP,
        byInstance: { claude: READY_ENTRY, codex: READY_ENTRY },
        autoYes: { claude: armed(42 * MINUTE) },
      }),
    ]);

    expect(autoYesCell(out, 'wt-ready')).toBe('off (codex)');
  });

  it('leaves REASON picking its own instance, even when AUTO_YES picks another', async () => {
    // REASON is #1926's per-TOOL aggregate with the default tool preferred;
    // AUTO_YES is per-INSTANCE with the minimum preferred. On this row they name
    // different sessions on purpose, and aligning them would be a change to the
    // #1926 contract.
    const out = await runLs([
      row({
        id: 'wt-split',
        cliToolId: 'claude',
        top: WAITING_TOP,
        byInstance: { claude: WAITING_ENTRY, codex: WAITING_ENTRY },
        byCli: { claude: WAITING_ENTRY, codex: RUNNING_ENTRY },
        autoYes: { claude: armed(30 * MINUTE) },
      }),
    ]);

    expect(cellsOf(out, 'wt-split')[3]).toBe('prompt_detected');
    expect(autoYesCell(out, 'wt-split')).toBe('off (codex)');
  });
});

describe('[#2575] the format is the Web UI countdown, spelled twice', () => {
  it('prints H:MM:SS at an hour and over, MM:SS below it, and on for no expiry', async () => {
    const out = await runLs([
      row({
        id: 'wt-hours',
        cliToolId: 'claude',
        top: WAITING_TOP,
        byInstance: { claude: WAITING_ENTRY },
        autoYes: { claude: armed(HOUR + 5 * MINUTE + 33 * SECOND) },
      }),
      row({
        id: 'wt-minutes',
        cliToolId: 'claude',
        top: WAITING_TOP,
        byInstance: { claude: WAITING_ENTRY },
        autoYes: { claude: armed(42 * MINUTE + 10 * SECOND) },
      }),
      row({
        id: 'wt-null',
        cliToolId: 'claude',
        top: WAITING_TOP,
        byInstance: { claude: WAITING_ENTRY },
        // Not a shape the current server produces (`AutoYesState.expiresAt` is a
        // number), but it says `enabled: true`, and armed-with-no-deadline is
        // what the Sessions tile reads the same input as.
        autoYes: { claude: { enabled: true, expiresAt: null } },
      }),
    ]);

    expect(autoYesCell(out, 'wt-hours')).toBe('1:05:33');
    expect(autoYesCell(out, 'wt-minutes')).toBe('42:10');
    expect(autoYesCell(out, 'wt-null')).toBe('on');
  });

  it('treats a malformed arming as unarmed rather than eternal', async () => {
    // `{ enabled: true }` with no `expiresAt` at all is not a shape the server
    // can send (the wire type is `number | null`, pinned by the assertions at
    // the foot of this file). If one ever arrives, it is malformed — and the
    // whole column falls towards `off` when it cannot tell, because the other
    // direction hides a prompt only a human can answer. `null` stays `on`.
    const out = await runLs([
      row({
        id: 'wt-malformed',
        cliToolId: 'claude',
        top: WAITING_TOP,
        byInstance: { claude: WAITING_ENTRY },
        autoYes: { claude: { enabled: true } },
      }),
      row({
        id: 'wt-null',
        cliToolId: 'claude',
        top: WAITING_TOP,
        byInstance: { claude: WAITING_ENTRY },
        autoYes: { claude: { enabled: true, expiresAt: null } },
      }),
    ]);

    expect(autoYesCell(out, 'wt-malformed')).toBe('off');
    expect(autoYesCell(out, 'wt-null')).toBe('on');
  });

  it('treats an unknown expiry as the longest when choosing the minimum', async () => {
    const out = await runLs([
      row({
        id: 'wt-null-min',
        cliToolId: 'claude',
        top: WAITING_TOP,
        byInstance: { claude: WAITING_ENTRY, codex: WAITING_ENTRY },
        autoYes: { claude: { enabled: true, expiresAt: null }, codex: armed(10 * MINUTE) },
      }),
    ]);

    expect(autoYesCell(out, 'wt-null-min')).toBe('10:00 (codex)');
  });

  it('agrees with formatTimeRemaining at every boundary that matters', async () => {
    // The identity that lets an operator read the same number in the browser and
    // in the terminal. Boundaries, not round numbers: the sub-second floor, the
    // last second below an hour, the hour itself, and the longest arming the UI
    // offers.
    const { formatAutoYesRemaining } = await import('../../../../src/cli/commands/ls');

    const cases: Array<[number, string]> = [
      [999, '00:00'],
      [59 * MINUTE + 59 * SECOND + 999, '59:59'],
      [HOUR, '1:00:00'],
      [8 * HOUR, '8:00:00'],
      [10 * MINUTE, '10:00'],
    ];

    for (const [remaining, expected] of cases) {
      expect(formatAutoYesRemaining(remaining)).toBe(expected);
      expect(formatAutoYesRemaining(remaining)).toBe(formatTimeRemaining(NOW + remaining));
    }
  });
});

describe('[#2575] --json and --quiet are untouched', () => {
  it('passes autoYesByInstance through verbatim and synthesises no cell', async () => {
    // `--json` stays "the server's rows, plus #2317's tmuxSession". A derived
    // `autoYesCell` there would read as a server field and would be less
    // accurate than the machine-readable answers (`wait` exit 10,
    // `capture --json`'s `autoYes`), which know about withheld answers.
    const autoYes = { claude: { enabled: true, expiresAt: NOW + 10 * MINUTE } };
    const out = await runLs(
      [
        row({
          id: 'wt-a',
          cliToolId: 'claude',
          top: WAITING_TOP,
          byInstance: { claude: WAITING_ENTRY },
          autoYes,
        }),
      ],
      ['--json'],
    );

    const rows = JSON.parse(out) as Array<Record<string, unknown>>;
    expect(rows[0].autoYesByInstance).toEqual(autoYes);
    expect(rows[0].sessionStatusByInstance).toEqual({ claude: WAITING_ENTRY });
    expect(rows[0]).toHaveProperty('tmuxSession', 'mcbd-claude-wt-a');
    expect(rows[0]).not.toHaveProperty('autoYesCell');
    expect(rows[0]).not.toHaveProperty('autoYes');
  });

  it('still prints ids only for --quiet', async () => {
    const out = await runLs(
      [
        row({ id: 'wt-a', cliToolId: 'claude', top: WAITING_TOP, autoYes: {} }),
        row({ id: 'wt-b', cliToolId: 'claude', top: IDLE_TOP, autoYes: {} }),
      ],
      ['--quiet'],
    );

    expect(out).toBe('wt-a\nwt-b');
  });
});

describe('[#2575] ls --help carries the legend', () => {
  /**
   * What an operator actually sees. `helpInformation()` is NOT that: commander
   * renders `addHelpText` through the listeners only `outputHelp()` emits, so a
   * suite built on it would pass with the section missing from the terminal
   * (measured in `wait-help-1926.test.ts` before it was written).
   */
  async function helpText(): Promise<string> {
    const { createLsCommand } = await import('../../../../src/cli/commands/ls');
    const cmd = createLsCommand();
    let out = '';
    cmd.configureOutput({ writeOut: (str) => { out += str; } });
    cmd.outputHelp();
    return out;
  }

  it('spells out the whole value vocabulary, including the two meanings of -', async () => {
    // docs/** is outside this change's scope, so until the guides catch up this
    // help text is the ONLY place a shipped operator can learn what the column
    // means. Facts are pinned, not prose.
    const help = await helpText();

    expect(help).toContain('AUTO_YES');
    for (const value of ['MM:SS', 'H:MM:SS', 'on', 'off']) {
      expect(help).toContain(value);
    }
    // A legend line whose term is a bare `-`.
    expect(help).toMatch(/\n\s+-\s{2,}\S/);
  });

  it('says a remaining time is not a promise that anything will answer', async () => {
    // Auto-Yes can be armed and still answer nothing: a contract policy can
    // withhold, and a free-text prompt has no answer to give. The column shows a
    // fact (time left), never a prediction.
    const help = await helpText();

    expect(help).toContain('lastSuppression');
    expect(help).toContain('exit 10');
    expect(help).toContain('stopReason');
  });

  it('points at --instance and at the per-instance breakdown', async () => {
    const help = await helpText();

    expect(help).toContain('--instance');
    // The two field names, not the `--json` flag: the flag is in the options
    // list either way, so asserting on it would stay green with the legend's
    // pointer deleted. These two appear only in the legend.
    expect(help).toContain('sessionStatusByInstance');
    expect(help).toContain('autoYesByInstance');
  });

  it('still lists every option it listed before', async () => {
    // `addHelpText('after', …)` appends; it must not have displaced the options.
    const help = await helpText();

    for (const option of ['--json', '--quiet', '--branch <prefix>', '--id <prefix>', '--token <token>']) {
      expect(help).toContain(option);
    }
  });
});

// ---------------------------------------------------------------------------
// Compile-time guards (Issue #2575). `src/cli/types/api-responses.ts` is outside
// this change's scope, so the two maps are declared locally in `ls.ts` — and a
// local mirror is exactly the kind of copy that drifts. These aliases make
// `npx tsc --noEmit` the thing that notices.
//
// Bidirectional on purpose: a server type that merely NARROWS (say `enabled`
// becoming the literal `true`) still means the CLI is reading a shape that no
// longer exists, and a one-way assertion would sleep through it.
// ---------------------------------------------------------------------------
type AssertAssignable<Super, Sub extends Super> = Sub;

type _WireAcceptsServerSummary = AssertAssignable<AutoYesInstanceWire, AutoYesInstanceSummary>;
type _ServerSummaryAcceptsWire = AssertAssignable<AutoYesInstanceSummary, AutoYesInstanceWire>;

/**
 * The per-instance entry with the `Partial<Record>` index's `undefined` removed.
 * `Pick<CliStatusEntry, K>` is TS2344 without this.
 */
type LsInstanceEntry = NonNullable<NonNullable<LsWorktreeItem['sessionStatusByInstance']>[string]>;
/** The four keys `explainsStatus` reads. */
type ExplainKeys = 'isRunning' | 'isWaitingForResponse' | 'isProcessing' | 'sessionStatusReason';

type _ServerEntryReadableByLs = AssertAssignable<
  Pick<LsInstanceEntry, ExplainKeys>,
  Pick<CliToolSessionStatus, ExplainKeys>
>;

describe('[#2575] wire types', () => {
  it('are enforced at compile time (see the aliases above this describe)', () => {
    // Types are erased, so there is nothing to compare at runtime; this test
    // makes the guard discoverable from the suite rather than only from a tsc
    // failure. The runtime behaviour is everything above.
    const fromServer: AutoYesInstanceSummary = { enabled: true, expiresAt: NOW + HOUR };
    const asWire: AutoYesInstanceWire = fromServer;
    expect(asWire.expiresAt).toBe(NOW + HOUR);
  });
});
