/**
 * codex's generated `hooks.json` and launch line (Issue #1760).
 *
 * Three of the failure modes this guards are silent on a real machine, which is
 * why the assertions are written against the live findings rather than against
 * what the generator happens to emit:
 *
 *  - a single `type:"http"` handler makes codex discard the **whole** file, so
 *    every event dies with one line on stderr the TUI never shows (#1757 §5.1.4);
 *  - the correlation keys live in the environment, not in the file, because one
 *    file serves every worktree and every instance — if the hook command lost
 *    the `$CM_AGENT_INSTANCE_ID` reference, `codex-2`'s events would be filed
 *    under `codex` and nothing would report an error;
 *  - the file is the operator's own, and it is the only place their codex hooks
 *    can live, so replacing rather than merging silently deletes a working
 *    configuration.
 *
 * The generated command strings are therefore also *executed*, through a real
 * `sh -c` with a fake relay and a fake `curl` on PATH. A string assertion alone
 * cannot tell a valid command from a quoting mistake, and this generator's
 * output is only ever run by a shell it does not control.
 *
 * @vitest-environment node
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { removeTempDir } from '@tests/helpers/temp-dir';
import {
  buildCodexEventHookCommand,
  buildCodexHookSettings,
  buildCodexLaunchCommand,
  buildCodexPermissionHookCommand,
  CODEX_HOOK_MARKER,
  CODEX_HOOK_TRUST_BYPASS_FLAG,
  CODEX_HOOK_TRUST_ENV_VAR,
  CODEX_INSTANCE_ID_ENV_VAR,
  CODEX_SESSION_END_TIMEOUT_SECONDS,
  CODEX_WORKTREE_ID_ENV_VAR,
  getCodexHooksPath,
  isCodexHookTrustBypassEnabled,
  mergeCodexHookSettings,
  writeCodexHookSettings,
  type CodexHookSettings,
} from '@/lib/hooks/sources/codex/hooks-config';

const TARGET = { worktreeId: 'wt-alpha', cliToolId: 'codex' } as const;
const TARGET_2 = { worktreeId: 'wt-alpha', cliToolId: 'codex', instanceId: 'codex-2' } as const;

/** Env keys this suite drives; saved and restored so order cannot leak. */
const MANAGED_ENV = [
  'CM_AGENT_HOOKS_INJECT',
  'CODEX_HOME',
  'CM_PORT',
  'MCBD_PORT',
  'CM_AUTH_TOKEN',
  'CM_AUTH_TOKEN_HASH',
  CODEX_HOOK_TRUST_ENV_VAR,
] as const;

let home: string;
let fakeBin: string;
let saved: Record<string, string | undefined>;

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'codex-home-'));
  fakeBin = mkdtempSync(join(tmpdir(), 'codex-hook-bin-'));

  // A `curl` that records its argv and replays a canned body on stdout, so the
  // permission hook's "the response body IS the verdict" contract is testable
  // without a server.
  const fakeCurl = join(fakeBin, 'curl');
  writeFileSync(
    fakeCurl,
    [
      '#!/usr/bin/env bash',
      'printf "%s\\n" "$@" > "$CURL_ARGS_FILE"',
      'cat > "$CURL_BODY_FILE"',
      'if [ -n "${FAKE_CURL_REPLY:-}" ]; then printf "%s" "$FAKE_CURL_REPLY"; fi',
      'exit "${FAKE_CURL_EXIT:-0}"',
      '',
    ].join('\n')
  );
  chmodSync(fakeCurl, 0o755);

  // A stand-in for scripts/hooks/cmate-agent-event.sh that records the argv the
  // generated command actually produced after the shell was done with it.
  const fakeRelay = join(fakeBin, 'relay with space.sh');
  writeFileSync(
    fakeRelay,
    ['#!/usr/bin/env bash', 'printf "%s\\n" "$@" > "$RELAY_ARGS_FILE"', 'cat > /dev/null', 'exit 0', ''].join(
      '\n'
    )
  );
  chmodSync(fakeRelay, 0o755);
});

afterAll(() => {
  removeTempDir(home);
  removeTempDir(fakeBin);
});

