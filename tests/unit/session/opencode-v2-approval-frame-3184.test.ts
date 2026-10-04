/**
 * Whether an OpenCode V2 approval frame is an "unclassified" frame
 * (Issue #3184, design §6-3).
 *
 * The chat surface checks `isUnclassifiedActive` before it looks at the prompt
 * payload, so if a V2 approval's frame were unclassified, an API-answerable
 * approval would still get the keystroke card however the payload is read.
 * Measured on the two existing approval fixtures instead of a live pane.
 *
 * @vitest-environment node
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/logger', () => {
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), withContext: vi.fn() };
  logger.withContext.mockReturnValue(logger);
  return { createLogger: vi.fn(() => logger), generateRequestId: vi.fn(() => 'test-request-id') };
});

import { detectSessionStatus, SELECTION_LIST_REASONS } from '@/lib/detection/status-detector';
import { isUnclassifiedFrame } from '@/lib/session/status-evidence';

const FIXTURES = join(__dirname, '../../fixtures');

const APPROVAL_FRAMES = [
  'opencode-v2-dialogs-2984/permission.txt',
  'opencode-v2-live-2945/permission-required.txt',
] as const;

describe('[#3184] OpenCode V2 approval frames are classified (design §6-3)', () => {
  it.each(APPROVAL_FRAMES)('%s', (path) => {
    const result = detectSessionStatus(readFileSync(join(FIXTURES, path), 'utf8'), 'opencode-v2');
    expect(isUnclassifiedFrame(result.status, result.reason)).toBe(false);
    // What it IS: the approval strip, read as a selection list — so the chat
    // surface's `isSelectionListActive` branch (ahead of both `unclassified`
    // and the payload branch) is what such a frame meets, and the status
    // read's waiting kind was `menu` until #3184's `apiAnswerable`.
    expect(result.status).toBe('waiting');
    expect(result.reason).toBe('opencode_permission_prompt');
    expect(SELECTION_LIST_REASONS.has(result.reason)).toBe(true);
  });
});
