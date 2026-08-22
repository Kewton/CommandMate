/**
 * The three ways copilot's hook configuration was brittle, and what each one
 * now does instead (Issue #1904, 設計方針書 §10.8 / §10.9, 受入条件 S7 / S16).
 *
 * All three come from the same root: `~/.copilot/settings.json` is **one file
 * for the whole machine**, written by whichever CommandMate server started a
 * copilot session last.
 *
 *  1. **`config.json` erases it.** copilot 1.0.80 migrates a `hooks` key out of
 *     `config.json` and *over* `settings.json` at startup — measured with a
 *     marker hook in both files: only the `config.json` ones fired, and the
 *     `settings.json` read back afterwards held six `config.json` entries and
 *     none of ours. `copilot help config` still documents `hooks` as a
 *     `config.json` key, so an operator following the published documentation
 *     loses events and Auto-Yes with no error anywhere.
 *  2. **The last server to start wins.** Port and relay path were baked in at
 *     write time, so a development server on 3011 pointed every copilot session
 *     on the machine at 3011, and a removed checkout took the relay with it.
 *  3. **A 4xx body was the verdict.** `out=$(curl …)` had no `-f`, so
 *     `{"error":"cwd rejected: …"}` was printed to stdout and copilot read the
 *     receiver's error message as its answer.
 *
 * The last `describe` runs the generated commands in a real `/bin/sh` against a
 * real loopback server. String pins alone cannot tell a guard that works from a
 * guard that is spelled wrong — `[!0-9]` in the wrong shell, an `&` outside its
 * quotes, a `$?` read one command too late.
 *
 * `COPILOT_HOME` is redirected into a temp directory for the whole suite, so
 * nothing here can reach the developer's `~/.copilot`.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'child_process';
import { createServer, type Server } from 'http';
import { tmpdir } from 'os';
import { join } from 'path';
import { removeTempDir } from '@tests/helpers/temp-dir';
import { COMMANDMATE_HOOK_ENV_VARS, renderAgentLaunchCommand } from '@/lib/hooks/sources';

import { REAL_SHELL_SUBPROCESS_TIMEOUT_MS } from '@tests/helpers/real-shell-budget';

// Real fs, wrapped: `writeFileSync` and `renameSync` are the two calls S16 is
// about, and the difference between them is invisible in the file afterwards.
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    default: actual,
    writeFileSync: vi.fn(actual.writeFileSync),
    renameSync: vi.fn(actual.renameSync),
  };
});

const {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  utimesSync,
  writeFileSync,
} = await import('fs');

const {
  buildCopilotEventCommand,
  buildCopilotHookSettings,
  buildCopilotLaunchCommand,
  buildCopilotPermissionCommand,
  COPILOT_HOOK_MARKER,
  COPILOT_HOOK_PORT_ENV,
  COPILOT_LAUNCH_COMMAND,
  COPILOT_SETTINGS_BACKUP_SUFFIX,
  COPILOT_SETTINGS_LOCK_BASENAME,
  COPILOT_SETTINGS_LOCK_STALE_MS,
  CopilotConfigHooksShadowError,
  getCopilotConfigPath,
  getCopilotSettingsPath,
  inspectCopilotConfigHooks,
  writeCopilotHookSettings,
} = await import('@/lib/hooks/sources/copilot/hook-settings');

const TARGET = { worktreeId: 'wt-1', cliToolId: 'copilot', instanceId: 'copilot-2' } as const;
const OPTIONS = { port: 3999, relayScriptPath: '/pkg/scripts/hooks/cmate-agent-event.sh' };

/** Every command CommandMate writes into the file, in one flat list. */
function generatedCommands(options = OPTIONS): string[] {
  const { hooks } = buildCopilotHookSettings(options);
  return Object.values(hooks).flatMap((groups) => groups.flatMap((g) => g.hooks.map((h) => h.command)));
}

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'cmate-copilot-1904-'));
  process.env.COPILOT_HOME = home;
  delete process.env.CM_AGENT_HOOKS_INJECT;
  vi.mocked(writeFileSync).mockClear();
  vi.mocked(renameSync).mockClear();
});

afterEach(() => {
  delete process.env.COPILOT_HOME;
  delete process.env.CM_AGENT_HOOKS_INJECT;
  removeTempDir(home);
});

// ===========================================================================
// 1. config.json shadows settings.json
// ===========================================================================

