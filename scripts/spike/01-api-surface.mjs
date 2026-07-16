/**
 * Spike 01: node:sqlite vs better-sqlite3 API surface comparison (Issue #1201)
 *
 * 何を検証するか:
 *   1. `node:sqlite` が experimental 警告を出すか（実行中の Node バージョンで）
 *   2. CommandMate が実際に使用している better-sqlite3 API が node:sqlite に存在するか
 *   3. 型変換（bigint / Buffer / null / boolean）の挙動差
 *   4. PRAGMA / WAL / トランザクションの代替可否
 *
 * 実行:
 *   node scripts/spike/01-api-surface.mjs
 *
 * 注意: 本番 DB には一切触れない。すべて :memory: と /tmp の使い捨て DB で検証する。
 */

import { DatabaseSync } from 'node:sqlite';
import BetterSqlite3 from 'better-sqlite3';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const results = [];
function record(area, item, betterSqlite3, nodeSqlite, verdict, note) {
  results.push({ area, item, betterSqlite3, nodeSqlite, verdict, note });
}

console.log('='.repeat(78));
console.log(`Spike 01: API surface  |  Node ${process.version}  |  platform ${process.platform}`);
console.log('='.repeat(78));

// ---------------------------------------------------------------------------
// 1. Experimental status
// ---------------------------------------------------------------------------
// The ExperimentalWarning is emitted on first require of node:sqlite. We can
// observe it via the process warning event only if we re-import in a child,
// so here we report the documented stability instead and let the shell capture
// stderr. See 01-experimental-check below for the definitive child-process test.
console.log('\n[1] node:sqlite exports:', Object.keys(await import('node:sqlite')).sort().join(', '));

// ---------------------------------------------------------------------------
// 2. Database-level API used by CommandMate
// ---------------------------------------------------------------------------
const nsDb = new DatabaseSync(':memory:');
const bsDb = new BetterSqlite3(':memory:');

const DB_METHODS = [
  ['prepare', 'src/ 全体で 194 箇所'],
  ['exec', 'src/ 全体で 151 箇所'],
  ['transaction', 'src/ で 8 箇所（runner.ts x2 含む）'],
  ['pragma', 'src/ 本番コード 2 箇所'],
  ['close', 'src/ で 5 箇所'],
  ['function', 'CommandMate では未使用'],
  ['aggregate', 'CommandMate では未使用'],
  ['backup', 'CommandMate では未使用'],
  ['serialize', 'CommandMate では未使用'],
  ['loadExtension', 'CommandMate では未使用'],
  ['defaultSafeIntegers', 'CommandMate では未使用'],
];

console.log('\n[2] Database メソッドの有無');
for (const [m, usage] of DB_METHODS) {
  const inBs = typeof bsDb[m] === 'function';
  const inNs = typeof nsDb[m] === 'function';
  const verdict = inBs && !inNs ? 'GAP' : inNs ? 'OK' : 'n/a';
  console.log(
    `    ${verdict.padEnd(4)} ${m.padEnd(20)} better-sqlite3=${String(inBs).padEnd(5)} node:sqlite=${String(inNs).padEnd(5)}  ${usage}`
  );
  record('Database', m, inBs, inNs, verdict, usage);
}

// ---------------------------------------------------------------------------
// 3. Statement-level API used by CommandMate
// ---------------------------------------------------------------------------
nsDb.exec('CREATE TABLE t (a INTEGER, b TEXT)');
bsDb.exec('CREATE TABLE t (a INTEGER, b TEXT)');
const nsStmt = nsDb.prepare('SELECT * FROM t');
const bsStmt = bsDb.prepare('SELECT * FROM t');

const STMT_METHODS = [
  ['get', 'src/ で使用（主要）'],
  ['all', 'src/ で使用（主要）'],
  ['run', 'src/ で使用（主要）'],
  ['iterate', 'CommandMate では未使用'],
  ['pluck', 'CommandMate では未使用'],
  ['raw', 'CommandMate では未使用'],
  ['columns', 'CommandMate では未使用'],
  ['bind', 'CommandMate では未使用'],
  ['safeIntegers', 'CommandMate では未使用'],
];

