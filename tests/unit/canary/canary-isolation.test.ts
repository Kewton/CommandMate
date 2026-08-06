/**
 * Isolation invariants of the detection canary (Issue #1727).
 *
 * These are the guarantees that keep `npm run canary` from touching the
 * developer's machine: never talk to the default tmux server, never leave the
 * throwaway HOME, never let a `/model` write reach the real settings. They are
 * tested here — with no tmux and no Claude — because the live harness is
 * exactly the code that cannot be trusted to police itself.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  buildTmuxArgs,
  exactTarget,
  CANARY_SOCKET_PATTERN,
  FORBIDDEN_TMUX_COMMANDS,
  GLOBAL_OPTION_FLAG,
  SERVER_TEARDOWN_COMMAND,
} from '../../../scripts/canary/tmux-private';
import {
  assertIsolatedHome,
  captureGuardSnapshot,
  assertGuardSnapshotIntact,
  diffSessionNames,
  filterProductionSessions,
  fingerprintFile,
  ABSENT_FINGERPRINT,
} from '../../../scripts/canary/guards';
import {
  assertCredentialUsable,
  buildSeedConfig,
  sanitizeEnv,
  CREDENTIAL_MIN_TTL_MS,
  STRIPPED_ENV_VARS,
} from '../../../scripts/canary/isolated-home';

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop() as string, { recursive: true, force: true });
  }
});

describe('buildTmuxArgs', () => {
  it('always puts -L <private socket> in front of the command', () => {
    expect(buildTmuxArgs('cmate-canary-1-abc', ['list-sessions'])).toEqual([
      '-L',
      'cmate-canary-1-abc',
      '-f',
      '/dev/null',
      'list-sessions',
    ]);
  });

  it('rejects socket names outside the canary namespace', () => {
    // A bug that let this through would send every command to the user's tmux
    // server, where the mcbd-* agent sessions live.
    for (const socket of ['', 'default', 'mcbd-claude-abc', '../default', 'CMATE-CANARY-1']) {
      expect(() => buildTmuxArgs(socket, ['list-sessions'])).toThrow();
    }
    expect(CANARY_SOCKET_PATTERN.test('cmate-canary-123-ab12cd')).toBe(true);
  });

  // The tokens below come from the module's own constants rather than string
  // literals: tests/unit/config/tmux-live-test-safety.test.ts treats an unpinned
  // occurrence of them anywhere under tests/ as a violation, and that guard is
  // the same rule this file exists to defend.
  it('refuses the server teardown command unless it comes through PrivateTmuxServer.killServer()', () => {
    expect(() => buildTmuxArgs('cmate-canary-1-abc', [SERVER_TEARDOWN_COMMAND])).toThrow(
      /PrivateTmuxServer/
    );
    expect(
      buildTmuxArgs('cmate-canary-1-abc', [SERVER_TEARDOWN_COMMAND], { allowKillServer: true })
    ).toEqual(['-L', 'cmate-canary-1-abc', '-f', '/dev/null', SERVER_TEARDOWN_COMMAND]);
  });

  it('refuses server-global mutations', () => {
    for (const command of FORBIDDEN_TMUX_COMMANDS) {
      expect(() => buildTmuxArgs('cmate-canary-1-abc', [command, 'x'])).toThrow(/forbidden/);
    }
    expect(() =>
      buildTmuxArgs('cmate-canary-1-abc', ['set-option', GLOBAL_OPTION_FLAG, 'status', 'off'])
    ).toThrow(/global options/);
  });

  it('builds exact session targets so a prefix cannot match another session', () => {
    expect(exactTarget('cmate-canary-idle-ab12cd')).toBe('=cmate-canary-idle-ab12cd:');
    expect(() => exactTarget('bad name')).toThrow();
  });
});

describe('assertIsolatedHome', () => {
  it('rejects the real HOME and anything containing it', () => {
    expect(() => assertIsolatedHome('/Users/dev', '/Users/dev')).toThrow(/real HOME/);
    expect(() => assertIsolatedHome('/Users/dev', '/Users')).toThrow(/contains the real HOME/);
    expect(() => assertIsolatedHome('/Users/dev', 'relative/path')).toThrow(/absolute/);
    expect(() => assertIsolatedHome('/Users/dev', '/')).toThrow();
  });

  it('accepts a temp directory outside the real HOME', () => {
    expect(() => assertIsolatedHome('/Users/dev', '/tmp/cmate-canary-home-x')).not.toThrow();
  });
});

describe('guard snapshot', () => {
  it('fires when the protected settings file changes', async () => {
    const fakeHome = makeTempDir('canary-guard-home-');
    mkdirSync(path.join(fakeHome, '.claude'));
    const settings = path.join(fakeHome, '.claude', 'settings.json');
    writeFileSync(settings, '{"model":"opus"}');

    const snapshot = await captureGuardSnapshot(fakeHome);
    await expect(assertGuardSnapshotIntact(snapshot, 'unchanged')).resolves.toBeUndefined();

    // This is the /model overlay writing the developer's default model.
    writeFileSync(settings, '{"model":"haiku"}');
    await expect(assertGuardSnapshotIntact(snapshot, 'after /model')).rejects.toThrow(/CHANGED/);
  });

  it('fingerprints a missing file as absent rather than throwing', () => {
    const dir = makeTempDir('canary-fingerprint-');
    expect(fingerprintFile(path.join(dir, 'nope.json'))).toBe(ABSENT_FINGERPRINT);
  });

  it('reports disappeared production sessions', () => {
    const before = ['mcbd-claude-a', 'mcbd-codex-b'];
    const after = ['mcbd-claude-a'];
    expect(diffSessionNames(before, after)).toEqual({ disappeared: ['mcbd-codex-b'], appeared: [] });
  });

  it('only tracks mcbd-* sessions', () => {
    expect(filterProductionSessions(['mcbd-claude-a', 'cmate-canary-idle-1', 'scratch'])).toEqual([
      'mcbd-claude-a',
    ]);
  });
});

describe('sanitizeEnv', () => {
  it('drops the outer Claude Code session and tmux variables but keeps the auth token', () => {
    // The stripped keys are taken from the module's own list (rather than spelled
    // out) so this assertion cannot drift out of sync with it — and so the tmux
    // variable names do not appear as literals under tests/, where the
    // tmux-live-test-safety guard rejects them.
    const pollution = Object.fromEntries(STRIPPED_ENV_VARS.map(key => [key, 'inherited']));
    const env = sanitizeEnv(
      {
        NODE_ENV: 'test',
        PATH: '/usr/bin',
        HOME: '/Users/dev',
        ...pollution,
        CLAUDE_CODE_SESSION_ID: 'outer',
        CLAUDE_CODE_OAUTH_TOKEN: 'token',
      } as NodeJS.ProcessEnv,
      '/tmp/canary-home'
    );

    expect(env.HOME).toBe('/tmp/canary-home');
    expect(env.PATH).toBe('/usr/bin');
    // Auth must survive; the outer session's bookkeeping must not.
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('token');
    expect(env.CLAUDE_CODE_SESSION_ID).toBeUndefined();
    for (const key of STRIPPED_ENV_VARS) {
      expect(env[key], key).toBeUndefined();
    }
  });
});

describe('buildSeedConfig', () => {
  it('pre-accepts the trust dialog for every scenario working directory', () => {
    const seed = buildSeedConfig({
      workingDirectories: ['/tmp/home/work/idle', '/tmp/home/work/generating'],
      claudeVersion: '2.1.223',
    });
    const projects = seed.projects as Record<string, { hasTrustDialogAccepted: boolean }>;
    expect(Object.keys(projects)).toEqual(['/tmp/home/work/idle', '/tmp/home/work/generating']);
    expect(projects['/tmp/home/work/idle'].hasTrustDialogAccepted).toBe(true);
    expect(seed.hasCompletedOnboarding).toBe(true);
  });

  it('omits identity fields when the real config has none', () => {
    const seed = buildSeedConfig({ workingDirectories: [], claudeVersion: '2.1.223' });
    expect('oauthAccount' in seed).toBe(false);
    expect('userID' in seed).toBe(false);
  });
});

describe('assertCredentialUsable', () => {
  const now = 1_786_000_000_000;

  it('accepts a credential with plenty of life left', () => {
    expect(() =>
      assertCredentialUsable({ claudeAiOauth: { expiresAt: now + 3 * 60 * 60 * 1000 } }, now, CREDENTIAL_MIN_TTL_MS)
    ).not.toThrow();
  });

  it('refuses a credential close to expiry so the throwaway session cannot rotate the real refresh token', () => {
    expect(() =>
      assertCredentialUsable({ claudeAiOauth: { expiresAt: now + 60_000 } }, now, CREDENTIAL_MIN_TTL_MS)
    ).toThrow(/rotate your real refresh token/);
  });

  it('refuses an expired or malformed credential', () => {
    expect(() =>
      assertCredentialUsable({ claudeAiOauth: { expiresAt: now - 1 } }, now, CREDENTIAL_MIN_TTL_MS)
    ).toThrow(/expired/);
    expect(() => assertCredentialUsable({}, now, CREDENTIAL_MIN_TTL_MS)).toThrow(/claudeAiOauth/);
    expect(() => assertCredentialUsable({ claudeAiOauth: {} }, now, CREDENTIAL_MIN_TTL_MS)).toThrow(
      /expiresAt/
    );
  });
});
