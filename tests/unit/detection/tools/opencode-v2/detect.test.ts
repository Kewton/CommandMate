/**
 * OpenCode V2's fallback screen reader, against frames captured from 2.0.18
 * (Issue #2934). The state normally comes from the SSE stream; this is what
 * decides when the stream is not there.
 */

import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { getToolStatusDetector } from '@/lib/detection/tools/registry';
import { normalizeFrame } from '@/lib/detection/tools/frame';
import {
  OPENCODE_IDLE_COMPOSER_PATTERN,
  OPENCODE_V2_FOOTER_PATTERN,
  OPENCODE_V2_IDLE_COMPOSER_PATTERN,
  OPENCODE_V2_THINKING_PATTERN,
  detectThinking,
  findOpencodeV2DialogTitle,
  isOpencodeV2ComposerVisible,
  stripAnsi,
} from '@/lib/detection/cli-patterns';
import { OPENCODE_V2_VERIFIED_AGAINST } from '@/lib/detection/tools/verified-against';
import {
  opencodeV2StatusDetector,
  endsWithTurnComplete,
  OPENCODE_V2_PERMISSION_PATTERN,
  OPENCODE_V2_QUESTION_PATTERN,
  OPENCODE_V2_TURN_COMPLETE_PATTERN,
} from '@/lib/detection/tools/opencode-v2/detect';
import { opencodeStatusDetector } from '@/lib/detection/tools/opencode/detect';
import { OPENCODE_PERMISSION_PATTERN } from '@/lib/detection/cli-patterns';
import { STATUS_REASON } from '@/lib/detection/status-reason';
import { SELECTION_LIST_REASONS } from '@/lib/detection/status-detector';
import { resolveLivenessSpec } from '@/lib/cli-tools/liveness-spec';

const DIR = path.resolve(__dirname, '../../../../fixtures/opencode-v2-live-2934');
const frame = (name: string): string => fs.readFileSync(path.join(DIR, `${name}.txt`), 'utf-8');

const detector = getToolStatusDetector('opencode-v2');
const verdict = (name: string) => detector.detect(normalizeFrame(frame(name)));

describe('Issue #2934: the registry resolves OpenCode V2 to its own module', () => {
  it('is the module, stamped with the build it was read off', () => {
    expect(detector).toBe(opencodeV2StatusDetector);
    expect(detector.verifiedAgainst).toBe(OPENCODE_V2_VERIFIED_AGAINST);
    expect(OPENCODE_V2_VERIFIED_AGAINST).toEqual({
      version: '2.0.18',
      capturedAt: '2026-09-28',
      paneGeometry: '80x200',
    });
    // Issue #2965 reads the dialogs as a STATUS only: both are driven by keys
    // and answered over the agent's API, so there is still no `detectDialog`.
    expect(detector.hasDialogRules).toBe(false);
  });
});

describe('Issue #2934: frames', () => {
  it('reads the launch screen as ready', () => {
    expect(verdict('boot-idle').status).toBe('ready');
  });

  it('reads a running turn (`esc interrupt` in the footer) as running', () => {
    expect(verdict('turn-running').status).toBe('running');
  });

  it('reads the frame after a turn — a bare gutter, no placeholder — as ready', () => {
    const text = stripAnsi(frame('turn-done'));
    expect(OPENCODE_V2_IDLE_COMPOSER_PATTERN.test(text)).toBe(false);
    expect(verdict('turn-done').status).toBe('ready');
  });
});

