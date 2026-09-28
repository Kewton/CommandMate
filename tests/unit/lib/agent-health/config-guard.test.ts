/**
 * Issue #2878: machine-singleton files are saved before `prepareLaunch` and
 * put back byte for byte afterwards, proved by sha256. Uses throwaway files
 * only — never the real `~/.codex` / `~/.gemini`.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  currentSha256,
  restoreSnapshot,
  restoreTrustState,
  sha256Of,
  snapshotFile,
  withoutMarker,
} from '@/lib/agent-health/config-guard';
import { decideExitCode } from '@/lib/agent-health/report';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-health-guard-'));
});

afterEach(() => {
  // Undo the read-only case before removing.
  for (const entry of fs.readdirSync(dir)) fs.chmodSync(path.join(dir, entry), 0o700);
  fs.chmodSync(dir, 0o700);
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('snapshotFile / restoreSnapshot', () => {
  it('rewrite → restore gives back the same bytes (sha256 equal)', () => {
    const file = path.join(dir, 'hooks.json');
    const original = Buffer.from('{\n  "hooks": { "Stop": [] }\n}\né', 'utf8');
    fs.writeFileSync(file, original, { mode: 0o600 });
    const snapshot = snapshotFile(file);
    expect(snapshot.sha256).toBe(sha256Of(original));

    fs.writeFileSync(file, '{"hooks":{"Stop":[{"command":"probe"}]}}');
    expect(currentSha256(file)).not.toBe(snapshot.sha256);

    const entry = restoreSnapshot(snapshot);
    expect(entry).toEqual({ path: file, restored: true, kind: 'hook-config' });
    expect(fs.readFileSync(file).equals(original)).toBe(true);
    expect(currentSha256(file)).toBe(snapshot.sha256);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it('does not rewrite a file that was never changed', () => {
    const file = path.join(dir, 'hooks.json');
    fs.writeFileSync(file, 'same');
    const past = new Date('2020-01-01T00:00:00Z');
    fs.utimesSync(file, past, past);
    const entry = restoreSnapshot(snapshotFile(file));
    expect(entry.restored).toBe(true);
    expect(fs.statSync(file).mtime.getTime()).toBe(past.getTime());
  });

  it('a file that did not exist is restored by removing it', () => {
    const file = path.join(dir, 'created-by-probe.json');
    const snapshot = snapshotFile(file);
    expect(snapshot.sha256).toBeNull();
    fs.writeFileSync(file, '{}');
    expect(restoreSnapshot(snapshot).restored).toBe(true);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('a failed restore is reported (restored: false) and makes the run exit 2', () => {
    const file = path.join(dir, 'hooks.json');
    fs.writeFileSync(file, 'original');
    const snapshot = snapshotFile(file);
    fs.writeFileSync(file, 'changed by the probe');
    fs.chmodSync(file, 0o400);
    fs.chmodSync(dir, 0o500);

    const entry = restoreSnapshot(snapshot);
    expect(entry.restored).toBe(false);
    expect(entry.detail).toBeTruthy();

    const exitCode = decideExitCode({
      schemaVersion: 1,
      startedAt: 'a',
      completedAt: 'b',
      host: { commandmateCommit: 'c', node: 'd' },
      tools: [],
      safety: { globalConfigRestored: [entry], tmuxSocket: 'cm-agent-health' },
    });
    expect(exitCode).toBe(2);
  });
});

describe('restoreTrustState', () => {
  const MARKER = 'cm-agent-health-';

  it('puts the bytes back when the probe’s own entry is the only difference', () => {
    const file = path.join(dir, 'settings.json');
    const before = '{\n  "model": "flash",\n  "trustedWorkspaces": ["/Users/me/repo"]\n}\n';
    fs.writeFileSync(file, before);
    const snapshot = snapshotFile(file);
    fs.writeFileSync(
      file,
      JSON.stringify({ model: 'flash', trustedWorkspaces: ['/Users/me/repo', '/private/var/T/cm-agent-health-ab12/antigravity'] })
    );
    const entry = restoreTrustState(snapshot, MARKER);
    expect(entry).toMatchObject({ restored: true, kind: 'trust-state' });
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
  });

  it('leaves the file alone when something else changed as well', () => {
    const file = path.join(dir, 'settings.json');
    fs.writeFileSync(file, JSON.stringify({ model: 'flash', trustedWorkspaces: [] }));
    const snapshot = snapshotFile(file);
    const concurrent = JSON.stringify({
      model: 'pro',
      trustedWorkspaces: ['/private/var/T/cm-agent-health-ab12/antigravity'],
    });
    fs.writeFileSync(file, concurrent);
    const entry = restoreTrustState(snapshot, MARKER);
    expect(entry).toMatchObject({ restored: false, kind: 'trust-state' });
    expect(fs.readFileSync(file, 'utf8')).toBe(concurrent);
  });

  it('withoutMarker drops keys, elements and strings that mention the marker', () => {
    expect(
      withoutMarker({ a: ['x', 'cm-agent-health-1'], 'cm-agent-health-2': { k: 1 }, b: 'cm-agent-health-3' }, MARKER)
    ).toEqual({ a: ['x'] });
  });
});
