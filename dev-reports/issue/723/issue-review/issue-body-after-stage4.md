## 概要

PC版で数MB以上の大規模ファイルを開くとUIがハングして操作不能になる問題に対し、**閲覧用途と編集用途で別戦略を採用する**ハイブリッド方式で根本対応する。

- **閲覧専用ファイル（コードビューア用途）**: 行ベースAPI（部分読み込み）＋ 仮想スクロール
- **編集系ファイル（Markdown / YAML / HTML 等）**: 従来通り全文読み込み ＋ サーバ側サイズ上限

## 背景（現状の問題）

数MBのテキストファイルをファイルパネルで開くと、以下が連鎖的にメインスレッドを長時間ブロックして実質ハングする。

| # | 箇所 | 問題 |
|---|------|------|
| 1 | `src/app/api/worktrees/[id]/files/[...path]/route.ts:335` | **通常テキスト（非編集系）だけサイズ上限なし**で `readFile(..., 'utf-8')` を一括実行し、JSONで全文返却 |
| 2 | `src/components/worktree/FilePanelContent.tsx:239-246` (`CodeViewer`) | `useMemo` 内で `hljs.highlight(content, ...)` を**メインスレッド同期実行**。失敗時 `hljs.highlightAuto` フォールバックでさらに重い |
| 3 | `src/components/worktree/FilePanelContent.tsx:247-295` | `content.split('\n')` で全行配列化し `<table>` の `<tr>` を**仮想化なしで全マウント**（数万行で数十万DOMノード） |
| 4 | `src/hooks/useFileContentPolling.ts:48-67` ＋ `src/config/file-polling-config.ts:11` | mtime 未変更時は If-Modified-Since/304 で本文転送をスキップ済み（Issue #469 で実装）。問題は **mtime が変化した瞬間に 5 秒間隔で全文再取得 → 再ハイライト → 再レンダリングが連鎖する点** |
| 5 | `src/hooks/useFileContentSearch.ts:78-88` | 検索クエリ入力ごとに `content.split('\n')` ＋全行 `toLowerCase().includes` を**debounceなし同期実行** |

### 現状のサイズ上限一覧（実コード照合）

| ファイル種別 | 上限 | 定数 | チェック方式 |
|------------|------|------|------------|
| 通常テキスト（非編集系） | **なし** | - | - |
| 編集系テキスト（`.md` / `.yaml` / `.yml`） | 1MB | `TEXT_MAX_SIZE_BYTES`（`editable-extensions.ts:17`） | `validateContent()` で**事後検証**（PUT時のみ） |
| 編集系HTML（`.html` / `.htm`） | 5MB（事前）＋ 5MB（事後） | `HTML_MAX_SIZE_BYTES`（route.ts:311 / Issue #490） | GET時事前 + PUT時事後の二重ガード |
| 画像 | 20MB | `IMAGE_MAX_SIZE_BYTES` | 事前検証 |
| 動画 | 100MB | `VIDEO_MAX_SIZE_BYTES` | 事前検証 |
| PDF | 20MB | `PDF_MAX_SIZE_BYTES`（Issue #673） | 事前検証 |

**重要**: 編集系には既に 1MB の事後検証 (`validateContent()`) が動作中。本Issueの提案 **2MB** はこの既存値の引き上げ統一を意図する（後述 S1-002 / S1-004 参照）。

## 対応方針（ハイブリッド）

### A. 閲覧専用ファイル（コード・ログ・ダンプ等）
**行ベースAPI(B) + 仮想スクロール(②)** を新規実装

- 既存 GET `/api/worktrees/:id/files/:path` の**挙動拡張**として、`startLine` / `endLine` クエリ指定時のみ行範囲モードに分岐（新APIを別エンドポイントとして追加するわけではない）
- メタ情報（`totalLines` / `totalBytes` / `encoding` / `range:{start,end}`）は **JSONレスポンスボディに含める**。理由：既存 `FileContent` 型（`src/types/models.ts`）の自然な拡張で、`useFileContentPolling` の `If-Modified-Since`/304 機構と独立して扱える（HTTPヘッダ方式は採用しない）
- クライアントは `@tanstack/react-virtual` で可視範囲 ± バッファ行のみマウント
- スクロール位置に応じて未取得チャンクを遅延fetch

