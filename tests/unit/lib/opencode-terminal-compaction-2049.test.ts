/**
 * Issue #2049 acceptance: the opencode terminal view collapses its blank rows
 * without losing the composer, the approval dialog or the picker.
 *
 * This is the fixture-snapshot half of the acceptance condition. Every frame is
 * a verbatim `capture-pane -p -e` recording — 1.18.22 for the #2049 captures,
 * 1.18.20/1.18.21 for the approval-dialog and picker ones already in the repo.
 *
 * A green "nothing was lost" suite proves nothing on its own: it is equally
 * satisfied by a compactor that does nothing at all. So every survival
 * assertion here is paired with a positive control that shows the same
 * assertion failing under Issue #1172's rule (`losesAPanelRow`), or with a
 * compaction-ratio assertion that fails if the frame is passed through
 * untouched.
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { normalizeTerminalOutputForDisplay } from '@/lib/terminal/terminal-display-normalizer';
import {
  isPaintedPanelRow,
  normalizeOpencodeTerminalOutputForDisplay,
} from '@/lib/terminal-display-normalize';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const F_2049 = path.join(REPO_ROOT, 'tests/fixtures/opencode-live-2049');
const F_DETECT = path.join(REPO_ROOT, 'tests/unit/lib/detection/fixtures');

const read = (p: string): string => fs.readFileSync(p, 'utf-8');
const frame2049 = (name: string): string => read(path.join(F_2049, `${name}.txt`));
const frameLive = (dir: string, name: string): string =>
  read(path.join(F_DETECT, dir, `${name}.txt`));

/**
 * opencode's composer gutter (U+2503) and the corner of the `╹▀▀▀…` rule under
 * it. The corner is matched alone because opencode colours `╹` and the `▀` run
 * separately, so an SGR sits between them in the raw capture.
 */
const GUTTER = '┃';
const SEPARATOR = '╹';

const rows = (text: string): string[] => text.split('\n');
const countRows = (text: string, predicate: (row: string) => boolean): number =>
  rows(text).filter(predicate).length;
const hasGutter = (row: string): boolean => row.includes(GUTTER);
const hasSeparator = (row: string): boolean => row.includes(SEPARATOR);

describe('Issue #2049: the fixtures are still raw captures', () => {
  it.each(['boot-idle-11822', 'two-turn-idle-11822', 'command-palette-11822'])(
    '%s keeps its raw ESC bytes and its box drawing',
    (name) => {
      const raw = frame2049(name);
      expect(raw).toContain('\x1b[');
      expect(raw).toContain(GUTTER);
      expect(raw).toContain(SEPARATOR);
      // OPENCODE_PANE_HEIGHT rows + the trailing newline capture-pane leaves.
      expect(rows(raw).length).toBe(201);
    },
  );

  it('command-palette-11822 was recorded on opencode 1.18.22 with the palette open', () => {
    const raw = frame2049('command-palette-11822');
    expect(raw).toContain('Commands');
    expect(raw).toContain('Switch model');
    expect(countRows(raw, isPaintedPanelRow)).toBe(8);
  });
});

describe('Issue #2049: opencode frames actually compact', () => {
  // Fails if the compactor is a no-op, which is the failure mode a pure
  // "nothing was lost" suite cannot see.
  it.each([
    ['boot-idle-11822', 20],
    ['two-turn-idle-11822', 50],
    ['command-palette-11822', 70],
  ])('%s collapses from 201 rows to under %i', (name, ceiling) => {
    const raw = frame2049(name);
    const compacted = normalizeOpencodeTerminalOutputForDisplay(raw);
    expect(rows(raw).length).toBe(201);
    expect(rows(compacted).length).toBeLessThan(ceiling as number);
  });

  it('leaves no run of 3+ blank rows behind', () => {
    for (const name of ['boot-idle-11822', 'two-turn-idle-11822', 'command-palette-11822']) {
      const compacted = rows(normalizeOpencodeTerminalOutputForDisplay(frame2049(name)));
      let run = 0;
      for (const row of compacted) {
        // eslint-disable-next-line no-control-regex
        const stripped = row.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
        run = stripped.trim() === '' && !isPaintedPanelRow(row) ? run + 1 : 0;
        expect(run, `${name}: ${run} consecutive blank rows`).toBeLessThanOrEqual(2);
      }
    }
  });
});

