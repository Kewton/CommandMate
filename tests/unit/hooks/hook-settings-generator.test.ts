/**
 * The injected `--settings` payload (Issue #1722).
 *
 * Almost everything this generator can get wrong fails *silently* on a real
 * machine: a `type:"http"` hook on `SessionStart` is skipped with nothing on
 * stdout or the TUI, a `$VAR` header with no matching `allowedEnvVars` entry
 * authenticates as the literal string, and a `Notification` matcher naming
 * something that does not exist simply never fires. None of those produce an
 * error anywhere. So the assertions below are written against the live findings
 * in `docs/design/agent-hooks-live-verification.md` and cross-checked against
 * the payloads captured from a real session in `tests/fixtures/hooks/claude/`,
 * rather than against what the generator happens to emit today.
 *
 * @vitest-environment node
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import { chmodSync, mkdtempSync, readdirSync, readFileSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { basename, dirname, join } from 'path';
import { removeTempDir } from '@tests/helpers/temp-dir';
import {
  AUTH_TOKEN_ENV_VAR,
  buildAgentEventUrl,
  buildAgentHookSettings,
  buildClaudeLaunchCommand,
  buildSessionStartCommand,
  getHookSettingsPath,
  isAuthTokenExpected,
  isHookInjectionEnabled,
  NOTIFICATION_MATCHER,
  resolveRelayScriptPath,
  shellQuote,
  writeAgentHookSettings,
  type ClaudeHookSettings,
} from '@/lib/hooks/hook-settings-generator';

const FIXTURE_DIR = join(process.cwd(), 'tests/fixtures/hooks/claude');

const TARGET = { worktreeId: 'wt-alpha' } as const;
const TARGET_2 = { worktreeId: 'wt-alpha', instanceId: 'claude-2' } as const;

/** Env keys this suite drives; saved and restored so order cannot leak. */
const MANAGED_ENV = [
  'CM_AGENT_HOOKS_INJECT',
  'CM_AGENT_HOOKS_DIR',
  'CM_PORT',
  'MCBD_PORT',
  AUTH_TOKEN_ENV_VAR,
  'CM_AUTH_TOKEN_HASH',
] as const;

let dir: string;
let saved: Record<string, string | undefined>;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'hook-settings-'));
});

afterAll(() => removeTempDir(dir));

beforeEach(() => {
  saved = Object.fromEntries(MANAGED_ENV.map((key) => [key, process.env[key]]));
  for (const key of MANAGED_ENV) delete process.env[key];
  process.env.CM_AGENT_HOOKS_DIR = dir;
});

afterEach(() => {
  for (const key of MANAGED_ENV) {
    const value = saved[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

/** Every handler in the settings, paired with the event it was registered for. */
function handlers(settings: ClaudeHookSettings) {
  return Object.entries(settings.hooks).flatMap(([event, groups]) =>
    groups.flatMap((group) => group.hooks.map((hook) => ({ event, matcher: group.matcher, hook })))
  );
}

function fixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, name), 'utf8'));
}

describe('event coverage', () => {
  it('registers exactly the five lifecycle events, and no decision-bearing ones', () => {
    // PermissionRequest and PreToolUse let a hook *answer* for the user. This
    // Issue is observation only; shipping them by default would make that claim
    // false. They belong to Auto-Yes v2 (#1724).
    expect(Object.keys(buildAgentHookSettings(TARGET).hooks).sort()).toEqual([
      'Notification',
      'SessionEnd',
      'SessionStart',
      'Stop',
      'UserPromptSubmit',
    ]);
  });

  it('covers every lifecycle event that a real session was observed to emit', () => {
    // Guards against the settings and the captured reality drifting apart: if a
    // future fixture records an event we do not subscribe to, this fails.
    const observed = new Set(
      readdirSync(FIXTURE_DIR)
        .filter((name) => name.endsWith('.json'))
        .map((name) => fixture(name).hook_event_name as string)
    );
    const outOfScope = new Set(['PermissionRequest', 'PreToolUse']);
    const registered = new Set(Object.keys(buildAgentHookSettings(TARGET).hooks));

    for (const event of observed) {
      if (outOfScope.has(event)) continue;
      expect(registered.has(event), `no hook registered for observed event ${event}`).toBe(true);
    }
  });
});

