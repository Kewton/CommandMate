/**
 * MobileConnectionBanner — the phone's connection status line (Issue #2501).
 *
 * `ConnectionStatusIndicator` lives in `Header`, and `AppShell`'s mobile branch
 * does not render `Header` at all, so before this component a phone had no
 * place a connection state could appear. This is that place.
 *
 * Deliberately a **bar in the flex column**, not a floating pill or a toast:
 * it takes its height out of `<main>` instead of drawing on top of it, so it
 * cannot cover the terminal composer or the `GlobalMobileNav` tab row no matter
 * what the page below is doing. Issue #2271 is the precedent — a Service Worker
 * toast that overlaid the composer — and a bar in flow makes that failure mode
 * structurally impossible rather than a z-index to get right.
 *
 * Shows nothing while connected, matching the desktop indicator's policy.
 */

'use client';

import { useTranslations } from 'next-intl';
import { useConnectivity } from '@/hooks/useConnectivity';

/**
 * Thin connection bar for the mobile shell.
 *
 * Renders `null` unless the connection has been degraded for longer than the
 * settle window (`shouldSurface`), so a page load does not blink a banner while
 * the WebSocket is still opening.
 */
export function MobileConnectionBanner() {
  const { shouldSurface, isReconnecting } = useConnectivity();
  const t = useTranslations('common');

  if (!shouldSurface) return null;

  const label = isReconnecting ? t('connection.reconnecting') : t('connection.offline');
  const detail = isReconnecting
    ? t('connection.reconnectingTooltip')
    : t('connection.offlineTooltip');

  // `pt-safe` sits on the outer element and the padding on the inner one: both
  // utilities write `padding-top`, so sharing an element would let one silently
  // win over the other depending on stylesheet order.
  return (
    <div
      data-testid="mobile-connection-banner"
      data-connection-state={isReconnecting ? 'reconnecting' : 'offline'}
      role="status"
      aria-live="polite"
      title={detail}
      className={`shrink-0 pt-safe border-b ${
        isReconnecting
          ? 'bg-warning-subtle border-warning-border text-warning-foreground'
          : 'bg-danger-subtle border-danger-border text-danger-foreground'
      }`}
    >
      <div className="flex items-center justify-center gap-1.5 px-3 py-1 text-xs">
        <span
          aria-hidden="true"
          className={`w-1.5 h-1.5 rounded-full ${
            isReconnecting ? 'bg-warning motion-safe:animate-pulse' : 'bg-danger'
          }`}
        />
        {label}
      </div>
    </div>
  );
}

export default MobileConnectionBanner;
