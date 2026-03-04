# Issue #408 Stage 1 レビューレポート

**レビュー日**: 2026-03-03
**フォーカス**: 通常レビュー（Consistency & Correctness）
**イテレーション**: 1回目

---

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 0 |
| Should Fix | 5 |
| Nice to Have | 3 |

**総合評価**: Fair

Issue の本質的な課題認識（`detectPrompt()` の二重呼び出し）は正確であり、提案方向性も妥当である。しかし、以下の4点が主要な改善点として挙げられる:

1. `!thinking` 条件下でのみ二重呼び出しが発生するという重要な詳細が欠落
2. 既存の SF-001 設計根拠への言及がなく、意図的な DRY 違反を覆す文脈が不明瞭
3. 他の `detectSessionStatus()` 呼び出し元への影響範囲が未記載
4. SRP への影響を踏まえた解決策の比較検討が不足

---

## Should Fix（推奨対応）

### F1-001: `!thinking` 条件の記載欠落

**カテゴリ**: 正確性
**場所**: 背景・課題 セクション

**問題**:
Issue本文は「同一出力に対してregexパターンマッチングが2回実行される」と無条件に記載しているが、実際には `current-output/route.ts` L99 の `if (!thinking)` ガードにより、二重呼び出しは `thinking === false` の場合のみ発生する。`thinking === true` の場合は `detectPrompt()` は `detectSessionStatus()` 内部の1回のみである。

**証拠**:
```typescript
// current-output/route.ts L98-102
let promptDetection = { isPrompt: false, cleanContent: cleanOutput };
if (!thinking) {  // <-- この条件により thinking 時はスキップ
  const promptOptions = buildDetectPromptOptions(cliToolId);
  promptDetection = detectPrompt(stripBoxDrawing(cleanOutput), promptOptions);
}
```

**推奨対応**:
「thinking状態でない場合（通常動作時の大部分）、同一出力に対してregexパターンマッチングが2回実行される。thinking状態の場合は route.ts の `!thinking` ガードにより1回のみ」と修正する。

---

### F1-002: 他の `detectSessionStatus()` 呼び出し元が影響範囲に未記載

**カテゴリ**: 完全性
**場所**: 影響範囲 セクション

**問題**:
`detectSessionStatus()` は3箇所で呼び出されているが、影響範囲テーブルには `current-output/route.ts` と `status-detector.ts` の2ファイルしか記載されていない。`StatusDetectionResult` の型を変更する場合、以下の呼び出し元にも影響が及ぶ:

| ファイル | 行 | 使用フィールド |
|---------|-----|---------------|
| `src/app/api/worktrees/route.ts` | L58 | `status`, `hasActivePrompt` |
| `src/app/api/worktrees/[id]/route.ts` | L68 | `status`, `hasActivePrompt` |
| `tests/unit/lib/status-detector.test.ts` | 全体 | 戻り値型の検証 |
| `tests/integration/current-output-thinking.test.ts` | 全体 | 結合テスト |

**推奨対応**:
影響範囲テーブルにこれらのファイルを追加する。新フィールドがオプショナルであれば破壊的変更にはならないが、型互換性の確認は必要である。

---

### F1-003: SF-001 設計根拠との関係が未言及

**カテゴリ**: 整合性
**場所**: 背景・課題 / 提案する解決策 セクション

**問題**:
`status-detector.ts` の冒頭JSDoc (L12-21) に、この二重呼び出しが **意図的な設計判断** として文書化されている:

```
// Architecture note (SF-001 tradeoff):
// This controlled DRY violation is accepted because:
//   - StatusDetectionResult maintains SRP (status + confidence, not prompt details)
//   - Exposing promptData would couple status detection to prompt data shape changes
//   - detectPrompt() is lightweight (regex-based, no I/O), so the cost is negligible
```

また `current-output/route.ts` L90-94 にも SF-001 コメントが記載されている。Issue の提案はこの設計判断を覆すものであり、その文脈が明記されるべきである。

**推奨対応**:
背景・課題に「現在この二重呼び出しは SF-001 として意図的な DRY 違反と文書化されている」と追記し、実装タスクに「SF-001 コメントの更新」を追加する。

---

### F1-004: SRP への影響を踏まえた解決策の比較検討が不足

**カテゴリ**: 完全性
**場所**: 提案する解決策 セクション

