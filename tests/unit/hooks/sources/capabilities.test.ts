/**
 * The table of declared source capabilities (Issue #1924, §4 D3 decision 1; the
 * sixth column added by Issue #2197, the seventh row by Issue #2251).
 *
 * `docs/design/multi-agent-state-architecture.md` §4 D3 states this table as the
 * decision, and DR3-006 states why it is pinned *by value* rather than by count:
 * the receipt originally proposed for D3 was
 * `grep -n "=== 'copilot'\|=== 'opencode'" src/lib/session src/lib/hooks` returning
 * zero, and that grep was already zero on the day the Epic opened. A test that
 * counts capabilities, or asserts "each source declares five fields", is the same
 * kind of vacuous green. So every cell is written out here, and the assertion is
 * `toStrictEqual` over exactly the five keys.
 *
 * ## What a mutation costs
 *
 * Phase 1 lands the declarations; the state machine starts reading them one
 * column at a time. Two are read already —
 * `permissionHookPredictsDialog` by `reportPendingDialog`
 * (`tests/unit/hooks/permission-dialog-forecast-1901.test.ts`, #1901) and
 * `sessionStartMayArriveLate` by `recordAgentEvent`
 * (`tests/unit/session/late-session-start-1903.test.ts`, #1903) — and both of
 * those suites flip the cell themselves, so a wrong value there is red twice.
 * The rest are still Phase 4 (`tests/unit/session/turn-model.test.ts`, #1927),
 * and until that exists flipping one of those cells has exactly one detector:
 * this file. That is the point of writing the cells out — the table is the
 * artefact the later Issues are implemented against, so it has to be wrong
 * *loudly* rather than quietly. The mapping from each flip to the case it must
 * break is recorded next to each column below.
 *
 * ## The columns, and what a wrong value does downstream
 *
 * - `permissionHookPredictsDialog` — flipping copilot to `true` re-creates
 *   #1901: every copilot tool call files a provisional dialog record and the
 *   pane reads `waiting` until it expires. Flipping claude to `false` removes
 *   the record #1725 shipped, so a real permission prompt reads `running`.
 * - `sessionStartMayArriveLate` — flipping copilot to `false` lets the late
 *   `SessionStart` (20.915Z, after `UserPromptSubmit` at 20.813Z; 12-15 s on a
 *   first turn) overwrite the displayed event and the verdict read from it,
 *   which is #1903. Read by `recordAgentEvent`; flipping it also reddens
 *   `tests/unit/session/late-session-start-1903.test.ts`.
 * - `permissionReplyReleasesPrompt` — flipping opencode to `false` leaves an
 *   answered permission `waiting` until expiry (#1898). Flipping any push source
 *   to `true` releases a dialog nothing observed being answered.
 * - `eventIdentity` — flipping opencode to `null` puts it back on the 3s time
 *   window that loses the `stop` of a short turn (#1899).
 * - `resync` — flipping opencode to `'none'` leaves a reconnect with no way to
 *   ask whether the conversation is still working (#1900).
 * - `transcriptHistory` (Issue #2197) — the one column that is read by
 *   something other than the state machine: `lib/polling/structured-history-gate`
 *   branches on it, so this is the column with a second detector. Flipping codex
 *   or claude to `null` puts that tool's replies back on the scraped pane, and
 *   flipping any of the other four to `'pull'` sends the gate looking for a
 *   reader that does not exist. Both are reddened by
 *   `tests/unit/polling/structured-history-gate-2197.test.ts` as well as here.
 *
 * @vitest-environment node
 */

import { describe, expect, it } from 'vitest';
import { readdirSync, existsSync } from 'fs';
import { join } from 'path';
import { claudeAgentEventSource } from '@/lib/hooks/sources/claude/source';
import { codexAgentEventSource } from '@/lib/hooks/sources/codex/source';
import { geminiAgentEventSource } from '@/lib/hooks/sources/gemini/source';
import { copilotAgentEventSource } from '@/lib/hooks/sources/copilot/source';
import { opencodeAgentEventSource } from '@/lib/hooks/sources/opencode/source';
import { antigravityAgentEventSource } from '@/lib/hooks/sources/antigravity/source';
import { commandCodeAgentEventSource } from '@/lib/hooks/sources/command-code/source';
import type { AgentEventSource, AgentSourceCapabilities } from '@/lib/hooks/sources/types';

/**
 * The five columns Issue #1924 adds, plus the one Issue #2197 does. Order is the
 * order of §4 D3's code block, with the new column last.
 */
