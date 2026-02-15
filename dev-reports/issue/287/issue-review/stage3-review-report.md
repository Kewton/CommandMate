# Issue #287 影響範囲レビューレポート

**レビュー日**: 2026-02-15
**フォーカス**: 影響範囲レビュー
**イテレーション**: 1回目（Stage 3）

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 1 |
| Should Fix | 3 |
| Nice to Have | 2 |

---

## Must Fix（必須対応）

### MF-1: useAutoYes.tsのprompt-response API呼び出しが修正箇所リストに含まれていない

**カテゴリ**: テスト範囲
**場所**: `src/hooks/useAutoYes.ts` L85-89

**問題**:
Issueの修正箇所リストに `src/hooks/useAutoYes.ts` が含まれていない。しかし、このファイルは `prompt-response` APIの3つのクライアントのうちの1つであり、アプローチBの型変更に追従する必要がある。

`useAutoYes.ts` L86-89:
```typescript
fetch(`/api/worktrees/${worktreeId}/prompt-response`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ answer, cliTool }),
})
```

現在、`{ answer, cliTool }` のみをリクエストボディに含めており、`promptType` / `defaultOption` フィールドが含まれていない。アプローチBでAPIが `promptType` を使用してフォールバック判定を行う設計になった場合、useAutoYes.tsのfetch呼び出しも同様に `promptData` 情報を送信する必要がある。

`useAutoYes.ts` はL76で `promptData` をpropsとして受け取っているため、修正自体は容易だが、修正箇所リストから漏れると **Auto-Yesパスで同一バグが再発する可能性がある**。

**証拠**:
- `useAutoYes.ts:L86-89`: `body: JSON.stringify({ answer, cliTool })` -- promptType未送信
- `useAutoYes.ts:L76`: `promptData` はpropsとして利用可能

**推奨対応**:
Issueの修正箇所リスト（アプローチBのセクション）に `src/hooks/useAutoYes.ts` を追加し、fetch呼び出しのリクエストボディに `promptType` と `defaultOption` を含める修正を明記すること。

---

## Should Fix（推奨対応）

### SF-1: PromptMessage.tsxが影響範囲として明記されていない

**カテゴリ**: 影響ファイル
**場所**: `src/components/worktree/PromptMessage.tsx` L145

**問題**:
`PromptMessage.tsx` の multiple_choice ボタン（L145: `handleRespond(option.number.toString())`）は、`WorktreeDetailRefactored.tsx` の `handlePromptRespond` を経由して `prompt-response` APIを呼び出す。Issueの関連ファイルリストに `PromptMessage.tsx` が含まれていない。

`onRespond` のシグネチャを変更する実装戦略を採る場合、`PromptMessage.tsx:L18` の型定義も変更が必要になる。`handlePromptRespond` 内部で `state.prompt.data` から直接取得する戦略であれば変更不要だが、影響範囲の「潜在的に影響するファイル」として明記すべきである。

**証拠**:
- `PromptMessage.tsx:L18`: `onRespond: (answer: string) => Promise<void>`
- `PromptMessage.tsx:L145`: `handleRespond(option.number.toString())` -- prompt-response APIへの間接的な呼び出し

**推奨対応**:
影響範囲セクションに `PromptMessage.tsx` を「実装戦略によっては影響するファイル」として追記。

---

### SF-2: onRespondシグネチャの変更方針（破壊的 vs 非破壊的）が明示されていない

**カテゴリ**: 破壊的変更
**場所**: 修正方針案セクション

**問題**:
アプローチBの修正には、2つの実装戦略が存在するが、Issueではどちらを採用するか明示されていない。

**戦略(A): 非破壊的 -- handlePromptRespond内部で解決**

`handlePromptRespond` 関数内部で `state.prompt.data` から `promptType` / `defaultOption` を直接取得し、リクエストボディに含める。

- `onRespond` のシグネチャは `(answer: string) => Promise<void>` のまま **変更不要**
- `MobilePromptSheet.tsx`, `PromptPanel.tsx`, `PromptMessage.tsx` のインターフェースは不変
- 修正範囲が最小

```typescript
// WorktreeDetailRefactored.tsx L1126-1147
const handlePromptRespond = useCallback(
  async (answer: string): Promise<void> => {
    const currentPromptData = state.prompt.data; // クロージャでアクセス
    const body: Record<string, unknown> = { answer, cliTool: activeCliTab };
    if (currentPromptData?.type === 'multiple_choice') {
      body.promptType = currentPromptData.type;
      const defaultOpt = currentPromptData.options.find(o => o.isDefault);
      body.defaultOption = defaultOpt?.number;
    }
    // ...fetch with body
  },
  [worktreeId, actions, fetchCurrentOutput, activeCliTab, state.prompt.data]
);
```

**戦略(B): 破壊的 -- onRespondシグネチャ変更**

`onRespond` のシグネチャを `(answer: string, promptData?: PromptData) => Promise<void>` に変更。

- 全呼び出し元（`MobilePromptSheet`, `PromptPanel`, `PromptMessage`）の型定義更新が必要
- 修正範囲が広い

**推奨対応**:
戦略(A)の非破壊的アプローチを推奨する旨をIssueに明記すべき。修正範囲の最小化と、既存コンポーネントインターフェースの安定性の観点から優位。

---

### SF-3: 結合テストでリクエストボディの内容検証が不足

**カテゴリ**: テスト範囲
**場所**: `tests/integration/worktree-detail-integration.test.tsx` L392-427