### B. 編集系ファイル（`.md`, `.html`, `.htm`, `.yaml`, `.yml` ＝ `EDITABLE_EXTENSIONS` 全件）
**従来通り全文読み込み ＋ サーバ側サイズ上限(①)** を導入・統一

#### 判定基準（A/B 分岐ロジック）
- `isEditableExtension(ext) === true` → **編集系（B 分岐）**
- `isEditableExtension(ext) === false` かつ **テキストとして扱うべき拡張子**（画像/動画/PDF/バイナリを除く） → **閲覧専用（A 分岐）**
- 画像 / 動画 / PDF は既存の専用パスを維持（B分岐にも閲覧専用にも含めない）
- 判定箇所: `route.ts` GET ハンドラの拡張子分岐内で行う（サーバ側で一元化）

#### クライアント側 `FilePanelContent.tsx` の分岐対応（S3-010 反映）

`FilePanelContent.tsx:691-815` の既存分岐順「image → video → pdf → html → md → editable → default code」と本 Issue の A/B 判定の対応関係を以下に明示する。実装者はこのマッピングに従って行範囲モードを差し込む。

| クライアント側分岐 | 判定条件 | サーバ側挙動 | A/B 分類 | 行範囲モード適用 |
|--------------------|----------|--------------|----------|------------------|
| isImage | 画像拡張子 | 既存専用パス | 専用パス | ✕ |
| isVideo | 動画拡張子 | 既存専用パス | 専用パス | ✕ |
| isPdf | PDF拡張子 | 既存専用パス | 専用パス | ✕ |
| isHtml | `.html` / `.htm` | 既存 5MB 事前ガード（Issue #490）維持 | **編集系 B** | ✕ |
| extension === 'md' | `.md` | 新規 2MB 事前ガード | **編集系 B**（MarkdownWithSearch） | ✕ |
| isEditableExtension(ext) | `.yaml` / `.yml` 等 | 新規 2MB 事前ガード | **編集系 B**（MarkdownWithSearch） | ✕ |
| default code（フォールバック） | 上記以外のテキスト | 行範囲モード対応 | **閲覧専用 A**（CodeViewer 仮想化） | **○** |

サーバ側 `route.ts` の `startLine` / `endLine` クエリは「default code」分岐のクライアントからのみ送信される。

#### サイズ上限ガードの方針
- `route.ts` のテキスト読み込み分岐で `fileStat.size > EDITABLE_TEXT_MAX_SIZE_BYTES` を事前チェック（新規）
- 超過時は `FILE_TOO_LARGE` (HTTP 413) を返却（既存 `ERROR_CODE_TO_HTTP_STATUS` 流用）
- 閾値の初期値は **2MB** を提案
  - **既存 `TEXT_MAX_SIZE_BYTES = 1MB` を 2MB に引き上げて統一**する方針（推奨案 (a)）。PUT (validateContent) / GET (route.ts事前ガード) を**単一定数**で扱い、書き込みと読み込みの非対称を避ける
  - 既存上限 1MB は `validateContent()` の事後検証として動作中。本変更でこれを2MBに引き上げる
  - 2MB の根拠：編集系で 2MB を超える `.md` / `.yaml` / `.yml` は実運用上極めて稀。既存 1MB から段階的に引き上げる保守的設定（HTML 5MB / 画像 20MB / 動画 100MB / PDF 20MB との並び）
- **HTML (`.html` / `.htm`) は本Issueの新規 2MB 上限の適用対象外**とする
  - HTML には既に `route.ts:311` で事前 5MB ガード（Issue #490 / セキュリティ判断・DoS対策）と `validateContent()` で事後 5MB ガードが存在
  - Issue #490 の 5MB 設計を維持。新規ガード（2MB）の適用対象は **`EDITABLE_EXTENSIONS` から HTML を除いたサブセット（`.md` / `.yaml` / `.yml`）**
  - 評価順: route.ts GET ハンドラで「HTML拡張子なら HTML 専用 5MB ガード」「それ以外の編集系なら新規 2MB ガード」を**排他分岐**で実装