describe('Issue #2049: composer, separator and approval-dialog rows are never dropped', () => {
  const COMPOSER_FRAMES: Array<[string, string]> = [
    ['2049/boot-idle-11822', frame2049('boot-idle-11822')],
    ['2049/two-turn-idle-11822', frame2049('two-turn-idle-11822')],
    ['2049/command-palette-11822', frame2049('command-palette-11822')],
    ['1883/boot-idle', frameLive('opencode-live-1883', 'boot-idle')],
    ['1883/turn-complete', frameLive('opencode-live-1883', 'turn-complete')],
    ['1883/composer-residual', frameLive('opencode-live-1883', 'composer-residual')],
    ['1906/composer-multiline-pending', frameLive('opencode-live-1906', 'composer-multiline-pending')],
  ];

  const DIALOG_FRAMES: Array<[string, string]> = [
    ['1893/permission-bash', frameLive('opencode-live-1893', 'permission-bash')],
    ['1893/permission-edit', frameLive('opencode-live-1893', 'permission-edit')],
    ['1893/permission-after-complete', frameLive('opencode-live-1893', 'permission-after-complete')],
    ['1896/permission-over-numbered', frameLive('opencode-live-1896', 'permission-over-numbered')],
  ];

  it.each([...COMPOSER_FRAMES, ...DIALOG_FRAMES])(
    '%s keeps every gutter row and its separator',
    (_name, raw) => {
      const compacted = normalizeOpencodeTerminalOutputForDisplay(raw);
      const before = countRows(raw, hasGutter);
      expect(before).toBeGreaterThan(0);
      expect(countRows(compacted, hasGutter)).toBe(before);
      expect(countRows(compacted, hasSeparator)).toBe(countRows(raw, hasSeparator));
    },
  );

  it.each(DIALOG_FRAMES)('%s keeps its approval button strip verbatim', (_name, raw) => {
    const compacted = normalizeOpencodeTerminalOutputForDisplay(raw);
    const buttons = rows(raw).filter((r) => r.includes('Allow once'));
    expect(buttons.length).toBeGreaterThan(0);
    for (const row of buttons) expect(rows(compacted)).toContain(row);
    expect(rows(compacted).some((r) => r.includes('Permission required'))).toBe(true);
  });

  it('keeps every gutter row byte-identical, not merely present', () => {
    const raw = frame2049('two-turn-idle-11822');
    const compacted = rows(normalizeOpencodeTerminalOutputForDisplay(raw));
    for (const row of rows(raw).filter(hasGutter)) expect(compacted).toContain(row);
  });
});

describe('Issue #2049: picker / palette panel rows survive — and the old rule loses them', () => {
  const PANEL_FRAMES: Array<[string, string]> = [
    ['2049/command-palette-11822 (1.18.22)', frame2049('command-palette-11822')],
    ['1896/model-picker (1.18.21)', frameLive('opencode-live-1896', 'model-picker')],
    ['1896/command-palette (1.18.21)', frameLive('opencode-live-1896', 'command-palette')],
  ];

  it.each(PANEL_FRAMES)('%s keeps all of its painted panel rows', (_name, raw) => {
    const before = countRows(raw, isPaintedPanelRow);
    expect(before).toBeGreaterThanOrEqual(8);
    const compacted = normalizeOpencodeTerminalOutputForDisplay(raw);
    expect(countRows(compacted, isPaintedPanelRow)).toBe(before);
    for (const row of rows(raw).filter(isPaintedPanelRow)) {
      expect(rows(compacted)).toContain(row);
    }
  });

  it.each(PANEL_FRAMES)(
    '%s: the Issue #1172 rule loses one — this is why #2049 exists',
    (_name, raw) => {
      const before = countRows(raw, isPaintedPanelRow);
      const naive = normalizeTerminalOutputForDisplay(raw);
      expect(countRows(naive, isPaintedPanelRow)).toBeLessThan(before);
    },
  );

  it.each(PANEL_FRAMES)('%s keeps every picker entry row', (_name, raw) => {
    // The entry rows carry glyphs, so no rule could drop them — assert it rather
    // than assume it, since that is half of the acceptance condition.
    const entries = rows(raw).filter((r) => /\S/.test(r.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')));
    const compacted = rows(normalizeOpencodeTerminalOutputForDisplay(raw));
    for (const row of entries) expect(compacted).toContain(row);
  });
});

describe('Issue #2049: claude / codex / copilot display is unchanged', () => {
  // The rule the other tools run through is `normalizeTerminalOutputForDisplay`,
  // untouched by this Issue; `preservePaintedPanelRows` is opt-in per tool. What
  // is worth pinning here is that opting IN would not have changed them either —
  // i.e. the new predicate is inert on frames without a painted panel row.
  const OTHER_TOOL_FRAMES = (): Array<[string, string]> => {
    const dir = path.join(F_DETECT);
    const out: Array<[string, string]> = [];
    for (const sub of fs.readdirSync(dir)) {
      const full = path.join(dir, sub);
      if (!fs.statSync(full).isDirectory()) continue;
      if (sub.startsWith('opencode-live-')) continue;
      for (const file of fs.readdirSync(full).filter((f) => f.endsWith('.txt'))) {
        out.push([`${sub}/${file}`, read(path.join(full, file))]);
      }
    }
    return out;
  };

  const frames = OTHER_TOOL_FRAMES();

  it('has non-opencode capture directories to check', () => {
    expect(frames.length).toBeGreaterThan(0);
  });

  it('produces byte-identical output for every non-opencode capture', () => {
    for (const [name, raw] of frames) {
      expect(normalizeOpencodeTerminalOutputForDisplay(raw), name).toBe(
        normalizeTerminalOutputForDisplay(raw),
      );
    }
  });
});
