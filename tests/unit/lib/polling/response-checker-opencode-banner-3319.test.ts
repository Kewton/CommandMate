/**
 * Issue #3319 item 23 — nothing pinned that opencode's launch screen is not
 * saved as the agent's first reply.
 *
 * What is measured here (opencode 1.18.21 frames recorded for #1908 / #2046):
 *
 *  1. the launch frame — banner art plus the empty composer — yields no reply;
 *  2. a finished turn is still read (陰性対照).
 *
 * Note on the positive control: with `suppressOpenCodeBanner` disabled, (1) still
 * passes. `isOpenCodeComplete` has required a finished-turn marker
 * (`▣ Build · … · 2.8s`, #1893) since the banner defense was written, so a launch
 * frame never reaches that function, and a marker-bearing frame always leaves the
 * `▣` row in the response, which no skip pattern matches. The test therefore
 * guards the behavior (the completion rules), not that function (#3319 report).
 *
 * gemini's counterpart (`suppressGeminiStartupScreen`) stays untested until a
 * real gemini launch frame can be captured (#3319 decision).
 *
 * @vitest-environment node
 */

import { describe, it, expect, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { extractResponse } from '@/lib/polling/response-checker';
import { stripAnsi } from '@/lib/detection/cli-patterns';
import { buildOpencodeComposerFrame } from '../../../fixtures/opencode-launch-boot-11821';

vi.mock('@/lib/logger', () => {
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), withContext: vi.fn() };
  logger.withContext.mockReturnValue(logger);
  return { createLogger: vi.fn(() => logger), generateRequestId: vi.fn(() => 'test-request-id') };
});

const FINISHED_TURN = fs.readFileSync(
  path.join(__dirname, '../../../fixtures/opencode-live-2046/w80/agent-build.txt'),
  'utf-8'
);

describe('[#3319] opencode launch screen is not a reply', () => {
  it('the launch frame (banner + empty composer) yields no reply', () => {
    const frame = buildOpencodeComposerFrame();
    // premise: the banner art and the composer are on the frame
    expect(stripAnsi(frame)).toContain('█▀▀█');
    expect(stripAnsi(frame)).toContain('Ask anything');

    const result = extractResponse(frame, 0, 'opencode');

    expect(result?.isComplete).toBe(false);
  });

  it('陰性対照: a finished turn is read as before', () => {
    const result = extractResponse(FINISHED_TURN, 0, 'opencode');

    expect(result?.isComplete).toBe(true);
    expect(stripAnsi(result!.response)).toContain('OK2046');
  });
});
