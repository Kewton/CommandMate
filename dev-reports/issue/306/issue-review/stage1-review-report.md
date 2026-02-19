# Issue #306 Stage 1 レビューレポート

**レビュー日**: 2026-02-18
**フォーカス**: 通常レビュー（整合性・正確性・完全性・明確性・テスト可能性）
**ステージ**: 1回目
**仮説検証結果**: 全5件 Confirmed（Issue記載内容の技術的正確性は高い）

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 3 |
| Should Fix | 6 |
| Nice to Have | 3 |
| **合計** | **12** |

**総合評価**: **High**

Issue全体の技術的正確性は高く、仮説検証で全項目がConfirmed。根本原因の分析は実コードと正確に一致している。ただし、対策案のコード例と実際のコード構造の整合性、および偽陽性防止の網羅性に改善が必要。

---

## Must Fix（必須対応）

### MF-001: 対策1の案Aに endsWith 判定の論理的欠陥がある

**カテゴリ**: 正確性
**場所**: ## 対策案 > 対策1: SHELL_PROMPT_ENDINGSの判定ロジック改善

**問題**:
Issue記載の対策1案Aは `trimmed.split('\n').pop()?.trim()` で最終行を取得し、`endsWith(ending)` を再チェックしている。しかし現行コード（`claude-session.ts:280,288`）では `cleanOutput.trim()` の結果全体の末尾文字をチェックしている。

案Aのコード例は「全体末尾→最終行末尾」への暗黙的な変更を含んでおり、この変更自体が持つ意味が明確に記述されていない。修正案コード例を現行コードのコンテキストに合わせて更新すべき。

**証拠**:
```typescript
// claude-session.ts:280 - 現行コード
const trimmed = cleanOutput.trim();
// claude-session.ts:288 - trimmed全体の末尾をチェック
if (SHELL_PROMPT_ENDINGS.some(ending => trimmed.endsWith(ending))) {
```

Issue案Aでは `trimmed.split('\n').pop()?.trim()` で最終行に変更しているが、この変更が意味する「全体末尾から最終行末尾への判定変更」が明記されていない。

**推奨対応**:
案Aのコード例を現行コードの構造に合致させ、かつ「最終行による判定への変更」が意図的であることを明記する。

---

### MF-002: SHELL_PROMPT_ENDINGS の `$` も偽陽性リスクがあるが対策に含まれていない

**カテゴリ**: 完全性
**場所**: ## 対策案 > 対策1

**問題**:
Issueは `%` の偽陽性のみを対策しているが、`$` にも同様のリスクがある。Claude CLIのレスポンスにはコード例中のシェル変数（`$HOME`）や金額表示（`100$`）が含まれうる。`#` もMarkdownの見出しやコメントで出力末尾に来る可能性がある。

対策1で `%` のみを除外するのではなく、全てのSHELL_PROMPT_ENDINGS文字について偽陽性のリスク分析と対策を記載すべき。

**証拠**:
- `claude-session.ts:58`: `SHELL_PROMPT_ENDINGS = ['$', '%', '#']`
- `claude-session.ts:50-56` のC-S2-002コメントで偽陽性リスクを「acceptable」と評価していたが、Issue #306で `%` の偽陽性が顕在化した

**推奨対応**:
対策1を拡張し、3文字全てに対する偽陽性防止戦略を記載する。案Bの「最終行が短い（例: 40文字以下）」を全文字共通の防御として採用し、案Aの個別パターン除外と組み合わせる「多段防御」を推奨。

---

### MF-003: 対策2のpromptKey生成ロジックにリセット条件が欠如

**カテゴリ**: 完全性
**場所**: ## 対策案 > 対策2: サーバー側Auto-Yes Pollerに重複応答防止を追加

**問題**:
Issue記載の重複防止用`lastAnsweredPromptKey`にリセットタイミングの記述がない。同一プロンプトが正規に再表示された場合（例: Claude CLIが応答処理後に同じ質問を再表示）に、応答がブロックされてしまう。

クライアント側（`useAutoYes.ts:60-62`）では `isPromptWaiting` が false になった時にリセットしているが、サーバー側の対応するリセットロジックが記載されていない。

**証拠**:
```typescript
// useAutoYes.ts:60-62 - クライアント側にはリセットがある
if (!isPromptWaiting) {
  lastAutoRespondedRef.current = null;
  return;
}
```

Issue記載の対策2コード例にはリセットロジックがなく、pollAutoYes()のL321-325（プロンプト非検出時）での `lastAnsweredPromptKey = null` リセットが必要。

**推奨対応**:
プロンプト非検出時のリセットロジックを対策2のコード例に追加し、クライアント側との対称性を明記する。

---

## Should Fix（推奨対応）

### SF-001: 対策4のログ出力がisSessionHealthy()の構造と不整合

**カテゴリ**: 整合性
**場所**: ## 対策案 > 対策4

