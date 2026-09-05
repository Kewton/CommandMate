/**
 * The tmux "surface" CommandMate publishes on its own sessions (Issue #2317).
 *
 * Everything here is a pure argument builder or a pure predicate — no
 * `child_process`, no `@/` path alias, and one constants import. Three
 * constraints put it here rather than under `lib/tmux/`, and all three are
 * load-bearing:
 *
 * 1. **`tsconfig.cli.json` sets `"paths": {}`.** The CLI bundle resolves nothing
 *    through `@/…`, so a module the `attach` command needs may only reach the
 *    rest of `src/` through relative specifiers. `lib/tmux/tmux.ts` cannot be
 *    that module — it imports `@/lib/cli-tools/validation` and `@/lib/logger`.
 * 2. **The Issue #1922 import guard.** `.eslintrc.json` forbids `src/cli/**`
 *    from importing anything matching `**‍/tmux/**`, and its allowlist is
 *    explicitly one-way ("may only shrink"). A pure argv builder is not the kind
 *    of tmux access that guard exists to stop — it issues no command and opens
 *    no session — but the rule is a path pattern, so the module lives on a path
 *    the CLI may read. Nothing here can reach tmux: the executors are in
 *    `lib/tmux/`, and those are what the guard still covers.
 * 3. **One wire form, two callers.** The server writes `@cm_status` from the
 *    status poll and the CLI writes `@cm_delegated` from `attach --live`. If
 *    each spelled its own `set-option` argv, the two could disagree about the
 *    target form (`=name:` vs `name`), and a bare name prefix-matches — the
 *    Issue #1156 leak, in a new place. Tests assert the builders, so a change to
 *    the wire form is a change to exactly one line.
 *
 * ## What is deliberately NOT here
 *
 * Anything server-global. Every builder below takes a session name and produces
 * a `-t <session>` form: `set-option -g`, `bind-key` and `set-hook -g` are
 * absent on purpose (Issue #2317 決定事項 2 — the only global tmux mutation
 * CommandMate makes is #1623's `bind-key`, and it stays where it is, in
 * `lib/tmux/read-mode.ts`).
 */

import { TUI_PANE_HEIGHT, TUI_PANE_WIDTH } from '../../config/tmux-pane-config';

/**
 * Session-name prefix every CommandMate tmux session carries.
 *
 * `lib/tmux/read-mode.ts` owns a constant of the same name for #1623's key
 * binding; `tests/unit/tmux/session-surface-2317.test.ts` pins the two together
 * so a rename breaks a test instead of silently turning a guard into a permanent
 * "never fire". Not imported from `cli-tools/base.ts` because it is a template
 * literal there, not a constant.
 */
export const MCBD_SESSION_PREFIX = 'mcbd-';

/**
 * Exact-match tmux target for a session (Issue #1156's `=name:` form).
 *
 * The same string `exactTarget()` in `lib/tmux/tmux.ts` produces — that function
 * stays the one the server-side module uses, and the test above pins the two to
 * each other so this copy cannot drift. It exists at all because `tmux.ts` is
 * unreachable from the CLI bundle (see the module docblock).
 *
 * @param sessionName - Exact tmux session name
 * @returns `=<name>:` — exact session match, valid as both a session and a
 *   window/pane target
 */
export function exactSessionTarget(sessionName: string): string {
  return `=${sessionName}:`;
}

/** True when `sessionName` looks like a session CommandMate created. */
export function isCommandMateSession(sessionName: string): boolean {
  return sessionName.startsWith(MCBD_SESSION_PREFIX);
}

// ---------------------------------------------------------------------------
// Phase B: the state CommandMate publishes onto its own sessions
// ---------------------------------------------------------------------------

/** User option carrying the session's status word. */
export const CM_STATUS_OPTION = '@cm_status';
/** User option carrying the worktree id the session belongs to. */
export const CM_WORKTREE_OPTION = '@cm_worktree';
/** User option carrying the CLI tool id running in the session. */
export const CM_TOOL_OPTION = '@cm_tool';
/** User option carrying the agent instance id. */
export const CM_INSTANCE_OPTION = '@cm_instance';
/** User option carrying the ISO timestamp of the last status write. */
export const CM_UPDATED_OPTION = '@cm_updated';
/**
 * User option set to `1` while a human client owns the session's geometry
 * (Phase D). Read by the server so it can stand down from resizing and from
 * saving a scraped reply off a terminal-sized frame.
 */
