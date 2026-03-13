# Issue #490 Stage 1 レビューレポート

**レビュー日**: 2026-03-13
**フォーカス**: 通常レビュー（Consistency & Correctness）
**イテレーション**: 1回目
**対象Issue**: ファイル内容表示にてhtmlファイル レンダリング

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 1 |
| Should Fix | 4 |
| Nice to Have | 3 |

**総合評価**: acceptable

Issue #490は全体として技術的に妥当な提案であり、既存コードパターン（isImage/isVideo、MarkdownEditor 3モード）との整合性が高い。ただし、MARPとの類似性に関する記述の誤解リスク、editable-extensions追加時のバリデーター未記載、ファイルサイズ上限の未確定、sandbox Fullレベルのセキュリティリスク説明不足など、実装者が迷うポイントがいくつか存在する。

---

## Must Fix（必須対応）

### S1-005: APIレスポンスでのHTML判定とisHtmlフラグ設定の実装詳細が不足

**カテゴリ**: 完全性

**問題**:
実装タスクに「route.tsにHTML判定ロジック追加」とあるが、具体的に何をすべきかが不明瞭。既存の`route.ts`のGETハンドラでは、isImage/isVideoの場合のみバイナリ読み込み+Base64変換の特別処理を行い、それ以外はテキスト読み込みを行う。HTMLファイルはテキストとして既に正常に取得可能であるため、API側で必要な変更は「レスポンスにisHtml: trueフラグを付与する」ことだけ。

しかし、フラグ付与には新規作成する`html-extensions.ts`の`isHtmlExtension()`をimportして判定を追加する必要がある。この具体的な実装箇所（テキスト読み込みのNextResponse.jsonにisHtmlフラグを追加する行、289-301行目付近）がIssueに明記されていない。

**証拠**:
- `src/app/api/worktrees/[id]/files/[...path]/route.ts` L290: テキストファイルのレスポンス箇所にisHtmlフラグがない
- isImageは画像判定時にL190で`isImage: true`を付与、isVideoはL247で`isVideo: true`を付与するパターンが既に存在

**推奨対応**:
route.tsの変更内容を具体化する: 「GET ハンドラの非画像・非動画パスにおいて、拡張子がHTML拡張子の場合にレスポンスに `isHtml: true` を追加する。HTMLファイルは既存のテキスト読み込みロジックで処理し、バイナリ変換は不要。」

---

## Should Fix（推奨対応）

### S1-001: MARPとの実装パターン相違点が未記載

**カテゴリ**: 正確性

**問題**:
Issueでは「iframe + sandbox属性を使用（MARPスライドと同じパターン）」と記載されているが、実装パターンは本質的に異なる:

- **MARP**: サーバーサイドAPI（POST `/api/worktrees/[id]/marp-render`）でMarkdownをHTMLに変換 -> クライアントがiframe srcDocに設定
- **HTMLプレビュー**: 既存ファイル取得API（GET `/api/worktrees/[id]/files/...`）で取得した生HTMLテキスト -> クライアントがそのままiframe srcDocに設定

実装者がMARPのようにサーバーサイドAPIを新設する必要があると誤解する可能性がある。

**証拠**:
- `src/app/api/worktrees/[id]/marp-render/route.ts`: POST APIでHTML生成するサーバーサイドパターン
- 仮説検証レポートでも「Partially Confirmed」として同様の指摘あり

**推奨対応**:
「レンダリング方式」セクションにて、MARPとの違いを明記する。例: 「MARPと異なりサーバーサイドAPIは不要。既存のファイル取得APIが返すHTMLテキストをそのままiframe srcDocに設定する。」

---

### S1-002: editable-extensions追加時のEXTENSION_VALIDATORS設定が未記載

**カテゴリ**: 完全性

**問題**:
Issueでは「editable-extensions.tsに.html, .htmを追加」と記載されているが、既存の実装では`EDITABLE_EXTENSIONS`配列への追加だけでなく`EXTENSION_VALIDATORS`配列にもバリデーターエントリを追加する必要がある。

現在`.md`のみ`maxFileSize: 1MB`で定義されている。HTML用のバリデーターエントリ（maxFileSize、additionalValidation）が未定義の場合、`validateContent()`が`'Unsupported extension'`エラーを返してPUT `/files/...` による保存が失敗する。