## なぜハイブリッドか

| 検討 | 理由 |
|------|------|
| 全ファイル部分読み込みにしない | シンタックスハイライタ（hljs）は**ファイル全体を見ないと複数行コメント・テンプレートリテラル・Markdownコードブロック等を正しく着色できない**。編集系も部分編集すると未読部分が消える保存事故が発生する |
| 編集系で全文読み込みを残す | `.md` / `.yaml` で数MBになるケースは稀。仮想化＋編集の両立は複雑度が極めて高い割に実利が薄い |
| 編集系にもサイズ上限を設けない選択肢を取らない | 何の保険もないと、誤って巨大ログを `.md` リネームしたケース等でハング再発する |

## 破壊的変更（マイグレーション影響）（S3-003 反映）

本Issue の実装により、以下の挙動変更が発生する。リリースノート / CHANGELOG に明記すること。

### 編集系ファイルの GET 事前ガード追加に伴う影響

| 項目 | 変更前 | 変更後 |
|------|--------|--------|
| `.md` / `.yaml` / `.yml` の GET 上限 | **なし**（route.ts に事前ガード無し） | **2MB**（新規事前ガード） |
| `.md` / `.yaml` / `.yml` の PUT 上限 | 1MB（`validateContent()` 事後検証） | 2MB（`TEXT_MAX_SIZE_BYTES` 引き上げ） |
| `.html` / `.htm` の GET 上限 | 5MB（Issue #490 事前ガード） | **5MB 据え置き** |
| `.html` / `.htm` の PUT 上限 | 5MB（`validateContent()` 事後検証） | **5MB 据え置き** |

### ユーザー視点の挙動変化

- **1MB〜2MB の `.md`/`.yaml`/`.yml` ファイル**: 変更前は『開けるが PUT 時に 1MB 超で保存失敗』 → 変更後は『開ける＆保存できる』（**改善**）
- **2MB を超える `.md`/`.yaml`/`.yml` ファイル**: 変更前は『開ける（GET 上限なし）が PUT で保存失敗』 → 変更後は『**そのものが開けなくなる**（GET 時点で 413）』（**破壊的変更**）
- **既にタブで開いている 2MB 超のファイル**: ポーリング再フェッチ時に 413 を受け取り、エラー表示に切り替わる（要 UI 対応）

### 将来案

- 2MB 超の編集系ファイルは『閲覧専用モード（行範囲＋仮想化）にフォールバック』する選択肢を将来 Issue で検討余地あり。本Issue 範囲では『開けない』挙動とする。

## 受入条件

### 閲覧専用ファイル（コードビューア）
- [ ] 100MB級のログファイルを開いてもUIがブロックされず、最初の数百行が表示される
  - **測定条件**: 開発機（M1 Mac 相当）で localhost 接続、warm cache 状態。Performance API で fetch 開始から行レンダリング完了までを計測し、**p50 < 1s**（n=10 試行）
- [ ] スクロール時に追加チャンクが遅延ロードされ、スクロールバーは総行数ベースで正しい位置/サイズになる
- [ ] シンタックスハイライトは**可視範囲のみ**でも視覚的に妥当（言語依存の境界問題は既知の制約として許容、ドキュメントに明記）
- [ ] サーバ側でファイル全文をメモリに載せない
  - **検証手段**: (1) 静的検証として `readFileLineRange` 実装内で `readFile` を呼ばないこと（grep/lint で確認）。(2) integration test で 100MB ファイル取得時に Node プロセス RSS 増分が **50MB 未満**であること
  - **テストフィクスチャ方針（S3-011 反映）**: 100MB フィクスチャはテスト `beforeAll` で動的生成（`os.tmpdir()` 配下に作成）し `afterAll` で削除。リポジトリにはコミットしない。生成内容は `'line {n}\n'` を 100 万行程度。
- [ ] 検索: 表示済み範囲はクライアント検索 / 全体検索は既存 `lib/file-search.ts` 流用のサーバ検索APIに委譲
- [ ] ポーリング: 大ファイル時は無効化、または `HEAD` でmtime差分のみチェック