console.log('\n[3] Statement メソッドの有無');
for (const [m, usage] of STMT_METHODS) {
  const inBs = typeof bsStmt[m] === 'function';
  const inNs = typeof nsStmt[m] === 'function';
  const verdict = inBs && !inNs ? 'GAP' : inNs ? 'OK' : 'n/a';
  console.log(
    `    ${verdict.padEnd(4)} ${m.padEnd(20)} better-sqlite3=${String(inBs).padEnd(5)} node:sqlite=${String(inNs).padEnd(5)}  ${usage}`
  );
  record('Statement', m, inBs, inNs, verdict, usage);
}

// ---------------------------------------------------------------------------
// 4. run() return value shape (lastInsertRowid / changes)
// ---------------------------------------------------------------------------
console.log('\n[4] run() の戻り値');
const nsRun = nsDb.prepare('INSERT INTO t VALUES (?, ?)').run(1, 'x');
const bsRun = bsDb.prepare('INSERT INTO t VALUES (?, ?)').run(1, 'x');
console.log('    better-sqlite3:', JSON.stringify(bsRun, (k, v) => (typeof v === 'bigint' ? `${v}n` : v)));
console.log('    node:sqlite   :', JSON.stringify(nsRun, (k, v) => (typeof v === 'bigint' ? `${v}n` : v)));
console.log(`    changes type   : better-sqlite3=${typeof bsRun.changes}  node:sqlite=${typeof nsRun.changes}`);
console.log(`    lastInsertRowid: better-sqlite3=${typeof bsRun.lastInsertRowid}  node:sqlite=${typeof nsRun.lastInsertRowid}`);
record(
  'run()',
  'changes / lastInsertRowid の型',
  `${typeof bsRun.changes} / ${typeof bsRun.lastInsertRowid}`,
  `${typeof nsRun.changes} / ${typeof nsRun.lastInsertRowid}`,
  typeof bsRun.changes === typeof nsRun.changes ? 'OK' : 'GAP',
  'changes を数値比較している箇所に影響'
);

// ---------------------------------------------------------------------------
// 5. Row prototype (null-prototype vs Object)
// ---------------------------------------------------------------------------
console.log('\n[5] 行オブジェクトのプロトタイプ');
const nsRow = nsDb.prepare('SELECT * FROM t').get();
const bsRow = bsDb.prepare('SELECT * FROM t').get();
const nsProto = Object.getPrototypeOf(nsRow);
const bsProto = Object.getPrototypeOf(bsRow);
console.log(`    better-sqlite3 proto: ${bsProto === Object.prototype ? 'Object.prototype' : String(bsProto)}`);
console.log(`    node:sqlite    proto: ${nsProto === null ? 'null (null-prototype!)' : String(nsProto)}`);
record(
  'Row',
  'prototype',
  bsProto === Object.prototype ? 'Object.prototype' : String(bsProto),
  nsProto === null ? 'null prototype' : String(nsProto),
  bsProto === nsProto ? 'OK' : 'GAP',
  'null-prototype は instanceof / hasOwnProperty / スプレッド互換に影響'
);

// ---------------------------------------------------------------------------
// 6. Type conversion: boolean / bigint / Buffer / null / undefined
// ---------------------------------------------------------------------------
console.log('\n[6] 型変換');
nsDb.exec('CREATE TABLE ty (v)');
bsDb.exec('CREATE TABLE ty (v)');

function tryBind(db, label, value) {
  try {
    db.prepare('DELETE FROM ty').run();
    db.prepare('INSERT INTO ty VALUES (?)').run(value);
    const out = db.prepare('SELECT v FROM ty').get();
    const v = out.v;
    return `ok -> ${typeof v}:${v instanceof Uint8Array ? `Uint8Array(${v.length})` : String(v)}`;
  } catch (e) {
    return `THROW: ${e.message.slice(0, 60)}`;
  }
}

const TYPE_CASES = [
  ['boolean true', true],
  ['number 42', 42],
  ['bigint 9007199254740993n', 9007199254740993n],
  ['string', 'hello'],
  ['null', null],
  ['Buffer', Buffer.from([1, 2, 3])],
  ['Uint8Array', new Uint8Array([1, 2, 3])],
];

