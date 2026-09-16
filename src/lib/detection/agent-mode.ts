/**
 * Reading a CLI's current permission mode off the pane (Issue #2592).
 *
 * The send half of mode switching has been complete since #473 / #2032 —
 * `BTab` is in every tool's `navigationKeys()` and in the tmux transport's
 * allow-list, and `POST /api/worktrees/[id]/special-keys` answers 200 for it.
 * What was missing is this: a way to know which mode the agent is in NOW. Without
 * it a mode button is a blind press, and four of the five tools that have modes
 * draw nothing at all in their base mode, so "press it and look" does not even
 * work from the chat surface (which hides the terminal footer).
 *
 * ## A pure function of a frame somebody else already captured
 *
 * Nothing here issues a `capture-pane`, exactly as `extractModelInfo` (#1784)
 * and `extractComposerText` (#1879) issue none. The frame is the one
 * `buildCurrentOutput` already fetched for the status poll and already publishes
 * as `fullOutput`, so the added load is a regex sweep over a few rows.
 *
 * That is also why this module is leaf-clean — `stripAnsi` and a declaration,
 * no logger, no db, no `child_process`. Both sides need it:
 *
 *  - the **server**, so `GET /current-output` publishes `agentMode` for
 *    `commandmate capture --json` and for the poll;
 *  - the **browser**, so a pane whose frames arrive by `terminal_snapshot` push
 *    resolves the mode from the frame the push carries instead of waiting up to
 *    a whole fallback-poll interval for the HTTP path to catch up.
 *
 * The second half is #1879's arrangement for `composerText`, chosen for #2240's
 * reason: a field only ONE delivery path carries is blank on the pane whose
 * first frame arrives by the other one. Deriving from the frame — which both
 * paths carry, unconditionally — is what makes push and poll agree by
 * construction rather than by two emitters remembering to publish the same
 * value.
 *
 * ## `unknown` is a verdict, not a gap
 *
 * See {@link AGENT_MODE_UNKNOWN}. The reader never infers a base mode from the
 * absence of a row.
 */

import {
  AGENT_MODE_UNKNOWN,
  isAgentModeId,
  type AgentMode,
  type AgentModeId,
  type AgentModeSpec,
} from '@/types/cli-tool-contracts';
import { resolveAgentModeSpec, AGENT_MODE_TOOL_IDS } from '@/lib/cli-tools/agent-mode-spec';
import type { CLIToolType } from '@/lib/cli-tools/types';
import { stripAnsi } from './ansi';

export { AGENT_MODE_TOOL_IDS };

/**
 * The last `count` non-blank rows of a frame, oldest first, ANSI stripped.
 *
 * Blank rows are **skipped, not counted**, and that is the whole subtlety here.
 * A 1000-row capture of a fresh Command Code session is 16 rows of content and
 * 984 rows of padding, because Command Code renders inline and tmux pads the
 * capture to the requested depth; codex is the same shape. A window counted in
 * raw rows would spend its entire budget on blank lines and reach no footer at
 * all — which is exactly what an earlier draft of this function did, and what
 * `tests/unit/lib/detection/agent-mode-2592.test.ts` now pins against.
 *
 * The walk is deliberately unbounded in reach and bounded in *result*: it stops
 * the moment `count` content rows exist. The cost is one `trim()` per row of a
 * string the caller is already holding in memory, and the alternative — a row
 * ceiling — is the bug above.
 */
function tailContentRows(rawCapture: string, count: number): string[] {
  const lines = rawCapture.split('\n');
  const rows: string[] = [];
  for (let i = lines.length - 1; i >= 0 && rows.length < count; i--) {
    const row = stripAnsi(lines[i] ?? '');
    if (row.trim() === '') continue;
    rows.push(row);
  }
  return rows.reverse();
}

/**
 * Which mode this frame says the tool is in.
 *
 * Indicators are tried in declaration order — most specific first — and the
 * first one that matches any row of the window wins. See
 * {@link AgentModeSpec.indicators} for why the order is part of the declaration
 * rather than an implementation detail here.
 *
 * @param spec - The tool's declaration, from `ICLITool.agentModeSpec()`
 * @param rawCapture - A pane capture, ANSI intact or stripped (both work)
 * @returns The mode, or {@link AGENT_MODE_UNKNOWN} when no indicator matched
 */
export function readAgentModeFromSpec(spec: AgentModeSpec, rawCapture: string): AgentMode {
  if (rawCapture === '') return AGENT_MODE_UNKNOWN;
  const rows = tailContentRows(rawCapture, spec.tailRows);
  if (rows.length === 0) return AGENT_MODE_UNKNOWN;
  for (const indicator of spec.indicators) {
    if (rows.some((row) => indicator.pattern.test(row))) return indicator.mode;
  }
  return AGENT_MODE_UNKNOWN;
}

/**
 * Which mode one tool's pane is in, resolved through that tool's declaration.
 *
 * The entry point both the route and the browser use. A tool with no mode cycle
 * (opencode / vibe-local / gemini) answers {@link AGENT_MODE_UNKNOWN} without
 * touching the frame, so a caller never has to ask "does this tool have modes?"
 * before asking "which mode is it in?".
 *
 * @param cliToolId - The CLI whose session was captured
 * @param rawCapture - The frame, or `''`/`undefined` when there is none
 * @returns The mode, or {@link AGENT_MODE_UNKNOWN}
 */
export function detectAgentMode(
  cliToolId: CLIToolType,
  rawCapture: string | undefined | null,
): AgentMode {
  const spec = resolveAgentModeSpec(cliToolId);
  if (spec === null) return AGENT_MODE_UNKNOWN;
  return readAgentModeFromSpec(spec, rawCapture ?? '');
}

/**
 * Whether a mode verdict is worth showing to a human.
 *
 * One predicate, so the chip's gate is written once instead of as
 * `mode !== 'unknown'` at every surface — and so the "read nothing, show
 * nothing" rule (#2592 §「設計に効く事実」2) is a named thing a test can pin.
 *
 * Takes a `string`, not an {@link AgentMode}, because one of its callers reads
 * the value off the wire: `/current-output` is JSON and is not typechecked on
 * arrival, and a daemon older than this Issue publishes no field at all. An id
 * this build does not know — a newer server's mode — is therefore `false` here
 * rather than a chip with a raw token in it.
 */
export function isReadableAgentMode(mode: string | undefined | null): mode is AgentModeId {
  return typeof mode === 'string' && isAgentModeId(mode);
}
