# Issue #287 レビューレポート

**レビュー日**: 2026-02-15
**フォーカス**: 影響範囲レビュー（2回目）
**ステージ**: 7

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 0 |
| Should Fix | 1 |
| Nice to Have | 2 |

## Stage 3 指摘事項の反映状況

前回の影響範囲レビュー（Stage 3）で指摘した6件全てについて、Issue本文への反映状況を確認した。

| ID | ステータス | 概要 |
|----|-----------|------|
| MF-1 | **解決済み** | `useAutoYes.ts` が影響範囲・修正ファイル一覧・受け入れ条件に追加された |
| SF-1 | **解決済み** | `PromptMessage.tsx` の影響パスが明記され、非破壊的アプローチでは変更不要と明示された |
| SF-2 | **解決済み** | 非破壊的アプローチ推奨方針と根拠が詳細に記載された |
| SF-3 | **解決済み** | 結合テストのリクエストボディ検証が修正ファイル一覧・受け入れ条件に追加された |
| NTH-1 | **解決済み** | `PromptResponseRequest` 型の配置方針（ローカル定義のまま拡張、共有化は別Issue）が明記された |
| NTH-2 | **スコープ外として認識** | CLAUDE.md更新は修正ファイル一覧に含まれておらず、実装後作業として暗黙的にスコープ外 |

Stage 5（通常レビュー2回目）の指摘事項も反映されている:
- **SF-1**: `defaultOption` を `defaultOptionNumber` にリネームし、`MultipleChoiceOption.isDefault` (boolean) からの導出ロジックを明記
- **SF-2**: `useAutoYes.ts` のpromptData参照箇所を「L76のprops」から「L30の関数パラメータ」に修正
- **NTH-1**: フォールバック判定ロジックの疑似コードを追加
- **NTH-2**: `PromptResponseRequest` 型のローカル定義維持方針を修正ファイル一覧に追記

---

## Should Fix（推奨対応）

### SF-1: フォールバックパスにおける defaultOptionNumber=undefined 時のエッジケース

**カテゴリ**: テスト範囲
**場所**: ## 修正方針案 > アプローチBの修正箇所 > フォールバック判定ロジックの疑似コード

**問題**:
フォールバック判定の疑似コードでは `isClaudeMultiChoice` 判定後にカーソルキーの offset を計算するロジックが記載されているが、フォールバックパス（`promptCheck === null`）で `body.defaultOptionNumber` が `undefined` の場合のデフォルト値が明示されていない。

**証拠**:
`route.ts:L103-104` の通常パスでは以下のようにフォールバック値 `1` を使用している:

```typescript
const defaultOption = mcOptions.find(o => o.isDefault);
const defaultNum = defaultOption?.number ?? 1;
```

フォールバックパスでは `promptCheck` が `null` のため `mcOptions` も利用不可であり、`body.defaultOptionNumber` のみが情報源となる。`body.defaultOptionNumber` が `undefined` の場合（UIが古いバージョン、または `YesNoPromptData` の場合は送信しない設計）のデフォルト値 `1` の使用を明示する必要がある。

**推奨対応**:
以下のいずれかを行う:
1. フォールバック判定ロジックの疑似コードに `const defaultNum = body.defaultOptionNumber ?? 1;` を追加
2. 受け入れ条件に「`defaultOptionNumber` が未送信の場合、デフォルト値 `1` が使用されること」のテストケースを追加

---

## Nice to Have（あれば良い）

### NTH-1: auto-yes-manager.ts のカーソルキーロジック重複のリファクタリングIssue

**カテゴリ**: テスト範囲
**場所**: ## 影響範囲

**問題**:
Issue本文で `auto-yes-manager.ts` が影響範囲外である理由が正確に記載されていることを確認した。`detectPrompt()` は常に `PromptDetectionResult` オブジェクトを返し、`null` にならないため、`route.ts` のような try-catch で `null` フォールバックする構造とは異なる。

ただし、`route.ts:L96-148` と `auto-yes-manager.ts:L343-399` のカーソルキーロジックの重複について「別Issue」と言及されているが、該当する既存Issueへのリンクはない。

