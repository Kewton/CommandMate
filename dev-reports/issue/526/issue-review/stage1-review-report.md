# Issue #526 レビューレポート

**レビュー日**: 2026-03-20
**フォーカス**: 通常レビュー（整合性・正確性）
**イテレーション**: 1回目

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 0 |
| Should Fix | 4 |
| Nice to Have | 2 |

Issue #526 の原因分析は正確であり、仮説検証で全4件がConfirmedされている。記載内容とコードベースの整合性は高い。主な改善点は、修正方針における設計判断の具体化、受け入れ基準の明示化、影響範囲の網羅性、およびテスト方針の追加である。

---

## Must Fix（必須対応）

なし。

Issue本文の原因分析、再現手順、影響範囲の比較表はすべてコードベースと整合しており、技術的に誤った記載は確認されなかった。

---

## Should Fix（推奨対応）

### SF-1: 修正方針における同期/非同期の設計判断が未記載

**カテゴリ**: 技術的妥当性
**場所**: 修正方針 セクション

**問題**:
`syncWorktreesToDB()`は同期関数(`void`を返す)だが、修正方針で参照している`cleanupWorktreeSessions()`および`cleanupMultipleWorktrees()`は非同期関数(`Promise`を返す)である。同期関数から非同期関数を呼ぶにはシグネチャ変更が必要であり、その影響が検討されていない。

**証拠**:
- `syncWorktreesToDB()`: `src/lib/git/worktrees.ts:265-268` -- `function syncWorktreesToDB(...): void`
- `cleanupMultipleWorktrees()`: `src/lib/session-cleanup.ts:153-156` -- `async function cleanupMultipleWorktrees(...): Promise<CleanupResult>`
- 呼び出し元は4箇所: sync, scan, restore, clone-manager

**推奨対応**:
以下いずれかの方針を明記する:
- (A) `syncWorktreesToDB()`をasyncに変更 -- 4箇所のすべての呼び出し元にawait追加が必要
- (B) `syncWorktreesToDB()`に削除対象IDを返す戻り値を追加し、呼び出し元でクリーンアップ実行 -- 関数シグネチャ変更は限定的だが、各呼び出し元に対応コード追加が必要
- (C) sync APIルート側で、syncWorktreesToDB()呼び出し前に削除対象を検出しクリーンアップ実行 -- syncWorktreesToDB()の変更不要だが、ロジック重複の懸念

---

### SF-2: 受け入れ基準が明示されていない

**カテゴリ**: 完全性
**場所**: Issue本文全体

**問題**:
「期待される動作」セクションは存在するが、テスト可能な受け入れ条件（Acceptance Criteria）としてフォーマットされていない。

**推奨対応**:
以下の受け入れ基準を追加:
1. POST /api/repositories/sync 実行時に、DBから削除されるworktreeの対応tmuxセッションがkillされること
2. `tmux list-sessions` に孤立セッションが残らないこと
3. セッションkill失敗時でもsync処理自体は成功すること（部分的成功の許容）
4. scan, restore, clone-manager経由の同期でも同様にクリーンアップされること

---

### SF-3: 影響範囲が不完全（syncWorktreesToDBの全呼び出し元が未記載）

**カテゴリ**: 完全性
**場所**: 影響 セクション / 関連ファイル セクション

**問題**:
Issueでは影響範囲をsync APIのみに限定しているが、`syncWorktreesToDB()`は以下の4箇所から呼ばれている:
- `src/app/api/repositories/sync/route.ts:48` (記載あり)
- `src/app/api/repositories/scan/route.ts:53` (未記載)
- `src/app/api/repositories/restore/route.ts:61` (未記載)
- `src/lib/git/clone-manager.ts:534` (未記載)

**推奨対応**:
影響範囲テーブルおよび関連ファイルに上記3箇所を追加する。修正方針(B)を採用する場合、各呼び出し元でクリーンアップコードの追加が必要となる点を明記する。

---

### SF-4: テスト方針が記載されていない

**カテゴリ**: 完全性
**場所**: Issue本文全体

**問題**:
既存テスト(`src/lib/__tests__/worktrees-sync.test.ts`)はDB操作のみを検証しており、tmuxセッションクリーンアップの検証は含まれていない。修正後にどのようなテストを追加するかの方針がない。

**推奨対応**:
以下のテスト方針を追加:
1. `worktrees-sync.test.ts` にtmuxセッションクリーンアップのモックテストを追加
2. `cleanupMultipleWorktrees`/`killSession`のモックを用いて、削除対象IDに対してクリーンアップが呼ばれることを検証
3. クリーンアップ失敗時にDB削除は成功すること（エラーハンドリング）を検証

---

## Nice to Have（あれば良い）

### NTH-1: 再現手順のcurlコマンドに認証情報の補足がない

**カテゴリ**: 完全性
**場所**: 再現手順 ステップ3

認証が有効な環境では`Authorization`ヘッダーが必要だが、curlコマンドに含まれていない。認証無効環境での手順であることを明記するか、ヘッダーの指定例を補足するとよい。

---

### NTH-2: 発見経緯に具体的なリンクがない

**カテゴリ**: 明確性
**場所**: 発見経緯 セクション

47件のworktreeという具体的な数値は有用だが、発見日時やAnvilプロジェクトへのリンクがあるとトリアージに役立つ。

---

## 参照ファイル

### コード
| ファイル | 行 | 関連性 |
|---------|-----|--------|
| `src/lib/git/worktrees.ts` | 265-308 | 修正対象: syncWorktreesToDB() |
| `src/lib/session-cleanup.ts` | 71-174 | 既存インフラ: cleanupWorktreeSessions(), cleanupMultipleWorktrees() |
| `src/app/api/repositories/route.ts` | 30-44, 80-109 | 正しく実装済みの参考: killWorktreeSession() |
| `src/app/api/repositories/sync/route.ts` | 48 | 呼び出し元（Issue記載済み） |
| `src/app/api/repositories/scan/route.ts` | 53 | 呼び出し元（Issue未記載） |
| `src/app/api/repositories/restore/route.ts` | 61 | 呼び出し元（Issue未記載） |
| `src/lib/git/clone-manager.ts` | 534 | 呼び出し元（Issue未記載） |
| `src/lib/__tests__/worktrees-sync.test.ts` | -- | 既存テスト（DB操作のみ） |

### ドキュメント
| ファイル | 関連性 |
|---------|--------|
| `CLAUDE.md` | プロジェクト構造・モジュール一覧の整合性確認 |
