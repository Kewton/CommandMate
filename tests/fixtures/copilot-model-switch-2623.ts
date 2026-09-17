/**
 * GitHub Copilot CLI 1.0.85 frames around `/model <id>` (Issue #2623).
 *
 * Recorded on 2026-09-17 by driving `copilot` 1.0.85 on a private tmux socket
 * (`tmux -L …`, production geometry 200 x 1000) and capturing
 * `capture-pane -p -e -S -50 -E -` about every 50 ms, in a fresh directory whose
 * folder-trust dialog was answered with `1` (session only). Keys were sent with
 * raw `tmux send-keys` in the shapes `CopilotTool` sends them (`/model <id>`
 * with its Enter in one command; a body, then Enter 0.1 s later), except in
 * `BUSY_SWITCH_AFTER_TURN`, where `CopilotTool` itself drove the pane.
 *
 * Every row is the capture's own, generated rather than retyped, and each
 * builder returns the capture byte for byte except for two edits:
 *
 *  - ANSI escapes are stripped with the same alternatives as
 *    `src/lib/detection/ansi.ts` (every consumer strips them before matching,
 *    and raw ESC bytes would trip `scripts/check-control-chars.mjs`). The OSC 8
 *    link under the refusal lists therefore reads `└ Open in browser`.
 *  - The probe directory is replaced with a neutral path, padded to the same
 *    width so the right-aligned `Session:` counter keeps its column.
 *
 * What the frames establish (see `COPILOT_LOADING_ROW_PATTERN` and
 * `CopilotTool.sendModelCommand`):
 *
 *  - the composer is drawn while the row below it still reads ` ● Loading: …`;
 *  - a `/model` sent then is held until loading ends, and a body sent behind it
 *    stays in the composer;
 *  - an idle switch answers with one of four rows, and a switch made during a
 *    turn answers with none;
 *  - `MCP Servers reloaded` belongs to the launch, not to `/model`.
 */

type Row = readonly [number, string];

/**
 * A capture, written as the rows that differ from an earlier one.
 *
 * Every copilot pane shares its banner, rules and chrome, and several of these
 * are one pane a moment apart, so each frame names the earlier capture it
 * differs least from and lists only the rows that differ (`''` blanks a row).
 * Where the two are the same pane the diff is the event: `SWITCH_LABEL_FIRST`
 * against `SWITCH_BEFORE` is the new label, and `SWITCH_AFTER` against
 * `SWITCH_LABEL_FIRST` is the row `/model` printed. A frame with no `base`
 * lists every non-empty row.
 */
interface CapturedFrame {
  readonly base?: CapturedFrame;
  /** `split('\n').length` of the capture, trailing empty element included. */
  readonly lineCount: number;
  readonly rows: readonly Row[];
}

function build(frame: CapturedFrame): string {
  const lines = frame.base ? build(frame.base).split('\n') : [];
  lines.length = frame.lineCount;
  for (let i = 0; i < lines.length; i++) lines[i] ??= '';
  for (const [index, text] of frame.rows) lines[index] = text;
  return lines.join('\n');
}

/** Fresh launch, 0.9 s after the composer appeared: the row under it is still the start-up row. */
const BOOT_LOADING: CapturedFrame = {
  lineCount: 1002,
  rows: [
    [1, " [Current]  Sessions   Issues   Pull requests   Gists"],
    [3, "╭────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────╮"],
    [4, "│                                                                                                                                                                                                    │"],
    [5, "│  ╭─╮╭─╮                            │  Getting started                                                                                                                                              │"],
    [6, "│  ╰─╯╰─╯  Copilot v1.0.85 uses AI.  │  Use the tabs above to explore your sessions and pull requests                                                                                                │"],
    [7, "│  █    █  Check for mistakes.       │  /init — Initialize Copilot instructions for this repository                                                                                                  │"],
    [8, "│   ▔▔▔▔                             │  /model — Switch models across providers, or use Auto                                                                                                         │"],
    [9, "│                                                                                                                                                                                                    │"],
    [10, "╰────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────╯"],
    [12, " ● Tip: /mcp"],
    [13, "   └ Manage MCP server configuration"],
    [996, " /Users/dev/work/copilot-probe-2623                                                                                                                                                 Session: 0 AIC used"],
    [997, "────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────"],
    [998, "❯"],
    [999, "────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────"],
    [1000, " ● Loading: 6 hooks, 16 skills                                                                                                                                               GPT-5.6 Terra · Extra High"],
  ],
};