describe('SessionStart cannot be an http hook (D1)', () => {
  it('registers SessionStart as a command and every other event as http', () => {
    // The failure this prevents is silent: Claude logs `HTTP hooks are not
    // supported for SessionStart` to the debug file only, and the session runs
    // on happily with the hook never firing.
    for (const { event, hook } of handlers(buildAgentHookSettings(TARGET))) {
      expect(hook.type, `wrong handler type for ${event}`).toBe(
        event === 'SessionStart' ? 'command' : 'http'
      );
    }
  });

  it('points the SessionStart relay at the same URL the http hooks use', () => {
    const command = buildSessionStartCommand(TARGET);

    expect(command).toContain(shellQuote(buildAgentEventUrl(TARGET)));
    expect(command).toContain("--worktree-id 'wt-alpha'");
    expect(command).toContain("--instance-id 'claude'");
    expect(command).toContain('--stdin-json');
  });

  it('uses the shipped relay script, which exists and is executable', () => {
    const relay = resolveRelayScriptPath();

    expect(relay, 'scripts/hooks/cmate-agent-event.sh not found from the app root').not.toBeNull();
    expect(buildSessionStartCommand(TARGET)).toContain(shellQuote(relay!));
    // Claude runs the command through a shell; a non-executable file would fail
    // at run time with nothing but a debug-log line to show for it.
    expect(statSync(relay!).mode & 0o111).not.toBe(0);
  });

  it('falls back to an inline curl when the relay is not on disk', () => {
    // A packaging change that drops scripts/hooks/ must cost the events, not
    // produce a command that runs a missing file on every session start.
    const command = buildSessionStartCommand(TARGET, { relayScriptPath: null });

    expect(command).toContain('curl');
    expect(command).toContain('--data-binary @-');
    expect(command).toContain(shellQuote(buildAgentEventUrl(TARGET)));
  });
});

describe('instance correlation is carried by the URL', () => {
  it('bakes tool, worktree and instance into every http hook URL', () => {
    for (const { hook } of handlers(buildAgentHookSettings(TARGET_2))) {
      if (hook.type !== 'http') continue;
      const url = new URL(hook.url);
      expect(url.pathname).toBe('/api/hooks/agent-event');
      expect(url.searchParams.get('tool')).toBe('claude');
      expect(url.searchParams.get('worktreeId')).toBe('wt-alpha');
      expect(url.searchParams.get('instanceId')).toBe('claude-2');
    }
  });

  it('names the primary instance explicitly when none is given', () => {
    expect(new URL(buildAgentEventUrl(TARGET)).searchParams.get('instanceId')).toBe('claude');
  });

  it('gives two instances of one worktree different URLs and different files', () => {
    // The whole point: cwd is identical for claude and claude-2, so if these
    // two collapsed onto one value the receiver would be back to guessing.
    expect(buildAgentEventUrl(TARGET)).not.toBe(buildAgentEventUrl(TARGET_2));
    expect(getHookSettingsPath(TARGET)).not.toBe(getHookSettingsPath(TARGET_2));
  });

  it('follows CM_PORT, and falls back to 3000 when it is nonsense', () => {
    process.env.CM_PORT = '3135';
    expect(buildAgentEventUrl(TARGET)).toContain('http://127.0.0.1:3135/');

    process.env.CM_PORT = 'not-a-port';
    expect(buildAgentEventUrl(TARGET)).toContain('http://127.0.0.1:3000/');
  });
});

