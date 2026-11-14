/**
 * env-clean: the flow record's directory is not this task's pollution (Issue #4396).
 *
 * #4367 records one tick per observation into `<home>/.commandmate/flow`
 * (`scripts/flow/record.mjs`). The tick runs while other workers verify, so
 * without the name in the runner's own bookkeeping (`COMMANDMATE_RUNTIME_ENTRY_NAMES`)
 * the first tick of a colleague's process would read as an entry this task left
 * behind and fail it with exit 20. The flow record is not the only bookkeeping
 * under `~/.commandmate`, either, so the negative controls pin that the sieve
 * still reports everything else — in `~/.commandmate` and in `$HOME` alike.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  diffEnvSnapshots,
  formatEnvCleanReport,
} from '@/lib/verification/env-clean-gate';
import {
  ENV_SNAPSHOT_VERSION,
  FLOW_DIR_NAME,
  probeCommandmateEntries,
  probeHomeEntries,
  type EnvProbeDeps,
  type EnvProbeId,
  type EnvProbeResult,
  type EnvSnapshot,
} from '@/lib/verification/env-snapshot';

const WORKTREE_ID = 'commandmate-issue-4396';
const WORKTREE_PATH = '/Users/dev/work/commandmate-issue-4396';
const CONTEXT = { worktreeId: WORKTREE_ID, worktreePath: WORKTREE_PATH };

const STARTED = 1_762_700_000_000;
const VERIFIED = STARTED + 60 * 60 * 1000;

/** Every fixture lives in `os.tmpdir()`; nothing is written outside it. */
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'cm-env-clean-flow-4396-'));
  roots.push(home);
  return home;
}

/** The real probes, pointed at a private HOME. */
function deps(home: string): EnvProbeDeps {
  return {
    run: async () => ({ code: 0, stdout: '', stderr: '', failure: null }),
    readDir: (path: string) => readdirSync(path),
    homeDir: () => home,
  };
}

function snapshot(home: string, capturedAt: number): EnvSnapshot {
  const probeDeps = deps(home);
  const empty: EnvProbeResult = { status: 'ok', entries: [], reason: null };
  const probes: Record<EnvProbeId, EnvProbeResult> = {
    listeners: empty,
    'tmux-sessions': empty,
    'home-entries': probeHomeEntries(probeDeps),
    'commandmate-entries': probeCommandmateEntries(probeDeps),
  };
  return { version: ENV_SNAPSHOT_VERSION, capturedAt, worktreeId: WORKTREE_ID, probes };
}

/** Snapshot, mutate, snapshot: the pair the gate actually compares. */
function diff(home: string, mutate: () => void) {
  const before = snapshot(home, STARTED);
  mutate();
  return diffEnvSnapshots(before, snapshot(home, VERIFIED), CONTEXT, {
    resolvePidCwd: () => null,
    sessionKills: [],
  });
}

describe('diffEnvSnapshots: the flow record is not this task’s pollution (#4396)', () => {
  it('names the flow dir exactly as scripts/flow/record.mjs does', () => {
    // record.mjs: `CM_FLOW_DIR`, or `path.join(home, '.commandmate', 'flow')`.
    expect(FLOW_DIR_NAME).toBe('flow');
  });

  it('a tick that creates ~/.commandmate/flow during the task is clean (positive)', () => {
    const home = makeHome();
    mkdirSync(join(home, '.commandmate'), { recursive: true });
    expect(probeCommandmateEntries(deps(home)).entries).toEqual([]);

    // The tick lands while the task runs: the dir and a repo's day file.
    const result = diff(home, () => {
      const repo = join(home, '.commandmate', 'flow', 'my-repo');
      mkdirSync(repo, { recursive: true });
      writeFileSync(join(repo, '2026-11-14.jsonl'), '{"kind":"tick"}\n');
    });
    expect(result.status).toBe('clean');
    expect(formatEnvCleanReport(result)).not.toContain('flow');
  });

  it('ticks that keep accumulating inside an existing ~/.commandmate/flow are clean (positive)', () => {
    const home = makeHome();
    const repo = join(home, '.commandmate', 'flow', 'my-repo');
    mkdirSync(repo, { recursive: true });
    writeFileSync(join(repo, '2026-11-14.jsonl'), '{"kind":"tick"}\n');

    // Another repository's first tick, then more lines in the same file.
    const result = diff(home, () => {
      mkdirSync(join(home, '.commandmate', 'flow', 'another-repo'));
      writeFileSync(join(repo, '2026-11-14.jsonl'), '{"kind":"tick"}\n{"kind":"tick"}\n');
    });
    expect(result.status).toBe('clean');
    expect(formatEnvCleanReport(result)).not.toContain('flow');
  });

  it('still reports an unknown entry under ~/.commandmate (negative)', () => {
    const home = makeHome();
    mkdirSync(join(home, '.commandmate'), { recursive: true });
    mkdirSync(join(home, '.commandmate', 'flow'));

    // A delegation writing `~/.commandmate/hooks` (#1722) must keep failing.
    const result = diff(home, () => mkdirSync(join(home, '.commandmate', 'hooks')));
    const probe = result.probes.find((p) => p.probeId === 'commandmate-entries')!;
    expect(result.status).toBe('violated');
    expect(probe.added.map((c) => c.key)).toEqual(['hooks']);
    expect(formatEnvCleanReport(result)).toContain('+ hooks');
  });

  it('does not ignore a `flow` entry directly under $HOME (negative)', () => {
    const home = makeHome();
    // `~/flow` is not ours; only `~/.commandmate/flow` is the record.
    const result = diff(home, () => mkdirSync(join(home, FLOW_DIR_NAME)));

    const probe = probeHomeEntries(deps(home));
    expect(probe.entries.map((entry) => entry.key)).toEqual([FLOW_DIR_NAME]);

    const homeProbe = result.probes.find((p) => p.probeId === 'home-entries')!;
    expect(result.status).toBe('violated');
    expect(homeProbe.added.map((c) => c.key)).toEqual([FLOW_DIR_NAME]);
  });
});
