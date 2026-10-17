/**
 * What the strict `respond` reads off a screen before any key (Issue #3756):
 * the option an answer names, the keys that reach it, and whether the screen
 * is the open one at the bottom of the pane.
 *
 * @vitest-environment node
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import {
  isScreenOpenAtBottom,
  resolveStrictChoice,
  sameApprovalTarget,
  strictAnswerKeys,
} from '@/lib/prompt-observation/strict-choice';
import { classifyScreen } from '@/lib/prompt-observation/classify';

const FIXTURES = path.resolve(__dirname, '../../../fixtures');
const read = (rel: string): string => readFileSync(path.join(FIXTURES, rel), 'utf8');

const TRUST_3746 = read('prompt-observation-3755/antigravity-trust.txt');
const TRUST_2364 = read('antigravity-live-2364/trust-dialog.txt');
const PERMISSION = read('antigravity-live-2364/dialog-bash-oneline.txt');
const COMPOSER = read('antigravity-live-2364/boot-idle.txt');

const TRUST_OPTIONS = ['Yes, I trust this folder', 'No, exit'];
const PERMISSION_OPTIONS = [
  'Yes',
  "Yes, and always allow in this conversation for commands that start with 'python3 -c'",
  "Yes, and always allow for commands that start with 'python3 -c' (Persist to settings.json)",
  'No',
];

describe('[#3756] resolveStrictChoice', () => {
  it('picks "Yes, I trust this folder" for the label Yes on the trust screen', () => {
    expect(resolveStrictChoice('antigravity-trust', TRUST_OPTIONS, 'Yes')).toEqual({ ok: true, index: 0 });
    expect(resolveStrictChoice('antigravity-trust', TRUST_OPTIONS, 'yes, i trust  this folder')).toEqual({ ok: true, index: 0 });
    expect(resolveStrictChoice('antigravity-trust', TRUST_OPTIONS, 'No')).toEqual({ ok: true, index: 1 });
  });

  it('refuses an option number on the unnumbered trust screen', () => {
    expect(resolveStrictChoice('antigravity-trust', TRUST_OPTIONS, '1')).toEqual({
      ok: false,
      reason: 'number_on_unnumbered_screen',
    });
  });

  it('takes an option number on the numbered permission dialog, within range', () => {
    expect(resolveStrictChoice('antigravity-permission', PERMISSION_OPTIONS, '4')).toEqual({ ok: true, index: 3 });
    expect(resolveStrictChoice('antigravity-permission', PERMISSION_OPTIONS, '5')).toEqual({
      ok: false,
      reason: 'number_out_of_range',
    });
  });

  it('an exact label wins over the labels it starts', () => {
    // Three rows start with "Yes"; one IS "Yes".
    expect(resolveStrictChoice('antigravity-permission', PERMISSION_OPTIONS, 'Yes')).toEqual({ ok: true, index: 0 });
  });

  it('refuses a label two options match, and a repeated label', () => {
    expect(resolveStrictChoice('antigravity-permission', PERMISSION_OPTIONS, 'Yes, and always')).toEqual({
      ok: false,
      reason: 'label_ambiguous',
    });
    expect(resolveStrictChoice('antigravity-trust', ['Yes', 'Yes'], 'Yes')).toEqual({ ok: false, reason: 'label_ambiguous' });
  });

  it('refuses a label no visible option has, and a prefix cut inside a word', () => {
    expect(resolveStrictChoice('antigravity-trust', TRUST_OPTIONS, 'Maybe')).toEqual({ ok: false, reason: 'label_not_found' });
    expect(resolveStrictChoice('antigravity-trust', TRUST_OPTIONS, 'Ye')).toEqual({ ok: false, reason: 'label_not_found' });
  });
});

describe('[#3756] strictAnswerKeys', () => {
  it('is Enter alone on the highlighted row, and arrows then Enter otherwise', () => {
    expect(strictAnswerKeys(0, 0)).toEqual(['Enter']);
    expect(strictAnswerKeys(0, 2)).toEqual(['Down', 'Down', 'Enter']);
    expect(strictAnswerKeys(3, 1)).toEqual(['Up', 'Up', 'Enter']);
  });
});

describe('[#3756] isScreenOpenAtBottom', () => {
  it('holds for the measured trust screens and the permission dialog', () => {
    expect(isScreenOpenAtBottom(TRUST_3746)).toBe(true);
    expect(isScreenOpenAtBottom(TRUST_2364)).toBe(true);
    expect(isScreenOpenAtBottom(PERMISSION)).toBe(true);
  });

  it('fails for the idle composer', () => {
    expect(isScreenOpenAtBottom(COMPOSER)).toBe(false);
  });

  it('fails for a trust screen quoted in a reply still being generated (#3755 L3), which the classifier reads as trust', () => {
    const quoted = `${TRUST_3746.trimEnd()}\n\nThat was the screen agy showed.\nIt asks whether the folder is trusted.\nThe answer is up to you.\nGenerating…\n`;
    expect(classifyScreen({ cliToolId: 'antigravity', fullOutput: quoted, sessionStatus: 'running' }).kind).toBe(
      'antigravity-trust'
    );
    expect(isScreenOpenAtBottom(quoted)).toBe(false);
  });

  it('fails when a composer is drawn under the footer', () => {
    expect(isScreenOpenAtBottom(`${TRUST_3746.trimEnd()}\n>\n`)).toBe(false);
  });
});

describe('[#3756] sameApprovalTarget', () => {
  it('matches the folder as drawn, and never a null', () => {
    expect(sameApprovalTarget('~/agy2364-probe', ' ~/agy2364-probe ')).toBe(true);
    expect(sameApprovalTarget('~/agy2364-probe', '~/other')).toBe(false);
    expect(sameApprovalTarget(null, '~/agy2364-probe')).toBe(false);
    expect(sameApprovalTarget('~/agy2364-probe', null)).toBe(false);
  });
});