describe('Issue #2934: the patterns (D6)', () => {
  it('finds the composer on every frame the TUI draws', () => {
    for (const name of ['boot-idle', 'turn-running', 'turn-done']) {
      expect(isOpencodeV2ComposerVisible(stripAnsi(frame(name))), name).toBe(true);
    }
    expect(isOpencodeV2ComposerVisible('maenokota@host repo % ')).toBe(false);
  });

  it('accepts the placeholder with U+2026 and with ASCII dots, only inside the gutter', () => {
    expect(OPENCODE_V2_IDLE_COMPOSER_PATTERN.test('   ┃  Ask anything… "Fix broken tests"')).toBe(true);
    expect(OPENCODE_V2_IDLE_COMPOSER_PATTERN.test('   ┃  Ask anything... "x"')).toBe(true);
    expect(OPENCODE_V2_IDLE_COMPOSER_PATTERN.test('Ask anything… in a reply')).toBe(false);
  });

  it('sees the running hint only while a turn runs', () => {
    expect(OPENCODE_V2_THINKING_PATTERN.test(stripAnsi(frame('turn-running')))).toBe(true);
    expect(OPENCODE_V2_THINKING_PATTERN.test(stripAnsi(frame('turn-done')))).toBe(false);
    expect(detectThinking('opencode-v2', stripAnsi(frame('turn-running')))).toBe(true);
    expect(OPENCODE_V2_FOOTER_PATTERN.test(stripAnsi(frame('turn-done')))).toBe(true);
  });

  it('keeps v1’s composer constant exactly as it was', () => {
    expect(OPENCODE_IDLE_COMPOSER_PATTERN.source).toBe(
      '^[^\\S\\n]*[\\u2502\\u2503][^\\S\\n]*Ask anything(?:\\.\\.\\.|\\u2026)'
    );
  });

  it('declares liveness on the footer, which a shell prompt cannot match', () => {
    const spec = resolveLivenessSpec('opencode-v2');
    expect(spec.alivePatterns).toContain(OPENCODE_V2_FOOTER_PATTERN);
    expect(spec.alivePatterns.some((p) => p.test('maenokota@host repo % '))).toBe(false);
  });
});

const DIR_2965 = path.resolve(__dirname, '../../../../fixtures/opencode-v2-live-2945');
const frame2965 = (name: string): string =>
  fs.readFileSync(path.join(DIR_2965, `${name}.txt`), 'utf-8');
const verdict2965 = (name: string) => detector.detect(normalizeFrame(frame2965(name)));

describe('Issue #2965: the dialogs and the completion row (2.0.18, 80x200)', () => {
  it('reads the approval dialog as waiting, on the key-driven menu reason', () => {
    const v = verdict2965('permission-required');
    expect(v.status).toBe('waiting');
    expect(v.reason).toBe(STATUS_REASON.OPENCODE_PERMISSION_PROMPT);
    expect(v.hasActivePrompt).toBe(false);
    expect(v.evidence).toBe('positive');
    expect(SELECTION_LIST_REASONS.has(v.reason)).toBe(true);
  });

  it('reads the question form as waiting, and never as a numbered prompt', () => {
    const v = verdict2965('question');
    expect(v.status).toBe('waiting');
    expect(v.reason).toBe(STATUS_REASON.OPENCODE_SELECTION_LIST);
    expect(v.hasActivePrompt).toBe(false);
    expect(v.promptDetection?.isPrompt ?? false).toBe(false);
    expect(SELECTION_LIST_REASONS.has(v.reason)).toBe(true);
  });

  it('reads a finished turn as ready on its completion row', () => {
    for (const name of ['turn-done-after-approval', 'question-answered']) {
      const v = verdict2965(name);
      expect(v.status, name).toBe('ready');
      expect(v.reason, name).toBe(STATUS_REASON.OPENCODE_RESPONSE_COMPLETE);
    }
    expect(verdict('turn-done').reason).toBe(STATUS_REASON.OPENCODE_RESPONSE_COMPLETE);
  });

  it('does not let the previous turn’s completion row outrank a dialog or a running turn', () => {
    // The question frame keeps `Build · … · 23.2s` above the form.
    expect(stripAnsi(frame2965('question'))).toMatch(/Build · .+ · 23\.2s/);
    expect(verdict2965('question').status).toBe('waiting');
    // A new turn under the old completion row: the footer says it is running.
    const running = frame2965('turn-done-after-approval').replace(
      /8\.8K \(1%\)  ctrl\+p commands/,
      '⬝⬝⬝⬝■■■■ esc interrupt  ctrl+p commands',
    );
    expect(detector.detect(normalizeFrame(running)).status).toBe('running');
  });

  it('reads only the LAST transcript row as the completion', () => {
    expect(endsWithTurnComplete(normalizeFrame(frame2965('question')))).toBe(false);
    expect(endsWithTurnComplete(normalizeFrame(frame2965('permission-required')))).toBe(false);
    expect(endsWithTurnComplete(normalizeFrame(frame('turn-running')))).toBe(false);
    expect(endsWithTurnComplete(normalizeFrame(frame('boot-idle')))).toBe(false);
    expect(endsWithTurnComplete(normalizeFrame(frame('turn-done')))).toBe(true);
  });

  it('keeps the rows the completion rule must not match out of it', () => {
    const row = '     Build · LongCat 2.5 Preview Free · 3.5s · 11.2 tok/s';
    expect(OPENCODE_V2_TURN_COMPLETE_PATTERN.test(row)).toBe(true);
    // A turn over a minute (seen live while an approval waited 2 minutes).
    expect(OPENCODE_V2_TURN_COMPLETE_PATTERN.test('     Build · LongCat 2.5 Preview Free · 2m 4s · 15.5 tok/s')).toBe(true);
    // The composer's model bar: gutter, no duration.
    expect(OPENCODE_V2_TURN_COMPLETE_PATTERN.test('  ┃  Build · LongCat 2.5 Preview Free OpenCode Zen')).toBe(false);
    // A step still open (no duration) and a thought row.
    expect(OPENCODE_V2_TURN_COMPLETE_PATTERN.test('     Build · LongCat 2.5 Preview Free')).toBe(false);
    expect(OPENCODE_V2_TURN_COMPLETE_PATTERN.test('     + Thought · 979ms')).toBe(false);
    // v1's row.
    expect(OPENCODE_V2_TURN_COMPLETE_PATTERN.test('▣  Build · gpt-5-mini · 2.3s')).toBe(false);
  });
});

