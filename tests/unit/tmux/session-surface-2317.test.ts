/**
 * Issue #2317 — the tmux surface's WIRE FORMS.
 *
 * Everything CommandMate writes onto a tmux session goes through the builders in
 * `lib/session/tmux-session-surface.ts`, so this file is where the argv is
 * pinned. Two properties matter more than any individual string:
 *
 *  - **nothing is server-global.** 決定事項 2 says the new surface must be
 *    session-scoped, and a `-g` anywhere in these vectors would silently make it
 *    everyone's. That is asserted over EVERY builder, not per call site.
 *  - **the target is exact.** `=name:` (Issue #1156). A bare name prefix-matches,
 *    and `mcbd-claude-wt` is a prefix of `mcbd-claude-wt-2`, so a fuzzy target
 *    would write one instance's status onto another's session.
 *
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest';
import {
  ALT_SCREEN_TOOLS,
  ATTACH_HOOK_FORMATS,
  AUTO_POPUP_HOOK,
  CM_DELEGATED_OPTION,
  CM_SESSION_OPTIONS,
  CM_STATUS_OPTION,
  CM_STATUS_RIGHT_FORMAT,
  DELEGATE_HOOK,
  LIVE_ATTACH_TOOLS,
  MCBD_SESSION_PREFIX,
  buildAttachArgs,
  buildDelegateGeometryCommands,
  buildHookRunShellBody,
  buildInstallAutoPopupHookArgs,
  buildInstallDelegateHookArgs,
  buildListClientsArgs,
  buildRemoveAutoPopupHookArgs,
  buildRemoveDelegateHookArgs,
  buildResizeWindowArgs,
  buildRestoreGeometryCommands,
  buildSetSessionOptionArgs,
  buildSetStatusRightArgs,
  buildShowSessionOptionArgs,
  buildShowSessionOptionValueArgs,
  buildSwitchClientArgs,
  buildUnsetSessionOptionArgs,
  buildWindowSizeArgs,
  countHumanClients,
  exactSessionTarget,
  isCommandMateSession,
  isLiveAttachEligibleSession,
  isLiveAttachSupported,
  isTmuxStatusEnabled,
  quoteScriptPathForHook,
  usesAltScreen,
} from '@/lib/session/tmux-session-surface';
import { exactTarget } from '@/lib/tmux/tmux';
import { MCBD_SESSION_PREFIX as READ_MODE_PREFIX } from '@/lib/tmux/read-mode';
import { CLI_TOOL_IDS, usesAlternateScreen, type CLIToolType } from '@/lib/cli-tools/types';
import { resolveSessionName } from '@/lib/cli-tools/session-name';
import { TUI_PANE_HEIGHT, TUI_PANE_WIDTH } from '@/config/tmux-pane-config';

const SESSION = 'mcbd-claude-wt';

/** Every argv this module can produce, for the invariants that apply to all of them. */
function everyBuilderOutput(): string[][] {
  return [
    buildSetSessionOptionArgs(SESSION, CM_STATUS_OPTION, 'running'),
    buildUnsetSessionOptionArgs(SESSION, CM_STATUS_OPTION),
    buildShowSessionOptionArgs(SESSION, 'status-right'),
    buildShowSessionOptionValueArgs(SESSION, CM_DELEGATED_OPTION),
    buildSetStatusRightArgs(SESSION, CM_STATUS_RIGHT_FORMAT),
    buildWindowSizeArgs(SESSION, 'latest'),
    buildWindowSizeArgs(SESSION, 'manual'),
    buildResizeWindowArgs(SESSION, TUI_PANE_WIDTH, TUI_PANE_HEIGHT),
    buildListClientsArgs(SESSION),
    buildAttachArgs(SESSION, false),
    buildAttachArgs(SESSION, true),
    buildSwitchClientArgs(SESSION),
    buildRemoveDelegateHookArgs(SESSION),
    buildRemoveAutoPopupHookArgs(SESSION),
    buildInstallDelegateHookArgs(SESSION, '/home/u/.commandmate/bin/x.sh')!,
    buildInstallAutoPopupHookArgs(SESSION, '/home/u/.commandmate/bin/y.sh')!,
    ...buildDelegateGeometryCommands(SESSION),
    ...buildRestoreGeometryCommands(SESSION),
  ];
}

