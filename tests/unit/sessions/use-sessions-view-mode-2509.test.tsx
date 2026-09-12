/**
 * useSessionsViewMode — the `/sessions` layout preference (Issue #2509).
 *
 * Three properties, all of which the page depends on: the default is the
 * pre-#2509 layout, a value that is not a known mode resolves to that default
 * rather than to an unrenderable state, and what is written is the bare string
 * (a JSON-quoted `"tile"` would read back as a value this hook rejects, i.e. a
 * preference that silently stops persisting).
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import {
  DEFAULT_SESSIONS_VIEW_MODE,
  SESSIONS_VIEW_MODES,
  SESSIONS_VIEW_MODE_STORAGE_KEY,
  isValidSessionsViewMode,
  useSessionsViewMode,
  type SessionsViewMode,
} from '@/hooks/useSessionsViewMode';

function Probe() {
  const { viewMode, setViewMode } = useSessionsViewMode();
  return (
    <div>
      <span data-testid="mode">{viewMode}</span>
      {SESSIONS_VIEW_MODES.map((mode: SessionsViewMode) => (
        <button key={mode} data-testid={`set-${mode}`} onClick={() => setViewMode(mode)} />
      ))}
    </div>
  );
}

beforeEach(() => {
  window.localStorage.clear();
});

describe('useSessionsViewMode (Issue #2509)', () => {
  it('defaults to list', () => {
    expect(DEFAULT_SESSIONS_VIEW_MODE).toBe('list');

    render(<Probe />);

    expect(screen.getByTestId('mode').textContent).toBe('list');
  });

  it('reads a stored mode back', () => {
    window.localStorage.setItem(SESSIONS_VIEW_MODE_STORAGE_KEY, 'tile');

    render(<Probe />);

    expect(screen.getByTestId('mode').textContent).toBe('tile');
  });

  it('writes the bare string, not JSON', () => {
    render(<Probe />);

    act(() => {
      screen.getByTestId('set-tile').click();
    });

    expect(window.localStorage.getItem(SESSIONS_VIEW_MODE_STORAGE_KEY)).toBe('tile');
    expect(screen.getByTestId('mode').textContent).toBe('tile');
  });

  it('falls back to the default for a value that is not a known mode', () => {
    window.localStorage.setItem(SESSIONS_VIEW_MODE_STORAGE_KEY, '{"mode":"tile"}');

    render(<Probe />);

    expect(screen.getByTestId('mode').textContent).toBe('list');
  });

  it('isValidSessionsViewMode accepts exactly the two modes', () => {
    expect(isValidSessionsViewMode('list')).toBe(true);
    expect(isValidSessionsViewMode('tile')).toBe(true);
    expect(isValidSessionsViewMode('mosaic')).toBe(false);
    expect(isValidSessionsViewMode(undefined)).toBe(false);
    expect(isValidSessionsViewMode(1)).toBe(false);
  });
});
