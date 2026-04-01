# Issue #600 レビューレポート

**レビュー日**: 2026-04-01
**フォーカス**: 通常レビュー
**イテレーション**: 1回目
**レビュアー**: opus

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 3 |
| Should Fix | 4 |
| Nice to Have | 3 |

Issue #600 は CommandMate の Web UI を 5 画面体制（Home / Sessions / Repositories / Review / More）に再編する大規模な UX 刷新提案である。全体の方向性と背景は明確だが、Review 画面の中核概念（Stalled / Approval）が既存データモデルに存在しない点、/worktrees/:id/reply の仕様不足、視認性ルールの「次アクション」の定義欠如が主な問題として検出された。

---

## Must Fix（必須対応）

### S1-MF-001: Review画面の「Done / Approval / Stalled」概念が現在のデータモデルに存在しない

**カテゴリ**: 整合性
**場所**: Issue本文「Review を Done / Approval / Stalled の処理面として設ける」

**問題**:
Review画面の中核となる3つのステータス分類のうち、「Approval」と「Stalled」は現在のWorktreeモデルにもSessionStatusにも定義されていない。

- Worktree.status は `'todo' | 'doing' | 'done' | null` の4値のみ
- SessionStatus は `'idle' | 'ready' | 'running' | 'waiting'` の4値
- 「Done」はWorktree.status = 'done'で表現可能だが、「Approval」「Stalled」の判定基準が不明

**証拠**:
- `src/types/models.ts` L73: `status?: 'todo' | 'doing' | 'done' | null`
- `src/lib/detection/status-detector.ts` L36: `SessionStatus = 'idle' | 'ready' | 'running' | 'waiting'`
- PromptType に `'approval'` は存在するが、これはプロンプト種別でありWorktreeレベルのステータスではない

**推奨対応**:
Issueに以下を明記する:
1. Stalled の判定ロジック（例: running状態で一定時間出力変化なし）
2. Approval の定義（PromptType 'approval' との関係、またはWorktreeレベルの新ステータス）
3. これらがDBスキーマ変更を伴うのか、ランタイム計算で導出するのか

---

### S1-MF-002: 視認性ルールの「次アクション」の定義が不明確

**カテゴリ**: 曖昧性
**場所**: Issue本文「すべての session/worktree 行・カードに、最低でも Repository名 / Branch名 / Agent / Status / 次アクション を表示する」

**問題**:
「次アクション」が何を意味するか定義されていない。これは表示項目の必須要件として挙げられているにもかかわらず、以下のいずれかが不明:

- システムがステータスに基づき自動推定するCTA（例: "Reply to prompt", "Review diff"）
- ユーザーが手動設定するフリーテキスト
- ステータスと固定のマッピングテーブル

**証拠**:
- 現在のWorktreeモデルに nextAction 相当のフィールドは存在しない
- UXプロトタイプHTMLではカードごとに異なるアクションテキストが表示されている（例: "Open diff / create PR / archive", "Choose strict validation policy"）

**推奨対応**:
「次アクション」の算出ロジックを定義する。例: ステータスとセッション状態の組み合わせから自動導出するマッピングテーブルを記載する。

---

### S1-MF-003: /worktrees/:id/reply の位置づけと挙動が未定義

**カテゴリ**: 曖昧性
**場所**: Issue本文「新設・再編対象URL」および実装タスク

**問題**:
`/worktrees/:id/reply` が新設URLとして挙げられ、実装タスクにも含まれているが、以下が未定義:

1. どのようなUI形態か（フルページ / モーダル / ボトムシート）
2. 既存の `/worktrees/:id` のメッセージ入力フォームとの違い
3. 「軽量」が何を意味するか（コンポーネント数? ロード時間? 表示情報量?）
4. PC / モバイルでの表示差異

「もしくは同等の軽量返信導線」という表現は実装方針が未確定であることを示しており、受け入れ条件として検証不可能。

**推奨対応**:
reply画面の具体的な仕様を記載するか、または設計フェーズで別途Issueとして切り出す旨を明記する。

---

## Should Fix（推奨対応）

### S1-SF-001: サイドバーの扱いが未記載

**カテゴリ**: 完全性
**場所**: Issue本文全体

**問題**:
現在の AppShell は全画面でサイドバー（Branches一覧）を表示する構造だが、新しい5画面体制でサイドバーがどうなるかの記載がない。Sessions画面がWorktree探索の専用面として設けられると、サイドバーのBranches一覧と責務が重複する可能性がある。

**証拠**:
- `src/components/layout/AppShell.tsx`: 全ページ共通でSidebarを表示
- `src/components/layout/Sidebar.tsx`: ブランチ検索・一覧表示（Sessions画面と責務重複の可能性）

**推奨対応**:
以下のいずれかを明記する:
- サイドバーを全画面で維持し、Sessions画面はより高機能な探索面とする
- サイドバーをWorktree Detail画面のみに限定する
- サイドバーを廃止し、Sessions画面に完全統合する

---

### S1-SF-002: PCとモバイルのナビゲーション構造が具体化されていない

**カテゴリ**: 完全性
**場所**: Issue本文「PC / モバイル双方で整合的な遷移と情報設計を定義する」

