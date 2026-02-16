# Issue #287 レビューレポート

**レビュー日**: 2026-02-15
**フォーカス**: 通常レビュー（Consistency & Correctness）
**イテレーション**: 1回目（Stage 1）

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 1 |
| Should Fix | 4 |
| Nice to Have | 3 |

**総評**: Issue #287の原因分析は正確であり（仮説検証で全4仮説がConfirmed済み）、処理フロー図や「期待される動作 vs 実際の動作」の対比も正確である。しかし、修正方針案が不完全であり、実装者が具体的な設計判断を行うための情報が不足している。また、受け入れ条件が記載されておらず、再現手順もpromptCheck再検証失敗の具体的条件を明示していない。

---

## Must Fix（必須対応）

### MF-1: 修正方針案が不完全 -- promptCheck=null時のフォールバック方式が具体的に定義されていない

**カテゴリ**: 完全性
**場所**: ## 修正方針案 セクション

**問題**:
修正方針案が抽象的であり、実装者が具体的な設計判断を行うための情報が不足している。特に、`promptCheck` が `null` の場合にカーソルキー方式を適用するための具体的な条件分岐と、UI側から送信すべき追加データの設計が明記されていない。

**証拠**:
現在のIssueの記載:
> ただし、デフォルト選択肢の番号が不明なため、UI側から `defaultOption` 情報もリクエストに含める設計変更が必要になる可能性がある。

これは「可能性がある」という曖昧な表現であり、修正方針の核心部分が未定義である。

実際のコードを確認すると:

- `WorktreeDetailRefactored.tsx:1130-1133` の `handlePromptRespond` は `{ answer, cliTool: activeCliTab }` のみを送信
- `PromptResponseRequest` インターフェース（`route.ts:17-20`）は `answer` と `cliTool?` のみ定義
- UIコンポーネント（`MobilePromptSheet.tsx`, `PromptPanel.tsx`）は `promptData` を保持しており、`selectedOption` と `promptData.options` にアクセス可能

**推奨対応**:
以下の2つのアプローチを明示的に比較し、採用方針を決定すべき:

**(A) API側フォールバック方式**: `promptCheck=null` かつ `cliToolId='claude'` かつ `answer` が数値の場合、カーソルキー方式を仮定して `sendSpecialKeys` を使用。`defaultOption` 不明のため offset=0（デフォルト選択）として Enter のみ送信。
- メリット: UI側の変更不要
- デメリット: promptType が不明なため誤送信リスク（Yes/No プロンプトに対してカーソルキーを送る可能性）、非デフォルト選択肢への対応が不可能

**(B) UI側データ送信方式**: `handlePromptRespond` で `promptData` の `type` と `defaultOption` 情報をリクエストボディに含め、API側でその情報を利用。
- メリット: 正確な判定が可能、全選択肢に対応可能
- デメリット: `PromptResponseRequest` 型の変更、UI側3箇所（`WorktreeDetailRefactored.tsx`, `MobilePromptSheet.tsx`, `PromptPanel.tsx`）の修正が必要

---

## Should Fix（推奨対応）

### SF-1: 再現手順でpromptCheck再検証が失敗する条件が明示されていない

**カテゴリ**: 明確性
**場所**: ## 再現手順 セクション

**問題**:
現在の再現手順は「選択肢を選んで送信すると認識されない」としか書かれておらず、この問題が常時発生するのか、特定条件下でのみ発生するのかが不明である。

**証拠**:
`route.ts:73` の `captureSessionOutput(params.id, cliToolId, 5000)` は5000msタイムアウトで呼び出されている。この関数が例外をスローする条件として以下が考えられるが、Issue本文では言及されていない:
- tmuxセッションが見つからない（セッション名の不一致）
- キャプチャのタイムアウト（5秒以内に完了しない）
- tmuxプロセス自体のエラー

**推奨対応**:
再現手順に「captureSessionOutput が例外をスローする条件」を追記するか、スクリーンショットで示されている具体的な環境情報（モバイルからのアクセス時に発生しやすい等）を補足すべき。

---

### SF-2: 受け入れ条件が記載されていない

**カテゴリ**: 完全性
**場所**: Issue本文全体

**問題**:
受け入れ条件セクションが存在せず、修正完了の判定基準が不明確である。

**推奨対応**:
以下のような受け入れ条件を追加すべき:
1. `promptCheck` 再検証が失敗した場合でも、Claude Codeの複数選択肢プロンプトにカーソルキー方式で正しく応答できること
2. Yes/No プロンプトの既存動作に影響がないこと
3. Codex の既存動作に影響がないこと
4. 既存テスト（`prompt-response-verification.test.ts`）が引き続きパスすること（または適切に更新されること）
5. 新規テストケース: `promptCheck=null` + Claude + 数値回答 の場合にカーソルキー方式が使用されること

---

### SF-3: 関連ファイルリストに src/lib/cli-session.ts が欠落している

**カテゴリ**: 完全性
**場所**: ## 関連ファイル セクション

**問題**:
`captureSessionOutput` の実装元である `src/lib/cli-session.ts` が関連ファイルリストに含まれていない。

**証拠**:
```typescript
// src/app/api/worktrees/[id]/prompt-response/route.ts:13
import { captureSessionOutput } from '@/lib/cli-session';

// route.ts:74
const currentOutput = await captureSessionOutput(params.id, cliToolId, 5000);
```

この関数の例外発生パターンを把握することが修正方針の検討に不可欠である。

**推奨対応**:
`src/lib/cli-session.ts` を関連ファイルに追加する。

---

### SF-4: 修正方針案で2つのアプローチの比較・選定基準が示されていない

