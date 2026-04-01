# Issue #600 影響範囲レビューレポート（Stage 3）

**レビュー日**: 2026-04-01
**フォーカス**: 影響範囲レビュー（1回目）
**レビュアー**: opus

---

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 3 |
| Should Fix | 7 |
| Nice to Have | 3 |

Issue #600 は CommandMate のUI構造を根本的に再設計する大規模変更である。影響範囲は新規ファイル約10個、変更ファイル約18個に及ぶ。DBスキーマ変更は不要で、APIの破壊的変更もないため、バックエンドへの影響は限定的。最大のリスクは WorktreeDetailRefactored.tsx のdeep link対応、AppShellレイアウト構造変更の全画面波及、Review画面のStalled判定パフォーマンスの3点。

---

## Must Fix（必須対応）

### S3-001: Home画面（/）の責務分解による既存ブックマーク・リンクへの影響が未定義

**カテゴリ**: 後方互換性

**問題**:
現在の `/` は WorktreeList + RepositoryManager + ExternalAppsManager を一括表示している（`src/app/page.tsx`）。Issue計画ではこれらを `/sessions`, `/repositories`, `/more` に分離するが、既存ユーザーが `/` にブックマークしている場合の移行パスが未定義。`/` をHome（Mission Control）に置き換えると、従来の操作フロー（Repositoryの追加、Worktreeの一覧表示など）が `/` から直接到達できなくなる。

**影響ファイル**:
- `src/app/page.tsx`
- `src/components/worktree/WorktreeList.tsx`
- `src/components/repository/RepositoryManager.tsx`
- `src/components/external-apps/ExternalAppsManager.tsx`

**推奨対応**:
受け入れ条件に「Home画面から各専門画面への導線が1クリックで到達可能であること」を明記する。また、移行期間中の旧UIフォールバックの要否を検討する。

---

### S3-002: WorktreeDetailRefactored.tsx（1966行）のdeep link対応が大規模リファクタリングを伴う

**カテゴリ**: コンポーネント影響

**問題**:
deep link戦略では現在のuseStateベースのタブ管理をuseSearchParams()ベースに移行する。WorktreeDetailRefactored.tsxは1966行の大規模コンポーネントで、タブ状態はDesktopのLeftPaneTab選択とMobileのMobileTab選択の2系統がある。変更には全タブ制御ロジックの書き換え、MobileTabBarへのsearchParams連携、router.replace呼び出しの追加が必要。関連テスト23ファイル以上に波及する。

**影響ファイル**:
- `src/components/worktree/WorktreeDetailRefactored.tsx`
- `src/components/mobile/MobileTabBar.tsx`
- `src/components/worktree/WorktreeDetailSubComponents.tsx`
- `src/components/worktree/LeftPaneTabSwitcher.tsx`
- テストファイル10個以上

**推奨対応**:
deep link対応を別サブタスクとして分離し、段階的に実装する。Phase 1: 新画面の枠組み作成、Phase 2: deep link移行。テスト修正計画も事前に立てること。

---

### S3-003: middleware.tsの認証マッチャー設定に関するIssue記述の不正確さ

**カテゴリ**: 認証・セキュリティ

**問題**:
現在のmiddleware.tsのmatcher設定は静的アセット以外の全パスにマッチするワイルドカード構成のため、新規URL（/sessions, /repositories, /review, /more）は自動的に認証対象になる。Issue記載の「ミドルウェアのマッチャーパスに新規URLを含めること」は追加作業が実際には不要であり、記述が誤解を招く。ただし、テストによる検証は必須。

**影響ファイル**:
- `src/middleware.ts`
- `src/config/auth-config.ts`

**推奨対応**:
Issueの実装タスクを「新規URLが既存の認証ミドルウェアで正しく保護されることをテストで検証する」に修正する。`tests/integration/auth-middleware.test.ts` に新規URL用の検証ケースを追加する。

---

## Should Fix（推奨対応）

### S3-004: AppShell.tsxへのグローバルナビゲーション追加がレイアウト構造を根本的に変更する

**カテゴリ**: コンポーネント影響

**問題**:
現在のAppShellはSidebar + Main contentの2列構造。Issue計画ではPCヘッダーに水平ナビ5画面の追加、モバイルにボトムタブバー4タブの追加、Sessions画面でのサイドバー自動折りたたみが必要。Header.tsxの現在の実装はシンプルなロゴ+GitHubリンクのみで、大幅な改修が必要。