**問題**:
目標として「整合的な遷移」が挙げられているが、具体的なナビゲーション構造の記載がない。UXプロトタイプHTMLではモバイルにボトムタブバー（4タブ: Home / Sessions / Repos / More）が見られるが、Issue本文には反映されていない。

現在のモバイルナビゲーション（MobileTabBar）はWorktree Detail専用の5タブ構成であり、グローバルナビとの共存方法が不明。

**証拠**:
- `src/components/mobile/MobileTabBar.tsx`: `MobileTab = 'terminal' | 'history' | 'files' | 'memo' | 'info'`
- プロトタイプHTML: Home / Sessions / Repos / More の4タブ

**推奨対応**:
PC（トップナビ or サイドナビ）とモバイル（ボトムタブバー）の具体的なナビゲーション構造をIssue本文に追記する。特にWorktree Detail画面に入った際のローカルナビとグローバルナビの切り替え方法を明記する。

---

### S1-SF-003: query paramによるdeep link戦略の技術的制約が未考慮

**カテゴリ**: 実現可能性
**場所**: Issue本文 `/worktrees/:id?pane=history|terminal|files|logs|notes|git`

**問題**:
WorktreeDetailRefactored（1966行）は `'use client'` のクライアントコンポーネントで、タブ状態をuseStateで管理している。query paramベースのdeep linkに変更すると以下の技術的考慮が必要:

1. Next.js 14 App Routerでの `useSearchParams()` はクライアントコンポーネント内で使用可能だが、タブ切替ごとにURLを更新する方法（router.push vs router.replace vs window.history.replaceState）の選択
2. ブラウザの戻る/進むボタンとの整合性
3. 既存MobileTabBarとの統合方法

**推奨対応**:
技術的なアプローチの選択肢と制約をIssueに記載するか、設計タスクとして分離する。

---

### S1-SF-004: 受け入れ条件の検証基準が不十分

**カテゴリ**: 正確性
**場所**: Issue本文「受け入れ条件」セクション

**問題**:
受け入れ条件の多くが主観的・抽象的な表現にとどまっている:

- 「責務が明確である」 -- 誰が何をもって「明確」と判断するか
- 「整合した遷移が定義・実装される」 -- 「整合」の基準が不明
- 「URL設計と画面遷移がドキュメント化されている」 -- ドキュメントの場所・形式が未指定

**推奨対応**:
各受け入れ条件に具体的な検証方法を追加する。例:
- 「各画面の責務がdocs/architecture.mdに記載されている」
- 「全てのURL間遷移がE2Eテストでカバーされている」
- 「モバイルの全タブ遷移がPlaywrightテストで検証されている」

---

## Nice to Have（あれば良い）

### S1-NTH-001: External Appsの移動が実装タスクに暗黙的

**カテゴリ**: 完全性
**場所**: Issue本文「実装タスク」セクション

**問題**:
目標では「More を External Apps / ... の補助面として整理する」と記載されているが、現行ホーム（`src/app/page.tsx` L39）に配置されている ExternalAppsManager をMore画面に移動するタスクが暗黙的に含まれている。明示的なタスク項目として追加すると見落としを防げる。

---

### S1-NTH-002: 新規URLの認証対応への言及がない

**カテゴリ**: 完全性
**場所**: Issue本文全体

**問題**:
新規URL（/sessions, /repositories, /review, /more）はmiddleware.tsによる認証保護が必要。既存の認証フローへの組み込みは自明かもしれないが、明記するとよい。

---

### S1-NTH-003: UXプロトタイプHTMLへの具体的なパス参照がない

**カテゴリ**: 完全性
**場所**: Issue本文「参考」セクション

**問題**:
Issue本文では「UXプロトタイプHTMLをdev-reports配下へ移動して管理する」と記載されているが、既に `dev-reports/design/issue-600-ux-refresh-html/` に26ファイルが配置済み。具体的なパスへのリンクを追加すると参照しやすくなる。

---

## 参照ファイル

### コード
| ファイル | 関連性 |
|---------|--------|
| `src/app/page.tsx` | 現行ホーム画面。分解対象 |
| `src/components/layout/AppShell.tsx` | 全画面共通レイアウト。サイドバー表示制御 |
| `src/components/layout/Sidebar.tsx` | ブランチ一覧サイドバー。Sessions画面との責務重複の可能性 |
| `src/components/mobile/MobileTabBar.tsx` | モバイルタブバー（Worktree Detail専用5タブ） |
| `src/types/models.ts` | Worktreeモデル定義。Review画面に必要なステータスが未定義 |
| `src/lib/detection/status-detector.ts` | セッションステータス検出。Stalled判定の基盤候補 |
| `src/components/worktree/WorktreeDetailRefactored.tsx` | Worktree詳細画面（1966行） |
| `src/contexts/SidebarContext.tsx` | サイドバー状態管理 |

### ドキュメント
| ファイル | 関連性 |
|---------|--------|
| `dev-reports/design/issue-600-ux-refresh-html/` | UXプロトタイプHTML群（26ファイル） |
| `CLAUDE.md` | プロジェクト全体の構成・技術スタック定義 |
