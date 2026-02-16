# Issue #287 レビューレポート

**レビュー日**: 2026-02-15
**フォーカス**: 通常レビュー（整合性・正確性）
**イテレーション**: 2回目（Stage 5）
**前回レビュー**: Stage 1（通常レビュー 1回目）

---

## Stage 1 指摘事項の対応状況

Stage 1 で指摘した全 8 件（MF: 1, SF: 4, NTH: 3）の対応状況を確認した。

| ID | カテゴリ | ステータス | 対応内容 |
|----|---------|-----------|---------|
| MF-1 | 完全性 | **対応済** | アプローチA/Bの比較表、非破壊的実装戦略の詳細、修正ファイル一覧を追加 |
| SF-1 | 明確性 | **対応済** | 再現手順にpromptCheck再検証の失敗条件3パターンを追記 |
| SF-2 | 完全性 | **対応済** | 8項目の受け入れ条件をチェックリスト形式で追加 |
| SF-3 | 完全性 | **対応済** | cli-session.tsを関連ファイルに追加（根拠付き） |
| SF-4 | 技術的妥当性 | **対応済** | アプローチA/Bのメリット・デメリット・リスクを比較表で提示 |
| NTH-1 | 完全性 | **対応済** | auto-yes-manager.tsの非影響を根拠付きで明記 |
| NTH-2 | 完全性 | **対応済** | 関連IssueセクションでIssue #193, #161へのリンクを追加 |
| NTH-3 | 完全性 | **対応済** | src/types/models.tsを関連ファイルに追加 |

**Stage 1 の指摘は全件対応済み。** Issue の品質は大幅に向上している。

---

## 今回の新規指摘事項

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 0 |
| Should Fix | 2 |
| Nice to Have | 2 |

---

## Should Fix（推奨対応）

### SF-1: defaultOption送信設計がPromptData型構造と不整合

**カテゴリ**: 正確性
**場所**: 修正方針案 > アプローチBの修正箇所 > 修正ファイル一覧

**問題**:
修正ファイル一覧の route.ts 修正内容で「`PromptResponseRequest` に `promptType?: string`, `defaultOption?: number` を追加」と記載しているが、実際の `PromptData` 型構造では `defaultOption` はトップレベルの number 型フィールドとして存在しない。

- `MultipleChoicePromptData` の場合: `options` 配列内の各 `MultipleChoiceOption` が `isDefault?: boolean` フィールドを持ち、`options.find(o => o.isDefault)?.number` で番号を導出する必要がある
- `YesNoPromptData` の場合: `defaultOption?: 'yes' | 'no'` であり、number 型ではない

**証拠**:
```typescript
// src/types/models.ts:L155-164
export interface MultipleChoiceOption {
  number: number;
  label: string;
  isDefault?: boolean;  // boolean型
  requiresTextInput?: boolean;
}

// route.ts:L103-104 での導出例
const defaultOption = mcOptions.find(o => o.isDefault);
const defaultNum = defaultOption?.number ?? 1;  // ここでnumberに変換
```

**推奨対応**:
`handlePromptRespond` から送信する際に `options.find(o => o.isDefault)?.number` で導出する変換ロジックが必要であることを Issueに補足するか、`PromptResponseRequest` に追加するフィールド名を `defaultOptionNumber?: number`（multiple_choice専用）のように区別すると、型の不整合を防げる。

---

### SF-2: useAutoYes.tsのpromptData参照箇所の行番号不一致

**カテゴリ**: 完全性
**場所**: 影響範囲 > 影響を受けるAPIクライアント

**問題**:
Issue本文の「影響を受けるAPIクライアント」セクションで以下の記載がある:

> `promptData` は既にpropsとして受け取っている（L76）ため修正は容易

しかし、`useAutoYes.ts:L76` は以下の行であり、`promptData` の受け取り箇所ではなく使用箇所:

```typescript
// L76: promptDataの使用箇所
const promptKey = `${promptData.type}:${promptData.question}`;
```

