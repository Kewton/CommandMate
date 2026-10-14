/**
 * env-clean names the additions it excused as another worktree's, also when the report is clean (Issue #3683)
 *
 * @vitest-environment node
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { diffEnvSnapshots, formatEnvCleanReport } from '@/lib/verification/env-clean-gate';
import {
  ENV_SNAPSHOT_VERSION,
  type EnvEntry,
  type EnvProbeId,
  type EnvProbeResult,
  type EnvSnapshot,
} from '@/lib/verification/env-snapshot';

const WORKTREE_ID = 'commandmate-issue-3683';
const SIBLING_ENTRY = '.commandmate-demo-vitest-30733';

function entry(key: string): EnvEntry {
  return { key, detail: null, anchor: null };
}

function probe(entries: EnvEntry[]): EnvProbeResult {
  return { status: 'ok', entries, reason: null };
}

function snapshot(homeEntries: EnvEntry[]): EnvSnapshot {
  const empty = probe([]);
  const probes: Record<EnvProbeId, EnvProbeResult> = {
    listeners: empty,
    'tmux-sessions': empty,
    'home-entries': probe(homeEntries),
    'commandmate-entries': empty,
  };
  return { version: ENV_SNAPSHOT_VERSION, capturedAt: 1_700_000_000_000, worktreeId: WORKTREE_ID, probes };
}

describe('env-clean report names excused sibling-worktree additions (#3683)', () => {
  let root: string | null = null;

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = null;
  });

  function report(after: EnvEntry[]): string {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'env-clean-3683-')));
    const self = join(root, 'commandmate-issue-3683');
    const sibling = join(root, 'commandmate-issue-3640');
    mkdirSync(self);
    mkdirSync(sibling);
    const diff = diffEnvSnapshots(
      snapshot([entry('Documents')]),
      snapshot([entry('Documents'), ...after]),
      { worktreeId: WORKTREE_ID, worktreePath: self },
      { resolvePidCwd: () => sibling }
    );
    return formatEnvCleanReport(diff);
  }

  it('lists the excused name with its reason when the probe is clean', () => {
    const text = report([entry(SIBLING_ENTRY)]);
    expect(text).toContain('home-entries clean');
    expect(text).toContain(`ignored (attributed to another worktree): ${SIBLING_ENTRY}`);
  });

  it('prints no such line when nothing was attributed to another worktree', () => {
    const text = report([]);
    expect(text).toContain('home-entries clean');
    expect(text).not.toContain('attributed to another worktree');
  });

  it('keeps the VIOLATED enumeration unchanged', () => {
    const text = report([entry(SIBLING_ENTRY), entry('stray-dir')]);
    expect(text).toContain('home-entries VIOLATED');
    expect(text).toContain(`· ${SIBLING_ENTRY} (ignored: belongs to another worktree)`);
    expect(text).not.toContain('ignored (attributed to another worktree)');
  });
});
