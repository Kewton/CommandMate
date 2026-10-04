/**
 * A pane's output surface (terminal / chat) and the handler that changes it,
 * shared by the PC split (`TerminalSplitPaneContent`) and the phone tab
 * (`MobileTerminalTab`). They differ only in the storage key they pass in.
 */
import { useCallback, useEffect, useState } from 'react';
import { resolveSurfaceMode, writeSurfaceMode } from '@/config/surface-mode-config';
import { DEFAULT_SURFACE_MODE, type SurfaceMode } from '@/types/ui-state';

export function useSurfaceMode(surfaceStorageKey: string): {
  surfaceMode: SurfaceMode;
  handleSurfaceModeChange: (mode: SurfaceMode) => void;
} {
  // SSR-safe first render: the deterministic default, replaced by the effect
  // below once `?view=` / localStorage can actually be read (same shape as
  // `useActivityBarState`, so there is no hydration mismatch to chase).
  const [surfaceMode, setSurfaceModeState] = useState<SurfaceMode>(DEFAULT_SURFACE_MODE);
  useEffect(() => {
    setSurfaceModeState(resolveSurfaceMode(surfaceStorageKey));
  }, [surfaceStorageKey]);

  const handleSurfaceModeChange = useCallback(
    (mode: SurfaceMode) => {
      setSurfaceModeState(mode);
      writeSurfaceMode(surfaceStorageKey, mode);
    },
    [surfaceStorageKey],
  );

  return { surfaceMode, handleSurfaceModeChange };
}
