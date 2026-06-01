## 概要

PC版で数MB以上の大規模ファイルを開くとUIがハングして操作不能になる問題に対し、**閲覧用途と編集用途で別戦略を採用する**ハイブリッド方式で根本対応する。

- **閲覧専用ファイル（コードビューア用途）**: 行ベースAPI（部分読み込み）＋ 仮想スクロール
- **編集系ファイル（Markdown / YAML / HTML 等）**: 従来通り全文読み込み ＋ サーバ側サイズ上限

## 背景（現状の問題）

数MBのテキストファイルをファイルパネルで開くと、以下が連鎖的にメインスレッドを長時間ブロックして実質ハングする。

| # | 箇所 | 問題 |
|---|------|------|
| 1 | \`src/app/api/worktrees/[id]/files/[...path]/route.ts:335\` | **通常テキスト（非編集系）だけサイズ上限なし**で \`readFile(..., 'utf-8')\` を一括実行し、JSONで全文返却 |
| 2 | \`src/components/worktree/FilePanelContent.tsx:239-246\` (\`CodeViewer\`) | \`useMemo\` 内で \`hljs.highlight(content, ...)\` を**メインスレッド同期実行**。失敗時 \`hljs.highlightAuto\` フォールバックでさらに重い |
| 3 | \`src/components/worktree/FilePanelContent.tsx:247-295\` | \`content.split('\\n')\` で全行配列化し \`<table>\` の \`<tr>\` を**仮想化なしで全マウント**（数万行で数十万DOMノード） |
| 4 | \`src/hooks/useFileContentPolling.ts:48-67\` ＋ \`src/config/file-polling-config.ts:11\` | mtime 未変更時は If-Modified-Since/304 で本文転送をスキップ済み（Issue #469 で実装）。問題は **mtime が変化した瞬間に 5 秒間隔で全文再取得 → 再ハイライト → 再レンダリングが連鎖する点** |
| 5 | \`src/hooks/useFileContentSearch.ts:78-88\` | 検索クエリ入力ごとに \`content.split('\\n')\` ＋全行 \`toLowerCase().includes\` を**debounceなし同期実行** |

### 現状のサイズ上限一覧（実コード照合）

| ファイル種別 | 上限 | 定数 | チェック方式 |
|------------|------|------|------------|
| 通常テキスト（非編集系） | **なし** | - | - |
| 編集系テキスト（\`.md\` / \`.yaml\` / \`.yml\`） | 1MB | \`TEXT_MAX_SIZE_BYTES\`（\`editable-extensions.ts:17\`） | \`validateContent()\` で**事後検証**（PUT時のみ） |
| 編集系HTML（\`.html\` / \`.htm\`） | 5MB（事前）＋ 5MB（事後） | \`HTML_MAX_SIZE_BYTES\`（route.ts:311 / Issue #490） | GET時事前 + PUT時事後の二重ガード |
| 画像 | 20MB | \`IMAGE_MAX_SIZE_BYTES\` | 事前検証 |
| 動画 | 100MB | \`VIDEO_MAX_SIZE_BYTES\` | 事前検証 |
| PDF | 20MB | \`PDF_MAX_SIZE_BYTES\`（Issue #673） | 事前検証 |

**重要**: 編集系には既に 1MB の事後検証 (`validateContent()`) が動作中。本Issueの提案 **2MB** はこの既存値の引き上げ統一を意図する（後述 S1-002 / S1-004 参照）。

## 対応方針（ハイブリッド）

### A. 閲覧専用ファイル（コード・ログ・ダンプ等）
**行ベースAPI(B) + 仮想スクロール(②)** を新規実装

- 既存 GET \`/api/worktrees/:id/files/:path\` の**挙動拡張**として、\`startLine\` / \`endLine\` クエリ指定時のみ行範囲モードに分岐（新APIを別エンドポイントとして追加するわけではない）
- メタ情報（\`totalLines\` / \`totalBytes\` / \`encoding\` / \`range:{start,end}\`）は **JSONレスポンスボディに含める**。理由：既存 \`FileContent\` 型（\`src/types/models.ts\`）の自然な拡張で、\`useFileContentPolling\` の \`If-Modified-Since\`/304 機構と独立して扱える（HTTPヘッダ方式は採用しない）
- クライアントは \`@tanstack/react-virtual\` で可視範囲 ± バッファ行のみマウント
- スクロール位置に応じて未取得チャンクを遅延fetch

### B. 編集系ファイル（\`.md\`, \`.html\`, \`.htm\`, \`.yaml\`, \`.yml\` ＝ \`EDITABLE_EXTENSIONS\` 全件）
**従来通り全文読み込み ＋ サーバ側サイズ上限(①)** を導入・統一

#### 判定基準（A/B 分岐ロジック）
- \`isEditableExtension(ext) === true\` → **編集系（B 分岐）**
- \`isEditableExtension(ext) === false\` かつ **テキストとして扱うべき拡張子**（画像/動画/PDF/バイナリを除く） → **閲覧専用（A 分岐）**
- 画像 / 動画 / PDF は既存の専用パスを維持（B分岐にも閲覧専用にも含めない）
- 判定箇所: \`route.ts\` GET ハンドラの拡張子分岐内で行う（サーバ側で一元化）

#### サイズ上限ガードの方針
- \`route.ts\` のテキスト読み込み分岐で \`fileStat.size > EDITABLE_TEXT_MAX_SIZE_BYTES\` を事前チェック（新規）
- 超過時は \`FILE_TOO_LARGE\` (HTTP 413) を返却（既存 \`ERROR_CODE_TO_HTTP_STATUS\` 流用）
- 閾値の初期値は **2MB** を提案
  - **既存 \`TEXT_MAX_SIZE_BYTES = 1MB\` を 2MB に引き上げて統一**する方針（推奨案 (a)）。PUT (validateContent) / GET (route.ts事前ガード) を**単一定数**で扱い、書き込みと読み込みの非対称を避ける
  - 既存上限 1MB は \`validateContent()\` の事後検証として動作中。本変更でこれを2MBに引き上げる
  - 2MB の根拠：編集系で 2MB を超える \`.md\` / \`.yaml\` / \`.yml\` は実運用上極めて稀。既存 1MB から段階的に引き上げる保守的設定（HTML 5MB / 画像 20MB / 動画 100MB / PDF 20MB との並び）
- **HTML (\`.html\` / \`.htm\`) は本Issueの新規 2MB 上限の適用対象外**とする
  - HTML には既に \`route.ts:311\` で事前 5MB ガード（Issue #490 / セキュリティ判断・DoS対策）と \`validateContent()\` で事後 5MB ガードが存在
  - Issue #490 の 5MB 設計を維持。新規ガード（2MB）の適用対象は **\`EDITABLE_EXTENSIONS\` から HTML を除いたサブセット（\`.md\` / \`.yaml\` / \`.yml\`）**
  - 評価順: route.ts GET ハンドラで「HTML拡張子なら HTML 専用 5MB ガード」「それ以外の編集系なら新規 2MB ガード」を**排他分岐**で実装

## なぜハイブリッドか

| 検討 | 理由 |
|------|------|
| 全ファイル部分読み込みにしない | シンタックスハイライタ（hljs）は**ファイル全体を見ないと複数行コメント・テンプレートリテラル・Markdownコードブロック等を正しく着色できない**。編集系も部分編集すると未読部分が消える保存事故が発生する |
| 編集系で全文読み込みを残す | \`.md\` / \`.yaml\` で数MBになるケースは稀。仮想化＋編集の両立は複雑度が極めて高い割に実利が薄い |
| 編集系にもサイズ上限を設けない選択肢を取らない | 何の保険もないと、誤って巨大ログを \`.md\` リネームしたケース等でハング再発する |

## 受入条件

### 閲覧専用ファイル（コードビューア）
- [ ] 100MB級のログファイルを開いてもUIがブロックされず、最初の数百行が表示される
  - **測定条件**: 開発機（M1 Mac 相当）で localhost 接続、warm cache 状態。Performance API で fetch 開始から行レンダリング完了までを計測し、**p50 < 1s**（n=10 試行）
- [ ] スクロール時に追加チャンクが遅延ロードされ、スクロールバーは総行数ベースで正しい位置/サイズになる
- [ ] シンタックスハイライトは**可視範囲のみ**でも視覚的に妥当（言語依存の境界問題は既知の制約として許容、ドキュメントに明記）
- [ ] サーバ側でファイル全文をメモリに載せない
  - **検証手段**: (1) 静的検証として \`readFileLineRange\` 実装内で \`readFile\` を呼ばないこと（grep/lint で確認）。(2) integration test で 100MB ファイル取得時に Node プロセス RSS 増分が **50MB 未満**であること
- [ ] 検索: 表示済み範囲はクライアント検索 / 全体検索は既存 \`lib/file-search.ts\` 流用のサーバ検索APIに委譲
- [ ] ポーリング: 大ファイル時は無効化、または \`HEAD\` でmtime差分のみチェック

### 編集系ファイル
- [ ] サイズ上限超過時は \`FILE_TOO_LARGE\` (HTTP 413) を返し、UIで「ファイルが大きすぎます」を明示
- [ ] 上限値は \`src/config/editable-extensions.ts\` の \`TEXT_MAX_SIZE_BYTES\` を **2MB へ引き上げる**形で統一（PUT/GET 共通の単一定数）
- [ ] HTML (\`.html\` / \`.htm\`) は既存 5MB ガード（Issue #490）を維持し、本Issueの 2MB 上限の対象外であることをコード上で明示
- [ ] 既存 \`MarkdownEditor\` / \`MarkdownPreview\` の挙動に変更なし（2MB 以下のファイルでは従来動作）

### 横断
- [ ] 編集系のサイズ上限ガードは \`GET /api/worktrees/:id/files/:path\` API レイヤで**一元化**され、呼び出し元（FilePanelContent / FileSearch プレビュー / リンク遷移）に依存せず効くこと
- [ ] 閲覧専用の行ベースAPI（startLine/endLine）への移行は別受入条件として独立し、上記API一元ガードと組み合わせて動作すること
- [ ] 既存テスト（unit / integration）がパスすること
- [ ] 大ファイルケースの新規 integration test を追加

## 実装方針（粒度の高い案）

### 1. サーバAPI拡張
- \`src/app/api/worktrees/[id]/files/[...path]/route.ts\`
  - 既存 GET の挙動拡張として、クエリ \`startLine\` / \`endLine\` が指定された場合は行範囲読み込み分岐へ
  - 範囲指定なしは現行挙動（編集系/小ファイル互換）
  - 編集系拡張子チェックの直後にサイズ上限ガード（\`fileStat.size > TEXT_MAX_SIZE_BYTES\`）を追加。**評価順**: 「HTML分岐（既存5MB事前ガード） → それ以外の編集系分岐（新規2MB事前ガード） → 通常テキスト分岐（行範囲モードまたは全文）」
- 新規ヘルパ: \`src/lib/file-operations.ts\` に \`readFileLineRange(root, path, startLine, endLine)\` 追加
  - 実装は \`createReadStream\` + \`readline\` でストリーム読み（メモリO(チャンク)）
  - レスポンスJSONボディに \`totalLines\` / \`totalBytes\` / \`encoding\` / \`range:{start,end}\` メタを含める
- \`src/types/models.ts\` の \`FileContent\` 型を拡張し、上記メタフィールドを追加

### 2. クライアント仮想化
- \`src/components/worktree/FilePanelContent.tsx\` の \`CodeViewer\` を仮想化対応に書き換え
- 依存追加: \`@tanstack/react-virtual\`
  - 既存依存に仮想化ライブラリは存在しない（package.json 確認済み）ため新規導入
  - React 18 / Next.js 14 互換。\`CodeViewer\` は \`'use client'\` コンポーネントとして組み込む（RSC では使えないため）
  - 代替候補（\`react-window\` 等）を検討したが、TanStack 系の API 一貫性・TypeScript型定義の充実・メンテナンス活発さで \`@tanstack/react-virtual\` を選定
- ハイライトは可視チャンク単位で \`hljs.highlight\` 実行、Mapキャッシュで再計算抑制
- 行高さは monospace 前提で固定値 \`24px\` を初期採用、可変高は将来対応

### 3. 設定定数
- \`src/config/editable-extensions.ts\`
  - **既存 \`TEXT_MAX_SIZE_BYTES\` を \`1 * 1024 * 1024\` → \`2 * 1024 * 1024\` へ引き上げ**（PUT/GET 共通）
  - HTML 用 \`HTML_MAX_SIZE_BYTES = 5MB\` は据え置き（Issue #490）
- 新規 \`src/config/file-viewer-config.ts\`
  - \`VIEWER_CHUNK_LINE_SIZE = 500\`
  - \`VIEWER_OVERSCAN_LINES = 100\`
    - 根拠：1080p / 行高さ 24px の場合、可視は約 45 行。オーバースキャン 100 行は約 2 画面分のバッファ。チャンク 500 行 ≈ 10 画面分で fetch 粒度を抑制。**初期値、運用後にチューニング想定**
  - \`POLLING_DISABLED_THRESHOLD_BYTES = 1 * 1024 * 1024\`（1MB）
    - 根拠：編集系上限 2MB の半分。編集可能サイズ帯内でも 1MB 超ファイルはポーリング無効化に倒す保守設定。既存 \`TEXT_MAX_SIZE_BYTES\`（旧 1MB 値）と数値が同じだが**意図は別**（旧来は編集系の絶対上限、本定数はポーリング負荷回避の閾値）

### 4. 検索の役割分担
- \`useFileContentSearch\`: 表示済みチャンク内検索 + debounce 300ms 追加
- 全体検索ボタン: 既存 \`src/lib/file-search.ts\` をAPI化して呼び出し（別Issueに切り出し可）

### 5. ポーリング
- \`src/hooks/useFileContentPolling.ts:51\` の \`enabled\` 条件に \`content.totalBytes < POLLING_DISABLED_THRESHOLD_BYTES\` を追加（PDF除外と同じ思想）
- 既存の \`If-Modified-Since\`/304 機構（Issue #469）はそのまま活用。本Issueは「mtime変化時の5秒間隔再ロード連鎖」の抑制を上乗せする位置付け

## 想定影響範囲

| ファイル | 変更内容 |
|----------|----------|
| \`src/app/api/worktrees/[id]/files/[...path]/route.ts\` | 行範囲取得分岐追加、編集系（HTML以外）サイズ上限事前ガード追加 |
| \`src/lib/file-operations.ts\` | \`readFileLineRange\` 追加（\`createReadStream\` + \`readline\`） |
| \`src/components/worktree/FilePanelContent.tsx\` (\`CodeViewer\`) | 仮想化対応への書き換え（\`'use client'\` 維持） |
| \`src/hooks/useFileContentPolling.ts\` | 大ファイル時無効化（\`POLLING_DISABLED_THRESHOLD_BYTES\` 判定追加） |
| \`src/hooks/useFileContentSearch.ts\` | debounce 300ms + 表示済み範囲限定検索 |
| \`src/config/editable-extensions.ts\` | \`TEXT_MAX_SIZE_BYTES\` を 1MB → 2MB へ引き上げ |
| \`src/config/file-viewer-config.ts\` (新規) | \`VIEWER_CHUNK_LINE_SIZE\` / \`VIEWER_OVERSCAN_LINES\` / \`POLLING_DISABLED_THRESHOLD_BYTES\` |
| \`src/types/models.ts\` (\`FileContent\`) | \`totalLines\` / \`totalBytes\` / \`encoding\` / \`range\` メタ追加 |
| \`package.json\` | \`@tanstack/react-virtual\` 追加（バンドルサイズ増分は導入時に実測して PR に記載） |

## スコープ外（別Issue推奨）

- ハイライトの Web Worker 化（メインスレッド解放）
- 全文検索のサーバAPI化（既存 \`lib/file-search.ts\` のエンドポイント整備）
- 編集系ファイルの部分編集対応
- MARP 大ファイル対応

## 関連

- \`CLAUDE.md\` モジュールリファレンス: \`src/components/worktree/FilePanelContent.tsx\` / \`src/hooks/useFileContentPolling.ts\` / \`src/lib/file-operations.ts\`
- 既存サイズ上限実装の参考: Issue #490 (HTML 5MB) / Issue #673 (PDF 20MB) / Issue #302 (Video 100MB)
- ファイルポーリング基盤・If-Modified-Since/304 実装: Issue #469
