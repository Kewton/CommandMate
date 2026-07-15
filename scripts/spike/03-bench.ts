/**
 * Spike 03: better-sqlite3 vs node:sqlite パフォーマンス比較 (Issue #1201)
 *
 * 何を検証するか:
 *   CommandMate の代表的なクエリ 5 本について、better-sqlite3 と node:sqlite（互換アダプタ経由）の
 *   実行時間を比較する。node:sqlite が「同等以上」かを判断する材料を出す。
 *
 *   ベンチ対象（実際のスキーマ・クエリ形状に合わせたもの）:
 *     B1. chat_messages 単純 INSERT（prepared statement 再利用）
 *     B2. chat_messages 一覧取得（worktree_id + ORDER BY timestamp、インデックス利用）
 *     B3. session_states の UPSERT（ON CONFLICT DO UPDATE）
 *     B4. worktrees 一覧（複数カラム SELECT）
 *     B5. トランザクション内バルク INSERT（1000 行）
 *
 *   アダプタ経由の測定なので「node:sqlite 素の性能」ではなく
 *   「移行方式 (b) を採った場合に本番で出る性能」を測っている点に注意。
 *
 * 実行:
 *   npx tsx scripts/spike/03-bench.ts
 *
 * 注意: 本番 DB には触れない。/tmp の使い捨て DB のみ。
 */

import BetterSqlite3 from 'better-sqlite3';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';

import { migrations } from '../../src/lib/db/migrations/index';
import { runMigrations } from '../../src/lib/db/migrations/runner';
import { BetterSqlite3CompatAdapter } from './lib/node-sqlite-adapter.mjs';

const ITERATIONS = 2000;
const BULK_ROWS = 1000;
const WARMUP = 200;

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-spike-bench-'));

const origLog = console.log;
function quiet<T>(fn: () => T): T {
  console.log = () => {};
  try {
    return fn();
  } finally {
    console.log = origLog;
  }
}

function setup(driver: 'better-sqlite3' | 'node:sqlite') {
  const dbPath = path.join(tmpDir, `${driver.replace(':', '-')}.db`);
  const db =
    driver === 'better-sqlite3'
      ? (new BetterSqlite3(dbPath) as never)
      : (new BetterSqlite3CompatAdapter(dbPath) as never);
  (db as { pragma: (s: string) => void }).pragma('foreign_keys = ON');
  quiet(() => runMigrations(db, migrations));
  return db as unknown as {
    prepare: (sql: string) => { run: (...a: unknown[]) => unknown; get: (...a: unknown[]) => unknown; all: (...a: unknown[]) => unknown[] };
    exec: (sql: string) => unknown;
    transaction: (fn: () => void) => () => void;
    close: () => void;
  };
}

function bench(label: string, fn: () => void, iterations: number): number {
  // warmup
  for (let i = 0; i < Math.min(WARMUP, iterations); i++) fn();
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < iterations; i++) fn();
  const t1 = process.hrtime.bigint();
  return Number(t1 - t0) / 1e6; // ms
}

type Row = { name: string; iterations: number; bs: number; ns: number };
const rows: Row[] = [];

