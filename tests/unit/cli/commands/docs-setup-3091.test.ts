/**
 * The setup guide and the CLI's own token (Issue #3091).
 *
 * After `commandmate remote` with its default `--auth all`, this machine's CLI
 * needs a token too, and the token goes only to the phone, so Stages 3 to 5
 * (all CLI) could not be done after Stage 2. The stage order is pinned by the
 * landing page, so what is pinned here is that the guide tells the agent to
 * pair the phone last, and puts the `--auth remote-only` choice in Stage 2
 * itself; plus the Codex network note and where a repository is registered.
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

describe('the setup guide pairs the phone after the CLI stages', () => {
  const intro = SETUP_GUIDE.split(/^## Stage 1:/m)[0];

  it('tells the agent, up front, to do Stage 2 last and why', () => {
    expect(intro).toMatch(/Do Stage 2 \(Pair your phone\) last/);
    expect(intro).toContain('`--auth all`');
    expect(intro).toMatch(/finish Stages 3 to 5 first, then pair the phone/);
  });

  it('asks the person, inside Stage 2, when to pair and whether to use --auth remote-only', () => {
    const pair = section('Stage 2: Pair your phone');

    expect(pair).toMatch(/Pair the phone last \(recommended\)/);
    expect(pair).toContain('--auth remote-only');
    expect(pair).toMatch(/every process on this machine, agents included, can operate CommandMate/);
    expect(pair.split('### Ask the person first')[1]).toMatch(/--auth remote-only/);
  });

  it('tells Codex how to get network for its shell', () => {
    expect(intro).toMatch(/If you are Codex: your shell has no network by default/);
    expect(intro).toContain('`/permissions`');
    expect(intro).toContain('"Ask for approval"');
  });

  it('says a repository is registered in the browser before Stages 3 to 5', () => {
    const add = section('Stage 3: Add a second agent');

    expect(add).toMatch(/Before Stages 3 to 5/);
    expect(add).toContain('**Repositories → Add Repository**');
  });
});
