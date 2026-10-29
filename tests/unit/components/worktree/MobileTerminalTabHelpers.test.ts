import { describe, expect, it } from 'vitest';
import { resolveMobileUnsentComposerSlot } from '@/components/worktree/MobileTerminalTabHelpers';

describe('resolveMobileUnsentComposerSlot (Issue #3997)', () => {
  it('shows the bar when the composer holds unsent text', () => {
    expect(resolveMobileUnsentComposerSlot(true, false, false)).toBe('bar');
    expect(resolveMobileUnsentComposerSlot(true, true, false)).toBe('bar');
  });

  it('shows the Clear notice alone when the bar is hidden', () => {
    expect(resolveMobileUnsentComposerSlot(false, true, false)).toBe('clearNotice');
  });

  it('shows nothing when there is neither unsent text nor a notice', () => {
    expect(resolveMobileUnsentComposerSlot(false, false, false)).toBe('none');
  });

  it('shows nothing while the direct-input keyboard is open', () => {
    expect(resolveMobileUnsentComposerSlot(true, true, true)).toBe('none');
    expect(resolveMobileUnsentComposerSlot(true, false, true)).toBe('none');
    expect(resolveMobileUnsentComposerSlot(false, true, true)).toBe('none');
  });
});
