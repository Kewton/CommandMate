/**
 * Issue #4210, item 3: `CM_LOG_DIR` in the CLI's security log is judged the way
 * `getLogDir()` judges it for every other log writer.
 *
 * Each case is a contrast: the same value through `getLogDir()` (the server's
 * resolver) and through `getSecurityLogPath()`. They must agree on refusing a
 * virtual-filesystem path and on keeping a relative value relative — resolved
 * against the cwd of the process that writes, which is the CLI's here.
 *
 * Real `fs`, no module mocks; the one append that happens goes into a
 * directory made under `os.tmpdir()` and removed afterwards.
 *
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { join } from 'path';
import { getSecurityLogPath, logSecurityEvent } from '../../../../src/cli/utils/security-logger';
import { getLogDir } from '../../../../src/config/log-config';
import { resetSafeDirectoryWarnings } from '../../../../src/config/safe-directory';

const HOME_FILE = join(homedir(), '.commandmate-security.log');

let base: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'cm-4210-security-log-'));
  resetSafeDirectoryWarnings();
  vi.stubEnv('MCBD_LOG_DIR', '');
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(base, { recursive: true, force: true });
});

describe('a CM_LOG_DIR that getLogDir() refuses (Issue #4210)', () => {
  it.each(['/proc/x', '/sys/x', '/dev/x'])('%s is refused here too', (value) => {
    vi.stubEnv('CM_LOG_DIR', value);
    // The server's resolver refuses it ...
    expect(getLogDir()).not.toBe(value);
    // ... and so does the CLI's. Before the fix this was `${value}/security.log`.
    expect(getSecurityLogPath()).toBe(HOME_FILE);
  });

  it('a relative value whose absolute form is in /proc is refused by both', () => {
    vi.spyOn(process, 'cwd').mockReturnValue('/');
    vi.stubEnv('CM_LOG_DIR', 'proc/x');
    expect(getLogDir()).not.toBe('proc/x');
    expect(getSecurityLogPath()).toBe(HOME_FILE);
  });
});

describe('what does not change (negative controls)', () => {
  it('a relative value stays relative in both, so each writer resolves it against its own cwd', () => {
    vi.stubEnv('CM_LOG_DIR', 'rel-logs');
    expect(getLogDir()).toBe('rel-logs');
    expect(getSecurityLogPath()).toBe(join(getLogDir(), 'security.log'));
  });

  it('an ordinary absolute value is used as given, and the event is appended there', () => {
    vi.stubEnv('CM_LOG_DIR', base);
    expect(getLogDir()).toBe(base);
    expect(getSecurityLogPath()).toBe(join(base, 'security.log'));

    logSecurityEvent({ timestamp: '2026-11-07T00:00:00.000Z', command: 'start', action: 'success' });
    expect(readFileSync(join(base, 'security.log'), 'utf8')).toContain('[SUCCESS] start');
  });

  it('unset or empty, it is the file in the home directory', () => {
    vi.stubEnv('CM_LOG_DIR', '');
    expect(getSecurityLogPath()).toBe(HOME_FILE);
  });
});

describe('the CLI build constraint', () => {
  it('imports nothing through an @/ alias (tsconfig.cli.json has no paths)', () => {
    const source = readFileSync(join(__dirname, '../../../../src/cli/utils/security-logger.ts'), 'utf8');
    expect(source).not.toMatch(/from '@\//);
    expect(source).not.toMatch(/config\/log-config'/);
  });
});
