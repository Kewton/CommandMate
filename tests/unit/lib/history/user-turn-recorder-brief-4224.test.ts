/**
 * A briefed send read back from the transcript (Issue #4224, D2 design §8.5, H-1〜H-4 and
 * the 2nd review ③④⑤).
 *
 * The send path types `brief + "\n\n" + body` and writes the `/send` row with the body
 * alone; the agent's transcript has both. `recordUserTurn` (the one function the claude,
 * codex, command-code and antigravity readers share) claims that `/send` row for the turn
 * — the row is the evidence the brief was CommandMate's — and never cuts a brief anyone
 * else typed: a pasted one is on its own row in full, and with no row to claim the whole
 * text is recorded.
 *
 * The positive controls fail on the recorder before #4224: there the briefed turn found
 * no row with its text and was inserted as a second user row.
 *
 * @vitest-environment node
 */
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/db/db-instance', () => {
  let mockDb: Database.Database | null = null;
  return {
    getDbInstance: () => {
      if (!mockDb) throw new Error('Mock database not initialized');
      return mockDb;
    },
    setMockDb: (db: Database.Database | null) => {
      mockDb = db;
    },
  };
});
vi.mock('@/lib/ws-server', () => ({ broadcastMessage: vi.fn() }));

import { runMigrations } from '@/lib/db/db-migrations';
import { createMessage, getMessages, upsertWorktree } from '@/lib/db';
import { afterDeliveredBrief, recordUserTurn, USER_TURN_ADOPTION_WINDOW_MS } from '@/lib/history/user-turn-recorder';
import { drawText } from '@/lib/brief/render';
import { dropNoticeLines } from '@/lib/brief/provider';
import type { BriefFixed } from '@/lib/brief/model';

const WT = 'wt-4224-history';
const AT = Date.parse('2026-11-09T10:00:00.000Z');
const BODY = '次はテストを足してください。\n絵文字も 🍣 そのまま';
const TOOLS = ['claude', 'codex', 'command-code'] as const;

let db: Database.Database;

async function setMockDb(value: Database.Database | null): Promise<void> {
  const module = (await import('@/lib/db/db-instance')) as unknown as { setMockDb: (value: Database.Database | null) => void };
  module.setMockDb(value);
}

const fixed = (tool: string): BriefFixed => ({
  mode: 'on',
  worktreeId: WT,
  instanceId: tool,
  cliToolId: tool,
  repositoryId: 'repo-1',
  repositoryIdBytes: 6,
  branch: null,
  detached: true,
  boundaryKind: 'launch',
  generatedAt: '2026-11-09T09:59:59.000Z',
  readAll: `commandmate brief --worktree ${WT} --instance ${tool} --all`,
});

const NOTICE_LINE = '[9] src=notice id=n2 by=server updated=- kind=ended';

/** A brief as C draws it (the fences carry the tag of its content). */
const brief = (tool: string, lines: string[] = ['[2] src=mem id=m1 by=agent:x updated=- kind=now text="a"', NOTICE_LINE]): string =>
  drawText(fixed(tool), lines, 0);

/** A `/send` row: the operator's body only, no key (what `sendUserMessage` writes). */
function sendRow(tool: (typeof TOOLS)[number], content: string, at: number) {
  return createMessage(db, { worktreeId: WT, role: 'user', content, messageType: 'normal', timestamp: new Date(at), cliToolId: tool, instanceId: tool });
}

const userRows = (tool: string) => getMessages(db, WT, { limit: 200, instanceId: tool }).filter((row) => row.role === 'user');

beforeEach(async () => {
  db = new Database(':memory:');
  runMigrations(db);
  await setMockDb(db);
  upsertWorktree(db, { id: WT, name: WT, path: '/repos/wt-4224', repositoryPath: '/repos', repositoryName: 'r' });
});

afterEach(async () => {
  await setMockDb(null);
  db.close();
});

describe('H-a a briefed send read back from the transcript keeps one row with the body (H-1, H-4)', () => {
  it.each(TOOLS)('%s: the /send row is claimed, its body unchanged, and a second read writes nothing', async (tool) => {
    const sent = sendRow(tool, BODY, AT);
    const turn = `${brief(tool)}\n\n${BODY}`;
    const first = await recordUserTurn({ worktreeId: WT, cliToolId: tool, instanceId: tool }, `k-${tool}`, turn, AT + 1_500);
    expect(first).toMatchObject({ outcome: 'adopted', messageId: sent.id });
    const second = await recordUserTurn({ worktreeId: WT, cliToolId: tool, instanceId: tool }, `k-${tool}`, turn, AT + 1_500);
    expect(second.outcome).toBe('already-recorded');
    const rows = userRows(tool);
    expect(rows).toHaveLength(1);
    expect(rows[0].content).toBe(BODY);
  });
});