export const CM_DELEGATED_OPTION = '@cm_delegated';

/**
 * Every `@cm_*` option this feature writes, in the order they are removed.
 *
 * The opt-out path (`CM_TMUX_STATUS=off`) iterates this list rather than
 * re-typing names, so an option added above cannot be left behind on a user's
 * tmux server.
 */
export const CM_SESSION_OPTIONS: readonly string[] = [
  CM_STATUS_OPTION,
  CM_WORKTREE_OPTION,
  CM_TOOL_OPTION,
  CM_INSTANCE_OPTION,
  CM_UPDATED_OPTION,
  CM_DELEGATED_OPTION,
];

/**
 * The session-scoped `status-right` CommandMate installs.
 *
 * A tmux FORMAT, not an interpolated string: the values come from the `@cm_*`
 * options above, so the status line re-renders on every status write without a
 * second write for the line itself. `window_width`x`window_height` is on it
 * because the whole Issue is about a window whose size the reader cannot see —
 * during Phase D delegation it is the fastest way to tell whether the geometry
 * handover actually happened.
 */
export const CM_STATUS_RIGHT_FORMAT =
  '[CommandMate #{@cm_tool}/#{@cm_instance} #{@cm_status}] #{window_width}x#{window_height}';

/** `tmux set-option -t <session> <name> <value>`. */
export function buildSetSessionOptionArgs(
  sessionName: string,
  option: string,
  value: string,
): string[] {
  return ['set-option', '-t', exactSessionTarget(sessionName), option, value];
}

/** `tmux set-option -u -t <session> <name>` — remove a session-scoped value. */
export function buildUnsetSessionOptionArgs(sessionName: string, option: string): string[] {
  return ['set-option', '-u', '-t', exactSessionTarget(sessionName), option];
}

/**
 * `tmux show-options -t <session> <name>`.
 *
 * Deliberately WITHOUT `-v`: the empty-vs-set distinction is the whole point of
 * the call at the `status-right` site. Measured on tmux 3.5a — a session that
 * has never had `status-right` set answers with empty stdout and exit 0, and one
 * that has answers `status-right "…"`. `-v` would print an empty line for the
 * first case too, and "the user already customised this session" would become
 * indistinguishable from "nobody has".
 */
export function buildShowSessionOptionArgs(sessionName: string, option: string): string[] {
  return ['show-options', '-t', exactSessionTarget(sessionName), option];
}

/**
 * `tmux show-options -v -t <session> <name>` — the VALUE alone.
 *
 * The right shape when only the value matters (`@cm_delegated` is `1` or it is
 * nothing). {@link buildShowSessionOptionArgs} is the right shape when the
 * distinction between "set to empty" and "never set" matters, which is the
 * `status-right` case.
 */
export function buildShowSessionOptionValueArgs(sessionName: string, option: string): string[] {
  return ['show-options', '-v', '-t', exactSessionTarget(sessionName), option];
}

/** `tmux set-option -t <session> status-right '<format>'`. */
export function buildSetStatusRightArgs(sessionName: string, format: string): string[] {
  return buildSetSessionOptionArgs(sessionName, 'status-right', format);
}

/** `tmux set-option -u -t <session> status-right`. */
export function buildUnsetStatusRightArgs(sessionName: string): string[] {
  return buildUnsetSessionOptionArgs(sessionName, 'status-right');
}

/** Environment variable that turns the Phase B surface off. */
export const TMUX_STATUS_ENV = 'CM_TMUX_STATUS';

/**
 * True unless the operator set `CM_TMUX_STATUS` to `off` / `0` / `false`.
 *
 * Read at CALL time from an injected environment rather than at module load, so
 * a test can flip it without module-registry surgery and so a process started
 * with the variable set is not at the mercy of import order.
 */
