/**
 * describeSessionTargetConflict() — the sentence a CLI user reads on exit 2
 * (Issue #1925, Issue #2487).
 *
 * A roster contradiction and a primary-anchor contradiction have different ways
 * out. A roster row can be re-registered; the primary anchor has no row behind
 * it, and `instances add --id antigravity` answers "already exists", so pointing
 * the operator at a registration there is sending them to a dead end.
 */

import { describe, it, expect } from 'vitest';
import { describeSessionTargetConflict } from '@/cli/utils/session-target';

describe('describeSessionTargetConflict (CLI)', () => {
  it('words a roster contradiction exactly as before', () => {
    expect(describeSessionTargetConflict({
      instanceId: 'codex-2',
      rosterCliTool: 'codex',
      requestedCliTool: 'claude',
    })).toBe(
      "instance 'codex-2' is registered as codex, but --agent claude was given. "
      + 'Drop --agent, pass --agent codex, or re-register the instance.'
    );
  });

  describe('a primary-anchor contradiction (Issue #2487)', () => {
    const message = describeSessionTargetConflict({
      instanceId: 'antigravity',
      rosterCliTool: 'antigravity',
      requestedCliTool: 'command-code',
      primaryAnchor: true,
    });

    it('names the instance as the primary instance of its tool', () => {
      expect(message).toContain("instance 'antigravity' is the primary instance of antigravity");
      expect(message).toContain('--agent command-code was given');
    });

    it('offers the three ways out that exist', () => {
      expect(message).toContain('Drop --agent');
      expect(message).toContain('pass --agent antigravity');
      expect(message).toContain('--instance command-code');
    });

    it('never mentions a registration or a roster the instance does not have', () => {
      expect(message).not.toMatch(/regist|roster/i);
    });
  });
});