/** The same launch 3.2 s after the composer appeared: loading has ended and the status bar is up. No `/model` was sent. */
const BOOT_IDLE: CapturedFrame = {
  base: BOOT_LOADING,
  lineCount: 1002,
  rows: [
    [7, "│  █ ▘▝ █  Check for mistakes.       │  /init — Initialize Copilot instructions for this repository                                                                                                  │"],
    [1000, " ← open sidebar · / commands · ? help · tab next tab                                                                                                                         GPT-5.6 Terra · Extra High"],
  ],
};

/** The same launch 1.9 s later: `MCP Servers reloaded` is printed with no `/model` involved. */
const BOOT_IDLE_MCP_RELOADED: CapturedFrame = {
  base: BOOT_IDLE,
  lineCount: 1002,
  rows: [
    [15, " ● MCP Servers reloaded: 1 server connected"],
    [1000, " ← open sidebar · / commands · ? help · tab next tab                                                                                                                                      GPT-5.6 Terra"],
  ],
};

/** `/model claude-sonnet-5` sent as soon as the composer appeared: its row lands 3.2 s later, still loading. */
const BOOT_SWITCH_HELD_WHILE_LOADING: CapturedFrame = {
  base: BOOT_IDLE,
  lineCount: 1002,
  rows: [
    [12, " ● Tip: /skills"],
    [13, "   └ Manage skills for enhanced capabilities"],
    [15, " ● Model changed from gpt-5.6-terra (xhigh) to claude-sonnet-5 (medium) for this session"],
    [1000, " ◉ Loading: 6 hooks, 16 skills, 1 MCP server                                                                                                                                   Claude Sonnet 5 · Medium"],
  ],
};

/** The same launch 1 s later: loading has ended, so the row and the idle status bar are up together. */
const BOOT_SWITCHED_IDLE: CapturedFrame = {
  base: BOOT_SWITCH_HELD_WHILE_LOADING,
  lineCount: 1002,
  rows: [
    [1000, " ← open sidebar · / commands · ? help · tab next tab                                                                                                                           Claude Sonnet 5 · Medium"],
  ],
};

/** `/model claude-sonnet-5`, then the body 0.33 s later (the old `send --model`): 16 s on, the body is still in the composer. */
const BOOT_BODY_STUCK_BEHIND_SWITCH: CapturedFrame = {
  lineCount: 1001,
  rows: [
    [0, " [Current]  Sessions   Issues   Pull requests   Gists"],
    [2, "╭────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────╮"],
    [3, "│                                                                                                                                                                                                    │"],
    [4, "│  ╭─╮╭─╮                            │  Getting started                                                                                                                                              │"],
    [5, "│  ╰─╯╰─╯  Copilot v1.0.85 uses AI.  │  Use the tabs above to explore your sessions and pull requests                                                                                                │"],
    [6, "│  █ ▘▝ █  Check for mistakes.       │  /init — Initialize Copilot instructions for this repository                                                                                                  │"],
    [7, "│   ▔▔▔▔                             │  /model — Switch models across providers, or use Auto                                                                                                         │"],
    [8, "│                                                                                                                                                                                                    │"],
    [9, "╰────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────╯"],
    [11, " ● Tip: /skills"],
    [12, "   └ Manage skills for enhanced capabilities"],
    [14, " ● Model changed from gpt-5.6-terra (xhigh) to claude-sonnet-5 (medium) for this session"],
    [16, " ● MCP Servers reloaded: 1 server connected"],
    [995, " /Users/dev/work/copilot-probe-2623                                                                                                                                                 Session: 0 AIC used"],
    [996, "────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────"],
    [997, "❯ Reply with exactly the word PONG and nothing else."],
    [998, "────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────"],
    [999, " @ files · # issues                                                                                                                                                                     Claude Sonnet 5"],
  ],
};

