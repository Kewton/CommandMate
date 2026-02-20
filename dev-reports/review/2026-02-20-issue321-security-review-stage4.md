# Issue #321 セキュリティレビュー (Stage 4)

**Issue**: #321 メモのコピー機能
**レビュー種別**: セキュリティレビュー (Stage 4)
**日付**: 2026-02-20
**ステータス**: approved
**スコア**: 5/5

---

## 1. エグゼクティブサマリー

Issue #321「メモのコピー機能」の設計方針書に対するセキュリティレビューを実施した。本変更はMemoCardコンポーネントにコピーボタンを追加し、既存の`copyToClipboard()`ユーティリティを利用してメモのcontentフィールドをクリップボードに書き込む機能である。

**総合評価**: セキュリティ上の懸念なし。変更はプレゼンテーション層のクライアントサイドに完全に閉じており、サーバーサイドの変更が一切ない。Clipboard APIの利用は既存4箇所の実装パターンと一貫しており、OWASP Top 10の全カテゴリで問題は認められなかった。

---

## 2. レビュー対象

### レビュー対象ファイル

| ファイル | レビュー観点 |
|---------|------------|
| `src/lib/clipboard-utils.ts` | ANSI除去ロジック、空文字バリデーション、Clipboard API呼び出し |
| `src/components/worktree/MemoCard.tsx` | 現在の実装とコピー機能追加箇所 |
| `src/components/worktree/FileViewer.tsx` | 既存copyToClipboard()利用パターンの確認 |
| `src/components/worktree/MarkdownEditor.tsx` | 既存copyToClipboard()利用パターンの確認 |
| `src/components/worktree/HistoryPane.tsx` | 既存copyToClipboard()利用パターンの確認 |
| `src/lib/cli-patterns.ts` | ANSI_PATTERNの定義とSEC-002既知制限 |
| `src/lib/__tests__/clipboard-utils.test.ts` | テストカバレッジの確認 |
| `src/app/api/worktrees/[id]/memos/route.ts` | サーバーサイドバリデーション |
| `src/app/api/worktrees/[id]/memos/[memoId]/route.ts` | サーバーサイドバリデーション |
| `src/types/models.ts` | WorktreeMemo型定義 |
| `next.config.js` | CSP・Permissions-Policy・セキュリティヘッダー |
| `dev-reports/design/issue-321-memo-copy-design-policy.md` | セキュリティ設計セクション |

---

## 3. OWASP Top 10 チェックリスト

| # | カテゴリ | 判定 | 詳細 |
|---|---------|------|------|
| A01 | Broken Access Control | N/A | サーバーサイドの変更なし。コピーはクライアントサイドのみ |
| A02 | Cryptographic Failures | N/A | 暗号化処理の変更なし |
| A03 | Injection | PASS | `writeText()`はプレーンテキスト書き込みのみ。HTML/DOM挿入なし。ANSI除去あり |
| A04 | Insecure Design | PASS | 2段階防御（UI側ガード + ライブラリ側バリデーション）。タイマークリーンアップ対応 |
| A05 | Security Misconfiguration | PASS | CSPヘッダー適切。Secure Context要件充足 |
| A06 | Vulnerable and Outdated Components | PASS | 新たな依存関係の追加なし。既存ユーティリティの再利用 |
| A07 | Identification and Authentication Failures | N/A | 認証・認可の変更なし |
| A08 | Software and Data Integrity Failures | PASS | コピー操作は読み取り専用。DB変更なし |
| A09 | Security Logging and Monitoring Failures | N/A | プレゼンテーション層のみでログ記録は不要 |
| A10 | Server-Side Request Forgery | N/A | サーバーサイドリクエストの変更なし |

---

## 4. セキュリティ詳細分析

### 4.1 Clipboard API セキュリティ

**評価**: 適切

`navigator.clipboard.writeText()`はWeb標準のClipboard APIであり、以下のセキュリティ制約により保護されている。

- **Secure Context要件**: HTTPS or localhost でのみ動作。HTTP接続では自動的に利用不可
- **ユーザージェスチャー要件**: ユーザーのクリック操作をトリガーとして呼び出される設計
- **CSP互換性**: 既存CSP（`default-src 'self'`）はClipboard APIの動作を阻害しない。Clipboard APIはCSPのフェッチディレクティブとは独立して動作する

**既存の利用箇所との一貫性**:

```
FileViewer.tsx       -- copyToClipboard(content.content)  -- サイレントエラー
MarkdownEditor.tsx   -- copyToClipboard(content)          -- サイレントエラー
HistoryPane.tsx      -- copyToClipboard(content)          -- Toast通知
LogViewer.tsx        -- copyToClipboard(...)              -- Toast通知
MemoCard.tsx (新規)  -- copyToClipboard(content)          -- サイレントエラー
```