describe('Issue #2965: the dialog patterns against v1 and against reply text', () => {
  it('reads v2’s word order and not v1’s', () => {
    const v2 = '  ┃   Allow once   Always allow   Reject  ctrl+f fullscreen  ⇆ select  enter con';
    const v1 = '  ┃   Allow once   Allow always   Reject';
    expect(OPENCODE_V2_PERMISSION_PATTERN.test(v2)).toBe(true);
    expect(OPENCODE_V2_PERMISSION_PATTERN.test(v1)).toBe(false);
    // v1's own rule is untouched, and does not read v2's strip either.
    expect(OPENCODE_PERMISSION_PATTERN.test(v1)).toBe(true);
    expect(OPENCODE_PERMISSION_PATTERN.test(v2)).toBe(false);
    expect(opencodeStatusDetector.detect(normalizeFrame(frame2965('permission-required'))).reason).not.toBe(
      STATUS_REASON.OPENCODE_PERMISSION_PROMPT,
    );
  });

  it('needs the gutter: the same words in a reply are not a dialog', () => {
    expect(OPENCODE_V2_PERMISSION_PATTERN.test('     Allow once   Always allow   Reject')).toBe(false);
    expect(OPENCODE_V2_QUESTION_PATTERN.test('     ↑↓ select  enter submit  esc dismiss')).toBe(false);
    expect(OPENCODE_V2_QUESTION_PATTERN.test('  ┃  ↑↓ select  enter submit  esc dismiss')).toBe(true);
  });
});

describe('Issue #2965: controls written outside the repository', () => {
  let tmp: string | null = null;
  afterEach(() => {
    if (tmp !== null) fs.rmSync(tmp, { recursive: true, force: true });
    tmp = null;
  });

  const readVia = (name: string, text: string) => {
    tmp = tmp ?? fs.mkdtempSync(path.join(os.tmpdir(), 'ocv2-2965-'));
    const file = path.join(tmp, name);
    fs.writeFileSync(file, text, 'utf-8');
    return detector.detect(normalizeFrame(fs.readFileSync(file, 'utf-8')));
  };

  it('positive: the captured dialogs, copied byte for byte, are waiting', () => {
    expect(readVia('perm.txt', frame2965('permission-required')).status).toBe('waiting');
    expect(readVia('question.txt', frame2965('question')).status).toBe('waiting');
  });

  it('negative: the same frames with the gutter removed from the dialog row are not', () => {
    const perm = frame2965('permission-required').replace(/^(\s*)┃(\s+Allow once)/m, '$1 $2');
    const question = frame2965('question').replace(/^(\s*)┃(\s+↑↓ select)/m, '$1 $2');
    expect(readVia('perm-no-gutter.txt', perm).status).not.toBe('waiting');
    expect(readVia('question-no-gutter.txt', question).status).not.toBe('waiting');
  });
});

