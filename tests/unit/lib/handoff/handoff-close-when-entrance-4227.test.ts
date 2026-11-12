/**
 * G9 (#4227 G-PR5): `handoff propose` checks `--close-when` as `mem add` does. The same value gets the same
 * answer from both, in a repository with an origin and in one without (a `pr:#12` was accepted by propose and
 * refused only at the confirmation). Driven by a table: kind × value × origin.
 *
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@/lib/logger', () => ({
  createLogger: () => {
    const quiet = () => undefined;
    return { info: quiet, warn: quiet, error: quiet, debug: quiet, withContext: () => ({}) };
  },
}));

import { memAddItem } from '@/lib/mem/service';
import { handoffPropose } from '@/lib/handoff/proposals';
import { makeHandoffWorld, SHA, WT, type HandoffWorld } from './handoff-harness';

let w: HandoffWorld;
beforeEach(() => {
  w = makeHandoffWorld('handoff-cw-entrance-4227-');
  w.makeWorktree();
  w.setMode('on', true);
  w.openLaunch();
});
afterEach(() => w.close());

const KINDS = ['waiting', 'note', 'decision'] as const;
const VALUES: Array<string | undefined> = [
  undefined,
  'manual',
  'at:2026-12-01T10:00:00+09:00',
  'pr:#12',
  'issue:#7',
  'pr:Kewton/CommandMate#12',
  'branch:feature/x:merged',
  'nonsense',
];
const ORIGINS: Array<{ name: string; url: string | null }> = [
  { name: 'origin', url: 'git@github.com:Kewton/CommandMate.git' },
  { name: 'no-origin', url: null },
];

interface Answer {
  ok: boolean;
  code?: string;
  reason?: string;
}
const answerOf = (outcome: { status: number; body: unknown }): Answer => {
  const body = outcome.body as { code?: string; reason?: string };
  return outcome.status < 300 ? { ok: true } : { ok: false, code: body.code, reason: body.reason };
};

async function bothAnswers(kind: string, closeWhen: string | undefined, url: string | null): Promise<{ propose: Answer; add: Answer }> {
  const deps = { ...w.deps(), git: { originUrl: async () => url, refTip: async () => SHA } };
  const created = await w.create();
  const base = { instanceId: 'claude', kind, text: `t-${kind}`, ...(closeWhen === undefined ? {} : { closeWhen }) };
  const propose = answerOf(await handoffPropose(w.db, WT, created.request.id, { op: 'add', ...base }, deps));
  const add = answerOf(await memAddItem(w.db, WT, base, deps));
  return { propose, add };
}

describe('[#4227 G9] propose and mem add check --close-when alike', () => {
  for (const origin of ORIGINS) {
    for (const kind of KINDS) {
      for (const value of VALUES) {
        it(`${kind} / ${value ?? '(omitted)'} / ${origin.name}: same answer`, async () => {
          const { propose, add } = await bothAnswers(kind, value, origin.url);
          expect(propose).toEqual(add);
        });
      }
    }
  }

  it('(positive) pr:#12 with no origin is refused by propose as invalid_close_when, like mem add', async () => {
    const { propose, add } = await bothAnswers('waiting', 'pr:#12', null);
    expect(add.ok).toBe(false);
    expect(propose.ok).toBe(false);
    expect(propose.code).toBe('invalid_close_when');
    expect(w.count('SELECT COUNT(*) AS n FROM mem_handoff_proposals')).toBe(0);
  });

  it('(control) pr:#12 with an origin is accepted by propose and by mem add', async () => {
    const { propose, add } = await bothAnswers('waiting', 'pr:#12', 'git@github.com:Kewton/CommandMate.git');
    expect(propose.ok).toBe(true);
    expect(add.ok).toBe(true);
    expect(w.count('SELECT COUNT(*) AS n FROM mem_handoff_proposals')).toBe(1);
  });
});
