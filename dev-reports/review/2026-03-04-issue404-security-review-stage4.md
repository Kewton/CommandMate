# Stage 4: Security Review - Issue #404

**Issue**: #404 - Long-running Resource Leak Cleanup
**Stage**: 4/4 (Security Review)
**Date**: 2026-03-04
**Reviewer**: Architecture Review Agent
**Status**: Conditionally Approved

---

## Executive Summary

Issue #404 の設計方針書に対してセキュリティ観点からのレビューを実施した。設計全体はプロジェクトのセキュリティ規約に準拠しており、重大な脆弱性は検出されなかった。`execFile()` 使用によるシェルインジェクション防止、複合条件によるプロセス誤 kill 防止、同期区間によるレース条件回避など、主要なセキュリティリスクに対する設計上の対策が適切に組み込まれている。

must_fix 1 件、should_fix 3 件、nice_to_have 2 件の指摘を報告する。

---

## OWASP Top 10 Checklist

| # | Category | Status | Notes |
|---|----------|--------|-------|
| A01 | Broken Access Control | OK | プロセス kill 対象は ppid=1 + プロセス名の複合チェックで限定。Map 操作は worktreeId ベース |
| A02 | Cryptographic Failures | N/A | 本 Issue のスコープ外 |
| A03 | Injection | OK | `execFile()` 使用で shell injection 防止。DB は prepared statements 使用 |
| A04 | Insecure Design | OK（条件付き） | R4-001: deleteAutoYesState の入力バリデーション追加を推奨 |
| A05 | Security Misconfiguration | OK | globalThis タイマー二重起動防止（R3-003）設計済み |
| A06 | Vulnerable Components | N/A | 新規外部依存なし |
| A07 | Authentication Failures | N/A | 本 Issue のスコープ外 |
| A08 | Software/Data Integrity | OK | DB 操作はトランザクション使用、同期区間でレース条件回避 |
| A09 | Logging/Monitoring Failures | OK（条件付き） | R4-005: ログ出力の機密情報制御を推奨 |
| A10 | SSRF | N/A | 外部ネットワーク呼び出しなし |

---

## Detailed Findings

### R4-001 [must_fix] deleteAutoYesState() の worktreeId 入力バリデーション欠如

**Category**: globalThis
**Location**: 設計方針書 Section 3.2 / Section 3.4

**Analysis**:

設計方針書 Section 3.2 で定義されている `deleteAutoYesState(worktreeId)` は `autoYesStates.delete(worktreeId)` を直接呼び出す設計である。

```typescript
// Section 3.2 の設計
export function deleteAutoYesState(worktreeId: string): boolean {
  return autoYesStates.delete(worktreeId);
}
```

既存の `auto-yes-manager.ts` では `startAutoYesPolling()` にゲートウェイバリデーションが存在する。

```typescript
// auto-yes-manager.ts L730 (既存コード)
if (!isValidWorktreeId(worktreeId)) {
  return { started: false, reason: 'invalid worktree ID' };
}
```

しかし `deleteAutoYesState()` の呼び出し元である `cleanupWorktreeSessions()` にはバリデーションがない。現在の呼び出しチェーンでは DB 由来の worktreeId が渡されるため安全だが、defense-in-depth として入力バリデーションが必要である。

**Risk**: Medium（現時点では DB 由来のみだが、将来の呼び出し元追加時に防御が効かない）

**Suggested Fix**: `deleteAutoYesState()` の冒頭、または `cleanupWorktreeSessions()` の冒頭に `isValidWorktreeId()` チェックを追加する。

---

### R4-002 [should_fix] PID 再利用によるプロセス誤 kill リスクの軽減策が未記載

**Category**: プロセス kill
**Location**: 設計方針書 Section 3.1 / Section 4

**Analysis**:

`cleanupOrphanedMcpProcesses()` は以下のフローで孤立プロセスを kill する。

```
1. execFile('ps', [...]) で ppid=1 のプロセス一覧を取得
2. プロセス名パターン (MCP_PROCESS_PATTERNS) でフィルタ
3. process.kill(pid, 'SIGKILL') で強制終了
```

ステップ 1 と 3 の間に TOCTOU（Time-of-Check Time-of-Use）ウィンドウが存在する。この間に対象プロセスが終了し、同じ PID が別プロセスに再割り当てされる可能性がある。

**Mitigating Factors**:
- ppid=1 とプロセス名パターンの複合チェックにより、再割り当てされたプロセスが同一パターンにマッチする確率は極めて低い
- `process.kill()` は自プロセスと同一ユーザーのプロセスのみ kill 可能（OS レベルの権限チェック）
- サーバー起動時の 1 回限りの実行であり、高頻度実行ではない

