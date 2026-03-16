# Issue #506 影響範囲レビューレポート

**レビュー日**: 2026-03-16
**フォーカス**: 影響範囲レビュー
**イテレーション**: 1回目
**ステージ**: 3

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 1 |
| Should Fix | 3 |
| Nice to Have | 2 |

---

## Must Fix（必須対応）

### MF-1: ToastContainerのstacking context問題

**カテゴリ**: 影響ファイル
**場所**: Toast通知の実装方針 / 影響範囲

**問題**:
ToastContainerは`position: fixed`（`bottom-4 right-4`）で配置されるが、Sidebar自体も`position: fixed`かつ`transform`アニメーション付きで`z-index: 30`（`Z_INDEX.SIDEBAR`）の中に描画される。CSSの仕様上、`transform`が適用された要素は新しいcontaining blockを生成するため、子要素の`position: fixed`はviewportではなくその要素を基準とする。結果として、ToastContainer（`z-index: 60`）がSidebar内部に閉じ込められ、メインコンテンツ領域に正しく表示されない可能性がある。モバイルドロワー（`z-50`）内でも同様の問題が発生する。

**証拠**:
- `src/config/z-index.ts`: `SIDEBAR=30`, `TOAST=60`
- `AppShell.tsx` 101-114行目: Sidebarは`<aside>`内に`fixed` + `transform` + `z-index`で配置
- 既存のToast利用箇所（MarkdownEditor, WorktreeDetailRefactored等）はメインコンテンツ領域内に配置されておりこの問題は発生しない

**推奨対応**:
以下のいずれかの方針をIssueに明記し、実装すること:
1. React Portalを使ってToastContainerを`document.body`に直接マウントする
2. ToastContainerをSidebar内部ではなくAppShell（またはその親）レベルに配置する
3. Sidebarの`transform`によるstacking context問題を回避する別の手法を採用する

---

## Should Fix（推奨対応）

### SF-1: memo化コンポーネントへのuseToast追加によるパフォーマンス影響

**カテゴリ**: 依存関係
**場所**: 主要な変更点

**問題**:
`Sidebar`は`memo`化されたコンポーネントだが、`useToast`フックの内部state（toasts配列）が変更されるたびに再レンダリングが発生する。Toast表示/非表示のたびにworktree一覧全体（useMemoチェーン含む）が再レンダリングされる可能性がある。

**証拠**:
- `Sidebar.tsx` 43行目: `memo(function Sidebar())`
- `memo`はpropsの変更を検出するが、内部の`useState`/`useReducer`は常に再レンダリングを引き起こす
- useMemoチェーン（63-84行目）の再評価コストが発生

**推奨対応**:
以下のいずれかの方針を明記:
1. 同期ボタン+Toast部分を小さなラッパーコンポーネントに分離し、Sidebar本体の再レンダリングを回避する
2. パフォーマンスへの影響が許容範囲であることを判断し、その旨を明記する

---

### SF-2: 既存テストへの影響とテスト観点の不足

**カテゴリ**: テスト範囲
**場所**: 実装タスク

**問題**:
既存の`Sidebar.test.tsx`はapi-clientモックで`worktreeApi`のみをモックしており、`repositoryApi`のモックが含まれていない。同期ボタンの追加により、既存テストのモック設定を拡張する必要がある。また、テスト観点が具体的に記載されていない。

**証拠**:
- `tests/unit/components/layout/Sidebar.test.tsx` 31-40行目: `vi.mock`で`worktreeApi`のみモック

**推奨対応**:
ユニットテストの具体的なテスト観点をIssueに記載:
1. 同期ボタンクリックで`repositoryApi.sync()`が呼ばれること
2. sync成功後に`refreshWorktrees()`が呼ばれること
3. sync中はボタンがdisabledになること
4. sync失敗時にエラーToastが表示されること
5. 既存テストの`api-client`モックに`repositoryApi`を追加する旨を明記

---

### SF-3: 既存ポーリングとの競合

**カテゴリ**: 依存関係
**場所**: 動作フロー

