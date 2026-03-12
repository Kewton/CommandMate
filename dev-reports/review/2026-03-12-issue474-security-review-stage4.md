# Issue #474 セキュリティレビュー（Stage 4）

**Issue**: #474 メッセージ入力時画像ファイル添付機能
**レビュー日**: 2026-03-12
**レビュー種別**: セキュリティレビュー（OWASP Top 10準拠確認）
**対象文書**: `dev-reports/design/issue-474-image-attachment-design-policy.md`

---

## レビューサマリー

設計方針書のセキュリティ設計は全体として堅牢である。既存の `path-validator.ts`（`isPathSafe` + `resolveAndValidateRealPath`）によるパストラバーサル防御、`upload/route.ts` の7層バリデーション（拡張子、MIME、サイズ、magic bytes、ファイル名、構造検証）、`middleware.ts` による認証保護が適切に活用されている。

ただし、フォールバック方式での `imagePath` 埋め込みによるCLIインジェクション、URLスキーム検証の欠如、`.gitignore` 自動追加の失敗時挙動未定義、孤立ファイルのクリーンアップ未設計など、対処すべきセキュリティリスクが存在する。

---

## OWASP Top 10 カバレッジ

| カテゴリ | ステータス | 詳細 |
|---------|-----------|------|
| A01 アクセス制御の不備 | OK | `middleware.ts` による認証保護が API ルート全体に適用済み。worktree 間のパス分離は `isPathSafe()` で実現。 |
| A02 暗号化の失敗 | OK | 画像ファイルは `.commandmate/attachments/` に保存され、`.gitignore` で追跡除外設計。ローカルファイルシステムのため暗号化は不要。 |
| A03 インジェクション | **RISK** | フォールバック方式でのパス埋め込みにCLIインジェクションリスクあり（S4-M1）。imagePath のホワイトリスト検証が不足（S4-S4）。 |
| A04 安全でない設計 | **RISK** | 孤立ファイル蓄積リスク（S4-S3）。2段階方式のトレードオフとして認識済みだが緩和策が未定義。 |
| A05 セキュリティの設定ミス | **RISK** | `.gitignore` 自動追加の失敗時挙動が未定義（S4-S1）。MIME type スプーフィング対策の明文化不足（S4-S2）。 |
| A06 脆弱なコンポーネント | OK | magic bytes 検証は各形式に対して実装済み。WebP のシグネチャ検証は改善余地あり（S4-N1）だがリスクは低い。 |
| A07 認証・セッション管理の失敗 | OK | `middleware.ts` の認証ミドルウェアが upload/send API を保護。`AUTH_EXCLUDED_PATHS` に upload/send は含まれない。 |
| A08 ソフトウェアとデータの整合性 | OK | ローカル開発ツールのため改ざん検知は過剰。将来的なリモート対応時に再検討（S4-N2）。 |
| A09 セキュリティログとモニタリングの失敗 | OK | 既存コードベースにセキュリティイベントログ（IP制限拒否、symlink traversal 拒否）が実装済み。 |
| A10 SSRF | **RISK** | imagePath に URL スキームが含まれる場合の明示的な拒否処理が未設計（S4-M2）。 |

---

## 指摘事項

### Must Fix（2件）

#### S4-M1: フォールバック方式の imagePath 埋め込みによるCLIインジェクションリスク

**OWASP**: A03 インジェクション

**問題**: フォールバック方式では `[添付画像: ${absoluteImagePath}]` という形式でメッセージにファイルパスを埋め込み、`tmux send-keys` で送信する。ファイル名に tmux send-keys の特殊文字が含まれている場合、意図しない動作につながる可能性がある。現状の `upload/route.ts` では `isValidNewName()` でファイル名バリデーションを行っているが、タイムスタンプリネーム後の最終パスが `send-keys` に安全であることを明示的に保証する設計が必要。

**現在の設計**:
```
フォールバック: `${trimmedContent}\n\n[添付画像: ${absoluteImagePath}]` をそのまま sendMessage に渡す
```

**推奨対応**: `send/route.ts` でフォールバック方式を使う場合、`absoluteImagePath` に制御文字やtmux特殊シーケンスが含まれていないことを追加検証する。具体的には、`absoluteImagePath` が `[\x00-\x1F]` を含まないこと、および `worktree.path + '.commandmate/attachments/'` プレフィックスで始まることを確認するホワイトリスト検証を追加すること。

