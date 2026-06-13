/**
 * Unit tests for agent-instance helpers (Issue #868).
 *
 * Covers the pure instance-identity helpers in cli-tools/types and the
 * instance-aware poller key, which together back the 1-agent-multiple-sessions
 * feature. The primary instance (instanceId === cliTool) must keep producing
 * the exact pre-#868 identifiers for backward compatibility.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  isValidInstanceId,
  getPrimaryInstanceId,
  isPrimaryInstance,
  buildInstanceId,
  deriveSessionSuffix,
  MAX_INSTANCE_ID_LENGTH,
} from '@/lib/cli-tools/types';

// response-poller-core pulls in logger/tui/dedup/checker at module load; mock
// them so we can import the pure getPollerKey helper in isolation.
vi.mock('@/lib/logger', () => ({
  createLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    withContext: vi.fn().mockReturnThis(),
  })),
}));
vi.mock('@/lib/tui-accumulator', () => ({
  initTuiAccumulator: vi.fn(),
  clearTuiAccumulator: vi.fn(),
}));
vi.mock('@/lib/polling/prompt-dedup', () => ({
  clearPromptHashCache: vi.fn(),
}));
vi.mock('@/lib/polling/response-checker', () => ({
  checkForResponse: vi.fn(),
}));

import { getPollerKey } from '@/lib/polling/response-poller-core';

describe('isValidInstanceId', () => {
  it('accepts alphanumeric/underscore/hyphen identifiers', () => {
    expect(isValidInstanceId('claude')).toBe(true);
    expect(isValidInstanceId('claude-2')).toBe(true);
    expect(isValidInstanceId('codex_alt')).toBe(true);
    expect(isValidInstanceId('A1-b2_c3')).toBe(true);
  });

  it('rejects empty, over-length, and unsafe identifiers', () => {
    expect(isValidInstanceId('')).toBe(false);
    expect(isValidInstanceId('a'.repeat(MAX_INSTANCE_ID_LENGTH + 1))).toBe(false);
    expect(isValidInstanceId('has space')).toBe(false);
    expect(isValidInstanceId('has/slash')).toBe(false);
    expect(isValidInstanceId('has:colon')).toBe(false);
    expect(isValidInstanceId('semi;colon')).toBe(false);
  });

  it('accepts an identifier at exactly the max length', () => {
    expect(isValidInstanceId('a'.repeat(MAX_INSTANCE_ID_LENGTH))).toBe(true);
  });
});

describe('getPrimaryInstanceId', () => {
  it('returns the cli tool id as the primary instance id', () => {
    expect(getPrimaryInstanceId('claude')).toBe('claude');
    expect(getPrimaryInstanceId('codex')).toBe('codex');
  });
});

describe('isPrimaryInstance', () => {
  it('treats an undefined instance as primary', () => {
    expect(isPrimaryInstance(undefined, 'claude')).toBe(true);
  });

  it('treats instanceId === cliTool as primary', () => {
    expect(isPrimaryInstance('claude', 'claude')).toBe(true);
  });

  it('treats a distinct instanceId as non-primary', () => {
    expect(isPrimaryInstance('claude-2', 'claude')).toBe(false);
  });
});

describe('buildInstanceId', () => {
  it('encodes the cli tool into the instance id', () => {
    expect(buildInstanceId('claude', '2')).toBe('claude-2');
    expect(buildInstanceId('codex', 'review')).toBe('codex-review');
  });
});

describe('deriveSessionSuffix', () => {
  it('strips the cli-tool prefix to avoid redundant session names', () => {
    expect(deriveSessionSuffix('claude-2', 'claude')).toBe('2');
    expect(deriveSessionSuffix('codex-review', 'codex')).toBe('review');
  });

  it('falls back to the raw id when there is no matching prefix', () => {
    // Only ever reached for non-primary ids; an id without the `{tool}-`
    // prefix (incl. one equal to the tool) is returned unchanged.
    expect(deriveSessionSuffix('weird', 'claude')).toBe('weird');
    expect(deriveSessionSuffix('claude', 'claude')).toBe('claude');
  });
});

describe('getPollerKey (Issue #868)', () => {
  it('keys on cliToolId when no instance is given (primary, backward compatible)', () => {
    expect(getPollerKey('wt-1', 'claude')).toBe('wt-1:claude');
  });

  it('keys on cliToolId when the primary instance is given explicitly', () => {
    expect(getPollerKey('wt-1', 'claude', 'claude')).toBe('wt-1:claude');
  });

  it('keys on the instance id for additional instances', () => {
    expect(getPollerKey('wt-1', 'claude', 'claude-2')).toBe('wt-1:claude-2');
    expect(getPollerKey('wt-1', 'codex', 'codex-review')).toBe('wt-1:codex-review');
  });
});
