/**
 * Issue #3749: both places the embedded agent doc shows `relays cancel` say
 * that a cancel during the delivery itself is refused (409, exit 2) — the
 * behaviour #3732 added to the route and the CLI. Without it an agent reads
 * "withdraw one; nothing is delivered" and takes exit 2 for a broken command.
 */

import { describe, expect, it } from 'vitest';
import {
  AGENT_DELEGATION_GUIDE,
  AGENT_OPERATIONS_GUIDE,
} from '@/cli/docs/agent-operations';

/** The paragraph block that follows the `relays cancel` example line. */
function sectionAfterCancelExample(doc: string): string {
  const at = doc.indexOf('commandmate relays cancel <relay-id>');
  expect(at).toBeGreaterThanOrEqual(0);
  return doc.slice(at, at + 800);
}

describe('relays cancel documents the delivering refusal (Issue #3749)', () => {
  it.each([
    ['AGENT_OPERATIONS_GUIDE', AGENT_OPERATIONS_GUIDE],
    ['AGENT_DELEGATION_GUIDE', AGENT_DELEGATION_GUIDE],
  ])('%s says a cancel during delivery is 409 / exit 2', (_name, doc) => {
    const section = sectionAfterCancelExample(doc);
    expect(section).toMatch(/409/);
    expect(section).toMatch(/exit(s)? 2/);
    expect(section).toMatch(/deliver/);
  });
});
