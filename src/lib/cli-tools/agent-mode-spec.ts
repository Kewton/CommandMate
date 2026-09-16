/**
 * How each CLI cycles its permission mode, and how that mode is read off the
 * pane (Issue #2592).
 *
 * `BaseCLITool.agentModeSpec()` answers from this table, the way it already
 * answers `describeComposer()` from `./composer-spec`, `captureSpec()` from
 * `./capture-spec` and `livenessSpec()` from `./liveness-spec`. Nothing outside
 * `src/lib/cli-tools/**` branches on a `CLIToolType` to find a mode.
 *
 * ## What `shift+tab` is, per tool (measured 2026-09-16, Issue #2592)
 *
 * Eight tools were driven on a private tmux socket at 200x60 from a repository
 * root, pressing `BTab` until the display returned to where it started:
 *
 * | tool           | version  | what `shift+tab` does            | measured cycle                                |
 * |----------------|----------|----------------------------------|-----------------------------------------------|
 * | claude         | 2.1.273  | permission-mode cycle            | auto → manual → accept edits → plan → auto    |
 * | command-code   | 1.53.1   | permission-mode cycle            | default → accept edits → plan → default       |
 * | codex          | 0.154.0  | two-value toggle                 | Default ⇄ Plan                                |
 * | copilot        | 1.0.83   | mode cycle                       | default → plan → autopilot → default          |
 * |                | 1.0.85   | (UAT) autopilot may read `autopilot (limited)` | same cycle                      |
 * | antigravity    | 1.2.4    | mode cycle                       | default → accept-edits → plan → default       |
 * | gemini         | 0.58.0   | `app.cycleApprovalMode` (docs)   | **NOT MEASURED** — see below                  |
 * | opencode       | 1.18.30  | agent switch, not a mode         | — (already shipped as #2046's quick keys)     |
 * | vibe-local     | —        | nothing (5 presses, no change)   | — (`-y` AUTO-APPROVE is fixed)                |
 *
 * ## The three tools this table deliberately leaves out
 *
 *  - **opencode.** `BTab` there is `agent_cycle_reverse`, and it already has a
 *    UI — `OpencodeQuickKeys`' `agentPrev` button (#2046). Giving opencode a
 *    mode spec would put a second button on the same key with a different
 *    promise. The separation is a DECLARATION (no entry here), not a tool-id
 *    check in the UI.
 *  - **vibe-local.** Five presses produced a byte-identical frame. There is no
 *    mode to cycle; the wrapper fixes `-y`.
 *  - **gemini.** Its bundled `docs/reference/keyboard-shortcuts.md` does bind
 *    `app.cycleApprovalMode`, so the binding is not in doubt — the *footer
 *    spelling* is, because sign-in failed with `This client is no longer
 *    supported for Gemini Code Assist for individuals` and the TUI was never
 *    reached. Drawing a button means promising to say what happens when it is
 *    pressed, and for gemini nothing here could. Adding it is a follow-up for
 *    whoever has an account that signs in.
 *
 * ## Why the indicators are patterns on a windowed tail and not positions
 *
 * The five declaring tools put the mode in five structurally different places —
 * a dedicated footer row (claude), an independent row above the shortcut hint
 * (Command Code 1.53.1) or *replacing* it (1.49.0), the right end of a status
 * bar (codex), a word spliced into a hint bar whose element count changes with
 * the mode (copilot), and a right-aligned footer segment plus a banner inside
 * the composer box (agy). No column index, no row offset and no "nth segment"
 * rule survives that set, so each tool declares what its row LOOKS like and the
 * reader scans a small window of non-blank tail rows for it.
 *
 * @module lib/cli-tools/agent-mode-spec
 */

import type { AgentModeSpec } from '../../types/cli-tool-contracts';
import type { CLIToolType } from './types';

/**
 * claude's permission-mode footer row.
 *
 * The four spellings are #1927's measurement table (claude-cli 2.1.240, 200x1000),
 * re-confirmed by #2592 on 2.1.273 and visible verbatim in the live captures
 * this repository already keeps — `tests/fixtures/claude-live-2247/*.txt` and
 * `tests/unit/lib/tmux/fixtures/capture-claude-*.txt` carry the `auto` and
 * `manual` rows respectively:
 *
 *   `  ⏸ manual mode on · ? for shortcuts · ← for agents            /rc · focus`
 *   `  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents          /rc · focus`
 *   `  ⏸ plan mode on (shift+tab to cycle) · ⇥ for agents`
 *   `  ⏵⏵ accept edits on (shift+tab to cycle) · ⇥ for agents`
 *
 * The leading glyph is REQUIRED in every pattern, and that is what separates a
 * footer from a permission dialog quoting the same words: `tests/fixtures/canary/
 * permission-hook-no-decision.raw.txt:33` reads
 * `2. Yes, and switch to accept edits (auto-approve …) for this session (shift+tab)`,
 * which contains "accept edits" and must never be read as a mode.
 *
 * claude has no `default`: `manual` IS its base mode and it prints a row for it,
 * which is why claude is the one declaring tool whose every cycle member is
 * readable.
 */
