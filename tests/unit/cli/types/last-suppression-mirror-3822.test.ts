/**
 * Issue #3822: the CLI's copy of `autoYes.lastSuppression`
 * (`src/cli/types/api-responses.ts`) has the same fields as the record the
 * server publishes (`AutoYesPolicySuppression` in
 * `src/lib/polling/auto-yes-suppression-state.ts`).
 *
 * `current-output-mirror-3300.test.ts` deliberately does not compare nested
 * shapes, so a field added to the record server-side (#3822's first fix added
 * `policyLookupFailed`) went unnoticed by the CLI. The key sets are held equal
 * at compile time; value types may stay looser on the CLI (wire strings, #1843),
 * but every server value must be assignable to the copy.
 *
 * @vitest-environment node
 */

import { afterEach, describe, expect, it } from 'vitest';
import type { CurrentOutputResponse } from '@/cli/types/api-responses';
import {
  clearPolicySuppressions,
  getLastPolicySuppression,
  recordPolicySuppression,
  type AutoYesPolicySuppression,
} from '@/lib/polling/auto-yes-suppression-state';

type CliLastSuppression = NonNullable<NonNullable<CurrentOutputResponse['autoYes']>['lastSuppression']>;

type AssertNever<T extends never> = T;
type AssertAssignable<Super, Sub extends Super> = Sub;
type _NoServerOnlyField = AssertNever<Exclude<keyof AutoYesPolicySuppression, keyof CliLastSuppression>>;
type _NoCliOnlyField = AssertNever<Exclude<keyof CliLastSuppression, keyof AutoYesPolicySuppression>>;
type _ServerValuesFit = AssertAssignable<CliLastSuppression, AutoYesPolicySuppression>;

/** Every field of the CLI copy, listed once; `satisfies` keeps it to real keys. */
const CLI_FIELDS = ['reason', 'mode', 'promptType', 'pattern', 'at', 'episodeId'] as const satisfies readonly (keyof CliLastSuppression)[];
type _ListIsComplete = AssertNever<Exclude<keyof CliLastSuppression, (typeof CLI_FIELDS)[number]>>;

afterEach(() => {
  clearPolicySuppressions();
});

describe('[#3822] lastSuppression: the CLI copy and the server record', () => {
  it('is enforced at compile time (see the assertions above this describe)', () => {
    expect(new Set(CLI_FIELDS).size).toBe(CLI_FIELDS.length);
  });

  it('a policy-lookup-failed record carries only fields the CLI knows', () => {
    recordPolicySuppression('wt-3822', 'claude', 'claude', {
      reason: 'policy-lookup-failed',
      mode: null,
      promptType: 'yes_no',
    });
    const record = getLastPolicySuppression('wt-3822', 'claude', 'claude');
    expect(record).not.toBeNull();
    for (const key of Object.keys(record ?? {})) {
      expect(CLI_FIELDS as readonly string[]).toContain(key);
    }
  });
});