MemoCardはFileViewer/MarkdownEditorのサイレントエラーパターンを踏襲しており、一貫性がある。

### 4.2 ANSIエスケープコード除去

**評価**: 十分

`clipboard-utils.ts`の`stripAnsi()`関数は以下のパターンをカバーする。

```typescript
const ANSI_PATTERN = /\x1b\[[0-9;]*[a-zA-Z]|\x1b\][^\x07]*\x07|\[[0-9;]*m/g;
```

- **SGRシーケンス**: `ESC[Nm` (色、太字、下線等)
- **OSCシーケンス**: `ESC]...BEL` (ウィンドウタイトル、ハイパーリンク等)
- **CSIシーケンス**: `ESC[...letter` (カーソル移動、消去等)

**SEC-002既知制限**: 8-bit CSI (0x9B)、DEC private modes、Character set switching、一部RGB color形式は未対応。

**メモ機能におけるリスク評価**: メモのcontentはユーザーが手動でテキストエリアに入力するデータである。ターミナル出力やCLIログとは異なり、ANSIエスケープシーケンスが混入する可能性は実質的にゼロである。`stripAnsi()`はdefense-in-depthとして存在するが、メモ機能に限定すれば既知制限によるリスクはない。

### 4.3 入力バリデーション

**評価**: 適切

メモcontentに対する入力バリデーションは多層防御で実装されている。

| 層 | バリデーション | 場所 |
|----|--------------|------|
| サーバーサイド | `MAX_CONTENT_LENGTH = 10000` 文字制限 | `src/app/api/worktrees/[id]/memos/route.ts` (L18, L91-96) |
| サーバーサイド | `MAX_CONTENT_LENGTH = 10000` 文字制限 | `src/app/api/worktrees/[id]/memos/[memoId]/route.ts` (L15, L62-68) |
| クライアントUI | `!content` ガード（空文字チェック） | MemoCard.tsx `handleCopy` |
| クリップボードライブラリ | `text.trim().length === 0` 空白文字チェック | `clipboard-utils.ts` (L30) |
| クリップボードライブラリ | `stripAnsi()` ANSIコード除去 | `clipboard-utils.ts` (L34) |

2段階防御設計（UI側ガード + ライブラリ側バリデーション）は設計方針書に明記されており、適切である。

### 4.4 XSS防止

**評価**: 適切

コピー操作に関するXSSリスクは以下の理由で極めて低い。

1. **`navigator.clipboard.writeText()`はプレーンテキスト書き込み**: HTMLコンテンツとしてクリップボードに書き込まれることはない
2. **DOM挿入なし**: コピー操作はテキストをクリップボードに書き込むのみで、HTML/DOMへの挿入を伴わない
3. **Reactの自動エスケープ**: JSX内のテキスト表示はReactによりXSSエスケープされる
4. **ANSI除去**: `stripAnsi()`によりエスケープシーケンスが除去される

仮にユーザーが`<script>alert('xss')</script>`のようなテキストをメモに入力しても:
- DB保存時: SQLiteのprepared statementでSQLインジェクションが防止される
- UI表示時: ReactのJSXが自動エスケープする
- クリップボード書き込み時: プレーンテキストとして書き込まれるため、貼り付け先がHTMLコンテキストでない限り実行されない

### 4.5 情報漏洩リスク

**評価**: 許容可能

クリップボードへの書き込みは以下の条件で制御されている。

- **ユーザー起動のみ**: コピーボタンのクリックイベントでのみ発生。自動コピーやバックグラウンドコピーは存在しない
- **ユーザー自身のデータ**: メモcontentはユーザーが自分で入力したテキストであり、外部データやシステム情報のコピーではない
- **サイレントエラー**: 失敗時にエラーメッセージを表示しないため、環境情報の漏洩リスクがない
- **ログ出力なし**: コピー操作はconsole.log等でcontentをログ出力しない

### 4.6 CSPの影響

**評価**: 影響なし

`next.config.js`に設定されているCSPヘッダー:

```
default-src 'self';
script-src 'self' 'unsafe-inline' 'unsafe-eval';
style-src 'self' 'unsafe-inline';
img-src 'self' data: blob:;
media-src 'self' data:;
font-src 'self' data:;
connect-src 'self' ws: wss:;
frame-ancestors 'none';
```

Clipboard API (`navigator.clipboard.writeText()`)はCSPのフェッチディレクティブ(`connect-src`, `default-src`等)とは独立して動作するWebプラットフォームAPIである。既存のCSP設定はClipboard APIの動作を阻害しない。

---

## 5. 設計方針書のセキュリティセクション評価

設計方針書Section 8「セキュリティ設計」の記載を評価する。

| 設計書の記載 | 評価 |
|------------|------|
| XSS: ANSIエスケープコード除去、DOM挿入なし | 正確。適切にリスク分析されている |
| 入力バリデーション: SF-S4-1空文字バリデーション | 正確。2段階防御が適切に設計されている |
| Clipboard API: Secure Context要件 | 正確。HTTPS/localhost制約を正しく認識している |