**問題**:
既存の結合テスト（L392-427）は `prompt-response` APIが呼び出されたことのみを検証しており、リクエストボディの内容は未検証である。

```typescript
// L423-426: 呼び出し存在の確認のみ
const promptResponseCall = mockFetch.mock.calls.find(
  (call) => call[0].includes('/prompt-response')
);
expect(promptResponseCall).toBeDefined();
```

アプローチBの修正後、新規フィールド（`promptType`, `defaultOption`）が正しくリクエストボディに含まれることを検証するテストケースの追加が望ましい。

**推奨対応**:
受け入れ条件に「結合テストでpromptType/defaultOptionがリクエストボディに含まれることを検証するテストの追加」を追記。

---

## Nice to Have（あれば良い）

### NTH-1: PromptResponseRequest型の共有化

**カテゴリ**: 依存関係
**場所**: `src/app/api/worktrees/[id]/prompt-response/route.ts` L17-20

現在、`PromptResponseRequest` は `route.ts` 内にローカル定義されている。アプローチBでフィールドを追加する際、この型を `src/types/models.ts` に移動してクライアント・サーバー間で共有すると型安全性が向上する。ただし、スコープ拡大になるため本Issue内ではローカル定義のまま拡張し、型共有化は別Issueとする判断も妥当。

---

### NTH-2: CLAUDE.mdへのモジュール説明追記

**カテゴリ**: ドキュメント更新
**場所**: CLAUDE.md

修正完了後、CLAUDE.mdの主要機能モジュール一覧に `prompt-response/route.ts` のエントリを追加するか、関連モジュールの説明を更新すると保守性が向上する。

---

## 影響範囲分析

### 直接影響するファイル

| ファイル | 変更内容 | リスク |
|---------|---------|--------|
| `src/app/api/worktrees/[id]/prompt-response/route.ts` | PromptResponseRequest型拡張、promptCheck=null時フォールバック判定追加 | Medium |
| `src/components/worktree/WorktreeDetailRefactored.tsx` | handlePromptRespond内でstate.prompt.dataからpromptType/defaultOptionを取得しリクエストに含める | Medium |
| `src/hooks/useAutoYes.ts` | fetch呼び出しのリクエストボディにpromptData情報を追加 | Medium |
| `src/types/models.ts` | PromptResponseRequest型追加（型共有化する場合のみ） | Low |
| `tests/unit/api/prompt-response-verification.test.ts` | capture失敗時テスト更新、promptType付きリクエストのテスト追加 | Low |

### 潜在的に影響するファイル

| ファイル | 条件 | リスク |
|---------|------|--------|
| `src/components/mobile/MobilePromptSheet.tsx` | onRespondシグネチャ変更時のみ | Low |
| `src/components/worktree/PromptPanel.tsx` | onRespondシグネチャ変更時のみ | Low |
| `src/components/worktree/PromptMessage.tsx` | onRespondシグネチャ変更時のみ | Low |
| `tests/integration/worktree-detail-integration.test.tsx` | リクエストボディ検証追加時 | Low |

### 影響なしと確認されたファイル

| ファイル | 理由 |
|---------|------|
| `src/lib/auto-yes-manager.ts` | サーバー側ポーリング。promptDetectionが常にnull以外で動作するため影響外 |
| `src/lib/cli-session.ts` | captureSessionOutput自体は修正不要 |
| `src/lib/tmux.ts` | sendKeys/sendSpecialKeysの実装は変更不要 |
| `src/lib/prompt-detector.ts` | プロンプト検出ロジック自体は変更不要 |

### 破壊的変更の有無

**破壊的変更なし**。アプローチBで追加される `promptType` / `defaultOption` フィールドはオプショナル（`?`）として設計すべきであり、これにより既存クライアントコード（フィールド未送信）でも後方互換性が保たれる。`route.ts` 側では `promptType` が未送信の場合は従来通りの動作（`promptCheck` ベースの判定）を行う。

### テスト範囲の妥当性

受け入れ条件に記載されている5項目は概ね妥当だが、以下の追加が推奨される:

1. **useAutoYes経由のprompt-responseパスのテスト**: Auto-Yesが有効時にpromptType情報がAPIに正しく送信されることの検証
2. **結合テストでのリクエストボディ検証**: 新規フィールドが含まれることの検証
3. **オプショナルフィールド未送信時の後方互換性テスト**: promptType/defaultOptionなしのリクエストでも従来動作が維持されることの検証

---

## 参照ファイル

### コード
- `src/app/api/worktrees/[id]/prompt-response/route.ts`: 主要修正対象。L17-20の型拡張、L86-89のフォールバック
- `src/components/worktree/WorktreeDetailRefactored.tsx`: L1126-1147のhandlePromptRespond修正
- `src/hooks/useAutoYes.ts`: L85-89のfetch呼び出し修正（**Issueの修正箇所リストに追加必要**）
- `src/components/worktree/PromptMessage.tsx`: 潜在的影響ファイル
- `src/components/mobile/MobilePromptSheet.tsx`: 潜在的影響ファイル
- `src/components/worktree/PromptPanel.tsx`: 潜在的影響ファイル
- `src/lib/auto-yes-manager.ts`: 影響なし（カーソルキーロジック重複あり、別Issueで対応推奨）
- `tests/unit/api/prompt-response-verification.test.ts`: テスト更新対象
- `tests/integration/worktree-detail-integration.test.tsx`: テスト拡充推奨

### ドキュメント
- `CLAUDE.md`: モジュール説明の整合性確認
