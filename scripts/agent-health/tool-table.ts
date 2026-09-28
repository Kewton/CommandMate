/**
 * How agent-health drives each CLI (Issue #2878).
 *
 * One row per tool: the launch additions, the start-up dialogs to get past,
 * the three requests, and how its approval dialog is recognised and refused.
 * Measured on this machine on 2026-09-27 against claude 2.1.283, codex
 * 0.157.1, agy 1.2.12, opencode 1.18.31/1.18.32 and commandcode 1.58.1/1.66.0,
 * in a 200x1000 pane (80x200 for opencode, the geometry CommandMate uses).
 *
 * opencode-v2 (opencode2 2.0.18) was added on 2026-09-28 (Issue #2937).
 *
 * Model calls per tool: at most three turns (running, approval, quoted) — the
 * approval turn is folded into the running turn where the CLI already asks
 * before `sleep` (antigravity, command-code).
 */

import os from 'os';
import path from 'path';
import { OPENCODE_PANE_HEIGHT, OPENCODE_PANE_WIDTH, TUI_PANE_HEIGHT, TUI_PANE_WIDTH } from '@/config/tmux-pane-config';
import { resolveCaptureSpec } from '@/lib/cli-tools/capture-spec';
import type { CLIToolType } from '@/lib/cli-tools/types';
import { getAntigravityHooksConfigPath } from '@/lib/hooks/sources/antigravity/hooks-config';
import { getCodexHome, getCodexHooksPath } from '@/lib/hooks/sources/codex/hooks-config';
import { getCodexRelayInstallPath } from '@/lib/hooks/sources/codex/relay-install';
import type { AgentHealthTool } from '@/lib/agent-health/types';

export interface StartupDialog {
  id: string;
  /** Recognises the dialog in the ANSI-stripped frame. */
  pattern: RegExp;
  /** Move the cursor to this option and press Enter … */
  select?: RegExp;
  /** … or send these keys. */
  keys?: string[];
}

export interface ApprovalSpec {
  /**
   * `running-turn`: the running request (`sleep`) already asks for approval,
   * so that dialog is the one checked. `own-turn`: a separate request
   * (`touch`) raises it. `none`: the CLI does not ask in its default setup.
   */
  via: 'running-turn' | 'own-turn' | 'none';
  /** Recognises the approval dialog (counted, so an older one does not match). */
  dialog: RegExp;
  /** Keys that refuse the request and close the dialog. */
  denyKeys: string[];
  skipReason?: string;
}

export interface ToolProbeSpec {
  tool: AgentHealthTool;
  cliToolId: CLIToolType;
  /** Executable for `--version` and `prepareLaunch`. */
  executable: string;
  width: number;
  height: number;
  /** Lines captured for the detector — the production status capture. */
  captureLines: number;
  /**
   * Appended after the rendered launch line, the way CommandMate appends
   * `--model` / command-code's flags. Only settings that make the probe
   * deterministic and cheap; nothing that changes where hooks go.
   */
  launchFlags: (workDir: string) => string[];
  startupDialogs: StartupDialog[];
  prompts: { running: string; approval: string; quoted: string };
  approval: ApprovalSpec;
  /** Machine-singleton files the run touches. */
  guardedFiles: () => { hookConfig: string[]; trustState: string[] };
  /**
   * Variables put in front of the launch line (`env K=V <line>`), for state
   * the CLI would otherwise write into the user's home. Never anything the
   * production launch line itself depends on.
   */
  launchEnv?: (workDir: string) => Record<string, string>;
  /**
   * `opencode-v2`: the launch goes through `scripts/opencode-v2/launch.sh`
   * with a reserved port and password (the production path), and the
   * `hook-correlation` slot checks that server's SSE instead of hooks
   * (Issue #2937).
   */
  server?: 'opencode-v2';
}

const RUNNING_PROMPT = 'Run the shell command: sleep 20';
const APPROVAL_PROMPT = 'Run the shell command: touch agent-health-probe.txt';

function quote(block: string): string {
  return `Reply with exactly the following block and nothing else (do not run anything):\n${block}`;
}

