/**
 * Issue #4480 (review-4452-3 P3-2): a use of antigravity inside the version list's
 * TTL adds the antigravity row without probing claude and codex again.
 *
 * #4452 made a use (or a declaration) drop the cached list at once so the
 * antigravity row shows without waiting out the TTL — but the drop re-ran every
 * tool's `--version`, one more claude / codex probe than the TTL allows. The
 * detector and the catalog already add only the tool that became probeable; the
 * version list now does the same. After the TTL, and with `force`, every tool is
 * probed as before.
 *
 * Fake binaries only (tests/helpers/fake-agy-path.ts): the real agy never runs.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { installFakeAgyPath, type FakeAgyPath } from '@tests/helpers/fake-agy-path';
import {
  AGENT_VERSIONS_CACHE_TTL_MS,
  clearAgentVersionsCache,
  getAgentVersions,
} from '@/lib/updates/agent-versions';
import { noteAntigravityUse, resetAntigravityUseForTest } from '@/lib/tool-policy/version-probe-gate';

let fake: FakeAgyPath;

beforeEach(() => {
  fake = installFakeAgyPath();
  clearAgentVersionsCache();
  resetAntigravityUseForTest();
});

afterEach(() => {
  clearAgentVersionsCache();
  resetAntigravityUseForTest();
  fake.restore();
});

describe('[#4480] agents version list after a use', () => {
  it('4480 (I4): a use inside the TTL adds the antigravity row without re-running claude or codex', async () => {
    const before = await getAgentVersions({ now: 1_000 });
    expect(before.find((row) => row.tool === 'antigravity')).toBeUndefined();

    noteAntigravityUse();
    const after = await getAgentVersions({ now: 1_001 });

    expect(fake.callsOf('claude')).toEqual(['claude --version']);
    expect(fake.callsOf('codex')).toEqual(['codex --version']);
    expect(fake.callsOf('agy')).toEqual(['agy --version']);
    expect(after.find((row) => row.tool === 'antigravity')?.installed).toBe('1.1.18');
    // Same rows as before plus antigravity, in the list's order (by tool id).
    expect(after.map((row) => row.tool)).toEqual([...before.map((row) => row.tool), 'antigravity'].sort());
    expect(after.find((row) => row.tool === 'claude')).toEqual(before.find((row) => row.tool === 'claude'));

    // And the merged list is what the cache now answers inside the TTL.
    await getAgentVersions({ now: 1_002 });
    expect(fake.callsOf('agy')).toEqual(['agy --version']);
    expect(fake.callsOf('claude')).toEqual(['claude --version']);
  });

  it('4480 (I4): concurrent callers right after the use share one agy probe', async () => {
    await getAgentVersions({ now: 1_000 });
    noteAntigravityUse();

    const [a, b] = await Promise.all([getAgentVersions({ now: 1_001 }), getAgentVersions({ now: 1_001 })]);

    expect(fake.callsOf('agy')).toEqual(['agy --version']);
    expect(fake.callsOf('claude')).toEqual(['claude --version']);
    expect(a).toEqual(b);
  });

  it('4480: after the TTL every tool is probed again, as before', async () => {
    await getAgentVersions({ now: 1_000 });
    noteAntigravityUse();
    await getAgentVersions({ now: 1_001 });

    await getAgentVersions({ now: 1_001 + AGENT_VERSIONS_CACHE_TTL_MS + 1 });

    expect(fake.callsOf('claude')).toEqual(['claude --version', 'claude --version']);
    expect(fake.callsOf('agy')).toEqual(['agy --version', 'agy --version']);
  });

  it('4480: force re-probes every tool, as before', async () => {
    await getAgentVersions({ now: 1_000 });
    noteAntigravityUse();

    await getAgentVersions({ now: 1_001, force: true });

    expect(fake.callsOf('claude')).toEqual(['claude --version', 'claude --version']);
    expect(fake.callsOf('agy')).toEqual(['agy --version']);
  });

  it('4480: without a use or declaration, the cached list is reused and agy never runs', async () => {
    await getAgentVersions({ now: 1_000 });
    await getAgentVersions({ now: 1_001 });

    expect(fake.callsOf('claude')).toEqual(['claude --version']);
    expect(fake.callsOf('agy')).toEqual([]);
  });
});

/**
 * Review-4480 (codex P2-1 / opus P3-2): a forced fetch (`force`, `?refresh=1`, an
 * update just finished) that arrives while the antigravity row is being added must
 * re-probe every tool and return that, and the add must not write its older rows
 * back afterwards.
 *
 * The fakes here read their version from `<sandbox>/<name>.version` (so the test
 * can "update" claude and codex mid-way), and each `agy` call waits for
 * `<sandbox>/agy.release.<n>` (n = its call number), so the add's probe can be
 * held while the forced fetch runs.
 */
