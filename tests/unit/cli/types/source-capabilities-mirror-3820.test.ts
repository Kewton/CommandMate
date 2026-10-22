/**
 * Issue #3820 PR 2 (review item 5): the CLI's copy of
 * `structuredEvents.source.capabilities` (`src/cli/types/api-responses.ts`)
 * names every capability the server declares (`AgentSourceCapabilities` in
 * `src/lib/hooks/sources/types.ts`), and the `capture --json` examples of the
 * CLI guide (ja and en) show claude's declaration as it is.
 *
 * `permissionAllowSuppressesDialog` (#3820) was added server-side with neither
 * the copy nor the examples following; nor had `transcriptHistory` (#2197) and
 * `stopReportsSelfResume` (#2614) before it. The key sets are held equal at
 * compile time — the CLI's value types stay looser (wire strings, optional for
 * an older server) — and the examples are compared by value.
 *
 * @vitest-environment node
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import type { CurrentOutputResponse } from '@/cli/types/api-responses';
import { claudeAgentEventSource } from '@/lib/hooks/sources/claude/source';
import { getAgentEventSource } from '@/lib/hooks/sources/registry';
import { CLI_TOOL_IDS } from '@/lib/cli-tools/types';
import type { AgentSourceCapabilities } from '@/lib/hooks/sources/types';

type CliCapabilities = NonNullable<
  NonNullable<CurrentOutputResponse['structuredEvents']>['source']
>['capabilities'];

type AssertNever<T extends never> = T;
type _NoServerOnlyCapability = AssertNever<Exclude<keyof AgentSourceCapabilities, keyof CliCapabilities>>;
type _NoCliOnlyCapability = AssertNever<Exclude<keyof CliCapabilities, keyof AgentSourceCapabilities>>;

/** Every capability of the CLI copy, listed once; `satisfies` keeps it to real keys. */
const CLI_CAPABILITIES = [
  'supportedEvents',
  'configScope',
  'decisionTimeoutSeconds',
  'permissionHookPredictsDialog',
  'sessionStartMayArriveLate',
  'permissionReplyReleasesPrompt',
  'permissionAllowSuppressesDialog',
  'eventIdentity',
  'resync',
  'transcriptHistory',
  'stopReportsSelfResume',
] as const satisfies readonly (keyof CliCapabilities)[];
type _ListIsComplete = AssertNever<Exclude<keyof CliCapabilities, (typeof CLI_CAPABILITIES)[number]>>;

/** The `capabilities` object of the guide's `capture --json` example. */
function exampleCapabilities(guide: string): unknown {
  const text = readFileSync(join(process.cwd(), guide), 'utf8');
  const start = text.indexOf('"capabilities": {');
  expect(start).toBeGreaterThan(-1);
  const open = text.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === '{') depth += 1;
    if (text[i] === '}') depth -= 1;
    if (depth === 0) return JSON.parse(text.slice(open, i + 1));
  }
  throw new Error(`unterminated capabilities example in ${guide}`);
}

describe('[#3820] source capabilities: the CLI copy, the server and the guide', () => {
  it('is enforced at compile time (see the assertions above this describe)', () => {
    expect(new Set(CLI_CAPABILITIES).size).toBe(CLI_CAPABILITIES.length);
  });

  it('every source declares only capabilities the CLI knows', () => {
    for (const tool of CLI_TOOL_IDS) {
      for (const key of Object.keys(getAgentEventSource(tool).capabilities)) {
        expect(CLI_CAPABILITIES as readonly string[]).toContain(key);
      }
    }
  });

  it.each(['docs/user-guide/cli-operations-guide.md', 'docs/en/user-guide/cli-operations-guide.md'])(
    '%s: the capture --json example is claude’s declaration, every column',
    (guide) => {
      expect(exampleCapabilities(guide)).toEqual(JSON.parse(JSON.stringify(claudeAgentEventSource.capabilities)));
    }
  );
});
