/**
 * Issue #4300: `readPaneForeground` says `shell` only on certain evidence —
 * tmux names a shell AND `ps` says the pane's own shell owns the terminal
 * (`tpgid == pane_pid`). `ps` is not run for a non-shell name; any failure or
 * unexpected answer is `unknown`.
 * @vitest-environment node
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { execFile } from 'child_process';
import { exactTarget, readPaneForeground } from '@/lib/tmux/tmux';

vi.mock('child_process', () => ({
  execFile: vi.fn(),
}));

type Answer = { error: Error | null; stdout: string };

/** Answer `tmux display-message` and `ps` separately. */
function answers(display: Answer, ps: Answer = { error: new Error('ps not expected'), stdout: '' }): void {
  vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
    const file = args[0] as string;
    const callback = args[args.length - 1] as (e: Error | null, r: { stdout: string; stderr: string }) => void;
    const answer = file === 'ps' ? ps : display;
    callback(answer.error, { stdout: answer.stdout, stderr: '' });
    return {} as ReturnType<typeof execFile>;
  });
}

function psCalls(): unknown[][] {
  return vi.mocked(execFile).mock.calls.filter((c) => c[0] === 'ps');
}

describe('readPaneForeground (Issue #4300)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shell: zsh and tpgid == pane_pid; reads the exact session, then ps for that pid', async () => {
    answers({ error: null, stdout: 'zsh\t4242\n' }, { error: null, stdout: ' 4242\n' });

    await expect(readPaneForeground('mcbd-claude-wt')).resolves.toBe('shell');
    expect(execFile).toHaveBeenCalledWith(
      'tmux',
      ['display-message', '-p', '-t', exactTarget('mcbd-claude-wt'), '#{pane_current_command}\t#{pane_pid}'],
      expect.any(Object),
      expect.any(Function)
    );
    expect(execFile).toHaveBeenCalledWith('ps', ['-o', 'tpgid=', '-p', '4242'], expect.any(Object), expect.any(Function));
  });

  it('shell: a login shell (`-zsh`) counts as a shell', async () => {
    answers({ error: null, stdout: '-zsh\t4242\n' }, { error: null, stdout: '4242\n' });
    await expect(readPaneForeground('s')).resolves.toBe('shell');
  });

  it('other: a non-exec wrapper shows as bash, but tpgid != pane_pid', async () => {
    answers({ error: null, stdout: 'bash\t4242\n' }, { error: null, stdout: '4300\n' });
    await expect(readPaneForeground('s')).resolves.toBe('other');
  });

  it.each(['node', 'claude', '2.1.287', 'codex'])('other: %s in the foreground, ps is not run', async (command) => {
    answers({ error: null, stdout: `${command}\t4242\n` });
    await expect(readPaneForeground('s')).resolves.toBe('other');
    expect(psCalls()).toHaveLength(0);
  });

  it('unknown: display-message failed', async () => {
    answers({ error: new Error("can't find session"), stdout: '' });
    await expect(readPaneForeground('s')).resolves.toBe('unknown');
    expect(psCalls()).toHaveLength(0);
  });

  it.each(['', '\n', 'zsh\n', 'zsh\t\n', '\t4242\n', 'zsh\tabc\n'])(
    'unknown: display-message answered %j',
    async (stdout) => {
      answers({ error: null, stdout });
      await expect(readPaneForeground('s')).resolves.toBe('unknown');
      expect(psCalls()).toHaveLength(0);
    }
  );

  it('unknown: ps failed (the pid is gone, or no ps)', async () => {
    answers({ error: null, stdout: 'zsh\t4242\n' }, { error: new Error('ps: exit 1'), stdout: '' });
    await expect(readPaneForeground('s')).resolves.toBe('unknown');
  });

  it.each(['', '\n', 'TPGID\n'])('unknown: ps answered %j', async (stdout) => {
    answers({ error: null, stdout: 'zsh\t4242\n' }, { error: null, stdout });
    await expect(readPaneForeground('s')).resolves.toBe('unknown');
  });
});
