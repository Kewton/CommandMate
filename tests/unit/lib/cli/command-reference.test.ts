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
  buildDelegationBrief,
  buildInstanceCliCommands,
  DELEGATION_ASK_TIMEOUT_SECONDS,
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


/**
 * The delegation brief (Issue #2376).
 *
 * The brief is a PROMPT: another agent reads it and acts on it, so what is
 * pinned is not its prose but the four things that change behaviour if they go
 * missing — the resolved target in the `ask` line, the exit-code branch, the
 * "do not answer their prompt" clause, and the absence of any suggestion to
 * touch the other session's Auto-Yes.
 */
describe('[#2376] buildDelegationBrief', () => {
  const base = {
    binary: COMMANDMATE_DEV_BINARY,
    worktreeId: 'anvil-develop',
    instanceId: 'codex-2',
    instanceLabel: 'Codex 2',
    toolLabel: 'Codex',
    locale: 'ja',
  };

  it.each(['ja', 'en'])('names the resolved target in the ask line (%s)', (locale) => {
    const brief = buildDelegationBrief({ ...base, locale });
    expect(brief).toContain(
      `${COMMANDMATE_DEV_BINARY} ask anvil-develop --instance codex-2`,
    );
    expect(brief).toContain(`--timeout ${DELEGATION_ASK_TIMEOUT_SECONDS}`);
  });

  it.each(['ja', 'en'])('branches on the exit codes wait actually returns (%s)', (locale) => {
    const brief = buildDelegationBrief({ ...base, locale });
    expect(brief).toContain('exit 0');
    expect(brief).toContain('exit 10');
    expect(brief).toContain('exit 124');
  });

  it.each(['ja', 'en'])('tells the reader to report a prompt, not answer it (%s)', (locale) => {
    const brief = buildDelegationBrief({ ...base, locale });
    // The clause this whole feature exists to carry: `respond` does not resolve
    // an answer semantically (#1681), so answering somebody else's dialog picks
    // whatever was highlighted.
    expect(brief).toContain('respond');
    expect(brief).toContain('auto-yes');
  });

  it('never suggests enabling auto-yes', () => {
    for (const locale of ['ja', 'en']) {
      const brief = buildDelegationBrief({ ...base, locale });
      expect(brief).not.toMatch(/--auto-yes/);
    }
  });

  it('writes Japanese for ja and English for anything else', () => {
    expect(buildDelegationBrief({ ...base, locale: 'ja' })).toContain('への委任');
    expect(buildDelegationBrief({ ...base, locale: 'en' })).toContain('Delegating to session');
    // An unknown locale is English, not a blank brief.
    expect(buildDelegationBrief({ ...base, locale: 'fr' })).toContain('Delegating to session');
  });

  it('carries the alias so the reader knows which session is meant', () => {
    const brief = buildDelegationBrief({ ...base, locale: 'ja' });
    expect(brief).toContain('Codex 2');
    expect(brief).toContain('Codex');
  });

  it('prefixes CM_PORT= on a non-default port, on every command line', () => {
    const brief = buildDelegationBrief({ ...base, portPrefix: 3135, locale: 'en' });
    expect(brief).toContain(`CM_PORT=3135 ${COMMANDMATE_DEV_BINARY} ask `);
    expect(brief).toContain(`CM_PORT=3135 ${COMMANDMATE_DEV_BINARY} capture `);
  });

  it('omits the prefix on the default port', () => {
    expect(buildDelegationBrief({ ...base, portPrefix: DEFAULT_SERVER_PORT, locale: 'en' }))
      .toBe(buildDelegationBrief({ ...base, locale: 'en' }));
  });

  it('offers a progress check that reads without interfering', () => {
    const brief = buildDelegationBrief({ ...base, locale: 'en' });
    expect(brief).toContain('capture anvil-develop --instance codex-2 --pane --tail 60');
  });
});
