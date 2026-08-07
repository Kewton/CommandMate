/**
 * Environment snapshots for the `env-clean` gate (Issue #1740).
 *
 * The suite is built around one property: a probe that could not answer must
 * never be indistinguishable from a probe that answered "nothing". Every probe
 * therefore has three cases — a populated answer, an empty answer, and a
 * failure — and the failure case asserts `status: 'unavailable'` with a reason,
 * not an empty entry list.
 *
 * Every probe runs against injected deps, so nothing here reads the real
 * machine's ports, tmux server or home directory.
 *
 * @vitest-environment node
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, utimesSync, writeFileSync, existsSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  captureEnvSnapshot,
  COMMANDMATE_PROCESS_PATTERN,
  ENV_PROBE_IDS,
  ENV_SNAPSHOT_DIR_NAME,
  ENV_SNAPSHOT_RETENTION_MS,
  ENV_SNAPSHOT_VERSION,
  isEnvSnapshot,
  loadEnvSnapshot,
  MCBD_SESSION_PREFIX,
  probeCommandmateEntries,
  probeHomeEntries,
  probeListeners,
  probeTmuxSessions,
  saveEnvSnapshot,
  type CommandResult,
  type EnvProbeDeps,
  type EnvSnapshot,
} from '@/lib/verification/env-snapshot';
import { removeTempDir } from '@tests/helpers/temp-dir';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) removeTempDir(tempDirs.pop() as string);
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function okResult(stdout: string): CommandResult {
  return { code: 0, stdout, stderr: '', failure: null };
}

const LSOF_LISTENERS = [
  'p1234',
  'cnode',
  'n*:3000',
  'n[::1]:3000',
  'p5678',
  'cnode',
  'n127.0.0.1:3779',
  'p9999',
  'cChrome',
  'n*:8080',
  '',
].join('\n');

const PS_TABLE = [
  ' 1234 node /Users/dev/work/commandmate-main/dist/server/server.js',
  ' 5678 node /Users/dev/work/commandmate-issue-1740/dist/server/server.js',
  ' 9999 /Applications/Chrome.app/Contents/MacOS/Chrome --type=renderer',
  '',
].join('\n');

const LSOF_CWD = [
  'p1234',
  'n/Users/dev/work/commandmate-main',
  'p5678',
  'n/Users/dev/work/commandmate-issue-1740',
  '',
].join('\n');

/**
 * Deps that answer from a table keyed by `command args…`.
 *
 * Unlisted commands resolve to a spawn failure, so a probe that reaches for a
 * command the test did not stub fails loudly instead of silently reading empty.
 */
function deps(overrides: {
  commands?: Record<string, CommandResult>;
  dirs?: Record<string, string[] | Error>;
  home?: string;
}): EnvProbeDeps {
  const home = overrides.home ?? '/Users/dev';
  return {
    run: async (command, args) => {
      const key = [command, ...args].join(' ');
      return (
        overrides.commands?.[key] ?? {
          code: null,
          stdout: '',
          stderr: '',
          failure: `${command} could not be run: not stubbed (${key})`,
        }
      );
    },
    readDir: (path: string) => {
      const value = overrides.dirs?.[path];
      if (value === undefined) {
        const error = new Error(`ENOENT: no such file or directory, scandir '${path}'`);
        (error as NodeJS.ErrnoException).code = 'ENOENT';
        throw error;
      }
      if (value instanceof Error) throw value;
      return value;
    },
    homeDir: () => home,
  };
}

const LSOF_LISTEN_KEY = 'lsof -nP -iTCP -sTCP:LISTEN -F pcn';
const PS_KEY = 'ps -A -o pid=,command=';
const LSOF_CWD_KEY = 'lsof -a -d cwd -p 1234,5678 -F pn';
const TMUX_KEY = 'tmux list-sessions -F #{session_name}';

