/**
 * env-clean no-baseline message points at `verify --task` only when the run has no task (Issue #3118)
 *
 * @vitest-environment node
 */

import { describe, expect, it } from 'vitest';
import { envCleanNoBaseline } from '@/lib/verification/env-clean-gate';

describe('envCleanNoBaseline (Issue #3118)', () => {
  it('suggests `verify <worktree> --task <id>` when the run is not attached to a task', () => {
    expect(envCleanNoBaseline(null, ['verify.yaml'])).toContain('--task');
  });

  it('keeps the message free of the hint when the task is known', () => {
    const message = envCleanNoBaseline('t-1', ['verify.yaml']);
    expect(message).toContain('task t-1');
    expect(message).not.toContain('--task');
  });
});
