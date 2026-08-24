/**
 * useEnvManager (Issue #1968)
 *
 * Owns the Env Manager's draft state for both surfaces that render it: the PC
 * Activity Bar pane and the mobile Tools sub-tab. One hook per mounted pane —
 * there is nothing to share between them because only one is ever mounted.
 *
 * THE DRAFT MODEL
 * ---------------
 * The file has two editable representations and they must not fight:
 *
 *   - Key-Value: `rows`, seeded from `baseEntries`, edited row by row.
 *   - Raw: `rawDraft`, the file text edited directly.
 *
 * The rule is that exactly ONE of them is authoritative at a time — whichever
 * view is open — and switching views hands the content over:
 *
 *   kv -> raw   `rawDraft` becomes the merge of the rows into `baseRaw`
 *   raw -> kv   `rawDraft` becomes the new baseline and reseeds the rows
 *
 * The merge (`applyEnvRows`) writes each row back over the line it came from,
 * so comments and blank lines survive a Key-Value edit. Regenerating the file
 * from the rows would delete them.
 *
 * NO POLLING. An env file is edited by a human, not produced by an agent, and a
 * background refresh would overwrite a draft the user is typing into. The pane
 * reloads on mount, on a file switch, after a save, and when the user asks.
 *
 * @module hooks/useEnvManager
 */

'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  EnvApiError,
  fetchEnvSnapshot,
  saveEnvFile,
} from '@/lib/env-manager/env-api-client';
import { DEFAULT_ENV_FILE_NAME } from '@/lib/env-manager/env-file-allowlist';
import {
  applyEnvRows,
  parseEnvContent,
  type EnvEntry,
  type EnvIssue,
  type EnvRow,
} from '@/lib/env-manager/env-parser';
import { validateEnvContent } from '@/lib/env-manager/env-validator';
import type { EnvFileDetail, EnvFileSummary, EnvKeySuggestion } from '@/lib/env-manager/types';

/** Which representation the user is editing. */
export type EnvViewMode = 'kv' | 'raw';

/** A Key-Value row plus the stable identity React needs for its key. */
export interface EnvEditableRow extends EnvRow {
  /** Stable within one editing session; never sent to the server. */
  id: string;
}

export interface UseEnvManagerResult {
  /** Files offered in the picker (allow-listed names, existing or creatable). */
  files: EnvFileSummary[];
  /** Currently selected file name. */
  selectedFile: string;
  /** Metadata for the selected file, or null before the first load. */
  detail: EnvFileDetail | null;
  loading: boolean;
  saving: boolean;
  /** Load/save failure, already translated to a message key by the caller. */
  error: { code: string; message: string } | null;
  /** True after a save until the next edit. */
  saved: boolean;
  mode: EnvViewMode;
  rows: EnvEditableRow[];
  rawDraft: string;
  /** Keys whose value is currently revealed. Everything else is masked. */
  revealedKeys: ReadonlySet<string>;
  /** True when the Raw view is showing values in the clear. */
  rawRevealed: boolean;
  /** Template keys not defined in this file. */
  suggestions: EnvKeySuggestion[];
  /** Validation of what would be saved right now. */
  issues: EnvIssue[];
  /** False when `issues` contains an error-severity entry. */
  canSave: boolean;
  /** True when the draft differs from what was loaded. */
  dirty: boolean;
  selectFile: (name: string) => void;
  setMode: (mode: EnvViewMode) => void;
  setRawDraft: (text: string) => void;
  updateRow: (id: string, patch: Partial<Pick<EnvRow, 'key' | 'value'>>) => void;
  addRow: (seed?: { key: string; value: string }) => void;
  removeRow: (id: string) => void;
  toggleReveal: (key: string) => void;
  toggleRawReveal: () => void;
  revealAll: () => void;
  hideAll: () => void;
  reload: () => void;
  save: () => void;
}

let rowIdCounter = 0;
function nextRowId(): string {
  rowIdCounter += 1;
  return `env-row-${rowIdCounter}`;
}

function rowsFromEntries(entries: ReadonlyArray<EnvEntry>): EnvEditableRow[] {
  return entries.map((entry) => ({
    id: nextRowId(),
    key: entry.key,
    value: entry.value,
    sourceLine: entry.line,
  }));
}

/**
 * @param worktreeId - Worktree whose root env files are edited.
 */