function runFor(driver: 'better-sqlite3' | 'node:sqlite') {
  const db = setup(driver);
  const results: Record<string, number> = {};

  // seed a worktree (FK parent)
  const wtId = randomUUID();
  db.prepare(
    `INSERT INTO worktrees (id, name, path, repository_path, repository_name, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(wtId, 'bench-wt', `/tmp/bench/${wtId}`, '/tmp/bench', 'bench-repo', Date.now());

  // ---- B1: chat_messages INSERT ----
  const insertMsg = db.prepare(
    `INSERT INTO chat_messages (id, worktree_id, role, content, timestamp)
     VALUES (?, ?, ?, ?, ?)`
  );
  let n = 0;
  results['B1 chat_messages INSERT'] = bench(
    'B1',
    () => {
      insertMsg.run(randomUUID(), wtId, 'user', `message body ${n++}`, Date.now());
    },
    ITERATIONS
  );

  // ---- B2: chat_messages 一覧取得 ----
  const selectMsgs = db.prepare(
    `SELECT id, worktree_id, role, content, timestamp
     FROM chat_messages WHERE worktree_id = ? ORDER BY timestamp DESC LIMIT 50`
  );
  results['B2 chat_messages 一覧(LIMIT 50)'] = bench('B2', () => { selectMsgs.all(wtId); }, ITERATIONS / 4);

  // ---- B3: session_states UPSERT ----
  const upsert = db.prepare(
    `INSERT INTO session_states (worktree_id, cli_tool_id, instance_id, last_captured_line)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(worktree_id, instance_id) DO UPDATE SET last_captured_line = excluded.last_captured_line`
  );
  let line = 0;
  results['B3 session_states UPSERT'] = bench('B3', () => { upsert.run(wtId, 'claude', 'claude-1', line++); }, ITERATIONS);

  // ---- B4: worktrees 一覧 ----
  const listWt = db.prepare(
    `SELECT id, name, path, repository_path, repository_name, updated_at, branch FROM worktrees ORDER BY updated_at DESC`
  );
  results['B4 worktrees 一覧'] = bench('B4', () => { listWt.all(); }, ITERATIONS);

  // ---- B5: transaction バルク INSERT ----
  const bulkStmt = db.prepare(
    `INSERT INTO chat_messages (id, worktree_id, role, content, timestamp) VALUES (?, ?, ?, ?, ?)`
  );
  const bulk = db.transaction(() => {
    for (let i = 0; i < BULK_ROWS; i++) {
      bulkStmt.run(randomUUID(), wtId, 'assistant', `bulk ${i}`, Date.now());
    }
  });
  results[`B5 transaction バルクINSERT(${BULK_ROWS}行)`] = bench('B5', () => { bulk(); }, 5);

  db.close();
  return results;
}

console.log('='.repeat(84));
console.log(`Spike 03: performance  |  Node ${process.version}  |  ${os.cpus()[0]?.model ?? 'unknown cpu'}`);
console.log(`  iterations: ${ITERATIONS} (B2 は ${ITERATIONS / 4}, B5 は 5 回 x ${BULK_ROWS} 行)`);
console.log('='.repeat(84));

console.log('\n計測中: better-sqlite3 ...');
const bsRes = runFor('better-sqlite3');
console.log('計測中: node:sqlite (互換アダプタ経由) ...');
const nsRes = runFor('node:sqlite');

for (const key of Object.keys(bsRes)) {
  rows.push({ name: key, iterations: 0, bs: bsRes[key], ns: nsRes[key] });
}

console.log('\n' + '='.repeat(84));
console.log('結果（合計 ms / 低いほど速い）');
console.log('='.repeat(84));
console.log(
  `${'ベンチ'.padEnd(38)} ${'better-sqlite3'.padStart(14)} ${'node:sqlite'.padStart(14)} ${'比'.padStart(10)}`
);
console.log('-'.repeat(84));
for (const r of rows) {
  const ratio = r.ns / r.bs;
  const verdict = ratio <= 1.1 ? '同等以上' : ratio <= 1.5 ? 'やや低速' : '低速';
  console.log(
    `${r.name.padEnd(38)} ${r.bs.toFixed(1).padStart(14)} ${r.ns.toFixed(1).padStart(14)} ${(`x${ratio.toFixed(2)}`).padStart(10)}  ${verdict}`
  );
}
console.log('-'.repeat(84));
const totalBs = rows.reduce((a, r) => a + r.bs, 0);
const totalNs = rows.reduce((a, r) => a + r.ns, 0);
console.log(
  `${'合計'.padEnd(38)} ${totalBs.toFixed(1).padStart(14)} ${totalNs.toFixed(1).padStart(14)} ${(`x${(totalNs / totalBs).toFixed(2)}`).padStart(10)}`
);

const outPath = path.join(os.tmpdir(), 'cm-spike-03-bench.json');
fs.writeFileSync(outPath, JSON.stringify({ node: process.version, cpu: os.cpus()[0]?.model, rows }, null, 2));
console.log(`\nJSON: ${outPath}`);

fs.rmSync(tmpDir, { recursive: true, force: true });