/** A body typed with raw keys the moment the composer appeared and submitted 0.1 s later (no `/model`), still in the composer 18 s on: the status bar reads `@ files · # issues`, not the idle hints. */
const IDLE_COMPOSER_HOLDS_TEXT: CapturedFrame = {
  base: BOOT_BODY_STUCK_BEHIND_SWITCH,
  lineCount: 1001,
  rows: [
    [11, " ● Tip: /autopilot"],
    [12, "   └ Toggle autopilot mode, or set an autopilot objective with an optional AI-credit limit (--max-ai-credits)"],
    [14, " ● MCP Servers reloaded: 1 server connected"],
    [16, ""],
    [999, " @ files · # issues                                                                                                                                                                       GPT-5.6 Terra"],
  ],
};

/** A settled session on claude-sonnet-5, 14 ms after `/model gpt-5.6-terra` + Enter: nothing of the command is drawn yet. */
const SWITCH_BEFORE: CapturedFrame = {
  base: BOOT_SWITCH_HELD_WHILE_LOADING,
  lineCount: 1002,
  rows: [
    [17, " ● MCP Servers reloaded: 1 server connected"],
    [1000, " ← open sidebar · / commands · ? help · tab next tab                                                                                                                                    Claude Sonnet 5"],
  ],
};

/** The same pane 0.3 s later: the label already reads GPT-5.6 Terra, and there is no new row yet. */
const SWITCH_LABEL_FIRST: CapturedFrame = {
  base: SWITCH_BEFORE,
  lineCount: 1002,
  rows: [
    [1000, " ← open sidebar · / commands · ? help · tab next tab                                                                                                                                      GPT-5.6 Terra"],
  ],
};

/** The same pane 1.2 s after the keystroke: the `Model changed` row has arrived. */
const SWITCH_AFTER: CapturedFrame = {
  base: SWITCH_LABEL_FIRST,
  lineCount: 1002,
  rows: [
    [19, " ● Model changed from claude-sonnet-5 (medium) to gpt-5.6-terra (medium) for this session"],
  ],
};

/** The same session, 12 ms after `/model gpt-5.6-terra` + Enter again: unchanged from `SWITCH_AFTER`. */
const SAME_MODEL_BEFORE: CapturedFrame = {
  base: SWITCH_AFTER,
  lineCount: 1002,
  rows: [],
};

/** `Switched model to:` — the answer for the model already in effect. */
const SAME_MODEL_AFTER: CapturedFrame = {
  base: SWITCH_AFTER,
  lineCount: 1002,
  rows: [
    [21, " ● Switched model to: gpt-5.6-terra"],
  ],
};

/** The same session, 14 ms after `/model claude-opus-4.6` + Enter: unchanged from `SAME_MODEL_AFTER`. */
const UNSUPPORTED_BEFORE: CapturedFrame = {
  base: SAME_MODEL_AFTER,
  lineCount: 1002,
  rows: [],
};