### 編集系ファイル
- [ ] サイズ上限超過時は `FILE_TOO_LARGE` (HTTP 413) を返し、UIで「ファイルが大きすぎます」を明示
- [ ] 上限値は `src/config/editable-extensions.ts` の `TEXT_MAX_SIZE_BYTES` を **2MB へ引き上げる**形で統一（PUT/GET 共通の単一定数）
- [ ] HTML (`.html` / `.htm`) は既存 5MB ガード（Issue #490）を維持し、本Issueの 2MB 上限の対象外であることをコード上で明示
- [ ] 既存 `MarkdownEditor` / `MarkdownPreview` の挙動に変更なし（2MB 以下のファイルでは従来動作）
- [ ] **（S3-003 反映）** 2MB を超える `.md`/`.yaml`/`.yml` は GET 時点で 413 を返し、UI でファイルが開けない旨を表示する（従来は GET 200 で表示されたが PUT 時に保存失敗していたケース）。この挙動変更は破壊的変更として CHANGELOG / リリースノートに明示する
- [ ] **（S3-003 反映）** 既にタブで開いている 2MB 超のファイルは、ポーリングで再フェッチ時に 413 を受け取り、エラー表示に切り替わること

### 横断
- [ ] 編集系のサイズ上限ガードは `GET /api/worktrees/:id/files/:path` API レイヤで**一元化**され、呼び出し元（FilePanelContent / FileSearch プレビュー / リンク遷移）に依存せず効くこと
- [ ] 閲覧専用の行ベースAPI（startLine/endLine）への移行は別受入条件として独立し、上記API一元ガードと組み合わせて動作すること
- [ ] 既存テスト（unit / integration）がパスすること
- [ ] 大ファイルケースの新規 integration test を追加

## 実装方針（粒度の高い案）

### 1. サーバAPI拡張
- `src/app/api/worktrees/[id]/files/[...path]/route.ts`
  - 既存 GET の挙動拡張として、クエリ `startLine` / `endLine` が指定された場合は行範囲読み込み分岐へ
  - 範囲指定なしは現行挙動（編集系/小ファイル互換）
  - 編集系拡張子チェックの直後にサイズ上限ガード（`fileStat.size > TEXT_MAX_SIZE_BYTES`）を追加。**評価順**: 「HTML分岐（既存5MB事前ガード） → それ以外の編集系分岐（新規2MB事前ガード） → 通常テキスト分岐（行範囲モードまたは全文）」
- 新規ヘルパ: `src/lib/file-operations.ts` に `readFileLineRange(root, path, startLine, endLine)` 追加
  - 実装は `createReadStream` + `readline` でストリーム読み（メモリO(チャンク)）
  - レスポンスJSONボディに `totalLines` / `totalBytes` / `encoding` / `range:{start,end}` メタを含める
- `src/types/models.ts` の `FileContent` 型を拡張し、上記メタフィールドを追加
  - **（S3-002 反映）** 追加フィールド (`totalLines` / `totalBytes` / `encoding` / `range`) は **全て optional** とする
    - 理由 (a): 編集系・画像・動画・PDF・HTML など範囲モードを使わない経路では当該フィールド未設定でも互換性を保つため
    - 理由 (b): 既存 9 ファイルの `FileContent` 利用箇所（`page.tsx` / `FilePanelTabs` / `FilePanelSplit` / `FilePanelContent` / `WorktreeDetailRefactored` / `FileViewer` / `useFileTabs` / `useFileContentPolling`）は型変更だけで coercion 不要
  - `FileContentResponse` も同型拡張に追従
- **（S3-007 反映）行範囲モードと If-Modified-Since の相互作用**:
  - 行範囲モード（`startLine` / `endLine` 指定時）はサーバ側で `If-Modified-Since` 検証をスキップし**常に 200** を返す
  - 理由：同一 mtime でも異なる行範囲を要求できなければ仮想スクロールが破綻するため
  - クライアント側では仮想スクロールのチャンク fetch では `If-Modified-Since` ヘッダを送らない実装とする
  - 範囲指定なしの全文モードは従来通り `If-Modified-Since` / 304 機構（Issue #469）を活用する
