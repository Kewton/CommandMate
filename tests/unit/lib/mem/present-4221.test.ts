/**
 * The one shape an item leaves in, and the withheld shape when a newer rule matches a
 * stored value (Issue #4221, design §6.4・§12.3, 2nd review 6). List, `--json` and the
 * conflict answer all go through `presentMemItem`; this pins that function and then
 * the list and conflict answers built on it.
 *
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { mkdirSync } from 'fs';
import path from 'path';
import { openMigratedFileDb } from '@tests/helpers/migrated-file-db';
import { makeTempDir, removeTempDir } from '@tests/helpers/temp-dir';
import { findWithheld, presentMemItem, type MemRecord } from '@/lib/mem/present';
import { MEM_SECRET_RULES, MEM_SECRET_RULES_VERSION } from '@/lib/mem/secret-scan';
import { createRepository } from '@/lib/db/db-repository';
import { getMemSettings, saveMemSettings } from '@/lib/db/mem-db';
import { setAgentInstances } from '@/lib/db/agent-instances-db';
import { memAddItem, memList, memUpdateItem, type MemServiceDeps } from '@/lib/mem/service';
import { MEM_WITHHELD_KEPT_KEYS, type MemListResponse, type MemWriteResponse } from '@/types/mem';

const NEW_RULES = [...MEM_SECRET_RULES, { id: 'internal-ticket', pattern: /TICKET-SECRET-\d+/ }];
const NEXT_VERSION = MEM_SECRET_RULES_VERSION + 1;
const FREE_KEYS = ['text', 'quote', 'quoteAt', 'evidence', 'promoteTo', 'closeWhen', 'closeNote'];

function record(overrides: Partial<MemRecord> = {}): MemRecord {
  return {
    id: 'item-1',
    kind: 'note',
    state: 'open',
    text: 'plain',
    closeWhen: '{"schema":1,"type":"manual"}',
    promoteTo: null,
    quote: null,
    quoteAt: null,
    evidence: [],
    closeNote: null,
    owner: {
      repositoryId: 'r',
      branch: 'main',
      worktreeId: 'w',
      worktreeIncarnation: 'wi',
      instanceId: 'claude',
      cliToolId: 'claude',
      incarnation: 'i',
      sessionGeneration: null,
    },
    createdBy: 'agent',
    updatedBy: 'agent',
    version: 3,
    checkedRulesVersion: MEM_SECRET_RULES_VERSION,
    createdAt: 0,
    updatedAt: 0,
    closedAt: null,
    closeReason: null,
    ...overrides,
  };
}

describe('presentMemItem (2nd review 6)', () => {
  it('shows every field of an item no rule matches (control)', () => {
    const view = presentMemItem(record({ quote: 'said', quoteAt: 1, evidence: ['commit:abcdef1'] }), {
      rules: NEW_RULES,
      rulesVersion: NEXT_VERSION,
    });
    expect(view).toMatchObject({ text: 'plain', quote: 'said', evidence: ['commit:abcdef1'] });
    expect(view.withheld).toBeUndefined();
  });

  it.each([
    ['text', { text: 'see TICKET-SECRET-1' }],
    ['quote', { quote: 'TICKET-SECRET-2', quoteAt: 1 }],
    ['evidence', { evidence: ['task:ok', 'url:https://x/TICKET-SECRET-3'] }],
    ['promoteTo', { promoteTo: 'issue:#1 TICKET-SECRET-4' }],
    ['closeNote', { closeNote: 'TICKET-SECRET-5' }],
  ] as const)('withholds the whole item when %s matches a newer rule', (field, overrides) => {
    const view = presentMemItem(record(overrides as Partial<MemRecord>), { rules: NEW_RULES, rulesVersion: NEXT_VERSION });
    expect(view.withheld).toEqual({ code: 'secret_like', field, rule: 'internal-ticket' });
    for (const key of FREE_KEYS) expect(view).not.toHaveProperty(key);
    expect(Object.keys(view).sort()).toEqual([...MEM_WITHHELD_KEPT_KEYS, 'withheld'].sort());
    expect(JSON.stringify(view)).not.toContain('TICKET-SECRET');
  });

  it('does not re-read a row checked against the current rules', () => {
    expect(findWithheld(record({ text: 'TICKET-SECRET-9', checkedRulesVersion: NEXT_VERSION }), NEW_RULES, NEXT_VERSION)).toBeNull();
  });
});

describe('every exit uses the withheld shape (list, --json, the conflict answer)', () => {
  let dir: string;
  let db: Database.Database;
  let deps: MemServiceDeps;

  beforeEach(() => {
    dir = makeTempDir('mem-present-4221-');
    db = openMigratedFileDb(path.join(dir, 'cm.db'), { foreignKeys: true });
    const root = path.join(dir, 'root');
    mkdirSync(root);
    mkdirSync(path.join(dir, 'wt'));
    const repo = createRepository(db, { name: 'r', path: root, cloneSource: 'local' }).id;
    db.prepare(`INSERT INTO worktrees (id, name, path, repository_path, repository_name) VALUES ('wt', 'wt', ?, ?, 'r')`).run(
      path.join(dir, 'wt'),
      root
    );
    setAgentInstances(db, 'wt', [{ id: 'claude', cliTool: 'claude', alias: '', order: 0 }]);
    saveMemSettings(db, repo, { version: getMemSettings(db, repo).version, features: getMemSettings(db, repo).features, rules: [{ match: 'glob', pattern: '**', mode: 'on' }] });
    deps = {
      resolveCommonDir: async () => '/c/.git',
      pathExists: () => true,
      observe: async () => ({ branch: 'main', detached: false, head: null, commonDir: '/c/.git', known: true }),
    };
  });
  afterEach(() => {
    db.close();
    removeTempDir(dir);
  });

  it('a stored quote and evidence that a newer rule matches leave no free field in list or conflict', async () => {
    const added = (
      await memAddItem(
        db,
        'wt',
        { instanceId: 'claude', kind: 'note', text: 'plain', quote: 'TICKET-SECRET-7', quoteAt: '2026-11-01T00:00:00Z', evidence: ['task:TICKET-SECRET-8'] },
        deps
      )
    ).body as MemWriteResponse;
    // A row checked against an older rule set: what a release adding a rule finds.
    db.prepare('UPDATE mem_items SET checked_rules_version = 0').run();
    const module = await import('@/lib/mem/secret-scan');
    (module.MEM_SECRET_RULES as unknown as Array<{ id: string; pattern: RegExp }>).push({ id: 'internal-ticket', pattern: /TICKET-SECRET-\d+/ });
    try {
      const list = (await memList(db, { via: 'worktree', worktreeId: 'wt' }, {}, deps)).body as MemListResponse;
      expect(list.items[0].withheld).toMatchObject({ field: 'quote', rule: 'internal-ticket' });
      const conflict = await memUpdateItem(db, 'wt', added.item.id, { instanceId: 'claude', ifVersion: 99, text: 'x' }, deps);
      expect(conflict.body).toMatchObject({ code: 'version_conflict', item: { withheld: { rule: 'internal-ticket' } } });
      for (const body of [list, conflict.body]) {
        expect(JSON.stringify(body)).not.toContain('TICKET-SECRET');
      }
    } finally {
      (module.MEM_SECRET_RULES as unknown as unknown[]).pop();
    }
  });
});
