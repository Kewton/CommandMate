/**
 * Issue #4056: `submit-verified-sender.ts` split into `submit-verified-sender-*.ts`.
 *
 * Each piece is exercised on its own here, and the origin is checked to still
 * hand out the same values it exported before (re-exports, not copies).
 *
 * Positive control: before the split none of the piece modules exists, so every
 * import below fails. Negative control: the "a piece never imports the origin"
 * check is run against a fixture written under `os.tmpdir()` that does import
 * it, and must report it; the repository is never written.
 *
 * @vitest-environment node
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('@/lib/tmux/tmux', () => ({
  sendKeys: vi.fn().mockResolvedValue(undefined),
  sendSpecialKeys: vi.fn().mockResolvedValue(undefined),
  capturePane: vi.fn().mockResolvedValue(''),
  clearInputLine: vi.fn().mockResolvedValue(undefined),
  clearComposerLine: vi.fn().mockResolvedValue(undefined),
  exactTarget: (name: string) => `=${name}:`,
}));

vi.mock('@/lib/tmux/tmux-capture-cache', () => ({
  invalidateCache: vi.fn(),
}));

const loggerSpies = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ ...loggerSpies, withContext: () => loggerSpies }),
}));

import * as origin from '@/lib/cli-tools/submit-verified-sender';
import * as shared from '@/lib/cli-tools/submit-verified-sender-shared';
import {
  DEADLINE_PASSED,
  assertInputOwner,
  beforeDeadline,
  isReadyFrame,
} from '@/lib/cli-tools/submit-verified-sender-lock';
import { needsPromptReport, visibleTypedBody } from '@/lib/cli-tools/submit-verified-sender-composer';
import {
  pasteFailureMayHaveTyped,
  resolveSubmitEnterCount,
  settleAwaitedPromptReport,
  shouldAwaitTypedBody,
} from '@/lib/cli-tools/submit-verified-sender-report';
import { resolveComposerSpec } from '@/lib/cli-tools/composer-spec';
import { invalidateCache } from '@/lib/tmux/tmux-capture-cache';
import type { InstanceInputTicket } from '@/lib/session/instance-input-lock';

const DIR = 'src/lib/cli-tools';
const ORIGIN_BASE = 'submit-verified-sender';

/** Specifiers in `source` that name the origin module itself. */
function importsOfOrigin(source: string): string[] {
  const out: string[] = [];
  const re = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"]([^'"]+)['"]/g;
  for (let m = re.exec(source); m !== null; m = re.exec(source)) {
    const spec = m[1];
    if (/(^|\/)submit-verified-sender(\.ts)?$/.test(spec)) out.push(spec);
  }
  return out;
}

function ticket(current: boolean): InstanceInputTicket {
  return {
    sessionName: 'mcbd-claude-x',
    generation: 7,
    waited: false,
    mode: 'exclusive',
    isCurrent: () => current,
  } as unknown as InstanceInputTicket;
}

describe('Issue #4056: the origin re-exports what moved', () => {
  it('hands out the very values of the shared module', () => {
    expect(origin.LITERAL_SEND_MAX_BYTES).toBe(shared.LITERAL_SEND_MAX_BYTES);
    expect(origin.PROMPT_REPORT_WAIT_MS).toBe(shared.PROMPT_REPORT_WAIT_MS);
    expect(origin.INPUT_READINESS_UNDER_LOCK_WAIT_MS).toBe(shared.INPUT_READINESS_UNDER_LOCK_WAIT_MS);
  });

  it('keeps the values they had', () => {
    expect(shared.LITERAL_SEND_MAX_BYTES).toBe(512);
    expect(shared.PROMPT_REPORT_WAIT_MS).toBe(5000);
    expect(shared.INPUT_READINESS_UNDER_LOCK_WAIT_MS).toBe(2000);
    expect(shared.DEFAULT_VERIFY_ATTEMPTS).toBe(4);
  });
});

describe('Issue #4056: no piece imports the origin (no cycle)', () => {
  let tmp: string | null = null;
  afterEach(() => {
    if (tmp !== null) rmSync(tmp, { recursive: true, force: true });
    tmp = null;
  });

  it('every submit-verified-sender-*.ts on disk is free of an origin import', () => {
    const pieces = readdirSync(join(process.cwd(), DIR)).filter((n) => n.startsWith(`${ORIGIN_BASE}-`) && n.endsWith('.ts'));
    expect(pieces.length).toBeGreaterThanOrEqual(4);
    for (const name of pieces) {
      expect(importsOfOrigin(readFileSync(join(process.cwd(), DIR, name), 'utf8')), name).toEqual([]);
    }
  });

  it('negative control: a fixture that imports the origin is reported', () => {
    tmp = mkdtempSync(join(tmpdir(), 'svs-split-4056-'));
    const fixture = join(tmp, `${ORIGIN_BASE}-fixture.ts`);
    writeFileSync(fixture, "import { LITERAL_SEND_MAX_BYTES } from './submit-verified-sender';\n");
    expect(importsOfOrigin(readFileSync(fixture, 'utf8'))).toEqual(['./submit-verified-sender']);
    // A sibling piece is not the origin.
    expect(importsOfOrigin("import { logger } from './submit-verified-sender-shared';\n")).toEqual([]);
  });
});

