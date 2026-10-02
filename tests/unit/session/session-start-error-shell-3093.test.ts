/**
 * Shell detection and the "agent exited" wording (Issue #3093).
 */

import { describe, it, expect, vi } from 'vitest';
import { buildSessionExitedToShellMessage } from '@/lib/session/session-start-error';
import { isPaneBackAtShell } from '@/app/api/worktrees/[id]/send/pane-shell';
import type { ICLITool } from '@/lib/cli-tools/types';
import { resolveLivenessSpec } from '@/lib/cli-tools/liveness-spec';

const captureSessionOutputFresh = vi.fn();
vi.mock('@/lib/session/cli-session', () => ({
  captureSessionOutputFresh: (...args: unknown[]) => captureSessionOutputFresh(...args),
}));

describe('buildSessionExitedToShellMessage (Issue #3093)', () => {
  it('names the exit and the next step, and never says the process is running', () => {
    const message = buildSessionExitedToShellMessage('Claude Code', 'mcbd-claude-wt');
    expect(message).toContain("Claude Code exited before reaching its input prompt");
    expect(message).toContain("'mcbd-claude-wt'");
    expect(message).toContain('commandmate capture');
    expect(message).not.toContain('still running');
    expect(message).not.toContain('nothing needs repairing');
  });
});

const claudeTool = {
  id: 'claude',
  name: 'Claude Code',
  livenessSpec: () => resolveLivenessSpec('claude'),
} as unknown as ICLITool;

/** Claude Code's folder-trust dialog, as drawn before the operator answers. */
const TRUST_DIALOG = [
  ' Do you trust the files in this folder?',
  '',
  ' ❯ 1. Yes, I trust this folder',
  '   2. No, exit',
  '',
  ' Enter to confirm · Esc to cancel',
];

describe('isPaneBackAtShell (Issue #3093)', () => {
  it('is true when the agent quit and the pane ends at a shell prompt', async () => {
    captureSessionOutputFresh.mockResolvedValue([...TRUST_DIALOG, '', 'kewton@mac commandmate % '].join('\n'));
    await expect(isPaneBackAtShell(claudeTool, 'wt', 'claude')).resolves.toBe(true);
    expect(captureSessionOutputFresh).toHaveBeenCalledWith('wt', 'claude', expect.any(Number), 'claude');
  });

  it('is false while the agent is still drawing its dialog', async () => {
    captureSessionOutputFresh.mockResolvedValue(TRUST_DIALOG.join('\n'));
    await expect(isPaneBackAtShell(claudeTool, 'wt')).resolves.toBe(false);
  });

  it('is false when the pane cannot be read', async () => {
    captureSessionOutputFresh.mockRejectedValue(new Error('no session'));
    await expect(isPaneBackAtShell(claudeTool, 'wt')).resolves.toBe(false);
  });
});