**証拠**:
- `src/config/editable-extensions.ts` L74-79: `validateContent()`はバリデーターが見つからない場合`{ valid: false, error: 'Unsupported extension' }`を返す
- `src/app/api/worktrees/[id]/files/[...path]/route.ts` L337-341: PUT時に`validateContent()`を呼び出す

**推奨対応**:
実装タスクに以下を追加:
- `EXTENSION_VALIDATORS`配列に`.html`と`.htm`のエントリを追加（maxFileSize、additionalValidationの仕様決定含む）

---

### S1-003: ファイルサイズ上限が未確定

**カテゴリ**: 明確性

**問題**:
セキュリティ考慮セクションに「ファイルサイズ上限の設定（検討: 5-10MB）」と記載があるが、具体的な値が未確定のまま。この上限はiframe srcDocに巨大HTMLを読み込ませた際のブラウザパフォーマンス・メモリ問題に直結するため、受入条件として値を確定させるべき。

**推奨対応**:
ファイルサイズ上限を確定させる（推奨: 画像と同じ5MB = `IMAGE_MAX_SIZE_BYTES`と統一）。確定値を受入条件に追加する。例: 「5MBを超えるHTMLファイルはプレビュー表示せず、ソースコード表示のみとする」

---

### S1-004: sandbox Fullレベル（allow-same-origin）のリスク説明不足

**カテゴリ**: セキュリティ

**問題**:
サンドボックスレベルFullは`sandbox="allow-scripts allow-same-origin"`を設定するが、`allow-scripts` + `allow-same-origin`の組み合わせはiframe内のスクリプトが親ページのDOMやCookieにアクセス可能になるため、sandbox属性を実質無効化する危険な組み合わせとして知られている（MDN Web Docsにも警告あり）。

Issueのセキュリティ考慮セクションではこのリスクに言及がなく、「allow-top-navigationは付与しない」という記載のみ。

**推奨対応**:
以下のいずれかの対策をIssueに追記する:
1. Fullレベル使用時に警告ダイアログを表示する
2. `srcdoc`ではなく`blob:` URLを使い、originを分離する（allow-same-originの影響を軽減）
3. Fullレベルを廃止して`allow-scripts`のみ（2段階: Safe / Interactive）に簡素化する

---

## Nice to Have（あれば良い）

### S1-006: DOMPurify基盤の活用方針が不明確

**カテゴリ**: 完全性

セキュリティ考慮に「既存のDOMPurify基盤を必要に応じて活用」とあるが、iframe srcDocパターンではDOMPurifyでのサニタイズはHTMLの構造を破壊する可能性がある。sandbox属性による隔離で安全性を担保する方針を明記することを推奨。

---

### S1-007: html-extensions.tsの設計パターンの明示

**カテゴリ**: 整合性

新規作成するhtml-extensions.tsの最小API仕様を記載すると良い: `HTML_EXTENSIONS`配列、`isHtmlExtension()`関数、`HTML_MAX_SIZE_BYTES`定数。image-extensions.tsほど複雑な構造（magic bytes検証等）は不要な旨も付記。

---

### S1-008: モバイル版FileViewerでの3モード切り替えUI仕様が未記載

**カテゴリ**: 完全性

PC版FilePanelContentでは3モードが提案されているが、モバイル版FileViewerはモーダル内レンダリングであり、分割表示はスペース的に困難。タブ切り替え方式（MarkdownEditorのmobileTab方式）にするか、プレビューのみにするかを明記すると実装が円滑になる。

---

## 参照ファイル

### コード
| ファイル | 関連性 |
|---------|--------|
| `src/components/worktree/FilePanelContent.tsx` | HTML用表示分岐の追加先。既存のisImage/isVideo/extension判定パターンを参照 |
| `src/components/worktree/MarkdownEditor.tsx` | 3モード（ソース/プレビュー/分割）の参照実装 |
| `src/components/worktree/FileViewer.tsx` | モバイル版での表示分岐追加先 |
| `src/config/editable-extensions.ts` | EDITABLE_EXTENSIONSとEXTENSION_VALIDATORS両方への追加が必要 |
| `src/config/image-extensions.ts` | html-extensions.tsの設計パターン参照 |
| `src/types/models.ts` | FileContentインターフェースへのisHtml追加先 |
| `src/app/api/worktrees/[id]/files/[...path]/route.ts` | GETハンドラのテキスト読み込みパスにisHtmlフラグ追加 |
| `src/lib/security/sanitize.ts` | DOMPurify基盤の確認 |
