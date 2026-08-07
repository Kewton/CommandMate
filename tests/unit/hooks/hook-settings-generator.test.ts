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
  buildPermissionRequestUrl,
  getHookSettingsPath,
  isAuthTokenExpected,
  isHookInjectionEnabled,
  NOTIFICATION_MATCHER,
  PERMISSION_DENY_RULES,
  PERMISSION_REQUEST_TIMEOUT_SECONDS,
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
  it('registers the five lifecycle events plus PermissionRequest and the tool-use pair', () => {
    expect(Object.keys(buildAgentHookSettings(TARGET).hooks).sort()).toEqual([
      'Notification',
      'PermissionRequest',
      'PostToolUse',
      'PreToolUse',
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
    const registered = new Set(Object.keys(buildAgentHookSettings(TARGET).hooks));

    for (const event of observed) {
      expect(registered.has(event), `no hook registered for observed event ${event}`).toBe(true);
    }
  });

  it.each(['PreToolUse', 'PostToolUse'])(
    'narrows %s to AskUserQuestion and posts it to the event receiver (Issue #1726)',
    (event) => {
      // Two separate claims, both load-bearing. The matcher: an unmatched
      // PreToolUse/PostToolUse pair fires on every tool call, and each one
      // blocks the agent until this server answers — two requests per `Read`
      // for a payload nothing reads. The receiver: a `PreToolUse` response body
      // can block or redirect the tool call, and this feature must not be able
      // to answer a question the human has not seen. The event route answers
      // 202 with a fixed body.
      const [group] = buildAgentHookSettings(TARGET).hooks[event];
      const [hook] = group.hooks;

      expect(group.matcher).toBe('AskUserQuestion');
      expect(hook.type === 'http' && hook.url).toBe(buildAgentEventUrl(TARGET));
      expect(hook.type === 'http' && hook.url).not.toContain('/api/hooks/permission-request');
    },
  );
});

describe('PermissionRequest wiring (Issue #1724)', () => {
  it('posts to its own receiver, not the fire-and-forget event one', () => {
    // The event receiver answers 202 with a fixed body and never carries a
    // decision. Pointing PermissionRequest at it would make every approval a
    // silent no-decision — the feature off, with no way to notice.
    const settings = buildAgentHookSettings(TARGET);
    const [group] = settings.hooks.PermissionRequest;
    const [hook] = group.hooks;

    expect(group.matcher).toBeUndefined();
    expect(hook.type).toBe('http');
    expect(hook.type === 'http' && hook.url).toBe(buildPermissionRequestUrl(TARGET));
    expect(hook.type === 'http' && hook.url).not.toBe(buildAgentEventUrl(TARGET));
    expect(buildPermissionRequestUrl(TARGET)).toContain('/api/hooks/permission-request');
  });

  it('carries the same correlation keys, per instance', () => {
    // A verdict applied to the wrong instance is an approval nobody asked for,
    // and cwd cannot tell claude from claude-2.
    expect(buildPermissionRequestUrl(TARGET_2)).toContain('instanceId=claude-2');
    expect(buildPermissionRequestUrl(TARGET_2)).toContain('worktreeId=wt-alpha');
    expect(buildPermissionRequestUrl(TARGET_2)).toContain('tool=claude');
  });

  it('bounds how long a wedged server can delay an approval dialog', () => {
    const [hook] = buildAgentHookSettings(TARGET).hooks.PermissionRequest[0].hooks;

    // Claude's own default for an http hook is 600 s and there is no async for
    // http (#1721 §5.3.6), so leaving this unset would hang every dialog on the
    // machine for ten minutes when the server is gone.
    expect(hook.timeout).toBe(PERMISSION_REQUEST_TIMEOUT_SECONDS);
    expect(PERMISSION_REQUEST_TIMEOUT_SECONDS).toBeLessThan(30);
  });

  it('is registered whether or not Auto-Yes is enabled anywhere', () => {
    // Injection happens once at launch; Auto-Yes is toggled mid-session. A
    // hook that were gated on Auto-Yes would simply never exist for the
    // sessions that later turn it on.
    expect(Object.keys(buildAgentHookSettings(TARGET).hooks)).toContain('PermissionRequest');
    expect(Object.keys(buildAgentHookSettings(TARGET_2).hooks)).toContain('PermissionRequest');
  });
});

/**
 * Claude's Bash rule matching, as measured in
 * `docs/design/agent-hooks-permission-deny-verification.md` §2 against
 * v2.1.223. Encoded once here so the table below asserts what a real session
 * does with these rules rather than what this suite wishes it did.
 *
 *  - `Bash(<prefix>:*)` matches a command whose text starts with `<prefix>`.
 *    The prefix is compared *including its flags*: a rule naming `uname -a`
 *    refused `uname -a` and left `uname -s` untouched in the same session.
 *  - The command line is decomposed and each segment matched on its own. All
 *    three composed spellings — `&&`, `|`, `;` — of a denied command were
 *    refused.
 */