- **（S3-013 反映）`readFileLineRange` の引数バリデーション**:
  - (a) `startLine >= 1` / `endLine >= startLine` / `endLine - startLine <= VIEWER_CHUNK_LINE_SIZE * 4` 程度の上限
  - (b) 違反時は **400 INVALID_REQUEST**（不正値の DoS 起点回避）
  - (c) ファイル総行数を超える `endLine` は実ファイル末尾までクランプし **200 で返す**（既存挙動との互換性）
  - (d) 行範囲指定が無い場合は従来全文モード

### 2. クライアント仮想化
- `src/components/worktree/FilePanelContent.tsx` の `CodeViewer` を仮想化対応に書き換え
- 依存追加: `@tanstack/react-virtual`
  - 既存依存に仮想化ライブラリは存在しない（package.json 確認済み）ため新規導入
  - React 18 / Next.js 14 互換。`CodeViewer` は `'use client'` コンポーネントとして組み込む（RSC では使えないため）
  - 代替候補（`react-window` 等）を検討したが、TanStack 系の API 一貫性・TypeScript型定義の充実・メンテナンス活発さで `@tanstack/react-virtual` を選定
- **（S3-009 反映）Server/Client Components 境界とバンドルサイズ**:
  - `FilePanelContent.tsx` は既存 `'use client'` のため **Server/Client Components 境界変更なし**（CLAUDE.md コーディング規約『Server Components 優先 / `'use client'` を明示』との整合確認済み）
  - バンドルサイズ目安として **`+30KB (gzipped)` を許容上限**とし、超過時はチャンク分割または代替ライブラリ再検討
  - `@tanstack/react-virtual` は ESM + `sideEffects: false` で tree-shaking 対応
- ハイライトは可視チャンク単位で `hljs.highlight` 実行、Mapキャッシュで再計算抑制
- 行高さは monospace 前提で固定値 `24px` を初期採用、可変高は将来対応

### 3. 設定定数
- `src/config/editable-extensions.ts`
  - **既存 `TEXT_MAX_SIZE_BYTES` を `1 * 1024 * 1024` → `2 * 1024 * 1024` へ引き上げ**（PUT/GET 共通）
  - HTML 用 `HTML_MAX_SIZE_BYTES = 5MB` は据え置き（Issue #490）
- 新規 `src/config/file-viewer-config.ts`
  - `VIEWER_CHUNK_LINE_SIZE = 500`
  - `VIEWER_OVERSCAN_LINES = 100`
    - 根拠：1080p / 行高さ 24px の場合、可視は約 45 行。オーバースキャン 100 行は約 2 画面分のバッファ。チャンク 500 行 ≈ 10 画面分で fetch 粒度を抑制。**初期値、運用後にチューニング想定**
  - `POLLING_DISABLED_THRESHOLD_BYTES = 1 * 1024 * 1024`（1MB）
    - 根拠：編集系上限 2MB の半分。編集可能サイズ帯内でも 1MB 超ファイルはポーリング無効化に倒す保守設定。既存 `TEXT_MAX_SIZE_BYTES`（旧 1MB 値）と数値が同じだが**意図は別**（旧来は編集系の絶対上限、本定数はポーリング負荷回避の閾値）

### 4. 検索の役割分担
- `useFileContentSearch`: 表示済みチャンク内検索 + debounce 300ms 追加
- 全体検索ボタン: 既存 `src/lib/file-search.ts` をAPI化して呼び出し（別Issueに切り出し可）
- **（S3-005 反映）`FileViewer.tsx` 内蔵検索ロジックの統一**:
  - `src/components/worktree/FileViewer.tsx:302-318` に `useFileContentSearch` を経由しない独立検索ロジック（`content.content.split('\n')` + `lines.forEach` + `toLowerCase().includes`、debounce 無し）が残存している
  - **本Issue 内で対応する**：FileViewer 側も `useFileContentSearch` に置き換えて統一する（推奨案 (a)）。FilePanelContent (PC側) と FileViewer (モーダル) の UX 一貫性を保つ
  - 置き換えが大規模になる場合は同等の debounce 300ms ＋最小2文字を入れる（暫定案 (b)）。最終判断は実装PR で記載