const DIR_2971 = path.resolve(__dirname, '../../../../fixtures/opencode-v2-live-2971');
const frame2971 = (name: string): string =>
  fs.readFileSync(path.join(DIR_2971, `${name}.txt`), 'utf-8');

describe('Issue #2971: a dialog open over the composer (2.0.18, 80x200)', () => {
  it.each([
    ['select-model', 'Select model'],
    ['select-variant', 'Select variant'],
    ['select-variant-typed', 'Select variant'],
    ['select-variant-over-transcript', 'Select variant'],
    ['commands', 'Commands'],
    ['sessions', 'Sessions for repo'],
    ['select-agent', 'Select agent'],
  ])('finds the %s dialog by its title row', (name, title) => {
    const text = stripAnsi(frame2971(name));
    expect(findOpencodeV2DialogTitle(text)).toBe(title);
    // Why the composer check alone let the send through: the footer is still drawn.
    expect(isOpencodeV2ComposerVisible(text)).toBe(true);
  });

  it('keeps the UAT shape: the typed body sits in the filter, not the composer', () => {
    const text = stripAnsi(frame2971('select-variant-typed'));
    expect(text).toMatch(/^\s+Reply with exactly: UAT-MODEL-2$/m);
    expect(text).toMatch(/No results found/);
  });

  it('finds no dialog on the composer, approval, question, running and finished frames', () => {
    for (const name of ['boot-idle', 'turn-running', 'turn-done']) {
      expect(findOpencodeV2DialogTitle(stripAnsi(frame(name))), name).toBeNull();
    }
    for (const name of ['permission-required', 'question', 'question-answered', 'turn-done-after-approval']) {
      expect(findOpencodeV2DialogTitle(stripAnsi(frame2965(name))), name).toBeNull();
    }
  });

  it('leaves the verdicts of those frames as they were', () => {
    expect(verdict('boot-idle').status).toBe('ready');
    expect(verdict('turn-running').status).toBe('running');
    expect(verdict('turn-done').status).toBe('ready');
    expect(verdict2965('permission-required').status).toBe('waiting');
    expect(verdict2965('question').status).toBe('waiting');
  });

  it('does not read the hints that end in other words, or a gutter row, as a title', () => {
    expect(findOpencodeV2DialogTitle('   /…/repo:main  ⬝⬝■■ esc interrupt  ctrl+p commands')).toBeNull();
    expect(findOpencodeV2DialogTitle('  ┃  ↑↓ select  enter submit  esc dismiss')).toBeNull();
    expect(findOpencodeV2DialogTitle('  ┃  Select model                           esc')).toBeNull();
    expect(findOpencodeV2DialogTitle('     Press esc to close the picker.')).toBeNull();
  });
});

describe('Issue #2971: controls written outside the repository', () => {
  let tmp: string | null = null;
  afterEach(() => {
    if (tmp !== null) fs.rmSync(tmp, { recursive: true, force: true });
    tmp = null;
  });

  const readVia = (name: string, text: string): string | null => {
    tmp = tmp ?? fs.mkdtempSync(path.join(os.tmpdir(), 'ocv2-2971-'));
    const file = path.join(tmp, name);
    fs.writeFileSync(file, text, 'utf-8');
    return findOpencodeV2DialogTitle(stripAnsi(fs.readFileSync(file, 'utf-8')));
  };

  it('positive: the captured dialog, copied byte for byte, is found', () => {
    expect(readVia('variant.txt', frame2971('select-variant-typed'))).toBe('Select variant');
  });

  it('negative: the same frame with the title row’s `esc` removed is not', () => {
    const noHint = frame2971('select-variant-typed').replace(/^(\s+Select variant)\s+esc$/m, '$1');
    expect(readVia('variant-no-esc.txt', noHint)).toBeNull();
  });
});
