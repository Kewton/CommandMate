/**
 * usePendingConnectivity — `usePendingMessages`' connectivity input, read from
 * `useConnectivity` (Issue #2512).
 *
 * The projection is the one `TerminalSplitPaneContent` and `MobileTerminalTab`
 * build inline since Issue #2503, field for field: `offline` from
 * `isConnectionKnownDown` (holding a failure back needs proof the network is
 * gone, not merely a socket that is closed) and `reachable` from
 * `isServerConfirmedReachable` (a resend needs proof the server answered, never
 * `navigator.onLine === true`). Named here because the `/sessions` tile wall
 * needs it at the grid rather than per tile — see `SessionTileGrid`.
 *
 * **One call per screen, not per pane.** Every mounted `useConnectivity` runs
 * its own reachability probe while the verdict is degraded, on its own clock,
 * so N callers mounted at different moments issue N probes per interval. A
 * surface that repeats a pane N times calls this once and hands the result
 * down.
 */

'use client';

import { useMemo } from 'react';
import {
  useConnectivity,
  isConnectionKnownDown,
  isServerConfirmedReachable,
} from '@/hooks/useConnectivity';
import type { PendingConnectivity } from '@/hooks/usePendingMessages';

export function usePendingConnectivity(): PendingConnectivity {
  const { signals } = useConnectivity();
  return useMemo(
    () => ({
      offline: isConnectionKnownDown(signals),
      reachable: isServerConfirmedReachable(signals),
    }),
    [signals],
  );
}

export default usePendingConnectivity;
