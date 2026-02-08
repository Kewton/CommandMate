# Issue #180 / #181 並列作業可否分析

**分析日**: 2026-02-07
**対象Issue**: #180, #181

---

## 1. Issue概要

| Issue | タイトル | 主要変更ファイル | 修正内容 |
|-------|---------|-----------------|---------|
| #180 | モバイルステータス表示の不整合 | `route.ts`, `prompt-detector.ts` | 検出優先順位変更、末尾検証追加 |
| #181 | 複数行オプションの検出失敗 | `prompt-detector.ts` | 継続行検出条件の拡張 |

---

## 2. 依存関係分析

### 2.1 共通変更ファイル

```
src/lib/prompt-detector.ts  ← 両Issue共通で変更
```

### 2.2 Issue #180のみ

```
src/app/api/worktrees/route.ts
src/app/api/worktrees/[id]/current-output/route.ts
src/lib/status-detector.ts
```

### 2.3 Issue #181のみ

```
(prompt-detector.tsのみ)
```

---

## 3. 並列作業可否判定

### 3.1 結論: **部分的に並列作業可能**

| 判定 | 理由 |
|------|------|
| **並列可能な部分** | Issue #180の`route.ts`変更とIssue #181の`prompt-detector.ts`変更は独立 |
| **並列不可な部分** | 両Issueとも`prompt-detector.ts`を変更するため、同時に修正するとコンフリクト発生 |

### 3.2 推奨アプローチ

**オプション1: シーケンシャル実行（推奨）**

```
Issue #181 → Issue #180 の順序
```

**理由**:
1. Issue #181はFalse Negative（検出漏れ）問題
2. Issue #180はFalse Positive（誤検出）問題
3. まず検出精度を上げ（#181）、その後に誤検出を減らす（#180）方が論理的
4. `prompt-detector.ts`の変更が先に安定する

**オプション2: 部分並列実行**

```
Phase 1（並列）:
  - Issue #181: prompt-detector.ts の継続行検出修正
  - Issue #180: route.ts の検出優先順位変更

Phase 2（シーケンシャル）:
  - Issue #180: prompt-detector.ts の末尾検証追加（#181マージ後）
```

---

## 4. リスク分析

### 4.1 相反するベクトル

| Issue | 方向性 | リスク |
|-------|-------|-------|
| #180 | 検出範囲を**狭める**（末尾検証） | False Negativeが増加する可能性 |
| #181 | 検出条件を**緩める**（継続行拡張） | False Positiveが増加する可能性 |

**対策**: バランステストを両Issue完了後に実施

### 4.2 コンフリクト箇所

`src/lib/prompt-detector.ts` の以下の箇所:
- Issue #181: `detectMultipleChoicePrompt()` 内の継続行検出（line 293-295付近）
- Issue #180: `detectPrompt()` の検索範囲/優先順位（新規関数追加の可能性）

---

## 5. 推奨実装順序

### Step 1: Issue #181を先に実装

```
1. prompt-detector.ts の継続行検出条件を拡張
2. 回帰テスト（Issue #161含む）を実行
3. PRマージ
```

### Step 2: Issue #180を実装

```
1. route.ts の検出優先順位を変更
2. prompt-detector.ts に末尾検証関数を追加（必要に応じて）
3. 統合テストを実行
4. PRマージ
```

### Step 3: バランステスト

```
1. False Positive / False Negative の両方をテスト
2. 実環境での動作確認
```

---

## 6. 作業見積もり

| Issue | 推定工数 | 複雑度 |
|-------|---------|-------|
| #181 | 2-4時間 | Low |
| #180 | 4-6時間 | Medium |
| バランステスト | 1-2時間 | Low |

**合計**: 7-12時間

---

## 7. 結論

1. **完全並列は非推奨**: `prompt-detector.ts`の変更がコンフリクトする
2. **推奨順序**: Issue #181 → Issue #180
3. **部分並列可能**: #180のroute.ts変更と#181のprompt-detector.ts変更は同時に着手可
4. **リスク管理**: 両Issue完了後にバランステストを実施