**カテゴリ**: 技術的妥当性
**場所**: ## 修正方針案 セクション

**問題**:
修正方針案にフォールバック追加のアプローチとUI側からの情報送信アプローチの2つが暗黙的に示唆されているが、トレードオフの分析がない。

**証拠**:
Issue本文では以下の2点が記載されている:
1. > `promptCheck` が `null`（再検証失敗）の場合でも、以下の条件を満たせばカーソルキー方式で送信するフォールバックを追加する
2. > UI側から `defaultOption` 情報もリクエストに含める設計変更が必要になる可能性がある

しかし、1のみで十分なのか、2が必須なのかの判断基準が示されていない。

**推奨対応**:
MF-1で記載した2つのアプローチ（A: API側フォールバック、B: UI側データ送信）の比較表を追加し、推奨アプローチを明記すべき。特に、非デフォルト選択肢（例: 2番目の選択肢）を選択した場合の動作保証が必要であり、その場合はアプローチBが必須となる点を明確にすべき。

---

## Nice to Have（あれば良い）

### NTH-1: auto-yes-manager.ts との関連性・影響有無が明記されていない

**カテゴリ**: 完全性
**場所**: ## 影響範囲 セクション

**問題**:
`src/lib/auto-yes-manager.ts:343-399` に `route.ts` と同様の `isClaudeMultiChoice` 判定とカーソルキー送信ロジックが存在する。本Issueのバグが auto-yes にも影響するかどうかが明記されていない。

**証拠**:
`auto-yes-manager.ts:318-321` で `promptDetection.isPrompt` が `false` の場合は早期リターンしており、`promptDetection` は `null` にならない設計であるため、本Issueのバグは影響しない。しかし、ロジックの重複（route.ts:96-148 と auto-yes-manager.ts:343-399）は保守性の観点から課題である。

**推奨対応**:
影響範囲セクションに「Auto-Yes機能は `promptDetection` が成功した場合のみカーソルキー方式を使用するため影響なし」と明記する。また、今後のリファクタリング候補として、カーソルキー送信ロジックの共通化を検討事項に追加する。

---

### NTH-2: 関連Issueへのリンクが不足

**カテゴリ**: 完全性
**場所**: Issue本文

**問題**:
本バグの前提となる実装を導入したIssueへの参照リンクがない。

**証拠**:
- `route.ts:93` に `// Issue #193: Claude Code AskUserQuestion uses cursor-based navigation` のコメント
- `route.ts:68` に `// Issue #161: Re-verify that a prompt is still active before sending keys` のコメント

**推奨対応**:
Issue本文に以下のリンクを追加:
- Issue #193: カーソルキー方式の導入元
- Issue #161: プロンプト再検証の導入元

---

### NTH-3: src/types/models.ts が関連ファイルに含まれていない

**カテゴリ**: 完全性
**場所**: ## 関連ファイル セクション

**問題**:
修正方針でUI側から `promptData` 情報をリクエストに含める場合、`PromptResponseRequest` 型の拡張や `MultipleChoiceOption` 型の参照が必要になる。

**証拠**:
`route.ts:17-20` の `PromptResponseRequest` インターフェースには現在 `answer` と `cliTool?` のみが定義されている:
```typescript
interface PromptResponseRequest {
  answer: string;
  cliTool?: CLIToolType;
}
```

**推奨対応**:
`src/types/models.ts` を関連ファイルに追加する。

---

## 既存テストへの影響に関する注記

`tests/unit/api/prompt-response-verification.test.ts:163-177` に以下の既存テストケースがある:

```typescript
it('should proceed with send when capture fails (fallback for manual responses)', async () => {
  vi.mocked(captureSessionOutput).mockRejectedValue(new Error('tmux capture failed'));
  // ...
  // Should still send keys (don't block manual responses)
  expect(data.success).toBe(true);
  expect(sendKeys).toHaveBeenCalled();
});
```

このテストは `captureSessionOutput` が失敗した場合に `sendKeys`（テキスト入力方式）が呼ばれることを期待している。Issue #287 の修正後、このケースで `sendSpecialKeys`（カーソルキー方式）が呼ばれるようテストの更新が必要になる可能性がある。この点は修正方針の選択（アプローチA or B）によって異なるため、受け入れ条件にテスト更新の有無を含めるべきである。

---

## 参照ファイル

### コード
| ファイル | 関連性 |
|---------|--------|
| `src/app/api/worktrees/[id]/prompt-response/route.ts` | 主要修正対象（L72-89, L96-98, L149-157） |
| `src/components/worktree/WorktreeDetailRefactored.tsx` | handlePromptRespond関数（L1126-1141） |
| `src/components/mobile/MobilePromptSheet.tsx` | モバイルUI送信処理（L242-249） |
| `src/components/worktree/PromptPanel.tsx` | デスクトップUI送信処理（L107-123） |
| `src/lib/cli-session.ts` | captureSessionOutput実装元（Issueの関連ファイルに欠落） |
| `src/lib/tmux.ts` | sendKeys/sendSpecialKeys実装（L252-278） |
| `src/lib/auto-yes-manager.ts` | 同様のカーソルキーロジック（L343-399、影響なし） |
| `src/types/models.ts` | PromptData/MultipleChoiceOption型定義（L126-178） |
| `tests/unit/api/prompt-response-verification.test.ts` | 既存テスト（L163-177要更新の可能性） |

### ドキュメント
| ファイル | 関連性 |
|---------|--------|
| `CLAUDE.md` | プロジェクト構成・モジュール説明の整合性確認 |

---

*Generated by issue-review-agent (Stage 1, Iteration 1)*