`ensureHealthySession()` は `isSessionHealthy()` の bool 結果しか受け取らないため、不健全の「理由」をログに出力するには戻り値の拡張か、`isSessionHealthy()` 内部でのログ出力が必要。Issue記載の実装タスク最後の項目（「isSessionHealthy()に不健全判定理由の構造化ログを追加」）との整合性を取るべき。

**推奨対応**: isSessionHealthy()の戻り値を `{ healthy: boolean; reason?: string }` に拡張するアプローチを対策4のコード例に反映する。

---

### SF-002: 対策5のクールダウンと対策2の重複防止の役割関係が不明確

**カテゴリ**: 完全性
**場所**: ## 対策案 > 対策5 / 対策2

対策2（promptKey比較）と対策5（応答後クールダウン）は共に重複送信防止が目的。両方実装した場合の動作関係が明確でない。

**推奨対応**: 対策2を「論理的重複防止（主防御）」、対策5を「タイミング制御（副防御：Claude CLIの処理時間確保）」と位置付け、役割の違いを明記する。

---

### SF-003: 受入条件「30分以上のセッション安定性」が自動テスト不可能

**カテゴリ**: テスト可能性
**場所**: ## 受入条件

CI/CDで30分の実行時間を持つテストは非現実的。

**推奨対応**: ユニットテスト可能な条件に分解する（例:「1000回のポーリングサイクルで重複応答なし」「promptKey不変時に応答1回のみ」など）。手動検証項目は別セクションに分離。

---

### SF-004: 影響範囲にprompt-answer-sender.tsとcli-session.tsが含まれていない

**カテゴリ**: 完全性
**場所**: ## 影響範囲 > 関連コンポーネント

`src/lib/prompt-answer-sender.ts`（sendPromptAnswer関数）と`src/lib/cli-session.ts`（captureSessionOutput関数）がauto-yes-manager.tsからインポートされており、テストでの検証対象となる。

**推奨対応**: 関連コンポーネントに追加する。

---

### SF-005: 「原因4」が概要の「3つの原因」と不整合

**カテゴリ**: 明確性
**場所**: ## 概要 / ## 根本原因 > 原因4

概要では「3つの原因」と記載されているが、根本原因セクションには「原因4: ヘルスチェックのkill時ログ不足」が存在する。原因4はデバッグ困難性であり、セッション削除の直接原因ではない。

**推奨対応**: 原因4を根本原因から分離し、「付帯的な改善点」として別セクションに移動する。

---

### SF-006: テストファイルのパスが不正確

**カテゴリ**: テスト可能性
**場所**: ## 影響範囲 > 変更対象ファイル

| Issue記載パス | 正しいパス |
|--------------|-----------|
| `tests/unit/claude-session.test.ts` | `tests/unit/lib/claude-session.test.ts` |
| `tests/unit/auto-yes-manager.test.ts` | `tests/unit/lib/auto-yes-manager.test.ts` |

**推奨対応**: パスを修正する。

---

## Nice to Have（あれば良い）

### NTH-001: 対策3のコンテキスト枯渇検出パターンの正規表現が未記載

cli-patterns.tsに追加する具体的な正規表現パターン（例: `/Context left until auto-compact:\s*(\d+)%/`）を記載すると実装者に親切。

---

### NTH-002: Issueタイトルが原因1のみを反映

タイトル「fix: Auto-Yes Pollerの重複応答によりtmuxセッションが定期的に削除される」は原因1のみを反映。3つの原因を包括するタイトルへの変更、またはIssue分割を検討。

---

### NTH-003: パターンB・Cの再現手順に前提条件が不足

`/pm-auto-issue2dev` コマンドの概要説明や、コンテキスト残量低下の目安（操作時間）が記載されていない。

---

## 参照ファイル

### コード

| ファイル | 関連箇所 | 関連性 |
|---------|----------|--------|
| `src/lib/claude-session.ts` | L58, L262-296, L306-313 | SHELL_PROMPT_ENDINGS定義、isSessionHealthy()、ensureHealthySession() |
| `src/lib/auto-yes-manager.ts` | L31-42, L274-369 | AutoYesPollerState型定義、pollAutoYes() |
| `src/lib/cli-patterns.ts` | 全体 | コンテキスト残量検出パターン追加候補 |
| `src/hooks/useAutoYes.ts` | L60-62, L68-78 | クライアント側重複防止の参照実装 |
| `src/lib/prompt-answer-sender.ts` | 全体 | sendPromptAnswer()（影響範囲漏れ候補） |
| `tests/unit/lib/claude-session.test.ts` | 全体 | 既存テスト（正しいパス） |
| `tests/unit/lib/auto-yes-manager.test.ts` | 全体 | 既存テスト（正しいパス） |

### ドキュメント

| ファイル | 関連性 |
|---------|--------|
| `CLAUDE.md` | プロジェクト構成・モジュール一覧との整合性確認 |