export function useEnvManager(worktreeId: string): UseEnvManagerResult {
  const [files, setFiles] = useState<EnvFileSummary[]>([]);
  const [selectedFile, setSelectedFile] = useState<string>(DEFAULT_ENV_FILE_NAME);
  const [detail, setDetail] = useState<EnvFileDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<{ code: string; message: string } | null>(null);
  const [saved, setSaved] = useState(false);
  const [mode, setModeState] = useState<EnvViewMode>('kv');
  const [rows, setRows] = useState<EnvEditableRow[]>([]);
  const [rawDraft, setRawDraftState] = useState('');
  const [baseRaw, setBaseRaw] = useState('');
  const [baseEntries, setBaseEntries] = useState<EnvEntry[]>([]);
  const [loadedContent, setLoadedContent] = useState('');
  const [revealedKeys, setRevealedKeys] = useState<ReadonlySet<string>>(new Set<string>());
  const [rawRevealed, setRawRevealed] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);

  // Guards against a slow response for a file the user already switched away
  // from repainting the newer file's draft.
  const requestSeqRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    const seq = requestSeqRef.current + 1;
    requestSeqRef.current = seq;

    setLoading(true);
    setError(null);
    setSaved(false);

    fetchEnvSnapshot(worktreeId, selectedFile)
      .then((snapshot) => {
        if (cancelled || requestSeqRef.current !== seq) return;
        setFiles(snapshot.files);
        const selected = snapshot.selected;
        setDetail(selected);
        const content = selected?.content ?? '';
        const entries = selected?.entries ?? [];
        setLoadedContent(content);
        setBaseRaw(content);
        setBaseEntries(entries);
        setRows(rowsFromEntries(entries));
        setRawDraftState(content);
        // Masking is the default on every load — including a reload of a file
        // the user had revealed a moment ago.
        setRevealedKeys(new Set<string>());
        setRawRevealed(false);
      })
      .catch((err: unknown) => {
        if (cancelled || requestSeqRef.current !== seq) return;
        const apiError = err instanceof EnvApiError ? err : null;
        setError({
          code: apiError?.code ?? 'UNKNOWN',
          message: apiError?.message ?? (err instanceof Error ? err.message : 'Failed to load'),
        });
        setDetail(null);
      })
      .finally(() => {
        if (cancelled || requestSeqRef.current !== seq) return;
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [worktreeId, selectedFile, reloadToken]);

  /** What a save would write: the authoritative view's content. */
  const composedContent = useMemo(
    () => (mode === 'raw' ? rawDraft : applyEnvRows(baseRaw, baseEntries, rows)),
    [mode, rawDraft, baseRaw, baseEntries, rows],
  );

  const validation = useMemo(() => validateEnvContent(composedContent), [composedContent]);

  /**
   * Whether the draft differs from what was loaded.
   *
   * Compared per representation rather than by text, because serializing a row
   * normalises formatting the user never touched — `A = 1` becomes `A=1`, and
   * `A="1"` loses quotes it did not need. A byte comparison would call such a
   * file dirty the instant it was opened.
   */
  const dirty = useMemo(() => {
    if (mode === 'raw') return rawDraft !== loadedContent;
    if (baseRaw !== loadedContent) return true;
    if (rows.length !== baseEntries.length) return true;
    return rows.some(
      (row, index) =>
        row.key !== baseEntries[index]?.key || row.value !== baseEntries[index]?.value,
    );
  }, [mode, rawDraft, loadedContent, baseRaw, rows, baseEntries]);

  // Not a functional updater: switching views has to move content between two
  // other pieces of state, and React re-invokes an updater under StrictMode —
  // which would run that hand-over twice.
  const setMode = useCallback(
    (next: EnvViewMode) => {
      if (next === mode) return;
      if (next === 'raw') {
        // Hand the Key-Value edits over as text.
        setRawDraftState(applyEnvRows(baseRaw, baseEntries, rows));
      } else {
        // The hand-edited text becomes the new baseline for the rows.
        const parsed = parseEnvContent(rawDraft);
        setBaseRaw(rawDraft);
        setBaseEntries(parsed.entries);
        setRows(rowsFromEntries(parsed.entries));
      }
      setModeState(next);
    },
    [mode, baseRaw, baseEntries, rows, rawDraft],
  );

  const selectFile = useCallback((name: string) => {
    setSelectedFile(name);
    setModeState('kv');
  }, []);

  const setRawDraft = useCallback((text: string) => {
    setRawDraftState(text);
    setSaved(false);
  }, []);

  const updateRow = useCallback((id: string, patch: Partial<Pick<EnvRow, 'key' | 'value'>>) => {
    setRows((current) => current.map((row) => (row.id === id ? { ...row, ...patch } : row)));
    setSaved(false);
  }, []);

  const addRow = useCallback((seed?: { key: string; value: string }) => {
    const row: EnvEditableRow = {
      id: nextRowId(),
      key: seed?.key ?? '',
      value: seed?.value ?? '',
      sourceLine: null,
    };
    setRows((current) => [...current, row]);
    setSaved(false);
    // A row the user just added is theirs to see; masking it would only make
    // them re-reveal a value they typed one keystroke ago.
    if (seed?.key) {
      setRevealedKeys((current) => new Set([...current, seed.key]));
    }
  }, []);

  const removeRow = useCallback((id: string) => {
    setRows((current) => current.filter((row) => row.id !== id));
    setSaved(false);
  }, []);

  const toggleReveal = useCallback((key: string) => {
    setRevealedKeys((current) => {
      const next = new Set(current);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }, []);

  const toggleRawReveal = useCallback(() => setRawRevealed((current) => !current), []);

  const revealAll = useCallback(() => {
    setRevealedKeys(new Set(rows.map((row) => row.key)));
  }, [rows]);

  const hideAll = useCallback(() => setRevealedKeys(new Set<string>()), []);

  const reload = useCallback(() => setReloadToken((token) => token + 1), []);

  const save = useCallback(() => {
    if (!validation.valid || saving) return;
    setSaving(true);
    setError(null);
    saveEnvFile(worktreeId, selectedFile, composedContent)
      .then(() => {
        setSaved(true);
        setReloadToken((token) => token + 1);
      })
      .catch((err: unknown) => {
        const apiError = err instanceof EnvApiError ? err : null;
        setError({
          code: apiError?.code ?? 'UNKNOWN',
          message: apiError?.message ?? (err instanceof Error ? err.message : 'Failed to save'),
        });
      })
      .finally(() => setSaving(false));
  }, [validation.valid, saving, worktreeId, selectedFile, composedContent]);

  return {
    files,
    selectedFile,
    detail,
    loading,
    saving,
    error,
    saved,
    mode,
    rows,
    rawDraft,
    revealedKeys,
    rawRevealed,
    suggestions: detail?.suggestions ?? [],
    issues: validation.issues,
    canSave: validation.valid,
    dirty,
    selectFile,
    setMode,
    setRawDraft,
    updateRow,
    addRow,
    removeRow,
    toggleReveal,
    toggleRawReveal,
    revealAll,
    hideAll,
    reload,
    save,
  };
}
