/**
 * `commandmate wait --help`: the unclassified dwell cross-reference
 * (Issue #1926, 方針書 規約 3).
 *
 * The dwell is the one stop reason with no flag of its own. `--timeout` and
 * `--stall-timeout` announce themselves in the options list; exit 10 after 60 s
 * of an unreadable frame announces itself nowhere a caller looks while it is
 * happening. Discoverability 規約 3 asks a judgement that a caller can be
 * surprised by to be reachable from the command's own help, and this is that
 * text.
 *
 * The assertions are on the FACTS, not on the prose: the threshold, the exit
 * code, the two flags it interacts with, and the fields that explain it. A
 * rewrite that keeps all of them is welcome; one that drops the number or the
 * exit code is the regression this catches.
 */

import { describe, it, expect } from 'vitest';

/**
 * What a user actually sees from `commandmate wait --help`.
 *
 * `helpInformation()` is NOT that: commander renders `addHelpText` through the
 * `beforeAll`/`after` listeners that only `outputHelp()` emits, so a suite built
 * on `helpInformation()` would pass while the section was missing from the
 * terminal. Measured against commander in this repo before it was written.
 */
async function helpText(): Promise<string> {
  const { createWaitCommand } = await import('../../../../src/cli/commands/wait');
  const cmd = createWaitCommand();
  let out = '';
  cmd.configureOutput({ writeOut: (str) => { out += str; } });
  cmd.outputHelp();
  return out;
}

describe('[#1926] wait --help documents the unclassified dwell', () => {
  it('names the 60 second dwell and the exit code it produces', async () => {
    const help = await helpText();

    expect(help).toContain('60 s');
    expect(help).toContain('exit 10');
    expect(help).toContain('unclassified');
  });

  it('states the interaction with --stall-timeout and --timeout', async () => {
    // The question a caller actually has: "I set --stall-timeout 30, will the
    // dwell delay it to 60?" It will not, and the answer has to be here rather
    // than only in the guide.
    const help = await helpText();

    const [, after] = help.split('Unclassified frames');
    expect(after).toContain('--stall-timeout');
    expect(after).toContain('--timeout');
    expect(after).toContain('124');
  });

  it('points at the fields that explain a frame nothing could read', async () => {
    const help = await helpText();

    expect(help).toContain('statusEvidence');
    expect(help).toContain('--pane');
  });

  it('still lists every option it listed before', async () => {
    // The help text is appended, not substituted: `addHelpText('after', …)`
    // must not have displaced the options block.
    const help = await helpText();

    for (const option of [
      '--timeout <seconds>',
      '--on-prompt <mode>',
      '--stall-timeout <seconds>',
      '--instance <id>',
      '--verify',
      '--require-work',
      '--fail-on-upstream-fault',
    ]) {
      expect(help).toContain(option);
    }
  });
});
