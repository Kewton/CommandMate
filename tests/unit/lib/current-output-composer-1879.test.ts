/** @vitest-environment node */

/**
 * Issue #1879: `composerText` has to reach the capture payload.
 *
 * The Issue's first acceptance criterion is about the payload, not the module:
 * `commandmate capture --json` and the WebSocket snapshot builder both read
 * `buildCurrentOutput`, so extraction that works in isolation but never lands in
 * the payload is the failure mode this file exists to catch. It runs the real
 * detection module against the real raw fixtures — the `output` handed to
 * `buildCurrentOutput` is the same `capture-pane -p -e` text `captureSessionOutput`
 * returns in production, ANSI attributes and all.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import type Database from 'better-sqlite3';

vi.mock('@/lib/db', () => ({ getSessionState: vi.fn(() => null), createMessage: vi.fn() }));
const isRunning = vi.fn().mockResolvedValue(true);
vi.mock('@/lib/cli-tools/manager', () => ({
  CLIToolManager: { getInstance: () => ({ getTool: () => ({ isRunning }) }) },
}));
vi.mock('@/lib/session/cli-session', () => ({ captureSessionOutput: vi.fn() }));
vi.mock('@/lib/polling/auto-yes-manager', () => ({
  getAutoYesState: vi.fn(() => null),
  buildCompositeKey: (worktreeId: string, cliToolId: string, instanceId?: string) =>
    `${worktreeId}:${cliToolId}:${instanceId ?? cliToolId}`,
  getLastServerResponseTimestamp: vi.fn(() => null),
  isPollerActive: vi.fn(() => false),
}));

import { captureSessionOutput } from '@/lib/session/cli-session';
import { buildCurrentOutput } from '@/lib/session/current-output-builder';

const FIXTURE_ROOT = path.resolve(__dirname, '../lib/detection/fixtures');
const frame = (name: string): string =>
  fs.readFileSync(path.join(FIXTURE_ROOT, 'claude-live-1879', `${name}.txt`), 'utf-8');
const codexFrame = (name: string): string =>
  fs.readFileSync(path.join(FIXTURE_ROOT, 'codex-live-1890', `${name}.txt`), 'utf-8');

const capture = (tool: 'claude' | 'codex' | 'gemini' = 'claude') =>
  buildCurrentOutput({} as Database.Database, 'wt-1', tool);

describe('capture payload exposes the unsent composer (Issue #1879)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isRunning.mockResolvedValue(true);
  });

  it('publishes real residual text', async () => {
    vi.mocked(captureSessionOutput).mockResolvedValue(frame('composer-residual-plain'));

    const payload = await capture();

    expect(payload.composerText).toBe('echo PREFILLED');
    expect(payload.composerState).toBe('content');
  });

  it('publishes null with state `ghost` for Claude’s dim suggestion', async () => {
    vi.mocked(captureSessionOutput).mockResolvedValue(frame('composer-ghost-suggestion'));

    const payload = await capture();

    expect(payload.composerText).toBeNull();
    // The state is what separates "the box looked occupied but it was a hint"
    // from "the prompt was blank" — a distinction a null alone erases.
    expect(payload.composerState).toBe('ghost');
  });

  it('publishes null with state `empty` for a blank composer', async () => {
    vi.mocked(captureSessionOutput).mockResolvedValue(frame('composer-empty'));

    const payload = await capture();

    expect(payload.composerText).toBeNull();
    expect(payload.composerState).toBe('empty');
  });

  it('publishes null with state `unsupported_tool` for an unmeasured CLI', async () => {
    vi.mocked(captureSessionOutput).mockResolvedValue(frame('composer-residual-plain'));

    const payload = await capture('gemini');

    expect(payload.composerText).toBeNull();
    expect(payload.composerState).toBe('unsupported_tool');
  });

  // Issue #1890. The payload half of teaching the reader codex: `capture --json`
  // and the WebSocket snapshot both come through here, so a codex composer that
  // the module reads correctly but the builder never publishes is still the
  // `unsupported_tool` the Issue was filed about.
  it('publishes real residual text from a codex frame', async () => {
    vi.mocked(captureSessionOutput).mockResolvedValue(codexFrame('composer-residual-plain'));

    const payload = await capture('codex');

    expect(payload.composerText).toBe('echo PREFILLED');
    expect(payload.composerState).toBe('content');
  });

  it('publishes null with state `ghost` for codex’s idle placeholder', async () => {
    vi.mocked(captureSessionOutput).mockResolvedValue(codexFrame('composer-placeholder-ask'));

    const payload = await capture('codex');

    expect(payload.composerText).toBeNull();
    expect(payload.composerState).toBe('ghost');
  });

  it('publishes the key explicitly, so an old server is distinguishable from an empty box', async () => {
    vi.mocked(captureSessionOutput).mockResolvedValue(frame('composer-empty'));

    const serialized = JSON.parse(JSON.stringify(await capture())) as Record<string, unknown>;

    expect('composerText' in serialized).toBe(true);
    expect('composerState' in serialized).toBe(true);
  });

  it('publishes nothing on a session that is not running', async () => {
    isRunning.mockResolvedValue(false);

    const payload = await capture();

    expect(payload.isRunning).toBe(false);
    expect(payload.composerText).toBeNull();
    expect(payload.composerState).toBe('no_composer');
  });

  it('does not disturb the detection flags it sits beside', async () => {
    // The composer read is structural and independent: adding it must not move
    // `isUnclassifiedActive` / `isSelectionListActive`, whose gates #1017/#1494
    // rely on. A residual composer is still a classified idle prompt.
    vi.mocked(captureSessionOutput).mockResolvedValue(frame('composer-residual-plain'));

    const payload = await capture();

    expect(payload.composerText).toBe('echo PREFILLED');
    expect(payload.sessionStatus).toBe('ready');
    expect(payload.sessionStatusReason).toBe('input_prompt');
    expect(payload.isUnclassifiedActive).toBe(false);
    expect(payload.isSelectionListActive).toBe(false);
  });
});
