# Issue #408 レビューレポート（Stage 3: 影響範囲レビュー 1回目）

**レビュー日**: 2026-03-03
**フォーカス**: 影響範囲レビュー
**ステージ**: 3（影響範囲レビュー 1回目）

---

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 2 |
| Should Fix | 7 |
| Nice to Have | 2 |

**総合評価**: fair

Issue #408 の影響範囲は限定的であり、循環依存リスクもない。しかし、(1) 前処理の同一性保証、(2) thinking/prompt 優先順序の整合性明確化、(3) テストファイルの影響範囲記載 の3点が主要な改善対象である。

---

## Must Fix（必須対応）

### F3-004: stripAnsi()/stripBoxDrawing() 前処理の同一性確認が受入条件に欠落

**カテゴリ**: 影響範囲
**場所**: 受入条件セクション / 実装タスクセクション

**問題**:

`detectSessionStatus()` 内部の `detectPrompt()` 呼び出しと、`current-output/route.ts` の独自 `detectPrompt()` 呼び出しでは、入力前処理パイプラインが独立して実装されている。

`status-detector.ts` (L120, L145):
```typescript
const cleanOutput = stripAnsi(output);       // L120
const promptDetection = detectPrompt(stripBoxDrawing(cleanOutput), promptOptions);  // L145
```

`current-output/route.ts` (L81, L101):
```typescript
const cleanOutput = stripAnsi(output);       // L81
promptDetection = detectPrompt(stripBoxDrawing(cleanOutput), promptOptions);        // L101
```

現在は同一結果を生成するが、案A実装時に `detectSessionStatus()` から返された `promptDetection` を route.ts で直接使用する場合、route.ts 側の独自前処理が不要になる。この統一の確認が受入条件に記載されていない。

**推奨対応**:

受け入れ条件に「detectSessionStatus() 内部の stripAnsi() + stripBoxDrawing() 前処理と、route.ts が独自に行っていた前処理が同一結果を生成すること」を追加する。実装タスクに「route.ts から detectPrompt() 呼び出しを削除する際、同時に不要になった import（detectPrompt, buildDetectPromptOptions, stripBoxDrawing）のクリーンアップ」を追加する。

---

### F3-006: thinking 状態時の promptDetection フィールド挙動が未整理

**カテゴリ**: 破壊的変更
**場所**: 受入条件セクション / 実装タスクセクション

**問題**:

`detectSessionStatus()` の優先順序は以下の通り:
1. Interactive prompt 検出 (L134-153) -- 最高優先
2. Thinking indicator 検出 (L155-164)
3. Input prompt 検出 (L236-245)
4. Time-based heuristic (L249-259)
5. Default (L263-268)

この優先順序により、thinking に到達した時点で prompt は必ず未検出（`promptDetection.isPrompt === false`）が確定している。案A で `promptDetection` フィールドを追加した場合:

- prompt 検出時: `{status: 'waiting', hasActivePrompt: true, promptDetection: {isPrompt: true, promptData: {...}}}`
- thinking 検出時: `{status: 'running', hasActivePrompt: false, promptDetection: {isPrompt: false, cleanContent: ...}}`

現在の route.ts は `!thinking` ガード（L99）で thinking 時の `detectPrompt()` 呼び出しをスキップしているが、案A 後は `detectSessionStatus()` 内部で既にプロンプト検出が完了しているため、このガードは不要になる。この設計保証が Issue 本文で明確化されていない。

**推奨対応**:

受入条件に「thinking 状態時に promptDetection フィールドは `{isPrompt: false, cleanContent: ...}` を含み、promptData は undefined であること」を追加する。detectSessionStatus() の優先順序（prompt -> thinking）により thinking 到達時点で prompt 未検出が確定している設計保証を、実装タスクの注記として記載する。

---

## Should Fix（推奨対応）

### F3-001: tests/unit/lib/status-detector.test.ts が影響範囲テーブルに未記載

**カテゴリ**: 影響範囲
**場所**: 影響範囲テーブル