export const TOOL_PROBE_SPECS: Record<AgentHealthTool, ToolProbeSpec> = {
  claude: {
    tool: 'claude',
    cliToolId: 'claude',
    executable: 'claude',
    width: TUI_PANE_WIDTH,
    height: TUI_PANE_HEIGHT,
    captureLines: resolveCaptureSpec('claude').statusLines,
    // `manual`: since 2.1.236 the default may be auto mode, which never draws
    // the approval dialog (scripts/canary/tool-profiles.ts).
    launchFlags: () => ['--model', 'haiku', '--permission-mode', 'manual'],
    startupDialogs: [
      // 2.1.283 pre-selects "No, exit".
      { id: 'trust', pattern: /Yes, I trust this folder/, select: /Yes, I trust this folder/ },
      { id: 'theme', pattern: /Choose the text style that looks best/i, keys: ['Enter'] },
    ],
    prompts: {
      running: RUNNING_PROMPT,
      approval: APPROVAL_PROMPT,
      quoted: quote(
        [
          'Bash command',
          '  touch probe.txt',
          'Do you want to proceed?',
          '❯ 1. Yes',
          '  2. No',
          'Esc to cancel',
        ].join('\n')
      ),
    },
    approval: { via: 'own-turn', dialog: /Do you want to proceed\?/, denyKeys: ['Escape'] },
    guardedFiles: () => ({ hookConfig: [], trustState: [] }),
  },

  codex: {
    tool: 'codex',
    cliToolId: 'codex',
    executable: 'codex',
    width: TUI_PANE_WIDTH,
    height: TUI_PANE_HEIGHT,
    captureLines: resolveCaptureSpec('codex').statusLines,
    // Trust through `-c` lives in memory only (the dialog would save it to
    // config.toml). codex splits the key on '.', so the work dir has no dots.
    // `read-only` + `on-request` makes `touch` ask; `sleep` still runs.
    launchFlags: (workDir) => [
      '-c',
      `projects.${workDir}.trust_level=trusted`,
      '-c',
      'history.persistence=none',
      '-c',
      'model_reasoning_effort=low',
      '-s',
      'read-only',
      '-a',
      'on-request',
    ],
    startupDialogs: [
      { id: 'trust', pattern: /Trust this folder\?/, select: /Trust and continue/ },
    ],
    prompts: {
      running: RUNNING_PROMPT,
      approval: APPROVAL_PROMPT,
      // The request `docs/design/codex-detection-corpus.md` uses for
      // `quoted-approval-idle.txt`.
      quoted: [
        'Reply with exactly the following block and nothing else:',
        'Would you like to run the following command?',
        '  $ npm test',
        '› 1. Yes, proceed (y)',
        '  2. No, and tell Codex what to do differently (esc)',
        '  Press enter to confirm or esc to cancel',
      ].join('\n'),
    },
    approval: {
      via: 'own-turn',
      dialog: /Would you like to run the following command\?/,
      denyKeys: ['Escape'],
    },
    guardedFiles: () => ({
      hookConfig: [getCodexHooksPath(), getCodexRelayInstallPath(getCodexHome())],
      trustState: [path.join(getCodexHome(), 'config.toml')],
    }),
  },

  antigravity: {
    tool: 'antigravity',
    cliToolId: 'antigravity',
    executable: 'agy',
    width: TUI_PANE_WIDTH,
    height: TUI_PANE_HEIGHT,
    captureLines: resolveCaptureSpec('antigravity').statusLines,
    launchFlags: () => [],
    startupDialogs: [
      { id: 'trust', pattern: /Do you trust the contents of this project\?/, select: /Yes, I trust this folder/ },
    ],
    prompts: {
      running: RUNNING_PROMPT,
      approval: APPROVAL_PROMPT,
      quoted: quote(
        [
          'Requesting permission for:',
          '   sleep 20',
          'Run this command?',
          '> 1. Yes, run command',
          '  4. No, cancel',
        ].join('\n')
      ),
    },
    // agy asks before `sleep` too.
    approval: { via: 'running-turn', dialog: /Run this command\?/, denyKeys: ['Escape'] },
    guardedFiles: () => ({
      hookConfig: [getAntigravityHooksConfigPath()],
      // `trustedWorkspaces` — written when the folder-trust dialog is answered.
      trustState: [path.join(os.homedir(), '.gemini', 'antigravity-cli', 'settings.json')],
    }),
  },

  opencode: {
    tool: 'opencode',
    cliToolId: 'opencode',
    executable: 'opencode',
    width: OPENCODE_PANE_WIDTH,
    height: OPENCODE_PANE_HEIGHT,
    captureLines: resolveCaptureSpec('opencode').statusLines,
    launchFlags: () => [],
    startupDialogs: [],
    prompts: {
      running: RUNNING_PROMPT,
      approval: APPROVAL_PROMPT,
      quoted: quote(
        ['△ Permission required', '  # Shell command', '$ uname -a', ' Allow once   Allow always   Reject'].join(
          '\n'
        )
      ),
    },
    approval: {
      via: 'none',
      dialog: /Permission required/,
      denyKeys: ['Escape'],
      skipReason:
        'opencode の既定の権限設定は bash・編集を確認なしで実行する（実測: sleep 20 がダイアログ無しで走る）ため、承認ダイアログが出ない',
    },
    guardedFiles: () => ({ hookConfig: [], trustState: [] }),
  },

  'command-code': {
    tool: 'command-code',
    cliToolId: 'command-code',
    executable: 'commandcode',
    width: TUI_PANE_WIDTH,
    height: TUI_PANE_HEIGHT,
    captureLines: resolveCaptureSpec('command-code').statusLines,
    // COMMAND_CODE_LAUNCH_FLAGS — what CommandMate itself appends.
    launchFlags: () => ['--trust', '--skip-onboarding', '--no-auto-update'],
    startupDialogs: [
      { id: 'trust', pattern: /Do you trust the files in this folder\?/, select: /Yes, proceed/ },
      { id: 'taste', pattern: /Build Your Coding Taste/, keys: ['Escape'] },
    ],
    prompts: {
      running: RUNNING_PROMPT,
      approval: APPROVAL_PROMPT,
      quoted: quote(
        [
          'Execute Shell Command',
          'Command Code needs to execute sleep 20.',
          '❯ 1. Yes',
          "  2. Yes, don't ask again for `sleep` commands in this project",
          '  3. No, tell Command Code what to do differently',
        ].join('\n')
      ),
    },
    approval: { via: 'running-turn', dialog: /Command Code needs to execute/, denyKeys: ['Escape'] },
    guardedFiles: () => ({
      hookConfig: [],
      trustState: [path.join(os.homedir(), '.commandcode', 'trusted-hooks.json')],
    }),
  },
  'opencode-v2': {
    tool: 'opencode-v2',
    cliToolId: 'opencode-v2',
    executable: 'opencode2',
    width: OPENCODE_PANE_WIDTH,
    height: OPENCODE_PANE_HEIGHT,
    captureLines: resolveCaptureSpec('opencode-v2').statusLines,
    launchFlags: () => [],
    startupDialogs: [],
    prompts: {
      running: RUNNING_PROMPT,
      approval: APPROVAL_PROMPT,
      // v2's wording: `Always allow`, where v1 says `Allow always`.
      quoted: quote(
        ['△ Permission required', '  # Shell command', '$ uname -a', ' Allow once   Always allow   Reject'].join(
          '\n'
        )
      ),
    },
    approval: {
      via: 'none',
      dialog: /Permission required/,
      denyKeys: ['Escape'],
      skipReason:
        'opencode2 の既定のルールは shell を確認なしで実行する（#2370 Phase 0 (f)。実測: sleep 20 がダイアログ無しで走る）ため、承認ダイアログが出ない',
    },
    // The TUI keeps prompt history, model picks and locks in
    // $XDG_STATE_HOME/opencode — the directory that also holds the user's
    // background service (`service.json`). Pointed next to the work dir (in
    // the run's temp dir, outside the repo the agent sees), so none of the
    // user's files is written, rather than compared afterwards.
    launchEnv: (workDir) => ({ XDG_STATE_HOME: `${workDir}-xdg-state` }),
    guardedFiles: () => ({ hookConfig: [], trustState: [] }),
    server: 'opencode-v2',
  },
};
