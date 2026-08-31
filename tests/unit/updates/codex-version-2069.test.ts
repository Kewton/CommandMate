/**
 * `~/.codex/version.json` reading, and the update verdict built from it
 * (Issue #2069).
 *
 * The acceptance criterion this suite exists for is stated negatively —
 * 「`version.json` が無い / 壊れている環境で落ちない」 — and a negative is
 * exactly the kind of claim that rots silently: a `readFileSync` that starts
 * throwing on a shape nobody wrote a case for takes down `GET
 * /api/agents/versions`, which is rendered inside the agent pane. So every way
 * the file can be wrong gets its own case, by name.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  CODEX_VERSION_FILE_MAX_BYTES,
  CODEX_VERSION_FILENAME,
  evaluateCodexUpdate,
  getCodexHomeForVersionRead,
  getCodexVersionFilePath,
  readCodexVersionFile,
} from '@/lib/updates/codex-version';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cm-codex-version-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Write `content` as the version file and read it back through the module. */
function readWith(content: string) {
  const path = join(dir, CODEX_VERSION_FILENAME);
  writeFileSync(path, content, 'utf-8');
  return readCodexVersionFile({ path });
}

describe('[#2069] readCodexVersionFile — the real shape', () => {
  it('reads the file codex actually writes', () => {
    // Verbatim from ~/.codex/version.json on 2026-08-31, codex-cli 0.149.1.
    const result = readWith(
      '{"latest_version":"0.151.0","last_checked_at":"2026-08-30T15:12:18.082219Z","dismissed_version":null}'
    );

    expect(result.readable).toBe(true);
    expect(result.latestVersion).toBe('0.151.0');
    expect(result.lastCheckedAt).toBe('2026-08-30T15:12:18.082219Z');
    // null is the ordinary value, not a failure.
    expect(result.dismissedVersion).toBeNull();
  });

  it('keeps a dismissed_version when codex has written one', () => {
    const result = readWith('{"latest_version":"0.151.0","dismissed_version":"0.151.0"}');
    expect(result.dismissedVersion).toBe('0.151.0');
  });

  it('normalizes a decorated version string to major.minor.patch', () => {
    expect(readWith('{"latest_version":"v0.151.0-beta.1"}').latestVersion).toBe('0.151.0');
  });
});

describe('[#2069] readCodexVersionFile — fail-open, every way the file can be wrong', () => {
  it('does not throw when the file is missing', () => {
    const result = readCodexVersionFile({ path: join(dir, 'nope.json') });
    expect(result.readable).toBe(false);
    expect(result.latestVersion).toBeNull();
  });

  it('does not throw when the path is a directory', () => {
    const path = join(dir, 'as-a-dir');
    mkdirSync(path);
    expect(readCodexVersionFile({ path }).readable).toBe(false);
  });

  it('does not throw on invalid JSON (a half-written file caught mid-rename)', () => {
    expect(readWith('{"latest_version":"0.15').readable).toBe(false);
  });

  it('does not throw when the JSON is not an object', () => {
    expect(readWith('"0.151.0"').readable).toBe(false);
    expect(readWith('[{"latest_version":"0.151.0"}]').readable).toBe(false);
    expect(readWith('null').readable).toBe(false);
  });

  it('reports the file as read but each bad field as null', () => {
    const result = readWith('{"latest_version":42,"dismissed_version":{},"last_checked_at":7}');
    expect(result.readable).toBe(true);
    expect(result.latestVersion).toBeNull();
    expect(result.dismissedVersion).toBeNull();
    expect(result.lastCheckedAt).toBeNull();
  });

  it('yields nulls for a version string with no version in it', () => {
    expect(readWith('{"latest_version":"unknown"}').latestVersion).toBeNull();
  });

  it('discards an oversized file rather than parsing it', () => {
    const padding = 'x'.repeat(CODEX_VERSION_FILE_MAX_BYTES + 1);
    const result = readWith(JSON.stringify({ latest_version: '0.151.0', pad: padding }));
    expect(result.readable).toBe(false);
    expect(result.latestVersion).toBeNull();
  });

  it('always reports the path it tried, even on failure', () => {
    const path = join(dir, 'nope.json');
    expect(readCodexVersionFile({ path }).path).toBe(path);
  });
});