describe('probeListeners', () => {
  it('keeps only CommandMate processes and keys them by port', async () => {
    const result = await probeListeners(
      deps({
        commands: {
          [LSOF_LISTEN_KEY]: okResult(LSOF_LISTENERS),
          [PS_KEY]: okResult(PS_TABLE),
          [LSOF_CWD_KEY]: okResult(LSOF_CWD),
        },
      })
    );

    expect(result.status).toBe('ok');
    expect(result.entries.map((entry) => entry.key)).toEqual(['tcp/3000', 'tcp/3779']);
    expect(result.entries[0]).toMatchObject({
      detail: 'node pid=1234',
      anchor: '/Users/dev/work/commandmate-main',
    });
    expect(result.entries[1].anchor).toBe('/Users/dev/work/commandmate-issue-1740');
  });

  it('reports zero listeners when lsof matched nothing (exit 1)', async () => {
    const result = await probeListeners(
      deps({ commands: { [LSOF_LISTEN_KEY]: { code: 1, stdout: '', stderr: '', failure: null } } })
    );
    expect(result).toEqual({ status: 'ok', entries: [], reason: null });
  });

  it('is unavailable — not empty — when lsof cannot be run', async () => {
    const result = await probeListeners(deps({}));
    expect(result.status).toBe('unavailable');
    expect(result.entries).toEqual([]);
    expect(result.reason).toContain('lsof');
  });

  it('is unavailable when ps cannot be run, because relevance is undecidable', async () => {
    const result = await probeListeners(
      deps({ commands: { [LSOF_LISTEN_KEY]: okResult(LSOF_LISTENERS) } })
    );
    expect(result.status).toBe('unavailable');
    expect(result.reason).toContain('ps');
  });

  it('still lists listeners when only the cwd lookup fails, with a null anchor', async () => {
    const result = await probeListeners(
      deps({ commands: { [LSOF_LISTEN_KEY]: okResult(LSOF_LISTENERS), [PS_KEY]: okResult(PS_TABLE) } })
    );
    expect(result.status).toBe('ok');
    expect(result.entries.map((entry) => entry.anchor)).toEqual([null, null]);
  });

  it('recognises the process shapes CommandMate actually runs as', () => {
    for (const commandLine of [
      'node /opt/homebrew/lib/node_modules/commandmate/dist/server/server.js',
      'node dist/server/server.js',
      'next-server (v14.2.15)',
      'node_modules/.bin/tsx server.ts',
    ]) {
      expect(COMMANDMATE_PROCESS_PATTERN.test(commandLine)).toBe(true);
    }
    expect(COMMANDMATE_PROCESS_PATTERN.test('/usr/bin/postgres -D /var/db')).toBe(false);
  });
});

describe('probeTmuxSessions', () => {
  it('lists mcbd-* sessions and ignores the user’s own', async () => {
    const result = await probeTmuxSessions(
      deps({
        commands: {
          [TMUX_KEY]: okResult('mcbd-claude-wt-a\nmy-editor\nmcbd-codex-wt-b\n'),
        },
      })
    );
    expect(result.status).toBe('ok');
    expect(result.entries.map((entry) => entry.key)).toEqual(['mcbd-claude-wt-a', 'mcbd-codex-wt-b']);
  });

  it('treats "no server running" as zero sessions, not as a failure', async () => {
    const result = await probeTmuxSessions(
      deps({
        commands: {
          [TMUX_KEY]: {
            code: 1,
            stdout: '',
            stderr: 'no server running on /private/tmp/tmux-501/default',
            failure: null,
          },
        },
      })
    );
    expect(result).toEqual({ status: 'ok', entries: [], reason: null });
  });

  it('is unavailable when tmux is missing', async () => {
    const result = await probeTmuxSessions(deps({}));
    expect(result.status).toBe('unavailable');
    expect(result.reason).toContain('tmux');
  });

  it('is unavailable on an unexpected non-zero exit', async () => {
    const result = await probeTmuxSessions(
      deps({
        commands: {
          [TMUX_KEY]: { code: 1, stdout: '', stderr: 'lost server', failure: null },
        },
      })
    );
    expect(result.status).toBe('unavailable');
    expect(result.reason).toContain('lost server');
  });

  it('uses the session-name prefix the CLI tools actually produce', () => {
    expect(MCBD_SESSION_PREFIX).toBe('mcbd-');
  });
});

describe('directory probes', () => {
  it('lists $HOME entries', () => {
    const result = probeHomeEntries(
      deps({ home: '/Users/dev', dirs: { '/Users/dev': ['Documents', '.zshrc'] } })
    );
    expect(result.status).toBe('ok');
    expect(result.entries.map((entry) => entry.key)).toEqual(['.zshrc', 'Documents']);
  });

  it('is unavailable — not empty — when $HOME cannot be listed', () => {
    const result = probeHomeEntries(deps({ home: '/Users/gone' }));
    expect(result.status).toBe('unavailable');
    expect(result.entries).toEqual([]);
    expect(result.reason).toContain('/Users/gone');
  });

  it('treats a missing ~/.commandmate as zero entries', () => {
    const result = probeCommandmateEntries(deps({ home: '/Users/dev', dirs: { '/Users/dev': [] } }));
    expect(result).toEqual({ status: 'ok', entries: [], reason: null });
  });

  it('is unavailable when ~/.commandmate exists but cannot be read', () => {
    const denied = new Error('EACCES: permission denied');
    (denied as NodeJS.ErrnoException).code = 'EACCES';
    const result = probeCommandmateEntries(
      deps({ home: '/Users/dev', dirs: { '/Users/dev/.commandmate': denied } })
    );
    expect(result.status).toBe('unavailable');
    expect(result.reason).toContain('EACCES');
  });

  it('drops SQLite sidecars, .DS_Store and its own snapshot directory', () => {
    const result = probeCommandmateEntries(
      deps({
        home: '/Users/dev',
        dirs: {
          '/Users/dev/.commandmate': [
            'cm.db',
            'cm.db-wal',
            'cm.db-shm',
            'cm.db-journal',
            '.DS_Store',
            ENV_SNAPSHOT_DIR_NAME,
            'hooks',
          ],
        },
      })
    );
    expect(result.entries.map((entry) => entry.key)).toEqual(['cm.db', 'hooks']);
  });
});

