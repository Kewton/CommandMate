# Issue #518 レビューレポート - Stage 7

**レビュー日**: 2026-03-18
**フォーカス**: 影響範囲レビュー（2回目）
**イテレーション**: 2

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 1 |
| Should Fix | 5 |
| Nice to Have | 2 |
| **合計** | **8** |

## 前回指摘事項（Stage 3）の確認

Stage 3 で指摘した 11 件の全てが Stage 4/6 で適切に反映されていることを確認した。
主要な反映内容:

- **F3-01/F3-02 (must_fix)**: CLI import 制約と HTTP クライアントユーティリティの設計が明記された
- **F3-04 (should_fix)**: current-output API フィールドと wait 終了条件のマッピング表が追加された
- **F5-01 (must_fix, Stage 5)**: isComplete フィールドの誤解が修正された
- **F5-03 (should_fix, Stage 5)**: auto-yes-config.ts の safe-regex2 依存問題が解決された

全件 resolved と判定。

---

## Must Fix（必須対応）

### F7-01: 認証方式の不整合 -- Authorization: Bearer ヘッダーが既存システムで未サポート

**カテゴリ**: 影響範囲
**場所**: 共通仕様 / 認証トークン、HTTP クライアントユーティリティ

**問題**:
Issue では CLI が `Authorization: Bearer <token>` ヘッダーを全 API リクエストに付与する方式を記載している。しかし既存の認証システムは**完全に Cookie ベース**であり、Bearer トークンを受け付けるコードが存在しない。

**証拠**:
- `src/middleware.ts`: `request.cookies.get(AUTH_COOKIE_NAME)` のみで認証判定。Authorization ヘッダーの読み取りなし
- `src/lib/security/auth.ts`: `verifyToken()` 関数は存在するが、HTTP リクエストからのトークン抽出機能なし
- `src/app/api/auth/login/route.ts`: トークン検証後に `response.cookies.set()` で Cookie を設定するフロー
- codebase 全体で `Authorization.*Bearer` のパターンマッチが 0 件

**影響**:
CLI が Issue の記載通りに `Authorization: Bearer` ヘッダーを送信しても、middleware.ts が認証 Cookie を検出できずに /login へリダイレクトするため、認証が必ず失敗する。

**推奨対応**:
以下のいずれかの方針を Issue に明記する:

**(A) 推奨: middleware.ts に Authorization: Bearer サポートを追加**
- middleware.ts の認証チェックで、Cookie が見つからない場合に `Authorization: Bearer` ヘッダーからもトークンを抽出する処理を追加
- `verifyTokenEdge()` を再利用可能なため、改修規模は小さい
- 影響ファイル: `src/middleware.ts`（Bearer トークン抽出の追加）
- この方式は CLI にとって最も自然なフロー

**(B) 代替: CLI 側で Cookie ベースの認証フローを実装**
- CLI が `/api/auth/login` に POST -> Set-Cookie を受信 -> 後続リクエストに Cookie ヘッダーを付与
- Node.js fetch の `credentials` 設定が必要で、Cookie 管理が複雑化する

---

## Should Fix（推奨対応）

### F7-02: 既存 src/lib/api-client.ts との命名に関する注意不足

**カテゴリ**: 影響範囲
**場所**: 共通仕様 / HTTP クライアントユーティリティ

**問題**:
Issue では `src/cli/utils/api-client.ts` の新設を記載しているが、既に `src/lib/api-client.ts`（ブラウザ UI 用）が存在する。同名ファイルが2箇所に存在することで、開発者の混乱や IDE 自動インポートの誤選択リスクがある。

**推奨対応**:
Issue に既存の `src/lib/api-client.ts` との関係を注記する。既存ファイルはブラウザ用（相対 URL）、新設ファイルは CLI 用（絶対 URL）であることを明記する。

---

### F7-03: auto-yes コマンドに --agent オプションが未記載

**カテゴリ**: 影響範囲
**場所**: 実装対象コマンド / 6. commandmate auto-yes

