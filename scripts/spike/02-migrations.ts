/**
 * Spike 02: 本番マイグレーション（v01〜v41）の node:sqlite 互換性検証 (Issue #1201)
 *
 * 何を検証するか:
 *   1. 本番の `migrations` 配列と `runMigrations()` を **そのまま** node:sqlite アダプタに流し、
 *      全マイグレーションが適用できるか（再実装ではなく実物を使う点が重要）
 *   2. better-sqlite3 で作った DB と node:sqlite で作った DB の **スキーマが完全一致**するか
 *   3. better-sqlite3 が作った既存 DB ファイルを node:sqlite で読み書きできるか（前方互換）
 *   4. node:sqlite が作った DB ファイルを better-sqlite3 で読み書きできるか（後方互換＝ロールバック可否）
 *   5. validateSchema() が両ドライバで true を返すか
 *
 * 実行:
 *   npx tsx scripts/spike/02-migrations.ts
 *
 * 注意: 本番 DB（~/.commandmate/data/cm.db）には一切触れない。すべて /tmp の使い捨て DB。
 */

import BetterSqlite3 from 'better-sqlite3';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

import { migrations } from '../../src/lib/db/migrations/index';
import { runMigrations, validateSchema, getCurrentVersion, CURRENT_SCHEMA_VERSION } from '../../src/lib/db/migrations/runner';
import { BetterSqlite3CompatAdapter } from './lib/node-sqlite-adapter.mjs';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-spike-mig-'));
const bsPath = path.join(tmpDir, 'better-sqlite3.db');
const nsPath = path.join(tmpDir, 'node-sqlite.db');

let failures = 0;
function check(label: string, ok: boolean, detail = '') {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
  if (!ok) failures++;
}

// 冗長な migration ログを抑制
const origLog = console.log;
function quiet<T>(fn: () => T): T {
  console.log = () => {};
  try {
    return fn();
  } finally {
    console.log = origLog;
  }
}

console.log('='.repeat(78));
console.log(`Spike 02: migrations v01-v${CURRENT_SCHEMA_VERSION}  |  Node ${process.version}`);
console.log(`  migration 定義数: ${migrations.length}  |  CURRENT_SCHEMA_VERSION: ${CURRENT_SCHEMA_VERSION}`);
console.log(`  tmp: ${tmpDir}`);
console.log('='.repeat(78));

// ---------------------------------------------------------------------------
// 1. better-sqlite3 で全マイグレーション適用（ベースライン）
// ---------------------------------------------------------------------------
console.log('\n[1] better-sqlite3 でベースライン構築');
const bsDb = new BetterSqlite3(bsPath);
bsDb.pragma('foreign_keys = ON');
let bsOk = true;
try {
  quiet(() => runMigrations(bsDb as never, migrations));
} catch (e) {
  bsOk = false;
  console.log(`  ERROR: ${(e as Error).message}`);
}
check('better-sqlite3: 全マイグレーション適用', bsOk);
check(
  `better-sqlite3: version == ${CURRENT_SCHEMA_VERSION}`,
  getCurrentVersion(bsDb as never) === CURRENT_SCHEMA_VERSION,
  `actual=${getCurrentVersion(bsDb as never)}`
);
check('better-sqlite3: validateSchema()', quiet(() => validateSchema(bsDb as never)));

// ---------------------------------------------------------------------------
// 2. node:sqlite アダプタで全マイグレーション適用（本番コードをそのまま使用）
// ---------------------------------------------------------------------------
console.log('\n[2] node:sqlite アダプタで全マイグレーション適用');
const nsDb = new BetterSqlite3CompatAdapter(nsPath);
nsDb.pragma('foreign_keys = ON');
let nsOk = true;
let nsErr = '';
try {
  quiet(() => runMigrations(nsDb as never, migrations));
} catch (e) {
  nsOk = false;
  nsErr = (e as Error).message;
}
check('node:sqlite: 全マイグレーション適用', nsOk, nsErr ? `ERROR: ${nsErr}` : '');
if (nsOk) {
  check(
    `node:sqlite: version == ${CURRENT_SCHEMA_VERSION}`,
    getCurrentVersion(nsDb as never) === CURRENT_SCHEMA_VERSION,
    `actual=${getCurrentVersion(nsDb as never)}`
  );
  check('node:sqlite: validateSchema()', quiet(() => validateSchema(nsDb as never)));
}

// ---------------------------------------------------------------------------
// 3. スキーマ完全一致比較
// ---------------------------------------------------------------------------
console.log('\n[3] スキーマ差分（sqlite_master 全比較）');
type SchemaRow = { type: string; name: string; tbl_name: string; sql: string | null };
const SCHEMA_SQL = `SELECT type, name, tbl_name, sql FROM sqlite_master
  WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name`;

