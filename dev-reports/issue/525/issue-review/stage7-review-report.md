# Issue #525 レビューレポート

**レビュー日**: 2026-03-20
**フォーカス**: 影響範囲レビュー
**イテレーション**: 2回目（Stage 7）

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 0 |
| Should Fix | 2 |
| Nice to Have | 2 |

## 前回レビュー（Stage 3）指摘の反映状況

Stage 3で指摘した全6件が適切にIssue本文に反映されていることを確認した。

| 指摘ID | 分類 | 内容 | 反映状況 |
|--------|------|------|----------|
| MF-1 | 影響ファイル | worktree-status-helper.ts未記載 | 反映済み -- 変更対象ファイルテーブルに追加、実装タスクにgetLastServerResponseTimestamp()の複合キー対応修正を明記 |
| MF-2 | 影響ファイル | current-output APIのisPollerActive/getLastServerResponseTimestamp未対応 | 反映済み -- 実装タスクを4項目に拡充（cliToolId指定呼び出し、serverPollerActive/lastServerResponseTimestampのエージェント毎返却） |
| SF-1 | 破壊的変更 | session-cleanup.tsの全エージェント分クリーンアップ | 反映済み -- 一括停止ヘルパー（stopAutoYesPollingByWorktree等）の導入検討を含む具体的設計方針を追記 |
| SF-2 | 破壊的変更 | resource-cleanup.tsの孤立エントリ検出ロジック | 反映済み -- extractWorktreeId()を用いた複合キー分解・DB比較の3ステップ手順を明記 |
| SF-3 | テスト範囲 | テストファイル5件の未記載 | 反映済み -- worktree-status-helper, auto-yes-persistence, auto-yes-manager-cleanup, session-cleanup-issue404, resource-cleanupの各テストファイル更新を追加 |
| NTH-1 | ドキュメント更新 | cli/types/api-responses.ts未記載 | 反映済み -- 関連コンポーネントに追加。型変更不要の方針も明記 |

---

## Should Fix（推奨対応）

### SF-1: setAutoYesEnabled()のcliToolIdパラメータ追加タスクの依存関係が暗黙的

**カテゴリ**: 影響ファイル
**場所**: 実装タスク > バックエンド

**問題**:
`auto-yes/route.ts` POST handler（L160）で`setAutoYesEnabled(params.id, ...)`を呼んでいるが、`cliToolId`は別変数（L156）で取得されているにもかかわらず渡されていない。Issueの実装タスクには「setAutoYesEnabled()にcliToolIdパラメータ追加」と「POST enable時にcliToolIdを渡す」の両方が記載されているが、前者が先行依存であることが暗黙的である。

**証拠**:
- `auto-yes/route.ts` L156: `const cliToolId = isValidCliTool(body.cliToolId) ? body.cliToolId : 'claude';`
- `auto-yes/route.ts` L160-165: `setAutoYesEnabled(params.id, body.enabled, ...)` -- cliToolIdが渡されていない
- `auto-yes-state.ts` L105-110: `setAutoYesEnabled(worktreeId, enabled, duration?, stopPattern?)` -- cliToolIdパラメータなし

**推奨対応**:
タスクの実行順序の依存関係を注記するか、現状の並び順（auto-yes-state.tsが先）が意図的であることを明示する。複数開発者が並行作業する場合の混乱を防止できる。

---

### SF-2: auto-yes/route.ts GET handlerの_requestパラメータ変更

**カテゴリ**: 影響ファイル
**場所**: 実装タスク > バックエンド > auto-yes/route.ts

**問題**:
GET handler（L82）で`getAutoYesState(params.id)`をworktreeId単体で呼んでいる。Issueには「GET時にcliToolIdクエリパラメータ対応」と記載されているが、現在のGET handlerの第一引数が`_request`（アンダースコアプレフィックス＝未使用）となっており、クエリパラメータ取得のためにはこのプレフィックスを外す変更も必要となる。

**証拠**:
- `auto-yes/route.ts` L74-75: `export async function GET(_request: NextRequest, ...)` -- _requestは未使用マーク
- クエリパラメータ取得には `new URL(request.url).searchParams.get('cliToolId')` が必要

**推奨対応**:
実装の詳細レベルであるため、Issue記載としてはオプション。ただし、`_request`を`request`に変更する点を実装タスクに含めると、レビュー時の見落としを防げる。

---

## Nice to Have（あれば良い）

### NTH-1: 複合キー生成・分解ユーティリティの具体的設計

**カテゴリ**: 依存関係
**場所**: 実装タスク > バックエンド > auto-yes-state.ts

**問題**:
`extractWorktreeId(compositeKey)`への言及はあるが、対になるbuild関数（`buildCompositeKey`等）の名前・シグネチャ・配置場所がIssueに記載されていない。auto-yes-poller.ts、resource-cleanup.ts、session-cleanup.ts等の複数ファイルから使用されるため、設計を統一する指針があるとよい。

**推奨対応**:
例として以下の設計を記載:
- `buildCompositeKey(worktreeId: string, cliToolId: CLIToolType): string` -- auto-yes-state.tsにエクスポート
- `extractWorktreeId(compositeKey: string): string` -- 同上
- セパレータ `:` はCLI_TOOL_IDSにコロンが含まれないことから安全

---

### NTH-2: テストタスクのファイルパス記載粒度の不統一

**カテゴリ**: テスト範囲
**場所**: 実装タスク > テスト

**問題**:
テストタスクの後半5件は具体的なファイルパス付き（例: `tests/unit/lib/worktree-status-helper.test.ts`）だが、前半5件（API route テスト等）はファイルパスの記載がない。実装者がテストファイルの新規作成か既存更新かを判断する材料として統一が望ましい。

**推奨対応**:
前半のテスト項目にもファイルパスを追記する。例: `tests/unit/api/auto-yes-route.test.ts`

---

## 全体評価

Stage 3の影響範囲レビューで指摘した全6件が適切にIssue本文に反映されている。特に以下の点が改善された:

1. **影響範囲の網羅性**: worktree-status-helper.ts、current-output/route.ts、session-cleanup.ts、resource-cleanup.tsが変更対象ファイルテーブルに追加され、具体的な変更内容も記載されている
2. **テストカバレッジ**: 既存テストファイル5件の更新が明示的にタスク化されている
3. **後方互換性**: Stage 5-6でcurrent-output APIのレスポンス設計方針が確定し、`CurrentOutputResponse.autoYes`の型を変更しない方針が明確化された
4. **クリーンアップ処理**: session-cleanup.tsとresource-cleanup.tsの複合キー対応が具体的な手順レベルで記載されている

残存するShould Fix 2件はタスクの依存関係の明示化と実装詳細レベルの補足であり、Nice to Have 2件はユーティリティ設計の具体化とテストファイルパスの統一である。いずれも実装に支障をきたすレベルではなく、**Issueの影響範囲分析は十分に網羅的である**と評価する。

---

## 参照ファイル

### コード
- `src/app/api/worktrees/[id]/auto-yes/route.ts`: setAutoYesEnabled()へのcliToolId未渡し、GET handlerの_requestパラメータ
- `src/lib/auto-yes-state.ts`: setAutoYesEnabled()のシグネチャ、extractWorktreeId()/buildCompositeKey()の配置先
- `src/lib/auto-yes-poller.ts`: autoYesPollerStates.set()のキー生成箇所