export function isTmuxStatusEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const raw = (env[TMUX_STATUS_ENV] ?? '').trim().toLowerCase();
  return raw !== 'off' && raw !== '0' && raw !== 'false';
}

// ---------------------------------------------------------------------------
// Session-scoped hooks
// ---------------------------------------------------------------------------

/**
 * `tmux set-hook -t <session> <hook> <command>`.
 *
 * The command is passed as ONE argv element. Do not fold an `if-shell -F` into
 * it: measured on tmux 3.5a (Issue #2317 技術検証), a hook body of the shape
 * `if-shell -F '#{…}' 'display-popup …'` is accepted and then silently never
 * fires. A `run-shell -b '<script> #{session_name} #{client_control_mode}'` that
 * hands the formats to a script DOES fire, so every hook this feature installs
 * has that shape and the branching happens in the script.
 */
export function buildSetSessionHookArgs(
  sessionName: string,
  hook: string,
  command: string,
): string[] {
  return ['set-hook', '-t', exactSessionTarget(sessionName), hook, command];
}

/** `tmux set-hook -u -t <session> <hook>`. */
export function buildUnsetSessionHookArgs(sessionName: string, hook: string): string[] {
  return ['set-hook', '-u', '-t', exactSessionTarget(sessionName), hook];
}

/** `tmux show-hooks -t <session>` — session-scoped hooks only, never the global table. */
export function buildShowSessionHooksArgs(sessionName: string): string[] {
  return ['show-hooks', '-t', exactSessionTarget(sessionName)];
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

/** `tmux set-window-option -t <session> window-size <mode>`. */
export function buildWindowSizeArgs(sessionName: string, mode: 'manual' | 'latest'): string[] {
  return ['set-window-option', '-t', exactSessionTarget(sessionName), 'window-size', mode];
}

/** `tmux resize-window -t <session> -x <w> -y <h>`. */
export function buildResizeWindowArgs(
  sessionName: string,
  width: number,
  height: number,
): string[] {
  return [
    'resize-window',
    '-t',
    exactSessionTarget(sessionName),
    '-x',
    String(width),
    '-y',
    String(height),
  ];
}

/**
 * `tmux list-clients -t <session> -F '#{client_control_mode}'`.
 *
 * `client_control_mode` is `1` for a `tmux -C` client — which is what
 * CommandMate's own control-mode transport attaches as — and `0` for a human
 * terminal. Phase D hands the geometry back when the HUMAN count reaches zero,
 * so a control client sitting on the session forever must not keep the
 * delegation open (Issue #2317 受入条件 Phase D 4).
 */
export function buildListClientsArgs(sessionName: string): string[] {
  return ['list-clients', '-t', exactSessionTarget(sessionName), '-F', '#{client_control_mode}'];
}

/**
 * Number of human (control-mode `0`) clients in `list-clients` output.
 *
 * Counts lines that are exactly `0`, NOT lines that are "anything but 1". The
 * difference matters twice: `list-clients` exits 0 with EMPTY stdout on a
 * detached session, and a line this function does not recognise is not evidence
 * that a person is looking at the pane. Since the answer gates a resize, "I
 * could not read this" has to mean "nobody is attached" — the reading that
 * leaves `reconcileSessionGeometry` doing its normal job — rather than "somebody
 * is", which would pin a window open on an unparsed byte.
 *
 * `#{client_control_mode}` is `1` for a `tmux -C` client and `0` for a terminal;
 * measured on tmux 3.5a, a human client attached to a CommandMate session
 * reports exactly `0`.
 *
 * @param stdout - Raw stdout of {@link buildListClientsArgs}
 * @returns How many attached clients are humans
 */
export function countHumanClients(stdout: string): number {
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line === '0').length;
}

/** `tmux attach-session -t '=<session>:'`, with `-r` when read-only. */
export function buildAttachArgs(sessionName: string, readOnly: boolean): string[] {
  const args = ['attach-session'];
  if (readOnly) args.push('-r');
  args.push('-t', exactSessionTarget(sessionName));
  return args;
}