- **（S3-012 反映）共通定数の流用**:
  - debounce / 最小クエリ長は `src/hooks/useTerminalSearch.ts` で export 済みの **`SEARCH_DEBOUNCE_MS = 300` / `SEARCH_MIN_QUERY_LENGTH = 2`** を流用する
  - 検索 UI 全体（ターミナル / 履歴 / ファイル）で挙動を統一する（Issue #47 / #716 との一貫性）

### 5. ポーリング
- `src/hooks/useFileContentPolling.ts:51` の `enabled` 条件に `content.totalBytes < POLLING_DISABLED_THRESHOLD_BYTES` を追加（PDF除外と同じ思想）
- **（S3-006 反映）境界条件の正確な仕様**:
  - 正確な `enabled` 条件: `tab.content !== null && !tab.loading && !tab.isDirty && !tab.content?.isPdf && !(tab.content?.totalBytes !== undefined && tab.content.totalBytes >= POLLING_DISABLED_THRESHOLD_BYTES)`
  - `totalBytes` が **undefined** の場合（小ファイル、編集系、または未拡張レスポンス）はポーリング**有効を維持**し既存挙動を保つ
  - `totalBytes` が判定可能な値で**閾値超過時のみ無効化**する
- 既存の `If-Modified-Since`/304 機構（Issue #469）はそのまま活用。本Issueは「mtime変化時の5秒間隔再ロード連鎖」の抑制を上乗せする位置付け

### 6. i18n（S3-008 反映）
- `locales/ja/error.json` / `locales/en/error.json` に新規エラーキー追加（ja/en 同期必須）
- 既存 `error.json` の構造に合わせた命名例:
  - `fileTooLarge.editableLimit` = 「編集可能ファイルサイズの上限（{limit}MB）を超えています」
  - `fileTooLarge.viewerLimit` = 「閲覧専用ファイルサイズの上限を超えています」
- 現状 `locales/ja/error.json` / `locales/en/error.json` には `FILE_TOO_LARGE` 系メッセージが存在しないため新規追加扱い
- `src/i18n.ts` で複数 namespace を merge している既存規約に準拠

### 7. ドキュメント・コメント同期（S3-004 反映）
- `src/types/markdown-editor.ts:227` のコメント参照値を **1MB → 2MB** に同期更新（`TEXT_MAX_SIZE_BYTES` 引き上げに追従）
- `CLAUDE.md` モジュール一覧の更新:
  - `src/config/editable-extensions.ts` エントリに Issue #723 を追記
  - `src/config/file-viewer-config.ts`（新規）エントリを追加
  - `src/lib/file-operations.ts` エントリに `readFileLineRange` の追加を明記
- コメント参照値の同期更新は PR の必須項目

## 想定影響範囲

### 直接変更ファイル

| ファイル | 変更内容 |
|----------|----------|
| `src/app/api/worktrees/[id]/files/[...path]/route.ts` | 行範囲取得分岐追加、編集系（HTML以外）サイズ上限事前ガード追加、行範囲モード時 If-Modified-Since スキップ |
| `src/lib/file-operations.ts` | `readFileLineRange` 追加（`createReadStream` + `readline`） |
| `src/components/worktree/FilePanelContent.tsx` (`CodeViewer`) | 仮想化対応への書き換え（`'use client'` 維持） |
| `src/hooks/useFileContentPolling.ts` | 大ファイル時無効化（`POLLING_DISABLED_THRESHOLD_BYTES` 判定追加、`totalBytes` undefined 境界仕様化） |
| `src/hooks/useFileContentSearch.ts` | debounce 300ms + 表示済み範囲限定検索（`SEARCH_DEBOUNCE_MS` / `SEARCH_MIN_QUERY_LENGTH` 流用） |
| `src/config/editable-extensions.ts` | `TEXT_MAX_SIZE_BYTES` を 1MB → 2MB へ引き上げ |
| `src/config/file-viewer-config.ts` (新規) | `VIEWER_CHUNK_LINE_SIZE` / `VIEWER_OVERSCAN_LINES` / `POLLING_DISABLED_THRESHOLD_BYTES` |
| `src/types/models.ts` (`FileContent`) | `totalLines` / `totalBytes` / `encoding` / `range` メタ追加（**全て optional**） |
| `package.json` | `@tanstack/react-virtual` 追加（バンドルサイズ目安 +30KB gzipped 上限、PR で実測記載） |
| `package-lock.json` | lockfile 更新 |

