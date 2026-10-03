/**
 * Stage 2 of the setup guide tells agents about `commandmate remote pair`
 * (Issue #3141). The stage order is pinned by the landing page and is not
 * touched here.
 */

import { describe, it, expect } from 'vitest';
import { SETUP_GUIDE } from '../../../../src/cli/docs/setup-guide';

/** The text of one `## ` section, from its heading to the next `## `. */
function section(heading: string): string {
  const start = SETUP_GUIDE.indexOf(`\n## ${heading}`);
  expect(start, heading).toBeGreaterThanOrEqual(0);
  const rest = SETUP_GUIDE.slice(start + 1);
  const next = rest.indexOf('\n## ', 1);
  return next === -1 ? rest : rest.slice(0, next);
}

describe('Stage 2 covers `commandmate remote pair`', () => {
  const pair = section('Stage 2: Pair your phone');

  it('gets the link as text without reopening the tunnel', () => {
    expect(pair).toContain('`commandmate remote pair`');
    expect(pair).toContain('`pairingUrl`');
    expect(pair).toMatch(/without reopening the tunnel/);
  });

  it('uses it for a cut-off or lost QR code that is still unused', () => {
    expect(pair).toMatch(/cut off in the agent's chat pane/);
    expect(pair).toMatch(/has not been used yet/);
    expect(pair).toMatch(/earlier link stops working/);
  });

  it('keeps stop-then-remote for used or expired codes', () => {
    expect(pair).toMatch(/already used: run `commandmate remote stop`, then `commandmate remote` again/);
    expect(pair).toMatch(/`remote pair` prints nothing for a used or expired code/);
    expect(pair).toContain('`--pairing-expires 30m`');
  });
});
