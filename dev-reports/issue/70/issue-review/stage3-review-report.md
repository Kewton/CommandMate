# Issue #70 影響範囲レビューレポート（Stage 3）

**レビュー日**: 2026-01-30
**フォーカス**: 影響範囲レビュー（1回目）
**ステージ**: 3/4

---

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 0 |
| Should Fix | 3 |
| Nice to Have | 4 |

Issue #70は新規ドキュメント（`docs/user-guide/webapp-guide.md`）の作成が主な変更であり、既存機能への破壊的変更はない。影響範囲は限定的で、主にREADME.mdのドキュメントテーブル更新と、既存ドキュメントとの相互参照の整備が必要。

---

## 影響分析

### 新規作成ファイル

| ファイル | 説明 |
|---------|------|
| `docs/user-guide/webapp-guide.md` | Webアプリ基本操作ガイド（本Issue主成果物） |

### 更新が必要なファイル

| ファイル | 更新内容 | 必須度 |
|---------|---------|--------|
| `README.md` | ドキュメントテーブルに新ガイドを追加 | **必須** |
| `docs/UI_UX_GUIDE.md` | 関連ドキュメントセクションに参照追加 | 任意 |
| `docs/concept.md` | 「始め方」セクションに新ガイドへの導線追加 | 任意 |

### 既存スクリーンショット（活用対象）

```
docs/images/
├── screenshot-desktop.png          # トップ画面（PC）
├── screenshot-mobile.png           # トップ画面（スマホ）
├── screenshot-worktree-desktop.png # ワークツリー詳細（PC）
├── screenshot-worktree-mobile.png  # ワークツリー詳細（スマホ）History
└── screenshot-worktree-mobile-terminal.png # ワークツリー詳細（スマホ）Terminal
```

### 関連ドキュメント

新ガイド作成時に参照・整合性確認が必要なドキュメント:

| ドキュメント | 関連性 |
|-------------|--------|
| `docs/UI_UX_GUIDE.md` | UI実装仕様の詳細。操作ガイドと補完関係 |
| `docs/features/sidebar-status-indicator.md` | ステータスインジケーター詳細 |
| `docs/concept.md` | コンセプト説明。始め方への導線 |
| `docs/DEPLOYMENT.md` | 環境変数設定の詳細 |

### ユーザー影響

- **新規ユーザー**: Webアプリの基本操作を習得するためのドキュメントが追加される
- **既存ユーザー**: 破壊的変更なし。参照可能なドキュメントが増加
- **ドキュメント発見性**: README.mdのテーブルに追加されることで発見性向上

### 関連Issue

| Issue | 関係 | 説明 |
|-------|------|------|
| #69 | 参照 | リポジトリ削除機能の操作手順を新ガイドに含める |
| #71 | 参照 | クローンURL登録機能の操作手順を新ガイドに含める |
| #31 | 参照 | ステータスインジケーター機能の説明を含める |
| #61 | 参照 | Auto Yesモードの操作手順を含める |
| #64 | 関連 | OSS公開準備で整備されたドキュメントとの整合性確保 |

---

## Should Fix（推奨対応）

### SF-1: README.md更新の受け入れ条件化

**カテゴリ**: ドキュメント更新
**場所**: 作成するドキュメント/備考セクション

**問題**:
README.mdのドキュメントテーブル更新がIssue本文の備考セクションに明記されているが、チェックリストの受け入れ条件として明確化されていない。

**証拠**:
```markdown
# README.md (92-102行目)
## ドキュメント

| ドキュメント | 説明 |
|-------------|------|
| [コンセプト](./docs/concept.md) | ビジョンと解決する課題 |
| [アーキテクチャ](./docs/architecture.md) | システム設計 |
| [デプロイガイド](./docs/DEPLOYMENT.md) | 本番環境構築手順 |
| [移行ガイド](./docs/migration-to-commandmate.md) | MyCodeBranchDesk からの移行手順 |
| [UI/UXガイド](./docs/UI_UX_GUIDE.md) | UI実装の詳細 |
| [クイックスタート](./docs/user-guide/quick-start.md) | Claude Codeコマンドの使い方 |
| [Trust & Safety](./docs/TRUST_AND_SAFETY.md) | セキュリティと権限の考え方 |
```

**推奨対応**:
「Issue完了時にREADME.mdのドキュメントテーブルに新ガイドを追加」を、受け入れ条件として明記するか、別チェックリスト項目として追加する。

---

### SF-2: UI_UX_GUIDE.mdとのクロスリファレンス

