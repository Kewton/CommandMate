/**
 * opencode-v2's live region (Issue #3183; design doc §7 "opencode-v2").
 *
 * - **composer** — the gutter block above `╹▀▀…` and the `ctrl+p commands`
 *   footer. Measured: `opencode-v2-dialogs-2984/quoted-dialog-reply.txt`
 *   L194-L199 (2.0.18), under the quotation at L27-L29.
 * - **dialog top** — the `┃  △ Permission required` row or the question form's
 *   `┃  Questions` row. Measured: `opencode-v2-dialogs-2984/permission.txt`
 *   L186, `question.txt` L190.
 *
 * `composerHidesDialogs: false`, as for v1: v2's dialog-title overlays
 * (`commands.txt`) are drawn over a live composer.
 *
 * @module lib/detection/tools/opencode-v2/live-region
 */

import { OPENCODE_GUTTER_COMPOSER, opencodeGutterDialogTop } from '../opencode-gutter-live-region';
import type { LiveRegionSpec } from '../types';

export const OPENCODE_V2_LIVE_REGION: LiveRegionSpec = {
  composer: OPENCODE_GUTTER_COMPOSER,
  dialogTop: opencodeGutterDialogTop(/△ Permission required|┃\s*Questions\s*$/),
  composerHidesDialogs: false,
};
