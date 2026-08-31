/**
 * The shared CLI command-reference module (Issue #2120).
 *
 * Two things are pinned here that nothing else can pin:
 *
 *   1. the binary name follows `CM_LAUNCHED_BY`. It is the same rule the
 *      assistant context reads (`buildAssistantStartupSnapshot`) and the same
 *      rule the roster pane renders, and the whole reason the function moved out
 *      of `context-builder.ts` was so those two cannot drift apart.
 *   2. the four commands are built from the values handed in. The GUI gets the
 *      instance id from `GET /api/worktrees/:id/resolve-target`; this function
 *      must not have an opinion of its own about what the target is.
 */

import { describe, it, expect } from 'vitest';
import {
  buildInstanceCliCommands,
  resolveCommandMateBinary,
  COMMANDMATE_GLOBAL_BINARY,
  COMMANDMATE_DEV_BINARY,
  DEFAULT_SERVER_PORT,
  INSTANCE_CLI_COMMAND_IDS,
} from '@/lib/cli/command-reference';

describe('[#2120] resolveCommandMateBinary', () => {
  it('is `commandmate` when the server was launched by the installed CLI', () => {
    expect(resolveCommandMateBinary({ CM_LAUNCHED_BY: 'commandmate-cli' })).toBe(
      COMMANDMATE_GLOBAL_BINARY,
    );
  });

  it('is `commandmatedev` for a checkout, where CM_LAUNCHED_BY is absent', () => {
    expect(resolveCommandMateBinary({})).toBe(COMMANDMATE_DEV_BINARY);
  });

  it('is `commandmatedev` for any other value of the marker', () => {
    // `commandmate start` writes exactly one string. Anything else is not the
    // installed CLI, and guessing `commandmate` would print a command that is
    // not on the operator's PATH.
    expect(resolveCommandMateBinary({ CM_LAUNCHED_BY: 'systemd' })).toBe(COMMANDMATE_DEV_BINARY);
  });
});

describe('[#2120] buildInstanceCliCommands', () => {
  const base = {
    binary: COMMANDMATE_DEV_BINARY,
    worktreeId: 'wt-1',
    instanceId: 'codex-2',
    messagePlaceholder: 'メッセージ',
  };

  it('builds the four session-targeting commands', () => {
    expect(buildInstanceCliCommands(base)).toEqual({
      send: 'commandmatedev send wt-1 "メッセージ" --instance codex-2',
      wait: 'commandmatedev wait wt-1 --instance codex-2 --on-prompt human',
      capture: 'commandmatedev capture wt-1 --instance codex-2',
      respond: 'commandmatedev respond wt-1 "1" --instance codex-2',
    });
  });

  it('covers exactly the advertised command ids', () => {
    expect(Object.keys(buildInstanceCliCommands(base)).sort()).toEqual(
      [...INSTANCE_CLI_COMMAND_IDS].sort(),
    );
  });

  it('spells every command with the binary it was given', () => {
    const commands = buildInstanceCliCommands({ ...base, binary: COMMANDMATE_GLOBAL_BINARY });
    for (const command of Object.values(commands)) {
      expect(command.startsWith('commandmate ')).toBe(true);
    }
  });

  it('names the instance it was given and never derives one', () => {
    const commands = buildInstanceCliCommands({ ...base, instanceId: 'claude' });
    for (const command of Object.values(commands)) {
      expect(command).toContain('--instance claude');
    }
  });

  it('answers `respond` with a NUMBER, not `yes`', () => {
    // `respond` types its argument and presses Enter without interpreting it,
    // so `yes` on a multiple-choice dialog selects the default option instead
    // of the one the operator meant.
    const { respond } = buildInstanceCliCommands(base);
    expect(respond).toContain('"1"');
    expect(respond).not.toContain('yes');
  });

  it('keeps `--on-prompt human` on wait and nowhere else', () => {
    const commands = buildInstanceCliCommands(base);
    expect(commands.wait).toContain('--on-prompt human');
    expect(commands.send).not.toContain('--on-prompt');
    expect(commands.capture).not.toContain('--on-prompt');
    expect(commands.respond).not.toContain('--on-prompt');
  });

  it('never emits a --port flag: these commands do not define one', () => {
    const commands = buildInstanceCliCommands({ ...base, portPrefix: 3135 });
    for (const command of Object.values(commands)) {
      expect(command).not.toContain('--port');
    }
  });

  it('prefixes CM_PORT= when the server is not on the default port', () => {
    const commands = buildInstanceCliCommands({ ...base, portPrefix: 3135 });
    for (const command of Object.values(commands)) {
      expect(command.startsWith('CM_PORT=3135 commandmatedev ')).toBe(true);
    }
  });

  it('omits the prefix on the default port and when no port is given', () => {
    expect(buildInstanceCliCommands({ ...base, portPrefix: DEFAULT_SERVER_PORT }).send).toBe(
      buildInstanceCliCommands(base).send,
    );
    expect(buildInstanceCliCommands({ ...base, portPrefix: null }).send).toBe(
      buildInstanceCliCommands(base).send,
    );
  });

  it('keeps the message body a placeholder, quoted', () => {
    const { send } = buildInstanceCliCommands({ ...base, messagePlaceholder: 'message' });
    expect(send).toContain('"message"');
  });
});
