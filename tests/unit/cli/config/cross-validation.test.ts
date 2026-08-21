/**
 * Cross-Validation Tests: CLI vs Server type/constant consistency
 * Issue #518: [IA3-03] [IA3-04] Ensure CLI-side definitions match server-side
 */

import { describe, it, expect } from 'vitest';
import { DURATION_MAP, parseDurationToMs } from '../../../../src/cli/config/duration-constants';
import { CLI_TOOL_IDS } from '../../../../src/cli/config/cli-tool-ids';

import type { AutoYesSuppressionReason as CliSuppressionReason } from '../../../../src/cli/types/api-responses';

// Import server-side sources of truth
import { ALLOWED_DURATIONS as SERVER_ALLOWED_DURATIONS } from '../../../../src/config/auto-yes-config';
import { CLI_TOOL_IDS as SERVER_CLI_TOOL_IDS } from '../../../../src/lib/cli-tools/types';
import type { AutoYesSuppressionReason as ServerSuppressionReason } from '../../../../src/lib/polling/auto-yes-resolver';

describe('[IA3-04] Duration constants cross-validation', () => {
  it('CLI DURATION_MAP values match server ALLOWED_DURATIONS', () => {
    const cliDurationValues = Object.values(DURATION_MAP).sort();
    const serverDurationValues = [...SERVER_ALLOWED_DURATIONS].sort();
    expect(cliDurationValues).toEqual(serverDurationValues);
  });

  it('parseDurationToMs output values are all in server ALLOWED_DURATIONS', () => {
    for (const key of Object.keys(DURATION_MAP)) {
      const ms = parseDurationToMs(key);
      expect(ms).not.toBeNull();
      expect((SERVER_ALLOWED_DURATIONS as readonly number[]).includes(ms!)).toBe(true);
    }
  });

  it('every server ALLOWED_DURATION has a CLI mapping', () => {
    const cliValues = new Set(Object.values(DURATION_MAP));
    for (const serverDuration of SERVER_ALLOWED_DURATIONS) {
      expect(cliValues.has(serverDuration)).toBe(true);
    }
  });
});

describe('[DR2-07] CLI_TOOL_IDS cross-validation', () => {
  it('CLI CLI_TOOL_IDS matches server CLI_TOOL_IDS', () => {
    expect([...CLI_TOOL_IDS].sort()).toEqual([...SERVER_CLI_TOOL_IDS].sort());
  });

  it('CLI CLI_TOOL_IDS has same length as server', () => {
    expect(CLI_TOOL_IDS.length).toBe(SERVER_CLI_TOOL_IDS.length);
  });
});

describe('[#757] CLI_TOOL_IDS single source of truth', () => {
  // After Issue #757, src/cli/config/cli-tool-ids.ts re-exports CLI_TOOL_IDS from
  // src/lib/cli-tools/types.ts (the single source of truth) instead of copying the
  // literal. This asserts the *same array reference* is shared, which guarantees
  // there is no second literal that could silently drift. If anyone reintroduces a
  // standalone copy, this reference check fails even when the values happen to match.
  it('CLI CLI_TOOL_IDS is the same reference as the server source of truth', () => {
    expect(CLI_TOOL_IDS).toBe(SERVER_CLI_TOOL_IDS);
  });
});

/**
 * Issue #1843: AutoYesSuppressionReason cross-validation.
 *
 * `wait` maps every suppression reason to its own wording (SUPPRESSION_CAUSE in
 * src/cli/commands/wait.ts is a `Record` over the union, so a reason with no
 * wording will not compile). That guarantee is only worth anything if the CLI's
 * copy of the union tracks the server's — and it has to be a copy: tsconfig.cli.json
 * sets `"paths": {}`, so `src/cli` cannot import auto-yes-resolver, which imports
 * `@/config/auto-yes-config`.
 *
 * The two aliases below are the guard. Add a reason to the server union and
 * `_ServerReasonsAllKnownToCli` stops compiling, failing `npx tsc --noEmit`;
 * fixing it by extending the CLI union then breaks the Record in wait.ts until
 * someone decides what the new reason should say. Neither step can be skipped,
 * which is what stops a new reason from silently reporting itself as
 * "by contract policy" the way `agent-launch-dialog` did.
 *
 * Type-level on purpose: a union has no runtime representation to compare, and
 * inventing a parallel array of literals to compare would just be a third copy
 * that can drift.
 */
type AssertAssignable<Super, Sub extends Super> = Sub;
type _ServerReasonsAllKnownToCli = AssertAssignable<CliSuppressionReason, ServerSuppressionReason>;
type _CliReasonsAllExistOnServer = AssertAssignable<ServerSuppressionReason, CliSuppressionReason>;

describe('[#1843] AutoYesSuppressionReason cross-validation', () => {
  it('is enforced at compile time (see the assertions above this describe)', () => {
    // Types are erased, so there is nothing to assert at runtime. This test
    // exists so the guard is discoverable from the suite rather than only from
    // a tsc failure; the behavioural coverage lives in
    // tests/unit/cli/commands/wait.test.ts ("Issue #1843").
    const knownToCli: CliSuppressionReason[] = [
      'mode-off',
      'deny-pattern',
      'deny-pattern-unusable',
      'type-not-allowed',
      'agent-launch-dialog',
      // Issue #1924: the generic prompt estimator matched a frame the tool's own
      // dialog detector would not vouch for.
      'unclassified-frame',
    ];
    const fromServer: ServerSuppressionReason[] = knownToCli;
    expect(new Set(fromServer).size).toBe(knownToCli.length);
  });
});
