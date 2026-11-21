/**
 * Issue #4498 (P3): a relay refused by rule 0 is told three ways, and they are not
 * the same sentence — refused at creation (no relay was opened), opened and then
 * withdrawn by the bound `/send`, and opened with a withdrawal the server could not
 * confirm (`relayWithdrawn: false`: it may still be open).
 *
 * @vitest-environment node
 */

import { describe, it, expect } from 'vitest';
import {
  formatToolPolicyDenialLines,
  toolPolicyDenialFromResponse,
} from '../../../../src/cli/utils/tool-policy-failure';
import { ANTIGRAVITY_FAQ_URL, ANTIGRAVITY_TERMS_URL, RELAY_TOOL_POLICY_DENIED } from '../../../../src/lib/tool-policy/policy';

const RELAY_ID = 'rly_0123456789abcdef';
const POLICY = {
  tool: 'antigravity',
  operation: 'relay',
  origin: 'relay',
  reason: 'ANTIGRAVITY_CONSUMER_TERMS',
  declaration: 'personal',
  links: { terms: ANTIGRAVITY_TERMS_URL, faq: ANTIGRAVITY_FAQ_URL },
  unlock: '',
  endpoint: 'to',
};

function fourthLine(payload: Record<string, unknown>): string {
  return formatToolPolicyDenialLines(toolPolicyDenialFromResponse(409, { code: RELAY_TOOL_POLICY_DENIED, error: 'x', policy: POLICY, ...payload })!)[3];
}

describe('Issue #4498 P3: the relay refusal says whether the relay was opened, and whether it was withdrawn', () => {
  it('4498 refused at creation (no relayId): the relay was not opened', () => {
    const line = fourthLine({});
    expect(line).toContain('The relay was not opened and nothing was sent');
    expect(line).not.toContain('withdrawn');
  });

  it('4498 refused at the bound /send, withdrawal confirmed: opened, withdrawn — not "not opened"', () => {
    for (const extra of [{ relayWithdrawn: true }, {}]) {
      const line = fourthLine({ relayId: RELAY_ID, sendOutcome: 'not_sent', ...extra });
      expect(line).toContain(`The relay ${RELAY_ID} had been opened and was withdrawn; nothing was sent`);
      expect(line).not.toContain('was not opened');
      expect(line).toContain('`to` end');
    }
  });

  it('4498 refused at the bound /send, withdrawal not confirmed: never "was withdrawn"; says how to cancel it', () => {
    const line = fourthLine({ relayId: RELAY_ID, sendOutcome: 'not_sent', relayWithdrawn: false });
    expect(line).not.toContain('was withdrawn');
    expect(line).not.toContain('was not opened');
    expect(line).toContain('its withdrawal could not be confirmed');
    expect(line).toContain(`commandmate relays cancel ${RELAY_ID}`);
    expect(line).toContain('nothing was sent');
  });
});
