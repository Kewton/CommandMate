# Issue #469 Stage 3 影響範囲レビューレポート

**レビュー日**: 2026-03-11
**フォーカス**: 影響範囲レビュー（1回目）
**ステージ**: 3/4

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 2 |
| Should Fix | 4 |
| Nice to Have | 2 |

**総合評価**: good -- Issue自体の設計は明確だが、既存コードとの統合時に競合リスクやパフォーマンス影響がある。特にポーリングの排他制御と複数ワークツリー同時使用時の負荷累積について、設計段階での対処が必要。

---

## Must Fix（必須対応）

### F1: FileTreeViewのポーリングがrefreshTriggerベースのuseEffectと競合し、二重リロードが発生する可能性

**カテゴリ**: パフォーマンス・メモリリーク

**問題**:
FileTreeView.tsx（行594-666）の既存useEffectは`refreshTrigger`の変更でルートディレクトリ+全展開済みディレクトリを並列再取得する。ポーリングを`setInterval`で別途追加した場合、UIファイル操作（`setFileTreeRefresh`）とポーリングが同タイミングで発生すると、2つの独立した再取得が同時に走る。

**証拠**:
- `FileTreeView.tsx`行594-666: `refreshTrigger`依存のuseEffectが全ツリーを再構築
- `FileTreeView.tsx`行118: `CONCURRENT_LIMIT = 5` で並列チャンク取得
- 展開ディレクトリ10個の場合、二重発火で最大20リクエストが同時発生
- `setRootItems`/`setCache`が競合するタイミングで呼ばれると、古いデータで新しいデータが上書きされる可能性

**推奨対応**:
ポーリングとrefreshTriggerを統合する設計を検討する。方法1: ポーリングはrefreshTriggerをインクリメントする形にし、既存のuseEffectにフローを統一する。方法2: ポーリング用のuseEffectにAbortControllerを導入し、前回の未完了リクエストをキャンセルしてから新規ポーリングを開始する。

---

### F2: 複数ワークツリー同時使用時のポーリング累積によるAPI負荷

**カテゴリ**: パフォーマンス・サーバー負荷

**問題**:
CommandMateは複数ワークツリーの同時表示をサポートしている（`commandmate start --issue N --auto-port`）。ブラウザで複数タブを開いた場合、各タブのFileTreeViewとFilePanelContentが独立してポーリングを実行する。

**負荷試算**:
- ワークツリー3個、各3ファイルタブの場合
- 5秒ごとに: 3（ツリー）+ 9（ファイル内容）= 12リクエスト/5秒
- FileTreeViewの展開ディレクトリ再取得を含めると数十リクエスト/5秒
- 既存ターミナルポーリング（2-5秒）と合算: 毎秒5-10リクエスト以上

**証拠**:
- `WorktreeDetailRefactored.tsx`行1951-1959: 既存ターミナルポーリングがACTIVE=2秒/IDLE=5秒
- 既存のvisibilitychange対応（行1940-1945）がバックグラウンドタブ停止パターンの参考

**推奨対応**:
(1) document.visibilitychange APIによるバックグラウンドタブでのポーリング停止を必須要件とする。(2) Issueの受け入れ条件に「ブラウザタブが非アクティブの場合はポーリングを停止する」を追加。(3) ファイルツリーポーリングでルートのみ取得し、ハッシュ比較で変更なしなら展開ディレクトリの再取得をスキップする方式を設計の必須要素として強調する。

---

## Should Fix（推奨対応）

### F3: FileTab型へのisDirtyフィールド追加による既存コードへの影響範囲が広い

**カテゴリ**: 破壊的変更・後方互換性

**問題**:
`useFileTabs.ts`のFileTab型にisDirtyフィールドを追加する場合の影響箇所:

1. `fileTabsReducer`の複数アクション（OPEN_FILE, RESTORE, SET_CONTENT等）でisDirtyの初期値設定が必要
2. `FileTabsAction`型に`SET_DIRTY`アクション追加が必要
3. localStorage永続化でisDirtyの扱い決定（リストア時は常にfalse）
4. `FilePanelTabs.tsx`、`FilePanelContent.tsx`のprops伝搬チェーン
5. データフロー: MarkdownEditor -> onDirtyChange -> FilePanelContent -> dispatch SET_DIRTY -> useFileTabs state

**推奨対応**:
Issueの変更対象ファイルにFilePanelTabs.tsx、FilePanelSplit.tsxを追加する。FileTabsAction型へのSET_DIRTYアクション追加を設計に明記する。isDirtyの更新データフローを明示的に記述すると実装時の認識齟齬を防げる。

---

### F4: 304 Not Modified対応がファイルAPI GETハンドラの既存レスポンス形式に影響

**カテゴリ**: 影響ファイル・依存関係

**問題**:
現在のファイルAPI GETは`NextResponse.json`でJSONレスポンスを返す。304対応を追加する際の技術的注意点:

1. テキストファイルのGETで`fs.stat`を呼んでいない（行257-271） -- statコール追加が必要
2. HTTPの304ステータスは`response.ok === false`となるため、FilePanelContentの既存エラーハンドリング（行653-676）が304を誤ってエラーとして処理する
3. 画像・動画のGETハンドラ部分のスコープ確認が必要

