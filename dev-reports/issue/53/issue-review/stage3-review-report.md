# Issue #53 影響範囲レビューレポート

**レビュー日**: 2026-01-30
**フォーカス**: 影響範囲レビュー
**イテレーション**: 1回目
**ステージ**: 3
**Issueステータス**: CLOSED

---

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 0 |
| Should Fix | 2 |
| Nice to Have | 2 |

**総合評価**: Issue #53は適切に実装されており、影響範囲は限定的です。主要な変更はsend/route.tsとassistant-response-saver.ts（新規）に集中しており、既存のAPIインターフェースやDBスキーマに破壊的変更がありません。リスクレベルは**低**と評価します。

---

## 影響分析

### 直接影響を受けるファイル

| ファイル | 変更種別 | 説明 |
|---------|---------|------|
| `src/app/api/worktrees/[id]/send/route.ts` | modified | savePendingAssistantResponse関数の呼び出しを追加。ユーザーメッセージ送信前に前回のAssistant応答を保存する新しいロジックを実装 |
| `src/lib/assistant-response-saver.ts` | new | 新規作成。savePendingAssistantResponse、extractAssistantResponseBeforeLastPrompt、detectBufferReset、cleanCliResponse関数を実装 |
| `src/lib/response-poller.ts` | modified | 重複保存防止のための競合状態検出ロジックを追加。savePendingAssistantResponseとの並行実行時の整合性確保 |
| `src/lib/__tests__/assistant-response-saver.test.ts` | new | 新規作成。単体テストを実装 |

### 間接影響を受けるファイル

| ファイル | 影響理由 | リスクレベル |
|---------|---------|-------------|
| `src/lib/db.ts` | createMessage、updateSessionState等のDB関数を使用 | low |
| `src/lib/cli-session.ts` | captureSessionOutput関数を使用 | low |
| `src/lib/ws-server.ts` | broadcastMessage関数を使用 | low |
| `src/lib/cli-patterns.ts` | stripAnsi関数を使用 | low |
| `src/app/api/worktrees/[id]/respond/route.ts` | startPolling関数を使用 | low |
| `src/app/api/worktrees/[id]/start-polling/route.ts` | startPolling関数を使用 | low |
| `src/app/api/worktrees/[id]/kill-session/route.ts` | stopPolling関数を使用 | low |

### API変更

| エンドポイント | 変更内容 | 破壊的変更 |
|---------------|---------|-----------|
| `POST /api/worktrees/:id/send` | 内部ロジック変更のみ。APIインターフェース（リクエスト/レスポンス形式）に変更なし | No |

### データベース変更

| テーブル | 変更内容 | マイグレーション要否 |
|---------|---------|---------------------|
| `chat_messages` | 新規レコード作成のタイミングが変更 | 不要 |
| `session_states` | lastCapturedLineの更新タイミングが変更 | 不要 |

### 破壊的変更

なし

---

## リスク評価

**総合リスク**: **低 (Low)**

### リスク評価根拠

- 変更は主にsend/route.tsとassistant-response-saver.ts（新規）に限定
- 既存APIインターフェースやDBスキーマへの変更がない
- response-pollerとの競合状態も適切に処理されている
- Issue #54、#59で追加の修正が行われ、エッジケースへの対応も充実

### リスク軽減策

1. 既存の単体テストで主要なシナリオがカバーされている
2. 競合状態の検出ロジックがresponse-poller.ts内に実装済み
3. バッファリセット検出によりセッション再起動時のエッジケースも対応済み

---

## Should Fix（推奨対応）

### SF-1: 競合状態のインテグレーションテスト追加

**カテゴリ**: regression
**場所**: `src/lib/__tests__/assistant-response-saver.test.ts`

**問題**:
response-pollerとの競合状態に関する追加テストが推奨されます。

**証拠**:
`response-poller.ts`内のコメントで競合状態への対策が記載されていますが、統合テストでの検証が見当たりません。