**カテゴリ**: 既存ドキュメントとの関連性
**場所**: 作成するドキュメント全体

**問題**:
新ガイドとUI_UX_GUIDE.mdの間のクロスリファレンスが明確に定義されていない。

**証拠**:
UI_UX_GUIDE.mdの関連ドキュメントセクション（288-293行目）:
```markdown
## 関連ドキュメント

- [README.md](../README.md) - プロジェクト概要
- [DEPLOYMENT.md](./DEPLOYMENT.md) - デプロイメントガイド
- [architecture.md](./architecture.md) - アーキテクチャ詳細
```

**推奨対応**:
1. 新ガイドからUI_UX_GUIDE.mdへの参照リンクを含める（詳細な画面構成説明として）
2. UI_UX_GUIDE.mdの関連ドキュメントセクションに新ガイドへのリンク追加を検討

---

### SF-3: スクリーンショット追加時の命名規則

**カテゴリ**: 影響範囲の明確化
**場所**: 備考セクション

**問題**:
スクリーンショットの追加撮影について「必要に応じて追加撮影」とあるが、新規撮影が必要な場合のファイル命名規則が不明確。

**証拠**:
```
docs/images/の既存ファイル:
- screenshot-desktop.png
- screenshot-mobile.png
- screenshot-worktree-desktop.png
- screenshot-worktree-mobile.png
- screenshot-worktree-mobile-terminal.png
```

**推奨対応**:
新規スクリーンショットを追加する場合は既存の命名規則（`screenshot-*.png`）に従うことを明記。また、追加が必要なスクリーンショットを事前に洗い出す（例: リポジトリ登録画面、削除確認ダイアログ等）。

---

## Nice to Have（あれば良い）

### NTH-1: concept.mdからの導線

**カテゴリ**: ドキュメント構造

`docs/concept.md`の「始め方」セクション（157-173行目）から新ガイドへの参照を追加することで、ユーザーの導線が改善される。

### NTH-2: CLAUDE.mdへの追加

CLAUDE.mdの「関連ドキュメント」セクションに新ガイドへのリンクを追加することで、開発者がユーザー向けドキュメントを把握しやすくなる。

### NTH-3: sidebar-status-indicator.mdとの連携

新ガイドでステータスインジケーターを説明する際、詳細は`docs/features/sidebar-status-indicator.md`を参照するよう誘導することで、ドキュメントの重複を避けられる。

### NTH-4: user-guideディレクトリの分類

`docs/user-guide/`配下は現在Claude Codeコマンド・エージェント向けのガイドで統一されているが、Webアプリ操作ガイドを追加することでガイドの種類が混在する。将来的にガイドが増えた場合を考慮し、インデックスファイル等での分類を検討。

---

## 参照ファイル一覧

### 更新対象ドキュメント

| ファイル | アクション | 備考 |
|---------|-----------|------|
| `README.md` | 更新 | ドキュメントテーブルに新ガイド追加 |
| `docs/UI_UX_GUIDE.md` | 任意更新 | 関連ドキュメントセクション |
| `docs/concept.md` | 任意更新 | 始め方セクションへの導線追加 |

### 参照対象ドキュメント

| ファイル | 参照理由 |
|---------|---------|
| `docs/features/sidebar-status-indicator.md` | ステータスインジケーター詳細の参照先 |
| `docs/DEPLOYMENT.md` | 環境変数設定の参照先 |
| `docs/user-guide/quick-start.md` | 既存user-guideの構成参考 |

### スクリーンショット

| ファイル | 用途 |
|---------|------|
| `docs/images/screenshot-desktop.png` | トップ画面説明に活用 |
| `docs/images/screenshot-mobile.png` | モバイル画面説明に活用 |
| `docs/images/screenshot-worktree-desktop.png` | ワークツリー詳細説明に活用 |
| `docs/images/screenshot-worktree-mobile.png` | モバイルHistory説明に活用 |
| `docs/images/screenshot-worktree-mobile-terminal.png` | モバイルTerminal説明に活用 |

---

## 結論

Issue #70の影響範囲は限定的であり、既存機能への破壊的変更はない。主な成果物は新規ドキュメント1ファイルの作成と、README.mdのテーブル更新である。

推奨事項として:
1. README.md更新を受け入れ条件として明確化
2. UI_UX_GUIDE.mdとの相互参照を検討
3. スクリーンショット追加時の命名規則を明記

これらの対応により、ドキュメント全体の整合性と発見性が向上する。
