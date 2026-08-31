/**
 * Issue #2132 — the startup line that says ".env is right there and empty here".
 *
 * Every consumer of these variables has a defensible default, so a server that
 * received none of them starts, listens and answers requests. What it does not
 * do is send one push notification, and it may open a different database than
 * the operator believes they are looking at. During the Epic #2002 device UAT
 * (2026-08-29) the ONLY signal was the VAPID warning, and reading that as "push
 * is broken" rather than "the environment is empty" cost two UAT rounds.
 *
 * The check lives beside the VAPID self-check in `server.ts` and carries the
 * same contract: fail-open, never blocks `listen`, silent when healthy.
 *
 * This file sits under `tests/unit/scripts/` with the two shell tests it
 * belongs to: it pins the *detection* of the failure those scripts cause.
 *
 * @vitest-environment node
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import {
  formatDotenvReportLines,
  inspectDotenvLoad,
  parseDotenvKeys,
  runDotenvSelfCheck,
} from '@/lib/env';
import { removeTempDir } from '@tests/helpers/temp-dir';

const REPO_ROOT = path.resolve(__dirname, '../../..');

describe('parseDotenvKeys', () => {
  it('reads the assignment forms a .env actually uses', () => {
    const keys = parseDotenvKeys(
      [
        '# comment',
        '',
        'CM_PORT=3000',
        '  CM_BIND=127.0.0.1',
        'export CM_ROOT_DIR=/tmp',
        'CM_VAPID_SUBJECT = https://example.com',
      ].join('\n'),
    );
    expect(keys).toEqual(['CM_PORT', 'CM_BIND', 'CM_ROOT_DIR', 'CM_VAPID_SUBJECT']);
  });

  it('ignores comments, blanks and lines that assign nothing', () => {
    expect(parseDotenvKeys('# CM_PORT=3000\n\njust some prose\n')).toEqual([]);
  });

  it('reports a repeated key once', () => {
    expect(parseDotenvKeys('CM_PORT=3000\nCM_PORT=3011\n')).toEqual(['CM_PORT']);
  });

  it('returns names only — never a value', () => {
    // The file it parses holds CM_VAPID_PRIVATE_KEY. Values must not be able to
    // reach a log line by accident.
    const keys = parseDotenvKeys('CM_VAPID_PRIVATE_KEY=super-secret-value\n');
    expect(keys).toEqual(['CM_VAPID_PRIVATE_KEY']);
    expect(JSON.stringify(keys)).not.toContain('super-secret-value');
  });
});

describe('inspectDotenvLoad', () => {
  let cwd: string;

  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-dotenv-'));
  });

  afterEach(() => {
    removeTempDir(cwd);
  });

  const writeEnv = (contents: string) => fs.writeFileSync(path.join(cwd, '.env'), contents);

  it('has nothing to say when there is no .env', () => {
    expect(inspectDotenvLoad({ cwd, env: {} })).toBeNull();
  });

  it('has nothing to say when the .env declares no variables', () => {
    writeEnv('# everything is commented out\n#CM_PORT=3000\n');
    expect(inspectDotenvLoad({ cwd, env: {} })).toBeNull();
  });

  it('flags the accident: the file declares variables and none of them arrived', () => {
    writeEnv('CM_PORT=3000\nCM_VAPID_PUBLIC_KEY=abc\nCM_DB_PATH=/tmp/db.sqlite\n');
    const inspection = inspectDotenvLoad({ cwd, env: { PATH: '/usr/bin' } });
    expect(inspection).not.toBeNull();
    expect(inspection?.loadFailed).toBe(true);
    expect(inspection?.declaredKeys).toHaveLength(3);
    expect(inspection?.presentKeys).toEqual([]);
    expect(inspection?.envPath).toBe(path.join(cwd, '.env'));
  });

  it('stays quiet when even one variable arrived', () => {
    // The all-or-nothing threshold is the point. A partially applied .env has
    // ordinary explanations (a key commented out mid-edit, a value overridden
    // on the command line); warning about those trains the reader to skip the
    // line, and then the real event is invisible again.
    writeEnv('CM_PORT=3000\nCM_VAPID_PUBLIC_KEY=abc\n');
    const inspection = inspectDotenvLoad({ cwd, env: { CM_PORT: '3011' } });
    expect(inspection?.loadFailed).toBe(false);
    expect(inspection?.presentKeys).toEqual(['CM_PORT']);
  });

  it('counts an empty string as present — `CM_BIND=` was still applied', () => {
    writeEnv('CM_BIND=\n');
    expect(inspectDotenvLoad({ cwd, env: { CM_BIND: '' } })?.loadFailed).toBe(false);
  });

  it('says nothing about a .env it cannot read', () => {
    // Unreadable is a permissions question, not a loading question, and a
    // diagnostic that guesses is worse than one that abstains.
    const envPath = path.join(cwd, '.env');
    fs.writeFileSync(envPath, 'CM_PORT=3000\n');
    fs.chmodSync(envPath, 0o000);
    try {
      // Running as root defeats the chmod; skip the assertion rather than
      // assert something that is false for the actual conditions.
      if (typeof process.getuid === 'function' && process.getuid() === 0) return;
      expect(inspectDotenvLoad({ cwd, env: {} })).toBeNull();
    } finally {
      fs.chmodSync(envPath, 0o600);
    }
  });
});

describe('formatDotenvReportLines', () => {
  const failed = (declaredKeys: string[]) => ({
    envPath: '/srv/commandmate/.env',
    declaredKeys,
    presentKeys: [],
    loadFailed: true,
  });

  it('prints nothing when the load worked', () => {
    expect(
      formatDotenvReportLines({
        envPath: '/srv/commandmate/.env',
        declaredKeys: ['CM_PORT'],
        presentKeys: ['CM_PORT'],
        loadFailed: false,
      }),
    ).toEqual([]);
  });

  it('names the file, the count, the cause and the supported way out', () => {
    const lines = formatDotenvReportLines(failed(['CM_PORT', 'CM_VAPID_PUBLIC_KEY'])).join('\n');
    expect(lines).toContain('/srv/commandmate/.env');
    expect(lines).toContain('2 variable(s)');
    expect(lines).toContain('CM_VAPID_PUBLIC_KEY');
    expect(lines).toContain('#2132');
    expect(lines).toContain('scripts/load-env.sh');
    expect(lines).toContain('./scripts/restart-nobuild.sh');
    expect(lines).toContain('./scripts/start.sh --daemon');
  });

  it('truncates a long list instead of printing a wall of names', () => {
    const keys = Array.from({ length: 12 }, (_, i) => `CM_KEY_${i}`);
    const lines = formatDotenvReportLines(failed(keys)).join('\n');
    expect(lines).toContain('and 4 more');
    expect(lines).toContain('CM_KEY_7');
    expect(lines).not.toContain('CM_KEY_8');
  });
});

describe('runDotenvSelfCheck', () => {
  let cwd: string;
  let warnings: string[];

  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-dotenv-run-'));
    warnings = [];
  });

  afterEach(() => {
    removeTempDir(cwd);
  });

  const warn = (message: string) => warnings.push(message);

  it('prints NOTHING for a healthy install — which is what makes a line meaningful', () => {
    fs.writeFileSync(path.join(cwd, '.env'), 'CM_PORT=3000\n');
    runDotenvSelfCheck({ cwd, env: { CM_PORT: '3000' }, warn });
    expect(warnings).toEqual([]);
  });

  it('prints nothing when there is no .env at all', () => {
    runDotenvSelfCheck({ cwd, env: {}, warn });
    expect(warnings).toEqual([]);
  });

  it('reports the accident', () => {
    fs.writeFileSync(path.join(cwd, '.env'), 'CM_PORT=3000\nCM_DB_PATH=/tmp/db\n');
    const inspection = runDotenvSelfCheck({ cwd, env: {}, warn });
    expect(inspection?.loadFailed).toBe(true);
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings.join('\n')).toContain('NOT ONE of them is set');
  });

  it('never throws — a diagnostic must not be why a server fails to start', () => {
    expect(() =>
      runDotenvSelfCheck({
        cwd,
        env: {},
        warn: () => {
          throw new Error('logger exploded');
        },
      }),
    ).not.toThrow();
  });
});

describe('Issue #2132: the check is wired into startup', () => {
  const server = fs.readFileSync(path.join(REPO_ROOT, 'server.ts'), 'utf8');

  it('server.ts calls it', () => {
    expect(server).toContain('runDotenvSelfCheck()');
  });

  it('calls it BEFORE the VAPID check — the cause has to be read before the symptom', () => {
    const dotenvAt = server.indexOf('runDotenvSelfCheck()');
    const vapidAt = server.indexOf('runVapidSelfCheck()');
    expect(dotenvAt).toBeGreaterThan(-1);
    expect(vapidAt).toBeGreaterThan(-1);
    expect(dotenvAt).toBeLessThan(vapidAt);
  });

  it('runs before initializeWorktrees(), like the checks around it', () => {
    expect(server.indexOf('runDotenvSelfCheck()')).toBeLessThan(
      server.indexOf('await initializeWorktrees()'),
    );
  });
});