/** `tmux switch-client -t '=<session>:'` — the in-tmux equivalent of attaching. */
export function buildSwitchClientArgs(sessionName: string): string[] {
  return ['switch-client', '-t', exactSessionTarget(sessionName)];
}

// ---------------------------------------------------------------------------
// Which tools each behaviour applies to
// ---------------------------------------------------------------------------

/**
 * CLI tools `attach --live` will hand the pane geometry to (Issue #2317 決定事項 3).
 *
 * claude alone, and the list is a measurement rather than a starting point:
 * claude's reply is written from its own transcript JSONL, so a terminal-sized
 * frame during delegation cannot lose History. Every other tool either reads its
 * reply off the pane (copilot / gemini / vibe-local), or has detection rules
 * that were only ever measured at 200x1000 (codex / antigravity / command-code),
 * or cannot survive a width change at all (opencode paints a sidebar at >=121
 * columns). Widening this set is out of scope for #2317 and requires
 * re-measuring the tool it adds.
 */
export const LIVE_ATTACH_TOOLS: readonly string[] = ['claude'];

/** Whether `attach --live` is allowed for a CLI tool. */
export function isLiveAttachSupported(cliToolId: string): boolean {
  return LIVE_ATTACH_TOOLS.includes(cliToolId);
}

/**
 * Whether a tmux session's NAME says it runs a tool `--live` supports.
 *
 * The session name is `mcbd-<tool>-<worktree>` and no supported tool id is a
 * prefix of another, so this is exact rather than a guess. It exists because
 * the two callers that need the answer — the attach hook script's installer and
 * the response poller — hold a session name and nothing else: a hook fires with
 * tmux formats, and the poller must not pay a tmux round-trip to ask about a
 * session that could never be delegated in the first place.
 *
 * @param sessionName - tmux session name
 */
export function isLiveAttachEligibleSession(sessionName: string): boolean {
  if (!isCommandMateSession(sessionName)) return false;
  return LIVE_ATTACH_TOOLS.some((tool) =>
    sessionName.startsWith(`${MCBD_SESSION_PREFIX}${tool}-`)
  );
}

/**
 * CLI tools that paint their transcript in the terminal's alternate screen.
 *
 * The reason a bare `tmux attach` looks EMPTY for them: the TUI draws the
 * transcript at the top of a 1000-row canvas and its composer at the bottom, and
 * tmux follows the cursor, so a 44-row client sees the composer and nothing
 * else. `attach` prints its hint for exactly these.
 *
 * Deliberately a local list rather than an import of `usesAlternateScreen()`:
 * this module must stay free of `lib/cli-tools`, whose graph the CLI bundle
 * cannot afford (see the module docblock). The two are pinned to each other by
 * `tests/unit/tmux/session-surface-2317.test.ts`, so a tool moving in or out of
 * the alternate screen breaks a test rather than silently dropping the hint.
 */
export const ALT_SCREEN_TOOLS: readonly string[] = ['claude', 'opencode', 'copilot'];

/** Whether `attach` should warn that a bare attach shows no transcript. */
export function usesAltScreen(cliToolId: string): boolean {
  return ALT_SCREEN_TOOLS.includes(cliToolId);
}

// ---------------------------------------------------------------------------
// Phase D: live attach — handing the geometry over and taking it back
// ---------------------------------------------------------------------------