describe('config.json, which copilot migrates over settings.json', () => {
  it('reads copilot’s own file even though it is not JSON', () => {
    // Verbatim from the machine this Issue was filed on: copilot stamps two
    // comment lines onto the file it manages, so `JSON.parse` throws at
    // character 0. A detector that gave up there would never see the key it
    // exists to find.
    writeFileSync(
      getCopilotConfigPath(),
      '// User settings belong in settings.json.\n' +
        '// This file is managed automatically.\n' +
        '{\n  "trustedFolders": ["/repo"],\n  "hooks": { "Stop": [] , "SessionStart": [{}] }\n}\n'
    );

    expect(inspectCopilotConfigHooks(getCopilotConfigPath())).toBe('present');
  });

  it('does not mistake a URL inside a string for a comment', () => {
    writeFileSync(
      getCopilotConfigPath(),
      JSON.stringify({ endpoint: 'https://example.com//x', hooks: { Stop: [{}] } })
    );

    expect(inspectCopilotConfigHooks(getCopilotConfigPath())).toBe('present');
  });

  it('calls a missing file, an absent key and an empty block all “absent”', () => {
    expect(inspectCopilotConfigHooks(getCopilotConfigPath())).toBe('absent');

    writeFileSync(getCopilotConfigPath(), JSON.stringify({ trustedFolders: ['/repo'] }));
    expect(inspectCopilotConfigHooks(getCopilotConfigPath())).toBe('absent');

    writeFileSync(getCopilotConfigPath(), JSON.stringify({ hooks: {} }));
    expect(inspectCopilotConfigHooks(getCopilotConfigPath())).toBe('absent');
  });

  it('refuses to write a settings file copilot is about to overwrite', () => {
    writeFileSync(getCopilotConfigPath(), JSON.stringify({ hooks: { Stop: [{}] } }));

    expect(() => writeCopilotHookSettings(OPTIONS)).toThrow(CopilotConfigHooksShadowError);
    // Nothing written: injecting here buys an entry copilot deletes at startup,
    // and touching the user's settings.json for it is a real cost for none.
    expect(existsSync(getCopilotSettingsPath())).toBe(false);
  });

  it('starts copilot bare rather than injecting into a file that will be erased', () => {
    writeFileSync(getCopilotConfigPath(), JSON.stringify({ hooks: { Stop: [{}] } }));

    const plan = buildCopilotLaunchCommand(COPILOT_LAUNCH_COMMAND, TARGET, OPTIONS);

    expect(plan.command).toBe('gh copilot');
    expect(plan.settingsPath).toBeNull();
    expect(plan.env).toEqual({});
  });

  it('injects again as soon as the key is gone', () => {
    // Self-healing on purpose: copilot's own migration removes the key, so the
    // refusal above lasts exactly one launch.
    writeFileSync(getCopilotConfigPath(), JSON.stringify({ hooks: { Stop: [{}] } }));
    expect(buildCopilotLaunchCommand(COPILOT_LAUNCH_COMMAND, TARGET, OPTIONS).settingsPath).toBeNull();

    writeFileSync(getCopilotConfigPath(), '// This file is managed automatically.\n{}\n');
    expect(buildCopilotLaunchCommand(COPILOT_LAUNCH_COMMAND, TARGET, OPTIONS).settingsPath).toBe(
      getCopilotSettingsPath()
    );
  });

  it('still injects when config.json is a shape nobody has measured', () => {
    // Fail-open. An unparseable file is not evidence that a migration is
    // coming, and disabling hooks on it would be permanent.
    writeFileSync(getCopilotConfigPath(), '{ this is not json');

    expect(inspectCopilotConfigHooks(getCopilotConfigPath())).toBe('unreadable');
    expect(writeCopilotHookSettings(OPTIONS)).toBe(getCopilotSettingsPath());
  });
});

// ===========================================================================
// 2. the file no longer names one server (S7)
// ===========================================================================

