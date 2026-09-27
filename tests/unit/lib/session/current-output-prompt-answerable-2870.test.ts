/**
 * `promptAnswerable` reaches the wire (Issue #2870).
 *
 * In #2868 the status API published codex's `/model` picker off the generic
 * parser alone while `/prompt-response` refused it, so the UI drew a Send that
 * did nothing. `buildCurrentOutput` now publishes the route's own verdict next
 * to the prompt, and the three claims here are the three the UI depends on:
 *
 *  1. a screen the route would answer publishes `promptAnswerable: true`;
 *  2. a screen only the generic parser reads — the pre-#2868 `/model` picker,
 *     rebuilt from the 0.157.1 capture by rewording its footer so the codex
 *     constants no longer match it — publishes `false`, while `isPromptWaiting`
 *     and `promptData` stay exactly as they were (`wait`, Auto-Yes and push
 *     still read them);
 *  3. with no prompt the key is absent.
 *
 * @vitest-environment node
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';

vi.mock('@/lib/db', () => ({ getSessionState: vi.fn(() => null) }));
vi.mock('@/lib/cli-tools/manager', () => ({
  CLIToolManager: {
    getInstance: () => ({
      getTool: () => ({ getSessionName: () => 'mcbd-test-session', isRunning: vi.fn().mockResolvedValue(true) }),
    }),
  },
}));
vi.mock('@/lib/session/cli-session', () => ({ captureSessionOutput: vi.fn() }));
vi.mock('@/lib/polling/auto-yes-manager', () => ({
  getAutoYesState: vi.fn(() => undefined),
  getLastServerResponseTimestamp: vi.fn(() => null),
  isPollerActive: vi.fn(() => true),
  buildCompositeKey: vi.fn(() => 'wt-2870:codex'),
}));

import { captureSessionOutput } from '@/lib/session/cli-session';
import { buildCurrentOutput } from '@/lib/session/current-output-builder';
import { stripAnsi } from '@/lib/detection/cli-patterns';

const WT = 'wt-2870';
const FIXTURES = path.resolve(__dirname, '../../../fixtures');
const DETECTION_FIXTURES = path.resolve(__dirname, '../detection/fixtures');

function read(file: string): string {
  return readFileSync(file, 'utf8');
}

/**
 * codex 0.157.1's `/model` picker with its footer reworded to a spelling the
 * codex footer constants do not match, i.e. what #2868 saw before its fix:
 * the generic parser still reads the seven options, codex's dialog rule no
 * longer vouches for them. Row-scoped, and loud if the row is missing.
 */
function preFixModelPicker(): string {
  const rows = read(path.join(FIXTURES, 'codex-dialogs-0157', 'model-picker.txt')).split('\n');
  const index = rows.findIndex((row) => /^\s*enter\s+select\s+·\s+esc\s+back\s*$/.test(stripAnsi(row)));
  if (index < 0) throw new Error('model-picker.txt carries no `enter select · esc back` footer');
  rows[index] = '  enter  pick · esc  leave';
  return rows.join('\n');
}

async function payloadFor(frame: string) {
  vi.mocked(captureSessionOutput).mockResolvedValue(frame);
  return buildCurrentOutput({} as Database.Database, WT, 'codex', 'codex');
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('[#2870] buildCurrentOutput publishes promptAnswerable', () => {
  it('is true for a dialog /prompt-response would answer', async () => {
    const payload = await payloadFor(
      read(path.join(DETECTION_FIXTURES, 'codex-live-1628', 'approval-run-command.txt')),
    );

    expect(payload.isPromptWaiting).toBe(true);
    expect(payload.promptAnswerable).toBe(true);
  });

  it('is absent for the 0.157.1 /model picker as captured (a selection list since #2868)', async () => {
    // The control for the rewording below: with the footer codex actually
    // draws, the picker is the arrow-key selection list, not a parser prompt.
    const payload = await payloadFor(read(path.join(FIXTURES, 'codex-dialogs-0157', 'model-picker.txt')));

    expect(payload.isSelectionListActive).toBe(true);
    expect(payload.isPromptWaiting).toBe(false);
    expect('promptAnswerable' in payload).toBe(false);
  });

  it('is false for a picker only the generic parser reads, and nothing else changes', async () => {
    const payload = await payloadFor(preFixModelPicker());

    // Published exactly as before — `wait`'s exit 10, Auto-Yes and push read these.
    expect(payload.isPromptWaiting).toBe(true);
    expect(payload.promptData).toMatchObject({ type: 'multiple_choice' });
    // ...and now said, on the same payload, not to be answerable.
    expect(payload.promptAnswerable).toBe(false);
  });

  it('is absent when no prompt is up', async () => {
    const payload = await payloadFor(read(path.join(FIXTURES, 'codex-dialogs-0157', 'idle.txt')));

    expect(payload.isPromptWaiting).toBe(false);
    expect('promptAnswerable' in payload).toBe(false);
  });
});