/** `✗ Model "claude-opus-4.6" is unsupported.` and the lists of ids; nothing changed. */
const UNSUPPORTED_AFTER: CapturedFrame = {
  base: SAME_MODEL_AFTER,
  lineCount: 1002,
  rows: [
    [23, " ✗ Model \"claude-opus-4.6\" is unsupported."],
    [25, "   Available models:"],
    [27, "    - \"claude-sonnet-5\""],
    [28, "    - \"claude-haiku-4.5\""],
    [29, "    - \"gpt-5.6-terra\""],
    [30, "    - \"gpt-5.6-luna\""],
    [31, "    - \"gpt-5.4\""],
    [32, "    - \"gpt-5.4-mini\""],
    [33, "    - \"gpt-5.3-codex\""],
    [34, "    - \"gpt-5-mini\""],
    [35, "    - \"mai-code-1.1-flash\""],
    [36, "    - \"gemini-3.8-flash\""],
    [37, "    - \"gemini-3.7-flash\""],
    [38, "    - \"gemini-3.6-flash\""],
    [39, "    - \"gemini-3.5-flash\""],
    [40, "    - \"grok-4.5\""],
    [41, "    - \"kimi-k3\""],
    [42, "    - \"kimi-k2.7-code\""],
    [43, "    - \"grok-4.6\""],
    [45, "   Supported models:"],
    [47, "    - \"claude-fable-5.1\""],
    [48, "    - \"claude-fable-5\""],
    [49, "    - \"claude-opus-5\""],
    [50, "    - \"claude-opus-4.8\""],
    [51, "    - \"claude-opus-4.8-fast\""],
    [52, "    - \"claude-opus-4.7\""],
    [53, "    - \"claude-sonnet-4.6\""],
    [54, "    - \"gpt-6-astra\""],
    [55, "    - \"gpt-5.6-sol\""],
    [56, "    - \"gpt-5.5\""],
    [58, "   For information on Copilot policies and subscription, use the link below. "],
    [59, "   └ Open in browser"],
  ],
};

/** The same session, 13 ms after `/model claude-opus-5` + Enter: unchanged from `UNSUPPORTED_AFTER`. */
const UNAVAILABLE_BEFORE: CapturedFrame = {
  base: UNSUPPORTED_AFTER,
  lineCount: 1002,
  rows: [],
};

/** `✗ Model "claude-opus-5" is unavailable.` — an id from the "Supported" list the plan does not include. */
const UNAVAILABLE_AFTER: CapturedFrame = {
  base: UNSUPPORTED_AFTER,
  lineCount: 1002,
  rows: [
    [61, " ✗ Model \"claude-opus-5\" is unavailable."],
    [63, "   Available models:"],
    [65, "    - \"claude-sonnet-5\""],
    [66, "    - \"claude-haiku-4.5\""],
    [67, "    - \"gpt-5.6-terra\""],
    [68, "    - \"gpt-5.6-luna\""],
    [69, "    - \"gpt-5.4\""],
    [70, "    - \"gpt-5.4-mini\""],
    [71, "    - \"gpt-5.3-codex\""],
    [72, "    - \"gpt-5-mini\""],
    [73, "    - \"mai-code-1.1-flash\""],
    [74, "    - \"gemini-3.8-flash\""],
    [75, "    - \"gemini-3.7-flash\""],
    [76, "    - \"gemini-3.6-flash\""],
    [77, "    - \"gemini-3.5-flash\""],
    [78, "    - \"grok-4.5\""],
    [79, "    - \"kimi-k3\""],
    [80, "    - \"kimi-k2.7-code\""],
    [81, "    - \"grok-4.6\""],
    [83, "   Supported models:"],
    [85, "    - \"claude-fable-5.1\""],
    [86, "    - \"claude-fable-5\""],
    [87, "    - \"claude-opus-5\""],
    [88, "    - \"claude-opus-4.8\""],
    [89, "    - \"claude-opus-4.8-fast\""],
    [90, "    - \"claude-opus-4.7\""],
    [91, "    - \"claude-sonnet-4.6\""],
    [92, "    - \"gpt-6-astra\""],
    [93, "    - \"gpt-5.6-sol\""],
    [94, "    - \"gpt-5.5\""],
    [96, "   For information on Copilot policies and subscription, use the link below. "],
    [97, "   └ Open in browser"],
  ],
};

