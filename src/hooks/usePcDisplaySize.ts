/**
 * usePcDisplaySize Hook (Issue #915)
 *
 * PC-only display-size preference (大 / 中 / 小 / 極小) persisted per browser via
 * localStorage. The selected size drives the `rem` cascade (案A): the value is
 * applied as `<html data-pc-size>` (see {@link PcDisplaySizeProvider}) so that
 * rem-based Tailwind spacing/typography scales automatically. Fixed-px surfaces
 * (sidebar width, xterm.js terminal fontSize) scale separately via the factor /
 * terminalFontSize metadata exported here.
 *
 * @module hooks/usePcDisplaySize
 */

'use client';

import { useLocalStorageState } from './useLocalStorageState';

/** PC display size identifiers (大 / 中 / 小 / 極小). */
export type PcDisplaySize = 'large' | 'medium' | 'small' | 'xsmall';

/** localStorage key (follows the `mcbd-*` convention). */
export const PC_DISPLAY_SIZE_STORAGE_KEY = 'mcbd-pc-display-size';

/** Default size when nothing is stored or the stored value is invalid. */
export const DEFAULT_PC_DISPLAY_SIZE: PcDisplaySize = 'medium';

/** Display order for the selector UI (大 → 極小). */
export const PC_DISPLAY_SIZE_ORDER: readonly PcDisplaySize[] = [
  'large',
  'medium',
  'small',
  'xsmall',
];

/** Per-size metadata. */
export interface PcDisplaySizeMeta {
  /** Stored value. */
  value: PcDisplaySize;
  /** `<html>` font-size in px applied via the globals.css cascade. */
  rootFontSizePx: number;
  /** Scale factor relative to medium, for fixed-px surfaces (e.g. sidebar width). */
  factor: number;
  /** xterm.js terminal fontSize for this size. */
  terminalFontSize: number;
}

/**
 * Size factor table (Issue #915 採用方針: 案A rem カスケード).
 * Keep in sync with the `html[data-pc-size=...]` rules in `globals.css`.
 *
 * Display labels are intentionally NOT stored here — they live in the i18n
 * dictionaries (`common.displaySize.*`) so the selector follows the active
 * locale instead of hard-coded Japanese (Issue #918).
 */
export const PC_DISPLAY_SIZE_META: Record<PcDisplaySize, PcDisplaySizeMeta> = {
  large: { value: 'large', rootFontSizePx: 18, factor: 1.125, terminalFontSize: 16 },
  medium: { value: 'medium', rootFontSizePx: 16, factor: 1, terminalFontSize: 14 },
  small: { value: 'small', rootFontSizePx: 14, factor: 0.875, terminalFontSize: 12 },
  xsmall: { value: 'xsmall', rootFontSizePx: 12.5, factor: 0.78, terminalFontSize: 11 },
};

/** Type guard / validator for stored values. */
export function isPcDisplaySize(value: unknown): value is PcDisplaySize {
  return (
    typeof value === 'string' &&
    Object.prototype.hasOwnProperty.call(PC_DISPLAY_SIZE_META, value)
  );
}

/** Scale factor (relative to medium) for the given size. */
export function getPcDisplaySizeFactor(size: PcDisplaySize): number {
  return PC_DISPLAY_SIZE_META[size].factor;
}

/** xterm.js terminal fontSize for the given size. */
export function getTerminalFontSize(size: PcDisplaySize): number {
  return PC_DISPLAY_SIZE_META[size].terminalFontSize;
}

/** Return type for {@link usePcDisplaySize}. */
export interface UsePcDisplaySizeReturn {
  /** Current persisted size. */
  size: PcDisplaySize;
  /** Update and persist the size. */
  setSize: (size: PcDisplaySize) => void;
  /** Whether localStorage is available. */
  isAvailable: boolean;
}

/**
 * Hook exposing the persisted PC display size preference.
 *
 * Out-of-range / corrupted stored values fall back to {@link DEFAULT_PC_DISPLAY_SIZE}
 * via the validator.
 */
export function usePcDisplaySize(): UsePcDisplaySizeReturn {
  const { value, setValue, isAvailable } = useLocalStorageState<PcDisplaySize>({
    key: PC_DISPLAY_SIZE_STORAGE_KEY,
    defaultValue: DEFAULT_PC_DISPLAY_SIZE,
    validate: isPcDisplaySize,
  });

  return { size: value, setSize: setValue, isAvailable };
}

export default usePcDisplaySize;
