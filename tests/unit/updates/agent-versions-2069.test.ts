/**
 * The version table both update surfaces render (Issue #2069).
 *
 * The TTL cache is the part worth pinning rather than the fan-out: this module
 * is read immediately after an update finishes, so a cache that could not be
 * bypassed would keep showing the OLD version and make the Issue's acceptance
 * criterion 「完了後に `codex --version` が上がる」 invisible from the UI. That
 * is why `getAgentVersions({ force: true })` exists and why it has its own case.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// `vi.mock` factories are hoisted above every other statement in the file, so
// the doubles they close over have to be hoisted with them.
const { runDetectorVersionProbe, readCodexVersionFile } = vi.hoisted(() => ({
  runDetectorVersionProbe: vi.fn(),
  readCodexVersionFile: vi.fn(),
}));

vi.mock('@/lib/detection/version-probes', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/detection/version-probes')>();
  return { ...actual, runDetectorVersionProbe };
});

vi.mock('@/lib/updates/codex-version', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/updates/codex-version')>();
  return { ...actual, readCodexVersionFile };
});

import { DETECTOR_VERSION_PROBES } from '@/lib/detection/version-probes';
import { clearAgentVersionsCache, getAgentVersions } from '@/lib/updates/agent-versions';

/** codex's file says 0.151.0 is out; every probed tool answers `version`. */
function machine(version: string | null, latest: string | null = '0.151.0') {
  runDetectorVersionProbe.mockResolvedValue(version);
  readCodexVersionFile.mockReturnValue({
    latestVersion: latest,
    dismissedVersion: null,
    lastCheckedAt: null,
    path: '/tmp/version.json',
    readable: latest !== null,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  clearAgentVersionsCache();
});

describe('[#2069] getAgentVersions', () => {
  it('returns one row per probe-table tool, sorted', async () => {
    machine('1.0.0');
    const rows = await getAgentVersions();
    expect(rows.map((row) => row.tool)).toEqual(Object.keys(DETECTOR_VERSION_PROBES).sort());
  });

  it('gives codex the latest/dismissed columns and every other tool only `installed`', async () => {
    machine('0.149.1');
    const rows = await getAgentVersions();

    const codex = rows.find((row) => row.tool === 'codex');
    expect(codex).toMatchObject({
      installed: '0.149.1',
      latestVersion: '0.151.0',
      updateAvailable: true,
      updatable: true,
      source: 'version.json',
    });

    // 実装内容 2: 他ツールは installed 版のみ. Nothing here claims to know what
    // a newer claude would be, because nothing on this machine says.
    for (const row of rows.filter((r) => r.tool !== 'codex')) {
      expect(row.latestVersion).toBeNull();
      expect(row.updateAvailable).toBe(false);
      expect(row.source).toBeNull();
      expect(row.updatable).toBe(false);
    }
  });

  it('reports a tool that is not installed as installed: null, not an error', async () => {
    machine(null, null);
    const rows = await getAgentVersions();
    expect(rows.every((row) => row.installed === null)).toBe(true);
    expect(rows.every((row) => row.updateAvailable === false)).toBe(true);
  });

  it('does not re-probe inside the TTL', async () => {
    machine('0.149.1');
    await getAgentVersions({ now: 1_000 });
    const afterFirst = runDetectorVersionProbe.mock.calls.length;
    await getAgentVersions({ now: 2_000 });
    expect(runDetectorVersionProbe.mock.calls.length).toBe(afterFirst);
  });

  it('re-probes when `force` is set — the post-update read', async () => {
    machine('0.149.1');
    await getAgentVersions({ now: 1_000 });
    const afterFirst = runDetectorVersionProbe.mock.calls.length;

    machine('0.151.0');
    const rows = await getAgentVersions({ force: true, now: 1_100 });

    expect(runDetectorVersionProbe.mock.calls.length).toBeGreaterThan(afterFirst);
    expect(rows.find((row) => row.tool === 'codex')?.installed).toBe('0.151.0');
    // And with the new version installed, the banner must be gone.
    expect(rows.find((row) => row.tool === 'codex')?.updateAvailable).toBe(false);
  });

  it('shares one fan-out between concurrent first callers', async () => {
    machine('0.149.1');
    const [a, b] = await Promise.all([getAgentVersions(), getAgentVersions()]);
    expect(a).toBe(b);
    expect(runDetectorVersionProbe.mock.calls.length).toBe(
      Object.keys(DETECTOR_VERSION_PROBES).length
    );
  });

  it('answers with an empty list rather than throwing when the fan-out fails', async () => {
    runDetectorVersionProbe.mockRejectedValue(new Error('probe exploded'));
    await expect(getAgentVersions()).resolves.toEqual([]);
  });

  it('does not throw when the version file read throws', async () => {
    runDetectorVersionProbe.mockResolvedValue('0.149.1');
    readCodexVersionFile.mockImplementation(() => {
      throw new Error('unreadable');
    });
    await expect(getAgentVersions()).resolves.toEqual([]);
  });
});
