/**
 * Issue #2361: the model of a Claude session after `/model`, read off the
 * confirmation line the switch prints — the one place a mid-session switch is
 * stated on a pane whose startup banner has scrolled away.
 *
 * Every positive frame here is a live capture from claude 2.1.263 at the
 * production 200x1000 geometry (`tests/fixtures/claude-model-switch-2361/`,
 * and that directory's README for what was measured and how). The Issue's
 * starting point — `Set model to Sonnet 5 and saved as your default for new
 * sessions` — turned out to be one of three suffixes, and two of the frames
 * below exist because the premise did not survive the probe:
 *
 *  - the banner is REWRITTEN IN PLACE on every switch (fullscreen and inline,
 *    and by `/effort` and `/fast` as well), so it is the freshest statement
 *    for as long as it is on screen and the line matters once the banner is
 *    gone (`fullscreen-switch-sonnet-banner-scrolled.txt`). The Issue's
 *    "lowest row wins" is pinned as the WRONG answer on `fullscreen-fast-on`;
 *  - the scope suffix precedes the effort (`… for new sessions with high
 *    effort`), and the effort is printed only when the picker's effort row was
 *    moved;
 *  - Haiku's rewritten banner has no effort clause, so the banner reader does
 *    not read it and the line is what publishes the model;
 *  - `/fast` prints `Fast mode ON · model set to Opus 5` — a real switch, and
 *    deliberately not read (see the reader's doc).
 *
 * The negative frame is the 2.1.263 release notes — hundreds of prose rows
 * about `/model`, the model picker and model ids — which must read as unknown.
 *
 * @vitest-environment node
 */

import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { stripAnsi } from '@/lib/detection/ansi';
import {
  CLAUDE_MODEL_SWITCH_PATTERN,
  extractModelInfo,
  type ModelInfo,
} from '@/lib/detection/model-info-extractor';

const UNKNOWN: ModelInfo = { model: null, effort: null };

const FIXTURE_DIR = path.resolve(__dirname, '../../../fixtures/claude-model-switch-2361');

const frame = (name: string): string => fs.readFileSync(path.join(FIXTURE_DIR, `${name}.txt`), 'utf8');

/**
 * Every frame in the directory and what it must read as. The inventory test
 * below fails if a file is added without a row here, so a sweep is never
 * partial.
 */
const LIVE_FRAMES: ReadonlyArray<readonly [name: string, expected: ModelInfo, why: string]> = [
  ['fullscreen-boot-fable', { model: 'Fable 5.1', effort: 'xhigh' }, 'the startup banner, as before this Issue'],
  ['fullscreen-picker-open', { model: 'Fable 5.1', effort: 'xhigh' }, 'the /model picker open changes nothing'],
  ['fullscreen-switch-sonnet-session-only', { model: 'Sonnet 5', effort: 'xhigh' }, '`s` in the picker: the banner, rewritten to Sonnet 5, wins while on screen'],
  ['fullscreen-switch-opus-default-effort-high', { model: 'Opus 5 (1M context)', effort: 'high' }, 'Enter in the picker with the effort row moved: banner and line agree'],
  ['fullscreen-switch-haiku-arg', { model: 'Haiku 4.5', effort: null }, '`/model haiku`: the rewritten banner has no effort clause, the line publishes the model'],
  ['fullscreen-same-model-haiku-arg', { model: 'Haiku 4.5', effort: null }, 'the same model picked again prints the same line'],
  ['fullscreen-picker-escaped-kept', { model: 'Haiku 4.5', effort: null }, 'Esc in the picker: `Kept model as`'],
  ['fullscreen-fast-on', { model: 'Opus 5 (1M context)', effort: 'high' }, '`/fast`: the rewritten banner, NOT the lowest line (`Kept model as Haiku 4.5`)'],
  ['fullscreen-fast-off', { model: 'Opus 5 (1M context)', effort: 'low' }, '`Fast mode OFF` names nothing and the model does not revert; the banner says so'],
  ['fullscreen-after-clear', UNKNOWN, '`/clear` leaves only a Haiku banner, which has no effort clause: honest unknown, the latch holds'],
  ['fullscreen-effort-low', { model: 'Fable 5.1', effort: 'low' }, '`/effort low` rewrites the banner, and the banner wins over the older switch line below it'],
  ['inline-switch-sonnet-arg', { model: 'Sonnet 5', effort: 'xhigh' }, 'the inline (non-fullscreen) renderer prints the same line and rewrites the same banner'],
  ['inline-switch-haiku-banner-scrolled', { model: 'Haiku 4.5', effort: null }, 'inline, banner in scrollback: the line alone'],
  ['fullscreen-switch-sonnet-banner-scrolled', { model: 'Sonnet 5', effort: null }, 'THE Issue: banner gone, the line is the only source'],
  ['fullscreen-switch-line-scrolled', UNKNOWN, 'the line gone too, 977 rows of release-notes prose: unknown'],
];