describe('[#2069] getCodexHomeForVersionRead', () => {
  it('honours an absolute $CODEX_HOME', () => {
    expect(getCodexHomeForVersionRead({ CODEX_HOME: '/tmp/codex-elsewhere' })).toBe(
      '/tmp/codex-elsewhere'
    );
  });

  it('falls back to ~/.codex when $CODEX_HOME is unset', () => {
    expect(getCodexHomeForVersionRead({})).toMatch(/\.codex$/);
  });

  it('answers UNKNOWN for a relative $CODEX_HOME, rather than falling back', () => {
    // `hooks-config` forwards a relative value to codex verbatim, and codex
    // resolves it against the AGENT's worktree cwd — so the file is at
    // `<worktree>/.codex-shared/version.json` and this process cannot say which
    // worktree. Falling back to ~/.codex would not be "no data": it would be an
    // unrelated install's version reported with full confidence.
    expect(getCodexHomeForVersionRead({ CODEX_HOME: '.codex-shared' })).toBeNull();
    expect(getCodexHomeForVersionRead({ CODEX_HOME: '../shared/.codex' })).toBeNull();
    expect(getCodexVersionFilePath({ CODEX_HOME: '.codex-shared' })).toBeNull();
  });

  it('reads nothing at all when the directory is unknown', () => {
    const result = readCodexVersionFile({ env: { CODEX_HOME: '.codex-shared' } });
    expect(result.readable).toBe(false);
    expect(result.latestVersion).toBeNull();
    expect(result.path).toBeNull();
  });

  it('refuses a virtual-filesystem $CODEX_HOME (#1774), matching hooks-config', () => {
    // Here the fallback IS right: `resolveSafeDirectory` rejects the value and
    // hands codex `~/.codex` on its launch line, so that is where codex writes.
    const resolved = getCodexHomeForVersionRead({ CODEX_HOME: '/proc/self/codex' });
    expect(resolved).not.toBeNull();
    expect(resolved).not.toContain('/proc');
    expect(resolved).toMatch(/\.codex$/);
  });

  it('builds the version path inside the resolved home', () => {
    expect(getCodexVersionFilePath({ CODEX_HOME: '/tmp/codex-elsewhere' })).toBe(
      `/tmp/codex-elsewhere/${CODEX_VERSION_FILENAME}`
    );
  });
});

describe('[#2069] evaluateCodexUpdate', () => {
  const file = (latest: string | null, dismissed: string | null = null) => ({
    latestVersion: latest,
    dismissedVersion: dismissed,
    lastCheckedAt: null,
    path: '/tmp/version.json',
    readable: true,
  });

  it('reports an update when latest is strictly newer', () => {
    const status = evaluateCodexUpdate('0.149.1', file('0.151.0'));
    expect(status.updateAvailable).toBe(true);
    expect(status.latestVersion).toBe('0.151.0');
    expect(status.source).toBe('version.json');
  });

  it('reports no update when the versions are equal', () => {
    expect(evaluateCodexUpdate('0.151.0', file('0.151.0')).updateAvailable).toBe(false);
  });

  it('reports no update when the installed build is NEWER than the file', () => {
    // codex's own check is only as fresh as the last time it ran.
    expect(evaluateCodexUpdate('0.152.0', file('0.151.0')).updateAvailable).toBe(false);
  });

  it('reports no update when codex is not installed', () => {
    expect(evaluateCodexUpdate(null, file('0.151.0')).updateAvailable).toBe(false);
  });

  it('reports no update when the file said nothing', () => {
    const status = evaluateCodexUpdate('0.149.1', {
      latestVersion: null,
      dismissedVersion: null,
      lastCheckedAt: null,
      path: '/tmp/version.json',
      readable: false,
    });
    expect(status.updateAvailable).toBe(false);
    expect(status.source).toBeNull();
  });

  it('flags a dismissal WITHOUT hiding the update', () => {
    const status = evaluateCodexUpdate('0.149.1', file('0.151.0', '0.151.0'));
    expect(status.updateAvailable).toBe(true);
    expect(status.dismissedInCodex).toBe(true);
  });

  it('does not flag a dismissal of some OTHER version', () => {
    const status = evaluateCodexUpdate('0.149.1', file('0.151.0', '0.150.0'));
    expect(status.dismissedInCodex).toBe(false);
  });
});