**問題**:
`WorktreeSelectionContext`は2-10秒間隔で`worktreeApi.getAll()`をポーリングしている。同期ボタンの`refreshWorktrees()`も同じ`fetchWorktrees()`を呼ぶため、タイミングによっては二重にAPI呼び出しが発生する。機能的な問題はないが、不要なネットワークリクエストが発生する。

**証拠**:
- `WorktreeSelectionContext.tsx` 233-271行目: setTimeoutベースのポーリング（2-10秒間隔）
- `refreshWorktrees()`（222-224行目）は同じ`fetchWorktrees`を呼ぶ

**推奨対応**:
既存ポーリングとの関係について以下のいずれかの方針を明記:
1. 許容する（二重fetchは冪等なので機能的に問題なし）
2. `refreshWorktrees`呼び出し時にポーリングタイマーをリセットする機構を追加

---

## Nice to Have（あれば良い）

### NTH-1: CLAUDE.mdのモジュール一覧更新

**カテゴリ**: ドキュメント更新
**場所**: 影響範囲

**問題**:
CLAUDE.mdのモジュール一覧にSidebar.tsxは直接記載されていないが、同期ボタン機能の追加後にドキュメント更新が必要かどうかの判断が未記載。

**推奨対応**:
実装完了後のドキュメント更新タスクとしてCLAUDE.mdへの反映要否を確認するとよい。

---

### NTH-2: アイコン実装方針の明確化

**カテゴリ**: 移行考慮
**場所**: 実装タスク

**問題**:
同期ボタンのアイコン（回転矢印）の実装方針が未確定。既存のSidebar.tsxはインラインSVG（ChevronIcon, GroupIcon等）を使用しているが、Toast.tsxはlucide-react（CheckCircle, XCircle等）を使用。どちらのパターンに合わせるかで依存関係が変わる。

**推奨対応**:
既存のSidebar.tsxのパターン（インラインSVG）に合わせるか、lucide-react（`RefreshCw`等）を使用するかを明記するとよい。

---

## 影響範囲マトリクス

| ファイル | 変更種別 | 影響度 | 備考 |
|---------|---------|--------|------|
| `src/components/layout/Sidebar.tsx` | 直接変更 | 高 | 同期ボタンUI + ハンドラ + Toast追加 |
| `src/components/layout/AppShell.tsx` | 間接影響 | 中 | stacking contextの影響。変更不要の可能性あり |
| `src/components/common/Toast.tsx` | 参照のみ | 低 | 変更なし。既存機能の利用 |
| `src/config/z-index.ts` | 参照のみ | 低 | 変更なし。stacking context問題の根拠 |
| `src/contexts/WorktreeSelectionContext.tsx` | 間接影響 | 低 | 変更なし。ポーリング競合の認識のみ |
| `src/lib/api-client.ts` | 参照のみ | 低 | 変更なし。repositoryApi.syncの利用 |
| `tests/unit/components/layout/Sidebar.test.tsx` | テスト拡張 | 中 | repositoryApiモック追加 + 新テストケース |

## 破壊的変更

なし。既存のAPIやコンポーネントインターフェースに変更はない。Sidebar.tsxへの機能追加のみ。

## 参照ファイル

### コード
- `src/components/layout/Sidebar.tsx`: 同期ボタン追加先（memo化、インラインSVGアイコン）
- `src/components/layout/AppShell.tsx`: Sidebarのマウント先（fixed + transform）
- `src/components/common/Toast.tsx`: ToastContainer（position: fixed, z-index: 60）
- `src/config/z-index.ts`: z-index定義（SIDEBAR=30, TOAST=60）
- `src/contexts/WorktreeSelectionContext.tsx`: ポーリング機構、refreshWorktrees()
- `src/lib/api-client.ts`: repositoryApi.sync()定義
- `tests/unit/components/layout/Sidebar.test.tsx`: 既存テスト（repositoryApiモック未定義）
- `src/app/api/repositories/sync/route.ts`: sync API実装

### ドキュメント
- `CLAUDE.md`: モジュール一覧の更新検討