const DECLARED_KEYS = [
  'permissionHookPredictsDialog',
  'sessionStartMayArriveLate',
  'permissionReplyReleasesPrompt',
  'eventIdentity',
  'resync',
  'transcriptHistory',
] as const;

type DeclaredRow = Pick<AgentSourceCapabilities, (typeof DECLARED_KEYS)[number]>;

/**
 * Every key on the interface, new and pre-existing.
 *
 * Pinned so that a seventh capability cannot be added without a decision about
 * what all six sources declare for it — which is the failure mode the table
 * exists to prevent, and the one a per-source `toStrictEqual` over five keys
 * would not see.
 */
const ALL_CAPABILITY_KEYS = [
  'configScope',
  'decisionTimeoutSeconds',
  'eventIdentity',
  'permissionHookPredictsDialog',
  'permissionReplyReleasesPrompt',
  'resync',
  'sessionStartMayArriveLate',
  'supportedEvents',
  'transcriptHistory',
];

/**
 * §4 D3 of the design policy, transcribed.
 *
 * The two rows that are not "Claude, as measured in #1720-#1725" are copilot and
 * opencode, and both come from the live probes the Epic ran: opencode 1.18.20
 * (#1758 / #1898 / #1899 / #1900) and copilot 1.0.80 (#1757 / #1901 / #1903).
 * Every cell marked "not audited" in the design table — codex / gemini /
 * antigravity `sessionStartMayArriveLate`, copilot `eventIdentity` — is set to
 * the Claude value on purpose, so an unmeasured source behaves the way the state
 * machine behaves today rather than a way nobody has seen.
 */
const TABLE: Record<string, DeclaredRow> = {
  claude: {
    permissionHookPredictsDialog: true,
    sessionStartMayArriveLate: false,
    permissionReplyReleasesPrompt: false,
    eventIdentity: null,
    resync: 'none',
    transcriptHistory: 'pull',
  },
  codex: {
    permissionHookPredictsDialog: true,
    sessionStartMayArriveLate: false,
    permissionReplyReleasesPrompt: false,
    eventIdentity: null,
    resync: 'none',
    transcriptHistory: 'pull',
  },
  gemini: {
    permissionHookPredictsDialog: false,
    sessionStartMayArriveLate: false,
    permissionReplyReleasesPrompt: false,
    eventIdentity: null,
    resync: 'none',
    transcriptHistory: null,
  },
  copilot: {
    permissionHookPredictsDialog: false,
    sessionStartMayArriveLate: true,
    permissionReplyReleasesPrompt: false,
    eventIdentity: null,
    resync: 'none',
    transcriptHistory: null,
  },
  opencode: {
    permissionHookPredictsDialog: false,
    sessionStartMayArriveLate: false,
    permissionReplyReleasesPrompt: true,
    eventIdentity: 'permission-id',
    resync: 'session-status-poll',
    transcriptHistory: 'push',
  },
  antigravity: {
    permissionHookPredictsDialog: false,
    sessionStartMayArriveLate: false,
    permissionReplyReleasesPrompt: false,
    eventIdentity: null,
    resync: 'none',
    transcriptHistory: 'pull',
  },
  // Issue #2251 (Epic #2249 Phase B). The seventh row, and it is gemini's rather
  // than claude's on the column that usually splits Claude-shaped tools:
  // Command Code registers no permission hook, because its `PreToolUse` fires
  // AFTER the approval dialog has been answered (measured — dialog 00:11:37,
  // answered 00:11:46, hook 00:11:46), so a non-allow reply on it forecasts
  // nothing. `transcriptHistory` became 'pull' in Phase C (#2252), which landed
  // the reader for `~/.commandcode/projects/<slug>/<session_id>.jsonl`; flipping
  // it back to null puts this tool's replies on the scraped pane, which is the
  // duplicated-then-lost shape #2121 measured on claude.
  'command-code': {
    permissionHookPredictsDialog: false,
    sessionStartMayArriveLate: false,
    permissionReplyReleasesPrompt: false,
    eventIdentity: null,
    resync: 'none',
    transcriptHistory: 'pull',
  },
};

const SOURCES: Record<string, AgentEventSource> = {
  claude: claudeAgentEventSource,
  codex: codexAgentEventSource,
  gemini: geminiAgentEventSource,
  copilot: copilotAgentEventSource,
  opencode: opencodeAgentEventSource,
  antigravity: antigravityAgentEventSource,
  'command-code': commandCodeAgentEventSource,
};

