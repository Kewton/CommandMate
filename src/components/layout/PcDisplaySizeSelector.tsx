/**
 * PcDisplaySizeSelector (Issue #915)
 *
 * PC-only dropdown for choosing the UI display size (large / medium / small / xsmall).
 * Hidden on mobile. Two-way bound to the persisted size via the context.
 *
 * Labels and the accessible label are localized via next-intl (`common.displaySize.*`)
 * so they follow the active locale instead of being hard-coded Japanese (Issue #918).
 */

'use client';

import React from 'react';
import { useTranslations } from 'next-intl';
import { usePcDisplaySizeContext } from '@/contexts/PcDisplaySizeContext';
import {
  PC_DISPLAY_SIZE_ORDER,
  isPcDisplaySize,
} from '@/hooks/usePcDisplaySize';

/**
 * Accessible display-size selector rendered in the PC header.
 * Returns `null` on mobile so scaling stays PC-only.
 */
export function PcDisplaySizeSelector() {
  const { size, setSize, isMobile } = usePcDisplaySizeContext();
  const t = useTranslations('common');

  if (isMobile) {
    return null;
  }

  const ariaLabel = t('displaySize.ariaLabel');

  return (
    <div className="flex items-center">
      <label htmlFor="pc-display-size" className="sr-only">
        {ariaLabel}
      </label>
      <select
        id="pc-display-size"
        data-testid="pc-display-size-select"
        aria-label={ariaLabel}
        value={size}
        onChange={(event) => {
          const next = event.target.value;
          if (isPcDisplaySize(next)) {
            setSize(next);
          }
        }}
        className="text-sm bg-transparent text-foreground border border-input rounded-md px-2 py-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {PC_DISPLAY_SIZE_ORDER.map((option) => (
          <option key={option} value={option}>
            {t(`displaySize.${option}`)}
          </option>
        ))}
      </select>
    </div>
  );
}

export default PcDisplaySizeSelector;
