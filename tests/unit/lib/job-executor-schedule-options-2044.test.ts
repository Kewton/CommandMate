/**
 * `resolveScheduleExecuteOptions()` composes two sources and invents none
 * (Issue #2044).
 *
 * The function that #2044 renamed from `resolveModelOption()` and taught to
 * delegate. Three properties are pinned here, because each one is a way the
 * composition could go wrong without any other suite noticing:
 *
 * 1. **It delegates.** Whatever `resolveScheduleCommandOptions()` answers for a
 *    row, this function returns unchanged — no filtering, no re-gating. A copy
 *    of the column's rules at this layer is the exact defect #1914 found
 *    (`cliToolId === 'copilot'` hard-coded beside the parser's Set) and #2044
 *    found one field later.
 * 2. **vibe-local still reads the DB.** Its model lives in the worktree row, not
 *    in CMATE.md, and delegating must not have dropped that branch.
 * 3. **The two sources stay ordered and disjoint.** CMATE.md wins; the DB is the
 *    fallback.
 *
 * The argv these options become, and the fact that `executeSchedule()` actually
 * calls this function, are
 * `tests/integration/schedule-opencode-run-options-2044.test.ts`.
 *
 * @vitest-environment node
 */

import { describe, it, expect } from 'vitest';
import { resolveScheduleExecuteOptions } from '@/lib/job-executor';
import { resolveScheduleCommandOptions } from '@/lib/cmate-cli-tool-parser';
import { CLI_TOOL_IDS } from '@/lib/cli-tools/types';
import type { ScheduleEntry } from '@/types/cmate';

function entry(overrides: Partial<ScheduleEntry> = {}): ScheduleEntry {
  return {
    name: 'nightly',
    cronExpression: '0 3 * * *',
    message: 'do something',
    cliToolId: 'claude',
    enabled: true,
    permission: '',
    ...overrides,
  };
}

const NO_DB_MODEL = { path: '/repos/wt', vibe_local_model: null };
const WITH_DB_MODEL = { path: '/repos/wt', vibe_local_model: 'qwen3:8b' };

describe('it delegates the CMATE.md half (Issue #2044)', () => {
  /**
   * Every row shape the column can produce, against every tool id. Anything the
   * parser's resolver answers must come back untouched.
   */
  const ROWS: ReadonlyArray<Partial<ScheduleEntry>> = [
    {},
    { model: 'provider/model' },
    { agent: 'plan' },
    { variant: 'high' },
    { continueSession: true },
    { title: 'nightly' },
    { model: 'provider/model', agent: 'plan', variant: 'high', continueSession: true, title: 'n' },
  ];

  for (const cliToolId of CLI_TOOL_IDS) {
    it.each(ROWS)(`${cliToolId}: returns the parser's answer verbatim for %j`, (row) => {
      const e = entry({ cliToolId, ...row });
      const delegated = resolveScheduleCommandOptions(e);
      // vibe-local has a second source; every other tool must match exactly.
      if (cliToolId === 'vibe-local') return;
      expect(resolveScheduleExecuteOptions(e, NO_DB_MODEL)).toEqual(delegated);
    });
  }

  it('carries opencode run options through, which is the whole point', () => {
    expect(
      resolveScheduleExecuteOptions(
        entry({ cliToolId: 'opencode', agent: 'plan', variant: 'high' }),
        NO_DB_MODEL,
      ),
    ).toEqual({ agent: 'plan', variant: 'high' });
  });

  it('answers undefined for every tool asked for nothing', () => {
    for (const cliToolId of CLI_TOOL_IDS) {
      expect(resolveScheduleExecuteOptions(entry({ cliToolId }), NO_DB_MODEL), cliToolId)
        .toBeUndefined();
    }
  });
});

describe('vibe-local still resolves its model from the DB (Issue #2044)', () => {
  it('uses the worktree row when the DB names a model', () => {
    expect(resolveScheduleExecuteOptions(entry({ cliToolId: 'vibe-local' }), WITH_DB_MODEL))
      .toEqual({ model: 'qwen3:8b' });
  });

  it('answers undefined when the DB names none', () => {
    expect(resolveScheduleExecuteOptions(entry({ cliToolId: 'vibe-local' }), NO_DB_MODEL))
      .toBeUndefined();
  });

  it('is the only tool the DB model applies to', () => {
    for (const cliToolId of CLI_TOOL_IDS) {
      if (cliToolId === 'vibe-local') continue;
      expect(resolveScheduleExecuteOptions(entry({ cliToolId }), WITH_DB_MODEL), cliToolId)
        .toBeUndefined();
    }
  });

  it('does not let a CMATE.md column smuggle a model into vibe-local', () => {
    // The parser refuses `vibe-local --model x` outright, so `entry.model` can
    // only be set by a caller that built the entry by hand. It must still lose
    // to the DB rather than reaching argv, because vibe-local is in neither Set.
    expect(
      resolveScheduleExecuteOptions(
        entry({ cliToolId: 'vibe-local', model: 'from-cmate' }),
        WITH_DB_MODEL,
      ),
    ).toEqual({ model: 'qwen3:8b' });
  });
});

describe('the two sources stay ordered (Issue #2044)', () => {
  it('prefers the CMATE.md model when a tool somehow has both', () => {
    expect(
      resolveScheduleExecuteOptions(
        entry({ cliToolId: 'copilot', model: 'from-cmate' }),
        WITH_DB_MODEL,
      ),
    ).toEqual({ model: 'from-cmate' });
  });

  it('never merges the DB model into an options object the column produced', () => {
    const resolved = resolveScheduleExecuteOptions(
      entry({ cliToolId: 'opencode', agent: 'plan' }),
      WITH_DB_MODEL,
    );
    expect(resolved).toEqual({ agent: 'plan' });
    expect(resolved).not.toHaveProperty('model');
  });
});
