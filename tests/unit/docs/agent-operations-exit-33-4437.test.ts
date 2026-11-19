/**
 * Issue #4437 PR2 (D2): the guide built into the CLI (`commandmate docs --section
 * agent-operations` / `delegation`) says what the file guide says — exit 33 for a
 * send, ask, respond or relay the tool policy refuses — and no longer tells an agent
 * that every relay refusal is exit 2.
 *
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest';
import { AGENT_DELEGATION_GUIDE, AGENT_OPERATIONS_GUIDE } from '../../../src/cli/docs/agent-operations';

/** The block of `text` from the line starting with `start` up to the next blank line. */
function block(text: string, start: RegExp): string {
  const lines = text.split('\n');
  const at = lines.findIndex((line) => start.test(line));
  if (at < 0) return '';
  const end = lines.findIndex((line, index) => index > at && line.trim() === '');
  return lines.slice(at, end < 0 ? undefined : end).join('\n');
}

describe('the built-in guide names exit 33 (Issue #4437, D2)', () => {
  it('the full exit-code list has 33 between 32 and 99', () => {
    const list = block(AGENT_OPERATIONS_GUIDE, /^ {2}0 {3}SUCCESS/);
    expect(list).toMatch(/^ {2}33 +TOOL POLICY DENIED +- /m);
    expect(list.indexOf('  32 ')).toBeLessThan(list.indexOf('  33 '));
    expect(list.indexOf('  33 ')).toBeLessThan(list.indexOf('  99 '));
  });

  it("ask's extra exit codes include 33", () => {
    const codes = block(AGENT_OPERATIONS_GUIDE, /wait's \(0 \/ 10 \/ 21 \/ 124\) plus:/);
    expect(codes).toMatch(/^ {4}33 +TOOL POLICY DENIED/m);
  });

  it.each([
    ['agent-operations', AGENT_OPERATIONS_GUIDE],
    ['delegation', AGENT_DELEGATION_GUIDE],
  ])('%s: a relay refusal says antigravity at either end is exit 33, the others exit 2', (_name, guide) => {
    const paragraph = block(guide, /^ {2}The relay is refused \(exit 2, nothing sent\)/);
    expect(paragraph).not.toBe('');
    expect(paragraph).toMatch(/antigravity/);
    expect(paragraph).toMatch(/exit 33/);
  });
});
