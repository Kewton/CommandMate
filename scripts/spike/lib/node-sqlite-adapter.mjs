/**
 * Spike lib: better-sqlite3 互換アダプタ（node:sqlite の DatabaseSync をラップ）(Issue #1201)
 *
 * 何のためのコードか:
 *   移行方式 (b)「ドライバ抽象化レイヤを挟んだ段階移行」が実際に成立するかを検証するための
 *   実物のアダプタ。CommandMate が使用している better-sqlite3 API のみを実装する:
 *     Database: prepare / exec / transaction / pragma / close / name / open
 *     Statement: get / all / run
 *
 *   本番コードには一切手を入れずに、既存の runMigrations() などへそのまま渡せることを狙う。
 *   これが動けば「抽象化レイヤ方式は現実的」の実証になり、動かなければギャップの証拠になる。
 *
 * 非目標:
 *   iterate / pluck / raw / bind / safeIntegers / backup / serialize は CommandMate 未使用のため未実装。
 *
 * 使用側: scripts/spike/02-migrations.mjs, scripts/spike/03-bench.mjs
 */

import { DatabaseSync } from 'node:sqlite';

/**
 * node:sqlite の StatementSync を better-sqlite3 の Statement 風に見せる。
 */
class StatementAdapter {
  #stmt;
  #sql;

  constructor(stmt, sql) {
    this.#stmt = stmt;
    this.#sql = sql;
  }

  get source() {
    return this.#sql;
  }

  #normalizeArgs(args) {
    // better-sqlite3 は run(a, b, c) と run([a,b,c]) と run({named}) を受ける。
    // node:sqlite も可変長を受けるが、boolean を bind できない点が異なるため変換する。
    return args.map((a) => {
      if (typeof a === 'boolean') return a ? 1 : 0;
      if (a === undefined) return null;
      return a;
    });
  }

  run(...args) {
    return this.#stmt.run(...this.#normalizeArgs(args));
  }

  get(...args) {
    const row = this.#stmt.get(...this.#normalizeArgs(args));
    return row === undefined ? undefined : toPlainObject(row);
  }

  all(...args) {
    return this.#stmt.all(...this.#normalizeArgs(args)).map(toPlainObject);
  }
}

/**
 * node:sqlite は null-prototype のオブジェクトを返す。
 * better-sqlite3 は Object.prototype 由来の通常オブジェクトを返すため、
 * スプレッド・hasOwnProperty・vitest の toEqual 互換のために変換する。
 */
function toPlainObject(row) {
  if (row === null || row === undefined) return row;
  return Object.assign({}, row);
}

/**
 * better-sqlite3 の Database 互換アダプタ。
 */
export class BetterSqlite3CompatAdapter {
  #db;
  #path;
  /** 入れ子トランザクションの深さ。0 なら BEGIN、1 以上なら SAVEPOINT を使う。 */
  #txDepth = 0;

  constructor(filename, _options) {
    this.#db = new DatabaseSync(filename);
    this.#path = filename;
  }

  get name() {
    return this.#path;
  }

  get open() {
    return this.#db.isOpen ?? true;
  }

  prepare(sql) {
    return new StatementAdapter(this.#db.prepare(sql), sql);
  }

  exec(sql) {
    this.#db.exec(sql);
    return this;
  }

  /**
   * better-sqlite3 の db.transaction(fn) 互換。
   * - 呼ぶと「トランザクション化された関数」を返す（即時実行しない）
   * - 例外時に自動 ROLLBACK
   * - 入れ子は SAVEPOINT で吸収（better-sqlite3 と同じ戦略）
   */
  transaction(fn) {
    const self = this;
    const wrapped = function (...args) {
      const depth = self.#txDepth;
      const savepoint = `_cm_sp_${depth}`;

      if (depth === 0) self.#db.exec('BEGIN');
      else self.#db.exec(`SAVEPOINT ${savepoint}`);
      self.#txDepth = depth + 1;

      try {
        const out = fn.apply(this, args);
        if (depth === 0) self.#db.exec('COMMIT');
        else self.#db.exec(`RELEASE ${savepoint}`);
        return out;
      } catch (e) {
        if (depth === 0) {
          self.#db.exec('ROLLBACK');
        } else {
          self.#db.exec(`ROLLBACK TO ${savepoint}`);
          self.#db.exec(`RELEASE ${savepoint}`);
        }
        throw e;
      } finally {
        self.#txDepth = depth;
      }
    };

    // better-sqlite3 のバリアント（CommandMate 未使用だが API 形状を合わせる）
    wrapped.deferred = wrapped;
    wrapped.immediate = wrapped;
    wrapped.exclusive = wrapped;
    return wrapped;
  }

  /**
   * better-sqlite3 の db.pragma(str, opts) 互換。
   * better-sqlite3 は結果を配列で返す（simple:true ならスカラ）。
   */
  pragma(source, options = {}) {
    const sql = `PRAGMA ${source}`;
    // 代入形（"foreign_keys = ON"）は結果を返さないので exec、参照形は prepare で読む。
    const isAssignment = /=/.test(source);
    if (isAssignment) {
      this.#db.exec(sql);
      return options.simple ? undefined : [];
    }
    const rows = this.#db.prepare(sql).all().map(toPlainObject);
    if (options.simple) {
      const first = rows[0];
      return first ? first[Object.keys(first)[0]] : undefined;
    }
    return rows;
  }

  close() {
    this.#db.close();
    return this;
  }
}

export default BetterSqlite3CompatAdapter;