```typescript
// response-poller.ts:548-554
// Additional duplicate prevention: check if savePendingAssistantResponse
// already saved this content by comparing line counts
if (result.lineCount <= lastCapturedLine) {
  console.log(`[checkForResponse] Already saved up to line ${lastCapturedLine}, skipping (result: ${result.lineCount})`);
  return false;
}
```

**推奨対応**:
savePendingAssistantResponseとcheckForResponseが並行実行された場合の重複保存防止をテストするインテグレーションテストの追加を検討してください。

---

### SF-2: 最後のメッセージへの応答保存に関する記載

**カテゴリ**: impact_scope
**場所**: Issue本文「考慮点」セクション

**問題**:
最後のメッセージへの応答保存のタイミングに関する記載が不十分です。

**証拠**:
Issue本文に記載された「最後のメッセージへの応答は、次のユーザー入力がないと保存されない」の対策として、response-pollerによる完了検出で保存される仕組みが実装されていますが、実装方針では明示されていません。

**推奨対応**:
response-pollerのcheckForResponse関数が完了検出時に保存を行う既存の仕組みが維持されていることを、Issue本文の実装方針に明記することを推奨します。

---

## Nice to Have（あれば良い）

### NTH-1: 関連Issueへのリンク追加

**カテゴリ**: impact_scope
**場所**: Issue本文

**問題**:
Issue #54、#59への関連リンクがIssue本文にあると変更履歴の追跡が容易になります。

**推奨対応**:
- Issue #54: extractAssistantResponseBeforeLastPromptの追加対応
- Issue #59: バッファリセット検出の追加対応

への参照リンクを「関連Issue」セクションに追加することを推奨します。

---

### NTH-2: バッファキャプチャサイズの設定

**カテゴリ**: performance
**場所**: `src/lib/assistant-response-saver.ts:119`

**問題**:
SESSION_OUTPUT_BUFFER_SIZEの値（10000行）が大きいセッションで性能に影響する可能性があります。

**推奨対応**:
必要に応じてチューニング可能にすることを検討してください。

---

## テストカバレッジ

### 単体テスト

**ファイル**: `src/lib/__tests__/assistant-response-saver.test.ts`

**カバー対象**:
- savePendingAssistantResponse
- extractAssistantResponseBeforeLastPrompt
- detectBufferReset
- cleanCliResponse

**テストシナリオ**:
- 新規出力がある場合の保存
- 新規出力がない場合のスキップ
- クリーン後の応答が空の場合のスキップ
- タイムスタンプの順序保証
- セッション状態の更新
- WebSocketブロードキャスト
- captureSessionOutput失敗時の例外処理
- セッション状態がない場合のデフォルト動作
- Issue #54修正: 最後のプロンプト前の応答抽出
- Issue #59修正: バッファリセット検出

### インテグレーションテスト

なし（競合状態のテスト追加を推奨）

### E2Eテスト

なし

---

## 参照ファイル

### コード

| ファイル | 関連性 | 重要行 |
|---------|-------|-------|
| `src/app/api/worktrees/[id]/send/route.ts` | 主要変更対象のAPIハンドラー | 22, 109-120, 147 |
| `src/lib/assistant-response-saver.ts` | 新規作成モジュール（Issue #53の核心実装） | 全体 |
| `src/lib/response-poller.ts` | 競合状態検出ロジックの追加 | 544-554, 617-624 |

---

## 結論

Issue #53「Assistant応答の保存ロジックを「次のユーザー入力まで」方式に変更」は、適切に設計・実装されています。

主な変更ポイント:
1. **新しい保存トリガー**: ユーザーメッセージ送信時に前回のAssistant応答を保存
2. **競合状態の防止**: response-pollerとの並行実行時の重複保存を防止
3. **エッジケース対応**: Issue #54、#59でバッファリセット検出等を追加対応

影響範囲は限定的であり、既存のAPIインターフェースやDBスキーマに破壊的変更がないため、リスクレベルは低と評価します。競合状態のインテグレーションテスト追加を推奨しますが、本番運用上の問題は想定されません。
