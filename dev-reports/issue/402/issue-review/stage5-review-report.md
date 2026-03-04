# Issue #402 レビューレポート（Stage 5）

**レビュー日**: 2026-03-03
**フォーカス**: 通常レビュー（2回目）
**ステージ**: Stage 5 / 6

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 0 |
| Should Fix | 0 |
| Nice to Have | 3 |

**総合評価**: good

4段階のレビュー・反映サイクル（Stage 1: 通常レビュー -> Stage 2: 反映 -> Stage 3: 影響範囲レビュー -> Stage 4: 反映）を経て、Issue #402の記載品質は十分な水準に達している。Must FixおよびShould Fixの指摘事項はゼロであり、残る3件はいずれもNice to Haveレベルの補足情報である。

---

## 前回指摘の対応確認

### Stage 1 指摘事項（全9件 -> 全件反映済み）

| ID | 重要度 | 対応状況 | 検証結果 |
|----|--------|---------|---------|
| MF-001 | must_fix | 反映済み | 「2秒間隔（POLLING_INTERVAL = 2000ms）」に修正。`response-poller.ts` L54、`auto-yes-manager.ts` L69と整合。 |
| MF-002 | must_fix | 反映済み | 呼び出しパターンに基づく具体的記述に変更。「最大6回/ポーリングサイクル」は呼び出し元内訳と合致。 |
| SF-001 | should_fix | 反映済み | 実装場所が `prompt-detector.ts` 内 `detectPrompt()` に明確化。推奨理由3点記載。 |
| SF-002 | should_fix | 反映済み | 実装タスクにlogger.debug/infoのテスト確認を追加。注記も追加。 |
| SF-003 | should_fix | 反映済み | 受入条件がテスト可能な形式に改善。75%は参考目標として維持。 |
| SF-004 | should_fix | 反映済み | 影響範囲表が全呼び出し元を網羅。 |
| SF-005 | should_fix | 反映済み | キャッシュ3方式（A/B/C）の比較テーブル追加。 |
| NTH-001 | nice_to_have | 反映済み | SF-001トレードオフの注記追加。 |
| NTH-002 | nice_to_have | 反映済み | ログ抑制戦略のトレードオフ記載。 |

### Stage 3 指摘事項（主要6件反映済み / 4件はNice to Haveとしてスキップ）

| ID | 重要度 | 対応状況 | 検証結果 |
|----|--------|---------|---------|
| IR-001 | should_fix | 反映済み | `prompt-response/route.ts` が影響範囲表に追加。 |
| IR-002 | should_fix | 反映済み | `response-poller.ts` の呼び出し回数が具体化。 |
| IR-003 | should_fix | 反映済み | テスト間キャッシュリセット（`resetDetectPromptCache()`）の設計が実装タスクに追加。 |
| IR-005 | must_fix | 反映済み | キャッシュヒット時の戻り値同一性が受入条件に追加。 |
| IR-006 | should_fix | 反映済み | `CLAUDE.md` が影響範囲表に追加。 |
| IR-008 | should_fix | 反映済み | SF-001キャッシュ自然抑制の注記が追加。 |
| IR-004 | should_fix | 未反映 | ハッシュ対象の最適化。実装時の判断として許容。 |
| IR-007 | nice_to_have | 未反映 | メモリリーク防止設計。実装時の判断として許容。 |
| IR-009 | nice_to_have | 未反映 | loggerモックのテスト戦略。実装時の判断として許容。 |
| IR-010 | nice_to_have | 未反映 | 抑制対象ログ箇所の優先順位。実装時の判断として許容。 |

---

## 整合性チェック

### セクション間の整合性

| チェック項目 | 結果 | 詳細 |
|------------|------|------|
| 概要 vs 背景・課題 | 整合 | 「最大6回のdetectPrompt呼び出し」が背景の呼び出し元内訳（3+1+2=6）と合致。 |
| 解決策 vs 実装タスク | 整合 | キャッシュ方式3選択肢が実装タスクの「キャッシュ方式の選定含む」に対応。 |
| 実装タスク vs 受入条件 | 整合 | 全タスク項目が受入条件でカバーされている。 |
| 受入条件 vs 影響範囲 | 整合 | テスト対象と影響ファイルが対応。 |
| 影響範囲の網羅性 | 十分 | 全detectPrompt呼び出し元 + CLAUDE.md更新が網羅。 |

### 技術的正確性

