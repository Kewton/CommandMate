/**
 * wait-verify's pane read finds the completion signal anywhere in the frame (Issue #4315).
 *
 * The fixture is the shape observed on a live 200x1000 Claude pane (prereview
 * 2026-11-13): the transcript is drawn at the top, `IMPL_COMPLETED head=<sha>`
 * sits on row 305, and rows 310-995 are 110 spaces plus a `│` that a border
 * left behind. Those rows are NOT blank (`isVisuallyBlank` sees the `│`), so the
 * squeeze keeps them — rightly: a table row is content too — and a `--tail 40`
 * window holds nothing but them and the composer. The signal is never read.
 *
 * The fake `capture` here runs the real squeeze with the arguments the script
 * passes (`--tail N` or none), so what is pinned is the read the script makes,
 * not a screen the test chose.
 *
 * @vitest-environment node
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { awaitCompletionSignal } from '../../../../scripts/orchestrate/wait-verify.mjs';
import { squeezeTranscript } from '../../../../src/lib/tmux/transcript-squeeze';

const FRAME = fs.readFileSync(
  path.join(process.cwd(), 'tests/fixtures/pane-border-rows-4315/claude-signal-row-305.txt'),
  'utf8'
);
const HEAD = `0a1b2c3d4e${'f'.repeat(30)}`;
const OTHER_HEAD = `9${'e'.repeat(39)}`;
const T0 = Date.UTC(2026, 10, 12, 1, 0);

type Call = { command: string; args: string[] };

/** `capture --pane [--tail N]` as the CLI answers it: the real squeeze over the raw frame. */
function captured(raw: string, args: string[]): string {
  const i = args.indexOf('--tail');
  const tail = i === -1 ? undefined : Number(args[i + 1]);
  return squeezeTranscript(raw, { tail }).text;
}

function harness({
  frame = FRAME,
  head = HEAD,
  commitMs = T0 + 60_000,
  reply = null as string | null,
}: { frame?: string; head?: string; commitMs?: number; reply?: string | null } = {}) {
  const ran: Call[] = [];
  let clock = T0 + 120_000;
  const run = (command: string, args: string[]) => {
    ran.push({ command, args });
    const ok = (stdout: string) => ({ status: 0, stdout, stderr: '' });
    if (command === 'git') {
      const sub = args.slice(2);
      if (sub[0] === 'rev-parse') return ok(`${head}\n`);
      if (sub[0] === 'log') return ok(`${new Date(commitMs).toISOString()}\n`);
      throw new Error(`unexpected git ${sub.join(' ')}`);
    }
    if (args[0] === 'reply') return ok(JSON.stringify({ worktreeId: args[1], reply }));
    if (args[0] === 'capture' && args.includes('--pane')) return ok(captured(frame, args));
    throw new Error(`unexpected ${command} ${args.join(' ')}`);
  };
  const ctx = {
    run,
    sleep: (ms: number) => {
      clock += ms;
    },
    now: () => new Date(clock),
    o: { cli: 'commandmatedev', wt: 'wt-1', instance: 'claude', worktree: '/wt', signalTimeout: '60' },
    cwd: '/wt',
    since: T0,
    supersededBy: () => null,
  };
  const captures = () => ran.filter((c) => c.args[0] === 'capture');
  return { ctx, ran, captures };
}

describe('the fixture is the observed shape (Issue #4315)', () => {
  it('has 1000 rows, the signal on row 305, and border rows after it that the squeeze keeps', () => {
    const rows = FRAME.replace(/\n$/, '').split('\n');
    expect(rows).toHaveLength(1000);
    expect(rows[304]).toBe('  IMPL_COMPLETED head=0a1b2c3d4e');
    expect(rows[309]).toBe(`${' '.repeat(110)}│`);
    expect(rows[994]).toBe(`${' '.repeat(110)}│`);
    // The trailing-blank squeeze is not what hides it: the border rows survive it.
    expect(squeezeTranscript(FRAME).lines).toBeGreaterThan(900);
    expect(squeezeTranscript(FRAME, { tail: 40 }).text).not.toContain('IMPL_COMPLETED');
  });
});