/**
 * ## The safety net is a poll, NOT a `client-detached` hook — measured
 *
 * Issue #2317's 技術検証 says a session-scoped `client-detached` hook fires.
 * Re-measured on tmux 3.5a against a private socket before this was written, it
 * does not, and two further facts make the shape unusable:
 *
 * | probe (tmux 3.5a, `tmux -L`)                        | result |
 * |-----------------------------------------------------|--------|
 * | `set-hook -t <s> client-attached`, human attaches    | fires; `#{session_name}` is the session, `#{client_control_mode}` is `0` |
 * | same, control-mode client attaches                   | does NOT fire |
 * | `set-hook -t <s> client-detached`, human detaches    | **never fires** |
 * | `set-hook -g client-detached`, human detaches        | fires — but `#{session_name}` is the CLIENT's other session and `#{client_control_mode}` is EMPTY |
 *
 * So the detach edge is unreachable session-scoped, and reaching it globally
 * would both break 決定事項 2 (no global tmux mutation) and arrive without the
 * session identity the restore needs. The restore therefore runs from the status
 * poll instead — `reconcileDelegatedGeometry()` in `lib/tmux/session-hooks.ts` —
 * which sees every session every couple of seconds, needs no tmux state of its
 * own, and covers cases a hook could not anyway: the CLI being killed, the
 * terminal window being closed, and a detach from some other client.
 *
 * The `client-attached` edge DOES work session-scoped, and that is the one the
 * opt-in hooks below are installed on.
 *
 * Both opt-in features hang off that same edge, and a tmux hook name without an
 * index IS `[0]`: installing two of them unindexed would mean the second
 * silently replaced the first. Measured on tmux 3.5a — `client-attached[0]` and
 * `client-attached[1]` both fire, and `set-hook -u` removes one without
 * disturbing the other.
 */
export const DELEGATE_HOOK = 'client-attached[0]';
/** @see DELEGATE_HOOK */
export const AUTO_POPUP_HOOK = 'client-attached[1]';

/**
 * Environment variable that also installs the geometry hand-over for a session
 * the user attached to BY HAND (`tmux attach`), not through
 * `commandmate attach --live`.
 *
 * Opt-in, because installing it unasked would mean a hand-rolled `tmux attach`
 * silently changes a session's geometry — the one thing Issue #2317 決定事項 1
 * says must not happen by default.
 */
export const LIVE_ATTACH_HOOK_ENV = 'CM_LIVE_ATTACH_HOOK';

/**
 * Environment variable that opens the following read popup on attach (Phase C).
 * Default off; see `AUTO_POPUP_SCRIPT` for why.
 */
export const AUTO_POPUP_ENV = 'CM_READ_MODE_AUTO_POPUP';

/** True when the operator opted into the attach-time geometry hand-over. */
export function isLiveAttachHookEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return (env[LIVE_ATTACH_HOOK_ENV] ?? '').trim().toLowerCase() === 'on';
}

/** True when the operator opted into the automatic read popup. */
export function isAutoPopupEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return (env[AUTO_POPUP_ENV] ?? '').trim().toLowerCase() === 'on';
}

/**
 * Quote a path for the `sh` command a tmux hook runs.
 *
 * Double quotes rather than single, because the whole shell-command is already
 * inside tmux's own single quotes and tmux's lexer does not process escapes
 * inside those — a `'\''` would end the tmux string, not the shell one.
 *
 * Returns undefined for a path carrying any character that would change the
 * meaning of a double-quoted word (`"`, `$`, a backtick, a backslash) or that
 * cannot appear on a command line at all (newline / carriage return). Callers
 * treat that as "install no hook": a home directory nobody can quote safely is a
 * reason to fall back to the CLI's own hand-over, not a reason to run a command
 * whose parse is a guess.
 *
 * @param path - Absolute script path
 * @returns The double-quoted word, or undefined when it cannot be represented
 */
