/**
 * OpenCode V2's fallback screen reader, against frames captured from 2.0.18
 * (Issue #2934). The state normally comes from the SSE stream; this is what
 * decides when the stream is not there.
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { getToolStatusDetector } from '@/lib/detection/tools/registry';
import { normalizeFrame } from '@/lib/detection/tools/frame';
import {
  OPENCODE_IDLE_COMPOSER_PATTERN,
  OPENCODE_V2_FOOTER_PATTERN,
  OPENCODE_V2_IDLE_COMPOSER_PATTERN,
  OPENCODE_V2_THINKING_PATTERN,
  detectThinking,
  isOpencodeV2ComposerVisible,
  stripAnsi,
} from '@/lib/detection/cli-patterns';
import { OPENCODE_V2_VERIFIED_AGAINST } from '@/lib/detection/tools/verified-against';
import { opencodeV2StatusDetector } from '@/lib/detection/tools/opencode-v2/detect';
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
    // Phase 3 reads the approval dialog; Phase 1 declares none.
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
