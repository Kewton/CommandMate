# Issue #180 Stage 1: Content Review (通常レビュー)

**Review Date**: 2026-02-07
**Focus Area**: 通常レビュー（Consistency & Correctness）
**Iteration**: 1

---

## Summary

| Category | Count |
|----------|-------|
| Must Fix | 1 |
| Should Fix | 3 |
| Nice to Have | 2 |

---

## Must Fix (必須対応)

### MF-1: 修正案のコード不完全 - 具体的な実装が省略されている

**Category**: 完全性
**Location**: `## 修正案` section

**Issue**:
修正案において「改善案」のコメントは方向性を示しているが、実際の実装コードが不完全である。具体的なアルゴリズムやロジックが「コード省略」として抜けている。

**Evidence**:
```typescript
// 改善案
// 1. まず最後2-3行で入力プロンプト(❯)をチェック → ready
// 2. 次に最後2-3行でインタラクティブプロンプトをチェック → waiting
// 3. 最後に最後2-3行でthinkingをチェック → running
// 4. いずれにも該当しない場合のみ → processing
```
上記のコメントのみで具体的な実装が示されていない。

**Recommendation**:
修正案に具体的な実装コードを追記するか、または設計書へのリンクを追加して詳細実装を別途定義すること。

---

## Should Fix (推奨対応)

### SF-1: 根本原因の問題3が実装と矛盾している

**Category**: 正確性
**Location**: `### 問題3: thinking検出の範囲が広すぎる` section

**Issue**:
Issueでは「detectThinking()が最後15行を検索」と記載されているが、実際のコード（`src/app/api/worktrees/route.ts`）では`detectThinking()`呼び出し前に非空行をフィルタリングし、最後15行を取得している。問題の記載と実装の関係が正確でない。

**Evidence**:
```typescript
// 実際のroute.ts (line 67-71)
const nonEmptyLines = cleanOutput.split('\n').filter(line => line.trim() !== '');
const lastLines = nonEmptyLines.slice(-15).join('\n');
if (detectThinking(cliToolId, lastLines)) {
  isProcessing = true;
}
```

ここで重要なのは「空行をフィルタしてから」15行を取得している点。これにより、実質的には視覚的に見える最後の出力部分よりも広い範囲を検索している可能性がある。

**Recommendation**:
「最後15行（空行除く）」と正確に記載するか、または「空行フィルタリング後」という点を明示すること。

---

### SF-2: detectPromptの検索範囲の記載が不正確

**Category**: 正確性
**Location**: `### 問題1: 過去のプロンプト誤検出` section

**Issue**:
「detectPrompt()が最後10-50行を検索」と記載されているが、実装では:
- yes/noパターン: 最後10行（`lines.slice(-10)`）
- 複数選択パターン: 最後50行（`scanStart = lines.length - 50`）

と異なる範囲を使い分けている。「10-50行」という表現は曖昧で誤解を招く。

**Evidence**:
```typescript
// prompt-detector.ts (line 47-48)
const lastLines = lines.slice(-10).join('\n');

// prompt-detector.ts (line 237)
const scanStart = Math.max(0, lines.length - 50);
```

**Recommendation**:
「yes/noプロンプトは最後10行、複数選択プロンプトは最後50行を検索」と正確に記載すること。

---

### SF-3: 受け入れ条件が未定義

**Category**: 受け入れ条件
**Location**: Issue全体

**Issue**:
問題の説明と修正案はあるが、この修正が完了した際の具体的な受け入れ条件が定義されていない。テストシナリオや検証方法が不明確。

**Recommendation**:
以下のような受け入れ条件を追加すること:
- AC1: `❯`プロンプトのみが最終行に表示されている場合、ステータスが「ready」（緑）になること
- AC2: `(y/n)`プロンプトが最終行に表示されている場合のみ、ステータスが「waiting」（黄）になること
- AC3: thinking indicator（`✻ Processing...`）が最終行に表示されている場合のみ、ステータスが「running」（青スピナー）になること
- AC4: 過去のプロンプトパターンがスクロールバックに存在しても、最終行の状態が正しく検出されること

---

## Nice to Have (あれば良い)

### NTH-1: デスクトップでの動作確認の記載

**Category**: 完全性
**Location**: `## 再現手順` section

**Issue**:
問題はモバイル表示時に発生すると記載されているが、デスクトップ表示でも同様の問題が発生するかどうかの情報がない。同じAPIロジックを使用しているため、デスクトップでも発生する可能性が高い。

**Recommendation**:
デスクトップでの動作確認結果を追記し、問題がモバイル固有なのか、または表示コンポーネントに依存しない根本的な問題なのかを明確にすること。

---

### NTH-2: 関連Issueのリンク補足

**Category**: 完全性
**Location**: `## 関連` section

**Issue**:
Issue #4とIssue #31への言及があるが、Issue #161（複数選択プロンプトの誤検出問題）も関連性が高い。prompt-detector.tsには「Issue #161」への参照が複数存在し、同様のパターン誤検出問題に対処している。

**Evidence**:
```typescript
// prompt-detector.ts (line 218-219)
 * Uses a 2-pass detection approach (Issue #161):
```

**Recommendation**:
関連Issueに `#161` を追加すること。

---

## Code References

| File | Relevance |
|------|-----------|
| `src/app/api/worktrees/route.ts` | ステータス検出のメインロジック（修正対象） |
| `src/lib/prompt-detector.ts` | プロンプト検出関数（修正対象） |
| `src/lib/cli-patterns.ts` | CLIツール別パターン定義（参照） |
| `src/types/sidebar.ts` | deriveCliStatus関数（ステータス変換） |

## Document References

| File | Relevance |
|------|-----------|
| `docs/features/sidebar-status-indicator.md` | ステータス検出仕様ドキュメント |
| `CLAUDE.md` | プロジェクト構成・モジュール説明 |

---

## Technical Analysis

### 現在の検出優先順位（問題あり）

```
1. detectPrompt() → isWaitingForResponse = true
2. detectThinking() → isProcessing = true
3. promptPattern.test() → (false の場合) isProcessing = true
4. 上記全てfalse → ready
```

### 提案されている検出優先順位

```
1. 最後2-3行で入力プロンプト(❯)をチェック → ready
2. 最後2-3行でインタラクティブプロンプト → waiting
3. 最後2-3行でthinking → running
4. いずれにも該当しない → processing
```

### 問題の核心

現在のロジックは「過去のパターン」も検出対象に含めてしまうため、スクロールバックに残った古いプロンプトを「現在アクティブ」と誤認識する。

**解決の方向性**:
検索範囲を「最終行付近」に限定することで、現在のターミナル状態を正確に反映する。

---

## Conclusion

Issue #180は問題の特定と根本原因の分析が概ね正確であり、修正の方向性も妥当である。ただし、修正案の具体的な実装コードが不足しており、受け入れ条件も未定義である。これらを補完することで、実装者が正確に対応できるようになる。
