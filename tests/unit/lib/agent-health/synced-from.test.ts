/**
 * Issue #2924: `run.ts --synced-from <sha>` (passed by scripts/agent-health/daily.sh)
 * records how the runner synced; a hand run records nothing.
 */

import { describe, expect, it } from 'vitest';
import { parseAgentHealthArgs, syncRecordFor } from '@/lib/agent-health/cli-args';

const SHA = '0123456789abcdef0123456789abcdef01234567';
const HEAD = 'fedcba9876543210fedcba9876543210fedcba98';

describe('--synced-from', () => {
  it('accepts a 40-digit hex commit (separate or inline value)', () => {
    for (const argv of [['--synced-from', SHA], [`--synced-from=${SHA}`]]) {
      const parsed = parseAgentHealthArgs(argv);
      expect(parsed.ok && parsed.options.syncedFrom).toBe(SHA);
    }
  });

  it('is null when not given', () => {
    const parsed = parseAgentHealthArgs(['--tools', 'claude']);
    expect(parsed.ok && parsed.options.syncedFrom).toBeNull();
  });

  it.each([
    [['--synced-from']],
    [['--synced-from', '']],
    [['--synced-from', SHA.slice(0, 8)]],
    [['--synced-from', `${SHA}0`]],
    [['--synced-from', `${SHA.slice(0, 39)}g`]],
    [['--synced-from', 'HEAD']],
    [['--synced-from', '--out', 'x.json']],
  ])('rejects %j as an argument error (exit 2)', (argv) => {
    const parsed = parseAgentHealthArgs(argv);
    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.help).toBeFalsy();
    expect(!parsed.ok && parsed.error).toContain('--synced-from');
  });
});

describe('syncRecordFor', () => {
  it('records before = --synced-from and after = the checked HEAD', () => {
    expect(syncRecordFor(SHA, HEAD)).toEqual({ status: 'ok', before: SHA, after: HEAD });
  });

  it('records nothing for a hand run (no --synced-from)', () => {
    expect(syncRecordFor(null, HEAD)).toBeUndefined();
  });

  it('parsed options feed straight into the record', () => {
    const withSync = parseAgentHealthArgs(['--synced-from', SHA]);
    const without = parseAgentHealthArgs([]);
    expect(withSync.ok && syncRecordFor(withSync.options.syncedFrom, HEAD)).toEqual({
      status: 'ok',
      before: SHA,
      after: HEAD,
    });
    expect(without.ok && syncRecordFor(without.options.syncedFrom, HEAD)).toBeUndefined();
  });
});
