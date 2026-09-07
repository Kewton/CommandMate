/**
 * How a CommandMate CLI command is spelled — the single source both the
 * assistant context and the GUI read (Issue #2120).
 *
 * ## Why this file exists
 *
 * `resolveCommandMateBinary()` used to be a module-private function inside
 * `src/lib/assistant/context-builder.ts`, where only the assistant prompt could
 * see it. Issue #2120 puts the same four commands on screen in the roster pane,
 * and a second copy of the `commandmate` / `commandmatedev` rule would be a
 * second authority on the one thing the operator pastes into a shell: a
 * development checkout would keep telling the assistant `commandmatedev` while
 * telling the human `commandmate`, and the human's copy would simply not be on
 * their PATH. So the rule moved here and both callers import it.
 *
 * ## Isomorphic on purpose
 *
 * {@link buildInstanceCliCommands} and {@link buildDelegationBrief} are pure
 * functions of strings so the browser can call them.
 * {@link resolveCommandMateBinary} reads an environment and is meant for the
 * server — a client component cannot read `CM_LAUNCHED_BY` (Next.js inlines
 * only `NEXT_PUBLIC_*` into the browser bundle), which is why
 * `GET /api/worktrees/:id/cli-reference` exists to hand the answer down.
 *
 * Nothing here touches a DOM, and that is load-bearing rather than incidental:
 * `commandmate peers` imports {@link resolveCommandMateBinary} from this file,
 * and the CLI build (`tsconfig.cli.json`) has no DOM lib at all. The delegation
 * brief's delivery into a composer therefore lives with the components that
 * deliver it — see `insertIntoVisibleComposer` in
 * `src/components/common/CommandPalette.tsx` (Issue #2376).
 */

/** The binary name a globally installed CommandMate puts on PATH. */
export const COMMANDMATE_GLOBAL_BINARY = 'commandmate';

/**
 * The binary name a repository checkout puts on PATH (`npm link` in this repo).
 *
 * Not a fallback in the "we could not tell" sense: `commandmate start` sets
 * `CM_LAUNCHED_BY=commandmate-cli` on itself and on the server child it spawns
 * (`src/cli/commands/start.ts`), so a server that was NOT started that way was
 * started from a checkout, and `commandmatedev` is the command that exists.
 */
export const COMMANDMATE_DEV_BINARY = 'commandmatedev';

/** The marker `commandmate start` stamps on the server process it launches. */
export const COMMANDMATE_CLI_LAUNCH_MARKER = 'commandmate-cli';

/**
 * The port a copied command does not have to name.
 *
 * `src/lib/env.ts` keeps its own private `DEFAULT_PORT` for the server's own
 * binding; this constant answers a different question — "must the pasted line
 * carry a `CM_PORT=` prefix?" — and is exported because the API route that
 * decides it and the builder that renders it are in different layers.
 */
export const DEFAULT_SERVER_PORT = 3000;

/** The binary name to spell CommandMate commands with. */
export type CommandMateBinary =
  | typeof COMMANDMATE_GLOBAL_BINARY
  | typeof COMMANDMATE_DEV_BINARY;

/**
 * Which binary name the CLI commands aimed at THIS server should use.
 *
 * @param env - The environment to read; defaults to the server's own
 * @returns `commandmate` when the server was started by the installed CLI,
 *   `commandmatedev` otherwise
 */
export function resolveCommandMateBinary(
  env: Readonly<Record<string, string | undefined>> = process.env,
): CommandMateBinary {
  return env.CM_LAUNCHED_BY === COMMANDMATE_CLI_LAUNCH_MARKER
    ? COMMANDMATE_GLOBAL_BINARY
    : COMMANDMATE_DEV_BINARY;
}

/** The four session-targeting commands the roster pane offers, in display order. */
export const INSTANCE_CLI_COMMAND_IDS = ['send', 'wait', 'capture', 'respond'] as const;

export type InstanceCliCommandId = (typeof INSTANCE_CLI_COMMAND_IDS)[number];

