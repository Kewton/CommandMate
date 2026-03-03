# Issue #408 Stage 5 レビューレポート

**レビュー日**: 2026-03-03
**フォーカス**: 通常レビュー（2回目）
**ステージ**: Stage 5（最終レビュー）

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 0 |
| Should Fix | 1 |
| Nice to Have | 2 |

## 前回指摘事項の反映確認

### Stage 1 指摘（F1-001 -- F1-008）: 全8件反映済み

| ID | 内容 | 状態 |
|----|------|------|
| F1-001 | `!thinking` 条件下でのみ二重呼び出し発生の正確な記載 | 反映済み |
| F1-002 | 他の `detectSessionStatus()` 呼び出し元とテストファイルの影響範囲追加 | 反映済み |
| F1-003 | SF-001設計根拠との関係の追記 | 反映済み |
| F1-004 | 3つの代替案（A/B/C）の比較表追加 | 反映済み |
| F1-005 | 行番号の注記追加 | 反映済み |
| F1-006 | 受入条件の具体的検証観点追加 | 反映済み |
| F1-007 | 主目的がDRY改善である旨の明記 | 反映済み |
| F1-008 | スコープ外の類似パターン言及 | 反映済み |

### Stage 3 指摘（F3-001 -- F3-011）: 全11件反映済み

| ID | 内容 | 状態 |
|----|------|------|
| F3-001 | `tests/unit/lib/status-detector.test.ts` の影響範囲追加 | 反映済み |
| F3-002 | `tests/integration/current-output-thinking.test.ts` の影響範囲追加 | 反映済み |
| F3-003 | 循環依存リスクなしの分析結果明記 | 反映済み |
| F3-004 | 前処理同一性の受入条件追加、不要import削除の実装タスク追加 | 反映済み |
| F3-005 | 実装タスクの4ステップ詳細化 | 反映済み |
| F3-006 | thinking 時の promptDetection 挙動の受入条件追加、優先順序保証の設計注記 | 反映済み |
| F3-007 | `auto-yes-manager.ts` の影響範囲追加（変更不要） | 反映済み |
| F3-008 | テスト更新タスクの4ステップ具体化 | 反映済み |
| F3-009 | APIレスポンスJSON形状の同一性確認の受入条件追加 | 反映済み |
| F3-010 | `response-poller.ts` のスコープ外言及 | 反映済み |
| F3-011 | CLAUDE.md モジュール説明更新の実装タスク追加 | 反映済み |

---

## 新規指摘事項

### Should Fix（推奨対応）

#### F5-001: 不要import削除リストに `stripAnsi` が漏れている

**カテゴリ**: 完全性
**場所**: 実装タスク「route.ts から detectPrompt() 呼び出し削除時に不要になった import」

**問題**:
案A 実装後、`current-output/route.ts` の以下のコードが全て不要になる:

```typescript
// L13 (import文の一部)
import { stripAnsi, stripBoxDrawing, buildDetectPromptOptions } from '@/lib/cli-patterns';

// L81 (変数宣言)
const cleanOutput = stripAnsi(output);

// L98-102 (promptDetection 関連)
let promptDetection = { isPrompt: false, cleanContent: cleanOutput };
if (!thinking) {
  const promptOptions = buildDetectPromptOptions(cliToolId);
  promptDetection = detectPrompt(stripBoxDrawing(cleanOutput), promptOptions);
}
```

`cleanOutput` 変数は `promptDetection` のデフォルト値（L98）と `detectPrompt()` 呼び出し（L101）の2箇所でのみ使用されている。両方が削除されるため `cleanOutput` 変数自体が不要になり、結果として `stripAnsi` のインポートも不要になる。

現在の Issue 本文では不要 import として `detectPrompt`, `buildDetectPromptOptions`, `stripBoxDrawing` の3つのみ記載されており、`stripAnsi` が漏れている。import 文 L13 は案A 後に全体が削除可能になる。

