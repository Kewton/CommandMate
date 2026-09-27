/**
 * Issue #2866: an adopted legacy session stops serving its new-format name once
 * it is killed or found gone, so the next start uses the new-format name.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execFile } from 'child_process';
import { hasSession, killSession } from '@/lib/tmux/tmux';
import {
  clearLegacyAliasesForTests,
  dropLegacyAliasByLegacyName,
  lookupLegacyAlias,
  registerLegacyAlias,
} from '@/lib/tmux/legacy-session-alias';
import { resolveSessionName, setActiveSessionNamespace } from '@/lib/cli-tools/session-name';

vi.mock('child_process', () => ({
  execFile: vi.fn(),
}));

const NS = '0a1b2c3d';
const NEW_NAME = `mcbd-${NS}-claude-wt-1`;
const LEGACY_NAME = 'mcbd-claude-wt-1';

function tmuxAnswers(error: Error | null): void {
  vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
    const callback = args[args.length - 1] as (err: Error | null, result: { stdout: string; stderr: string }) => void;
    callback(error, { stdout: '', stderr: '' });
    return {} as ReturnType<typeof execFile>;
  });
}

describe('legacy session alias table', () => {
  afterEach(() => clearLegacyAliasesForTests());

  it('registers, looks up and drops by the legacy name', () => {
    registerLegacyAlias(NEW_NAME, LEGACY_NAME);
    registerLegacyAlias(`${NEW_NAME}-2`, 'mcbd-claude-wt-1-2');
    expect(lookupLegacyAlias(NEW_NAME)).toBe(LEGACY_NAME);

    expect(dropLegacyAliasByLegacyName('mcbd-claude-unrelated')).toBe(false);
    expect(dropLegacyAliasByLegacyName(LEGACY_NAME)).toBe(true);
    expect(lookupLegacyAlias(NEW_NAME)).toBeUndefined();
    expect(lookupLegacyAlias(`${NEW_NAME}-2`)).toBe('mcbd-claude-wt-1-2');
  });
});

describe('alias removal through tmux.ts (Issue #2866)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setActiveSessionNamespace(NS);
    registerLegacyAlias(NEW_NAME, LEGACY_NAME);
    expect(resolveSessionName('claude', 'wt-1')).toBe(LEGACY_NAME);
  });

  afterEach(() => {
    setActiveSessionNamespace(null);
    clearLegacyAliasesForTests();
  });

  it('killSession success drops the alias', async () => {
    tmuxAnswers(null);
    expect(await killSession(LEGACY_NAME)).toBe(true);
    expect(resolveSessionName('claude', 'wt-1')).toBe(NEW_NAME);
  });

  it('a failed killSession (session not found) keeps it — hasSession decides later', async () => {
    tmuxAnswers(new Error("can't find session"));
    expect(await killSession('mcbd-claude-other')).toBe(false);
    expect(resolveSessionName('claude', 'wt-1')).toBe(LEGACY_NAME);
  });

  it('hasSession false drops the alias', async () => {
    tmuxAnswers(new Error("can't find session"));
    expect(await hasSession(LEGACY_NAME)).toBe(false);
    expect(resolveSessionName('claude', 'wt-1')).toBe(NEW_NAME);
  });

  it('hasSession true keeps the alias', async () => {
    tmuxAnswers(null);
    expect(await hasSession(LEGACY_NAME)).toBe(true);
    expect(resolveSessionName('claude', 'wt-1')).toBe(LEGACY_NAME);
  });

  it('hasSession false for another name keeps the alias', async () => {
    tmuxAnswers(new Error("can't find session"));
    expect(await hasSession('mcbd-claude-wt-2')).toBe(false);
    expect(resolveSessionName('claude', 'wt-1')).toBe(LEGACY_NAME);
  });
});