for (const [label, value] of TYPE_CASES) {
  const bs = tryBind(bsDb, label, value);
  const ns = tryBind(nsDb, label, value);
  const verdict = bs === ns ? 'OK' : 'DIFF';
  console.log(`    ${verdict.padEnd(4)} ${label.padEnd(26)}`);
  console.log(`         better-sqlite3: ${bs}`);
  console.log(`         node:sqlite   : ${ns}`);
  record('型変換', label, bs, ns, verdict, '');
}

// ---------------------------------------------------------------------------
// 7. PRAGMA: foreign_keys / defer_foreign_keys / journal_mode(WAL)
// ---------------------------------------------------------------------------
console.log('\n[7] PRAGMA の代替可否（node:sqlite は db.pragma() を持たない → exec/prepare で代替）');

function pragmaViaExec(db, sql) {
  try {
    db.exec(`PRAGMA ${sql}`);
    return 'exec ok';
  } catch (e) {
    return `THROW: ${e.message.slice(0, 60)}`;
  }
}
function pragmaViaPrepare(db, sql) {
  try {
    const r = db.prepare(`PRAGMA ${sql}`).get();
    return `read -> ${JSON.stringify(r)}`;
  } catch (e) {
    return `THROW: ${e.message.slice(0, 60)}`;
  }
}

for (const p of ['foreign_keys = ON', 'defer_foreign_keys = ON']) {
  console.log(`    PRAGMA ${p}`);
  console.log(`         node:sqlite exec   : ${pragmaViaExec(nsDb, p)}`);
}
console.log('    PRAGMA foreign_keys (read back)');
console.log(`         node:sqlite prepare: ${pragmaViaPrepare(nsDb, 'foreign_keys')}`);
console.log('    PRAGMA table_info(t) (テストで使用)');
try {
  const ti = nsDb.prepare('PRAGMA table_info(t)').all();
  console.log(`         node:sqlite prepare: ok, ${ti.length} columns -> ${ti.map((c) => c.name).join(',')}`);
  record('PRAGMA', 'table_info()', 'db.pragma()', 'db.prepare().all()', 'OK(代替可)', 'テスト4箇所で使用');
} catch (e) {
  console.log(`         node:sqlite prepare: THROW ${e.message}`);
  record('PRAGMA', 'table_info()', 'db.pragma()', 'THROW', 'GAP', '');
}

// WAL on a real file (in-memory DBs cannot use WAL)
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-spike-'));
const walPath = path.join(tmpDir, 'wal-test.db');
try {
  const walDb = new DatabaseSync(walPath);
  const before = walDb.prepare('PRAGMA journal_mode').get();
  walDb.exec('PRAGMA journal_mode = WAL');
  const after = walDb.prepare('PRAGMA journal_mode').get();
  console.log(`    PRAGMA journal_mode = WAL (file DB)`);
  console.log(`         before: ${JSON.stringify(before)}  after: ${JSON.stringify(after)}`);
  record(
    'PRAGMA',
    'journal_mode = WAL',
    'db.pragma("journal_mode = WAL")',
    `db.exec() -> ${JSON.stringify(after)}`,
    'OK(代替可)',
    '※CommandMate は WAL を設定していない（journal_mode は src/ に不在）'
  );
  walDb.close();
} catch (e) {
  console.log(`    WAL THROW: ${e.message}`);
  record('PRAGMA', 'journal_mode = WAL', 'ok', `THROW ${e.message}`, 'GAP', '');
}

// ---------------------------------------------------------------------------
// 8. transaction: better-sqlite3 helper vs manual BEGIN/COMMIT on node:sqlite
// ---------------------------------------------------------------------------
console.log('\n[8] transaction の代替（node:sqlite に db.transaction() は無い）');

