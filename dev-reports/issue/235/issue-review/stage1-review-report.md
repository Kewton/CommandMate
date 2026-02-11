# Issue #235 レビューレポート

**レビュー日**: 2026-02-11
**フォーカス**: 通常レビュー（Consistency & Correctness）
**イテレーション**: 1回目
**前提**: 仮説検証（hypothesis-verification.md）にて全5仮説がConfirmed済み

---

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 1 |
| Should Fix | 4 |
| Nice to Have | 2 |

### 総合評価

Issue #235 の原因分析は正確であり、修正方針B（rawContentフィールド導入）は技術的に妥当である。仮説検証で確認された通り、データフローの記載はコードベースと完全に一致している。ただし、実装タスクの網羅性と一部の仕様の明確性に改善の余地がある。

---

## Must Fix（必須対応）

### MF-1: claude-poller.ts の同一パターンが実装タスクから漏れている

**カテゴリ**: 完全性
**場所**: 実装タスク / 影響範囲

**問題**:
`src/lib/claude-poller.ts:245` にも `content: promptDetection.cleanContent` によるDB保存箇所が存在するが、Issueの実装タスクおよび影響範囲テーブルのいずれにも記載がない。

**証拠**:
```typescript
// src/lib/claude-poller.ts:242-245
const message = createMessage(db, {
  worktreeId,
  role: 'assistant',
  content: promptDetection.cleanContent,  // <-- response-poller.ts:618 と同一パターン
```

ただし、同ファイル L234 に以下のコメントがある:
```typescript
// TODO [Issue #193]: This code path is unreachable (claude-poller.ts is superseded by response-poller.ts).
```

**推奨対応**:
以下のいずれかをIssueに追記する:
1. `claude-poller.ts:245` も `rawContent || cleanContent` に変更するタスクを追加
2. `claude-poller.ts` は `response-poller.ts` に統合済みで到達不能コードであることを影響範囲の「影響なしの確認済みコンポーネント」テーブルに明記

後者の場合、将来的なコード削除（Issue #193 TODO）までの整合性リスクは低いが、明示的な記載により実装者の判断を支援できる。

---

## Should Fix（推奨対応）

### SF-1: Approveパターンが実装タスクに含まれていない

**カテゴリ**: 完全性
**場所**: 実装タスク

**問題**:
`prompt-detector.ts:134-153` のApproveパターン（Pattern 5）も `cleanContent: content || 'Approve?'` として質問テキストのみを返却しているが、実装タスクではYes/Noパターンとmultiple_choiceパターンのみ言及されており、Approveパターンへの `rawContent` 追加が記載されていない。

**証拠**:
```typescript
// src/lib/prompt-detector.ts:139-153
if (approveMatch) {
  const content = approveMatch[1].trim();
  const question = content ? `${content} Approve?` : 'Approve?';
  return {
    isPrompt: true,
    promptData: { ... },
    cleanContent: content || 'Approve?',  // rawContent なし
  };
}
```

**推奨対応**:
実装タスクに以下を追加:
- `src/lib/prompt-detector.ts`: Approveパターン検出で `rawContent: lastLines.trim()` を返却

---

### SF-2: PromptMessage.tsx での表示方法が未定義

**カテゴリ**: 明確性
**場所**: 実装タスク（最後のタスク）

**問題**:
Issueでは「`message.content`（指示テキスト）の表示を追加」とだけ記載されているが、具体的なUIレイアウトが未定義である。以下の設計判断が必要:

1. `message.content`（rawContent由来の全文）をそのまま表示するか
2. `message.content` から `prompt.question` を除いた差分（指示テキスト部分）のみを表示するか
3. 表示位置は `prompt.question` の上か下か
4. 長文の指示テキストに対するスクロール・折りたたみは必要か

**証拠**:
```tsx
// 現在の PromptMessage.tsx:50-53（質問のみ表示）
<div className="mb-4">
  <p className="text-base text-gray-800 leading-relaxed">
    {prompt.question}
  </p>
</div>
```

`message.content` は ChatMessage の `content` フィールドとして渡されているが、コンポーネント内で一切参照されていない。

**推奨対応**:
以下の情報を実装タスクに追記:
- `message.content` を指示テキストとして `prompt.question` の上部に表示
- `message.content` と `prompt.question` が同一の場合は重複表示を避ける
- 長文の場合の最大表示行数またはスクロール方針

---

### SF-3: rawContent の内容ソースが検出パターンごとに異なる

**カテゴリ**: 技術的妥当性
**場所**: 実装タスク

**問題**:
実装タスクでは以下のように検出パターンごとに異なるソースから rawContent を設定する:
- `detectMultipleChoicePrompt()`: `rawContent: output.trim()` -- 全出力
- Yes/No パターン: `rawContent: lastLines.trim()` -- 末尾10行

Yes/Noパターンの場合、`lastLines` は `lines.slice(-10).join('\n')` で末尾10行のみであるため、10行を超える指示テキストが存在するケースでは切り捨てが発生する。

**証拠**:
```typescript
// src/lib/prompt-detector.ts:96-97
const lines = output.split('\n');
const lastLines = lines.slice(-10).join('\n');
```

**推奨対応**:
以下のいずれかを検討:
1. Yes/Noパターンでも `rawContent: output.trim()` として全出力を使用する（multiple_choiceと統一）
2. `lastLines` のまま使用し、制限事項として「Yes/Noプロンプトの指示テキストは末尾10行以内」を受入条件に追記する