beforeEach(() => {
  saved = Object.fromEntries(MANAGED_ENV.map((key) => [key, process.env[key]]));
  for (const key of MANAGED_ENV) delete process.env[key];
  process.env.CODEX_HOME = home;
  rmSync(getCodexHooksPath(), { force: true });
});

afterEach(() => {
  for (const key of MANAGED_ENV) {
    const value = saved[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

/** Every handler in the settings, paired with the event it was registered for. */
function handlers(
  settings: CodexHookSettings
): Array<{ event: string; type: string; command: string; timeout: number }> {
  return Object.entries(settings.hooks).flatMap(([event, groups]) =>
    groups.flatMap((group) => group.hooks.map((hook) => ({ event, ...hook })))
  );
}

/** Run one generated command through a real shell, with the fakes on PATH. */
function runCommand(
  command: string,
  env: Record<string, string> = {}
): { status: number | null; stdout: string; relayArgs: string[] | null; curlArgs: string[] | null } {
  const relayArgsFile = join(fakeBin, 'relay-args.txt');
  const curlArgsFile = join(fakeBin, 'curl-args.txt');
  const curlBodyFile = join(fakeBin, 'curl-body.txt');
  for (const file of [relayArgsFile, curlArgsFile, curlBodyFile]) {
    writeFileSync(file, '');
  }
  const result = spawnSync('sh', ['-c', command], {
    encoding: 'utf8',
    input: '{"hook_event_name":"Stop","session_id":"s-1","cwd":"/tmp"}',
    env: {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
      RELAY_ARGS_FILE: relayArgsFile,
      CURL_ARGS_FILE: curlArgsFile,
      CURL_BODY_FILE: curlBodyFile,
      ...env,
    },
  });
  const read = (file: string): string[] | null => {
    const text = readFileSync(file, 'utf8');
    return text === '' ? null : text.split('\n').slice(0, -1);
  };
  return {
    status: result.status,
    stdout: result.stdout,
    relayArgs: read(relayArgsFile),
    curlArgs: read(curlArgsFile),
  };
}

describe('the generated hooks.json', () => {
  it('registers only `type: "command"` handlers', () => {
    // The single most destructive thing this generator could emit: one `http`
    // handler and codex throws the entire file away, taking the command hooks
    // with it (#1757 §5.1.4).
    const emitted = handlers(buildCodexHookSettings());
    expect(emitted.length).toBeGreaterThan(0);
    for (const handler of emitted) {
      expect(handler.type).toBe('command');
    }
    expect(JSON.stringify(buildCodexHookSettings())).not.toContain('"http"');
  });

  it('registers the four lifecycle events plus PermissionRequest, and no Notification', () => {
    expect(Object.keys(buildCodexHookSettings().hooks).sort()).toEqual([
      'PermissionRequest',
      'SessionEnd',
      'SessionStart',
      'Stop',
      'UserPromptSubmit',
    ]);
  });

  it('keeps SessionEnd inside the 3s codex clamps it to', () => {
    // Above 3 codex prints `⚠ clamping SessionEnd hook timeout to 3s` over
    // every session, for a value it was going to ignore.
    const sessionEnd = handlers(buildCodexHookSettings()).find((h) => h.event === 'SessionEnd');
    expect(sessionEnd!.timeout).toBe(CODEX_SESSION_END_TIMEOUT_SECONDS);
    expect(CODEX_SESSION_END_TIMEOUT_SECONDS).toBe(3);
  });

  it('carries the correlation keys as environment references, not as literals', () => {
    // One file serves every worktree and instance, so a baked-in id would be
    // whichever session wrote last. Every handler's keys therefore come from
    // the environment: the event hooks read them directly, and the permission
    // hook reads the receiver URL the launch line already put them into.
    const emitted = handlers(buildCodexHookSettings({ port: 4321 }));
    const events = emitted.filter((handler) => handler.event !== 'PermissionRequest');
    expect(events).toHaveLength(4);
    for (const handler of events) {
      expect(handler.command).toContain(`$${CODEX_WORKTREE_ID_ENV_VAR}`);
      expect(handler.command).toContain(`$${CODEX_INSTANCE_ID_ENV_VAR}`);
    }
    const permission = emitted.find((handler) => handler.event === 'PermissionRequest')!;
    expect(permission.command).toContain('${CM_PERMISSION_HOOK_URL:-');

    // And nothing anywhere names a worktree, an instance or the port of the
    // server that happened to write the file.
    for (const handler of emitted) {
      expect(handler.command).not.toContain('4321');
      expect(handler.command).not.toContain('wt-');
    }
  });

  it('produces the same bytes for two different instances', () => {
    // Trust is keyed by the hash of the handler: a file that varies per session
    // would put codex's review dialog in front of every launch, forever.
    expect(JSON.stringify(buildCodexHookSettings())).toBe(JSON.stringify(buildCodexHookSettings()));
  });

  it('marks every handler as this server’s', () => {
    for (const handler of handlers(buildCodexHookSettings())) {
      expect(handler.command).toContain(CODEX_HOOK_MARKER);
    }
  });
});

describe('the generated commands, run through a real shell', () => {
  it('hands the relay the correlation keys the environment carries', () => {
    const command = buildCodexEventHookCommand('stop', {
      relayScriptPath: join(fakeBin, 'relay with space.sh'),
    });
    const run = runCommand(command, {
      [CODEX_WORKTREE_ID_ENV_VAR]: 'wt-alpha',
      [CODEX_INSTANCE_ID_ENV_VAR]: 'codex-2',
    });
    expect(run.status).toBe(0);
    expect(run.relayArgs).toEqual([
      '--tool',
      'codex',
      '--event',
      'stop',
      '--worktree-id',
      'wt-alpha',
      '--instance-id',
      'codex-2',
      '--stdin-json',
    ]);
  });

  it('passes an empty correlation key rather than dropping the argument', () => {
    // A manually launched codex has none of these set. The relay treats an
    // empty value as absent and falls back to `cwd`; a *missing* argument would
    // make it consume `--instance-id` as the worktree id instead.
    const command = buildCodexEventHookCommand('stop', {
      relayScriptPath: join(fakeBin, 'relay with space.sh'),
    });
    const run = runCommand(command);
    expect(run.status).toBe(0);
    expect(run.relayArgs).toEqual([
      '--tool',
      'codex',
      '--event',
      'stop',
      '--worktree-id',
      '',
      '--instance-id',
      '',
      '--stdin-json',
    ]);
  });

  it('falls back to an inline curl when the relay is not on disk', () => {
    const command = buildCodexEventHookCommand('session_start', { relayScriptPath: null });
    const run = runCommand(command, {
      CM_HOOK_URL: 'http://127.0.0.1:4321/api/hooks/agent-event',
      [CODEX_WORKTREE_ID_ENV_VAR]: 'wt-alpha',
      [CODEX_INSTANCE_ID_ENV_VAR]: 'codex-2',
    });
    expect(run.status).toBe(0);
    expect(run.curlArgs).toContain(
      'http://127.0.0.1:4321/api/hooks/agent-event?tool=codex&worktreeId=wt-alpha&instanceId=codex-2'
    );
  });

  it('omits the correlation query entirely when the environment has none', () => {
    const command = buildCodexEventHookCommand('session_start', { relayScriptPath: null });
    const run = runCommand(command, { CM_HOOK_URL: 'http://127.0.0.1:4321/api/hooks/agent-event' });
    expect(run.curlArgs).toContain('http://127.0.0.1:4321/api/hooks/agent-event?tool=codex');
  });

  it('writes the receiver’s reply to stdout, which is where codex reads the verdict', () => {
    const allow =
      '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}';
    const run = runCommand(buildCodexPermissionHookCommand(), {
      CM_PERMISSION_HOOK_URL: 'http://127.0.0.1:4321/api/hooks/permission-request?tool=codex',
      FAKE_CURL_REPLY: allow,
    });
    expect(run.status).toBe(0);
    expect(run.stdout).toBe(allow);
    expect(run.curlArgs).toContain(
      'http://127.0.0.1:4321/api/hooks/permission-request?tool=codex'
    );
  });

  it('prints nothing and still exits 0 when the receiver is gone', () => {
    // Fail-open: no output is exactly what codex sees with no hook installed,
    // and it draws the ordinary approval dialog. A non-zero exit would be the
    // agent's problem instead of the server's.
    const run = runCommand(buildCodexPermissionHookCommand(), {
      CM_PERMISSION_HOOK_URL: 'http://127.0.0.1:4321/api/hooks/permission-request',
      FAKE_CURL_EXIT: '7',
      FAKE_CURL_REPLY: '',
    });
    expect(run.status).toBe(0);
    expect(run.stdout).toBe('');
  });

  it('sends the bearer header only when the server expects one', () => {
    expect(buildCodexPermissionHookCommand({ withAuthHeader: false })).not.toContain('Authorization');
    expect(buildCodexPermissionHookCommand({ withAuthHeader: true })).toContain(
      'Authorization: Bearer $CM_AUTH_TOKEN'
    );
  });
});

describe('writing into the operator’s file', () => {
  it('creates the file under $CODEX_HOME, readable only by its owner', () => {
    const path = writeCodexHookSettings();
    expect(path).toBe(join(home, 'hooks.json'));
    expect(statSync(path!).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(path!, 'utf8')).hooks.Stop).toHaveLength(1);
  });

  it('keeps the operator’s own hooks and adds ours beside them', () => {
    // Their file is the only place codex will read their hooks from; there is
    // no second file to move them to.
    writeFileSync(
      join(home, 'hooks.json'),
      JSON.stringify({
        $schema: 'https://example.test/codex-hooks.json',
        hooks: {
          Stop: [{ hooks: [{ type: 'command', command: '/usr/local/bin/mine.sh', timeout: 9 }] }],
          PreCompact: [{ hooks: [{ type: 'command', command: '/usr/local/bin/compact.sh' }] }],
        },
      })
    );

    const merged = JSON.parse(readFileSync(writeCodexHookSettings()!, 'utf8'));
    expect(merged.$schema).toBe('https://example.test/codex-hooks.json');
    expect(merged.hooks.PreCompact[0].hooks[0].command).toBe('/usr/local/bin/compact.sh');
    expect(merged.hooks.Stop[0].hooks[0].command).toBe('/usr/local/bin/mine.sh');
    expect(merged.hooks.Stop).toHaveLength(2);
    expect(merged.hooks.Stop[1].hooks[0].command).toContain(CODEX_HOOK_MARKER);
  });

  it('replaces its own previous handler instead of stacking a second one', () => {
    writeCodexHookSettings();
    writeCodexHookSettings({ port: 4321 });
    const merged = JSON.parse(readFileSync(join(home, 'hooks.json'), 'utf8'));
    for (const groups of Object.values(merged.hooks) as Array<Array<{ hooks: unknown[] }>>) {
      expect(groups).toHaveLength(1);
    }
  });

  it('does not touch the file when the content already matches', () => {
    // Rewriting would change nothing but the mtime — and on a machine where the
    // human has trusted these hooks, an unnecessary write is a chance to get
    // the bytes wrong and send them back to the review dialog.
    const path = writeCodexHookSettings()!;
    const before = statSync(path).mtimeMs;
    writeFileSync(join(home, 'marker'), 'x');
    expect(writeCodexHookSettings()).toBe(path);
    expect(statSync(path).mtimeMs).toBe(before);
  });

  it('refuses to overwrite a file it cannot parse', () => {
    writeFileSync(join(home, 'hooks.json'), '{ this is not json');
    expect(writeCodexHookSettings()).toBeNull();
    expect(readFileSync(join(home, 'hooks.json'), 'utf8')).toBe('{ this is not json');
  });

  it('leaves an event whose shape it does not understand exactly as found', () => {
    const merged = mergeCodexHookSettings({ hooks: { Stop: 'not-an-array' } }, buildCodexHookSettings());
    expect((merged.hooks as Record<string, unknown>).Stop).toBe('not-an-array');
    // …and the events it does understand still get their handler.
    expect((merged.hooks as Record<string, unknown[]>).SessionStart).toHaveLength(1);
  });
});

describe('the launch command', () => {
  it('carries the worktree, the instance and both receiver URLs', () => {
    const command = buildCodexLaunchCommand('codex', TARGET_2, { port: 4321 });
    expect(command).toContain(`${CODEX_WORKTREE_ID_ENV_VAR}='wt-alpha'`);
    expect(command).toContain(`${CODEX_INSTANCE_ID_ENV_VAR}='codex-2'`);
    expect(command).toContain("CM_HOOK_URL='http://127.0.0.1:4321/api/hooks/agent-event'");
    expect(command).toContain(
      "CM_PERMISSION_HOOK_URL='http://127.0.0.1:4321/api/hooks/permission-request" +
        "?tool=codex&worktreeId=wt-alpha&instanceId=codex-2'"
    );
    expect(command.endsWith("'codex'")).toBe(true);
  });

  it('pins the codex home the config was written to', () => {
    // Measured live: a tmux session inherits the *tmux server's* environment,
    // so a CommandMate server started with `CODEX_HOME=…` wrote its hooks
    // there while the codex it launched read `~/.codex` and found none —
    // zero events, no error anywhere. The launch line names the directory so
    // the two cannot diverge.
    const command = buildCodexLaunchCommand('codex', TARGET, { codexHome: home });
    expect(command).toContain(`CODEX_HOME='${home}'`);
    expect(readFileSync(join(home, 'hooks.json'), 'utf8')).toContain(CODEX_HOOK_MARKER);
  });

  it('defaults to the primary instance', () => {
    expect(buildCodexLaunchCommand('codex', TARGET, { port: 4321 })).toContain(
      `${CODEX_INSTANCE_ID_ENV_VAR}='codex'`
    );
  });

  it('gives two instances of one worktree different keys', () => {
    // The measurement this Issue's acceptance turns on: `cwd` is identical for
    // both, so if these two lines matched, `codex-2`'s stop would end the wait
    // on `codex`.
    const first = buildCodexLaunchCommand('codex', TARGET, { port: 4321 });
    const second = buildCodexLaunchCommand('codex', TARGET_2, { port: 4321 });
    expect(first).not.toBe(second);
    expect(first).toContain("CM_AGENT_INSTANCE_ID='codex'");
    expect(second).toContain("CM_AGENT_INSTANCE_ID='codex-2'");
  });

  it('is byte-identical to the pre-#1760 launch when injection is off', () => {
    process.env.CM_AGENT_HOOKS_INJECT = '0';
    expect(buildCodexLaunchCommand('codex', TARGET_2)).toBe('codex');
    expect(existsSync(join(home, 'hooks.json'))).toBe(false);
  });

  it('does not pass the trust bypass unless an operator asked for it', () => {
    // The flag disables review for every hook the invocation can see, including
    // a `.codex/hooks.json` committed to the repository being worked on.
    expect(isCodexHookTrustBypassEnabled()).toBe(false);
    expect(buildCodexLaunchCommand('codex', TARGET)).not.toContain(CODEX_HOOK_TRUST_BYPASS_FLAG);

    process.env[CODEX_HOOK_TRUST_ENV_VAR] = 'bypass';
    expect(isCodexHookTrustBypassEnabled()).toBe(true);
    expect(buildCodexLaunchCommand('codex', TARGET)).toContain(CODEX_HOOK_TRUST_BYPASS_FLAG);

    process.env[CODEX_HOOK_TRUST_ENV_VAR] = '1';
    expect(buildCodexLaunchCommand('codex', TARGET)).not.toContain(CODEX_HOOK_TRUST_BYPASS_FLAG);
  });

  it('falls back to the bare command when the ids could not be used', () => {
    expect(buildCodexLaunchCommand('codex', { worktreeId: '../etc', cliToolId: 'codex' })).toBe(
      'codex'
    );
    expect(
      buildCodexLaunchCommand('codex', { worktreeId: 'wt-alpha', cliToolId: 'codex', instanceId: 'a b' })
    ).toBe('codex');
  });

  it('falls back to the bare command when the file cannot be written', () => {
    // A launch is not worth failing over a config file. `$CODEX_HOME` pointed at
    // a regular file makes the directory creation fail.
    const blocked = join(home, 'blocked');
    writeFileSync(blocked, 'not a directory');
    expect(buildCodexLaunchCommand('codex', TARGET, { codexHome: join(blocked, 'inner') })).toBe(
      'codex'
    );
  });
});