**影響ファイル**:
- `src/components/layout/AppShell.tsx`
- `src/components/layout/Header.tsx`
- `src/contexts/SidebarContext.tsx`
- テストファイル2個

**推奨対応**:
SidebarContextに `autoCollapsedPaths` 設定を追加し、パスベースの自動折りたたみを宣言的に制御する。Header.tsxは完全書き直し前提で設計する。

---

### S3-005: モバイルのグローバルナビとローカルナビの排他制御

**カテゴリ**: コンポーネント影響

**問題**:
モバイルのグローバルナビ（Home/Sessions/Review/More）とWorktree Detail内ローカルナビ（terminal/history/files/memo/info）の排他表示には、URLパス判定、新コンポーネント作成、AppShellレベルの条件分岐が必要。

**影響ファイル**:
- `src/components/mobile/MobileTabBar.tsx`
- `src/components/layout/AppShell.tsx`
- `src/app/layout.tsx`

**推奨対応**:
グローバルナビ用に `GlobalMobileNav.tsx` を新規作成し、AppShell内で `usePathname()` に基づいて切り替える。既存MobileTabBarの変更は最小限にとどめる。

---

### S3-006: Review画面のStalled判定にはAPI拡張が必要

**カテゴリ**: API影響

**問題**:
Stalled状態は「SessionStatus === 'running' かつ最終出力からN秒経過」で算出されるが、現在のworktrees APIレスポンスには最終出力タイムスタンプが含まれていない。サーバーサイドでの算出が必要。

**影響ファイル**:
- `src/app/api/worktrees/route.ts`
- `src/lib/session/worktree-status-helper.ts`
- `src/lib/detection/status-detector.ts`

**推奨対応**:
既存 GET /api/worktrees にquery param `?include=review` を追加してReview用フィールドを返す方式を推奨。STALLED_THRESHOLD_MS定数は `src/config/review-config.ts` に定義する。Stalled判定はtmux captureではなく `getLastServerResponseTimestamp` を活用する。

---

### S3-007: 新設4画面のPage コンポーネントとNext.js App Router構造の追加

**カテゴリ**: コンポーネント影響

**問題**:
Sessions, Repositories, Review, Moreの4画面新設には、`src/app/{name}/page.tsx` の4ファイル新規作成が必要。特にSessions画面はWorktreeList.tsxの機能を大幅に取り込むため、既存コンポーネントの分解・再利用戦略が重要。

**推奨対応**:
WorktreeList.tsx内のフィルタリング・ソート・検索ロジックを共通hooksに抽出し再利用可能にする。RepositoryManager.tsxとExternalAppsManagerはほぼそのまま移動可能。

---

### S3-008: 既存テスト23ファイル以上への影響と新規テスト要件

**カテゴリ**: テスト影響

**問題**:
AppShell、WorktreeDetail、MobileTabBar、Sidebar、SidebarContext、auth-middlewareの各テストファイルが影響を受ける。さらに新規テストとして各画面のレンダリングテスト、グローバルナビ遷移テスト、deep link復元テスト、getNextAction()ユニットテストが必要。

**推奨対応**:
テスト修正の優先順位: Phase 1: 新規画面スモークテスト、Phase 2: 既存テスト修正、Phase 3: deep link・Reviewテスト追加。

---

### S3-009: Review画面のリアルタイムStalled判定のパフォーマンス影響

**カテゴリ**: パフォーマンス影響

**問題**:
Review画面を開いた状態でのポーリングが、既存のDetail画面のポーリングと合わせて tmux capture の負荷を増大させる可能性がある。特にworktree数が多い環境で顕著。

**推奨対応**:
Stalled判定はtmux captureではなく `getLastServerResponseTimestamp` を活用する。Review画面のポーリング間隔は5-10秒とし、Detail画面より低頻度にする。

---

### S3-010: Review画面のインライン返信フォーム実装方針

**カテゴリ**: コンポーネント影響

**問題**:
Review画面の各カード内にインライン返信フォームを配置する計画だが、既存MessageInputは多機能。新規コンポーネントを作るか、既存にsimplifiedモードを追加するかの設計判断が必要。

**推奨対応**:
MessageInputに `variant='simplified'` propsを追加する方式を推奨。新規コンポーネントは機能差分の乖離リスクが高い。

---

