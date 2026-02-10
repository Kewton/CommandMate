# Issue #225 レビューレポート (Stage 5)

**レビュー日**: 2026-02-10
**フォーカス**: 通常レビュー（2回目）
**イテレーション**: 2回目
**ステージ**: 5/6

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 0 |
| Should Fix | 2 |
| Nice to Have | 3 |

## 前回指摘事項（Stage 1）の対応状況

Stage 1で指摘した全7件の対応状況を検証した結果、**全件が適切に対応済み**であることを確認した。

| ID | カテゴリ | 状況 | 対応内容 |
|----|---------|------|---------|
| MF-1 | 整合性 | **解決済み** | データフロー（duration伝搬経路）セクションが追加され、全経路と型変更が明示された |
| SF-1 | 完全性 | **解決済み** | AutoYesConfirmDialog.tsxの固定テキスト動的変更タスクが追加された |
| SF-2 | 技術的妥当性 | **解決済み** | ALLOWED_DURATIONS定数と型定義のセクションが新設された |
| SF-3 | 完全性 | **解決済み** | 既存テスト（auto-yes-manager.test.ts, AutoYesConfirmDialog.test.tsx, AutoYesToggle.test.tsx）の更新タスクが追加された |
| SF-4 | 明確性 | **解決済み** | APIリクエスト/レスポンススキーマが具体例付きで追加された |
| NTH-1 | 完全性 | **解決済み** | 関連Issue (#61, #138, #153) へのリンクが追加された |
| NTH-2 | 完全性 | **解決済み** | HH:MM:SS形式の検討が受入条件に追加された |

---

## Should Fix（推奨対応）

### SF-1: データフロー図のsetAutoYesEnabled引数がコード構造と不整合

**カテゴリ**: 整合性
**場所**: データフロー（duration伝搬経路）セクション

**問題**:
Issueのデータフロー図の最終行で `setAutoYesEnabled(worktreeId, cliToolId, duration)` と記載されているが、現在の `setAutoYesEnabled` 関数の第2引数は `enabled: boolean` であり、`cliToolId` ではない。実際の `route.ts` での呼び出し（L104）は `setAutoYesEnabled(params.id, body.enabled)` であり、`cliToolId` は `startAutoYesPolling` に別途渡される。

**証拠**:
- Issue記載: `setAutoYesEnabled(worktreeId, cliToolId, duration)`
- `src/lib/auto-yes-manager.ts` L181: `setAutoYesEnabled(worktreeId: string, enabled: boolean): AutoYesState`
- `src/app/api/worktrees/[id]/auto-yes/route.ts` L104: `const state = setAutoYesEnabled(params.id, body.enabled);`

**推奨対応**:
データフロー図を `setAutoYesEnabled(worktreeId, enabled, duration)` に修正する。route.tsからの呼び出しは `setAutoYesEnabled(params.id, body.enabled, duration)` と `startAutoYesPolling(params.id, cliToolId)` の2つの呼び出しに分かれることを示すとより正確。

---

### SF-2: ALLOWED_DURATIONSのクライアントからのインポートにバンドル問題の懸念

**カテゴリ**: 技術的妥当性
**場所**: ALLOWED_DURATIONS定数と型定義 セクション

**問題**:
`ALLOWED_DURATIONS` を `auto-yes-manager.ts` からexportしてクライアントコンポーネント (`AutoYesConfirmDialog.tsx`, `'use client'`) からimportする設計だが、`auto-yes-manager.ts` はサーバー専用モジュールである。トップレベルで `cli-session`, `tmux`, `prompt-detector`, `cli-tools/manager` 等のNode.js依存モジュールをimportしており、クライアントバンドルに含まれるとビルドエラーまたは実行時エラーが発生する可能性が高い。

**証拠**:
- `src/lib/auto-yes-manager.ts` L1-17: サーバー専用importが多数（captureSessionOutput, detectPrompt, sendKeys, sendSpecialKeys, CLIToolManager等）
- `src/components/worktree/AutoYesConfirmDialog.tsx` L8: `'use client'`

**推奨対応**:
実装タスクに以下のいずれかの方針を明記すべき:
- (A) `ALLOWED_DURATIONS`、`AutoYesDuration`型、`DEFAULT_AUTO_YES_DURATION` を共有configファイル（例: `src/config/auto-yes-durations.ts`）に分離し、`auto-yes-manager.ts` と `AutoYesConfirmDialog.tsx` の両方からimportする
- (B) `auto-yes-manager.ts` からexportしつつ、クライアントバンドルに問題がないことをビルド確認するタスクを追加する

---

## Nice to Have（あれば良い）

### NTH-1: 後方互換性テストの明示

**カテゴリ**: 完全性
**場所**: 実装タスク セクション

受入条件に「duration未指定時にデフォルト値が適用されること（後方互換性）」は記載されているが、テスト項目に「durationフィールドなしでPOSTした場合のデフォルト値適用テスト」を明示すると、後方互換性の担保がより確実になる。

---

### NTH-2: AUTO_YES_TIMEOUT_MS定数の削除方針

**カテゴリ**: 完全性
**場所**: 実装タスク セクション

`AUTO_YES_TIMEOUT_MS` 定数（`auto-yes-manager.ts` L68）を `DEFAULT_AUTO_YES_DURATION` に置き換えて削除する方針を実装タスクに明記するとよい。現在は暗黙的な置換となっている。

---

### NTH-3: APIレスポンススキーマと現在のコードの不一致

**カテゴリ**: 明確性
**場所**: APIリクエスト/レスポンススキーマ セクション

Issueの成功レスポンス例では `{ "success": true, "expiresAt": ... }` と記載されているが、現在の `route.ts` の `buildAutoYesResponse` 関数は `{ enabled: boolean, expiresAt: number | null, pollingStarted?: boolean }` を返しており、`success` フィールドは含まれていない。レスポンス形式を現在のコードに合わせるか、変更方針を明記するとよい。

---

## 総合評価

Stage 1で指摘した全7件が適切に対応されており、Issue #225は**実装に着手可能な品質**に達している。

今回新たに発見した指摘はMust Fixレベルのものはなく、Should Fix 2件（データフロー図の引数表記誤り、ALLOWED_DURATIONSのクライアントインポート懸念）とNice to Have 3件にとどまる。

特にSF-2（ALLOWED_DURATIONSのバンドル問題）は実装時に顕在化する可能性があるため、実装着手前に方針を決定しておくことを推奨する。SF-1（データフロー図の引数表記）は実装者が混乱する可能性があるため、修正が望ましい。

---

## 参照ファイル

### コード
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-225/src/lib/auto-yes-manager.ts`: setAutoYesEnabledシグネチャ(L181)、AUTO_YES_TIMEOUT_MS(L68)、サーバー専用import群(L1-17)
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-225/src/app/api/worktrees/[id]/auto-yes/route.ts`: buildAutoYesResponse型(L24-28)、setAutoYesEnabled呼び出し(L104)
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-225/src/components/worktree/AutoYesConfirmDialog.tsx`: 'use client'(L8)、onConfirm型(L18)
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-225/src/components/worktree/AutoYesToggle.tsx`: onToggle型(L20)、formatTimeRemaining(L32-37)
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-225/src/components/worktree/WorktreeDetailRefactored.tsx`: handleAutoYesToggle(L1149-1164)
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-225/tests/unit/lib/auto-yes-manager.test.ts`: setAutoYesEnabledテスト(L55-81)
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-225/tests/unit/components/worktree/AutoYesConfirmDialog.test.tsx`: onConfirmテスト(L63-66)
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-225/tests/unit/components/worktree/AutoYesToggle.test.tsx`: onToggleテスト(L37-44)

### ドキュメント
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-225/docs/user-guide/webapp-guide.md`: ドキュメント更新タスク対象（Issueに記載済み）
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-225/docs/TRUST_AND_SAFETY.md`: ドキュメント更新タスク対象（Issueに記載済み）