function declaredRow(capabilities: AgentSourceCapabilities): DeclaredRow {
  return {
    permissionHookPredictsDialog: capabilities.permissionHookPredictsDialog,
    sessionStartMayArriveLate: capabilities.sessionStartMayArriveLate,
    permissionReplyReleasesPrompt: capabilities.permissionReplyReleasesPrompt,
    eventIdentity: capabilities.eventIdentity,
    resync: capabilities.resync,
    transcriptHistory: capabilities.transcriptHistory,
  };
}

describe('[#1924] AgentSourceCapabilities — the table of §4 D3', () => {
  it.each(Object.keys(TABLE))('%s declares exactly the row the design policy states', (id) => {
    const source = SOURCES[id];
    expect(source.cliToolId).toBe(id);
    expect(declaredRow(source.capabilities)).toStrictEqual(TABLE[id]);
  });

  it('covers every source in the tree, so a seventh cannot land without a row', () => {
    // Read off the filesystem rather than the registry: the registry lives on
    // globalThis and other suites in this directory deliberately unregister
    // sources, so a check against it would be a check against whatever ran
    // first. A directory with a `source.ts` in it is a source, full stop.
    const dir = join(process.cwd(), 'src/lib/hooks/sources');
    const implemented = readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((name) => existsSync(join(dir, name, 'source.ts')))
      .sort();

    expect(implemented).toEqual(Object.keys(TABLE).sort());
  });

  it('declares every capability key on every source', () => {
    // Five columns pinned per row is not the same as "the interface has five new
    // columns". This is the second half.
    for (const [id, source] of Object.entries(SOURCES)) {
      expect(Object.keys(source.capabilities).sort(), id).toEqual(ALL_CAPABILITY_KEYS);
    }
  });

  it('holds declared values only — nothing here is a function (DR1-005)', () => {
    // §4 D3 decision 1: "すべて JSON 直列化可能な宣言値とする。関数は置かない."
    // The whole block is copied onto the wire in `structuredEvents.source`, so a
    // capability that were a callback would vanish silently on the way out.
    for (const [id, source] of Object.entries(SOURCES)) {
      const roundTripped = JSON.parse(JSON.stringify(source.capabilities));
      expect(roundTripped, id).toEqual({
        ...source.capabilities,
        supportedEvents: [...source.capabilities.supportedEvents],
      });
    }
  });

  it('gives exactly one source a late session_start, and it is copilot', () => {
    // The column-wise reading of the table. Written out because each of these
    // four columns has exactly one departure from the Claude row, and naming the
    // departure is how a reviewer checks the transcription without diffing
    // twenty-four booleans.
    const lateStart = Object.keys(TABLE).filter((id) => TABLE[id].sessionStartMayArriveLate);
    expect(lateStart).toEqual(['copilot']);

    const forecasts = Object.keys(TABLE).filter((id) => TABLE[id].permissionHookPredictsDialog);
    expect(forecasts).toEqual(['claude', 'codex']);

    const releases = Object.keys(TABLE).filter((id) => TABLE[id].permissionReplyReleasesPrompt);
    expect(releases).toEqual(['opencode']);

    const identified = Object.keys(TABLE).filter((id) => TABLE[id].eventIdentity !== null);
    expect(identified).toEqual(['opencode']);

    const resyncing = Object.keys(TABLE).filter((id) => TABLE[id].resync !== 'none');
    expect(resyncing).toEqual(['opencode']);
  });

  it('names exactly the five sources with a second writer, and which kind (#2252)', () => {
    // The column-wise reading of Issue #2197's addition, with #2198's fourth
    // source and #2252's fifth in it. Two departures from "nobody but the
    // scraper", and they are different departures: opencode is pushed the reply
    // over a connection, while claude, codex, antigravity and command-code each
    // keep a file that has to be read.
    // `lib/polling/structured-history-gate` asks a different question of each,
    // so a value in the wrong one of these two lists is not a near miss — it
    // sends the gate down the other branch entirely.
    const pull = Object.keys(TABLE).filter((id) => TABLE[id].transcriptHistory === 'pull');
    expect(pull).toEqual(['claude', 'codex', 'antigravity', 'command-code']);

    const push = Object.keys(TABLE).filter((id) => TABLE[id].transcriptHistory === 'push');
    expect(push).toEqual(['opencode']);

    const scraperOnly = Object.keys(TABLE).filter((id) => TABLE[id].transcriptHistory === null);
    expect(scraperOnly).toEqual(['gemini', 'copilot']);
  });
});
