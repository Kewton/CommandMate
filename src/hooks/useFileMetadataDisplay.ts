/**
 * useFileMetadataDisplay Hook (Issue #969)
 *
 * Manages which file-metadata columns (size / created / modified) are shown
 * inline in the file tree, persisted to localStorage. Mirrors
 * `useFilePanelState` (Issue #840): same-window writes are broadcast via a
 * CustomEvent so multiple hook instances on the same page stay in sync (the
 * native `storage` event only fires for *other* tabs).
 *
 * Persistence:
 *   - `commandmate.worktree.fileMetadataDisplay`
 *     (JSON: { showSize, showCreated, showModified })
 *
 * Default (Issue #969 recommendation — VS Code-style: size only inline,
 * timestamps on hover):
 *   - showSize: true, showCreated: false, showModified: false
 *
 * SSR / hydration:
 *   - SSR returns the default. An effect on mount syncs from localStorage.
 */

'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

export const FILE_METADATA_DISPLAY_STORAGE_KEY =
  'commandmate.worktree.fileMetadataDisplay';

/** Inline file-metadata column visibility settings. */
export interface FileMetadataDisplaySettings {
  /** Show the file size (or directory item count) inline. */
  showSize: boolean;
  /** Show the creation time (birthtime) inline. */
  showCreated: boolean;
  /** Show the last-modification time (mtime) inline. */
  showModified: boolean;
}

export const DEFAULT_FILE_METADATA_DISPLAY: FileMetadataDisplaySettings = {
  showSize: true,
  showCreated: false,
  showModified: false,
};

export interface UseFileMetadataDisplayReturn {
  /** Current visibility settings. */
  settings: FileMetadataDisplaySettings;
  /** Toggle a single key (also persists). */
  toggle: (key: keyof FileMetadataDisplaySettings) => void;
  /** Replace all settings explicitly (also persists). */
  setSettings: (next: FileMetadataDisplaySettings) => void;
}

function sanitize(value: unknown): FileMetadataDisplaySettings {
  if (typeof value !== 'object' || value === null) {
    return { ...DEFAULT_FILE_METADATA_DISPLAY };
  }
  const v = value as Partial<Record<keyof FileMetadataDisplaySettings, unknown>>;
  return {
    showSize:
      typeof v.showSize === 'boolean'
        ? v.showSize
        : DEFAULT_FILE_METADATA_DISPLAY.showSize,
    showCreated:
      typeof v.showCreated === 'boolean'
        ? v.showCreated
        : DEFAULT_FILE_METADATA_DISPLAY.showCreated,
    showModified:
      typeof v.showModified === 'boolean'
        ? v.showModified
        : DEFAULT_FILE_METADATA_DISPLAY.showModified,
  };
}

function readStored(): FileMetadataDisplaySettings {
  if (typeof window === 'undefined') {
    return { ...DEFAULT_FILE_METADATA_DISPLAY };
  }
  try {
    const raw = window.localStorage.getItem(FILE_METADATA_DISPLAY_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_FILE_METADATA_DISPLAY };
    return sanitize(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_FILE_METADATA_DISPLAY };
  }
}

function writeStored(settings: FileMetadataDisplaySettings): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(
      FILE_METADATA_DISPLAY_STORAGE_KEY,
      JSON.stringify(settings)
    );
  } catch {
    /* unavailable */
  }
}

/**
 * Custom event used to broadcast hook state changes across multiple
 * `useFileMetadataDisplay` instances on the same page (same rationale as
 * `useFilePanelState` — Issue #730): same-window localStorage writes do not
 * fire the native `storage` event.
 */
const FILE_METADATA_DISPLAY_EVENT = 'commandmate:fileMetadataDisplayChange';

interface FileMetadataDisplayEventDetail {
  settings: FileMetadataDisplaySettings;
}

function emitChange(detail: FileMetadataDisplayEventDetail): void {
  if (typeof window === 'undefined') return;
  try {
    window.dispatchEvent(
      new CustomEvent<FileMetadataDisplayEventDetail>(
        FILE_METADATA_DISPLAY_EVENT,
        { detail }
      )
    );
  } catch {
    /* CustomEvent may be unavailable in very old environments */
  }
}

function settingsEqual(
  a: FileMetadataDisplaySettings,
  b: FileMetadataDisplaySettings
): boolean {
  return (
    a.showSize === b.showSize &&
    a.showCreated === b.showCreated &&
    a.showModified === b.showModified
  );
}

export function useFileMetadataDisplay(): UseFileMetadataDisplayReturn {
  const [settings, setSettingsState] = useState<FileMetadataDisplaySettings>(
    DEFAULT_FILE_METADATA_DISPLAY
  );

  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  // Hydrate once on mount.
  useEffect(() => {
    setSettingsState(readStored());
  }, []);

  // Sync state across hook instances on the same page.
  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const onChange = (event: Event): void => {
      const ce = event as CustomEvent<FileMetadataDisplayEventDetail>;
      if (!ce.detail) return;
      if (!settingsEqual(ce.detail.settings, settingsRef.current)) {
        setSettingsState(ce.detail.settings);
      }
    };
    window.addEventListener(FILE_METADATA_DISPLAY_EVENT, onChange);
    return () =>
      window.removeEventListener(FILE_METADATA_DISPLAY_EVENT, onChange);
  }, []);

  const setSettings = useCallback(
    (next: FileMetadataDisplaySettings): void => {
      // Update the ref synchronously so multiple toggles within the same tick
      // compose off the latest value (the ref is otherwise only refreshed on
      // the next render).
      settingsRef.current = next;
      setSettingsState(next);
      writeStored(next);
      emitChange({ settings: next });
    },
    []
  );

  const toggle = useCallback(
    (key: keyof FileMetadataDisplaySettings): void => {
      const next: FileMetadataDisplaySettings = {
        ...settingsRef.current,
        [key]: !settingsRef.current[key],
      };
      setSettings(next);
    },
    [setSettings]
  );

  return { settings, toggle, setSettings };
}

export default useFileMetadataDisplay;