20件以上のテストケースが `detectSessionStatus()` の戻り値フィールドを検証している。optional フィールド追加のため既存テストは壊れないが、新フィールドの検証テスト追加が必要。

**推奨対応**: 影響範囲テーブルに追加（変更内容: `promptDetection` フィールドの存在検証・`hasActivePrompt` との一致性テスト追加）。

---

### F3-002: tests/integration/current-output-thinking.test.ts が影響範囲テーブルに未記載

**カテゴリ**: 影響範囲
**場所**: 影響範囲テーブル

SF-001 コメントを直接参照する結合テスト（L98: `SF-001 (S3)`）。SF-001 設計根拠が更新されるため、テスト内コメントも更新が必要。

**推奨対応**: 影響範囲テーブルに追加。

---

### F3-003: 循環依存リスク分析が Issue 本文に未記載

**カテゴリ**: 依存関係
**場所**: 提案する解決策セクション

現在の依存方向は一方向: `status-detector.ts` -> `prompt-detector.ts`（L24）。`prompt-detector.ts` は `status-detector.ts` をインポートしていない。`PromptDetectionResult` 型の追加インポートも同一方向のため、循環依存は発生しない。

**推奨対応**: 循環依存リスクなしの分析結果を Issue 本文に明記する。

---

### F3-005: route.ts の promptDetection ローカル変数と !thinking ガードの取り扱い

**カテゴリ**: 影響範囲
**場所**: 実装タスク「呼び出し元の戻り値利用を更新」

`current-output/route.ts` L98 の明示的型注釈付き変数と L99 の `!thinking` ガードは、案A 実装後に不要になる。実装タスクの詳細化が必要。

**推奨対応**: 実装タスクを詳細化:
- (a) L98 の promptDetection ローカル変数を削除し `statusResult.promptDetection` を直接参照
- (b) L99 の `!thinking` ガード不要化の確認
- (c) L133 の promptData 参照更新
- (d) 不要 import 文の削除

---

### F3-007: auto-yes-manager.ts のスコープ外明示

**カテゴリ**: 影響範囲
**場所**: 影響範囲テーブル

`auto-yes-manager.ts` の `detectAndRespondToPrompt()` は `detectPrompt()` を独立して呼び出しており、`detectSessionStatus()` を使用していない独立パス。直接影響はないが、類似パターンとしてスコープ外であることを明示すべき。

**推奨対応**: 影響範囲テーブルに「変更不要（独立パス）」として追加。

---

### F3-008: テスト更新方針の具体化

**カテゴリ**: テスト
**場所**: 実装タスク「ユニットテスト・結合テストの更新」

2つのユニットテストファイル（`src/lib/__tests__/status-detector.test.ts` と `tests/unit/lib/status-detector.test.ts`）が存在し、テスト追加先の方針が不明確。

**推奨対応**: `tests/unit/lib/status-detector.test.ts` への集約を推奨（Issue #188 以降の新規テストパターンに統一）。追加テスト項目: (a) promptDetection フィールド存在確認、(b) promptData 構造検証、(c) hasActivePrompt との一致性。

---

### F3-009: API レスポンス形状の保全が受入条件に未記載

**カテゴリ**: 影響範囲
**場所**: 受入条件セクション

current-output/route.ts のレスポンス JSON（`promptData`、`isPromptWaiting`、`thinking` 等）の形状保全が受入条件に明示されていない。

**推奨対応**: 受入条件に「API レスポンスの JSON 形状が変更前後で同一であること」を追加。統合テストまたはスナップショットテストによる検証を推奨。

---

## Nice to Have（あれば良い）

### F3-010: response-poller.ts のスコープ外注記

**カテゴリ**: 影響範囲

`response-poller.ts` は `PromptDetectionResult` 型を使用するが `detectSessionStatus()` を使用していない。スコープ外であることの注記があると将来の参考になる。

---

### F3-011: CLAUDE.md モジュール説明の更新