| チェック項目 | 結果 | 証拠 |
|------------|------|------|
| ポーリング間隔 | 正確 | `response-poller.ts` L54: `POLLING_INTERVAL = 2000`、`auto-yes-manager.ts` L69: `POLLING_INTERVAL_MS = 2000` |
| 呼び出し箇所数 | 正確 | response-poller 3箇所、auto-yes-manager 1箇所、status-detector 1箇所、current-output 2箇所、prompt-response 1箇所 |
| ログレベル設定 | 正確 | `env.ts` L160: development=debug、production=info |
| detectPromptシグネチャ | 正確 | worktreeIdパラメータなし（`output: string, options?: DetectPromptOptions`） |

---

## Nice to Have（補足的な改善提案）

### S5-NTH-001: current-output/route.tsの直接呼び出しは条件付き

**カテゴリ**: 正確性の補足
**場所**: 背景・課題セクション

**問題**:
`current-output/route.ts` の直接 `detectPrompt()` 呼び出し（L101）は `if (!thinking)` ガード内にあり、thinking状態の場合は `detectSessionStatus()` 経由の1回のみとなる。Issue本文の「detectSessionStatus()経由1回 + 直接1回」は、thinking=false時の最大値である。

**推奨対応**:
実質的な影響は小さいため、必須の修正ではない。ログ量が問題になるのは主にidle/ready状態（thinking=false）であり、thinking状態ではログ頻度自体が低い。

**証拠**:
`src/app/api/worktrees/[id]/current-output/route.ts` L98-102:
```typescript
if (!thinking) {
  const promptOptions = buildDetectPromptOptions(cliToolId);
  promptDetection = detectPrompt(stripBoxDrawing(cleanOutput), promptOptions);
}
```

---

### S5-NTH-002: 抑制対象ログの主体はdebugレベル

**カテゴリ**: 正確性の補足
**場所**: 提案する解決策 - ログ抑制戦略

**問題**:
`prompt-detector.ts` 内のlogger呼び出し3箇所のうち、ログ量の大半を占めるのはdebugレベル（L171 `detectPrompt:start`、L216 `detectPrompt:complete`）である。`logger.info`（L185 `detectPrompt:multipleChoice`）はmultiple_choice検出時のみ出力されるため頻度が低い。yes/noプロンプト検出パス（L196-212）にはlogger.info呼び出しが存在しない。

**推奨対応**:
実装時の参考情報として有用だが、Issue本文への修正は必須ではない。実装者が `prompt-detector.ts` のコードを確認すれば自明である。

**証拠**:
- `src/lib/prompt-detector.ts` L171: `logger.debug('detectPrompt:start', ...)` -- 全呼び出しで出力
- `src/lib/prompt-detector.ts` L185-189: `logger.info('detectPrompt:multipleChoice', ...)` -- multiple_choice検出時のみ
- `src/lib/prompt-detector.ts` L216: `logger.debug('detectPrompt:complete', ...)` -- プロンプト未検出時のみ

---

### S5-NTH-003: 方式(A)のワークツリー間誤抑制リスクの補足

**カテゴリ**: 完全性
**場所**: キャッシュ設計方針

**問題**:
方式(A)の「異なるワークツリーの同一出力が相互に抑制される（実害小）」について、実際にはdetectPrompt()の呼び出し元でstripAnsi()やstripBoxDrawing()が適用されたcleanOutputが渡され、さらにワークツリーごとにパス表示やセッション名が異なるため、同一outputになる確率は極めて低い。

**推奨対応**:
特段の修正は不要。現在の記載で十分であり、方式(A)の「実害小」の判断は妥当。

---

## 参照ファイル

### コード
- `src/lib/prompt-detector.ts`: 主要変更対象。logger呼び出し3箇所（L171, L185-189, L216）
- `src/lib/response-poller.ts`: detectPromptWithOptions()経由で3箇所（L779, L953, L1088）
- `src/app/api/worktrees/[id]/current-output/route.ts`: detectSessionStatus()経由 + 直接呼び出し（thinkingガード付き）
- `src/lib/auto-yes-manager.ts`: detectAndRespondToPrompt() L585
- `src/lib/status-detector.ts`: detectSessionStatus() L145
- `src/app/api/worktrees/[id]/prompt-response/route.ts`: L99で直接呼び出し

### ドキュメント
- `CLAUDE.md`: prompt-detector.tsモジュール説明の更新対象
