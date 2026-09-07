/**
 * The delegation commands are actually REACHABLE (Issue #2376, #2377).
 *
 * A command factory that nothing calls compiles, lints, and passes its own unit
 * tests while `commandmate ask` answers "unknown command". The factories are
 * attached in `src/cli/index.ts` rather than inside `buildProgram()` — see that
 * file's header — so nothing in `program.ts`'s own tests would notice if the
 * wiring were dropped. This is the test that would.
 *
 * `src/cli/index.ts` parses argv as a module side effect (bin/commandmate.js
 * requires it for exactly that), so `buildProgram` is replaced with a recorder:
 * importing the entry point then reports what it attached and parses nothing.
 */

import { describe, it, expect, vi } from 'vitest';

const attached: string[] = [];
const parse = vi.fn();

vi.mock('../../../../src/cli/program', () => ({
  buildProgram: () => ({
    addCommand: (cmd: { name(): string }) => {
      attached.push(cmd.name());
    },
    parse,
  }),
}));

describe('src/cli/index.ts', () => {
  it('attaches ask / whoami / peers / relays and then parses', async () => {
    await import('../../../../src/cli/index');

    // Issue #2377 added `relays`, the other half of the same feature: what a
    // delegation left standing. Same wiring, same reason it needs a test.
    expect(attached).toEqual(['ask', 'whoami', 'peers', 'relays']);
    expect(parse).toHaveBeenCalledTimes(1);
  });
});
