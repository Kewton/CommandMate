/**
 * OpenCode V2 cannot be a schedule's CLI Tool yet (Issue #2934).
 *
 * Phase 1 of Epic #2370 runs it interactively only; the headless path
 * (`opencode2 run`) is Phase 4. The parser and the validator must agree: the
 * validator reports the row, the parser skips it, and no other tool changes.
 */

import { describe, expect, it, vi } from 'vitest';

const { mockLogger } = vi.hoisted(() => {
  const mockLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    withContext: vi.fn().mockReturnThis(),
  };
  return { mockLogger };
});
vi.mock('@/lib/logger', () => ({
  createLogger: vi.fn(() => mockLogger),
}));

import { parseSchedulesSection } from '@/lib/cmate-parser';
import { validateSchedulesSection } from '@/lib/cmate-validator';
import {
  SCHEDULE_UNSUPPORTED_CLI_TOOLS,
  getPermissionOptionsForTool,
  isScheduleSupportedCliTool,
} from '@/config/schedule-config';
import { CLI_TOOL_IDS } from '@/lib/cli-tools/types';

describe('opencode-v2 in CMATE.md (Issue #2934)', () => {
  const row = ['v2-task', '0 9 * * *', 'Do something', 'opencode-v2', 'true', ''];

  it('is a validation error naming the tool', () => {
    const errors = validateSchedulesSection([row]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ row: 0, field: 'cliTool' });
    expect(errors[0].message).toContain('"opencode-v2" is not supported in schedules yet');
  });

  it('is skipped by the parser, so no run is ever built for it', () => {
    expect(parseSchedulesSection([row])).toEqual([]);
    expect(mockLogger.warn).toHaveBeenCalledWith('parse:unsupported-cli-tool', {
      name: 'v2-task',
      cliToolId: 'opencode-v2',
    });
  });

  it('offers no permission values', () => {
    expect(getPermissionOptionsForTool('opencode-v2')).toEqual([]);
  });

  it('leaves every other tool schedulable', () => {
    expect(SCHEDULE_UNSUPPORTED_CLI_TOOLS).toEqual(['opencode-v2']);
    for (const id of CLI_TOOL_IDS) {
      expect(isScheduleSupportedCliTool(id), id).toBe(id !== 'opencode-v2');
    }
    // v1 is untouched.
    const v1 = ['v1-task', '0 9 * * *', 'Do something', 'opencode', 'true', ''];
    expect(validateSchedulesSection([v1])).toEqual([]);
    expect(parseSchedulesSection([v1])).toHaveLength(1);
  });
});