**証拠**:
- `FilePanelContent.tsx`行659: `if (!response.ok)` で304がエラー分岐に入る
- `route.ts`行257-271: テキストファイルGETではstatを使用していない

**推奨対応**:
ポーリング用のfetchロジックを初回読み込みとは別に設計する。`response.status === 304`の場合は「変更なし」として処理する分岐を追加。画像・動画ファイルのLast-Modified対応はスコープ内/外を明記する。

---

### F5: テスト計画が未記載であり、影響範囲に応じたテストケースが不明

**カテゴリ**: テスト範囲

**問題**:
受け入れ条件にテスト要件の記載がない。変更が複数コンポーネントとAPIルートにまたがるため、テスト計画が必要。

**推奨テストケース**:
1. `useFileTabs` reducerのisDirty関連アクション単体テスト
2. ファイルAPI GETの304レスポンス結合テスト
3. ポーリング開始/停止のライフサイクルテスト（`vi.useFakeTimers`使用）
4. `isDirty === true`のタブでポーリング更新がスキップされることの検証

---

### F6: WorktreeDetailRefactored.tsxの既存fileTreeRefresh状態管理との統合設計が必要

**カテゴリ**: 影響ファイル・依存関係

**問題**:
`WorktreeDetailRefactored.tsx`では`fileTreeRefresh`状態を11箇所でインクリメントしてFileTreeViewの手動リフレッシュを制御している。ポーリングによる自動更新が加わると、手動リフレッシュと自動ポーリングの2系統が並存する。

また、ポーリング条件「Filesタブがアクティブな場合のみ」の判定には`state.layout.leftPaneTab`へのアクセスが必要だが、これはFileTreeViewの外部状態である。

**推奨対応**:
FileTreeViewコンポーネントに`isPollingEnabled`等のbooleanプロパティを追加し、WorktreeDetailRefactored.tsxから左ペインタブの状態に応じてtrueを渡す設計とする。これにより既存のrefreshTriggerによる手動更新と自動ポーリングの共存が明確になる。

---

## Nice to Have（あれば良い）

### F7: CLAUDE.mdのモジュール一覧にポーリング定数やフックの追記が必要になる可能性

ポーリング間隔定数やカスタムフック（useFileTreePolling等）を新設する場合、CLAUDE.mdの更新が必要。実装完了後の対応で可。

---

### F8: ポーリング追加がデバッグ/開発時のAPI呼び出しログに与える影響

`src/lib/api-logger.ts`による開発環境ロギングが有効な場合、5秒ごとのポーリングでコンソールにログが大量出力される。既存ターミナルポーリングのログと合わせて開発体験への影響を考慮する必要がある。

---

## 影響ファイル一覧

### 直接変更が必要なファイル（Issue記載済み）

| ファイル | 変更内容 |
|---------|---------|
| `src/components/worktree/FileTreeView.tsx` | ポーリングロジック追加 |
| `src/components/worktree/FilePanelContent.tsx` | ポーリングロジック追加、304ハンドリング |
| `src/hooks/useFileTabs.ts` | FileTab型にisDirty追加、SET_DIRTYアクション追加 |
| `src/components/worktree/MarkdownEditor.tsx` | onDirtyChangeコールバック追加 |
| `src/app/api/worktrees/[id]/files/[...path]/route.ts` | Last-Modified/If-Modified-Since/304対応 |
| `src/app/api/worktrees/[id]/tree/route.ts` | 直接変更不要（Issue記載の通りクライアント側ハッシュ比較方式） |

### 追加で影響を受けるファイル（Issue未記載）

| ファイル | 影響内容 |
|---------|---------|
| `src/components/worktree/FilePanelTabs.tsx` | isDirtyのprops伝搬（間接的） |
| `src/components/worktree/FilePanelSplit.tsx` | props変更の可能性（isDirtyの伝搬経路による） |
| `src/components/worktree/WorktreeDetailRefactored.tsx` | isPollingEnabled prop追加、左ペインタブ状態連携 |

### テストファイル（新規追加推奨）

| ファイル | テスト内容 |
|---------|---------|
| `tests/unit/useFileTabs.test.ts` | isDirty/SET_DIRTYアクションのreducerテスト |
| `tests/integration/file-api-304.test.ts` | 304 Not Modified応答テスト |
| `tests/unit/file-tree-polling.test.ts` | ポーリングライフサイクルテスト |

---

## 既存ポーリングパターンとの比較

| 項目 | ターミナルポーリング（既存） | ファイルツリーポーリング（新規） | ファイル内容ポーリング（新規） |
|------|:---:|:---:|:---:|
| 間隔 | 2秒(active)/5秒(idle) | 5秒（固定） | 5秒（固定） |
| 停止条件 | loading/error時 | Filesタブ非アクティブ時 | タブなし/isDirty時 |
| visibilitychange対応 | あり | **要実装** | **要実装** |
| 差分検知 | なし（毎回全取得） | クライアント側ハッシュ比較 | If-Modified-Since/304 |
| 排他制御 | なし | **要検討**（refreshTriggerとの競合） | fetchingRef（既存） |
