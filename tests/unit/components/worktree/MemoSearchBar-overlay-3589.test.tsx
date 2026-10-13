/**
 * Esc in the memo search box closes the search, not the Notes pane around it
 * (Issue #3589).
 *
 * Real pieces: `PaneOverlayFrame` (with the real `usePaneOverlayDismiss`) and
 * `MemoSearchBar`, laid out the way MemoPane shows the search inside the
 * overlaid activity pane. The frame closes on an Esc from inside it unless the
 * key's own handler already called preventDefault.
 *
 * @vitest-environment jsdom
 */

import React, { useState } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { PaneOverlayFrame } from '@/components/worktree/WorktreeDesktopLayout';
import { MemoSearchBar } from '@/components/worktree/MemoSearchBar';

function NotesPane({ onDismiss }: { onDismiss: () => void }) {
  const [searching, setSearching] = useState(true);
  const [query, setQuery] = useState('');
  return (
    <PaneOverlayFrame
      title="Notes"
      pinned={false}
      onTogglePinned={vi.fn()}
      onClose={vi.fn()}
      onDismiss={onDismiss}
      testIdPrefix="activity-pane"
    >
      <div data-testid="notes-pane">
        {searching && (
          <div data-testid="memo-search">
            <MemoSearchBar
              query={query}
              onQueryChange={setQuery}
              matchCount={0}
              currentIndex={0}
              onNext={vi.fn()}
              onPrev={vi.fn()}
              onClose={() => setSearching(false)}
              onCompositionStart={vi.fn()}
              onCompositionEnd={vi.fn()}
            />
          </div>
        )}
        <button type="button" data-testid="memo-card">memo</button>
      </div>
    </PaneOverlayFrame>
  );
}

describe('MemoSearchBar inside the overlaid Notes pane (Issue #3589)', () => {
  it('closes only the search on Esc typed into it; the pane stays open', () => {
    const onDismiss = vi.fn();
    render(<NotesPane onDismiss={onDismiss} />);
    const input = screen.getByTestId('memo-search').querySelector('input')!;
    fireEvent.change(input, { target: { value: 'todo' } });
    const notCancelled = fireEvent.keyDown(input, { key: 'Escape' });
    expect(notCancelled).toBe(false);
    expect(screen.queryByTestId('memo-search')).not.toBeInTheDocument();
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('closes the pane on Esc pressed elsewhere in it (negative control)', () => {
    const onDismiss = vi.fn();
    render(<NotesPane onDismiss={onDismiss} />);
    fireEvent.keyDown(screen.getByTestId('memo-card'), { key: 'Escape' });
    expect(onDismiss).toHaveBeenCalledWith('escape');
    expect(screen.getByTestId('memo-search')).toBeInTheDocument();
  });

  it('leaves Enter unchanged: it still moves to the next match, not the pane (negative control)', () => {
    const onDismiss = vi.fn();
    render(<NotesPane onDismiss={onDismiss} />);
    const input = screen.getByTestId('memo-search').querySelector('input')!;
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onDismiss).not.toHaveBeenCalled();
    expect(screen.getByTestId('memo-search')).toBeInTheDocument();
  });
});