describe('H-b a brief the operator typed is never cut (H-2, 2nd review ③)', () => {
  it('pasted with its fences: its own /send row has the whole text, and keeps it', async () => {
    const pasted = `${brief('claude')}\n\n${BODY}`;
    sendRow('claude', pasted, AT);
    const result = await recordUserTurn({ worktreeId: WT, cliToolId: 'claude', instanceId: 'claude' }, 'k1', pasted, AT + 500);
    expect(result.outcome).toBe('adopted');
    expect(userRows('claude').map((row) => row.content)).toEqual([pasted]);
  });

  it('a real brief sent, then the same block pasted again by hand: two rows, the pasted one in full', async () => {
    const block = brief('claude');
    sendRow('claude', BODY, AT); // the real send: brief + body typed, body recorded
    const pasted = `${block}\n\n${BODY}`;
    sendRow('claude', pasted, AT + 2_000); // the hand-pasted send: recorded as typed
    // Both turns read the same in the transcript.
    await recordUserTurn({ worktreeId: WT, cliToolId: 'claude', instanceId: 'claude' }, 'k1', pasted, AT + 100);
    await recordUserTurn({ worktreeId: WT, cliToolId: 'claude', instanceId: 'claude' }, 'k2', pasted, AT + 2_100);
    const contents = userRows('claude').map((row) => row.content).sort();
    expect(contents).toEqual([BODY, pasted].sort());
  });

  it('no /send row at all (typed in the terminal): the whole text is recorded', async () => {
    const turn = `${brief('claude')}\n\n${BODY}`;
    const result = await recordUserTurn({ worktreeId: WT, cliToolId: 'claude', instanceId: 'claude' }, 'k1', turn, AT);
    expect(result.outcome).toBe('inserted');
    expect(userRows('claude').map((row) => row.content)).toEqual([turn]);
  });
});

describe('H-c a send with no brief is read back as before (H-3)', () => {
  it('the body alone is claimed by its own row', async () => {
    const sent = sendRow('codex', BODY, AT);
    expect(await recordUserTurn({ worktreeId: WT, cliToolId: 'codex', instanceId: 'codex' }, 'k1', BODY, AT + 100)).toMatchObject({
      outcome: 'adopted',
      messageId: sent.id,
    });
    expect(afterDeliveredBrief(BODY)).toBeNull();
  });
});

describe('H-d no evidence, no cut', () => {
  it('no /send row with the rest in the window: the whole text stays (an unrelated old row is not used)', async () => {
    sendRow('claude', BODY, AT - USER_TURN_ADOPTION_WINDOW_MS - 60_000);
    const turn = `${brief('claude')}\n\n${BODY}`;
    expect((await recordUserTurn({ worktreeId: WT, cliToolId: 'claude', instanceId: 'claude' }, 'k1', turn, AT)).outcome).toBe('inserted');
    expect(userRows('claude').map((row) => row.content)).toContain(turn);
  });

  it('fences whose tags differ are not a brief: the whole text stays', async () => {
    sendRow('claude', BODY, AT);
    const real = brief('claude');
    const broken = real.replace(/cmate-brief:([0-9a-f]{8})>>>$/, 'cmate-brief:00000000>>>');
    expect(broken).not.toBe(real);
    const turn = `${broken}\n\n${BODY}`;
    expect(afterDeliveredBrief(turn)).toBeNull();
    expect((await recordUserTurn({ worktreeId: WT, cliToolId: 'claude', instanceId: 'claude' }, 'k1', turn, AT)).outcome).toBe('inserted');
  });

  it('a relay delivery row is never claimed for the rest', async () => {
    createMessage(db, {
      worktreeId: WT,
      role: 'user',
      content: BODY,
      messageType: 'normal',
      timestamp: new Date(AT),
      cliToolId: 'claude',
      instanceId: 'claude',
      requestId: 'relay:r1',
    });
    const turn = `${brief('claude')}\n\n${BODY}`;
    expect((await recordUserTurn({ worktreeId: WT, cliToolId: 'claude', instanceId: 'claude' }, 'k1', turn, AT)).outcome).toBe('inserted');
  });
});

describe('H-e a brief rebuilt after a partial reservation keeps its first tag (2nd review ④)', () => {
  it('the dropped-notice body (tag unchanged) is still recognised: one row, the body', async () => {
    const full = brief('claude');
    const rebuilt = dropNoticeLines(full, new Set([NOTICE_LINE]));
    expect(rebuilt).not.toBe(full);
    expect(rebuilt.split('\n')[0]).toBe(full.split('\n')[0]); // the tag is kept, not computed again
    const sent = sendRow('claude', BODY, AT);
    const result = await recordUserTurn({ worktreeId: WT, cliToolId: 'claude', instanceId: 'claude' }, 'k1', `${rebuilt}\n\n${BODY}`, AT + 300);
    expect(result).toMatchObject({ outcome: 'adopted', messageId: sent.id });
    expect(userRows('claude').map((row) => row.content)).toEqual([BODY]);
  });
});

describe('H-f the evidence lives as long as the adoption does (2nd review ⑤)', () => {
  it('a send accepted 11 minutes late (the widened window) is still the one row', async () => {
    const sent = sendRow('claude', BODY, AT);
    const turnAt = AT + 11 * 60_000;
    const result = await recordUserTurn(
      { worktreeId: WT, cliToolId: 'claude', instanceId: 'claude' },
      'k1',
      `${brief('claude')}\n\n${BODY}`,
      turnAt,
      { adoptionFromMs: AT - 1_000 }
    );
    expect(result).toMatchObject({ outcome: 'adopted', messageId: sent.id });
    expect(userRows('claude')).toHaveLength(1);
  });

  it('without the ledger (its rows retained away): the row is still claimed — the ledger is not read', async () => {
    db.prepare('DELETE FROM session_brief_boundaries').run();
    const sent = sendRow('command-code', BODY, AT);
    const result = await recordUserTurn(
      { worktreeId: WT, cliToolId: 'command-code', instanceId: 'command-code' },
      'k1',
      `${brief('command-code')}\n\n${BODY}`,
      AT + 100
    );
    expect(result).toMatchObject({ outcome: 'adopted', messageId: sent.id });
  });
});