const CLAUDE_MODE_SPEC: AgentModeSpec = {
  key: 'BTab',
  cycle: ['auto', 'manual', 'accept-edits', 'plan'],
  indicators: [
    { mode: 'accept-edits', pattern: /⏵⏵\s*accept edits on\b/ },
    { mode: 'auto', pattern: /⏵⏵\s*auto mode on\b/ },
    { mode: 'plan', pattern: /⏸\s*plan mode on\b/ },
    { mode: 'manual', pattern: /⏸\s*manual mode on\b/ },
  ],
  // The row is the LAST content row of every measured frame (row 1000 of a
  // 200x1000 alternate-screen capture). Three rows of slack for the `/rc · focus`
  // continuation and for a build that grows a row under it; not more, because
  // claude renders in the alternate screen and a wider window reaches nothing
  // new anyway.
  tailRows: 3,
  noteId: null,
};

/**
 * Command Code's mode row.
 *
 * Two shapes, nine minor versions apart, and the reader has to answer both:
 *
 *  - **1.49.0** (`tests/fixtures/command-code-live-2250/README.md`): `ModeIndicator`
 *    REPLACES the shortcut hint, so the footer is one row that reads
 *    `? for shortcuts · taste on` in default and `» accept edits on` /
 *    `plan mode` / `» permission bypass on` / `» don't-ask on` otherwise.
 *  - **1.53.1** (#2592): the mode is its OWN row directly above the
 *    `? for shortcuts` row, spelled `» accept edits on [shift+tab]` /
 *    `plan mode [shift+tab]`.
 *
 * One consequence drives the ordering below. On 1.53.1 `? for shortcuts` is
 * drawn in EVERY mode, so an indicator that reads it as `default` is only
 * correct once every mode row has been checked first — hence `default` last.
 * `bypass` and `dont-ask` are checked even though `shift+tab` skips them
 * (#2592 measured the cycle as default → accept edits → plan), because without
 * them a 1.53.1 pane sitting in `permission bypass` would fall through to
 * `? for shortcuts` and publish `default`.
 *
 * The spellings are `cli-patterns.ts`'s `COMMAND_CODE_FOOTER_PATTERN`
 * alternatives, which is the same list read off the same bundle.
 */
