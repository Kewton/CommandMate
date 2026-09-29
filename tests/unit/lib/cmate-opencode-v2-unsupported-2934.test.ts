/**
 * OpenCode V2 as a schedule's CLI Tool.
 *
 * Issue #2934 kept it out (Phase 1 had no headless path); Issue #2974 measured
 * `opencode2 run --standalone --format json` and let it in. The parser and the
 * validator must still agree: both accept the row, both accept the same
 * Permission values, both reject the same out-of-vocabulary value, and no other
 * tool changes.
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
  DEFAULT_PERMISSIONS,
  OPENCODE_V2_PERMISSIONS,
  SCHEDULE_UNSUPPORTED_CLI_TOOLS,
  getPermissionOptionsForTool,
  isScheduleSupportedCliTool,
} from '@/config/schedule-config';
import { CLI_TOOL_IDS } from '@/lib/cli-tools/types';

describe('opencode-v2 in CMATE.md (Issue #2934 → #2974)', () => {
  const row = (permission: string) => ['v2-task', '0 9 * * *', 'Do something', 'opencode-v2', 'true', permission];

  it('passes validation and is parsed, not skipped', () => {
    expect(validateSchedulesSection([row('')])).toEqual([]);
    const parsed = parseSchedulesSection([row('')]);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({ name: 'v2-task', cliToolId: 'opencode-v2' });
    expect(mockLogger.warn).not.toHaveBeenCalledWith('parse:unsupported-cli-tool', expect.anything());
  });

  it('an empty Permission cell resolves to `default` (no --auto)', () => {
    expect(DEFAULT_PERMISSIONS['opencode-v2']).toBe('default');
    expect(parseSchedulesSection([row('')])[0].permission).toBe('default');
  });

  it.each(['default', 'auto'])('accepts Permission "%s" in both parser and validator', (permission) => {
    expect(validateSchedulesSection([row(permission)])).toEqual([]);
    expect(parseSchedulesSection([row(permission)])[0].permission).toBe(permission);
  });

  it.each(['acceptEdits', 'yolo', 'workspace-write'])(
    'rejects another tool\'s Permission "%s" in both parser and validator',
    (permission) => {
      const errors = validateSchedulesSection([row(permission)]);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatchObject({ row: 0, field: 'permission' });
      // The parser falls back to the default rather than passing it on.
      expect(parseSchedulesSection([row(permission)])[0].permission).toBe('default');
    }
  );

  it('does not accept v1\'s run options in the column yet (the row is skipped)', () => {
    const withModel = ['v2-task', '0 9 * * *', 'Do something', 'opencode-v2 --model ollama/qwen3:8b', 'true', ''];
    expect(validateSchedulesSection([withModel])[0]).toMatchObject({ field: 'cliTool' });
    expect(parseSchedulesSection([withModel])).toEqual([]);
  });

  it('offers `default` and `auto` in the dialog / writer vocabulary', () => {
    expect(getPermissionOptionsForTool('opencode-v2')).toBe(OPENCODE_V2_PERMISSIONS);
    expect([...OPENCODE_V2_PERMISSIONS]).toEqual(['default', 'auto']);
  });

  it('leaves every tool schedulable, and v1 untouched', () => {
    expect(SCHEDULE_UNSUPPORTED_CLI_TOOLS).toEqual([]);
    for (const id of CLI_TOOL_IDS) {
      expect(isScheduleSupportedCliTool(id), id).toBe(true);
    }
    const v1 = ['v1-task', '0 9 * * *', 'Do something', 'opencode', 'true', ''];
    expect(validateSchedulesSection([v1])).toEqual([]);
    expect(parseSchedulesSection([v1])).toHaveLength(1);
    expect(validateSchedulesSection([[...v1.slice(0, 5), 'auto']])).toHaveLength(1);
  });
});
