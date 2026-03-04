# Issue #406 仮説検証レポート

## 検証日時
- 2026-03-04

## 検証結果サマリー

| # | 仮説/主張 | 判定 | 根拠 |
|---|----------|------|------|
| 1 | `cmate-parser.ts` L84-85 で `realpathSync()` が同期I/Oとして呼ばれている | Confirmed | src/lib/cmate-parser.ts L84-85で確認済み |
| 2 | この関数はスケジュールマネージャの60秒ポーリングループから呼ばれる | Confirmed | syncSchedules() → readCmateFile() → validateCmatePath() の呼び出し連鎖を確認 |
| 3 | worktree数が多い場合、同期I/Oの累積でイベントループがブロックされる | Partially Confirmed | realpathSync()以外にreadFileSync()/statSync()も存在するが、Issueでは未言及 |

## 詳細検証

### 仮説 1: `cmate-parser.ts` L84-85 で `realpathSync()` が同期I/Oとして呼ばれている

**Issue内の記述**: 「`cmate-parser.ts` (L84-85) で`realpathSync()`が同期I/Oとして呼ばれている」

**検証手順**:
1. `src/lib/cmate-parser.ts` の L80-98 を確認

**判定**: Confirmed

**根拠**:
```typescript
// src/lib/cmate-parser.ts L80-98
export function validateCmatePath(
  filePath: string,
  worktreeDir: string
): boolean {
  const realFilePath = realpathSync(filePath);    // L84: 同期I/O確認
  const realWorktreeDir = realpathSync(worktreeDir); // L85: 同期I/O確認
  ...
}
```
import文でも `import { readFileSync, realpathSync } from 'fs';` (L15) で同期版を使用していることを確認。

---

### 仮説 2: この関数はスケジュールマネージャの60秒ポーリングループから呼ばれる

**Issue内の記述**: 「この関数はスケジュールマネージャの60秒ポーリングループ（`schedule-manager.ts` L363-442）から呼ばれる」

**検証手順**:
1. `src/lib/schedule-manager.ts` の呼び出しチェーンを確認
2. `syncSchedules()` → `readCmateFile()` → `validateCmatePath()` の連鎖を確認

**判定**: Confirmed（ただしIssueの行番号は現在のコードと若干ずれている可能性あり）

**根拠**:
- `schedule-manager.ts` の `syncSchedules()` 関数（L478-591）で `readCmateFile(worktree.path)` を呼び出し (L516)
- `readCmateFile()` (cmate-parser.ts L311-329) が内部で `validateCmatePath()` を呼び出し (L316)
- `syncSchedules()` は `setInterval(() => { syncSchedules(); }, POLL_INTERVAL_MS)` (L620-622) で60秒ごとに実行

---

### 仮説 3: 同期I/Oの累積でイベントループがブロックされる（特にworktree数が多い場合）

**Issue内の記述**: 「worktree数が多い場合、同期I/Oの累積でイベントループがブロックされ、他のAPIリクエストのレイテンシが増加」

**検証手順**:
1. `syncSchedules()` 全体の同期I/O箇所を確認
2. Issueが言及していない同期I/Oの存在を確認

**判定**: Partially Confirmed

**根拠（Confirmed部分）**:
- `validateCmatePath()` の `realpathSync()` × 2回（Issue言及済み）
- `readCmateFile()` 内の `readFileSync(filePath, 'utf-8')` (L317) もブロッキングI/O（Issue **未言及**）
- `getCmateMtime()` 内の `statSync(filePath).mtimeMs` (L163) もブロッキングI/O（Issue **未言及**）

**根拠（重要な補足）**:
Issue の実装タスクは `validateCmatePath()` と `realpathSync()` のみに絞られているが、
実際には同一呼び出しパス上に `readFileSync` と `statSync` も存在する。
Issue の受入条件「`validateCmatePath()` 内に同期ファイルI/Oが残っていないこと」は満たせるが、
`readCmateFile()` 内の `readFileSync()` や `getCmateMtime()` の `statSync()` は対象外となっており、
イベントループブロックの根本解消としては不十分な可能性がある。

---

## Stage 1レビューへの申し送り事項

1. **Issueのスコープが部分的である可能性**: `validateCmatePath()` の `realpathSync()` のみが対象だが、同じ呼び出しパス上に `readFileSync()` (readCmateFile内) と `statSync()` (getCmateMtime内) も存在する。Issueの受入条件をより明確にするか、スコープの明示が必要。

2. **`readCmateFile()` も非同期化が必要**: `validateCmatePath()` を async にした場合、`readCmateFile()` も async にする必要があり、`readFileSync()` も `fs.promises.readFile()` への変換が自然な流れとなる。

3. **`getCmateMtime()` の `statSync()` について**: mtime キャッシュによりほとんどのケースで `readCmateFile()` の呼び出し自体がスキップされるため、`getCmateMtime()` のブロッキングは相対的に軽微だが、言及する価値がある。

4. **テストの更新スコープ**: `validateCmatePath()` が async になると、テストも `await` を使う形に変更が必要（`tests/unit/lib/cmate-parser.test.ts` 参照）。