describe('authentication header (D7)', () => {
  it('lists CM_AUTH_TOKEN in allowedEnvVars whenever it references it', () => {
    // Without the allowedEnvVars entry the `$CM_AUTH_TOKEN` in the header is
    // *not* expanded, and the server 401s on the literal string. Asserted as an
    // implication rather than on one fixed config, so any future header that
    // references an env var is covered too.
    for (const withAuthHeader of [true, false]) {
      for (const { event, hook } of handlers(buildAgentHookSettings(TARGET, { withAuthHeader }))) {
        if (hook.type !== 'http') continue;
        const referenced = Object.values(hook.headers).filter((value) => value.includes('$'));
        for (const value of referenced) {
          const name = value.slice(value.indexOf('$') + 1);
          expect(hook.allowedEnvVars ?? [], `${event} references ${value}`).toContain(name);
        }
        expect(hook.headers.Authorization).toBe(
          withAuthHeader ? `Bearer $${AUTH_TOKEN_ENV_VAR}` : undefined
        );
      }
    }
  });

  it('sends no bearer header on an installation with no auth configured', () => {
    expect(isAuthTokenExpected()).toBe(false);
    for (const { hook } of handlers(buildAgentHookSettings(TARGET))) {
      if (hook.type !== 'http') continue;
      expect(hook.allowedEnvVars).toBeUndefined();
      expect(JSON.stringify(hook.headers)).not.toContain('$');
    }
  });

  it('sends one as soon as either the token or its hash is in the environment', () => {
    process.env.CM_AUTH_TOKEN_HASH = 'deadbeef';
    expect(isAuthTokenExpected()).toBe(true);

    delete process.env.CM_AUTH_TOKEN_HASH;
    process.env[AUTH_TOKEN_ENV_VAR] = 'tok';
    expect(isAuthTokenExpected()).toBe(true);

    const http = handlers(buildAgentHookSettings(TARGET)).find((h) => h.hook.type === 'http')!.hook;
    expect(http.type === 'http' && http.allowedEnvVars).toEqual([AUTH_TOKEN_ENV_VAR]);
  });

  it('adds the header to the inline curl fallback too', () => {
    expect(buildSessionStartCommand(TARGET, { relayScriptPath: null, withAuthHeader: true }))
      .toContain(`Authorization: Bearer $${AUTH_TOKEN_ENV_VAR}`);
    expect(buildSessionStartCommand(TARGET, { relayScriptPath: null, withAuthHeader: false }))
      .not.toContain('Authorization');
  });
});

describe('Notification matcher (D3)', () => {
  it('matches on notification_type, which is what the captured payloads carry', () => {
    const settings = buildAgentHookSettings(TARGET);
    const group = settings.hooks.Notification[0];
    expect(group.matcher).toBe(NOTIFICATION_MATCHER);

    // A matcher naming a type that does not exist fires zero times and says
    // nothing, so the two spellings are checked against the real payloads.
    const pattern = new RegExp(`^(?:${group.matcher})$`);
    for (const name of ['notification-permission-prompt.json', 'notification-idle-prompt.json']) {
      expect(pattern.test(fixture(name).notification_type as string), name).toBe(true);
    }
    // `message` is English prose for a human; matching on it would be fragile.
    expect(pattern.test(fixture('notification-idle-prompt.json').message as string)).toBe(false);
  });
});

