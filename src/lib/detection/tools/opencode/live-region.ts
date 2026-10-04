/**
 * opencode (v1)'s live region (Issue #3183; design doc §7 "opencode").
 *
 * - **composer** — the gutter block above `╹▀▀…` and the `ctrl+p` footer.
 *   Measured: `opencode-agent-health-3021/quoted-dialog-reply-done.txt`
 *   L192-L199 (1.18.33).
 * - **dialog top** — the `┃  △ Permission required` row. Measured:
 *   `opencode-live-1893/permission-bash.txt` L192 / L198 (1.18.21).
 *
 * `composerHidesDialogs: false`: opencode draws its pickers and the command
 * palette over a live composer, so a composer at the bottom vetoes only the
 * numbered readings.
 *
 * @module lib/detection/tools/opencode/live-region
 */

import { OPENCODE_GUTTER_COMPOSER, opencodeGutterDialogTop } from '../opencode-gutter-live-region';
import type { LiveRegionSpec } from '../types';

export const OPENCODE_LIVE_REGION: LiveRegionSpec = {
  composer: OPENCODE_GUTTER_COMPOSER,
  dialogTop: opencodeGutterDialogTop(/△ Permission required/),
  composerHidesDialogs: false,
};