describe('[#4480] a forced fetch while the antigravity row is being added (I4\')', () => {
  let held: FakeAgyPath;

  const versionedFake = (name: string): string => [
    'root="${0%/bin/' + name + '}"',
    'read -r v < "$root/' + name + '.version"',
    'echo "$v"',
  ].join('\n');

  const heldAgy = [
    'root="${0%/bin/agy}"',
    'n=0',
    'while IFS= read -r line; do case "$line" in "agy "*) n=$((n+1)) ;; esac; done < "$root/calls.log"',
    'while [ ! -f "$root/agy.release.$n" ]; do :; done',
    "echo '1.1.18'",
  ].join('\n');

  const setVersion = (name: string, value: string): void => {
    fs.writeFileSync(path.join(held.root, `${name}.version`), `${value}\n`);
  };
  const release = (n: number): void => {
    fs.writeFileSync(path.join(held.root, `agy.release.${n}`), '');
  };
  const waitFor = async (check: () => boolean): Promise<void> => {
    for (let i = 0; i < 300 && !check(); i += 1) await new Promise((r) => setTimeout(r, 10));
    expect(check()).toBe(true);
  };
  const installedOf = (rows: { tool: string; installed: string | null }[], tool: string) =>
    rows.find((row) => row.tool === tool)?.installed;

  beforeEach(() => {
    fake.restore();
    held = installFakeAgyPath({
      extraBinaries: { claude: versionedFake('claude'), codex: versionedFake('codex'), agy: heldAgy },
    });
    fake = held;
    setVersion('claude', '2.1.0 (Claude Code)');
    setVersion('codex', 'codex-cli 0.100.0');
  });

  afterEach(() => {
    // Let any held probe finish before the sandbox goes.
    for (let n = 1; n <= 5; n += 1) release(n);
  });

  it('4480 (I4\'): force during the add returns every tool re-probed, and the add does not write its old rows back', async () => {
    const first = await getAgentVersions({ now: 1_000 });
    expect(installedOf(first, 'codex')).toBe('0.100.0');

    noteAntigravityUse();
    const adding = getAgentVersions({ now: 1_001 }); // the add: agy call 1, held
    await waitFor(() => held.callsOf('agy').length === 1);

    setVersion('claude', '2.2.0 (Claude Code)');
    setVersion('codex', 'codex-cli 0.101.0');
    const forced = getAgentVersions({ now: 1_002, force: true }); // full: agy call 2, held
    await waitFor(() => held.callsOf('agy').length === 2);
    release(2);
    const forcedRows = await forced;

    expect(installedOf(forcedRows, 'claude')).toBe('2.2.0');
    expect(installedOf(forcedRows, 'codex')).toBe('0.101.0');
    expect(installedOf(forcedRows, 'antigravity')).toBe('1.1.18');

    release(1);
    await adding;

    // The next plain fetch inside the TTL answers the forced rows, not the add's.
    const next = await getAgentVersions({ now: 1_003 });
    expect(installedOf(next, 'claude')).toBe('2.2.0');
    expect(installedOf(next, 'codex')).toBe('0.101.0');
    expect(held.callsOf('claude')).toHaveLength(2);
  });

  it('4480 (I4\'): clearing the cache during the add keeps the add from writing its old rows back', async () => {
    await getAgentVersions({ now: 1_000 });
    noteAntigravityUse();
    const adding = getAgentVersions({ now: 1_001 });
    await waitFor(() => held.callsOf('agy').length === 1);

    clearAgentVersionsCache();
    setVersion('codex', 'codex-cli 0.101.0');
    release(1);
    await adding;
    release(2);

    const next = await getAgentVersions({ now: 1_002 });
    expect(installedOf(next, 'codex')).toBe('0.101.0');
  });
});