const bsSchema = bsDb.prepare(SCHEMA_SQL).all() as SchemaRow[];
const nsSchema = nsOk ? (nsDb.prepare(SCHEMA_SQL).all() as SchemaRow[]) : [];

const norm = (rows: SchemaRow[]) =>
  rows.map((r) => `${r.type}|${r.name}|${r.tbl_name}|${(r.sql ?? '').replace(/\s+/g, ' ').trim()}`);
const bsNorm = norm(bsSchema);
const nsNorm = norm(nsSchema);

console.log(`  better-sqlite3: ${bsSchema.length} objects  (tables=${bsSchema.filter((r) => r.type === 'table').length}, indexes=${bsSchema.filter((r) => r.type === 'index').length}, triggers=${bsSchema.filter((r) => r.type === 'trigger').length})`);
console.log(`  node:sqlite   : ${nsSchema.length} objects  (tables=${nsSchema.filter((r) => r.type === 'table').length}, indexes=${nsSchema.filter((r) => r.type === 'index').length}, triggers=${nsSchema.filter((r) => r.type === 'trigger').length})`);

const onlyBs = bsNorm.filter((x) => !nsNorm.includes(x));
const onlyNs = nsNorm.filter((x) => !bsNorm.includes(x));
check('スキーマ完全一致', onlyBs.length === 0 && onlyNs.length === 0);
for (const x of onlyBs) console.log(`    better-sqlite3 のみ: ${x.slice(0, 150)}`);
for (const x of onlyNs) console.log(`    node:sqlite のみ   : ${x.slice(0, 150)}`);

// ---------------------------------------------------------------------------
// 4. 既存 DB ファイルの相互運用（前方・後方互換）
// ---------------------------------------------------------------------------
console.log('\n[4] DB ファイルの相互運用');
bsDb.close();
if (nsOk) nsDb.close();

// 4a. better-sqlite3 が作った DB を node:sqlite で読み書き（＝既存ユーザーの cm.db を開けるか）
try {
  const reopen = new BetterSqlite3CompatAdapter(bsPath);
  const v = getCurrentVersion(reopen as never);
  const tables = reopen.prepare(SCHEMA_SQL).all().length;
  reopen.exec(`CREATE TABLE _spike_write_test (x INTEGER)`);
  reopen.prepare('INSERT INTO _spike_write_test VALUES (?)').run(1);
  const readBack = reopen.prepare('SELECT x FROM _spike_write_test').get() as { x: number };
  reopen.exec('DROP TABLE _spike_write_test');
  reopen.close();
  check('前方互換: better-sqlite3 製 DB を node:sqlite で読み書き', v === CURRENT_SCHEMA_VERSION && readBack.x === 1, `version=${v}, objects=${tables}`);
} catch (e) {
  check('前方互換: better-sqlite3 製 DB を node:sqlite で読み書き', false, `ERROR: ${(e as Error).message}`);
}

// 4b. node:sqlite が作った DB を better-sqlite3 で読み書き（＝ロールバック可否）
if (nsOk) {
  try {
    const reopen = new BetterSqlite3(nsPath);
    const v = getCurrentVersion(reopen as never);
    reopen.exec(`CREATE TABLE _spike_write_test (x INTEGER)`);
    reopen.prepare('INSERT INTO _spike_write_test VALUES (?)').run(1);
    const readBack = reopen.prepare('SELECT x FROM _spike_write_test').get() as { x: number };
    reopen.exec('DROP TABLE _spike_write_test');
    const valid = quiet(() => validateSchema(reopen as never));
    reopen.close();
    check('後方互換: node:sqlite 製 DB を better-sqlite3 で読み書き（ロールバック可否）', v === CURRENT_SCHEMA_VERSION && readBack.x === 1 && valid, `version=${v}`);
  } catch (e) {
    check('後方互換: node:sqlite 製 DB を better-sqlite3 で読み書き', false, `ERROR: ${(e as Error).message}`);
  }
}

// ---------------------------------------------------------------------------
// 5. ファイルフォーマット同一性
// ---------------------------------------------------------------------------
console.log('\n[5] SQLite ライブラリバージョン');
const bsVer = new BetterSqlite3(':memory:');
console.log(`  better-sqlite3 同梱 SQLite: ${(bsVer.prepare('SELECT sqlite_version() AS v').get() as { v: string }).v}`);
bsVer.close();
const nsVer = new BetterSqlite3CompatAdapter(':memory:');
console.log(`  node:sqlite 内蔵 SQLite   : ${(nsVer.prepare('SELECT sqlite_version() AS v').get() as { v: string }).v}`);
nsVer.close();

// ---------------------------------------------------------------------------
console.log('\n' + '='.repeat(78));
console.log(failures === 0 ? 'RESULT: 全チェック PASS' : `RESULT: ${failures} 件 FAIL`);
console.log('='.repeat(78));

fs.rmSync(tmpDir, { recursive: true, force: true });
process.exit(failures === 0 ? 0 : 1);
