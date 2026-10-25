/**
 * Cross-Validation Tests: CLI vs Server type/constant consistency
 * Issue #518: [IA3-03] [IA3-04] Ensure CLI-side definitions match server-side
 */

import { describe, it, expect } from 'vitest';
import {
  AUTO_YES_DURATIONS as CLI_AUTO_YES_DURATIONS,
  parseDurationToMs,
} from '../../../../src/cli/config/duration-constants';
import { CLI_TOOL_IDS } from '../../../../src/cli/config/cli-tool-ids';

import type { AutoYesSuppressionReason as CliSuppressionReason } from '../../../../src/cli/types/api-responses';

// Import server-side sources of truth
import { AUTO_YES_DURATIONS as SERVER_AUTO_YES_DURATIONS } from '../../../../src/config/auto-yes-config';
import { CLI_TOOL_IDS as SERVER_CLI_TOOL_IDS } from '../../../../src/lib/cli-tools/types';
import type { AutoYesSuppressionReason as ServerSuppressionReason } from '../../../../src/lib/polling/auto-yes-resolver';

describe('[IA3-04] Duration constants cross-validation', () => {
  // Issue #3913: 1h〜24h. The CLI re-exports the server's definitions, so the
  // values below agree by construction; the reference check keeps it that way.
  it('CLI AUTO_YES_DURATIONS is the same reference as the server source of truth', () => {
    expect(CLI_AUTO_YES_DURATIONS).toBe(SERVER_AUTO_YES_DURATIONS);
  });

  it('parseDurationToMs maps all 24 flags to the server values, in order', () => {
    const parsed = Array.from({ length: 24 }, (_, i) => parseDurationToMs(`${i + 1}h`));
    expect(parsed).toEqual([...SERVER_AUTO_YES_DURATIONS]);
  });

  it('every server duration has a CLI flag', () => {
    for (const serverDuration of SERVER_AUTO_YES_DURATIONS) {
      expect(parseDurationToMs(`${serverDuration / 3_600_000}h`)).toBe(serverDuration);
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
 * union is the server's. Today both re-export the one declared in the
 * dependency-free `src/lib/polling/auto-yes-suppression-reason.ts` (tsconfig.cli.json
 * sets `"paths": {}`, so `src/cli` cannot import auto-yes-resolver, which imports
 * `@/config/auto-yes-config`); the assertions keep it that way should either side
 * ever grow its own copy again. Passing them says the two aliases agree, not that
 * every reason the server records at runtime is listed (Issue #3713).
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
      // Issue #3713: #3706's answer stopped with keys already in the input.
      'partial-answer',
      // Issue #3757: agy's trust screen, left to the launch.
      'startup-trust-unhandled',
      // Issue #3748: an AskUserQuestion confirm page, left to a human.
      'question-confirm-page',
      // Issue #3767: agy's dialog with no matching hook question.
      'no-hook-receipt',
      // Issue #3822: the contract lookup failed, so nothing was answered.
      'policy-lookup-failed',
      // Issue #3822: a question the agent asks, left to a human.
      'question-left-to-human',
      // Issue #3822: a permission dialog with no single allow-once row.
      'allow-once-unidentified',
      // Issue #3863: a question whose recommended option could not be told.
      'recommended-option-unidentified',
    ];
    const fromServer: ServerSuppressionReason[] = knownToCli;
    expect(new Set(fromServer).size).toBe(knownToCli.length);
  });
});