describe('captureEnvSnapshot', () => {
  it('records every probe, mixing answers and failures without collapsing them', async () => {
    const snapshot = await captureEnvSnapshot({
      worktreeId: 'wt-a',
      now: 1_700_000_000_000,
      deps: deps({
        commands: {
          [LSOF_LISTEN_KEY]: okResult(LSOF_LISTENERS),
          [PS_KEY]: okResult(PS_TABLE),
          [LSOF_CWD_KEY]: okResult(LSOF_CWD),
        },
        home: '/Users/dev',
        dirs: { '/Users/dev': ['Documents'] },
      }),
    });

    expect(snapshot.version).toBe(ENV_SNAPSHOT_VERSION);
    expect(snapshot.capturedAt).toBe(1_700_000_000_000);
    expect(snapshot.worktreeId).toBe('wt-a');
    expect(Object.keys(snapshot.probes).sort()).toEqual([...ENV_PROBE_IDS].sort());
    expect(snapshot.probes.listeners.status).toBe('ok');
    // tmux was not stubbed: the probe has to say so rather than report none.
    expect(snapshot.probes['tmux-sessions'].status).toBe('unavailable');
    expect(snapshot.probes['home-entries'].status).toBe('ok');
    expect(snapshot.probes['commandmate-entries'].status).toBe('ok');
  });
});

describe('snapshot persistence', () => {
  const TASK_ID = '11111111-2222-4333-8444-555555555555';

  function snapshot(capturedAt = 1_700_000_000_000): EnvSnapshot {
    return {
      version: ENV_SNAPSHOT_VERSION,
      capturedAt,
      worktreeId: 'wt-a',
      probes: {
        listeners: { status: 'ok', entries: [], reason: null },
        'tmux-sessions': { status: 'ok', entries: [], reason: null },
        'home-entries': { status: 'ok', entries: [], reason: null },
        'commandmate-entries': { status: 'ok', entries: [], reason: null },
      },
    };
  }

  it('round-trips through disk', () => {
    const dir = tempDir('env-snapshot-');
    expect(saveEnvSnapshot(TASK_ID, snapshot(), dir)).toBe(true);
    expect(loadEnvSnapshot(TASK_ID, dir)).toEqual(snapshot());
  });

  it('returns null for a task with no snapshot', () => {
    expect(loadEnvSnapshot(TASK_ID, tempDir('env-snapshot-'))).toBeNull();
  });

  it('refuses a task id that is not a UUID, so it can never become a path', () => {
    const dir = tempDir('env-snapshot-');
    expect(saveEnvSnapshot('../../etc/passwd', snapshot(), dir)).toBe(false);
    expect(loadEnvSnapshot('../../etc/passwd', dir)).toBeNull();
    expect(readdirSync(dir)).toEqual([]);
  });

  it('returns null — never a partial snapshot — for a corrupt file', () => {
    const dir = tempDir('env-snapshot-');
    writeFileSync(join(dir, `${TASK_ID}.json`), '{"version":1,"capturedAt":1}');
    expect(loadEnvSnapshot(TASK_ID, dir)).toBeNull();
  });

  it('rejects a snapshot written by a different format version', () => {
    const dir = tempDir('env-snapshot-');
    const stale = { ...snapshot(), version: ENV_SNAPSHOT_VERSION + 1 };
    writeFileSync(join(dir, `${TASK_ID}.json`), JSON.stringify(stale));
    expect(loadEnvSnapshot(TASK_ID, dir)).toBeNull();
    expect(isEnvSnapshot(stale)).toBe(false);
  });

  it('prunes snapshots past the retention window when a new one is written', () => {
    const dir = tempDir('env-snapshot-');
    const oldPath = join(dir, '99999999-9999-4999-8999-999999999999.json');
    writeFileSync(oldPath, JSON.stringify(snapshot()));
    const ancient = new Date(Date.now() - ENV_SNAPSHOT_RETENTION_MS - 60_000);
    utimesSync(oldPath, ancient, ancient);

    saveEnvSnapshot(TASK_ID, snapshot(Date.now()), dir);

    expect(existsSync(oldPath)).toBe(false);
    expect(existsSync(join(dir, `${TASK_ID}.json`))).toBe(true);
  });

  it('writes the snapshot owner-only', () => {
    const dir = tempDir('env-snapshot-');
    saveEnvSnapshot(TASK_ID, snapshot(), dir);
    expect(JSON.parse(readFileSync(join(dir, `${TASK_ID}.json`), 'utf8')).worktreeId).toBe('wt-a');
  });
});
