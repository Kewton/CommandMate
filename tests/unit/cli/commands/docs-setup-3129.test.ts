/**
 * The setup guide's notes from the hands-on check (Issue #3129).
 *
 * Codex's first-run screens, git author before a worker commits, opening the
 * pairing link by pasting it, and the Command Code plan mode workaround.
 * The stage order is pinned by the landing page and is not touched here.
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

describe('the setup guide covers what tripped agents in the hands-on check', () => {
  it('explains Codex\'s trust and hooks review screens in Stage 3', () => {
    const add = section('Stage 3: Add a second agent');

    expect(add).toContain('`Trust this folder?`');
    expect(add).toContain('`Hooks need review (5 hooks are new or changed)`');
    expect(add).toContain('`~/.codex/hooks.json`');
    expect(add).toContain('# commandmate:agent-hooks');
    expect(add).toMatch(/localhost/);
    expect(add).toMatch(/cannot receive Codex's state as events/);
  });

  it('asks for the git author before a worker commits, in Stage 5', () => {
    const verify = section("Stage 5: Let checks decide what's done");

    expect(verify).toContain('`git config user.name`');
    expect(verify).toContain('`git config user.email`');
    expect(verify).toMatch(/Do not let a worker invent a bot name/);
    expect(verify).toMatch(/leave the changes uncommitted/);
  });

  it('says to paste the pairing link into the address bar in Stage 2', () => {
    const pair = section('Stage 2: Pair your phone');

    expect(pair).toMatch(/paste it into the address bar/);
  });

  it('says a plan does not need Command Code plan mode, and that the note can go once #3125 is fixed', () => {
    const lead = section('Stage 4: Give your team a PM');

    expect(lead).toMatch(/do not have the lead enter plan mode/);
    expect(lead).toContain('REVIEW');
    expect(lead).toContain('#3125');
  });
});