**Risk**: Low（ただし設計書に明記すべき）

**Suggested Fix**: Section 4 のリスク表に TOCTOU 行を追加。実装では SIGTERM -> 短いウェイト -> SIGKILL の 2 段階方式を検討。

---

### R4-003 [should_fix] ps コマンド出力パーサーの防御的実装ガイダンス不足

**Category**: シェルインジェクション
**Location**: 設計方針書 Section 3.1

**Analysis**:

設計方針書は `execFile('ps', [...])` の使用を正しく指定しているが、ps 出力のパース実装に関する防御的ガイダンスが不足している。

具体的に以下の点が未記載:

1. **PID 値のバリデーション**: `parseInt()` の結果が `NaN`、負数、または `Number.MAX_SAFE_INTEGER` を超える値である場合のスキップ処理
2. **不正フォーマット行の処理**: ps 出力にヘッダ行や空行が含まれる場合の安全なスキップ
3. **MCP_PROCESS_PATTERNS のマッチ方式**: `includes()` による部分文字列マッチか、正規表現による境界マッチかの明記

これらは直接的なインジェクションリスクではないが、不正なデータによる `process.kill()` への意図しない PID 渡しを防止するために重要である。

**Risk**: Low

**Suggested Fix**: Section 3.1 に以下のパース実装ガイダンスを追加する。

```typescript
// PID バリデーション例
const pid = parseInt(fields[0], 10);
if (!Number.isInteger(pid) || pid <= 0) continue;
```

---

### R4-004 [should_fix] ps コマンド出力サイズの上限未設定

**Category**: DoS
**Location**: 設計方針書 Section 3.1

**Analysis**:

`execFile()` のデフォルト `maxBuffer` は 1MB（Node.js 標準）である。通常環境では十分だが、設計方針書に明示的な記載がない。プロジェクト内の既存実装を確認すると、`tmux.ts` の `capturePane()` では `maxBuffer: 10 * 1024 * 1024` を明示的に設定している前例がある。

```typescript
// tmux.ts L347 (既存コード)
maxBuffer: 10 * 1024 * 1024  // 10MB buffer for large Claude outputs
```

`cleanupOrphanedMcpProcesses()` の ps 出力は通常数 KB 以下であり、デフォルトの 1MB でも十分だが、防御的設計として明示的な設定を推奨する。

**Risk**: Low

**Suggested Fix**: `execFile('ps', [...], { maxBuffer: 5 * 1024 * 1024 })` のように明示的に設定し、設計書に記載。

---

### R4-005 [nice_to_have] OrphanCleanupResult のログ出力における機密情報制御の明記

**Category**: 情報漏洩
**Location**: 設計方針書 Section 3.1 型定義

**Analysis**:

`OrphanCleanupResult.errors` にプロセス情報を記録する際、ps の `args` カラムにはコマンドライン引数が含まれる。MCP サーバーのプロセスでは API キーやトークンがコマンドライン引数として渡される可能性があり、これがログに記録されると機密情報漏洩のリスクがある。

```typescript
interface OrphanCleanupResult {
  detected: number;
  killed: number;
  errors: string[];  // ここにプロセスのコマンドライン引数が含まれる可能性
}
```

**Risk**: Low（サーバーローカルのログのみ）

**Suggested Fix**: errors 配列には PID とプロセス名のみを記録し、コマンドライン引数全体は含めない方針を設計書に追記する。

---

### R4-006 [nice_to_have] globalThis.__resourceCleanupTimerId の型安全性強化

**Category**: globalThis
**Location**: 設計方針書 Section 3.1

**Analysis**:

globalThis はグローバルスコープであるため、理論的には他のモジュールから上書き可能である。ただし、本プロジェクトでは以下の globalThis 変数で同一パターンが確立されており、実運用上のリスクは極めて低い。

- `globalThis.__autoYesStates` (auto-yes-manager.ts)
- `globalThis.__autoYesPollerStates` (auto-yes-manager.ts)
- `globalThis.__scheduleManagerStates` (schedule-manager.ts)
- `globalThis.__scheduleActiveProcesses` (claude-executor.ts)

`__resourceCleanupTimerId` の命名もダブルアンダースコアプレフィックスの規約に従っており、衝突リスクは無視できるレベルである。

**Risk**: Negligible

**Suggested Fix**: 現行設計で十分。変数が更に増加する場合にネームスペース化を検討。

---

## Security-Specific Analysis

### 1. プロセス kill 操作のセキュリティ

