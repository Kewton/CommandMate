# Issue #474 レビューレポート

**レビュー日**: 2026-03-12
**フォーカス**: 通常レビュー
**イテレーション**: 2回目（Stage 5）

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 0 |
| Should Fix | 2 |
| Nice to Have | 2 |

Stage 1の全指摘事項（Must Fix 2件、Should Fix 4件）が適切に反映されていることを確認した。Issueは実装に必要な情報が概ね揃っており、重大な問題は残っていない。新規の指摘は、既存upload APIとの関係の明確化および.gitignoreエントリの具体化の2件（Should Fix）と、軽微な補足事項2件（Nice to Have）に留まる。

---

## 前回指摘事項の確認

| ID | タイトル | ステータス |
|----|---------|-----------|
| S1-M1 | 変更対象ファイルリストにgemini.tsが欠落 | 解決済み - gemini.ts、opencode.ts、vibe-local.tsが追加されている |
| S1-M2 | SVGファイルの画像添付方針が未定義 | 解決済み - 受入条件にSVG方針が明記されている（実装時判断） |
| S1-S1 | CLIツール固有の画像送信方式に関する具体性不足 | 解決済み - ブロッキングタスクとして明示されている |
| S1-S2 | 画像ファイルサイズ上限の受入条件への未記載 | 解決済み - 5MB上限がバリデーション条件として追加されている |
| S1-S3 | ICLIToolインターフェース拡張の後方互換性への言及不足 | 解決済み - BaseCLIToolデフォルト実装方針が後方互換性セクションに記載されている |
| S1-S4 | フォールバック方式の画像保存先パスが未定義 | 解決済み - .commandmate/attachments/が明記され、.gitignore追加タスクも含まれている |

---

## Should Fix（推奨対応）

### S5-S1: 既存upload APIとの関係が不明確

**カテゴリ**: 整合性
**場所**: 実装タスク - 画像アップロード用APIエンドポイント作成

**問題**:
Issueでは画像アップロード用APIエンドポイントの作成を実装タスクとしているが、既存の `/api/worktrees/[id]/upload/[...path]/route.ts` がすでに存在する。既存APIはmultipart/form-dataでファイルアップロードを受け付け、拡張子バリデーション、magic bytesチェック、パストラバーサル防御を実装済みである。新規エンドポイントを作成するのか、既存エンドポイントを拡張するのかの方針が明確でない。

**証拠**:
- `src/app/api/worktrees/[id]/upload/[...path]/route.ts` が存在し、`isUploadableExtension`/`validateMimeType`/`validateMagicBytes`によるバリデーションを実装済み
- Issueのタスクには「画像アップロード用APIエンドポイント作成（または既存upload APIを拡張）」と曖昧な記載がある
- 関連コンポーネント欄に「既存のアップロードAPI」への言及はあるが、再利用範囲が不明

**推奨対応**:
実装タスクの記述を具体化する。既存の `/api/worktrees/[id]/upload/[...path]/` を拡張して `.commandmate/attachments/` への保存をサポートするのか、別途 `/api/worktrees/[id]/upload-image/` のような専用エンドポイントを新設するのかを明記する。既存の `uploadableExtensions` と `image-extensions.ts` の使い分けも検討事項として記載すると実装時の判断が容易になる。

---

### S5-S2: .gitignore対象の記載と実態の確認

**カテゴリ**: 整合性
**場所**: 実装タスク - .commandmate/attachments/ を .gitignore に追加

**問題**:
Issueでは `.commandmate/attachments/` のgitignore対象ディレクトリと記載し、実装タスクに `.gitignore` への追加が含まれているが、現在の `.gitignore` には `.commandmate` ディレクトリに関するエントリが一切ない。`.commandmate` ディレクトリは既存コード（`db-path-resolver.ts` 等）で使用されているが、gitignoreには含まれていない。`attachments` サブディレクトリのみを追加するのか、`.commandmate/` 全体を追加するのかの判断が必要。

**証拠**:
- 現在の `.gitignore` に `.commandmate` 関連エントリなし
- `src/lib/db-path-resolver.ts` 等で `.commandmate` ディレクトリが使用されている

**推奨対応**:
`.commandmate/attachments/` のみをgitignoreに追加する方針を明記する。`.commandmate` ディレクトリ内にはDBマイグレーション等の重要ファイルが含まれる可能性があるため、`attachments` サブディレクトリのみの追加が安全である。実装タスクの記述を「`.commandmate/attachments/` を `.gitignore` に追加する（`.commandmate/` 全体は対象外）」のように具体化する。

---

## Nice to Have（あれば良い）

### S5-N1: 画像添付後のクリーンアップ方針

**カテゴリ**: 完全性
**場所**: 提案する解決策 - フォールバック方式

**問題**:
`.commandmate/attachments/` に保存された画像ファイルの削除タイミングやクリーンアップ方針が記載されていない。画像がworktree内に蓄積し続けるとディスク容量の問題が生じる可能性がある。

**推奨対応**:
初期実装ではクリーンアップを行わず、将来の改善として「セッション終了時やworktree削除時に `.commandmate/attachments/` を削除する」等の方針を記載するか、スコープ外として明示する。

---

### S5-N2: api-client.tsの変更内容の具体化

**カテゴリ**: 明確性
**場所**: 影響範囲 - api-client.ts

**問題**:
影響範囲テーブルに `src/lib/api-client.ts` が「sendMessageに画像パラメータ追加」として記載されているが、現在の `sendMessage` 関数は `content: string` と `cliToolId?: CLIToolType` のみを受け取る。`imagePath` パラメータの追加方法が未記載。

**推奨対応**:
`sendMessage(id, content, cliToolId, imagePath?)` のように引数追加するか、`sendMessage(id, options: { content, cliToolId?, imagePath? })` のようにオプションオブジェクトに変更するかを明記する。後者の方が将来の拡張性は高いが、既存の呼び出し箇所の変更が必要になる。

---

## 参照ファイル

### コード
- `src/app/api/worktrees/[id]/upload/[...path]/route.ts`: 既存のファイルアップロードAPI
- `src/app/api/worktrees/[id]/send/route.ts`: メッセージ送信API（imagePath追加対象）
- `src/lib/api-client.ts`: クライアント側API（sendMessage関数変更対象）
- `src/lib/cli-tools/base.ts`: BaseCLITool（デフォルト実装追加先）
- `src/lib/cli-tools/types.ts`: ICLIToolインターフェース（画像対応メソッド拡張対象）
- `src/config/image-extensions.ts`: 画像拡張子・バリデーション（再利用対象）
- `.gitignore`: .commandmate/attachments/ 追加対象
- `src/components/worktree/MessageInput.tsx`: 画像添付ボタン追加対象

### ドキュメント
- `CLAUDE.md`: モジュールリファレンス（変更対象ファイルの正確性確認）