**影響セクション**: 3. 設計パターン（BaseCLITool デフォルト実装）, 5. API設計（send API）

---

#### S4-M2: imagePath 入力に対するURLスキーム検証の欠如

**OWASP**: A10 SSRF

**問題**: `send/route.ts` に送信される `body.imagePath` に対して、`isPathSafe()` と `resolveAndValidateRealPath()` によるパストラバーサル検証は行われるが、`file://`、`http://`、`https://`、`data:` 等のURLスキームを含む文字列に対する明示的な拒否処理が設計に記載されていない。`path.resolve()` はURLスキーム付き文字列を相対パスとして処理するため、`isPathSafe()` を通過する可能性がある。ローカルツールのため実害は限定的だが、防御的プログラミングとして明示的に拒否すべき。

**現在の設計**: `isPathSafe()` + `resolveAndValidateRealPath()` のみ

**推奨対応**: `send/route.ts` の imagePath バリデーションの冒頭で、`/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(body.imagePath)` によるURLスキーム検出を追加し、マッチした場合は400エラーを返す。

**影響セクション**: 6. セキュリティ設計（パストラバーサル防御）

---

### Should Fix（4件）

#### S4-S1: .gitignore 自動追加の実装タイミングと失敗時の挙動が未定義

**OWASP**: A05 セキュリティの設定ミス

**問題**: 設計書では `.commandmate/attachments/` を `.gitignore` に自動追加すると記載されているが、追加のタイミング（upload時かディレクトリ作成時か）、`.gitignore` が存在しない場合の作成、追加が失敗した場合のエラーハンドリング、既に追加済みの場合の重複チェックが未定義。追加が失敗した場合、画像ファイルが git にコミットされ、スクリーンショットに含まれるAPI鍵や個人情報等がリモートリポジトリに漏洩するリスクがある。

**推奨対応**: `.commandmate/attachments/` ディレクトリの自動作成時（S3-S2）に `.gitignore` 更新も行う。失敗時はアップロード処理を中断してエラーを返す（fail-safe）。

---

#### S4-S2: MIME type スプーフィング対策の明文化不足

**OWASP**: A05 セキュリティの設定ミス

**問題**: 既存の magic bytes 検証がMIME typeスプーフィングを補完しているが、設計書のセキュリティ設計セクション（Section 6）にMIME typeスプーフィングへの対策方針が明示されていない。

**推奨対応**: セキュリティ設計セクションのチェック表に「MIME typeスプーフィング対策: magic bytes検証で二重チェック済み」を追加し、MIME type 単体では信頼しない方針を明文化する。

---

#### S4-S3: アップロード後の send 失敗時に孤立ファイルが蓄積するリスク

**OWASP**: A04 安全でない設計

**問題**: 2段階方式（upload -> send）では、ステップ1でアップロード成功後にステップ2の send が失敗した場合、`.commandmate/attachments/` に孤立ファイルが蓄積する。設計書のトレードオフセクションで「クリーンアップ未実装」と認識されているが、蓄積によるディスク圧迫リスクに対する緩和策が未定義。

**推奨対応**: 以下のいずれかを設計に追加:
1. 一定期間（例: 24時間）経過した孤立ファイルを定期クリーンアップするバッチ処理の設計方針を記載
2. `.commandmate/attachments/` ディレクトリの合計サイズ上限を設け、超過時は古いファイルから削除
3. 将来の Issue として孤立ファイルクリーンアップを明示的にスコープアウトする旨を記載

---

#### S4-S4: imagePath のホワイトリスト検証（.commandmate/attachments/ プレフィックス）の未設計

**OWASP**: A03 インジェクション

**問題**: `send/route.ts` の imagePath バリデーションでは `isPathSafe()` と `resolveAndValidateRealPath()` を使用して worktree 外へのアクセスを防いでいるが、worktree 内の任意のファイルパスを imagePath として指定できてしまう。例えば `.env` や `src/config/auth-config.ts` など、画像以外のファイルパスが指定された場合、フォールバック方式ではそのパスが CLI ツールに送信される。