## Nice to Have（あれば良い）

### S3-011: CLIコマンドへの直接影響はないがAPI拡張時の後方互換性に注意

CLIコマンドはAPI経由で動作しており、UI変更による直接影響はない。worktrees APIレスポンスに追加フィールドを入れる場合はオプショナルフィールドとして追加し、`src/cli/types/api-responses.ts` の後方互換性を維持する。

### S3-012: getNextAction()に必要なデータ取得効率の確認

Home画面が集計値を表示する場合、API効率化の検討が有益。初期実装ではクライアントサイド集計で十分。

### S3-013: docs/architecture.mdおよびCLAUDE.mdへの更新

受け入れ条件に含まれるドキュメント更新の追記箇所を事前に特定しておく。

---

## 影響範囲サマリー

### 新規作成ファイル（約10個）

| ファイル | 役割 |
|---------|------|
| `src/app/sessions/page.tsx` | Sessions画面 |
| `src/app/repositories/page.tsx` | Repositories画面 |
| `src/app/review/page.tsx` | Review画面 |
| `src/app/more/page.tsx` | More画面 |
| `src/components/mobile/GlobalMobileNav.tsx` | モバイルグローバルナビ |
| `src/components/review/ReviewCard.tsx` | Reviewカードコンポーネント |
| `src/components/review/InlineReplyForm.tsx` | インライン返信フォーム |
| `src/components/home/HomeSessionSummary.tsx` | Home画面セッションサマリー |
| `src/lib/session/next-action-helper.ts` | getNextAction()ヘルパー |
| `src/config/review-config.ts` | Review画面設定定数 |

### 変更ファイル（約18個）

| ファイル | 変更内容 |
|---------|---------|
| `src/app/page.tsx` | Home画面（Mission Control）に全面書き換え |
| `src/components/layout/AppShell.tsx` | グローバルナビ追加、パスベース折りたたみ |
| `src/components/layout/Header.tsx` | 5画面水平ナビゲーション追加（全面書き直し） |
| `src/components/worktree/WorktreeDetailRefactored.tsx` | deep link対応（useSearchParams移行） |
| `src/components/mobile/MobileTabBar.tsx` | searchParams連携 |
| `src/contexts/SidebarContext.tsx` | 自動折りたたみ機能追加 |
| `src/app/api/worktrees/route.ts` | Review用フィールド追加 |
| `src/lib/session/worktree-status-helper.ts` | Stalled判定追加 |
| `docs/architecture.md` | URL設計・画面遷移追記 |
| `CLAUDE.md` | ファイル構成更新 |

### 削除ファイル

なし（既存コンポーネントは移動・再利用）

### DBスキーマ変更

不要

### 推奨実装フェーズ

| Phase | 内容 | リスク |
|-------|------|-------|
| Phase 1 | 4画面の枠組み作成 + グローバルナビ + 認証テスト | 低 |
| Phase 2 | Home画面リデザイン + Review画面（Stalled判定含む） | 中 |
| Phase 3 | deep link対応 + MobileTabBar統合 | 高 |
| Phase 4 | テスト修正 + ドキュメント更新 | 低 |

---

## 参照ファイル

### コード
- `src/app/page.tsx`: 現行ホーム画面（全面書き換え対象）
- `src/components/layout/AppShell.tsx`: 全画面共通レイアウト（グローバルナビ追加対象）
- `src/components/layout/Header.tsx`: ヘッダー（5画面ナビ追加対象、現在はロゴ+GitHubリンクのみ）
- `src/components/worktree/WorktreeDetailRefactored.tsx`: 1966行のメイン画面（deep link対応対象）
- `src/components/mobile/MobileTabBar.tsx`: モバイルローカルナビ（searchParams統合対象）
- `src/middleware.ts`: 認証ミドルウェア（新規URL保護確認対象）
- `src/lib/session/worktree-status-helper.ts`: セッション状態検出（Stalled判定追加対象）
- `src/lib/detection/status-detector.ts`: SessionStatus定義
- `src/lib/polling/auto-yes-manager.ts`: getLastServerResponseTimestamp（Stalled判定活用候補）

### ドキュメント
- `docs/architecture.md`: URL設計・画面遷移追記先
- `CLAUDE.md`: ファイル構成更新先
- `dev-reports/design/issue-600-ux-refresh-html/`: UXプロトタイプHTML（26ファイル）