describe('nothing this feature writes is server-global (決定事項 2)', () => {
  it('no builder ever emits -g', () => {
    for (const argv of everyBuilderOutput()) {
      expect(argv, argv.join(' ')).not.toContain('-g');
    }
  });

  it('every builder targets the session, and exactly', () => {
    for (const argv of everyBuilderOutput()) {
      expect(argv, argv.join(' ')).toContain('-t');
      expect(argv, argv.join(' ')).toContain(exactSessionTarget(SESSION));
    }
  });

  it('the exact-match form is the same string lib/tmux/tmux.ts produces', () => {
    // Two copies exist because `tmux.ts` is unreachable from the CLI bundle
    // (tsconfig.cli.json sets paths: {}). This is what keeps them one string.
    expect(exactSessionTarget(SESSION)).toBe(exactTarget(SESSION));
    expect(exactSessionTarget(SESSION)).toBe('=mcbd-claude-wt:');
  });

  it('the session prefix is the same one #1623 guards its key binding with', () => {
    expect(MCBD_SESSION_PREFIX).toBe(READ_MODE_PREFIX);
    // And it is the prefix real sessions actually carry.
    expect(resolveSessionName('claude', 'wt')).toMatch(new RegExp(`^${MCBD_SESSION_PREFIX}`));
    expect(isCommandMateSession(resolveSessionName('claude', 'wt'))).toBe(true);
    expect(isCommandMateSession('someone-elses-session')).toBe(false);
  });
});

