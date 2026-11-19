/**
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest';
import { parseToolPolicyRefusal } from '@/lib/tool-policy/refusal-view';

const links = { terms: 'https://antigravity.google/terms', faq: 'https://antigravity.google/docs/faq' };

describe('parseToolPolicyRefusal (#4436)', () => {
  it('reads a 409 TOOL_POLICY_DENIED with its links as given', () => {
    expect(parseToolPolicyRefusal(409, { code: 'TOOL_POLICY_DENIED', error: 'why', links })).toEqual({ message: 'why', links });
  });
  it('falls back to the standard sentence when the error is missing', () => {
    expect(parseToolPolicyRefusal(409, { code: 'TOOL_POLICY_DENIED', links })?.message).toMatch(/Antigravity/);
  });
  it.each([
    [500, { code: 'TOOL_POLICY_DENIED', error: 'x', links }],
    [409, { code: 'OTHER', error: 'x', links }],
    [409, { code: 'TOOL_POLICY_DENIED', error: 'x' }],
    [409, { code: 'TOOL_POLICY_DENIED', error: 'x', links: { terms: 'javascript:alert(1)', faq: links.faq } }],
    [409, null],
  ])('is null for %s %j', (status, body) => {
    expect(parseToolPolicyRefusal(status, body)).toBeNull();
  });
});
