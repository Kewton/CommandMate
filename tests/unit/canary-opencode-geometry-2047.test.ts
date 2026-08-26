/**
 * Issue #2047: the detection canary fires at the width production actually uses.
 *
 * #2050's opencode canary profile carries a geometry, and its whole claim is
 * "these five scenarios were shot at the shape a real opencode pane has". It
 * spelled that shape `paneWidth: 80` as a literal, next to a
 * `paneHeight: OPENCODE_PANE_HEIGHT` that came from the config module.
 *
 * That asymmetry is the failure mode #2047 was warned about: raise
 * `OPENCODE_PANE_WIDTH` and the canary keeps shooting at 80 while claiming to
 * shoot at production, and the five recorded frames in
 * `tests/fixtures/canary/opencode-*.raw.txt` — captured at 80 columns —
 * quietly stop being captures of anything real. Nothing would go red.
 *
 * The width now comes from the same constant the launcher reads, and this file
 * is the second half: it fails if the default moves at all, because moving it
 * means the recorded fixtures have to be re-shot and
 * `OPENCODE_VERIFIED_AGAINST.paneGeometry` has to be re-stamped. A red here is
 * not a bug — it is the checklist.
 *
 * The profile deliberately takes the DEFAULT rather than
 * `resolveOpencodePaneWidth()`: `CM_OPENCODE_PANE_WIDTH` is an operator's choice
 * about their own panes, and letting it reach the canary would silently re-shoot
 * it at a width its fixtures were never captured at.
 *
 * @vitest-environment node
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { OPENCODE_TOOL_PROFILE } from '@/../scripts/canary/tool-profiles';
import {
  OPENCODE_PANE_HEIGHT,
  OPENCODE_PANE_WIDTH,
  OPENCODE_PANE_WIDTH_ENV,
  resolveOpencodePaneWidth,
} from '@/config/tmux-pane-config';
import { OPENCODE_VERIFIED_AGAINST } from '@/lib/detection/tools/verified-against';

describe('Issue #2047: the canary and the launcher share one geometry', () => {
  it('takes its pane width from OPENCODE_PANE_WIDTH', () => {
    expect(OPENCODE_TOOL_PROFILE.paneWidth).toBe(OPENCODE_PANE_WIDTH);
    expect(OPENCODE_TOOL_PROFILE.paneHeight).toBe(OPENCODE_PANE_HEIGHT);
  });

  it('is not reachable from CM_OPENCODE_PANE_WIDTH', () => {
    // The profile is a module-level literal, so an env var set at runtime cannot
    // reach it. Asserted rather than assumed, because "use the resolver here
    // too" is the obvious-looking change that would break the fixtures.
    expect(
      resolveOpencodePaneWidth({ [OPENCODE_PANE_WIDTH_ENV]: '200' })
    ).toBe(200);
    expect(OPENCODE_TOOL_PROFILE.paneWidth).toBe(OPENCODE_PANE_WIDTH);
  });

  it('matches the geometry OPENCODE_VERIFIED_AGAINST is stamped with', () => {
    // One string, three producers: the launcher's resize, the canary's session,
    // and the stamp `wait --verify` / the detection docs quote. If the default
    // moves, all three move together or this goes red.
    expect(OPENCODE_VERIFIED_AGAINST.paneGeometry).toBe(
      `${OPENCODE_PANE_WIDTH}x${OPENCODE_PANE_HEIGHT}`
    );
  });

  it('still has 80-column frames on disk to compare against', () => {
    // The recorded canary frames were captured at 80 columns (#2050). This
    // measures them rather than trusting the filename: if the default is raised
    // without re-shooting them, the widest visible row will no longer reach the
    // new width and this fails with the reason attached.
    const dir = path.resolve(__dirname, '../fixtures/canary');
    const frames = fs.readdirSync(dir).filter((f) => /^opencode-.*\.raw\.txt$/.test(f));
    expect(frames.length, 'the #2050 opencode canary frames are gone').toBe(5);

    for (const file of frames) {
      const raw = fs.readFileSync(path.join(dir, file), 'utf-8');
      const widest = Math.max(
        ...raw.split('\n').map((l) => l.replace(/\x1b\[[0-9;]*m/g, '').trimEnd().length)
      );
      expect(widest, `${file} is wider than the profile's pane`).toBeLessThanOrEqual(
        OPENCODE_TOOL_PROFILE.paneWidth
      );
      expect(
        widest,
        `${file} was captured at a narrower width than the profile now asks for`
      ).toBeGreaterThan(OPENCODE_TOOL_PROFILE.paneWidth - 20);
    }
  });
});
