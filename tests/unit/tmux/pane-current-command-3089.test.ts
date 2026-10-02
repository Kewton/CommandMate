/**
 * Issue #3089: `getPaneCurrentCommand` reads `#{pane_current_command}` so
 * Claude's start wait can tell an agent that quit to the shell from one that is
 * still drawing.
 * @vitest-environment node
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { execFile } from 'child_process';
import { getPaneCurrentCommand, exactTarget } from '@/lib/tmux/tmux';

vi.mock('child_process', () => ({
  execFile: vi.fn(),
}));

function execFileAnswers(err: Error | null, stdout: string): void {
  vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
    const callback = args[args.length - 1] as (e: Error | null, result: { stdout: string; stderr: string }) => void;
    callback(err, { stdout, stderr: '' });
    return {} as ReturnType<typeof execFile>;
  });
}

describe('getPaneCurrentCommand (Issue #3089)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the pane command, trimmed, for the exact session', async () => {
    execFileAnswers(null, 'bash\n');

    await expect(getPaneCurrentCommand('mcbd-claude-wt')).resolves.toBe('bash');
    expect(execFile).toHaveBeenCalledWith(
      'tmux',
      ['display-message', '-p', '-t', exactTarget('mcbd-claude-wt'), '#{pane_current_command}'],
      expect.any(Object),
      expect.any(Function)
    );
  });

  it('returns null when tmux fails or prints nothing', async () => {
    execFileAnswers(new Error("can't find session"), '');
    await expect(getPaneCurrentCommand('mcbd-claude-gone')).resolves.toBeNull();

    execFileAnswers(null, '\n');
    await expect(getPaneCurrentCommand('mcbd-claude-wt')).resolves.toBeNull();
  });
});