**カテゴリ**: その他

SF-001 JSDoc 更新に伴い、CLAUDE.md の `status-detector.ts` 説明も整合性のため更新が望ましい。

---

## 影響範囲マトリクス

### 直接影響ファイル（変更が必要）

| ファイル | 変更内容 | 破壊的変更 |
|---------|---------|-----------|
| `src/lib/status-detector.ts` | `StatusDetectionResult` に `promptDetection?: PromptDetectionResult` 追加、SF-001 JSDoc 更新 | なし（optional フィールド） |
| `src/app/api/worktrees/[id]/current-output/route.ts` | 二重 `detectPrompt()` 呼び出し削除、不要 import 削除、promptData 参照更新 | なし（API レスポンス形状不変） |
| `tests/unit/lib/status-detector.test.ts` | promptDetection フィールド検証テスト追加 | なし |
| `src/lib/__tests__/status-detector.test.ts` | 影響確認（既存テスト後方互換） | なし |
| `tests/integration/current-output-thinking.test.ts` | SF-001 コメント更新 | なし |

### 間接影響ファイル（変更不要だが型互換性確認）

| ファイル | 確認内容 | 影響リスク |
|---------|---------|-----------|
| `src/app/api/worktrees/route.ts` | `StatusDetectionResult` 型変更の後方互換性（`hasActivePrompt` のみ使用） | LOW |
| `src/app/api/worktrees/[id]/route.ts` | 同上 | LOW |

### スコープ外ファイル（今回の変更対象外）

| ファイル | 理由 |
|---------|------|
| `src/lib/auto-yes-manager.ts` | `detectSessionStatus()` を使用していない独立パス |
| `src/lib/response-poller.ts` | `detectSessionStatus()` を使用していない独立パス |
| `src/lib/prompt-detector.ts` | 型定義の提供元（変更不要、`PromptDetectionResult` は既存） |

### 依存関係グラフ

```
status-detector.ts ──import──> prompt-detector.ts     (既存)
status-detector.ts ──import──> cli-patterns.ts         (既存)
status-detector.ts ──import──> cli-tools/types.ts      (既存)

current-output/route.ts ──import──> status-detector.ts  (既存)
current-output/route.ts ──import──> prompt-detector.ts  (削除対象)
current-output/route.ts ──import──> cli-patterns.ts     (一部削除候補)

worktrees/route.ts ──import──> status-detector.ts       (既存、変更なし)
worktrees/[id]/route.ts ──import──> status-detector.ts  (既存、変更なし)
```

**循環依存**: なし。`prompt-detector.ts` は `status-detector.ts` をインポートしていない。

---

## 参照ファイル

### コード
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-408/src/lib/status-detector.ts`: StatusDetectionResult 型定義、detectSessionStatus() 内部優先順序
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-408/src/app/api/worktrees/[id]/current-output/route.ts`: 二重呼び出し発生箇所、API レスポンス構築
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-408/src/lib/prompt-detector.ts`: PromptDetectionResult 型定義
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-408/src/app/api/worktrees/route.ts`: detectSessionStatus() 呼び出し元（hasActivePrompt のみ使用）
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-408/src/app/api/worktrees/[id]/route.ts`: 同上
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-408/tests/unit/lib/status-detector.test.ts`: Issue #188 ユニットテスト
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-408/src/lib/__tests__/status-detector.test.ts`: Issue #54 初期テスト
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-408/tests/integration/current-output-thinking.test.ts`: SF-001 結合テスト
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-408/src/lib/auto-yes-manager.ts`: スコープ外の類似パターン
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-408/src/lib/response-poller.ts`: スコープ外（PromptDetectionResult 使用）

### ドキュメント
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-408/CLAUDE.md`: モジュール説明
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-408/dev-reports/design/issue-180-status-display-inconsistency-design-policy.md`: DR-002 設計根拠
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-408/dev-reports/design/issue-188-thinking-indicator-false-detection-design-policy.md`: SF-001 トレードオフ設計根拠