describe('what the machine-global file is allowed to fix (S7)', () => {
  it('takes the port from the environment, behind a numeric guard', () => {
    for (const command of generatedCommands()) {
      expect(command).toContain(`case "$${COPILOT_HOOK_PORT_ENV}" in ''|*[!0-9]*)`);
      expect(command).toContain(`'http://127.0.0.1:'"$${COPILOT_HOOK_PORT_ENV}"'`);
    }
  });

  it('never spells the port with a default to fall back to', () => {
    // `"${CM_HOOK_PORT:-3000}"` would send the payload — and the bearer header
    // — somewhere else in silence on every path that forgot to set it. Not
    // firing is the safe answer (§10.8 決定 3).
    for (const command of generatedCommands()) {
      expect(command).not.toContain(`\${${COPILOT_HOOK_PORT_ENV}:-`);
      expect(command).not.toContain(`\${${COPILOT_HOOK_PORT_ENV}-`);
    }
  });

  it('keeps scheme, host and relay path as literals rather than variables', () => {
    // These decide *where the bearer token goes* and *which program runs*.
    // `curlArgumentPreamble` attaches the Authorization header without looking
    // at the destination, so a constant host is what keeps it on loopback
    // (§10.7); an env-supplied script path would be delegated code execution
    // (§10.8 決定 2).
    for (const command of generatedCommands()) {
      expect(command).toContain(`'http://127.0.0.1:'`);
      expect(command).not.toMatch(/https?:\/\/[^']*\$/);
      expect(command).not.toContain('CM_HOOK_URL');
      expect(command).not.toContain('CM_HOOK_HOST');
      expect(command).not.toContain('CM_HOOK_PATH');
      expect(command).not.toContain('CM_HOOK_RELAY');
    }
    expect(buildCopilotEventCommand('stop', OPTIONS)).toContain(
      `[ -x '${OPTIONS.relayScriptPath}' ]`
    );
  });

  it('writes the same bytes whichever server is running', () => {
    // The whole point. Two servers, two ports, one file: before #1904 the
    // second launch rewrote the first server's sessions onto its own port.
    writeCopilotHookSettings({ ...OPTIONS, port: 3000 });
    const first = readFileSync(getCopilotSettingsPath(), 'utf8');

    writeCopilotHookSettings({ ...OPTIONS, port: 3011 });

    expect(readFileSync(getCopilotSettingsPath(), 'utf8')).toBe(first);
    expect(first).not.toContain(':3000/');
    expect(first).not.toContain(':3011/');
  });

  it('puts the port on the launch line instead, once per session (S8)', () => {
    const plan = buildCopilotLaunchCommand(COPILOT_LAUNCH_COMMAND, TARGET, { ...OPTIONS, port: 3011 });

    expect(plan.env[COPILOT_HOOK_PORT_ENV]).toBe('3011');
    expect(renderAgentLaunchCommand(plan)).toContain(`${COPILOT_HOOK_PORT_ENV}='3011'`);
    // The one list a sanitizer and this pin can share, so neither drifts.
    expect(COMMANDMATE_HOOK_ENV_VARS).toContain(COPILOT_HOOK_PORT_ENV);
  });

  it('decides at fire time whether the relay is still there', () => {
    // A worktree's checkout is removed and its server's absolute path stays in
    // the machine-global file. Before #1904 every copilot session on the
    // machine then lost every event; now the `[ -x … ]` misses and the inline
    // curl — the branch already written for a package with no relay — runs.
    const command = buildCopilotEventCommand('stop', OPTIONS);

    expect(command).toContain(`if [ -x '${OPTIONS.relayScriptPath}' ]; then`);
    expect(command).toContain('; exit 0; fi; ');
    expect(command).toContain('curl "$@" --data-binary @-');
  });
});

// ===========================================================================
// 3. a 4xx is not a verdict
// ===========================================================================

describe('what a failed POST is allowed to say', () => {
  it('makes curl fail on a 4xx instead of printing its body', () => {
    expect(buildCopilotPermissionCommand(OPTIONS)).toContain('set -- -fsS -m 4 -X POST');
    expect(buildCopilotEventCommand('stop', { ...OPTIONS, relayScriptPath: null })).toContain(
      'set -- -fsS -m 4 -X POST'
    );
  });

  it('answers no-decision and says why, rather than either in silence', () => {
    const command = buildCopilotPermissionCommand(OPTIONS);

    expect(command).toContain(`out=''`);
    expect(command).toContain(`[ -n "$out" ] || out='{}'`);
    expect(command).toContain(
      `printf '%s\\n' "${COPILOT_HOOK_MARKER}: permission_request_failed rc=$rc" >&2`
    );
  });

  it('does not swallow a failed event POST either', () => {
    const command = buildCopilotEventCommand('stop', { ...OPTIONS, relayScriptPath: null });

    expect(command).not.toContain('|| true');
    expect(command).toContain(
      `printf '%s\\n' "${COPILOT_HOOK_MARKER}: agent_event_post_failed rc=$rc" >&2`
    );
  });
});

// ===========================================================================
// 4. writing somebody else's file (S16)
// ===========================================================================

describe('how the user’s settings.json is replaced (S16)', () => {
  it('renames a complete temp file over it, never truncates it in place', () => {
    // `writeFileSync` truncates first: a process that dies mid-write leaves the
    // operator with half a settings.json, which this module's own docstring
    // calls the unrecoverable failure.
    const settingsPath = getCopilotSettingsPath();
    writeCopilotHookSettings(OPTIONS);

    expect(vi.mocked(renameSync).mock.calls.map((c) => c[1])).toContain(settingsPath);
    expect(vi.mocked(writeFileSync).mock.calls.map((c) => c[0])).not.toContain(settingsPath);
    expect(readdirSync(home).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('keeps one generation of whatever it replaced', () => {
    const mine = JSON.stringify({ theme: 'dark' }, null, 2);
    writeFileSync(getCopilotSettingsPath(), mine);

    writeCopilotHookSettings(OPTIONS);

    expect(readFileSync(`${getCopilotSettingsPath()}${COPILOT_SETTINGS_BACKUP_SUFFIX}`, 'utf8')).toBe(
      mine
    );
  });

  it('does not touch the file at all when the bytes would not change', () => {
    writeCopilotHookSettings(OPTIONS);
    vi.mocked(renameSync).mockClear();

    writeCopilotHookSettings(OPTIONS);

    expect(vi.mocked(renameSync)).not.toHaveBeenCalled();
    expect(existsSync(`${getCopilotSettingsPath()}${COPILOT_SETTINGS_BACKUP_SUFFIX}`)).toBe(false);
  });

  it('starts without hooks rather than racing another server for the file', () => {
    // `commandmate start --issue N --auto-port` makes concurrent servers a
    // supported workflow, and all of them write this one file (§10.9 決定 2).
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, COPILOT_SETTINGS_LOCK_BASENAME), '999999\n');

    expect(() => writeCopilotHookSettings(OPTIONS)).toThrow(/locked by another CommandMate server/);
    expect(existsSync(getCopilotSettingsPath())).toBe(false);

    const plan = buildCopilotLaunchCommand(COPILOT_LAUNCH_COMMAND, TARGET, OPTIONS);
    expect(plan.command).toBe('gh copilot');
    expect(plan.settingsPath).toBeNull();
  });

  it('takes a lock a crashed server left behind', () => {
    const lock = join(home, COPILOT_SETTINGS_LOCK_BASENAME);
    writeFileSync(lock, '999999\n');
    // `utimesSync` takes seconds; the lock's age is read from mtime.
    const stale = (Date.now() - COPILOT_SETTINGS_LOCK_STALE_MS - 1_000) / 1000;
    utimesSync(lock, stale, stale);

    expect(writeCopilotHookSettings(OPTIONS)).toBe(getCopilotSettingsPath());
    expect(existsSync(lock)).toBe(false);
  });

  it('releases the lock even when the merge throws', () => {
    writeFileSync(getCopilotSettingsPath(), JSON.stringify({ hooks: 'yes please' }));

    expect(() => writeCopilotHookSettings(OPTIONS)).toThrow(/non-object/);
    expect(existsSync(join(home, COPILOT_SETTINGS_LOCK_BASENAME))).toBe(false);
  });
});

// ===========================================================================
// 5. the commands, run
// ===========================================================================

describe('the generated commands in a real shell', () => {
  let server: Server;
  let port: string;
  let hits: Array<{ url: string; body: string; auth?: string }>;
  let status: 200 | 400;

  beforeEach(async () => {
    hits = [];
    status = 200;
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        hits.push({ url: req.url ?? '', body, auth: req.headers.authorization });
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(
          status === 400
            ? JSON.stringify({ error: 'cwd rejected: outside repository' })
            : JSON.stringify({ hookSpecificOutput: { permissionDecision: 'deny' } })
        );
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    port = String((server.address() as { port: number }).port);
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function run(
    command: string,
    env: Record<string, string>
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      // A minimal environment rather than `process.env`: the point of most of
      // these cases is what the hook does when a variable is *absent*, and an
      // inherited `CM_AUTH_TOKEN` or `CM_HOOK_PORT` would answer for it.
      // `stdio` is left at spawn's default (all three piped), which is also
      // what gives `child.stdout` / `.stderr` / `.stdin` their non-null types.
      const child = spawn('/bin/sh', ['-c', command], {
        env: { NODE_ENV: process.env.NODE_ENV, PATH: process.env.PATH ?? '', ...env },
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (c) => (stdout += c));
      child.stderr.on('data', (c) => (stderr += c));
      // Issue #1950: an explicit hang guard, because `spawn` has none and this
      // file is one of the two outside tests/unit/skills/orchestrate-monitor
      // observed timing out under parallel load. Without it the only limit was
      // vitest's per-test budget, which reports the wall clock rather than the
      // hang. Rejecting (not resolving with a sentinel code) keeps a wedged
      // shell from reading as a hook that answered with the wrong exit code.
      const guard = setTimeout(() => {
        child.kill('SIGKILL');
        reject(
          new Error(
            `/bin/sh did not finish within its ${REAL_SHELL_SUBPROCESS_TIMEOUT_MS}ms guard. ` +
              `stdout so far: ${JSON.stringify(stdout)}; stderr so far: ${JSON.stringify(stderr)}`,
          ),
        );
      }, REAL_SHELL_SUBPROCESS_TIMEOUT_MS);
      guard.unref?.();
      child.on('close', (code) => {
        clearTimeout(guard);
        resolve({ code: code ?? -1, stdout, stderr });
      });
      child.stdin.end('{"hook_event_name":"Stop","session_id":"s1","cwd":"/tmp"}');
    });
  }

  const session = (overrides: Record<string, string> = {}) => ({
    CM_AGENT_WORKTREE_ID: 'wt-1',
    CM_AGENT_INSTANCE_ID: 'copilot-2',
    [COPILOT_HOOK_PORT_ENV]: port,
    ...overrides,
  });

  it('is silent and harmless for a session CommandMate did not start', async () => {
    const result = await run(buildCopilotPermissionCommand(OPTIONS), {});

    expect(result.code).toBe(0);
    expect(result.stdout).toBe('{}');
    expect(hits).toHaveLength(0);
  });

  it('sends nothing at all when the port is not a number', async () => {
    // The guard is what stops a `CM_HOOK_PORT` of `1/x?a=b@elsewhere.example`
    // from moving the host — and the bearer header with it.
    const result = await run(
      buildCopilotPermissionCommand(OPTIONS),
      session({ [COPILOT_HOOK_PORT_ENV]: `${port}/x?a=b@example.com` })
    );

    expect(result.stdout).toBe('{}');
    expect(hits).toHaveLength(0);
  });

  it('passes a real verdict through, with the correlation keys and the token', async () => {
    const result = await run(
      buildCopilotPermissionCommand(OPTIONS),
      session({ CM_AUTH_TOKEN: 'tok-1' })
    );

    expect(result.stdout).toContain('"permissionDecision":"deny"');
    expect(result.stderr).toBe('');
    expect(hits[0].url).toBe(
      '/api/hooks/permission-request?tool=copilot&worktreeId=wt-1&instanceId=copilot-2'
    );
    expect(hits[0].auth).toBe('Bearer tok-1');
    expect(hits[0].body).toBe('{"hook_event_name":"Stop","session_id":"s1","cwd":"/tmp"}');
  });

  it('does not hand copilot a 4xx body as its answer', async () => {
    // The bug: `{"error":"cwd rejected: …"}` reached copilot's verdict parser.
    status = 400;

    const result = await run(buildCopilotPermissionCommand(OPTIONS), session());

    expect(hits).toHaveLength(1);
    expect(result.stdout).toBe('{}');
    expect(result.stderr).toContain('permission_request_failed rc=22');
    expect(result.code).toBe(0);
  });

  it('runs the relay when it is on disk and the inline curl when it is not', async () => {
    const relay = join(home, 'relay.sh');
    writeFileSync(relay, '#!/bin/sh\ncat >/dev/null\nprintf "RELAY %s\\n" "$*" >&2\n');
    chmodSync(relay, 0o755);

    const withRelay = await run(
      buildCopilotEventCommand('stop', { ...OPTIONS, relayScriptPath: relay }),
      session()
    );
    expect(withRelay.stderr).toContain(`--url http://127.0.0.1:${port}/api/hooks/agent-event`);
    expect(hits).toHaveLength(0);

    const removed = await run(
      buildCopilotEventCommand('stop', { ...OPTIONS, relayScriptPath: join(home, 'gone', 'relay.sh') }),
      session()
    );
    expect(removed.code).toBe(0);
    expect(hits.map((h) => h.url)).toEqual([
      '/api/hooks/agent-event?tool=copilot&worktreeId=wt-1&instanceId=copilot-2',
    ]);
  });

  it('names the reason when an event cannot be delivered', async () => {
    const result = await run(
      buildCopilotEventCommand('stop', { ...OPTIONS, relayScriptPath: null }),
      session({ [COPILOT_HOOK_PORT_ENV]: '9' })
    );

    expect(result.code).toBe(0);
    expect(result.stderr).toContain('agent_event_post_failed rc=');
  });
});