**問題**:
POST /api/worktrees/:id/auto-yes API は `cliToolId` フィールドを受け付け、どの CLI ツールのセッションをポーリングするかを決定する。しかし auto-yes コマンドのオプション一覧に `--agent` がないため、デフォルトの claude 以外のエージェントに対して Auto-Yes を有効化できない。

**証拠**:
`src/app/api/worktrees/[id]/auto-yes/route.ts` 156行目: `const cliToolId: CLIToolType = isValidCliTool(body.cliToolId) ? body.cliToolId : 'claude';`

**推奨対応**:
auto-yes コマンドに `--agent <id>` オプションを追加する。

---

### F7-04: send --auto-yes 時の auto-yes API と send API への cliToolId 同期が未定義

**カテゴリ**: 影響範囲
**場所**: 実装対象コマンド / 2. commandmate send / 内部実装

**問題**:
`send --auto-yes --agent codex` のように指定した場合、auto-yes API と send API の両方に同じ cliToolId を渡す必要があるが、この同期が Issue に明記されていない。

**推奨対応**:
send コマンドの内部実装セクションに「--agent の値を auto-yes API と send API の両方に cliToolId として送信する」旨を追記する。

---

### F7-05: respond コマンドに --agent オプションが未記載

**カテゴリ**: 影響範囲
**場所**: 実装対象コマンド / 4. commandmate respond

**問題**:
prompt-response API は `cliTool` フィールドを受け付けるが、respond コマンドには --agent オプションがない。wait コマンドの exit 10 出力にも cliToolId が含まれていないため、respond コマンドでエージェント種別を伝達する手段がない。

**推奨対応**:
respond コマンドに `--agent <id>` オプションを追加する。または wait コマンドの exit 10 出力に cliToolId を含める（F7-07 参照）。

---

### F7-06: capture コマンドに --agent オプションが未記載

**カテゴリ**: 影響範囲
**場所**: 実装対象コマンド / 5. commandmate capture

**問題**:
current-output API は `?cliTool=codex` クエリパラメータで対象エージェントを切り替え可能だが、capture コマンドには --agent オプションがない。

**証拠**:
`src/app/api/worktrees/[id]/current-output/route.ts` 49-50行目: `const cliToolParam = url.searchParams.get('cliTool');`

**推奨対応**:
capture コマンドに `--agent <id>` オプションを追加する。

---

## Nice to Have（あれば良い）

### F7-07: wait コマンドの exit 10 JSON 出力に cliToolId が未含

**場所**: 実装対象コマンド / 3. commandmate wait / exit 10 時の stdout

**問題**:
exit 10 時の JSON は `{ worktreeId } & PromptData` 形式だが、current-output API レスポンスに含まれる cliToolId が含まれていない。respond コマンドへのパイプライン利用時に、エージェント種別を自動伝播できない。

**推奨対応**:
拡張形式を `{ worktreeId, cliToolId } & PromptData` に変更する。

---

### F7-08: ls --quiet の出力形式が未定義

**場所**: 実装対象コマンド / 1. commandmate ls

**問題**:
`commandmate ls --quiet` で「IDのみ出力」とあるが、具体的な出力形式（改行区切り等）が未定義。シェルスクリプト連携時に重要。

**推奨対応**:
「1行に1つの worktree ID を改行区切りで出力する」等の形式を明記する。

---

## 参照ファイル

### コード
| ファイル | 関連 |
|---------|------|
| `src/middleware.ts` | 認証ミドルウェア。Cookie ベースのみで Bearer 未対応 |
| `src/lib/security/auth.ts` | トークン認証コア |
| `src/lib/api-client.ts` | 既存ブラウザ UI 用 API クライアント |
| `src/app/api/worktrees/[id]/auto-yes/route.ts` | auto-yes API。cliToolId 受付あり |
| `src/app/api/worktrees/[id]/current-output/route.ts` | current-output API。cliTool クエリパラメータ対応 |
| `src/app/api/worktrees/[id]/prompt-response/route.ts` | prompt-response API。cliTool フィールド対応 |
| `src/app/api/auth/login/route.ts` | ログイン API。Cookie 設定フロー |