/** `/model claude-haiku-4.5` sent 1.6 s into a turn: 10.6 s later the label has changed, and no row was printed. */
const WORKING_SWITCHED_SILENTLY: CapturedFrame = {
  base: UNAVAILABLE_AFTER,
  lineCount: 1002,
  rows: [
    [99, " ❯ Reply with exactly the word PONG and nothing else.                                                                                                                                            18:05"],
    [101, " ● PONG"],
    [996, " /Users/dev/work/copilot-probe-2623                                                                                                                                              Session: 3.66 AIC used"],
    [1000, " ○ Working · 4 B esc interrupt                                                                                                                                                         Claude Haiku 4.5"],
  ],
};

/** The same pane when the turn ended: idle, on Claude Haiku 4.5, still no row for the switch. */
const WORKING_SWITCH_TURN_ENDED: CapturedFrame = {
  base: WORKING_SWITCHED_SILENTLY,
  lineCount: 1002,
  rows: [
    [1000, " ← open sidebar · / commands · ? help · tab next tab                                                                                                                                   Claude Haiku 4.5"],
  ],
};

/** Through `sendModelCommand` as fixed: it waited out the turn, then the switch printed its row (no effort suffix for this model). */
const BUSY_SWITCH_AFTER_TURN: CapturedFrame = {
  base: SWITCH_BEFORE,
  lineCount: 1002,
  rows: [
    [12, " ● Tip: /context"],
    [13, "   └ Show context window token usage and visualization"],
    [15, " ❯ Reply with exactly the word PONG and nothing else.                                                                                                                                            18:18"],
    [19, " ● PONG"],
    [21, " ❯ Reply with exactly the word PONG and nothing else.                                                                                                                                            18:20"],
    [23, " ● PONG"],
    [25, " ● Model changed from gpt-5.6-terra (xhigh) to claude-haiku-4.5 for this session"],
    [996, " /Users/dev/work/copilot-probe-2623                                                                                                                                              Session: 3.97 AIC used"],
    [1000, " ← open sidebar · / commands · ? help · tab next tab                                                                                                                                   Claude Haiku 4.5"],
  ],
};

/** Every frame, keyed by name; each call returns a fresh string. */
export const COPILOT_MODEL_SWITCH_2623_FRAMES = {
  BOOT_LOADING: () => build(BOOT_LOADING),
  BOOT_IDLE: () => build(BOOT_IDLE),
  BOOT_IDLE_MCP_RELOADED: () => build(BOOT_IDLE_MCP_RELOADED),
  BOOT_SWITCH_HELD_WHILE_LOADING: () => build(BOOT_SWITCH_HELD_WHILE_LOADING),
  BOOT_SWITCHED_IDLE: () => build(BOOT_SWITCHED_IDLE),
  BOOT_BODY_STUCK_BEHIND_SWITCH: () => build(BOOT_BODY_STUCK_BEHIND_SWITCH),
  IDLE_COMPOSER_HOLDS_TEXT: () => build(IDLE_COMPOSER_HOLDS_TEXT),
  SWITCH_BEFORE: () => build(SWITCH_BEFORE),
  SWITCH_LABEL_FIRST: () => build(SWITCH_LABEL_FIRST),
  SWITCH_AFTER: () => build(SWITCH_AFTER),
  SAME_MODEL_BEFORE: () => build(SAME_MODEL_BEFORE),
  SAME_MODEL_AFTER: () => build(SAME_MODEL_AFTER),
  UNSUPPORTED_BEFORE: () => build(UNSUPPORTED_BEFORE),
  UNSUPPORTED_AFTER: () => build(UNSUPPORTED_AFTER),
  UNAVAILABLE_BEFORE: () => build(UNAVAILABLE_BEFORE),
  UNAVAILABLE_AFTER: () => build(UNAVAILABLE_AFTER),
  WORKING_SWITCHED_SILENTLY: () => build(WORKING_SWITCHED_SILENTLY),
  WORKING_SWITCH_TURN_ENDED: () => build(WORKING_SWITCH_TURN_ENDED),
  BUSY_SWITCH_AFTER_TURN: () => build(BUSY_SWITCH_AFTER_TURN),
} as const;

export type CopilotModelSwitch2623FrameName = keyof typeof COPILOT_MODEL_SWITCH_2623_FRAMES;