方針1が推奨。Yes/Noパターンの `lastLines` はパターンマッチングの効率化のための制限であり、rawContent（表示用途）には同じ制限を適用する必然性がない。

---

### SF-4: current-output API の cleanContent 使用が影響分析に含まれていない

**カテゴリ**: 完全性
**場所**: 影響範囲

**問題**:
`src/app/api/worktrees/[id]/current-output/route.ts:91` で `cleanContent` を独自にデフォルト値として設定しているが、影響範囲テーブルに記載がない。

**証拠**:
```typescript
// route.ts:91
let promptDetection: { isPrompt: boolean; cleanContent: string; promptData?: unknown } = {
  isPrompt: false,
  cleanContent: cleanOutput
};
```

このコードは `PromptDetectionResult` 型を直接参照せず、独自のインラインオブジェクト型を使用しているため、`PromptDetectionResult` への `rawContent` フィールド追加による型エラーは発生しない。

**推奨対応**:
影響範囲の「影響なしの確認済みコンポーネント」テーブルに以下を追加:
| `current-output/route.ts` | PromptDetectionResult型を直接使用していない。独自のインラインオブジェクト型で cleanContent を設定しており、rawContent 追加の影響なし |

---

## Nice to Have（あれば良い）

### NTH-1: rawContent フォールバック動作の受入条件

**カテゴリ**: 完全性
**場所**: 受入条件

**問題**:
`response-poller.ts:618` の変更で `promptDetection.rawContent || promptDetection.cleanContent` とフォールバック設計にしているが、rawContent が undefined のケース（noPromptResult等）のフォールバック動作に関する受入条件がない。

**推奨対応**:
受入条件に以下を追加:
- 「rawContent 未設定時（非プロンプト検出等）に cleanContent が正常にDB保存されること」

---

### NTH-2: Codex プロンプト検出パスの補足

**カテゴリ**: 完全性
**場所**: 影響範囲 > 関連コンポーネント

**問題**:
関連コンポーネントとして `src/lib/cli-tools/codex.ts` が記載されているが、codex.ts 自体は detectPrompt/cleanContent を直接使用していない。Codexのプロンプトは `response-poller.ts` の `detectPromptWithOptions()` 経由で処理されるため、rawContent の導入により間接的に恩恵を受ける。

**推奨対応**:
関連コンポーネントの説明を以下のように明確化:
- 「codex.ts 自体は detectPrompt を直接呼ばないが、response-poller.ts 経由で rawContent の恩恵を受ける」

---

## レビュー観点別評価

### 整合性（既存コード・ドキュメントとの整合性）

**評価**: 概ね良好

- Issue記載のデータフロー（tmux -> response-poller -> prompt-detector -> DB -> UI）はコードベースと正確に一致している
- 仮説検証で全5仮説がConfirmedされており、原因分析の信頼性は高い
- `claude-poller.ts` の同一パターン漏れ（MF-1）は要対応

### 正確性（記載内容の正しさ）

**評価**: 良好

- 問題箇所の行番号は全て正確（仮説検証で確認済み）
- 不採用案（方針A, C）の理由も技術的に妥当
- DBスキーマ変更不要の判断も正しい（`content TEXT` カラムに長さ制限なし）

### 明確性（要件の明確さ）

**評価**: 改善の余地あり

- PromptMessage.tsx での UI 表示方法が曖昧（SF-2）
- rawContent の定義（全出力 vs 末尾10行）がパターンごとに異なる点の説明不足（SF-3）

### 完全性（必要情報の網羅性）

**評価**: 一部不足

- Approveパターンの漏れ（SF-1）
- claude-poller.ts の漏れ（MF-1）
- current-output API の影響確認漏れ（SF-4）

### 受け入れ条件

**評価**: 概ね良好

- 4つの受入条件は明確で検証可能
- フォールバック動作の検証条件追加が望ましい（NTH-1）

### 技術的妥当性

**評価**: 良好

- 方針B（rawContent導入）は後方互換性を維持しつつ問題を解決する適切なアプローチ
- `rawContent?: string` のオプショナル設計は既存コードへの影響を最小化
- `rawContent || cleanContent` のフォールバック設計は堅実

---

## 参照ファイル

### コード

| ファイル | 関連性 |
|---------|--------|
| `src/lib/prompt-detector.ts` | PromptDetectionResult型定義およびcleanContent生成ロジックの変更対象 |
| `src/lib/response-poller.ts` | DB保存時のcontent値の変更対象（L618） |
| `src/lib/claude-poller.ts` | 同一パターンのDB保存箇所（L245）- Issueに記載なし |
| `src/components/worktree/PromptMessage.tsx` | 指示テキスト表示追加の変更対象 |
| `src/app/api/worktrees/[id]/current-output/route.ts` | cleanContent独自設定（影響確認が必要） |
| `src/lib/auto-yes-manager.ts` | promptDataのみ使用 - 影響なし確認済み |
| `src/lib/auto-yes-resolver.ts` | promptDataのみ使用 - 影響なし確認済み |
| `src/lib/status-detector.ts` | isPromptフラグのみ参照 - 影響なし確認済み |
| `tests/unit/prompt-detector.test.ts` | 既存テストでcleanContentを検証 - rawContent追加時にテスト更新が必要 |

### ドキュメント

| ファイル | 関連性 |
|---------|--------|
| `CLAUDE.md` | prompt-detector.ts, response-poller.ts のモジュール説明記載あり |