describe('Issue #4056: submit-verified-sender-lock', () => {
  it('assertInputOwner passes for the current owner', () => {
    expect(() => assertInputOwner(ticket(true), 'claude', 'Enter', true)).not.toThrow();
  });

  it('assertInputOwner throws with the `nothing was typed` wording before the body', () => {
    expect(() => assertInputOwner(ticket(false), 'claude', 'the body', false)).toThrow(
      /before the body; input lock lost, nothing was typed \(Issue #3945\)/
    );
  });

  it('assertInputOwner throws with the `may be in its composer` wording once typed', () => {
    expect(() => assertInputOwner(ticket(false), 'claude', 'Enter', true)).toThrow(
      /before Enter; part of the message may be in its composer \(Issue #3945\)/
    );
  });

  it('isReadyFrame answers the test, and false for a test that throws', () => {
    expect(isReadyFrame({ label: 't', isReady: (f) => f === 'ok' }, 'ok')).toBe(true);
    expect(isReadyFrame({ label: 't', isReady: (f) => f === 'ok' }, 'no')).toBe(false);
    expect(
      isReadyFrame(
        {
          label: 't',
          isReady: () => {
            throw new Error('boom');
          },
        },
        'ok'
      )
    ).toBe(false);
  });

  it('beforeDeadline returns the read when it comes first, the marker when the deadline does', async () => {
    await expect(beforeDeadline(Promise.resolve('frame'), Date.now() + 1000)).resolves.toBe('frame');
    const never = new Promise<string>(() => undefined);
    await expect(beforeDeadline(never, Date.now())).resolves.toBe(DEADLINE_PASSED);
  });
});

describe('Issue #4056: submit-verified-sender-composer', () => {
  it('visibleTypedBody stops at the first blank line after text', () => {
    expect(visibleTypedBody('a\nb\n\nc')).toBe('a\nb');
    expect(visibleTypedBody('\n\nfirst\n\nsecond')).toBe('\n\nfirst');
    expect(visibleTypedBody('one line')).toBe('one line');
    expect(visibleTypedBody('\n  \n')).toBe('');
  });

  it('needsPromptReport: only a B/F `submitted` of a body the TUI does not run itself', () => {
    expect(needsPromptReport('submitted', 'B-empty', 'hello')).toBe(true);
    expect(needsPromptReport('submitted', 'F', 'hello')).toBe(true);
    expect(needsPromptReport('submitted', 'A', 'hello')).toBe(false);
    expect(needsPromptReport('pending', 'C', 'hello')).toBe(false);
    expect(needsPromptReport('submitted', 'B-empty', '/status')).toBe(false);
    expect(needsPromptReport('submitted', 'B-empty', '  !ls')).toBe(false);
  });
});

describe('Issue #4056: submit-verified-sender-report', () => {
  it('resolveSubmitEnterCount takes the param, else the composer', () => {
    const vibe = resolveComposerSpec('vibe-local');
    const params = { sessionName: 's', message: 'm', cliToolId: 'vibe-local' as const };
    expect(resolveSubmitEnterCount(params, vibe)).toBe(2);
    expect(resolveSubmitEnterCount({ ...params, submitEnterCount: 1 }, vibe)).toBe(1);
  });

  it('pasteFailureMayHaveTyped is false only before paste-buffer', () => {
    expect(pasteFailureMayHaveTyped(new Error('Failed to paste message into tmux session: x'))).toBe(true);
    expect(pasteFailureMayHaveTyped(Object.assign(new Error('x'), { delivery: 'not-started' }))).toBe(false);
    expect(
      pasteFailureMayHaveTyped(new Error('Input boundary could not be recorded (x); nothing was typed (Issue #3957)'))
    ).toBe(false);
    expect(pasteFailureMayHaveTyped(null)).toBe(true);
  });

  it('shouldAwaitTypedBody only for a measured composer with the flag on', () => {
    expect(shouldAwaitTypedBody(true, 'codex')).toBe(true);
    expect(shouldAwaitTypedBody(true, 'claude')).toBe(true);
    expect(shouldAwaitTypedBody(true, 'gemini')).toBe(false);
    expect(shouldAwaitTypedBody(false, 'codex')).toBe(false);
  });

  it('settleAwaitedPromptReport: received → submitted with the read-back frame', () => {
    const out = settleAwaitedPromptReport({
      watched: { verdict: 'received' },
      sessionName: 's',
      cliToolId: 'claude',
      attempt: 0,
      rule: 'F',
      output: 'frame',
    });
    expect(out).toEqual({ state: 'submitted', rule: 'F', output: 'frame' });
    expect(loggerSpies.info).toHaveBeenCalledWith('submit-confirmed-by-prompt-hook', expect.objectContaining({ rule: 'F' }));
  });

  it('settleAwaitedPromptReport: screen → the screen verdict', () => {
    const out = settleAwaitedPromptReport({
      watched: { verdict: 'screen', state: 'pending', rule: 'C', output: 'later' },
      sessionName: 's',
      cliToolId: 'claude',
      attempt: 1,
      rule: 'F',
      output: 'frame',
    });
    expect(out).toEqual({ state: 'pending', rule: 'C', output: 'later' });
  });

  it('settleAwaitedPromptReport: unreported → throws and drops the cache', () => {
    vi.mocked(invalidateCache).mockClear();
    expect(() =>
      settleAwaitedPromptReport({
        watched: { verdict: 'unreported', rule: 'B-empty' },
        sessionName: 's',
        cliToolId: 'claude',
        attempt: 0,
        rule: 'B-empty',
        output: 'frame',
      })
    ).toThrow(/did not report the prompt within 5000ms \(Issue #4035\)/);
    expect(invalidateCache).toHaveBeenCalledWith('s');
  });
});
