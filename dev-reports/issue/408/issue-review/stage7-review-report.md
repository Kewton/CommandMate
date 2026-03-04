# Issue #408 レビューレポート - Stage 7

**レビュー日**: 2026-03-03
**フォーカス**: 影響範囲レビュー（2回目）
**ステージ**: 7（最終影響範囲レビュー）

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 0 |
| Should Fix | 1 |
| Nice to Have | 2 |

**総合評価**: good

Stage 3 の影響範囲指摘 11 件（F3-001 -- F3-011）および Stage 5 の通常レビュー指摘 3 件（F5-001 -- F5-003）の全 14 件が適切に反映されていることを確認した。3 回のレビュー+反映サイクルを経て、Issue は十分な品質に到達している。

---

## 前回指摘の反映確認

### Stage 3 影響範囲指摘（F3-001 -- F3-011）: 全 11 件反映済み

| ID | 概要 | 状態 |
|----|------|------|
| F3-001 | tests/unit/lib/status-detector.test.ts 追加 | 反映済み |
| F3-002 | tests/integration/current-output-thinking.test.ts 追加 | 反映済み |
| F3-003 | 循環依存リスクなしの明記 | 反映済み |
| F3-004 | stripAnsi/stripBoxDrawing 前処理同一性の受入条件追加 | 反映済み |
| F3-005 | 呼び出し元更新タスクの 4 ステップ詳細化 | 反映済み |
| F3-006 | thinking 状態時の promptDetection 挙動と優先順序保証 | 反映済み |
| F3-007 | auto-yes-manager.ts の「変更不要」記載 | 反映済み |
| F3-008 | テスト更新タスクの 4 ステップ具体化 | 反映済み |
| F3-009 | API レスポンス JSON 形状の同一性受入条件 | 反映済み |
| F3-010 | response-poller.ts のスコープ外記載 | 反映済み |
| F3-011 | CLAUDE.md モジュール説明更新の実装タスク追加 | 反映済み |

### Stage 5 通常レビュー指摘（F5-001 -- F5-003）: 全 3 件反映済み

| ID | 概要 | 状態 |
|----|------|------|
| F5-001 | stripAnsi を不要 import 削除リストに追加（計 4 件） | 反映済み |
| F5-002 | __tests__/status-detector.test.ts の変更内容明確化 | 反映済み |
| F5-003 | Issue #161 Layer 1 との関係補足 | 反映済み |

---

## 新規指摘事項

### Should Fix（推奨対応）

#### F7-001: prompt-response/route.ts が影響範囲テーブルおよびスコープ外セクションに未記載

**カテゴリ**: 影響範囲
**場所**: 影響範囲テーブル / スコープ外セクション

**問題**:
`src/app/api/worktrees/[id]/prompt-response/route.ts` が影響範囲テーブルにもスコープ外セクションにも記載されていない。このファイルは current-output/route.ts と同一パターンの呼び出しを行っている。

```typescript
// prompt-response/route.ts L13-14
import { detectPrompt, type PromptDetectionResult } from '@/lib/prompt-detector';
import { stripAnsi, stripBoxDrawing, buildDetectPromptOptions } from '@/lib/cli-patterns';

// prompt-response/route.ts L96-99
const currentOutput = await captureSessionOutput(params.id, cliToolId, 5000);
const cleanOutput = stripAnsi(currentOutput);
const promptOptions = buildDetectPromptOptions(cliToolId);
promptCheck = detectPrompt(stripBoxDrawing(cleanOutput), promptOptions);
```

ただし、このファイルの `detectPrompt()` 呼び出しは current-output/route.ts の二重呼び出しとは設計意図が異なる。prompt-response/route.ts の呼び出しは **race condition 防止のための re-verification**（L90-93 コメント: 「Re-verify that a prompt is still active before sending keys」）であり、`detectSessionStatus()` を使用していない独立パスである。

明示的にスコープ外として記載すべき理由:
1. 実装者が「detectPrompt の外部呼び出しを全て削除する」と誤解して prompt-response/route.ts まで変更するリスクの防止
2. auto-yes-manager.ts, response-poller.ts と同じく、将来の適用候補として記録する価値がある

**推奨対応**:
スコープ外セクションに以下を追加する:
> `prompt-response/route.ts` は `detectPrompt()` を独立して使用しており（race condition 防止のための re-verification 目的）、`detectSessionStatus()` を使用していないため本 Issue のスコープ外。current-output/route.ts の二重呼び出しとは設計意図が異なる。

---

### Nice to Have（あれば良い）

#### F7-002: src/lib/__tests__/status-detector.test.ts のマッピング契約テスト注記

**カテゴリ**: テスト
**場所**: 影響範囲テーブル src/lib/__tests__/status-detector.test.ts 行