// 8a. rollback-on-throw — agent-instances-db.ts:203 がこの挙動に依存
function manualTransaction(db, fn) {
  return (...args) => {
    db.exec('BEGIN');
    try {
      const out = fn(...args);
      db.exec('COMMIT');
      return out;
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  };
}

nsDb.exec('CREATE TABLE tx (v INTEGER)');
try {
  manualTransaction(nsDb, () => {
    nsDb.prepare('INSERT INTO tx VALUES (1)').run();
    throw new Error('boom');
  })();
} catch {
  /* expected */
}
const txCount = nsDb.prepare('SELECT COUNT(*) AS c FROM tx').get().c;
console.log(`    rollback-on-throw: 手動 BEGIN/ROLLBACK -> 残存行数=${txCount} (期待 0)`);
record(
  'transaction',
  'rollback-on-throw',
  'db.transaction() が自動',
  `手動 BEGIN/try/ROLLBACK で再現可（残存${txCount}行）`,
  txCount === 0 ? 'OK(代替可)' : 'GAP',
  'agent-instances-db.ts:203 が依存'
);

// 8b. nesting — better-sqlite3 は savepoint で入れ子を吸収する。手動 BEGIN は入れ子で throw する
console.log('    nesting（入れ子）:');
try {
  nsDb.exec('BEGIN');
  nsDb.exec('BEGIN'); // nested
  console.log('         node:sqlite 入れ子 BEGIN: 通った（想定外）');
  record('transaction', 'nesting', 'savepoint で自動吸収', '入れ子 BEGIN が通った', 'CHECK', '');
} catch (e) {
  console.log(`         node:sqlite 入れ子 BEGIN: THROW "${e.message.slice(0, 70)}"`);
  record(
    'transaction',
    'nesting（入れ子）',
    'savepoint で自動吸収（.transaction() は再入可）',
    `素の BEGIN は THROW: ${e.message.slice(0, 50)}`,
    'GAP',
    'SAVEPOINT を使った自前ヘルパが必要'
  );
} finally {
  try {
    nsDb.exec('ROLLBACK');
  } catch {
    /* ignore */
  }
}

// 8c. savepoint-based nesting works?
console.log('    SAVEPOINT による入れ子:');
try {
  nsDb.exec('BEGIN');
  nsDb.exec('SAVEPOINT sp1');
  nsDb.prepare('INSERT INTO tx VALUES (99)').run();
  nsDb.exec('ROLLBACK TO sp1');
  nsDb.exec('RELEASE sp1');
  nsDb.exec('COMMIT');
  const c = nsDb.prepare('SELECT COUNT(*) AS c FROM tx').get().c;
  console.log(`         SAVEPOINT ネスト: ok（残存${c}行、期待 0）`);
  record('transaction', 'SAVEPOINT ネスト', 'db.transaction() が内部で使用', 'SAVEPOINT/ROLLBACK TO/RELEASE が動作', 'OK(代替可)', '自前ヘルパで再現可能');
} catch (e) {
  console.log(`         SAVEPOINT ネスト: THROW ${e.message}`);
  record('transaction', 'SAVEPOINT ネスト', 'ok', `THROW ${e.message}`, 'GAP', '');
}

// 8d. better-sqlite3 transaction variants
console.log('    better-sqlite3 の .deferred/.immediate/.exclusive バリアント:');
const bsTx = bsDb.transaction(() => {});
console.log(
  `         better-sqlite3: deferred=${typeof bsTx.deferred} immediate=${typeof bsTx.immediate} exclusive=${typeof bsTx.exclusive}`
);
console.log('         node:sqlite   : 相当物なし（BEGIN DEFERRED/IMMEDIATE/EXCLUSIVE を手書き）');
record(
  'transaction',
  '.deferred/.immediate/.exclusive',
  'あり',
  'なし（BEGIN <mode> を手書きで代替）',
  'GAP(未使用)',
  'CommandMate では未使用のため影響なし'
);

// ---------------------------------------------------------------------------
// 9. Summary
// ---------------------------------------------------------------------------
console.log('\n' + '='.repeat(78));
console.log('SUMMARY: GAP と判定された項目');
console.log('='.repeat(78));
const gaps = results.filter((r) => r.verdict.startsWith('GAP') || r.verdict === 'DIFF');
for (const g of gaps) {
  console.log(`  [${g.verdict}] ${g.area} / ${g.item}`);
  console.log(`        better-sqlite3: ${g.betterSqlite3}`);
  console.log(`        node:sqlite   : ${g.nodeSqlite}`);
  if (g.note) console.log(`        note: ${g.note}`);
}
console.log(`\n  GAP/DIFF 合計: ${gaps.length} 件 / 検査 ${results.length} 項目`);

nsDb.close();
bsDb.close();
fs.rmSync(tmpDir, { recursive: true, force: true });

// Emit machine-readable output for the report
const outPath = path.join(os.tmpdir(), 'cm-spike-01-results.json');
fs.writeFileSync(outPath, JSON.stringify({ node: process.version, results }, null, 2));
console.log(`\n  JSON: ${outPath}`);