### 間接影響ファイル（型シグネチャ追従のみ、ロジック変更なし）（S3-002 反映）

`FileContent` 型を import しているファイル（grep 結果 9 ファイル）。optional フィールド追加のため transparent に追従。

| ファイル | 追従内容 |
|----------|----------|
| `src/app/worktrees/[id]/files/[...path]/page.tsx` | `FileContent` import、追加メタフィールド透過（型推論影響あり） |
| `src/components/worktree/FilePanelSplit.tsx` | `FileContent` import、`onLoadContent` シグネチャ伝播 |
| `src/components/worktree/FilePanelTabs.tsx` | `FileContent` import、`onLoadContent` シグネチャ伝播 |
| `src/components/worktree/FileViewer.tsx` | `FileContent` import、内蔵検索ロジック L302-318 を `useFileContentSearch` に置き換え（S3-005） |
| `src/components/worktree/WorktreeDetailRefactored.tsx` | `handleLoadContent: (path, content: FileContent) => void` シグネチャは保持、メタ透過確認 |
| `src/hooks/useFileTabs.ts` | `FileTab.content: FileContent \| null` / `SET_CONTENT` アクションの型を介して追加フィールド透過 |

### テスト影響（S3-001 反映）

| ファイル | 影響内容 |
|----------|----------|
| `tests/unit/config/editable-extensions.test.ts:46` | `expect(mdValidator?.maxFileSize).toBe(1024 * 1024)` → **2MB へ更新必須** |
| `tests/unit/config/editable-extensions.test.ts:64` | `expect(yamlValidator?.maxFileSize).toBe(1024 * 1024)` → **2MB へ更新必須** |
| `tests/unit/config/editable-extensions.test.ts:71` | `expect(ymlValidator?.maxFileSize).toBe(1024 * 1024)` → **2MB へ更新必須** |
| `tests/unit/config/editable-extensions.test.ts:158-167` | `validateContent('.md', largeContent)` 系のサイズ境界テストフィクスチャを 2MB 化 |
| `tests/integration/yaml-file-operations.test.ts` | YAML 編集系の上限値変更影響を確認要 |
| `tests/unit/components/FilePanelContent.test.tsx` | `CodeViewer` のレンダリング構造変化（`<table>` → 仮想化コンテナ）で DOM 構造ベースのアサーション要更新 |

**プロセス明示**: 同期更新を要する test ファイル更新は実装PR で同一コミットに含めること。

### 新規テスト追加

- `tests/unit/lib/file-operations.test.ts`: `readFileLineRange` 単体テスト（バリデーション境界、`startLine > endLine` 違反、行数超過クランプ、空ファイル、最終行 EOF、大ファイル 100MB でストリーム動作）
- `tests/integration/api-file-operations.test.ts`:
  - `GET /api/.../files/...path?startLine=N&endLine=M` 動作テスト（200 / 400 範囲外 / メタフィールド検証 / 編集系 2MB 超過時 413）
  - 編集系 GET 事前ガード（`.md`/`.yaml`/`.yml` ＞ 2MB → 413、HTML 5MB は通る）
- `tests/unit/components/FilePanelContent.test.tsx`: `CodeViewer` 仮想化テスト（1万行ファイルでマウントされる行数が limited、スクロール時チャンク fetch、ハイライトキャッシュヒット）
- `tests/unit/hooks/useFileContentPolling.test.ts`: `POLLING_DISABLED_THRESHOLD_BYTES` 超過時 `enabled=false`（`totalBytes` 未定義時の挙動含む）
- `tests/unit/hooks/useFileContentSearch.test.ts`: debounce 300ms 動作確認、表示済み範囲限定検索
- `tests/integration`: 100MB ファイル取得時の Node プロセス RSS 増分 < 50MB の検証（`process.memoryUsage()` ベース）

### ドキュメント・コメント同期（S3-004 反映）