設計書のセキュリティ記載は簡潔ながら要点を押さえており、過不足なく適切である。

---

## 6. リスクアセスメント

| リスク種別 | 内容 | 影響度 | 発生確率 | 対策優先度 |
|-----------|------|--------|---------|-----------|
| XSS | コピーされたテキストがHTML文脈に貼り付けられる | Low | Low | P3 |
| 情報漏洩 | メモ内容がクリップボード経由で漏洩 | Low | Low | P3 |
| ANSI残留 | SEC-002既知制限によるANSIシーケンスの残留 | Low | Very Low | P3 |
| API無効 | Secure Context外でのClipboard API利用不可 | Low | Low | P3（既存パターンと同一） |

全てのリスクがLow以下であり、本変更による新たなセキュリティリスクの導入はない。

---

## 7. 指摘事項

### 7.1 Nice to Have (検討事項)

#### S4-001: ANSI_PATTERNのSEC-002既知制限

**カテゴリ**: ANSI除去の網羅性

`clipboard-utils.ts`の`ANSI_PATTERN`は8-bit CSI (0x9B)、DEC private modes、Character set switching、一部RGB color形式をカバーしていない。メモ機能（ユーザー手動入力テキスト）に限定すればリスクは実質ゼロだが、将来的に`strip-ansi` npmパッケージの導入を検討する価値はある。

**対応**: 現状のまま許容可能。`cli-patterns.ts`のSEC-002コメントに将来対応方針が既に記載されている。

#### S4-002: Permissions-Policyへのclipboard-write明示

**カテゴリ**: Permissions-Policy

`next.config.js`の`Permissions-Policy`ヘッダーにはcamera, microphone, geolocationのみが制限されている。`clipboard-write=(self)`を明示的に追加することで、サードパーティiframe等からのクリップボードアクセスを明示的に制御できる。

**対応**: 本Issue #321のスコープ外。現状のCSPとSecure Context要件で十分に保護されている。別Issueでの対応を推奨。

#### S4-003: サイレントエラーの設計妥当性確認

**カテゴリ**: エラーハンドリング

`handleCopy`のcatchブロックがエラーを握りつぶすサイレントエラー設計は、エラーメッセージによる環境情報漏洩を防止する意味でセキュリティ的に適切である。FileViewerの既存パターンとも一貫している。

**対応**: 現状で問題なし。確認的指摘のみ。

---

## 8. 既存テストカバレッジの確認

`src/lib/__tests__/clipboard-utils.test.ts`で以下のセキュリティ関連テストが既に実装されている。

| テスト | セキュリティ観点 |
|-------|----------------|
| `should strip ANSI escape codes before copying` | ANSI除去の動作確認 |
| `should handle multiple ANSI codes in text` | 複数ANSIコードの除去確認 |
| `should not call clipboard API for empty string` | 空文字バリデーション |
| `should not call clipboard API for whitespace-only string` | 空白文字バリデーション |
| `should throw error if clipboard API fails` | エラー伝播の確認 |
| `should handle text with special characters` | 特殊文字の安全な処理確認 |

テストカバレッジはセキュリティ観点で十分である。設計方針書のテストケース5a/5b（空コンテンツ時の振る舞い）により、MemoCard側の2段階防御もテストされる。

---

## 9. 総合判定

| 項目 | 判定 |
|------|------|
| OWASP Top 10準拠 | 全項目PASS/N/A |
| Clipboard APIセキュリティ | 適切 |
| ANSI除去 | 十分 |
| 入力バリデーション | 多層防御で適切 |
| XSS防止 | 適切 |
| CSP影響 | なし |
| 情報漏洩リスク | 許容可能 |
| **総合評価** | **approved (5/5)** |

本変更は既存の確立されたパターンを再利用するプレゼンテーション層のみの変更であり、新たなセキュリティリスクを導入しない。設計方針書のセキュリティ記載も適切である。

---

## 10. 指摘事項サマリー

| ID | 重要度 | カテゴリ | タイトル | 対応推奨 |
|----|--------|---------|---------|---------|
| S4-001 | Nice to Have | ANSI除去 | ANSI_PATTERNのSEC-002既知制限 | スコープ外（既存課題） |
| S4-002 | Nice to Have | Permissions-Policy | clipboard-write明示の検討 | スコープ外（別Issue推奨） |
| S4-003 | Nice to Have | エラーハンドリング | サイレントエラー設計の妥当性 | 対応不要（確認的指摘） |

**Must Fix**: 0件
**Should Fix**: 0件
**Nice to Have**: 3件

---

*Generated by architecture-review-agent for Issue #321 Stage 4 Security Review*
*Date: 2026-02-20*
