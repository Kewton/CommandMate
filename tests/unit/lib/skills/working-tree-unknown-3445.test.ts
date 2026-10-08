/**
 * Issue #3445: when `git status` could not be read, the skills plans and the
 * CLI say "unknown" rather than "dirty" — and still never "clean".
 *
 * @vitest-environment node
 */

import { describe, it, expect } from 'vitest';
import { SkillPreviewWarning, workingTreeWarning } from '@/lib/skills/preview-diff';
import { formatWorkingTreeMark } from '@/cli/commands/skill-format';

describe('workingTreeWarning', () => {
  it('warns "status unknown" (not dirty) when status could not be read', () => {
    expect(workingTreeWarning({ dirty: true, dirtyUnknown: true })).toBe(
      SkillPreviewWarning.WORKING_TREE_STATUS_UNKNOWN
    );
  });

  it('keeps dirty and clean as before', () => {
    expect(workingTreeWarning({ dirty: true })).toBe(SkillPreviewWarning.WORKING_TREE_DIRTY);
    expect(workingTreeWarning({ dirty: false })).toBeNull();
  });
});

describe('formatWorkingTreeMark (CLI)', () => {
  it('marks an unread status as unknown, never clean', () => {
    expect(formatWorkingTreeMark({ workingTreeDirty: true, workingTreeUnknown: true })).toBe(
      ' [working tree status unknown]'
    );
  });

  it('keeps dirty and clean output byte-identical', () => {
    expect(formatWorkingTreeMark({ workingTreeDirty: true })).toBe(' [working tree dirty]');
    expect(formatWorkingTreeMark({ workingTreeDirty: false })).toBe('');
  });
});
