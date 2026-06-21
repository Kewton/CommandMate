/**
 * PcDisplaySizeContext (Issue #915)
 *
 * Single source of truth for the PC display size so that the header selector,
 * the AppShell sidebar-width scaling, and the `<html data-pc-size>` cascade stay
 * in sync within the same tab (separate `usePcDisplaySize()` instances would not).
 *
 * The provider applies the size to `document.documentElement` as `data-pc-size`
 * for the rem cascade (案A) — PC only. On mobile (`useIsMobile()`) or unmount the
 * attribute is removed so rem resolves to the browser default (16px = medium).
 *
 * The context has a non-throwing default (medium, factor 1) so components remain
 * usable without an explicit provider (e.g. isolated unit tests).
 */

'use client';

import React, {
  createContext,
  useContext,
  useEffect,
  useMemo,
  type ReactNode,
} from 'react';
import { useIsMobile } from '@/hooks/useIsMobile';
import {
  usePcDisplaySize,
  DEFAULT_PC_DISPLAY_SIZE,
  PC_DISPLAY_SIZE_META,
  type PcDisplaySize,
} from '@/hooks/usePcDisplaySize';

/** Attribute applied to `<html>` to drive the rem cascade. */
export const PC_DISPLAY_SIZE_ATTRIBUTE = 'data-pc-size';

/** Context value. */
export interface PcDisplaySizeContextValue {
  /** Current display size. */
  size: PcDisplaySize;
  /** Update and persist the display size. */
  setSize: (size: PcDisplaySize) => void;
  /** True when the viewport is mobile — selector hidden, scaling disabled. */
  isMobile: boolean;
  /** Scale factor (relative to medium) for the current size. */
  factor: number;
  /** Whether localStorage is available. */
  isAvailable: boolean;
}

const DEFAULT_CONTEXT_VALUE: PcDisplaySizeContextValue = {
  size: DEFAULT_PC_DISPLAY_SIZE,
  setSize: () => {},
  isMobile: false,
  factor: PC_DISPLAY_SIZE_META[DEFAULT_PC_DISPLAY_SIZE].factor,
  isAvailable: false,
};

const PcDisplaySizeContext = createContext<PcDisplaySizeContextValue>(
  DEFAULT_CONTEXT_VALUE
);

/**
 * Provider that owns the persisted size and applies the rem cascade attribute.
 */
export function PcDisplaySizeProvider({ children }: { children: ReactNode }) {
  const { size, setSize, isAvailable } = usePcDisplaySize();
  const isMobile = useIsMobile();

  // Apply `<html data-pc-size>` on PC only; remove on mobile / unmount.
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const root = document.documentElement;

    if (isMobile) {
      root.removeAttribute(PC_DISPLAY_SIZE_ATTRIBUTE);
      return;
    }

    root.setAttribute(PC_DISPLAY_SIZE_ATTRIBUTE, size);
    return () => {
      root.removeAttribute(PC_DISPLAY_SIZE_ATTRIBUTE);
    };
  }, [size, isMobile]);

  const value = useMemo<PcDisplaySizeContextValue>(
    () => ({
      size,
      setSize,
      isMobile,
      factor: PC_DISPLAY_SIZE_META[size].factor,
      isAvailable,
    }),
    [size, setSize, isMobile, isAvailable]
  );

  return (
    <PcDisplaySizeContext.Provider value={value}>
      {children}
    </PcDisplaySizeContext.Provider>
  );
}

/** Consume the PC display size context. */
export function usePcDisplaySizeContext(): PcDisplaySizeContextValue {
  return useContext(PcDisplaySizeContext);
}

export default PcDisplaySizeContext;