describe('awaitCompletionSignal reads the whole pane frame (Issue #4315)', () => {
  it('finds IMPL_COMPLETED head=<sha> on row 305 above hundreds of border rows', () => {
    const h = harness();
    expect(awaitCompletionSignal(h.ctx)).toEqual({ seen: true, head: HEAD, note: 'signal=seen(pane,head)' });
  });

  it('does not narrow the pane read with --tail', () => {
    const h = harness();
    awaitCompletionSignal(h.ctx);
    expect(h.captures().length).toBeGreaterThan(0);
    for (const c of h.captures()) expect(c.args).not.toContain('--tail');
  });

  it('finds the bare line with no task to date it by, as before', () => {
    const h = harness();
    expect(awaitCompletionSignal({ ...h.ctx, since: null })).toEqual({
      seen: true,
      head: HEAD,
      note: 'signal=seen signal-task=unknown',
    });
  });
});

describe('the wider read takes nothing it did not take before (Issue #4315)', () => {
  it('a frame with no signal stays unseen', () => {
    const h = harness({ frame: FRAME.replace('  IMPL_COMPLETED head=0a1b2c3d4e', '  still working') });
    expect(awaitCompletionSignal(h.ctx)).toEqual({ seen: false, reason: 'no IMPL_COMPLETED line within 60s' });
  });

  it('a line naming another HEAD stays unseen', () => {
    const h = harness({ head: OTHER_HEAD });
    expect(awaitCompletionSignal(h.ctx).seen).toBe(false);
  });

  it('a HEAD committed before the task was created stays unseen', () => {
    const h = harness({ commitMs: T0 - 60_000 });
    expect(awaitCompletionSignal(h.ctx).seen).toBe(false);
  });

  it('a bare IMPL_COMPLETED with a task known stays unseen', () => {
    const h = harness({ frame: FRAME.replace('  IMPL_COMPLETED head=0a1b2c3d4e', '  IMPL_COMPLETED') });
    expect(awaitCompletionSignal(h.ctx).seen).toBe(false);
  });

  it('a reply without the signal wins: the pane is not read at all', () => {
    const h = harness({ reply: 'still on it' });
    expect(awaitCompletionSignal(h.ctx).seen).toBe(false);
    expect(h.captures()).toHaveLength(0);
  });

  it('a reply with the signal is taken from the reply', () => {
    const h = harness({ reply: `done\nIMPL_COMPLETED head=${HEAD.slice(0, 10)}` });
    expect(awaitCompletionSignal(h.ctx)).toEqual({ seen: true, head: HEAD, note: 'signal=seen(reply)' });
    expect(h.captures()).toHaveLength(0);
  });

  it('a newer task created while the pane was read wins over the signal on it (#4315 review)', () => {
    const h = harness();
    let created = false;
    const run = (command: string, args: string[]) => {
      if (args[0] === 'capture') created = true;
      return h.ctx.run(command, args);
    };
    expect(
      awaitCompletionSignal({ ...h.ctx, run, supersededBy: () => (created ? 'a newer task t-2 was created' : null) })
    ).toEqual({ seen: false, reason: 'a newer task t-2 was created' });
  });

  it('a newer task created while the reply was read wins over the signal in it (#4315 review)', () => {
    const h = harness({ reply: `IMPL_COMPLETED head=${HEAD.slice(0, 10)}` });
    let created = false;
    const run = (command: string, args: string[]) => {
      if (args[0] === 'reply') created = true;
      return h.ctx.run(command, args);
    };
    expect(
      awaitCompletionSignal({ ...h.ctx, run, supersededBy: () => (created ? 'a newer task t-2 was created' : null) })
    ).toEqual({ seen: false, reason: 'a newer task t-2 was created' });
  });

  it('a newer task created while the pane was read wins with no task to date it by (#4315 review)', () => {
    const h = harness();
    let created = false;
    const run = (command: string, args: string[]) => {
      if (args[0] === 'capture') created = true;
      return h.ctx.run(command, args);
    };
    expect(
      awaitCompletionSignal({
        ...h.ctx,
        since: null,
        run,
        supersededBy: () => (created ? 'a newer task t-2 was created' : null),
      })
    ).toEqual({ seen: false, reason: 'a newer task t-2 was created' });
  });

  it('a newer task ends the wait unseen', () => {
    const h = harness({ frame: FRAME.replace('  IMPL_COMPLETED head=0a1b2c3d4e', '  still working') });
    expect(awaitCompletionSignal({ ...h.ctx, supersededBy: () => 'superseded by t-2' })).toEqual({
      seen: false,
      reason: 'superseded by t-2',
    });
  });
});