| 確認項目 | 評価 | 詳細 |
|---------|------|------|
| PID の信頼性 | OK | `ps` コマンド出力から取得（OS 由来の信頼できるデータソース） |
| ppid=1 チェック | OK | init/launchd にリペアレントされた孤立プロセスのみ対象 |
| プロセス名パターン | OK | `MCP_PROCESS_PATTERNS` の as const 配列で固定値 |
| 別ユーザーのプロセス kill | OK | `process.kill()` は OS レベルで同一ユーザーのプロセスのみ操作可能 |
| TOCTOU リスク | 要改善 | R4-002 参照。設計書への明記を推奨 |

### 2. シェルインジェクション対策

| 確認項目 | 評価 | 詳細 |
|---------|------|------|
| execFile 使用 | OK | Issue #393 規約に完全準拠 |
| MCP_PROCESS_PATTERNS | OK | `as const` 定数配列、ユーザー入力を含まない |
| ps 出力パース | 要改善 | R4-003 参照。防御的パースガイダンスを推奨 |

### 3. globalThis 操作のセキュリティ

| 確認項目 | 評価 | 詳細 |
|---------|------|------|
| isValidWorktreeId 既存実装 | 確認済み | auto-yes-manager.ts L94-95, L151-154 に実装あり（`/^[a-zA-Z0-9_-]+$/`） |
| deleteAutoYesState バリデーション | 要改善 | R4-001 参照。defense-in-depth として追加を推奨 |
| cleanupOrphanedMapEntries の DB 照会 | OK | `getAllWorktrees()` は prepared statement 使用、Map 操作は同期区間（R3-004） |
| __resourceCleanupTimerId 汚染 | OK | R4-006 参照。命名規約による衝突回避で十分 |

### 4. DB 操作のセキュリティ

| 確認項目 | 評価 | 詳細 |
|---------|------|------|
| getWorktreeById SQL injection | OK | `db.prepare('SELECT ... WHERE id = ?').get(id)` のパラメータバインディング使用（db.ts L309-319） |
| getAllWorktrees SQL injection | OK | `db.prepare('SELECT id, path FROM worktrees').all()` のパラメータなしクエリ（schedule-manager.ts L190） |
| stopScheduleForWorktree の DB lookup | OK | 内部で `getWorktreeById()` を使用する設計、prepared statements 保証 |
| batchUpsertSchedules の IN 句 | OK | SEC4-002 に明記済み、`?` プレースホルダのみを動的生成 |

### 5. 情報漏洩

| 確認項目 | 評価 | 詳細 |
|---------|------|------|
| OrphanCleanupResult のログ | 要改善 | R4-005 参照。プロセス引数のマスキング推奨 |
| エラーメッセージのスタックトレース | OK | 既存パターンでは `error instanceof Error ? error.message : String(error)` で message のみ出力 |
| DB lookup 失敗時のログ | OK | R3-002 設計で `console.warn` ログ出力のみ、DB 内容は漏洩しない |

### 6. DoS 耐性

| 確認項目 | 評価 | 詳細 |
|---------|------|------|
| ps 出力サイズ | 要改善 | R4-004 参照。maxBuffer の明示的設定を推奨 |
| 24 時間タイマー二重起動 | OK | R3-003 設計済み。`globalThis.__resourceCleanupTimerId` の存在チェックで防止 |
| Map エントリ上限 | OK | autoYesStates/autoYesPollerStates は MAX_CONCURRENT_POLLERS=50 で間接的に制限 |
| 3 秒 graceful shutdown 制約 | OK | `stopResourceCleanup()` は `clearInterval()` のみで即時完了 |

---

## Risk Assessment

| Risk Category | Level | Description |
|--------------|-------|-------------|
| Technical Risk | Low | 設計は既存パターンに準拠しており、実装リスクは低い |
| Security Risk | Low | 重大な脆弱性は検出されず。defense-in-depth の改善余地あり |
| Operational Risk | Low | サーバー起動時の 1 回実行 + 24 時間定期実行。システム安定性への影響は最小限 |

---

## Conclusion

Issue #404 の設計方針書はセキュリティ面で適切な設計判断がなされている。`execFile()` によるシェルインジェクション防止、ppid + プロセス名の複合チェックによる誤 kill 防止、better-sqlite3 の prepared statements による SQL インジェクション防止、同期区間によるレース条件回避など、プロジェクトのセキュリティ規約に準拠した堅実な設計である。

must_fix の R4-001（deleteAutoYesState の入力バリデーション）を対応した上で実装に進むことを推奨する。should_fix の 3 件は実装時に併せて対応することが望ましい。

**Status**: Conditionally Approved（R4-001 の対応を条件として承認）