**推奨対応**:
不要import のリストに `stripAnsi` を追加し、計4つのインポート削除を明記する。あわせて `const cleanOutput = stripAnsi(output)` 変数宣言自体の削除も実装タスクに含める。

---

### Nice to Have（あれば良い）

#### F5-002: テストファイル2件の変更内容の明確化

**カテゴリ**: 完全性
**場所**: 影響範囲テーブル `src/lib/__tests__/status-detector.test.ts` 行

**問題**:
影響範囲テーブルの `src/lib/__tests__/status-detector.test.ts` の変更内容が「戻り値型変更に伴うテスト更新」のみ。テスト追加先が `tests/unit/lib/status-detector.test.ts` に集約推奨されている中、`src/lib/__tests__/` 側で具体的にどのような更新が必要か（既存テストの確認のみか、修正が必要か）が曖昧。

**推奨対応**:
変更内容を「既存テストの後方互換性確認（optional フィールド追加のため壊れない見込み。新フィールドの検証テスト追加は `tests/unit/lib/status-detector.test.ts` に集約）」のように明確化する。

---

#### F5-003: Issue #161 Layer 1 防御との関係の補足

**カテゴリ**: 明確性
**場所**: 実装タスク (b) / 設計上の注記

**問題**:
実装タスク (b) に「`!thinking` ガードは不要になることを確認」とあるが、`!thinking` ガードは Issue #161 の Layer 1 防御（thinking 中の false multiple_choice 検出防止）として意図的に設置されたもの。案A 後にこの防御が暗黙的に維持される理由（detectSessionStatus() の内部優先順序により thinking 到達時点で prompt 未検出が確定）は設計注記で説明されているが、Layer 1 防御との直接的な関係が明示されていない。

**推奨対応**:
設計注記に「Issue #161 Layer 1 の防御（thinking 中の false multiple_choice 検出防止）は detectSessionStatus() の内部優先順序（prompt -> thinking）により暗黙的に維持される」と補足する。

---

## 総合評価

Issue #408 は2回のレビューサイクル（Stage 1-4）を経て、非常に高品質な状態に仕上がっている。

**強み**:
- 概要が明確で、主目的（DRY改善）と副次的目的（パフォーマンス）が区別されている
- SF-001 設計根拠との関係が適切に文書化されている
- 3つの代替案の比較表により設計判断の根拠が明確
- 循環依存リスク分析が具体的（依存方向の一方向性を確認）
- 実装タスクが (a)-(d) のステップで詳細化されており、実装者が迷わない
- 受入条件が具体的で検証可能（8項目）
- 影響範囲テーブルが網羅的（本体3ファイル + テスト3ファイル + スコープ外2ファイル）
- 設計注記による優先順序保証の説明が技術的に正確
- レビュー履歴が全19件の反映状況とともに記録されている

**新規指摘の要約**:
- should_fix 1件（`stripAnsi` のimport削除漏れ） -- 実装時に自然に気づく可能性は高いが、実装タスクの完全性として明示すべき
- nice_to_have 2件（テストファイル変更内容の明確化、Layer 1 防御の補足） -- なくても実装に支障はないが、あると理解が深まる

## 参照ファイル

### コード
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-408/src/app/api/worktrees/[id]/current-output/route.ts`: L13 stripAnsi import、L81 cleanOutput 変数、L87-102 二重呼び出し箇所
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-408/src/lib/status-detector.ts`: L12-21 SF-001 JSDoc、L42-60 StatusDetectionResult 型、L114-153 detectSessionStatus() 内部ロジック
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-408/src/lib/prompt-detector.ts`: L54-69 PromptDetectionResult 型、L253-256 isPrompt:false 時の cleanContent 返却

### ドキュメント
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-408/CLAUDE.md`: status-detector.ts モジュール説明（SF-001 記載あり、更新対象）