const COMMAND_CODE_MODE_SPEC: AgentModeSpec = {
  key: 'BTab',
  cycle: ['default', 'accept-edits', 'plan'],
  indicators: [
    { mode: 'accept-edits', pattern: /»\s*accept edits on\b/ },
    { mode: 'bypass', pattern: /»\s*permission bypass on\b/ },
    { mode: 'dont-ask', pattern: /»\s*don't-ask on\b/ },
    { mode: 'plan', pattern: /^[^\S\n]*plan mode\b/ },
    // LAST, and the only positive reading of a base mode in this file. It is a
    // row Command Code actually draws, not the absence of one: #2592 §3's
    // "default が無表示" applies to codex / copilot / agy, not here.
    { mode: 'default', pattern: /\?\s+for\s+shortcuts\b/ },
  ],
  // Command Code renders INLINE — #2250 measured `alternate_on` 0 and a pane
  // that keeps its scrollback — so a 1000-row capture holds every footer the
  // session has ever drawn. Four rows covers 1.53.1's `mode row + rule +
  // shortcut row` stack and nothing above it.
  tailRows: 4,
  noteId: null,
};

/**
 * codex's Plan-mode badge, at the right end of the status bar.
 *
 * `Plan mode (shift+tab to cycle)`, measured on 0.154.0. **There is no default
 * indicator, on purpose.** codex prints nothing at all in Default — #2592
 * §「設計に効く事実」3 — so the only honest answer for a Default pane is
 * `unknown`, and the chip is not drawn. Reading Default off the absence of the
 * badge would publish `default` for every frame captured mid-repaint and for
 * every future build that renames the badge.
 *
 * Note the footer's LEFT segment is not consulted either, although it moves with
 * the mode: `tests/fixtures/codex-live-2310/idle-composer.txt` ends
 * `gpt-5.6-sol default · /private/tmp/…`, and that `default` is the reasoning
 * preset `CODEX_FOOTER_MODEL_PATTERN` already reads as a model/effort pair. Two
 * readers on one token is how one of them ends up publishing the other's value.
 */
const CODEX_MODE_SPEC: AgentModeSpec = {
  key: 'BTab',
  cycle: ['default', 'plan'],
  indicators: [
    { mode: 'plan', pattern: /\bPlan mode\s*\(shift\+tab to cycle\)/i },
  ],
  tailRows: 3,
  // #2592 §4: codex couples the mode to the model tier and reasoning effort
  // (xhigh ⇄ medium, measured). One press of a button labelled "mode" therefore
  // also moves the model, and the UI has to say so rather than let it be found.
  noteId: 'codexModelCoupled',
};

/**
 * One mode-naming segment of a status bar (Issue #2592).
 *
 * copilot and antigravity both put the mode into a row that is otherwise their
 * status bar, as one segment among `·`-separated others, and neither puts it in
 * a fixed place. The grammar, as measured on the live frames under
 * `tests/fixtures/agent-mode-2592/`:
 *
 *   left boundary   start of row | `·` | a column gap (two spaces)
 *   the word        `plan`, `accept-edits`, `autopilot` (+ an optional ` mode`)
 *   qualifier       optional ` (limited)` — copilot 1.0.85 prints
 *                   `autopilot (limited)` after the user answers its permission
 *                   dialog with "Continue with limited permissions"
 *   right boundary  `·` | a column gap | end of row
 *
 * The column gap on the LEFT is what agy 1.2.4 needs, and what the first cut of
 * this file did not accept: agy draws `? for shortcuts` and the right-aligned
 * `accept-edits · Gemini 3.8 Flash · hi` on the SAME row, 150 columns apart, so
 * the mode word is preceded by spaces and nothing else. The first fixture had
 * been built from the Issue's prose with the segment on a row of its own, where
 * `^` matched — and the live UAT read `unknown` on every agy step.
 *
 * The gap is exactly two spaces immediately before the word rather than "two or
 * more then any": each alternative is anchored at one position (`^`, a `·`, or
 * the last two columns of a run), so the scan stays linear in the row width
 * instead of re-walking every run of padding from every start position. A single
 * space is deliberately NOT a boundary — that is what keeps prose such as
 * `Follow the plan` from reading as a mode.
 *
 * @param word - Regex source for the mode word (no capture groups)
 */
function statusBarSegment(word: string): RegExp {
  const gap = '[^\\S\\n]';
  return new RegExp(
    `(?:^${gap}*|·${gap}*|${gap}{2})${word}` +
      `(?:${gap}\\([^()\\n]{1,32}\\))?` +
      `(?:${gap}*·|${gap}{2}|${gap}*$)`,
    'i',
  );
}

/**
 * copilot's mode word, spliced into the hint bar.
 *
 * The bar is the last content row of the pane — `readCopilotBarRow` in
 * `lib/detection/model-info-extractor.ts` relies on exactly that, and
 * `tests/fixtures/tool-liveness-2070/copilot-ready-1080.txt:1001` shows it:
 *
 *   ` … · ← open sidebar · / commands · ? help · tab next tab        GPT-5.6 Terra`
 *
 * #2592 measured `default → plan → autopilot → default` on 1.0.83, with the mode
 * word inserted as a `·`-delimited segment of that bar and `? help` DISAPPEARING
 * in autopilot — i.e. the bar's element count is itself mode-dependent, which is
 * why the patterns below are delimiter-anchored rather than positional and why
 * nothing here requires `? help` to be present.
 *
 * The UAT on 1.0.85 (`tests/fixtures/agent-mode-2592/copilot-*.txt`) placed the
 * word directly after `← open sidebar`:
 *
 *   ` ← open sidebar · plan · / commands · ? help · tab next tab     GPT-5.6 Terra`
 *   ` ← open sidebar · autopilot (limited) · / commands · tab next tab  GPT-5.6 Terra`
 *
 * The second is what copilot draws for the rest of the session once its
 * autopilot permission dialog is answered "Continue with limited permissions";
 * it is still autopilot, so {@link statusBarSegment} reads the parenthetical as a
 * qualifier rather than as a different mode. Before the UAT it was read as
 * nothing, and every autopilot step of the cycle published `unknown`.
 *
 * No default indicator: the measurement found no word for it.
 */
const COPILOT_MODE_SPEC: AgentModeSpec = {
  key: 'BTab',
  cycle: ['default', 'plan', 'autopilot'],
  indicators: [
    { mode: 'autopilot', pattern: statusBarSegment('autopilot') },
    { mode: 'plan', pattern: statusBarSegment('plan(?:[^\\S\\n]mode)?') },
  ],
  // The bar is the last content row. Two rows of slack and no more: copilot
  // renders in the alternate screen, and its transcript is measured (#1885 /
  // #1897) to repeat its own status-bar vocabulary as body text — position is
  // the only thing that separates the bar from a sentence about it.
  tailRows: 2,
  noteId: null,
};

/**
 * antigravity's mode segment, at the right end of the footer.
 *
 * agy's footer is the last content row. On 1.2.4 it is ONE row holding both the
 * shortcut hint at the left edge and the model chip at the right, with the mode
 * spliced in front of the chip (`tests/fixtures/agent-mode-2592/antigravity-*.txt`,
 * captured live in the #2592 UAT, row 20, 200 columns):
 *
 *   `? for shortcuts            …            accept-edits · Gemini 3.8 Flash · hi`
 *   `? for shortcuts            …                    plan · Gemini 3.8 Flash · hi`
 *   `? for shortcuts            …                           Gemini 3.8 Flash · hig`
 *
 * Nothing is drawn for default. The segment is preceded by a column gap and not
 * by a `·`, which is the case {@link statusBarSegment}'s left boundary had to
 * learn; see there.
 *
 * agy ALSO paints a mode banner inside its composer box
 * (`> Plan mode: research & plan only (shift+tab to cycle)`), and that is
 * deliberately not read here: one row, the footer, is enough. The banner matters
 * to STATUS detection instead — it replaces the bare `>` the idle rule looks for,
 * which is why `ANTIGRAVITY_PROMPT_PATTERN` in `lib/detection/cli-patterns.ts`
 * accepts it — and it is the region `extractComposerText` walks. (It cannot
 * collide with that today — agy is not
 * in `SUPPORTED_COMPOSER_TOOLS`, so `extractComposerText` short-circuits to
 * `unsupported_tool` and `UnsentComposerBar` can never draw for it. #2592's
 * §「設計に効く事実」5 is therefore answered by construction, and
 * `tests/unit/lib/detection/agent-mode-2592.test.ts` pins it so a future
 * widening of that set has to face the question.)
 */
const ANTIGRAVITY_MODE_SPEC: AgentModeSpec = {
  key: 'BTab',
  cycle: ['default', 'accept-edits', 'plan'],
  indicators: [
    { mode: 'accept-edits', pattern: statusBarSegment('accept-edits') },
    { mode: 'plan', pattern: statusBarSegment('plan(?:[^\\S\\n]mode)?') },
  ],
  tailRows: 2,
  noteId: null,
};

/**
 * The declarations, keyed by tool.
 *
 * A `Partial` rather than a total record on purpose: "this tool has no mode on
 * `shift+tab`" is a statement three tools make, and making it by ABSENCE keeps
 * `resolveAgentModeSpec` from needing a sentinel value that a caller could
 * mistake for a spec.
 */
const AGENT_MODE_SPECS: Readonly<Partial<Record<CLIToolType, AgentModeSpec>>> = {
  claude: CLAUDE_MODE_SPEC,
  'command-code': COMMAND_CODE_MODE_SPEC,
  codex: CODEX_MODE_SPEC,
  copilot: COPILOT_MODE_SPEC,
  antigravity: ANTIGRAVITY_MODE_SPEC,
};

/**
 * How one CLI cycles its permission mode, or `null` when it does not have one.
 *
 * @param cliToolId - CLI tool identifier
 * @returns That tool's {@link AgentModeSpec}, or `null`
 */
export function resolveAgentModeSpec(cliToolId: CLIToolType): AgentModeSpec | null {
  return AGENT_MODE_SPECS[cliToolId] ?? null;
}

/**
 * The tool ids that declare a mode cycle, for a reader that cannot call
 * `ICLITool.agentModeSpec()`.
 *
 * The browser is such a reader: `ICLITool` lives behind the CLITool gateway on
 * the server (§4 D4). This is the same arrangement — and the same hazard —
 * `SESSION_SCOPE_KEY_TOOL_IDS` has carried since #2297, so it is pinned against
 * the real registry the same way, by
 * `tests/unit/lib/cli-tools/agent-mode-declaration-2592.test.ts`.
 */
export const AGENT_MODE_TOOL_IDS: readonly CLIToolType[] = Object.keys(
  AGENT_MODE_SPECS,
) as CLIToolType[];
