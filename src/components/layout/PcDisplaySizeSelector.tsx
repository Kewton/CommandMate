/**
 * PcDisplaySizeSelector (Issue #915)
 *
 * PC-only dropdown for choosing the UI display size (大 / 中 / 小 / 極小).
 * Hidden on mobile. Two-way bound to the persisted size via the context.
 */

'use client';

import React from 'react';
import { usePcDisplaySizeContext } from '@/contexts/PcDisplaySizeContext';
import {
  PC_DISPLAY_SIZE_ORDER,
  PC_DISPLAY_SIZE_META,
  isPcDisplaySize,
} from '@/hooks/usePcDisplaySize';

/**
 * Accessible display-size selector rendered in the PC header.
 * Returns `null` on mobile so scaling stays PC-only.
 */
export function PcDisplaySizeSelector() {
  const { size, setSize, isMobile } = usePcDisplaySizeContext();

  if (isMobile) {
    return null;
  }

  return (
    <div className="flex items-center">
      <label htmlFor="pc-display-size" className="sr-only">
        表示サイズ
      </label>
      <select
        id="pc-display-size"
        data-testid="pc-display-size-select"
        aria-label="表示サイズ"
        value={size}
        onChange={(event) => {
          const next = event.target.value;
          if (isPcDisplaySize(next)) {
            setSize(next);
          }
        }}
        className="text-sm bg-transparent text-gray-700 dark:text-gray-300 border border-gray-300 dark:border-gray-600 rounded-md px-2 py-1 focus:outline-none focus:ring-2 focus:ring-cyan-500"
      >
        {PC_DISPLAY_SIZE_ORDER.map((option) => (
          <option key={option} value={option}>
            {PC_DISPLAY_SIZE_META[option].label}
          </option>
        ))}
      </select>
    </div>
  );
}

export default PcDisplaySizeSelector;