`promptData` の受け取り箇所は以下:

```typescript
// L30: パラメータ定義（propsではなく関数引数）
promptData: PromptData | null;
```

**推奨対応**:
- 行番号を L30 に修正するか、「関数パラメータとして受け取っている」に表現を修正
- 「props」ではなく「パラメータ」が正確（useAutoYes はカスタムフックであり、React コンポーネントの props ではない）

---

## Nice to Have（あれば良い）

### NTH-1: route.tsのフォールバック判定ロジックの疑似コード

**カテゴリ**: 明確性
**場所**: 修正方針案 > アプローチBの修正箇所

**問題**:
「`promptCheck=null` 時にリクエストボディの `promptType` を参照してカーソルキー方式を判定」と記載されているが、具体的な判定ロジック（`promptCheck` が存在する場合の優先順位、null の場合のフォールバック条件）の疑似コードがない。

**推奨対応**:
以下のような疑似コードを追加すると実装者にとって明確になる:

```typescript
// promptCheck優先、nullの場合はリクエストボディにフォールバック
const isClaudeMultiChoice = cliToolId === 'claude'
  && (promptCheck?.promptData?.type === 'multiple_choice'
      || (promptCheck === null && body.promptType === 'multiple_choice'))
  && /^\d+$/.test(answer);
```

---

### NTH-2: PromptResponseRequest型の配置方針

**カテゴリ**: 完全性
**場所**: 修正方針案 > アプローチBの修正箇所

**問題**:
Stage 3 レビュー NTH-1 で指摘された「`PromptResponseRequest` のローカル定義 vs `src/types/models.ts` への共有化」について、本 Issue 内での方針（ローカル定義のまま拡張 or 共有化）が未記載。

**推奨対応**:
「本 Issue ではスコープを限定し、`PromptResponseRequest` は `route.ts` 内のローカル定義のまま拡張する。型の共有化（クライアント/サーバー間）は別 Issue で対応する」等の方針を明記すると、実装時の判断が不要になる。

---

## 全体評価

Stage 1 の全指摘が適切に反映されており、Issue の品質は大幅に向上した。特に以下の点が優れている:

1. **アプローチ比較**: アプローチA/Bのメリット・デメリット・リスクが明確に整理されている
2. **非破壊的実装戦略**: `onRespond` シグネチャを変更しない方針が根拠付きで記載されている
3. **受け入れ条件**: 8項目が具体的で検証可能な形式で記載されている
4. **影響範囲**: `useAutoYes.ts` の API クライアントパスが修正箇所に含まれており、Auto-Yes パスでの同一バグ再発が防止される
5. **再現条件**: `captureSessionOutput()` の失敗条件が3パターン明示されている

今回の新規指摘は Should Fix 2 件、Nice to Have 2 件であり、いずれも致命的な問題ではない。SF-1（defaultOption型不整合）は実装時に混乱を招く可能性があるため対応が望ましい。

---

## 参照ファイル

### コード
- `src/app/api/worktrees/[id]/prompt-response/route.ts`: 主要修正対象。L17-20 の PromptResponseRequest 型拡張、L96-98 の isClaudeMultiChoice 判定が変更対象
- `src/components/worktree/WorktreeDetailRefactored.tsx`: L1126-1147 の handlePromptRespond。state.prompt.data にアクセス可能
- `src/hooks/useAutoYes.ts`: L86-89 の fetch 呼び出し。L30 で promptData をパラメータとして受け取り
- `src/types/models.ts`: L155-164 の MultipleChoiceOption 型（isDefault: boolean）、L169-173 の MultipleChoicePromptData 型
- `tests/unit/api/prompt-response-verification.test.ts`: L163-177 の captureSessionOutput 失敗テスト
- `tests/integration/worktree-detail-integration.test.tsx`: L392-427 の prompt-response API 呼び出し検証

### ドキュメント
- `CLAUDE.md`: プロジェクト構成・モジュール説明の整合性確認に使用