**推奨対応**:
リファクタリング用のIssueが未作成であれば作成を検討する。作成済みであればリンクを追加する。

---

### NTH-2: handlePromptRespond の useCallback dependency 追加に伴うパフォーマンス考慮

**カテゴリ**: 影響ファイル
**場所**: ## 修正方針案 > アプローチBの修正箇所 > 修正ファイル一覧 > WorktreeDetailRefactored.tsx

**問題**:
`handlePromptRespond` の `useCallback` dependency 配列（現在: `[worktreeId, actions, fetchCurrentOutput, activeCliTab]`）に `state.prompt.data` を追加すると、`promptData` が変化するたびに関数が再生成される。`promptData` はポーリング（2秒/5秒間隔）の度に更新される可能性がある。

**推奨対応**:
実質的なパフォーマンス影響は無視できるレベル（React.memo による保護、他の props も同時に変化するため）だが、実装時の注意点として認識しておくと良い。代替策として `useRef` で `state.prompt.data` を保持し dependency 配列に含めないアプローチも検討可能。

---

## 影響範囲分析 総括

### 修正が必要なファイル（5ファイル）

| ファイル | 変更内容 | リスク |
|---------|---------|-------|
| `src/app/api/worktrees/[id]/prompt-response/route.ts` | PromptResponseRequest拡張、フォールバック判定ロジック追加 | Medium |
| `src/components/worktree/WorktreeDetailRefactored.tsx` | handlePromptRespond内部でpromptType/defaultOptionNumber導出・送信 | Medium |
| `src/hooks/useAutoYes.ts` | fetch呼び出しにpromptType/defaultOptionNumber追加 | Low |
| `tests/unit/api/prompt-response-verification.test.ts` | promptType付きリクエストのテスト追加 | Low |
| `tests/integration/worktree-detail-integration.test.tsx` | リクエストボディ内容検証追加 | Low |

### 修正不要なファイル（確認済み）

| ファイル | 理由 |
|---------|------|
| `src/components/worktree/PromptPanel.tsx` | onRespondシグネチャ不変（非破壊的アプローチ） |
| `src/components/mobile/MobilePromptSheet.tsx` | 同上 |
| `src/components/worktree/PromptMessage.tsx` | 同上 |
| `src/lib/auto-yes-manager.ts` | detectPrompt()がnullを返さない構造のため影響なし |
| `src/lib/auto-yes-resolver.ts` | 回答導出の純粋関数、API呼び出しに関与しない |
| `src/lib/prompt-detector.ts` | 検出ロジック変更不要 |
| `src/lib/cli-session.ts` | captureSessionOutput変更不要 |
| `src/lib/tmux.ts` | sendKeys/sendSpecialKeys変更不要 |
| `src/types/models.ts` | PromptResponseRequest共有化は別Issue |

### 破壊的変更

**なし**。`promptType`/`defaultOptionNumber` フィールドはオプショナルとして設計され、後方互換性が保たれる。

---

## 参照ファイル

### コード
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-287/src/app/api/worktrees/[id]/prompt-response/route.ts`: 主要修正対象。L96-148のisClaudeMultiChoice判定とカーソルキー送信ロジック
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-287/src/components/worktree/WorktreeDetailRefactored.tsx`: L1126-1148のhandlePromptRespond
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-287/src/hooks/useAutoYes.ts`: L85-92のfetch呼び出し
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-287/src/lib/auto-yes-manager.ts`: L319-325のpromptDetection nullチェック（影響範囲外の確認用）
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-287/tests/unit/api/prompt-response-verification.test.ts`: L163-177のcaptureSessionOutput失敗テスト
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-287/tests/integration/worktree-detail-integration.test.tsx`: L392-427のAPI呼び出し検証

### ドキュメント
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-287/CLAUDE.md`: モジュール説明の整合性確認

---

## 結論

Stage 3 で指摘した6件の全てがIssue本文に適切に反映されている。影響範囲の分析は正確であり、非破壊的アプローチの採用により修正範囲が最小限に抑えられている。新たに発見された指摘は1件の Should Fix（フォールバックパスの defaultOptionNumber=undefined エッジケース）と2件の Nice to Have のみであり、Issue の完成度は高い。