describe('determinism and file layout', () => {
  it('produces byte-identical settings for the same target', () => {
    expect(JSON.stringify(buildAgentHookSettings(TARGET_2))).toBe(
      JSON.stringify(buildAgentHookSettings(TARGET_2))
    );
    expect(getHookSettingsPath(TARGET_2)).toBe(getHookSettingsPath(TARGET_2));
  });

  it('writes a 0600 file of valid JSON under the configured directory', () => {
    const path = writeAgentHookSettings(TARGET);

    expect(path.startsWith(`${dir}/`)).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(() => JSON.parse(readFileSync(path, 'utf8'))).not.toThrow();
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(buildAgentHookSettings(TARGET));
  });

  it('overwrites rather than accumulating across restarts', () => {
    const before = readdirSync(dir).length;
    writeAgentHookSettings(TARGET_2);
    writeAgentHookSettings(TARGET_2);
    expect(readdirSync(dir).length).toBe(before + 1);
  });

  it('keeps a worktree id that is not filename-safe out of the path', () => {
    const path = getHookSettingsPath({ worktreeId: '../../etc/passwd' });

    expect(dirname(path)).toBe(dir);
    expect(basename(path)).toMatch(/^[a-zA-Z0-9_-]+\.json$/);
  });

  it('does not collapse two ids that sanitise to the same name', () => {
    // `a/b` and `a-b` would share a slug; the digest of the raw pair is what
    // keeps two live instances from writing over each other's settings.
    expect(getHookSettingsPath({ worktreeId: 'a/b' })).not.toBe(
      getHookSettingsPath({ worktreeId: 'a_b' })
    );
  });
});

describe('launch command', () => {
  it('quotes both the CLI path and the settings path', () => {
    // The command travels through `tmux send-keys` as one line, and either path
    // can contain a space — an install under "Application Support", a worktree
    // under a user directory with a space in it.
    const command = buildClaudeLaunchCommand('/Applications/My Tools/claude', TARGET);

    expect(command).toMatch(/^'\/Applications\/My Tools\/claude' --settings '.+\.json'$/);
    expect(command.split('\n')).toHaveLength(1);
    expect(command).not.toContain('~');
  });

  it('is the bare CLI path when CM_AGENT_HOOKS_INJECT=0, and writes nothing', () => {
    process.env.CM_AGENT_HOOKS_INJECT = '0';
    const before = readdirSync(dir);

    expect(isHookInjectionEnabled()).toBe(false);
    expect(buildClaudeLaunchCommand('/usr/local/bin/claude', { worktreeId: 'wt-rollback' })).toBe(
      '/usr/local/bin/claude'
    );
    expect(readdirSync(dir)).toEqual(before);
  });

  it('is enabled for any other value, including unset and "1"', () => {
    expect(isHookInjectionEnabled()).toBe(true);
    process.env.CM_AGENT_HOOKS_INJECT = '1';
    expect(isHookInjectionEnabled()).toBe(true);
  });

  it('falls back to the bare path when the settings file cannot be written', () => {
    // Fail-open: hooks are an enhancement to a session that has to start
    // regardless. Losing the events is acceptable; losing the session is not.
    const readOnly = mkdtempSync(join(tmpdir(), 'hook-settings-ro-'));
    try {
      chmodSync(readOnly, 0o500);
      process.env.CM_AGENT_HOOKS_DIR = join(readOnly, 'nested');

      expect(buildClaudeLaunchCommand('/usr/local/bin/claude', TARGET)).toBe(
        '/usr/local/bin/claude'
      );
    } finally {
      chmodSync(readOnly, 0o700);
      removeTempDir(readOnly);
    }
  });

  it('refuses to inject an instance id the receiver would reject', () => {
    expect(buildClaudeLaunchCommand('/usr/local/bin/claude', {
      worktreeId: 'wt-alpha',
      instanceId: 'claude 2; rm -rf /',
    })).toBe('/usr/local/bin/claude');
  });
});

describe('shellQuote', () => {
  it('round-trips awkward values through a real shell', () => {
    // Asserted by running a shell rather than against an expected spelling:
    // what matters is that the value survives, not how it was escaped.
    for (const value of ["it's", '/Applications/My Tools/claude', 'a"b', '$CM_AUTH_TOKEN', 'x;y']) {
      const echoed = execFileSync('sh', ['-c', `printf %s ${shellQuote(value)}`], {
        encoding: 'utf8',
      });
      expect(echoed).toBe(value);
    }
  });
});