describe('the @cm_* option set', () => {
  it('publishes the five the Issue names, plus the delegation flag', () => {
    expect(CM_SESSION_OPTIONS).toEqual([
      '@cm_status',
      '@cm_worktree',
      '@cm_tool',
      '@cm_instance',
      '@cm_updated',
      '@cm_delegated',
    ]);
  });

  it('renders the status line FROM those options rather than baking values in', () => {
    // A format, not an interpolation: the line re-renders on every option write,
    // so the status line never needs a write of its own.
    expect(CM_STATUS_RIGHT_FORMAT).toContain('#{@cm_tool}');
    expect(CM_STATUS_RIGHT_FORMAT).toContain('#{@cm_instance}');
    expect(CM_STATUS_RIGHT_FORMAT).toContain('#{@cm_status}');
    expect(CM_STATUS_RIGHT_FORMAT).toMatch(/^\[CommandMate /);
    // The window size is on it because this whole Issue is about a window whose
    // size the reader cannot otherwise see.
    expect(CM_STATUS_RIGHT_FORMAT).toContain('#{window_width}x#{window_height}');
  });

  it('the status probe keeps the empty/set distinction, the value probe does not', () => {
    // `show-options -t <s> status-right` answers with EMPTY stdout when the
    // session never set it; `-v` would print an empty line either way and
    // "the user customised this" would be unreadable.
    expect(buildShowSessionOptionArgs(SESSION, 'status-right')).not.toContain('-v');
    expect(buildShowSessionOptionValueArgs(SESSION, CM_DELEGATED_OPTION)).toContain('-v');
  });
});

describe('CM_TMUX_STATUS', () => {
  it('is on unless explicitly turned off', () => {
    expect(isTmuxStatusEnabled({})).toBe(true);
    expect(isTmuxStatusEnabled({ CM_TMUX_STATUS: '' })).toBe(true);
    expect(isTmuxStatusEnabled({ CM_TMUX_STATUS: 'on' })).toBe(true);
    for (const off of ['off', 'OFF', ' 0 ', 'false', 'False']) {
      expect(isTmuxStatusEnabled({ CM_TMUX_STATUS: off }), off).toBe(false);
    }
  });
});

describe('counting human clients', () => {
  it('counts control-mode 0 and nothing else', () => {
    expect(countHumanClients('')).toBe(0);
    expect(countHumanClients('0\n')).toBe(1);
    expect(countHumanClients('0\n0\n1\n')).toBe(2);
    expect(countHumanClients('1\n1\n')).toBe(0);
  });

  it('treats an unreadable line as "nobody", never as "somebody"', () => {
    // The answer gates a resize. "I could not parse this" must fall on the side
    // that keeps `reconcileSessionGeometry` doing its job, not the side that
    // pins a window open on an unrecognised byte.
    expect(countHumanClients('80|24')).toBe(0);
    expect(countHumanClients('no clients')).toBe(0);
  });
});

describe('attach argv', () => {
  it('quotes nothing itself — the exact-match form is one argv element', () => {
    // The zsh `=` expansion the Issue measured only bites a SHELL. execFile /
    // spawn pass argv straight through, which is why `commandmate attach` can
    // hide the problem entirely.
    expect(buildAttachArgs(SESSION, false)).toEqual([
      'attach-session',
      '-t',
      '=mcbd-claude-wt:',
    ]);
  });

  it('adds -r for a read-only attach', () => {
    expect(buildAttachArgs(SESSION, true)).toEqual([
      'attach-session',
      '-r',
      '-t',
      '=mcbd-claude-wt:',
    ]);
  });

  it('switches instead of attaching when already inside tmux', () => {
    expect(buildSwitchClientArgs(SESSION)).toEqual(['switch-client', '-t', '=mcbd-claude-wt:']);
  });
});

describe('which tools each behaviour applies to', () => {
  it('--live is claude and only claude', () => {
    expect(LIVE_ATTACH_TOOLS).toEqual(['claude']);
    expect(isLiveAttachSupported('claude')).toBe(true);
    for (const tool of CLI_TOOL_IDS.filter((t) => t !== 'claude')) {
      expect(isLiveAttachSupported(tool), tool).toBe(false);
    }
  });

  it('recognises a live-eligible session by its name alone', () => {
    expect(isLiveAttachEligibleSession(resolveSessionName('claude', 'wt'))).toBe(true);
    expect(isLiveAttachEligibleSession(resolveSessionName('claude', 'wt', 'claude-2'))).toBe(true);
    expect(isLiveAttachEligibleSession(resolveSessionName('codex', 'wt'))).toBe(false);
    expect(isLiveAttachEligibleSession('not-commandmates')).toBe(false);
  });

  it('the alt-screen list agrees with the detection layer, tool for tool', () => {
    // The list is duplicated because this module may not import lib/cli-tools
    // (the CLI bundle cannot afford that graph). This is what keeps them equal,
    // so a tool that moves in or out of the alternate screen breaks a test
    // rather than silently losing the `attach` hint.
    for (const tool of CLI_TOOL_IDS) {
      expect(usesAltScreen(tool), tool).toBe(usesAlternateScreen(tool as CLIToolType));
    }
    expect([...ALT_SCREEN_TOOLS].sort()).toEqual(['claude', 'copilot', 'opencode']);
  });
});

describe('hook bodies', () => {
  it('uses run-shell -b, never if-shell -F', () => {
    // Measured on tmux 3.5a: a hook body built from `if-shell -F` is accepted by
    // set-hook and then never fires, silently. `run-shell -b` fires.
    const args = buildInstallDelegateHookArgs(SESSION, '/home/u/x.sh')!;
    const body = args[args.length - 1];
    expect(body.startsWith('run-shell -b ')).toBe(true);
    expect(body).not.toContain('if-shell');
  });

  it('hands the session and the client mode to the script as separate words', () => {
    const body = buildHookRunShellBody('"/x.sh"', ATTACH_HOOK_FORMATS);
    expect(body).toBe(`run-shell -b '"/x.sh" #{session_name} #{client_control_mode} #{client_name}'`);
  });

  it('indexes the two attach hooks so neither replaces the other', () => {
    // A tmux hook name with no index IS [0]. Both features hang off
    // client-attached, so an unindexed pair would silently be one hook.
    expect(DELEGATE_HOOK).toBe('client-attached[0]');
    expect(AUTO_POPUP_HOOK).toBe('client-attached[1]');
    expect(DELEGATE_HOOK).not.toBe(AUTO_POPUP_HOOK);
  });

  it('double-quotes the script path, and refuses one it cannot represent', () => {
    // Single quotes are already spent on tmux's own lexer, whose strings do not
    // process escapes — a `'\''` would end the tmux string, not the shell one.
    expect(quoteScriptPathForHook('/home/a b/x.sh')).toBe('"/home/a b/x.sh"');
    for (const bad of ['/home/a"b/x.sh', '/home/a$b/x.sh', '/home/a`b/x.sh', '/home/a\nb/x.sh']) {
      expect(quoteScriptPathForHook(bad), bad).toBeUndefined();
    }
    expect(buildInstallDelegateHookArgs(SESSION, '/home/a"b/x.sh')).toBeUndefined();
    expect(buildInstallAutoPopupHookArgs(SESSION, '/home/a$b/x.sh')).toBeUndefined();
  });
});

describe('geometry hand-over and hand-back', () => {
  it('raises the flag BEFORE handing the size over', () => {
    // A poll landing between the two must see "delegated, still pinned" — which
    // suppresses one scrape too early — rather than "not delegated, 44 rows",
    // which saves a truncated reply.
    const [first, second] = buildDelegateGeometryCommands(SESSION);
    expect(first).toEqual(['set-option', '-t', '=mcbd-claude-wt:', '@cm_delegated', '1']);
    expect(second).toEqual([
      'set-window-option',
      '-t',
      '=mcbd-claude-wt:',
      'window-size',
      'latest',
    ]);
  });

  it('drops the flag LAST when handing the size back', () => {
    const commands = buildRestoreGeometryCommands(SESSION);
    expect(commands).toEqual([
      ['set-window-option', '-t', '=mcbd-claude-wt:', 'window-size', 'manual'],
      ['resize-window', '-t', '=mcbd-claude-wt:', '-x', '200', '-y', '1000'],
      ['set-option', '-u', '-t', '=mcbd-claude-wt:', '@cm_delegated'],
    ]);
  });

  it('restores to the #1163 canvas, read from the constants rather than retyped', () => {
    const resize = buildRestoreGeometryCommands(SESSION)[1];
    expect(resize).toContain(String(TUI_PANE_WIDTH));
    expect(resize).toContain(String(TUI_PANE_HEIGHT));
    expect(TUI_PANE_WIDTH).toBe(200);
    expect(TUI_PANE_HEIGHT).toBe(1000);
  });
});