function isDeniedBy(rules: readonly string[], command: string): boolean {
  const prefixes = rules.map((rule) => {
    const match = /^Bash\((.*):\*\)$/.exec(rule);
    if (!match) throw new Error(`not a Bash prefix rule: ${rule}`);
    return match[1];
  });
  return command
    .split(/&&|\|\||[;|]/)
    .map((segment) => segment.trim())
    .some((segment) => prefixes.some((prefix) => segment.startsWith(prefix)));
}

describe('process-kill deny rules (Issue #1739)', () => {
  it('carries permissions as a sibling of hooks, not inside it', () => {
    // Claude reads `permissions` at the top level of a settings file. Nested
    // anywhere else it is not an error — it is simply ignored, which is this
    // feature being off with nothing to notice.
    const settings = buildAgentHookSettings(TARGET);

    expect(settings.permissions.deny).toEqual([...PERMISSION_DENY_RULES]);
    expect(JSON.stringify(settings.hooks)).not.toContain('permissions');
  });

  it('denies the command that stopped the production server on 2026-08-06', () => {
    // The accident, verbatim from the incident in Issue #1739. A worker meant
    // to restart its own isolated server on port 3778; `-f` matches the whole
    // command line, so it also hit the operator's server on 3000 and the
    // global instance on 60301.
    expect(
      isDeniedBy(PERMISSION_DENY_RULES, 'pkill -f "node dist/server/server.js"')
    ).toBe(true);
  });

  it.each([
    ['pkill -f node', 'the bare pattern kill'],
    ['killall node', 'the by-name variant'],
    ['kill -9 -1', 'signalling every process the user owns'],
    ['kill -9 -4242', 'signalling a whole process group'],
    ['cd /tmp && pkill -f node', 'hidden behind a cd'],
    ['killall node | cat', 'hidden in a pipeline'],
    ['echo restarting; pkill -f node', 'hidden after a semicolon'],
  ])('denies %s (%s)', (command) => {
    expect(isDeniedBy(PERMISSION_DENY_RULES, command)).toBe(true);
  });

  it.each([
    ['kill "$(cat uat.pid)"', 'the pid-file idiom the docs recommend'],
    ['kill 4242', 'a literal pid'],
    ['kill -TERM 4242', 'an explicit graceful signal'],
    ['npm run kill-orphans', 'a script whose name merely contains kill'],
    ['git commit -m "kill -9 is denied"', 'a rule name quoted inside prose'],
  ])('leaves %s alone (%s)', (command) => {
    // A worker still has to be able to stop what it started, or it will reach
    // for something worse. Stopping by identity is exactly what these rules
    // are meant to leave standing.
    expect(isDeniedBy(PERMISSION_DENY_RULES, command)).toBe(false);
  });

  it('states every rule in the prefix form Claude honours', () => {
    for (const rule of PERMISSION_DENY_RULES) {
      expect(rule, `${rule} is not a Bash prefix rule`).toMatch(/^Bash\(\S(?:.*\S)?:\*\)$/);
    }
  });

  it('never emits an allow list', () => {
    // This file is handed to every session CommandMate starts. `deny` only
    // narrows, so it is safe to inject unconditionally; an `allow` here would
    // pre-approve tool calls no human ever saw.
    expect(Object.keys(buildAgentHookSettings(TARGET).permissions)).toEqual(['deny']);
  });

  it('writes the rules into the file the CLI actually reads', () => {
    // The generator's return value is not what Claude loads; the file is.
    const written = JSON.parse(readFileSync(writeAgentHookSettings(TARGET), 'utf8'));

    expect(written.permissions.deny).toEqual([...PERMISSION_DENY_RULES]);
  });

  it('hands out a copy, so one caller cannot edit every later session', () => {
    // Snapshot *before* the edit. Comparing against `PERMISSION_DENY_RULES`
    // afterwards would pass even when the array is shared, because the edit
    // would have changed both sides of the assertion.
    const pristine = [...PERMISSION_DENY_RULES];
    const settings = buildAgentHookSettings(TARGET);
    settings.permissions.deny.push('Bash(anything:*)');

    expect(buildAgentHookSettings(TARGET).permissions.deny).toEqual(pristine);
    expect([...PERMISSION_DENY_RULES]).toEqual(pristine);
  });

  it('writes no rules at all when CM_AGENT_HOOKS_INJECT=0', () => {
    // The rollback switch has to take the permissions with it: an operator who
    // turns injection off to get a kill through would otherwise still be denied
    // by a file nothing is writing any more.
    process.env.CM_AGENT_HOOKS_INJECT = '0';
    const before = readdirSync(dir);

    expect(buildClaudeLaunchCommand('/usr/local/bin/claude', { worktreeId: 'wt-deny' })).toBe(
      '/usr/local/bin/claude'
    );
    expect(readdirSync(dir)).toEqual(before);
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
    for (const { event, hook } of handlers(buildAgentHookSettings(TARGET_2))) {
      if (hook.type !== 'http') continue;
      const url = new URL(hook.url);
      expect(url.pathname).toBe(
        event === 'PermissionRequest' ? '/api/hooks/permission-request' : '/api/hooks/agent-event'
      );
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