/**
 * The answer `respond` is shown with.
 *
 * A NUMBER, never `yes`. `respond` hands its argument to the pane as keystrokes
 * and does not resolve it semantically, so `yes` on a multiple-choice dialog is
 * typed, ignored, and followed by Enter — which picks whatever the DEFAULT
 * option happens to be. The number is the only form that selects what the
 * operator meant. The note beside the command says so; this constant is what
 * keeps the example itself from teaching the wrong habit.
 */
export const RESPOND_ANSWER_EXAMPLE = '1';

export interface InstanceCliCommandInput {
  /** From {@link resolveCommandMateBinary}, never hardcoded by the caller. */
  binary: string;
  /** The worktree id as the CLI must be given it. */
  worktreeId: string;
  /**
   * The instance id **as the server resolved it**
   * (`GET /api/worktrees/:id/resolve-target`). Never a roster row read directly:
   * Issue #1925 is the record of what two authorities answering this question
   * cost.
   */
  instanceId: string;
  /**
   * The port to name in a `CM_PORT=` prefix, or null when this server is on
   * {@link DEFAULT_SERVER_PORT} and the prefix would be noise.
   *
   * There is deliberately no `--port` flag here: `send` / `wait` / `capture` /
   * `respond` do not define one (only `start` / `stop` / `status` do), so a
   * pasted `--port 3135` would be rejected by commander as an unknown option.
   * `CM_PORT=<n> commandmate ls` is the documented way to aim one invocation at
   * a non-default server (see `loadClientEnv()` in `src/cli/utils/server-url.ts`).
   */
  portPrefix?: number | null;
  /** Localized stand-in for the message body, e.g. `メッセージ`. */
  messagePlaceholder: string;
}

/**
 * Render the four commands that address one agent instance.
 *
 * The message body stays a PLACEHOLDER. Quoting a real body correctly in the
 * browser means getting Japanese text, newlines and embedded quotes past a
 * shell whose dialect this code cannot see, and a near-miss does not fail
 * loudly — it sends a truncated prompt to a live agent.
 *
 * `worktreeId` and `instanceId` need no quoting of their own: both are
 * validated before they can reach a roster row or this route
 * (`isValidWorktreeId` / `isValidInstanceId` allow no shell metacharacter).
 *
 * @param input - Binary, target and presentation details
 * @returns One shell line per command id
 */
export function buildInstanceCliCommands(
  input: InstanceCliCommandInput,
): Record<InstanceCliCommandId, string> {
  const { binary, worktreeId, instanceId, messagePlaceholder } = input;
  const prefix =
    input.portPrefix != null && input.portPrefix !== DEFAULT_SERVER_PORT
      ? `CM_PORT=${input.portPrefix} `
      : '';
  const target = `--instance ${instanceId}`;
  const head = `${prefix}${binary}`;

  return {
    send: `${head} send ${worktreeId} "${messagePlaceholder}" ${target}`,
    // `--on-prompt human` is part of the copied line, not an afterthought: the
    // default (`agent`) exits 10 the moment a prompt appears, which is right
    // for a script polling in a loop and useless for the operator who just
    // pasted a wait into their own terminal.
    wait: `${head} wait ${worktreeId} ${target} --on-prompt human`,
    capture: `${head} capture ${worktreeId} ${target}`,
    respond: `${head} respond ${worktreeId} "${RESPOND_ANSWER_EXAMPLE}" ${target}`,
  };
}

// ===========================================================================
// Delegation brief (Issue #2376)
// ===========================================================================

/**
 * `--timeout` the brief tells session A to use, in seconds.
 *
 * 30 minutes. Long enough that an ordinary implementation request is not cut
 * off mid-turn, short enough that a session which died in its pane surfaces as
 * an exit 124 in the same sitting rather than at the end of the day. A caller
 * who wants a different one edits the line — it is a brief, not a config.
 */
export const DELEGATION_ASK_TIMEOUT_SECONDS = 1800;

/**
 * Rows of pane transcript the brief's progress-check line asks for.
 *
 * Matches what `capture --pane --tail 60` shows a human: enough to see what the
 * other session is doing, short enough to paste into a report.
 */
const DELEGATION_CAPTURE_TAIL = 60;

/** The locales the brief is written in. Anything else falls back to English. */
export type DelegationBriefLocale = 'ja' | 'en';