**問題**:
「`detectSessionStatus()` の戻り値にプロンプト検出結果を含める」という単一の解決策のみが提示されているが、これは SF-001 が明示的に回避しようとした SRP 違反（ステータス検出モジュールがプロンプトデータ形状に結合）を発生させる。代替案の検討が必要である。

**推奨対応**:
以下の選択肢を比較検討した上で推奨案を明記する:
- **案A**: `StatusDetectionResult` にオプショナルな `promptDetection?: PromptDetectionResult` を追加（SRP緩和を許容、最小変更）
- **案B**: `detectSessionStatusWithPromptData()` を新設（SRP維持、関数増加）
- **案C**: `current-output/route.ts` 側でキャッシュ等を導入（status-detector 変更なし）

---

### F1-006: 受入条件の検証方法が不明確

**カテゴリ**: 完全性
**場所**: 受入条件 セクション

**問題**:
「既存のUI動作に影響がないこと」という受入条件があるが、何をもって「影響がない」と判定するかが不明確。`promptData` は API レスポンスとしてクライアントに返され、`MobilePromptSheet` 等の UI 表示に使用されている。

**推奨対応**:
以下のような具体的な検証条件を追加する:
- `promptData` のレスポンス構造が変更前後で同一であること
- `isPromptWaiting` の判定結果が変更前後で同一であること
- `thinking` フラグの判定結果が変更前後で同一であること

---

## Nice to Have（あれば良い）

### F1-005: 行番号の脆弱性

**カテゴリ**: 正確性
**場所**: 背景・課題 セクション

**問題**:
L87, L100-101 という行番号はコード変更によりずれる可能性が高い。仮説検証でも「行番号は若干ずれあり」と指摘されている。

**推奨対応**:
コードスニペットやコメントマーカー（SF-001, DR-001 等）で該当箇所を特定する記法に変更するか、「おおよその行番号」と注記する。

---

### F1-007: パフォーマンス改善の定量的根拠が不足

**カテゴリ**: 完全性
**場所**: 概要 / 背景・課題 セクション

**問題**:
既存の SF-001 コメントに `detectPrompt() is lightweight (regex-based, no I/O), so the cost is negligible` と明記されており、パフォーマンスインパクトは元々小さいと認識されていた。本 Issue の主な価値がコード明瞭性・DRY 改善にあるのかパフォーマンスにあるのかを明確にすべきである。

**推奨対応**:
改善の主目的（DRY 原則の遵守 / コードの明瞭性向上 / パフォーマンス改善）を明示する。

---

### F1-008: 類似パターン（auto-yes-manager.ts）への言及

**カテゴリ**: 完全性
**場所**: 実装タスク セクション

**問題**:
`auto-yes-manager.ts` の `detectAndRespondToPrompt()` (L585) にも同様の `detectPrompt()` 独立呼び出しパターンが存在する。スコープ外であっても類似パターンとして言及があると実装者の理解を助ける。

**推奨対応**:
「スコープ外の類似パターン」として注記する。

---

## 参照ファイル

### コード
| ファイル | 関連性 |
|---------|--------|
| `src/app/api/worktrees/[id]/current-output/route.ts` | 二重呼び出しの発生箇所（L87, L98-102） |
| `src/lib/status-detector.ts` | SF-001 設計根拠JSDoc（L12-21）、`StatusDetectionResult` 型定義（L42-60）、内部 `detectPrompt()` 呼び出し（L145） |
| `src/app/api/worktrees/route.ts` | `detectSessionStatus()` 呼び出し元（L58、`hasActivePrompt` のみ使用） |
| `src/app/api/worktrees/[id]/route.ts` | `detectSessionStatus()` 呼び出し元（L68、`hasActivePrompt` のみ使用） |
| `src/lib/prompt-detector.ts` | `PromptDetectionResult` 型定義（L54-69）、`detectPrompt()` 関数（L184） |
| `src/lib/auto-yes-manager.ts` | 類似パターン: `detectAndRespondToPrompt()` 内の独立した `detectPrompt()` 呼び出し（L585） |

### テスト
| ファイル | 関連性 |
|---------|--------|
| `src/lib/__tests__/status-detector.test.ts` | `detectSessionStatus()` のユニットテスト |
| `tests/integration/current-output-thinking.test.ts` | thinking/prompt 検出の結合テスト |

### ドキュメント
| ファイル | 関連性 |
|---------|--------|
| `CLAUDE.md` | `status-detector.ts` / `prompt-detector.ts` / `current-output/route.ts` のモジュール説明（SF-001記載あり） |