export function quoteScriptPathForHook(path: string): string | undefined {
  if (/["$`\\\n\r]/.test(path)) return undefined;
  return `"${path}"`;
}

/**
 * The `run-shell` body of a session-scoped hook.
 *
 * `-b` because a hook that blocks the tmux server for the length of a shell
 * script is a hook that makes tmux feel broken.
 *
 * The formats are passed as separate words and consumed as `$1`, `$2`, `$3` by
 * the script, which is why none of them is quoted here — a tmux format that
 * expanded to something with a space would be split, and all three of these
 * (`session_name`, `client_control_mode`, `client_name`) are single words by
 * construction.
 *
 * @param quotedScriptPath - Result of {@link quoteScriptPathForHook}
 * @param formats - tmux formats to hand the script
 * @param extraArgs - Literal words appended after the formats
 * @returns The command string to hand to `set-hook`
 */
export function buildHookRunShellBody(
  quotedScriptPath: string,
  formats: readonly string[],
  extraArgs: readonly string[] = [],
): string {
  const words = [quotedScriptPath, ...formats, ...extraArgs].join(' ');
  return `run-shell -b '${words}'`;
}

/**
 * Formats every attach hook hands to its script.
 *
 * `#{client_name}` is included for both because the auto-popup needs it
 * (`display-popup -c <client>`) and the delegate script ignores extra arguments
 * — one format list is one thing to keep right.
 */
export const ATTACH_HOOK_FORMATS = [
  '#{session_name}',
  '#{client_control_mode}',
  '#{client_name}',
] as const;

/**
 * `set-hook -t <session> client-attached[0] 'run-shell -b …'`, or undefined when
 * the script path cannot be quoted safely.
 *
 * @param sessionName - Target session
 * @param scriptPath - Absolute path of the materialized delegate script
 */
export function buildInstallDelegateHookArgs(
  sessionName: string,
  scriptPath: string,
): string[] | undefined {
  const quoted = quoteScriptPathForHook(scriptPath);
  if (quoted === undefined) return undefined;
  return buildSetSessionHookArgs(
    sessionName,
    DELEGATE_HOOK,
    buildHookRunShellBody(quoted, ATTACH_HOOK_FORMATS),
  );
}

/** `set-hook -u -t <session> client-attached[0]`. */
export function buildRemoveDelegateHookArgs(sessionName: string): string[] {
  return buildUnsetSessionHookArgs(sessionName, DELEGATE_HOOK);
}

/**
 * `set-hook -t <session> client-attached[1] 'run-shell -b …'`, or undefined when
 * the script path cannot be quoted safely.
 */
export function buildInstallAutoPopupHookArgs(
  sessionName: string,
  scriptPath: string,
): string[] | undefined {
  const quoted = quoteScriptPathForHook(scriptPath);
  if (quoted === undefined) return undefined;
  return buildSetSessionHookArgs(
    sessionName,
    AUTO_POPUP_HOOK,
    buildHookRunShellBody(quoted, ATTACH_HOOK_FORMATS),
  );
}

/** `set-hook -u -t <session> client-attached[1]`. */
export function buildRemoveAutoPopupHookArgs(sessionName: string): string[] {
  return buildUnsetSessionHookArgs(sessionName, AUTO_POPUP_HOOK);
}

/**
 * The tmux commands that hand a session's geometry to the attaching terminal.
 *
 * Ordered: the flag is raised BEFORE `window-size latest`, so a status poll that
 * lands between the two sees "delegated, still 200x1000" — which suppresses the
 * scraped save one poll early — rather than "not delegated, 44 rows", which
 * would save a truncated reply. The cheap failure is the safe one.
 *
 * @param sessionName - Target session
 * @returns Argument vectors, to run in order
 */
export function buildDelegateGeometryCommands(sessionName: string): string[][] {
  return [
    buildSetSessionOptionArgs(sessionName, CM_DELEGATED_OPTION, '1'),
    buildWindowSizeArgs(sessionName, 'latest'),
  ];
}

/**
 * The tmux commands that take a session's geometry back.
 *
 * The mirror image of {@link buildDelegateGeometryCommands}, and ordered the
 * other way for the same reason: the canvas is restored first and the flag is
 * dropped last, so no poll can ever see "not delegated" while the pane is still
 * the size of somebody's terminal.
 *
 * @param sessionName - Target session
 * @param width - Canvas width (defaults to the pinned {@link TUI_PANE_WIDTH})
 * @param height - Canvas height (defaults to the pinned {@link TUI_PANE_HEIGHT})
 */
export function buildRestoreGeometryCommands(
  sessionName: string,
  width: number = TUI_PANE_WIDTH,
  height: number = TUI_PANE_HEIGHT,
): string[][] {
  return [
    buildWindowSizeArgs(sessionName, 'manual'),
    buildResizeWindowArgs(sessionName, width, height),
    buildUnsetSessionOptionArgs(sessionName, CM_DELEGATED_OPTION),
  ];
}