**問題**:
`src/lib/__tests__/status-detector.test.ts` L329 には StatusDetectionResult のマッピング契約テスト（status フィールドと isWaitingForResponse/isProcessing フラグの対応検証）がある。案A 後は route.ts が `statusResult.promptDetection` も参照するようになるが、この契約変更の検証テストは tests/unit/ に集約する方針（F3-008 反映済み）に沿えば `__tests__/` 側への追加は不要。現在の記載（「既存テストの後方互換性確認」）で実用上は十分だが、L329 のマッピングテストが更新不要である旨を明示すると、より明確になる。

**推奨対応**:
既存の記載で実用上は十分。追記する場合は「L329 の StatusDetectionResult マッピング契約テストは status フィールドのみ検証しており、promptDetection の契約テストは tests/unit/lib/status-detector.test.ts に集約」と補足する。

---

#### F7-003: detectSessionStatus() の 9 箇所の return パスへの promptDetection 追加に関する注記

**カテゴリ**: 影響範囲
**場所**: 実装タスク「detectSessionStatus() 内部で detectPrompt() の結果を戻り値に含める」

**問題**:
現在の `detectSessionStatus()` には 9 箇所の return 文がある:

| # | 行 | 条件 | promptDetection の期待値 |
|---|-----|------|-------------------------|
| 1 | L147-152 | prompt detected | `{ isPrompt: true, promptData: ..., cleanContent: ... }` |
| 2 | L159-163 | thinking indicator | `{ isPrompt: false, cleanContent: ... }` |
| 3 | L178-182 | opencode processing | `{ isPrompt: false, cleanContent: ... }` |
| 4 | L213-217 | opencode content thinking | `{ isPrompt: false, cleanContent: ... }` |
| 5 | L225-230 | opencode response complete | `{ isPrompt: false, cleanContent: ... }` |
| 6 | L239-244 | input prompt | `{ isPrompt: false, cleanContent: ... }` |
| 7 | L252-258 | time-based heuristic | `{ isPrompt: false, cleanContent: ... }` |
| 8 | L263-268 | default | `{ isPrompt: false, cleanContent: ... }` |

`promptDetection` は optional フィールドのため、追加し忘れた return パスがあっても TypeScript の型エラーにはならず `undefined` になる。テスト (b)（「未検出時に isPrompt:false であること」）が defense-in-depth として機能するが、実装タスクに return パスの数を注記しておくと実装者にとって有用。

**推奨対応**:
実装タスクに「detectSessionStatus() 内の全 return パス（9 箇所）に promptDetection フィールドを追加。L145 の detectPrompt() 結果は L146 の条件分岐より前に計算されるため、全 return パスで参照可能」と補足する。

---

## 影響範囲の総合評価

### 網羅性

| カテゴリ | 記載状況 |
|---------|---------|
| 主要変更ファイル（2件） | 全て記載済み |
| 型互換性確認対象（2件） | 全て記載済み |
| テストファイル（3件） | 全て記載済み |
| スコープ外モジュール（2件 + 1件未記載） | auto-yes-manager.ts, response-poller.ts 記載済み。prompt-response/route.ts 未記載（F7-001） |
| CLAUDE.md 更新 | 記載済み |

### 破壊的変更

なし。`StatusDetectionResult` への `promptDetection?: PromptDetectionResult` はオプショナルフィールド追加であり、既存の 3 箇所の呼び出し元（worktrees/route.ts, worktrees/[id]/route.ts, current-output/route.ts）に対して後方互換。テストファイル 3 件も既存テストが壊れない。

### 依存関係

循環依存リスクなし（status-detector -> prompt-detector の一方向依存、Issue 本文に明記済み）。新たな外部ライブラリ依存もなし。

### テスト戦略

十分。テスト更新タスクが 4 ステップ（後方互換確認、promptDetection 検証、hasActivePrompt 一致性、テスト追加先集約）に具体化されており、受入条件に API レスポンス形状の同一性確認も含まれている。

---

## 参照ファイル

### コード
- `src/app/api/worktrees/[id]/prompt-response/route.ts` L13-14, L94-99: detectPrompt 独立呼び出し（スコープ外、F7-001）
- `src/lib/status-detector.ts` L114-269: 9 箇所の return 文（F7-003）
- `src/lib/__tests__/status-detector.test.ts` L329-367: マッピング契約テスト（F7-002）
- `src/app/api/worktrees/[id]/current-output/route.ts` L9, L13, L81, L87-102: 主要変更対象
- `src/lib/prompt-detector.ts` L54-69: PromptDetectionResult 型定義

### ドキュメント
- `CLAUDE.md`: status-detector.ts モジュール説明（SF-001 更新対象）