export interface DelegationBriefInput {
  /** From {@link resolveCommandMateBinary}, never hardcoded by the caller. */
  binary: string;
  /** The worktree id as the CLI must be given it. */
  worktreeId: string;
  /**
   * The instance id **as the server resolved it**
   * (`GET /api/worktrees/:id/resolve-target`) — the same rule
   * {@link InstanceCliCommandInput.instanceId} states, for the same reason.
   */
  instanceId: string;
  /** The roster alias of the target instance, e.g. `Codex 2`. */
  instanceLabel: string;
  /** Display name of the CLI tool behind the instance, e.g. `Codex`. */
  toolLabel: string;
  /** As {@link InstanceCliCommandInput.portPrefix}. */
  portPrefix?: number | null;
  /** UI locale. Anything but `ja` is written in English. */
  locale: string;
}

/**
 * The paragraph one agent session pastes to another agent session's operator —
 * "here is how you delegate to that session" — in the UI's own language.
 *
 * ## Why it lives beside {@link buildInstanceCliCommands}
 *
 * Both answer the same question (how is a CommandMate command aimed at ONE
 * instance spelled?) from the same two server reads, and Issue #2120 already
 * paid for learning that a second copy of the binary-name rule is a copy that
 * tells the human one thing and the assistant another. The panel and the brief
 * therefore share this module, and neither composes a command from what the
 * browser happens to know.
 *
 * ## Why the text is here rather than in `locales/`
 *
 * It is a PROMPT, not a label. The whole value of it is that the four exit
 * codes, the "do not answer their prompt" rule and the command spellings arrive
 * together and unedited; a translator moving a line between keys, or a key
 * resolving to its own name because the namespace was renamed, produces a brief
 * that still looks like a brief and quietly drops the one clause that stops
 * session A from answering session B's permission dialog. The two languages are
 * written out in full, side by side, so a change to one is visibly a change to
 * the other.
 *
 * @param input - Binary, target and locale
 * @returns The brief, ready to be inserted into a composer
 */
export function buildDelegationBrief(input: DelegationBriefInput): string {
  const { binary, worktreeId, instanceId, instanceLabel, toolLabel } = input;
  const prefix =
    input.portPrefix != null && input.portPrefix !== DEFAULT_SERVER_PORT
      ? `CM_PORT=${input.portPrefix} `
      : '';
  const head = `${prefix}${binary}`;
  const target = `--instance ${instanceId}`;
  const locale: DelegationBriefLocale = input.locale === 'ja' ? 'ja' : 'en';

  const capture = `${head} capture ${worktreeId} ${target} --pane --tail ${DELEGATION_CAPTURE_TAIL}`;

  if (locale === 'ja') {
    const ask =
      `${head} ask ${worktreeId} ${target} "<依頼文>" --timeout ${DELEGATION_ASK_TIMEOUT_SECONDS}`;
    return [
      `## 別セッション「${instanceLabel}」への委任`,
      `- 宛先: worktree \`${worktreeId}\` / instance \`${instanceId}\`（${toolLabel}）`,
      `- 依頼: ${ask}`,
      '  - exit 0: 標準出力が返答本文',
      '  - exit 10: 相手が確認待ち。標準出力のprompt JSONを私に報告して止まる（自分で答えない）',
      '  - exit 124: タイムアウト。captureで状況を見て報告',
      `- 進捗確認: ${capture}`,
      '- 禁止: respondで相手のプロンプトに答える / auto-yesを有効化する',
    ].join('\n');
  }

  const ask =
    `${head} ask ${worktreeId} ${target} "<request>" --timeout ${DELEGATION_ASK_TIMEOUT_SECONDS}`;
  return [
    `## Delegating to session "${instanceLabel}"`,
    `- Target: worktree \`${worktreeId}\` / instance \`${instanceId}\` (${toolLabel})`,
    `- Ask: ${ask}`,
    '  - exit 0: stdout is the reply body',
    '  - exit 10: they are waiting on a confirmation. Report the prompt JSON on stdout back to me and stop (do not answer it yourself)',
    '  - exit 124: timed out. Look with capture and report what you see',
    `- Progress: ${capture}`,
    '- Do not: answer their prompt with respond / turn auto-yes on',
  ].join('\n');
}