**推奨対応**: `send/route.ts` で imagePath が `.commandmate/attachments/` プレフィックスで始まることをホワイトリスト検証する。加えて、拡張子が `ATTACHABLE_IMAGE_EXTENSIONS` に含まれることも検証する。

---

### Nice to Have（3件）

#### S4-N1: WebP magic bytes 検証の完全性

**OWASP**: A06 脆弱なコンポーネント

`uploadable-extensions.ts` の WebP magic bytes 定義は RIFF ヘッダ（4バイト）のみの検証。RIFF ヘッダは AVI 等の他フォーマットでも使用されるため、オフセット8-11 の WEBP シグネチャまで検証することが望ましい。`image-extensions.ts` には `validateWebPMagicBytes()` が完全検証を実装済みなので、共通化を検討。

---

#### S4-N2: アップロード後の画像ファイル改ざん検知

**OWASP**: A08 ソフトウェアとデータの整合性

upload 完了後から send 実行までの間にファイルシステム上の画像ファイルが改ざんされるリスクがある。ローカル開発ツールのため脅威レベルは低く、現時点ではスコープ外として許容可能。

---

#### S4-N3: 他の worktree の画像ファイルへの横断アクセス防止の明示

**OWASP**: A01 アクセス制御の不備

`isPathSafe(body.imagePath, worktree.path)` により imagePath は当該 worktree のルートディレクトリ配下に制限されるため、他の worktree の画像にはアクセスできない。この防御が機能していることをセキュリティ設計セクションに明記すると、レビュアーの理解が容易になる。

---

## コードベース確認結果

### middleware.ts（認証保護）

- upload API (`/api/worktrees/[id]/upload/[...path]`) および send API (`/api/worktrees/[id]/send`) は `middleware.ts` の matcher パターン `/((?!_next/|favicon\\.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)` にマッチするため、認証保護の対象である。
- `AUTH_EXCLUDED_PATHS` には `/login`、`/api/auth/*` のみが含まれ、upload/send API は除外されていない。
- **結論**: 認証なしで upload/send API にアクセスすることはできない（A07 OK）。

### path-validator.ts（パストラバーサル防御）

- `isPathSafe()`: null byte インジェクション検出、URL デコード、`..` トラバーサル検出を実装。
- `resolveAndValidateRealPath()`: symlink 経由のトラバーサル防御、存在しないパスの祖先ディレクトリ検証を実装。
- **結論**: パストラバーサル防御は堅牢（A03 の基本防御は OK）。

### upload/route.ts（アップロードバリデーション）

- 7層バリデーション: 拡張子ホワイトリスト、MIME type、ファイルサイズ、magic bytes、ファイル名、構造検証（YAML/JSON）、パス安全性。
- **結論**: アップロード時のバリデーションは十分。

### send/route.ts（メッセージ送信）

- 現状 `imagePath` パラメータは未実装（設計段階）。
- 既存の `sendMessage` は `body.content` をそのまま tmux `send-keys` に渡している。tmux.ts の `sendKeys()` は `execFile()` を使用しており、シェルインジェクションは防止されている。
- **結論**: tmux 経由のシェルインジェクションリスクは低いが、tmux send-keys 自体の特殊文字処理に注意が必要（S4-M1）。

---

## 実装チェックリスト（Stage 4）

- [ ] send/route.ts の imagePath バリデーションに URL スキーム拒否処理を追加 [S4-M2]
- [ ] send/route.ts のフォールバック方式で absoluteImagePath の制御文字検証を追加 [S4-M1]
- [ ] send/route.ts で imagePath が `.commandmate/attachments/` プレフィックスであることをホワイトリスト検証 [S4-S4]
- [ ] .gitignore 自動追加の実装タイミング・失敗時挙動を設計書に追記 [S4-S1]
- [ ] セキュリティ設計セクションに MIME type スプーフィング対策方針を追記 [S4-S2]
- [ ] 孤立ファイルクリーンアップの方針（実装 or スコープアウト）を設計書に追記 [S4-S3]

---

## 指摘件数サマリー

| 重要度 | 件数 |
|--------|------|
| Must Fix | 2 |
| Should Fix | 4 |
| Nice to Have | 3 |
| **合計** | **9** |

---

*Generated by architecture-review-agent (Stage 4: Security Review)*
*Review date: 2026-03-12*