| ファイル | 更新内容 |
|----------|----------|
| `src/types/markdown-editor.ts:227` | コメントの `TEXT_MAX_SIZE_BYTES` 参照値（1MB → 2MB）同期更新 |
| `CLAUDE.md` | `src/config/editable-extensions.ts` エントリに Issue #723 追記、`src/config/file-viewer-config.ts`（新規）エントリ追加、`src/lib/file-operations.ts` エントリに `readFileLineRange` 追加明記 |

### i18n（S3-008 反映）

| ファイル | 追加内容 |
|----------|----------|
| `locales/ja/error.json` | 新規キー `fileTooLarge.editableLimit` / `fileTooLarge.viewerLimit` 追加（ja/en 同期必須） |
| `locales/en/error.json` | 同上、英語版を同期追加 |

### 外部モジュール影響

- `@tanstack/react-virtual` (新規依存追加：実測 bundle size を PR で記載必須、+30KB gzipped 上限)
- `node:readline` (`readFileLineRange` で使用、既存依存なしのため import 追加)
- `node:fs` (`createReadStream` を `file-operations.ts` で利用)

### 関連 Issue 影響整理

| Issue | 影響 |
|-------|------|
| #469 | `useFileContentPolling` の `If-Modified-Since` / 304 機構は維持。本Issue は `enabled` 条件に `POLLING_DISABLED_THRESHOLD_BYTES` 判定を上乗せ。304 機構との優先順位（PDF と同様）に整合 |
| #490 | HTML 5MB 事前ガード (route.ts:311) はそのまま維持。本Issue で『編集系 2MB ガードは HTML を除外して `.md`/`.yaml`/`.yml` のみに適用』を明示することで Issue #490 設計を保護 |
| #673 | PDF は専用パス（`isPdf` 分岐）で独立。本Issue の編集系/閲覧専用判定の影響なし。`useFileContentPolling.ts:51` の `!tab.content?.isPdf` 既存判定パターンが `POLLING_DISABLED_THRESHOLD_BYTES` の前例として活用可能 |
| #302 | Video 専用パス。影響なし |
| #646 | YAML 編集対応で `TEXT_MAX_SIZE_BYTES` が `.yaml`/`.yml` の `maxFileSize` として参照されている (editable-extensions.ts:67-73)。1MB → 2MB 引き上げで YAML の保存上限も拡張される（意図的）。`validateYamlContent` (危険タグ検出) は `content.length` とは独立に動作するので機能影響なし |
| #47 / #716 | `TerminalSearchBar` / `HistorySearchBar` の検索 UI パターン (debounce 300ms、最小 2 文字、最大 500 件) と `useFileContentSearch` の改修方針を統一すべき。`SEARCH_DEBOUNCE_MS` / `SEARCH_MIN_QUERY_LENGTH` 共通定数化（`useTerminalSearch` から export 済み）の流用を採用（S3-012） |
| #438 | `FilePanelContent` / `FilePanelTabs` / `FilePanelSplit` 一連の構造に対する変更。`tab.content?.isHtml` / `isPdf` 等の既存分岐パターンを踏襲する形で行範囲モード分岐が追加される |

## スコープ外（別Issue推奨）

- ハイライトの Web Worker 化（メインスレッド解放）
- 全文検索のサーバAPI化（既存 `lib/file-search.ts` のエンドポイント整備）
- 編集系ファイルの部分編集対応
- MARP 大ファイル対応
- 2MB 超の編集系ファイルの『閲覧専用モードへのフォールバック』対応

## 関連

- `CLAUDE.md` モジュールリファレンス: `src/components/worktree/FilePanelContent.tsx` / `src/hooks/useFileContentPolling.ts` / `src/lib/file-operations.ts`
- 既存サイズ上限実装の参考: Issue #490 (HTML 5MB) / Issue #673 (PDF 20MB) / Issue #302 (Video 100MB)
- ファイルポーリング基盤・If-Modified-Since/304 実装: Issue #469
- 検索 UI 共通定数 (`SEARCH_DEBOUNCE_MS` / `SEARCH_MIN_QUERY_LENGTH`): Issue #47 / #716