/** The lowest confirmation row of a frame, after `stripAnsi`. */
function switchRow(name: string): string {
  const rows = frame(name).split('\n').map(stripAnsi);
  const hits = rows.filter((row) => /⎿\s+(?:Set model to|Kept model as|↯ Fast mode ON)/.test(row));
  if (hits.length === 0) throw new Error(`${name}: no confirmation row — the assertion would be vacuous`);
  return hits[hits.length - 1];
}

// =============================================================================
// The live frames
// =============================================================================

describe('extractModelInfo: claude /model confirmation (Issue #2361)', () => {
  it('names every frame in the fixture directory, so the sweep below is not partial', () => {
    const onDisk = fs
      .readdirSync(FIXTURE_DIR)
      .filter((file) => file.endsWith('.txt'))
      .map((file) => file.replace(/\.txt$/, ''))
      .sort();
    expect(LIVE_FRAMES.map(([name]) => name).sort()).toEqual(onDisk);
  });

  it.each(LIVE_FRAMES)('%s → %j (%s)', (name, expected) => {
    expect(extractModelInfo('claude', frame(name))).toEqual(expected);
  });

  it('reads the acceptance frame from the confirmation line and from nothing else', () => {
    // The Issue's first acceptance criterion, with the vacuity removed: the
    // same frame with its one `Set model to` row cut reads as unknown, so the
    // Sonnet 5 above can only have come from that row.
    const raw = frame('fullscreen-switch-sonnet-banner-scrolled');
    const rows = raw.split('\n');
    const switchRows = rows.filter((row) => stripAnsi(row).includes('Set model to'));
    expect(switchRows).toHaveLength(1);
    expect(extractModelInfo('claude', raw).model).toBe('Sonnet 5');
    const without = rows.filter((row) => !stripAnsi(row).includes('Set model to')).join('\n');
    expect(extractModelInfo('claude', without)).toEqual(UNKNOWN);
  });

  it('the banner wins while on screen: the Issue\'s "lowest row" answers the stale model on the /fast frame', () => {
    // `/model haiku` twice, `/model` + Esc, then `/fast`: the lowest
    // confirmation is `Kept model as Haiku 4.5`, the banner above it was
    // rewritten to Opus 5 (1M context) by the `/fast` that followed.
    const raw = frame('fullscreen-fast-on');
    expect(switchRow('fullscreen-fast-on')).toBe('  ⎿  ↯ Fast mode ON · model set to Opus 5 · $10/$50 per Mtok');
    const rows = raw.split('\n');
    const lowestModelLine = [...rows].reverse().find((row) => /Set model to|Kept model as/.test(stripAnsi(row)));
    expect(stripAnsi(lowestModelLine!)).toBe('  ⎿  Kept model as Haiku 4.5');
    expect(extractModelInfo('claude', raw)).toEqual({ model: 'Opus 5 (1M context)', effort: 'high' });
    // And with the banner cut out, the lowest line is what is left — the
    // fallback, not the rule.
    const bannerRows = rows.filter((row) => stripAnsi(row).includes('with high effort · API Usage Billing'));
    expect(bannerRows).toHaveLength(1);
    const withoutBanner = rows.filter((row) => !bannerRows.includes(row)).join('\n');
    expect(extractModelInfo('claude', withoutBanner)).toEqual({ model: 'Haiku 4.5', effort: null });
  });

  it('reads the raw ANSI-bearing row — the model is wrapped in its own SGR', () => {
    const raw = frame('fullscreen-switch-sonnet-session-only')
      .split('\n')
      .find((row) => row.includes('Set model to'));
    expect(raw).toBeDefined();
    // The value really is inside colour codes on the wire.
    expect(raw).toMatch(/Set model to \[[0-9;]*mSonnet 5\[[0-9;]*m for this session only/);
    expect(extractModelInfo('claude', raw!)).toEqual({ model: 'Sonnet 5', effort: null });
  });

  it('answers unknown for every single row of the release-notes frame', () => {
    // Row by row, not only as a whole frame: a whole-frame read would stop at
    // the first hit and never test the rows above it.
    const rows = frame('fullscreen-switch-line-scrolled').split('\n').map(stripAnsi);
    const aboutModels = rows.filter((row) => /model/i.test(row));
    expect(aboutModels.length).toBeGreaterThan(20);
    for (const row of rows) {
      expect(extractModelInfo('claude', row), row).toEqual(UNKNOWN);
    }
  });
});

// =============================================================================
// The line, shape by shape
// =============================================================================

describe('CLAUDE_MODEL_SWITCH_PATTERN', () => {
  it.each([
    ['fullscreen-switch-sonnet-session-only', '  ⎿  Set model to Sonnet 5 for this session only'],
    ['fullscreen-switch-opus-default-effort-high', '  ⎿  Set model to Opus 5 (1M context) and saved as your default for new sessions with high effort'],
    ['fullscreen-switch-haiku-arg', '  ⎿  Set model to Haiku 4.5 and saved as your default for new sessions'],
    ['fullscreen-picker-escaped-kept', '  ⎿  Kept model as Haiku 4.5'],
  ])('%s carries the measured row verbatim: %s', (name, row) => {
    expect(switchRow(name)).toBe(row);
  });

  it('reads the three measured suffix forms', () => {
    expect(extractModelInfo('claude', '  ⎿  Set model to Sonnet 5 for this session only')).toEqual({
      model: 'Sonnet 5',
      effort: null,
    });
    expect(
      extractModelInfo('claude', '  ⎿  Set model to Haiku 4.5 and saved as your default for new sessions')
    ).toEqual({ model: 'Haiku 4.5', effort: null });
    expect(
      extractModelInfo(
        'claude',
        '  ⎿  Set model to Opus 5 (1M context) and saved as your default for new sessions with high effort'
      )
    ).toEqual({ model: 'Opus 5 (1M context)', effort: 'high' });
  });

  it('keeps the parenthesised qualifier inside the model — the effort clause comes after the scope suffix', () => {
    // A lazy label that stopped at `(` would publish "Opus 5" for the 1M model.
    const match = CLAUDE_MODEL_SWITCH_PATTERN.exec(
      '  ⎿  Set model to Opus 5 (1M context) and saved as your default for new sessions with high effort'
    );
    expect(match?.[1]).toBe('Opus 5 (1M context)');
    expect(match?.[2]).toBe('high');
  });

  it('reads `Kept model as` — the Esc outcome names the current model', () => {
    expect(extractModelInfo('claude', '  ⎿  Kept model as Opus 5 (1M context)')).toEqual({
      model: 'Opus 5 (1M context)',
      effort: null,
    });
  });

  it('publishes the model and a null effort for an effort word outside the vocabulary', () => {
    // `ultracode` is what the binary prints for its ultracode level; like
    // Command Code's `max` it is not a ReasoningEffort and is not promoted.
    expect(
      extractModelInfo(
        'claude',
        '  ⎿  Set model to Opus 5 (1M context) for this session only with ultracode effort (ultracode applies to this session only)'
      )
    ).toEqual({ model: 'Opus 5 (1M context)', effort: null });
  });

  it('stops the model at the middle dot that opens the fast-mode / credits suffixes', () => {
    // Suffixes the binary appends (`p7`): ` · Fast mode ON`, ` · Draws from
    // usage credits`, ` · Fast mode OFF`. Not captured live; shape from the
    // binary's own template, pinned so a suffix cannot become part of the name.
    expect(extractModelInfo('claude', '  ⎿  Set model to Sonnet 5 for this session only · Fast mode OFF')).toEqual({
      model: 'Sonnet 5',
      effort: null,
    });
    expect(
      extractModelInfo(
        'claude',
        '  ⎿  Set model to Opus 5 and saved as your default for new sessions · Fast mode ON · Draws from usage credits'
      )
    ).toEqual({ model: 'Opus 5', effort: null });
  });

  it('requires the ⎿ marker: the same sentence as prose is not a switch', () => {
    expect(extractModelInfo('claude', 'Set model to Sonnet 5 for this session only')).toEqual(UNKNOWN);
    expect(extractModelInfo('claude', '● Set model to Sonnet 5 for this session only')).toEqual(UNKNOWN);
    expect(
      extractModelInfo('claude', '  I would run `/model sonnet`, which prints "Set model to Sonnet 5 for this session only".')
    ).toEqual(UNKNOWN);
  });

  it('does not read the /effort confirmation, which shares the marker and the verb', () => {
    expect(switchRow('fullscreen-effort-low')).not.toMatch(/Set effort level/);
    expect(
      extractModelInfo(
        'claude',
        '  ⎿  Set effort level to low (saved as your default for new sessions): Quick, straightforward implementation with minimal overhead'
      )
    ).toEqual(UNKNOWN);
  });

  it('does not read a nested marker — a tool result that echoed another pane', () => {
    // `commandmate capture` run through the Bash tool renders the other pane's
    // rows under its own ⎿; the first of them is that pane's marker, not text.
    expect(extractModelInfo('claude', '  ⎿    ⎿  Set model to Sonnet 5 for this session only')).toEqual(UNKNOWN);
  });

  it('rejects a name the label shape does not admit, and an empty one', () => {
    expect(CLAUDE_MODEL_SWITCH_PATTERN.exec('  ⎿  Set model to  for this session only')).toBeNull();
    expect(extractModelInfo('claude', '  ⎿  Set model to → Sonnet 5 for this session only')).toEqual(UNKNOWN);
  });

  it('is stateless (no /g) and reads the same row twice', () => {
    const row = '  ⎿  Set model to Sonnet 5 for this session only';
    expect(CLAUDE_MODEL_SWITCH_PATTERN.exec(row)?.[1]).toBe('Sonnet 5');
    expect(CLAUDE_MODEL_SWITCH_PATTERN.exec(row)?.[1]).toBe('Sonnet 5');
  });
});

describe('the /fast line (measured, deliberately not read)', () => {
  it('carries the measured row verbatim, and reads as nothing on its own', () => {
    const row = '  ⎿  ↯ Fast mode ON · model set to Opus 5 · $10/$50 per Mtok';
    expect(switchRow('fullscreen-fast-on')).toBe(row);
    // `Opus 5` here is `Opus 5 (1M context)` on the banner and in `Kept model
    // as`; #2357 compares one channel exactly, so publishing this spelling
    // would announce a spurious change the next time the fuller one appears.
    expect(extractModelInfo('claude', row)).toEqual(UNKNOWN);
    expect(extractModelInfo('claude', '  ⎿  Fast mode OFF')).toEqual(UNKNOWN);
  });
});

// =============================================================================
// Banner and line on one pane
// =============================================================================

describe('extractModelInfo: claude banner and confirmation line together', () => {
  const BANNER_FABLE = '▝▜██████▀  Fable 5.1 with xhigh effort · API Usage Billing';
  const BANNER_SONNET = '▝▜██████▀  Sonnet 5 with low effort · API Usage Billing';
  const LINE_SONNET = '  ⎿  Set model to Sonnet 5 for this session only';

  it('the banner wins over a line below it — the banner is rewritten in place, so it is current', () => {
    const capture = [BANNER_SONNET, '', '❯ /model', LINE_SONNET, '', '❯ '].join('\n');
    expect(extractModelInfo('claude', capture)).toEqual({ model: 'Sonnet 5', effort: 'low' });
  });

  it('the banner wins over a line below it even when they disagree', () => {
    // Only reachable on a pane whose banner is NOT rewritten (scrollback
    // captured under geometry delegation). The banner is chrome; the line is
    // history.
    const capture = [BANNER_FABLE, '', '❯ /model', LINE_SONNET, '', '❯ '].join('\n');
    expect(extractModelInfo('claude', capture)).toEqual({ model: 'Fable 5.1', effort: 'xhigh' });
  });

  it('the LAST banner wins, as before (#1784)', () => {
    const capture = [BANNER_FABLE, '', LINE_SONNET, '', BANNER_SONNET, '', '❯ '].join('\n');
    expect(extractModelInfo('claude', capture)).toEqual({ model: 'Sonnet 5', effort: 'low' });
  });

  it('falls back to the LAST confirmation line when no banner is readable', () => {
    const capture = [
      '  ⎿  Set model to Sonnet 5 for this session only',
      '',
      '  ⎿  Set model to Haiku 4.5 and saved as your default for new sessions',
      '',
      '  ⎿  Kept model as Haiku 4.5',
      '',
      '❯ ',
    ].join('\n');
    expect(extractModelInfo('claude', capture)).toEqual({ model: 'Haiku 4.5', effort: null });
  });

  it('falls back past a banner the banner reader cannot read (Haiku, no effort clause)', () => {
    const capture = ['▝▜██████▀  Haiku 4.5 · API Usage Billing', '', '❯ /model haiku', '  ⎿  Set model to Haiku 4.5 and saved as your default for new sessions', '', '❯ '].join('\n');
    expect(extractModelInfo('claude', capture)).toEqual({ model: 'Haiku 4.5', effort: null });
  });

  it('takes the effort the line itself prints', () => {
    const line = '  ⎿  Set model to Sonnet 5 for this session only with high effort';
    expect(extractModelInfo('claude', ['❯ /model', line, '', '❯ '].join('\n'))).toEqual({ model: 'Sonnet 5', effort: 'high' });
  });

  it('is scoped to claude: the same rows read as nothing for every other tool', () => {
    const capture = [BANNER_SONNET, LINE_SONNET].join('\n');
    for (const tool of ['codex', 'antigravity', 'copilot', 'opencode', 'command-code', 'gemini', 'vibe-local'] as const) {
      expect(extractModelInfo(tool, capture), tool).toEqual(UNKNOWN);
    }
  });
});
